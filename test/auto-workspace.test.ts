import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readWorkspaceEvidence } from "../src/auto/workspace.ts";

test("workspace identity binds tracked diff and untracked content without sharing their contents", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-identity-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  };
  try {
    git("init", "-q");
    await Bun.write(path.join(root, ".gitignore"), ".omp/\n.rasen/\nignored.txt\n");
    await Bun.write(path.join(root, "source.ts"), "private fixture source one");
    const before = await readWorkspaceEvidence(root);
    expect(JSON.stringify(before)).not.toContain("private fixture");
    await Bun.write(path.join(root, "source.ts"), "private fixture source two");
    const changed = await readWorkspaceEvidence(root);
    expect(changed.fingerprint).not.toBe(before.fingerprint);
    git("add", ".");
    const staged = await readWorkspaceEvidence(root);
    await Bun.write(path.join(root, "source.ts"), "private fixture source three");
    git("add", "source.ts");
    const restaged = await readWorkspaceEvidence(root);
    expect(restaged.fingerprint).not.toBe(staged.fingerprint);
    git("-c", "user.name=Codex", "-c", "user.email=codex@openai.com", "commit", "-qm", "Fixture");
    const committed = await readWorkspaceEvidence(root);
    await Bun.write(path.join(root, "source.ts"), "private fixture source four");
    const diff = await readWorkspaceEvidence(root);
    expect(diff.fingerprint).not.toBe(committed.fingerprint);
    await Bun.write(path.join(root, "ignored.txt"), "ignored fixture");
    expect((await readWorkspaceEvidence(root)).fingerprint).toBe(diff.fingerprint);
    await Bun.write(path.join(root, "untracked.txt"), "new fixture source");
    expect((await readWorkspaceEvidence(root)).fingerprint).not.toBe(diff.fingerprint);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workspace verification refuses a non-Git root without recursively reading it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-nongit-"));
  try {
    await expect(readWorkspaceEvidence(root)).rejects.toThrow("requires a Git workspace");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["gitlink", "assume-unchanged", "skip-worktree", "ancestor-symlink"] as const) {
  test(`workspace observation refuses ${mode} blind spots`, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-unsafe-"));
    const root = path.join(temp, "project");
    await fs.mkdir(root);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git("init", "-q");
      await Bun.write(path.join(root, "src/file.ts"), "safe local fixture");
      git("add", ".");
      git("-c", "user.name=Codex", "-c", "user.email=codex@openai.com", "commit", "-qm", "Fixture");
      if (mode === "gitlink") {
        const head = git("rev-parse", "HEAD");
        git("update-index", "--add", "--cacheinfo", `160000,${head},vendor`);
      } else if (mode === "ancestor-symlink") {
        await Bun.write(path.join(temp, "outside/file.ts"), "outside fixture must not be read");
        await fs.rm(path.join(root, "src"), { recursive: true });
        await fs.symlink(path.join(temp, "outside"), path.join(root, "src"), "dir");
      } else git("update-index", `--${mode}`, "src/file.ts");
      await expect(readWorkspaceEvidence(root)).rejects.toThrow(
        mode === "gitlink"
          ? "submodules/gitlinks"
          : mode === "ancestor-symlink"
            ? "symlink"
            : "index entries",
      );
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
}

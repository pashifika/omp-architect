import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { supportsSymlinks } from "./fixtures/symlink-support.ts";
import { WorkspaceEvidenceError, autoPreflightDiagnostic } from "../src/auto/diagnostics.ts";
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
  test.skipIf(mode === "ancestor-symlink" && !supportsSymlinks)(
    `workspace observation refuses ${mode} blind spots`,
    async () => {
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
        git(
          "-c",
          "user.name=Codex",
          "-c",
          "user.email=codex@openai.com",
          "commit",
          "-qm",
          "Fixture",
        );
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
              ? '"src"'
              : "index entries",
        );
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    },
  );
}

test.skipIf(!supportsSymlinks)(
  "tracked CLAUDE link binds target edits, retargets, deletion and file type",
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-links-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    try {
      git("init", "-q");
      await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
      await fs.writeFile(path.join(root, "OTHER.md"), "instructions");
      await fs.symlink("AGENTS.md", path.join(root, "CLAUDE.md"), "file");
      git("add", ".");
      git("-c", "user.name=Codex", "-c", "user.email=codex@openai.com", "commit", "-qm", "Fixture");
      const identity = async () => (await readWorkspaceEvidence(root)).fingerprint;
      const first = await identity();
      expect(await identity()).toBe(first);
      await fs.writeFile(path.join(root, "AGENTS.md"), "edited instructions");
      expect(await identity()).not.toBe(first);
      await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
      expect(await identity()).toBe(first);
      await fs.unlink(path.join(root, "CLAUDE.md"));
      await fs.symlink("OTHER.md", path.join(root, "CLAUDE.md"), "file");
      const retargeted = await identity();
      expect(retargeted).not.toBe(first);
      await fs.unlink(path.join(root, "CLAUDE.md"));
      const deleted = await identity();
      expect(deleted).not.toBe(retargeted);
      await fs.writeFile(path.join(root, "CLAUDE.md"), "OTHER.md");
      expect(await identity()).not.toBe(retargeted);
      expect(await identity()).not.toBe(deleted);
      await fs.unlink(path.join(root, "CLAUDE.md"));
      await fs.symlink("AGENTS.md", path.join(root, "CLAUDE.md"), "file");
      await fs.unlink(path.join(root, "AGENTS.md"));
      const broken = await identity();
      expect(broken).not.toBe(first);
      expect(await identity()).toBe(broken);
      await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
      expect(await identity()).toBe(first);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

for (const mode of [
  "untracked",
  "broken",
  "ignored",
  "external",
  "directory",
  "execution-records",
  "chain",
] as const) {
  test.skipIf(!supportsSymlinks)(`workspace link target policy: ${mode}`, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-policy-"));
    const root = path.join(temp, "project");
    await fs.mkdir(root);
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
      await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
      let target = "target.txt";
      if (mode === "external") {
        target = "../private.txt";
        await fs.writeFile(path.join(temp, "private.txt"), "private external content");
      } else if (mode === "ignored") {
        target = "ignored.txt";
        await fs.writeFile(path.join(root, target), "ignored content");
      } else if (mode === "directory") {
        target = "directory";
        await fs.mkdir(path.join(root, target));
      } else if (mode === "execution-records") {
        target = ".rasen/missing";
      } else if (mode !== "broken") {
        await fs.writeFile(path.join(root, target), "untracked content");
      }
      if (mode === "chain") {
        await fs.symlink(target, path.join(root, "middle"), "file");
        target = "middle";
      }
      await fs.symlink(target, path.join(root, "CLAUDE.md"), "file");
      if (["ignored", "external", "directory", "execution-records"].includes(mode)) {
        let caught: unknown;
        try {
          await readWorkspaceEvidence(root);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(WorkspaceEvidenceError);
        const diagnostic = autoPreflightDiagnostic("change snapshot", caught);
        expect(diagnostic).toContain('"CLAUDE.md"');
        expect(diagnostic).not.toContain("rasen status");
        expect(diagnostic).not.toContain("private external content");
        expect(diagnostic).not.toContain(temp);
      } else {
        const before = await readWorkspaceEvidence(root);
        await fs.writeFile(path.join(root, "target.txt"), "new target content");
        expect((await readWorkspaceEvidence(root)).fingerprint).not.toBe(before.fingerprint);
      }
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
}

test("workspace file content cannot impersonate the next inventory entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-code-framing-"));
  try {
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    await fs.writeFile(path.join(root, "a"), "X\0b\0file\0Y");
    await fs.writeFile(path.join(root, "b"), "Z");
    const before = await readWorkspaceEvidence(root);
    await fs.writeFile(path.join(root, "a"), "X");
    await fs.writeFile(path.join(root, "b"), "Y\0b\0file\0Z");
    expect((await readWorkspaceEvidence(root)).fingerprint).not.toBe(before.fingerprint);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const kind of ["symlink", "file", "missing", "directory"] as const) {
  test.skipIf(!supportsSymlinks)(`link raw parent traversal through ${kind}`, async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-link-traversal-"));
    const root = path.join(temp, "project");
    await fs.mkdir(root);
    try {
      expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
      await fs.writeFile(path.join(root, "AGENTS.md"), "instructions");
      const intermediate = path.join(root, "intermediate");
      if (kind === "symlink") {
        await fs.mkdir(path.join(temp, "outside"));
        await fs.symlink(path.join(temp, "outside"), intermediate, "dir");
      } else if (kind === "file") await fs.writeFile(intermediate, "file");
      else if (kind === "directory") await fs.mkdir(intermediate);
      await fs.symlink("intermediate/../AGENTS.md", path.join(root, "CLAUDE.md"), "file");
      if (kind === "directory") expect((await readWorkspaceEvidence(root)).kind).toBe("git");
      else await expect(readWorkspaceEvidence(root)).rejects.toThrow('"CLAUDE.md"');
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  });
}

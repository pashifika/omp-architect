import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { AutoPreflightError } from "./diagnostics.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 20000;

async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ code: number | null; output: Buffer }> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn("git", ["--no-optional-locks", ...args], {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0" },
    });
    const buffers: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve({ code, output: Buffer.concat(buffers) });
    };
    const abort = () => finish(new AutoPreflightError("Workspace observation cancelled"));
    const timer = setTimeout(
      () => finish(new AutoPreflightError("Workspace observation timed out")),
      5000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES)
        finish(new AutoPreflightError("Workspace diff exceeds the 32 MiB observation limit"));
      else buffers.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () =>
      finish(new AutoPreflightError("Git workspace observation could not start")),
    );
    child.on("close", (code) => finish(undefined, code));
  });
}

/** Fresh code identity, independent of task checkboxes or assistant claims. */
export async function readWorkspaceEvidence(
  root: string,
  signal?: AbortSignal,
): Promise<{ kind: "git"; fingerprint: string; files: number }> {
  root = await fs.realpath(root);
  const hash = createHash("sha256");
  const probe = await git(root, ["rev-parse", "--show-toplevel"], signal);
  let files: string[];
  const kind = "git";
  if (probe.code === 0) {
    if (path.resolve(probe.output.toString().trim()) !== path.resolve(root))
      throw new AutoPreflightError("Auto workspace must be the Git root to bind review evidence");
    const index = await git(root, ["ls-files", "--stage", "-v", "-z"], signal);
    if (index.code !== 0)
      throw new AutoPreflightError("Workspace index evidence could not be read");
    const entries = index.output.toString("utf8").split("\0").filter(Boolean);
    if (entries.some((entry) => /^. 160000 /.test(entry)))
      throw new AutoPreflightError(
        "Auto code verification does not support Git submodules/gitlinks",
      );
    if (entries.some((entry) => /^[a-zS] /.test(entry)))
      throw new AutoPreflightError(
        "Auto code verification does not support assume-unchanged or skip-worktree index entries",
      );
    const head = await git(root, ["rev-parse", "--verify", "HEAD"], signal);
    const changes = await git(
      root,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        ...(head.code === 0 ? ["HEAD"] : []),
        "--",
      ],
      signal,
    );
    const names = await git(
      root,
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      signal,
    );
    if (changes.code !== 0 || names.code !== 0)
      throw new AutoPreflightError("Workspace Git evidence could not be read");
    hash.update(head.output).update(changes.output);
    if (head.code !== 0) {
      const staged = await git(
        root,
        ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--"],
        signal,
      );
      if (staged.code !== 0)
        throw new AutoPreflightError("Unborn workspace staged evidence could not be read");
      hash.update(staged.output);
    }
    files = [...new Set(names.output.toString("utf8").split("\0").filter(Boolean))];
  } else {
    throw new AutoPreflightError(
      "Auto verification requires a Git workspace so current code evidence can be bounded and checked; initialize version control before starting Auto",
    );
  }

  if (files.length > MAX_FILES)
    throw new AutoPreflightError("Workspace inventory exceeds 20000 files");
  let bytes = 0;
  for (const name of files.sort()) {
    signal?.throwIfAborted();
    const file = path.resolve(root, name);
    const relative = path.relative(root, file);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new AutoPreflightError("Workspace evidence escapes the project");
    // Generated host/CLI execution records are not implementation content.
    if (relative.split(path.sep)[0] === ".rasen") continue;
    hash.update(name).update("\0");
    let ancestor = root;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      ancestor = path.join(ancestor, segment);
      try {
        if ((await fs.lstat(ancestor)).isSymbolicLink())
          throw new AutoPreflightError("Workspace file ancestors must not be symlinks");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("deleted");
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new AutoPreflightError(
        "Auto code verification does not support workspace symlink files",
      );
    if (!stat.isFile())
      throw new AutoPreflightError("Workspace evidence contains a non-file entry");
    const remaining = MAX_BYTES - bytes;
    if (stat.size > remaining)
      throw new AutoPreflightError("Workspace content exceeds the 32 MiB observation limit");
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > remaining)
        throw new AutoPreflightError("Workspace evidence changed or exceeds its content limit");
      const content = Buffer.alloc(Math.min(opened.size + 1, remaining + 1));
      let size = 0;
      while (size < content.length) {
        signal?.throwIfAborted();
        const read = await handle.read(content, size, content.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const after = await handle.stat();
      if (size !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
        throw new AutoPreflightError("Workspace changed during observation");
      bytes += size;
      hash.update(content.subarray(0, size)).update("\0");
    } finally {
      await handle.close();
    }
  }
  return { kind, fingerprint: hash.digest("hex"), files: files.length };
}

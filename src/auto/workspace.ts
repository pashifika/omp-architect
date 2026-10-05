import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";
import { WorkspaceEvidenceError, diagnosticPath } from "./diagnostics.ts";

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
    const abort = () => finish(new WorkspaceEvidenceError("Workspace observation cancelled"));
    const timer = setTimeout(
      () => finish(new WorkspaceEvidenceError("Workspace observation timed out")),
      5000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES)
        finish(new WorkspaceEvidenceError("Workspace diff exceeds the 32 MiB observation limit"));
      else buffers.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () =>
      finish(new WorkspaceEvidenceError("Git workspace observation could not start")),
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
      throw new WorkspaceEvidenceError(
        "Auto workspace must be the Git root to bind review evidence",
      );
    const index = await git(root, ["ls-files", "--stage", "-v", "-z"], signal);
    if (index.code !== 0)
      throw new WorkspaceEvidenceError("Workspace index evidence could not be read");
    const entries = index.output.toString("utf8").split("\0").filter(Boolean);
    if (entries.some((entry) => /^. 160000 /.test(entry)))
      throw new WorkspaceEvidenceError(
        "Auto code verification does not support Git submodules/gitlinks",
      );
    if (entries.some((entry) => /^[a-zS] /.test(entry)))
      throw new WorkspaceEvidenceError(
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
      throw new WorkspaceEvidenceError("Workspace Git evidence could not be read");
    hash.update(head.output).update(changes.output);
    if (head.code !== 0) {
      const staged = await git(
        root,
        ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary", "--"],
        signal,
      );
      if (staged.code !== 0)
        throw new WorkspaceEvidenceError("Unborn workspace staged evidence could not be read");
      hash.update(staged.output);
    }
    files = [...new Set(names.output.toString("utf8").split("\0").filter(Boolean))];
  } else {
    throw new WorkspaceEvidenceError(
      "Auto verification requires a Git workspace so current code evidence can be bounded and checked; initialize version control before starting Auto",
    );
  }

  if (files.length > MAX_FILES)
    throw new WorkspaceEvidenceError("Workspace inventory exceeds 20000 files");
  const inventory = new Set(files.map((name) => path.resolve(root, name)));
  const quoted = (name: string) => JSON.stringify(diagnosticPath(name));
  const isOutside = (relative: string) =>
    relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  const checkAncestors = async (relative: string) => {
    let ancestor = root;
    for (const segment of relative.split(path.sep).slice(0, -1)) {
      ancestor = path.join(ancestor, segment);
      try {
        if ((await fs.lstat(ancestor)).isSymbolicLink())
          throw new WorkspaceEvidenceError(
            `Workspace path ${quoted(relative)} has symlink ancestor ${quoted(path.relative(root, ancestor))}; directory-link contents are outside the file inventory`,
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  };
  let bytes = 0;
  for (const name of files.sort()) {
    signal?.throwIfAborted();
    const file = path.resolve(root, name);
    const relative = path.relative(root, file);
    if (isOutside(relative))
      throw new WorkspaceEvidenceError("Workspace evidence escapes the project");
    // Generated host/CLI execution records are not implementation content.
    if (relative.split(path.sep)[0] === ".rasen") continue;
    hash.update(name).update("\0");
    await checkAncestors(relative);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        hash.update("deleted\0");
        continue;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      // A Git symlink is link text, not dereferenced content. Observe its target
      // separately through the same bounded inventory; never read external content.
      const link = await fs.readlink(file, { encoding: "buffer" });
      const after = await fs.lstat(file);
      if (!after.isSymbolicLink() || after.ino !== stat.ino || after.mtimeMs !== stat.mtimeMs)
        throw new WorkspaceEvidenceError(
          `Workspace link ${quoted(relative)} changed during observation`,
        );
      bytes += link.length;
      if (bytes > MAX_BYTES)
        throw new WorkspaceEvidenceError("Workspace content exceeds the 32 MiB observation limit");
      const decodedLink = link.toString();
      if (!Buffer.from(decodedLink).equals(link))
        throw new WorkspaceEvidenceError(
          `Workspace link ${quoted(relative)} has a non-UTF-8 target that cannot be inventoried`,
        );
      const linkText = path.sep === "\\" ? decodedLink.replaceAll("/", "\\") : decodedLink;
      // Inspect raw components before normalizing "..": "dir-link/../file"
      // must not hide an intermediate directory symlink or an outside traversal.
      let rawTarget = path.dirname(file);
      let components = linkText.split(path.sep);
      if (path.isAbsolute(linkText)) {
        if (!linkText.startsWith(root + path.sep))
          throw new WorkspaceEvidenceError(
            `Workspace link ${quoted(relative)} targets outside the project; external content cannot be verified`,
          );
        rawTarget = root;
        components = linkText.slice(root.length + 1).split(path.sep);
      }
      for (const component of components.slice(0, -1)) {
        rawTarget = path.resolve(rawTarget, component);
        const rawRelative = path.relative(root, rawTarget);
        if (isOutside(rawRelative))
          throw new WorkspaceEvidenceError(
            `Workspace link ${quoted(relative)} traverses outside the project`,
          );
        let directory;
        try {
          directory = await fs.lstat(rawTarget);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (!directory?.isDirectory())
          throw new WorkspaceEvidenceError(
            `Workspace link ${quoted(relative)} traverses missing, symlink or non-directory path ${quoted(rawRelative)}`,
          );
      }
      const target = path.resolve(path.dirname(file), linkText);
      const targetRelative = path.relative(root, target);
      if (isOutside(targetRelative))
        throw new WorkspaceEvidenceError(
          `Workspace link ${quoted(relative)} targets outside the project; external content cannot be verified`,
        );
      await checkAncestors(targetRelative);
      if (targetRelative.split(path.sep)[0] === ".rasen")
        throw new WorkspaceEvidenceError(
          `Workspace link ${quoted(relative)} targets excluded execution records`,
        );
      let targetStat;
      try {
        targetStat = await fs.lstat(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Broken internal links have no effective content. If a target appears later,
      // it must enter the inventory or observation fails instead of approving stale evidence.
      if (targetStat && !inventory.has(target))
        throw new WorkspaceEvidenceError(
          `Workspace link ${quoted(relative)} targets ${quoted(targetRelative)} outside the Git file inventory (ignored files and directories cannot be verified)`,
        );
      hash.update("symlink\0").update(String(link.length)).update("\0").update(link).update("\0");
      continue;
    }
    if (!stat.isFile())
      throw new WorkspaceEvidenceError(
        `Workspace evidence contains non-file entry ${quoted(relative)}`,
      );
    hash.update("file\0");
    const remaining = MAX_BYTES - bytes;
    if (stat.size > remaining)
      throw new WorkspaceEvidenceError("Workspace content exceeds the 32 MiB observation limit");
    const handle = await fs.open(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.size > remaining
      )
        throw new WorkspaceEvidenceError("Workspace evidence changed or exceeds its content limit");
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
        throw new WorkspaceEvidenceError("Workspace changed during observation");
      bytes += size;
      hash.update(String(size)).update("\0").update(content.subarray(0, size)).update("\0");
    } finally {
      await handle.close();
    }
  }
  return { kind, fingerprint: hash.digest("hex"), files: files.length };
}

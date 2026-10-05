import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Contracts verified against Rasen dev/0.1.8 at f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd. No mutating CLI commands. */
export interface RasenOptions {
  executable?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface RasenSnapshot {
  change: string;
  schema: string;
  root: string;
  state: "blocked" | "ready" | "all_done";
  progress: { total: number; complete: number; remaining: number };
  tasks: Array<{ id: string; description: string; done: boolean }>;
  instruction: string;
  skill: string;
  contextFiles: Array<{ path: string; content: string }>;
  fingerprint: string;
}

// The complete captured prompt payload, not merely each file, must fit this cap.
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_FILES = 128;
const invalid = () =>
  new Error("Rasen returned an unsupported or inconsistent local change contract");
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && !value.includes("\0");
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function localPath(root: string, file: string): Promise<string> {
  if (!text(file) || !path.isAbsolute(file) || !within(root, path.resolve(file))) throw invalid();
  let resolved: string;
  try {
    resolved = await fs.realpath(file);
  } catch {
    throw new Error("Rasen local change or generated skill is missing or unreadable");
  }
  if (!within(root, resolved)) throw new Error("Rasen path escapes the local project");
  return resolved;
}

/** Refuse symlinked artifacts before the CLI itself gets a chance to follow them. */
async function checkTree(directory: string, signal?: AbortSignal): Promise<void> {
  let entries = 0;
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 12) throw new Error("Rasen change directory exceeds the depth limit");
    const directory = await fs.opendir(current);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++entries > 1024) throw new Error("Rasen change directory exceeds the entry limit");
      if (entry.isSymbolicLink()) throw new Error("Rasen change artifacts must not be symlinks");
      if (entry.isDirectory()) await visit(path.join(current, entry.name), depth + 1);
      else if (!entry.isFile()) throw new Error("Rasen change artifacts must be regular files");
    }
  }
  try {
    await visit(directory, 0);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith("Rasen ")) throw error;
    throw new Error("Rasen local change is unreadable");
  }
}

async function prepare(cwd: string, change: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(change) || change.length > 128)
    throw new Error("Rasen change must be a bounded kebab-case name");
  let root: string;
  try {
    root = await fs.realpath(cwd);
  } catch {
    throw new Error("Rasen project directory is unreadable");
  }
  const expected = path.join(root, "rasen", "changes", change);
  const changeDir = await localPath(root, expected);
  if (changeDir !== expected) throw new Error("Rasen change must use the local project directory");
  await checkTree(changeDir, signal);
  return { root, changeDir };
}

async function boundedText(
  root: string,
  file: string,
  signal?: AbortSignal,
  limit = MAX_CONTEXT_BYTES,
): Promise<string> {
  signal?.throwIfAborted();
  const resolved = await localPath(root, file);
  try {
    const handle = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > limit)
        throw new Error("Rasen context must contain bounded regular text files");
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > limit) throw new Error(`Rasen text exceeds its ${limit}-byte limit`);
      const result = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (result.includes("\0")) throw new Error("Rasen context must be UTF-8 text");
      return result;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith("Rasen ")) throw error;
    throw new Error("Rasen context is unreadable or is not UTF-8 text");
  }
}

async function command(
  cwd: string,
  args: string[],
  options: RasenOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxOutputBytes = options.maxOutputBytes ?? 512 * 1024;
  const executable = options.executable ?? "rasen";
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 4 * 1024 * 1024 ||
    !text(executable)
  )
    throw new Error("Invalid Rasen process limits");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RASEN_TELEMETRY: "0",
        OPENSPEC_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        CI: "1",
        NO_COLOR: "1",
      },
    });
    let settled = false;
    let bytes = 0;
    const stdout: Buffer[] = [];
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) {
        child.kill("SIGKILL");
        reject(error);
      } else resolve(value!);
    };
    const abort = () => finish(new Error("Rasen command aborted"));
    const timer = setTimeout(() => finish(new Error("Rasen command timed out")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    const consume = (chunk: Buffer, capture: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) finish(new Error("Rasen command exceeded its output limit"));
      else if (capture) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.on("error", () => finish(new Error("Rasen executable could not be started")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0)
        return finish(new Error("Rasen command failed; inspect it locally for details"));
      try {
        const value: unknown = JSON.parse(Buffer.concat(stdout).toString("utf8"));
        if (!record(value) || (Array.isArray(value.status) && value.status.length > 0))
          throw invalid();
        finish(undefined, value);
      } catch {
        finish(new Error("Rasen returned invalid JSON or an error result"));
      }
    });
    if (signal?.aborted) abort();
  });
}

function assertRoot(value: Record<string, unknown>, root: string): void {
  if (
    !record(value.root) ||
    value.root.path !== root ||
    value.root.storeId !== undefined ||
    value.root.storeType !== undefined ||
    value.root.store_id !== undefined ||
    value.root.source === "store"
  )
    throw invalid();
  if (
    value.root.scope !== undefined &&
    (!record(value.root.scope) || value.root.scope.kind !== "standalone")
  )
    throw invalid();
}

function assertExecution(value: Record<string, unknown>, root: string): void {
  const context = value.actionContext;
  if (
    !record(context) ||
    context.version !== 1 ||
    context.mode !== "repo-local" ||
    context.sourceOfTruth !== "repo" ||
    !Array.isArray(context.codeWriteRoots) ||
    context.codeWriteRoots.length !== 1 ||
    context.codeWriteRoots[0] !== root ||
    !Array.isArray(context.allowedEditRoots) ||
    context.allowedEditRoots.length !== 1 ||
    context.allowedEditRoots[0] !== root ||
    context.requiresAffectedAreaSelection !== false
  )
    throw invalid();
}

/** Read-only, local standalone changes only; does not initialize, update or archive Rasen. */
export async function readRasenSnapshot(
  cwd: string,
  change: string,
  options: RasenOptions = {},
  signal?: AbortSignal,
): Promise<RasenSnapshot> {
  const { root, changeDir } = await prepare(cwd, change, signal);
  const skill = await boundedText(
    root,
    path.join(root, ".omp", "skills", "rasen-apply-change", "SKILL.md"),
    signal,
  );
  const frontmatter = skill.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*["']?rasen-apply-change["']?\s*$/m.test(frontmatter))
    throw new Error("Rasen apply skill has an unexpected identity; run rasen init --tools omp");
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let status: Record<string, unknown>;
  let apply: Record<string, unknown>;
  try {
    [status, apply] = await Promise.all([
      command(root, ["status", "--change", change, "--json"], options, combined),
      command(root, ["instructions", "apply", "--change", change, "--json"], options, combined),
    ]);
  } finally {
    controller.abort();
  }
  signal?.throwIfAborted();
  assertRoot(status, root);
  assertRoot(apply, root);
  assertExecution(status, root);
  assertExecution(apply, root);
  if (
    status.changeName !== change ||
    apply.changeName !== change ||
    status.changeRoot !== changeDir ||
    apply.changeDir !== changeDir ||
    apply.changeRoot !== changeDir ||
    !text(status.schemaName) ||
    status.schemaName !== apply.schemaName ||
    typeof status.isComplete !== "boolean" ||
    !Array.isArray(status.artifacts) ||
    !record(apply.contextFiles) ||
    !record(apply.progress) ||
    !Array.isArray(apply.tasks) ||
    !text(apply.instruction) ||
    !["blocked", "ready", "all_done"].includes(String(apply.state))
  )
    throw invalid();
  const { total, complete, remaining } = apply.progress;
  if (
    !count(total) ||
    !count(complete) ||
    !count(remaining) ||
    total !== complete + remaining ||
    total > 1024
  )
    throw invalid();
  const seen = new Set<string>();
  const tasks = apply.tasks.map((task: unknown) => {
    if (
      !record(task) ||
      !text(task.id) ||
      !text(task.description) ||
      typeof task.done !== "boolean" ||
      seen.has(task.id)
    )
      throw invalid();
    seen.add(task.id);
    return { id: task.id, description: task.description, done: task.done };
  });
  if (
    tasks.length !== total ||
    tasks.filter((task) => task.done).length !== complete ||
    (apply.state === "all_done" && (total === 0 || remaining !== 0)) ||
    (apply.state === "ready" && (total === 0 || remaining === 0))
  )
    throw invalid();
  const files = new Set<string>();
  for (const outputs of Object.values(apply.contextFiles)) {
    if (!Array.isArray(outputs) || outputs.some((file) => !text(file))) throw invalid();
    for (const file of outputs as string[]) {
      if (files.has(file) || files.size >= MAX_FILES) throw invalid();
      files.add(file);
    }
  }
  const contextFiles: RasenSnapshot["contextFiles"] = [];
  for (const file of [...files].sort()) {
    const content = await boundedText(changeDir, file, signal);
    contextFiles.push({ path: path.relative(root, file), content });
    if (Buffer.byteLength(JSON.stringify(contextFiles), "utf8") > MAX_CONTEXT_BYTES)
      throw new Error("Rasen context exceeds the 64 KiB limit");
  }
  const payload = {
    change,
    schema: status.schemaName,
    root,
    state: apply.state as RasenSnapshot["state"],
    progress: { total, complete, remaining },
    tasks,
    instruction: apply.instruction,
    skill,
    contextFiles,
  };
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > MAX_CONTEXT_BYTES)
    throw new Error("Rasen context exceeds the 64 KiB limit");
  return { ...payload, fingerprint: createHash("sha256").update(encoded).digest("hex") };
}

/** Strict spec validation is evidence about change artifacts, not a test or implementation pass. */
export async function validateRasenChange(
  cwd: string,
  change: string,
  options: RasenOptions = {},
  signal?: AbortSignal,
): Promise<void> {
  const { root } = await prepare(cwd, change, signal);
  const result = await command(
    root,
    ["validate", change, "--type", "change", "--strict", "--json"],
    options,
    signal,
  );
  assertRoot(result, root);
  if (
    result.version !== "1.0" ||
    !Array.isArray(result.items) ||
    result.items.length !== 1 ||
    !record(result.items[0]) ||
    result.items[0].id !== change ||
    result.items[0].type !== "change" ||
    result.items[0].valid !== true ||
    !Array.isArray(result.items[0].issues) ||
    result.items[0].issues.some(
      (issue: unknown) => !record(issue) || issue.level !== "INFO" || !text(issue.message),
    ) ||
    !record(result.summary) ||
    !record(result.summary.totals) ||
    result.summary.totals.items !== 1 ||
    result.summary.totals.passed !== 1 ||
    result.summary.totals.failed !== 0
  )
    throw invalid();
}

export interface RasenAutoSkill {
  message: string;
  path: string;
  sha256: string;
  bytes: number;
}

/** Use the running host's native autoload renderer; no source-SDK runtime import. */
export async function loadRasenAutoSkill(
  cwd: string,
  args: string,
  host: Pick<import("@oh-my-pi/pi-coding-agent").ExtensionAPI["pi"], "buildSkillPromptMessage">,
  signal?: AbortSignal,
): Promise<RasenAutoSkill> {
  const root = await fs.realpath(cwd);
  const file = path.join(root, ".omp", "skills", "rasen-auto", "SKILL.md");
  const limit = 256 * 1024;
  const content = await boundedText(root, file, signal, limit);
  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || !/^name:\s*["']?rasen-auto["']?\s*$/m.test(frontmatter))
    throw new Error(
      "Installed rasen-auto skill is missing or has the wrong identity; initialize Rasen with the builtin full profile",
    );
  const rendered = await host.buildSkillPromptMessage(
    { name: "rasen-auto", filePath: file, baseDir: path.dirname(file) },
    { args },
    "autoload",
  );
  signal?.throwIfAborted();
  if ((await boundedText(root, file, signal, limit)) !== content)
    throw new Error("Rasen Auto skill changed during admission");
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
  // Native prompt rendering compacts Markdown table whitespace. Verify every
  // non-whitespace source character survives; never truncate the skill to fit task evidence.
  if (!body || !rendered.message.replace(/\s/g, "").includes(body.replace(/\s/g, "")))
    throw new Error("Native skill loader did not preserve the complete Rasen Auto body");
  return {
    message: rendered.message,
    path: file,
    sha256: createHash("sha256").update(content).digest("hex"),
    bytes: Buffer.byteLength(content),
  };
}

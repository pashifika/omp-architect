import { AutoPreflightError, diagnosticPath, systemErrorCode } from "./diagnostics.ts";
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
  /** Apply readiness/checkbox facts only; neither blocked nor all_done determines Auto completion. */
  state: "blocked" | "ready" | "all_done" | "archived";
  archived?: boolean;
  source?: "live-cli" | "archived-artifacts";
  changeDir?: string;
  progress: { total: number; complete: number; remaining: number };
  tasks: Array<{ id: string; description: string; done: boolean }>;
  instruction: string;
  /** Compatibility field. Selected native skills are observed separately, never required here. */
  skill: string;
  isComplete?: boolean;
  artifacts?: RasenArtifactStatus[];
  nextSteps?: string[];
  nextWorkflows?: RasenWorkflowHint[];
  applyNextWorkflows?: RasenWorkflowHint[];
  applyRequires?: string[];
  missingArtifacts?: string[];
  actionContext?: Record<string, unknown>;
  evidenceDir?: string;
  handoffDir?: string;
  ephemeraDir?: string;
  workDir?: string;
  /** Shared skill/UI output, never native execution or completion proof. */
  skillRecord?: RasenSkillRecord;
  contextFiles: Array<{ path: string; content: string }>;
  fingerprint: string;
}

export interface RasenArtifactStatus {
  id: string;
  outputPath: string;
  status: "done" | "ready" | "blocked";
  missingDeps?: string[];
}

export interface RasenWorkflowHint {
  workflow: string;
  reason: string;
}

/** This is a bounded source observation, not a private pipeline-state schema. */
export type RasenSkillRecord =
  | { kind: "absent"; searchedPaths: string[] }
  | { kind: "valid"; path: string; sha256: string; content: Record<string, unknown> }
  | { kind: "malformed"; path: string; reason: string; sha256?: string };

export interface RasenChangeDirectory {
  root: string;
  changeDir: string;
  archived: boolean;
}

// Artifact text has its own budget; the entire snapshot, including the optional
// independently bounded skill record, is capped at the sum of these two budgets.
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_SKILL_RECORD_BYTES = 64 * 1024;
const MAX_FILES = 128;
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const invalid = () =>
  new AutoPreflightError("Rasen returned an unsupported or inconsistent local change contract");
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
  } catch (error) {
    throw new AutoPreflightError(
      `Cannot read ${diagnosticPath(path.relative(root, file))} (${systemErrorCode(error)})`,
    );
  }
  if (!within(root, resolved))
    throw new AutoPreflightError(
      `${diagnosticPath(path.relative(root, file))} resolves outside this project; external linked change artifacts are not admitted`,
    );
  return resolved;
}

/** Refuse symlinked artifacts before the CLI itself gets a chance to follow them. */
async function checkTree(directory: string, signal?: AbortSignal): Promise<void> {
  let entries = 0;
  async function visit(current: string, depth: number): Promise<void> {
    if (depth > 12) throw new AutoPreflightError("Rasen change directory exceeds the depth limit");
    const directory = await fs.opendir(current);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      if (++entries > 1024)
        throw new AutoPreflightError("Rasen change directory exceeds the entry limit");
      if (entry.isSymbolicLink())
        throw new AutoPreflightError("Rasen change artifacts must not be symlinks");
      if (entry.isDirectory()) await visit(path.join(current, entry.name), depth + 1);
      else if (!entry.isFile())
        throw new AutoPreflightError("Rasen change artifacts must be regular files");
    }
  }
  try {
    await visit(directory, 0);
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof AutoPreflightError) throw error;
    throw new AutoPreflightError(`Rasen local change is unreadable (${systemErrorCode(error)})`);
  }
}

/** Check every ancestor before the CLI or a directory reader can follow it. */
async function localDirectory(root: string, target: string): Promise<boolean> {
  if (!within(root, target)) throw invalid();
  let current = root;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink())
        throw new AutoPreflightError("Rasen change directories must not be symlinks");
      if (!stat.isDirectory())
        throw new AutoPreflightError("Rasen change must use the local project directory");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      if (error instanceof AutoPreflightError) throw error;
      throw new AutoPreflightError(`Rasen local change is unreadable (${systemErrorCode(error)})`);
    }
  }
  return true;
}

/**
 * Resolve active or unambiguous standalone archived artifacts, without writing.
 * Date-prefixed archive names are the pinned Rasen standalone archive contract.
 * Store instance suffixes, external roots and ambiguous prior archives are refused.
 */
export async function resolveRasenChangeDirectory(
  cwd: string,
  change: string,
  signal?: AbortSignal,
): Promise<RasenChangeDirectory> {
  signal?.throwIfAborted();
  if (!slug.test(change) || change.length > 128)
    throw new AutoPreflightError("Rasen change must be a bounded kebab-case name");
  let root: string;
  try {
    root = await fs.realpath(cwd);
  } catch (error) {
    throw new AutoPreflightError(
      `Rasen project directory is unreadable (${systemErrorCode(error)})`,
    );
  }
  let changeDir = path.join(root, "rasen", "changes", change);
  let archived = false;
  if (!(await localDirectory(root, changeDir))) {
    const archiveDir = path.join(root, "rasen", "changes", "archive");
    const matches: string[] = [];
    if (await localDirectory(root, archiveDir)) {
      const directory = await fs.opendir(archiveDir);
      let entries = 0;
      for await (const entry of directory) {
        signal?.throwIfAborted();
        if (++entries > 1024)
          throw new AutoPreflightError("Rasen archive directory exceeds the entry limit");
        const date = entry.name.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
        if (!date || date[2] !== change) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink())
          throw new AutoPreflightError("Rasen archived change must be a regular local directory");
        const timestamp = Date.parse(`${date[1]}T00:00:00Z`);
        if (
          !Number.isFinite(timestamp) ||
          new Date(timestamp).toISOString().slice(0, 10) !== date[1]
        )
          throw new AutoPreflightError("Rasen archived change has an invalid date identity");
        matches.push(path.join(archiveDir, entry.name));
      }
    }
    if (matches.length > 1)
      throw new AutoPreflightError(
        "Rasen archived change is ambiguous; select one canonical archive before continuing",
      );
    if (matches.length === 0)
      throw new AutoPreflightError(
        `Cannot read ${diagnosticPath(path.relative(root, changeDir))} (ENOENT)`,
      );
    changeDir = matches[0];
    archived = true;
  }
  // Recheck after directory discovery; never accept linked archive ancestors.
  if (!(await localDirectory(root, changeDir))) throw invalid();
  await checkTree(changeDir, signal);
  return { root, changeDir, archived };
}

async function prepare(cwd: string, change: string, signal?: AbortSignal) {
  const resolved = await resolveRasenChangeDirectory(cwd, change, signal);
  if (resolved.archived)
    throw new AutoPreflightError("Rasen strict validation requires an active local change");
  return resolved;
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
    const handle = await fs.open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        throw new AutoPreflightError(
          `Expected a regular file: ${diagnosticPath(path.relative(root, file))}`,
        );
      if (stat.size > limit)
        throw new AutoPreflightError(
          `${diagnosticPath(path.relative(root, file))} is ${stat.size} bytes; limit is ${limit} bytes`,
        );
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > limit)
        throw new AutoPreflightError(`Rasen text exceeds its ${limit}-byte limit`);
      const result = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (result.includes("\0")) throw new AutoPreflightError("Rasen context must be UTF-8 text");
      return result;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof AutoPreflightError) throw error;
    throw new AutoPreflightError(
      `Cannot read UTF-8 text from ${diagnosticPath(path.relative(root, file))} (${systemErrorCode(error)})`,
    );
  }
}

async function command(
  cwd: string,
  args: string[],
  options: RasenOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 10000;
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
    throw new AutoPreflightError("Invalid Rasen process limits");
  const invocation = `rasen ${args.join(" ")}`;
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
    const abort = () => finish(new AutoPreflightError("Rasen command aborted"));
    const timer = setTimeout(
      () => finish(new AutoPreflightError(`${invocation} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    const consume = (chunk: Buffer, capture: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes)
        finish(
          new AutoPreflightError(`${invocation} exceeded the ${maxOutputBytes}-byte output limit`),
        );
      else if (capture) stdout.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.on("error", (error) =>
      finish(
        new AutoPreflightError(
          `${invocation} could not start (${systemErrorCode(error)}); check the configured executable and OMP process PATH`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0)
        return finish(
          new AutoPreflightError(
            `${invocation} exited with code ${code ?? "unknown"}; inspect that read-only command locally for details`,
          ),
        );
      try {
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout)),
        );
        if (!record(value) || (Array.isArray(value.status) && value.status.length > 0))
          throw invalid();
        finish(undefined, value);
      } catch {
        finish(new AutoPreflightError(`${invocation} returned invalid JSON or an error result`));
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

function boundedStrings(value: unknown, maximum = 128): string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => !text(item)))
    throw invalid();
  return value as string[];
}

function workflowHints(value: unknown): RasenWorkflowHint[] {
  if (!Array.isArray(value) || value.length > 128) throw invalid();
  return value.map((hint) => {
    if (!record(hint) || !text(hint.workflow) || !text(hint.reason)) throw invalid();
    return { workflow: hint.workflow, reason: hint.reason };
  });
}

/** Preserve CLI guidance as observations. It is not an Auto phase transition table. */
function statusFacts(status: Record<string, unknown>, apply: Record<string, unknown>) {
  if (!Array.isArray(status.artifacts) || status.artifacts.length > MAX_FILES) throw invalid();
  const ids = new Set<string>();
  const artifacts: RasenArtifactStatus[] = status.artifacts.map((artifact) => {
    if (
      !record(artifact) ||
      !text(artifact.id) ||
      !text(artifact.outputPath) ||
      !["done", "ready", "blocked"].includes(String(artifact.status)) ||
      ids.has(artifact.id)
    )
      throw invalid();
    ids.add(artifact.id);
    return {
      id: artifact.id,
      outputPath: artifact.outputPath,
      status: artifact.status as RasenArtifactStatus["status"],
      ...(artifact.missingDeps === undefined
        ? {}
        : { missingDeps: boundedStrings(artifact.missingDeps) }),
    };
  });
  const locations: Pick<RasenSnapshot, "ephemeraDir" | "workDir" | "evidenceDir" | "handoffDir"> =
    {};
  for (const key of ["ephemeraDir", "workDir", "evidenceDir", "handoffDir"] as const) {
    const location = status[key];
    if (location !== undefined) {
      if (
        !text(location) ||
        location.length > 4096 ||
        !path.isAbsolute(location) ||
        /[\x00-\x1f\x7f]/.test(location)
      )
        throw invalid();
      if (apply[key] !== undefined && apply[key] !== location) throw invalid();
      locations[key] = location;
    }
  }
  return {
    isComplete: status.isComplete as boolean,
    artifacts,
    actionContext: status.actionContext as Record<string, unknown>,
    ...(status.nextSteps === undefined ? {} : { nextSteps: boundedStrings(status.nextSteps) }),
    ...(status.applyRequires === undefined
      ? {}
      : { applyRequires: boundedStrings(status.applyRequires) }),
    ...(status.nextWorkflows === undefined
      ? {}
      : { nextWorkflows: workflowHints(status.nextWorkflows) }),
    ...(apply.nextWorkflows === undefined
      ? {}
      : { applyNextWorkflows: workflowHints(apply.nextWorkflows) }),
    ...(apply.missingArtifacts === undefined
      ? {}
      : { missingArtifacts: boundedStrings(apply.missingArtifacts) }),
    ...locations,
  };
}

/** Bound arbitrary skill-owned metadata without interpreting it as native proof. */
function boundedRecord(value: unknown): value is Record<string, unknown> {
  if (!record(value)) return false;
  let entries = 0;
  function visit(item: unknown, depth: number): boolean {
    if (++entries > 8192 || depth > 32) return false;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") return !item.includes("\0");
    if (Array.isArray(item)) return item.every((child) => visit(child, depth + 1));
    if (record(item))
      return Object.entries(item).every(
        ([key, child]) => !key.includes("\0") && visit(child, depth + 1),
      );
    return item === null || typeof item === "boolean";
  }
  return visit(value, 0);
}

/**
 * Follow only Rasen's reported sticky locations, then the actual change directory.
 * The first existing record wins even when malformed. Never repair, seed, merge,
 * migrate or overwrite this shared skill/UI output. `valid` means a bounded JSON
 * object, not validation against a private pipeline schema or execution evidence.
 */
async function observeSkillRecord(
  directories: string[],
  signal?: AbortSignal,
): Promise<RasenSkillRecord> {
  const searchedPaths: string[] = [];
  for (const directory of [...new Set(directories)]) {
    signal?.throwIfAborted();
    const file = path.join(directory, "auto-run.json");
    searchedPaths.push(file);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        return { kind: "malformed", path: file, reason: "Skill record must be a regular file" };
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        kind: "malformed",
        path: file,
        reason: `Skill record is unreadable (${systemErrorCode(error)})`,
      };
    }
    let content: string;
    try {
      // A CLI-reported workDir may be outside this project. It is a read-only
      // source location, never an expansion of the native code-write roots.
      const canonicalDirectory = await fs.realpath(directory);
      content = await boundedText(
        canonicalDirectory,
        path.join(canonicalDirectory, "auto-run.json"),
        signal,
        MAX_SKILL_RECORD_BYTES,
      );
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      return {
        kind: "malformed",
        path: file,
        reason: "Skill record is unreadable or exceeds the bounded UTF-8 contract",
      };
    }
    const sha256 = createHash("sha256").update(content).digest("hex");
    try {
      const parsed: unknown = JSON.parse(content);
      if (!boundedRecord(parsed)) throw invalid();
      return { kind: "valid", path: file, sha256, content: parsed };
    } catch {
      return {
        kind: "malformed",
        path: file,
        sha256,
        reason: "Skill record must be a bounded JSON object",
      };
    }
  }
  return { kind: "absent", searchedPaths };
}

function captured<T extends Omit<RasenSnapshot, "fingerprint">>(
  payload: T,
  limit = MAX_CONTEXT_BYTES + MAX_SKILL_RECORD_BYTES,
): T & { fingerprint: string } {
  const encoded = JSON.stringify(payload);
  if (Buffer.byteLength(encoded, "utf8") > limit)
    throw new AutoPreflightError(`Rasen context exceeds its ${Math.floor(limit / 1024)} KiB limit`);
  return { ...payload, fingerprint: createHash("sha256").update(encoded).digest("hex") };
}

/** Archived artifacts are observations, not a synthesized successful CLI result. */
async function readArchivedSnapshot(
  root: string,
  changeDir: string,
  change: string,
  signal?: AbortSignal,
): Promise<RasenSnapshot> {
  const metadataText = await boundedText(root, path.join(changeDir, ".openspec.yaml"), signal);
  let metadata: unknown;
  try {
    metadata = Bun.YAML.parse(metadataText);
  } catch {
    throw new AutoPreflightError("Rasen archived change metadata is invalid YAML");
  }
  if (
    !record(metadata) ||
    !text(metadata.schema) ||
    !slug.test(metadata.schema) ||
    metadata.schema.length > 128 ||
    [...metadataText.matchAll(/^schema\s*:/gm)].length !== 1 ||
    metadata.identity !== undefined ||
    (metadata.change !== undefined && metadata.change !== change) ||
    (metadata.changeName !== undefined && metadata.changeName !== change)
  )
    throw new AutoPreflightError(
      "Rasen archived change has an unsupported or inconsistent local identity",
    );
  const files: string[] = [path.join(changeDir, ".openspec.yaml")];
  let visited = 0;
  async function collect(directory: string, depth = 0): Promise<void> {
    if (depth > 12) throw new AutoPreflightError("Rasen change directory exceeds the depth limit");
    const entries = await fs.opendir(directory);
    for await (const entry of entries) {
      signal?.throwIfAborted();
      if (++visited > 1024)
        throw new AutoPreflightError("Rasen change directory exceeds the entry limit");
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new AutoPreflightError("Rasen change artifacts must not be symlinks");
      if (entry.isDirectory()) await collect(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".md")) {
        if (files.length >= MAX_FILES) throw invalid();
        files.push(file);
      } else if (!entry.isFile())
        throw new AutoPreflightError("Rasen change artifacts must be regular files");
    }
  }
  await collect(changeDir);
  const contextFiles: RasenSnapshot["contextFiles"] = [];
  for (const file of files.sort()) {
    const content =
      file === path.join(changeDir, ".openspec.yaml")
        ? metadataText
        : await boundedText(changeDir, file, signal);
    contextFiles.push({ path: path.relative(root, file), content });
    if (Buffer.byteLength(JSON.stringify(contextFiles), "utf8") > MAX_CONTEXT_BYTES)
      throw new AutoPreflightError("Rasen context exceeds the 64 KiB limit");
  }
  const taskText =
    contextFiles.find((file) => file.path === path.relative(root, path.join(changeDir, "tasks.md")))
      ?.content ?? "";
  // Same checkbox grammar as pinned Rasen's instructions/apply parser. The
  // archive state below deliberately makes no live apply-readiness claim.
  const tasks: RasenSnapshot["tasks"] = [];
  for (const line of taskText.split("\n")) {
    const match = line.match(/^[-*]\s*\[([ xX])\]\s*(.+)\s*$/);
    if (match)
      tasks.push({
        id: String(tasks.length + 1),
        description: match[2].trim(),
        done: match[1].toLowerCase() === "x",
      });
    if (tasks.length > 1024) throw invalid();
  }
  const complete = tasks.filter((task) => task.done).length;
  return captured({
    change,
    schema: metadata.schema,
    root,
    changeDir,
    archived: true,
    source: "archived-artifacts" as const,
    state: "archived" as const,
    progress: { total: tasks.length, complete, remaining: tasks.length - complete },
    tasks,
    instruction:
      "This change is archived. These are local archived artifacts and tasks.md checkbox facts, not live apply instructions or proof of Auto completion. Choose further work from the available native skills and observed evidence.",
    skill: "",
    contextFiles,
    skillRecord: await observeSkillRecord([changeDir], signal),
  });
}

/** Read-only, local standalone changes only; does not initialize, update or archive Rasen. */
export async function readRasenSnapshot(
  cwd: string,
  change: string,
  options: RasenOptions = {},
  signal?: AbortSignal,
): Promise<RasenSnapshot> {
  const { root, changeDir, archived } = await resolveRasenChangeDirectory(cwd, change, signal);
  if (archived) return readArchivedSnapshot(root, changeDir, change, signal);
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
      throw new AutoPreflightError("Rasen context exceeds the 64 KiB limit");
  }
  const facts = statusFacts(status, apply);
  const payload = {
    change,
    schema: status.schemaName,
    root,
    changeDir,
    archived: false,
    source: "live-cli" as const,
    state: apply.state as RasenSnapshot["state"],
    progress: { total, complete, remaining },
    tasks,
    instruction: apply.instruction,
    skill: "",
    contextFiles,
    ...facts,
    skillRecord: await observeSkillRecord(
      [status.ephemeraDir, status.workDir, changeDir].filter(
        (directory): directory is string => typeof directory === "string",
      ),
      signal,
    ),
  };
  return captured(payload);
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

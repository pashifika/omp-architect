import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RasenOptions } from "./rasen.ts";

export type WorkflowStageStatus =
  | "pending"
  | "in_progress"
  | "done"
  | "skipped"
  | "escalated"
  | "delegated";
export interface WorkflowStage {
  id: string;
  kind: "standard" | "decompose";
  skill?: string;
  role?: string;
  runtime?: string;
  runtimeSource?: string;
  dispatchMode?: string;
  requires: string[];
  status: WorkflowStageStatus;
  condition?: string;
  verifyPolicy?: string;
  note?: string;
  loop?: { kind: "review-cycle" | "goal"; maxRounds: number };
}
export interface WorkflowFinding {
  severity?: string;
  summary?: string;
  stage?: string;
}
export type RasenWorkflow =
  | { kind: "absent" | "invalid"; change: string; reason: string; fingerprint: string }
  | {
      kind: "present";
      change: string;
      pipeline: string;
      runStateDir: string;
      stages: WorkflowStage[];
      completed: string[];
      next: string | null;
      ready: string[];
      remaining: string[];
      inProgressStages: string[];
      escalatedStages: string[];
      openFindings: WorkflowFinding[];
      rounds: number;
      fingerprint: string;
    };

const MAX_BYTES = 512 * 1024;
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && !v.includes("\0");
const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length <= 256 && v.every(string) && new Set(v).size === v.length;
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every((value) => b.includes(value));
const statuses = new Set<WorkflowStageStatus>([
  "pending",
  "in_progress",
  "done",
  "skipped",
  "escalated",
  "delegated",
]);
const completedStatus = (status: WorkflowStageStatus) => status === "done" || status === "skipped";

/** Never follow a symlink in a project-local state path, including its ancestors. */
async function localPath(root: string, target: string, missing = false): Promise<void> {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("Rasen workflow state escapes the local project");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Rasen workflow paths must not be symlinks");
    } catch (error) {
      if (missing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function readState(root: string, file: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await localPath(root, file);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("Rasen workflow state must be bounded regular UTF-8 text");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("Rasen workflow state exceeds its size limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    if (text.includes("\0")) throw new Error("Rasen workflow state must be UTF-8 text");
    return text;
  } finally {
    await handle.close();
  }
}

/** Read-only public CLI calls. Bounded diagnostics are deliberately never echoed. */
async function command(
  cwd: string,
  args: string[],
  options: RasenOptions,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  const executable = options.executable ?? "rasen";
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_BYTES;
  if (
    !string(executable) ||
    /[\r\n]/.test(executable) ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 5000 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 4 * 1024 * 1024
  )
    throw new Error("Invalid Rasen workflow process limits");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        RASEN_AGENT_RUNTIME: "omp",
        RASEN_TELEMETRY: "0",
        OPENSPEC_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        CI: "1",
        NO_COLOR: "1",
      },
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let settled = false;
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
    const abort = () => finish(new Error("Rasen workflow command aborted"));
    const timer = setTimeout(
      () => finish(new Error("Rasen workflow command timed out")),
      timeoutMs,
    );
    const consume = (chunk: Buffer, capture: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes)
        finish(new Error("Rasen workflow command exceeded its output limit"));
      else if (capture) output.push(chunk);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => consume(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, false));
    child.on("error", () => finish(new Error("Rasen workflow executable could not start")));
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) return finish(new Error("Rasen workflow command failed"));
      try {
        const value: unknown = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (!record(value)) throw new Error();
        finish(undefined, value);
      } catch {
        finish(new Error("Rasen workflow returned invalid JSON"));
      }
    });
    if (signal?.aborted) abort();
  });
}

/**
 * Observe the source workflow, never execute it or write its ledger. Contracts
 * verified against Rasen dev/0.1.8 f0ae20d. Only standalone local changes are
 * supported, matching readRasenSnapshot; Store/external legacy roots fail closed.
 */
export async function readRasenWorkflow(
  cwd: string,
  change: string,
  options: RasenOptions = {},
  signal?: AbortSignal,
): Promise<RasenWorkflow> {
  signal?.throwIfAborted();
  if (!slug.test(change) || change.length > 128)
    throw new Error("Rasen workflow change must be a bounded kebab-case name");
  const root = await fs.realpath(cwd);
  const changeDir = path.join(root, "rasen", "changes", change);
  const ephemeraDir = path.join(root, ".rasen", "changes", change, "ephemera");
  await localPath(root, changeDir);
  if (!(await fs.stat(changeDir)).isDirectory())
    throw new Error("Rasen workflow change must be a local directory");
  // Refuse local state symlinks before the CLI can follow them.
  for (const directory of [ephemeraDir, changeDir])
    for (const filename of ["auto-run.json", "portfolio-run.json"])
      await localPath(root, path.join(directory, filename), true);
  const resume = await command(root, ["pipeline", "resume", change, "--json"], options, signal);
  const result = (kind: "absent" | "invalid", reason: string): RasenWorkflow => ({
    kind,
    change,
    reason,
    fingerprint: digest({ kind, change, reason }),
  });
  if (resume.change !== change) return result("invalid", "Rasen workflow identity changed");
  if (resume.invalidRunState === true)
    return result("invalid", "Rasen run-state is invalid; repair it before resuming");
  if (resume.hasRunState === false)
    return result("absent", "No Rasen workflow run-state has been recorded");
  if (resume.hasRunState !== true)
    return result("invalid", "Rasen workflow returned an unsupported state contract");
  if (resume.pipeline === null || resume.pipeline === undefined)
    return result("absent", "Rasen run-state does not name an executed pipeline");
  if (
    !string(resume.pipeline) ||
    !slug.test(resume.pipeline) ||
    resume.pipeline.length > 128 ||
    !string(resume.runStateDir) ||
    !path.isAbsolute(resume.runStateDir)
  )
    return result("invalid", "Rasen workflow returned an invalid pipeline or state path");
  const runStateDir = path.resolve(resume.runStateDir);
  if (![changeDir, ephemeraDir].includes(runStateDir))
    throw new Error("Rasen workflow state is outside the supported local state directories");
  const statePath = path.join(runStateDir, "auto-run.json");
  const before = await readState(root, statePath, signal);
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(before);
    if (!record(parsed)) throw new Error();
    state = parsed;
  } catch {
    return result("invalid", "Rasen run-state is invalid JSON");
  }
  const plan = await command(
    root,
    ["pipeline", "show", resume.pipeline, "--for-execution", "--json"],
    options,
    signal,
  );
  if ((await readState(root, statePath, signal)) !== before)
    return result("invalid", "Rasen workflow changed during observation; read it again");
  if (
    state.pipeline !== resume.pipeline ||
    plan.name !== resume.pipeline ||
    plan.hostRuntime !== "omp" ||
    !Array.isArray(plan.stages) ||
    plan.stages.length === 0 ||
    plan.stages.length > 256 ||
    !strings(plan.buildOrder) ||
    !strings(resume.completed) ||
    !strings(resume.remaining) ||
    !strings(resume.ready) ||
    !strings(resume.inProgressStages) ||
    !strings(resume.escalatedStages) ||
    !(resume.next === null || string(resume.next)) ||
    !Array.isArray(resume.openFindings) ||
    resume.openFindings.length > 512 ||
    (state.stages !== undefined && !record(state.stages)) ||
    (state.completed !== undefined && !strings(state.completed))
  )
    return result("invalid", "Rasen workflow returned inconsistent pipeline evidence");
  const stageStates = record(state.stages) ? state.stages : undefined;
  const stages: WorkflowStage[] = [];
  for (const raw of plan.stages) {
    if (
      !record(raw) ||
      !string(raw.id) ||
      !slug.test(raw.id) ||
      !strings(raw.requires) ||
      (raw.kind !== "standard" && raw.kind !== "decompose") ||
      (raw.skill != null && !string(raw.skill)) ||
      (raw.role != null && !string(raw.role)) ||
      (raw.runtime != null && !string(raw.runtime)) ||
      (raw.runtimeSource != null && !string(raw.runtimeSource)) ||
      (raw.dispatchMode != null && !string(raw.dispatchMode)) ||
      (raw.condition != null && !string(raw.condition)) ||
      (raw.verifyPolicy != null && !string(raw.verifyPolicy))
    )
      return result("invalid", "Rasen workflow contains an invalid stage");
    const saved = stageStates?.[raw.id];
    if (saved !== undefined && !record(saved))
      return result("invalid", "Rasen workflow contains an invalid stage status");
    const status = (
      record(saved)
        ? saved.status
        : !stageStates && (state.completed as string[] | undefined)?.includes(raw.id)
          ? "done"
          : "pending"
    ) as WorkflowStageStatus;
    if (!statuses.has(status) || (record(saved) && saved.note != null && !string(saved.note)))
      return result("invalid", "Rasen workflow contains an invalid stage status");
    let loop: WorkflowStage["loop"];
    if (raw.loop != null) {
      if (
        !record(raw.loop) ||
        !["review-cycle", "goal"].includes(String(raw.loop.kind)) ||
        !Number.isSafeInteger(raw.loop.maxRounds) ||
        Number(raw.loop.maxRounds) < 1
      )
        return result("invalid", "Rasen workflow contains an invalid loop");
      loop = {
        kind: raw.loop.kind as "review-cycle" | "goal",
        maxRounds: raw.loop.maxRounds as number,
      };
    }
    stages.push({
      id: raw.id,
      kind: raw.kind,
      requires: raw.requires,
      status,
      ...(raw.skill != null ? { skill: raw.skill as string } : {}),
      ...(raw.role != null ? { role: raw.role as string } : {}),
      ...(raw.runtime != null ? { runtime: raw.runtime as string } : {}),
      ...(raw.runtimeSource != null ? { runtimeSource: raw.runtimeSource as string } : {}),
      ...(raw.dispatchMode != null ? { dispatchMode: raw.dispatchMode as string } : {}),
      ...(raw.condition != null ? { condition: raw.condition as string } : {}),
      ...(raw.verifyPolicy != null ? { verifyPolicy: raw.verifyPolicy as string } : {}),
      ...(record(saved) && string(saved.note) ? { note: saved.note } : {}),
      ...(loop ? { loop } : {}),
    });
  }
  const buildOrder = plan.buildOrder;
  const ids = stages.map((stage) => stage.id);
  const completed = stages.filter((stage) => completedStatus(stage.status)).map((s) => s.id);
  if (
    new Set(ids).size !== ids.length ||
    !sameSet(ids, plan.buildOrder) ||
    (stageStates && Object.keys(stageStates).some((id) => !ids.includes(id))) ||
    stages.some((stage) =>
      stage.requires.some(
        (id) => !ids.includes(id) || buildOrder.indexOf(id) >= buildOrder.indexOf(stage.id),
      ),
    ) ||
    !sameSet(completed, resume.completed) ||
    !sameSet(
      ids.filter((id) => !completed.includes(id)),
      resume.remaining,
    ) ||
    !sameSet(
      stages.filter((s) => s.status === "in_progress").map((s) => s.id),
      resume.inProgressStages,
    ) ||
    !sameSet(
      stages.filter((s) => s.status === "escalated").map((s) => s.id),
      resume.escalatedStages,
    )
  )
    return result("invalid", "Rasen workflow status and public resume evidence disagree");
  const ready = (plan.buildOrder as string[]).filter((id) => {
    const stage = stages.find((s) => s.id === id)!;
    return (
      !completed.includes(id) && stage.requires.every((required) => completed.includes(required))
    );
  });
  if (!sameSet(ready, resume.ready) || resume.next !== (resume.ready[0] ?? null))
    return result("invalid", "Rasen workflow frontier is inconsistent");
  const findings: WorkflowFinding[] = [];
  for (const finding of resume.openFindings) {
    if (
      !record(finding) ||
      (finding.severity !== undefined &&
        !["blocker", "major", "minor", "trivial"].includes(String(finding.severity))) ||
      (finding.summary !== undefined && !string(finding.summary)) ||
      (finding.stage !== undefined && (!string(finding.stage) || !ids.includes(finding.stage)))
    )
      return result("invalid", "Rasen workflow contains invalid findings");
    findings.push({
      ...(finding.severity !== undefined ? { severity: finding.severity as string } : {}),
      ...(finding.summary !== undefined ? { summary: finding.summary as string } : {}),
      ...(finding.stage !== undefined ? { stage: finding.stage as string } : {}),
    });
  }
  // Findings are security/completion evidence. A concurrent stale resume must
  // never erase a newly recorded blocker or convert an unknown severity to clean.
  if (JSON.stringify(state.openFindings ?? []) !== JSON.stringify(resume.openFindings))
    return result("invalid", "Rasen workflow findings changed during observation");
  const rounds = state.rounds ?? 0;
  if (!Number.isSafeInteger(rounds) || Number(rounds) < 0)
    return result("invalid", "Rasen workflow contains an invalid round count");
  const facts = {
    change,
    pipeline: resume.pipeline,
    runStateDir,
    stages,
    completed: resume.completed,
    next: resume.next,
    ready: resume.ready,
    remaining: resume.remaining,
    inProgressStages: resume.inProgressStages,
    escalatedStages: resume.escalatedStages,
    openFindings: findings,
    rounds: rounds as number,
  };
  return { kind: "present", ...facts, fingerprint: digest(facts) };
}

export interface WorkflowScopeAssessment {
  /** All supported apply/verification prerequisites for the host review are satisfied. */
  ready: boolean;
  /** Any source review-cycle is at its boundary; the host owns its independent review. */
  reviewLoopReady: boolean;
  remaining: string[];
  unsupported: string[];
  reason: string | null;
}

const outsideScope = new Set([
  "rasen-propose",
  "rasen-office-hours-command",
  "rasen-ship",
  "rasen-retain",
  "rasen-archive-change",
]);
const verification = new Set([
  "rasen-review",
  "rasen-verify-change",
  "rasen-verify-enhanced",
  "rasen-cso",
  "rasen-benchmark",
  "rasen-design-review",
  "rasen-qa",
  "rasen-qa-only",
]);

/** This is a completion guard, not a scheduler or a second workflow driver. */
export function assessWorkflowScope(workflow: RasenWorkflow): WorkflowScopeAssessment {
  const fail = (reason: string, remaining: string[] = [], unsupported: string[] = []) => ({
    ready: false,
    reviewLoopReady: false,
    remaining,
    unsupported,
    reason,
  });
  if (workflow.kind !== "present") return fail(workflow.reason);
  const unsupported = workflow.stages.filter(
    (stage) =>
      stage.kind !== "standard" ||
      (stage.runtime !== undefined && stage.runtime !== "claude") ||
      (stage.runtimeSource !== undefined && stage.runtimeSource !== "legacy-default") ||
      (stage.dispatchMode !== undefined && stage.dispatchMode !== "legacy-fallback") ||
      (stage.loop !== undefined &&
        (stage.loop.kind !== "review-cycle" || stage.skill !== "rasen-review-cycle")) ||
      !stage.skill ||
      (!outsideScope.has(stage.skill) &&
        !verification.has(stage.skill) &&
        stage.skill !== "rasen-apply-change" &&
        !(stage.skill === "rasen-review-cycle" && stage.loop?.kind === "review-cycle")),
  );
  if (unsupported.length)
    return fail(
      "Rasen workflow has unsupported prepared-change stages",
      [],
      unsupported.map((s) => s.id),
    );
  const required = workflow.stages.filter(
    (stage) => stage.skill === "rasen-apply-change" || verification.has(stage.skill!),
  );
  if (
    !required.some((stage) => stage.skill === "rasen-apply-change") ||
    !required.some((stage) => verification.has(stage.skill!))
  )
    return fail("Rasen workflow must include implementation and non-loop verification");
  const settled = (stage: WorkflowStage) =>
    stage.status === "done" ||
    (stage.status === "skipped" &&
      stage.skill !== "rasen-apply-change" &&
      !!stage.note?.trim() &&
      ((!!stage.condition && stage.condition !== "always") || stage.verifyPolicy === "light"));
  const remaining = required.filter((stage) => !settled(stage)).map((stage) => stage.id);
  if (
    workflow.openFindings.some(
      (finding) => !finding.severity || ["blocker", "major"].includes(finding.severity),
    )
  )
    return fail("Rasen workflow has unresolved blocking or unclassified findings", remaining);
  if (workflow.inProgressStages.length || workflow.escalatedStages.length)
    return fail("Rasen workflow has in-progress or escalated stages", remaining);
  if (remaining.length)
    return fail("Rasen implementation or verification is not complete", remaining);
  const loops = workflow.stages.filter((stage) => stage.loop?.kind === "review-cycle");
  const reviewLoopReady = loops.every(
    (stage) =>
      (stage.status === "pending" || stage.status === "done") &&
      stage.requires.every((id) => workflow.completed.includes(id)),
  );
  return {
    ready: true,
    reviewLoopReady,
    remaining: [],
    unsupported: [],
    reason: reviewLoopReady ? null : "Rasen review-cycle is not at a host-review boundary",
  };
}

import { AutoPreflightError, systemErrorCode } from "./diagnostics.ts";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RasenOptions, RasenSnapshot } from "./rasen.ts";
import type { Verdict } from "../core.ts";

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
    throw new AutoPreflightError("Rasen workflow state escapes the local project");
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new AutoPreflightError("Rasen workflow paths must not be symlinks");
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
      throw new AutoPreflightError("Rasen workflow state must be bounded regular UTF-8 text");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, size, buffer.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_BYTES)
      throw new AutoPreflightError("Rasen workflow state exceeds its size limit");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
    if (text.includes("\0"))
      throw new AutoPreflightError("Rasen workflow state must be UTF-8 text");
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
    throw new AutoPreflightError("Invalid Rasen workflow process limits");
  const invocation = `rasen ${args.join(" ")}`;
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
    const abort = () => finish(new AutoPreflightError("Rasen workflow command aborted"));
    const timer = setTimeout(
      () => finish(new AutoPreflightError(`${invocation} timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
    const consume = (chunk: Buffer, capture: boolean) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes)
        finish(
          new AutoPreflightError(`${invocation} exceeded the ${maxOutputBytes}-byte output limit`),
        );
      else if (capture) output.push(chunk);
    };
    signal?.addEventListener("abort", abort, { once: true });
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
        const value: unknown = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (!record(value)) throw new AutoPreflightError();
        finish(undefined, value);
      } catch {
        finish(new AutoPreflightError(`${invocation} returned invalid JSON`));
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
    throw new AutoPreflightError("Rasen workflow change must be a bounded kebab-case name");
  const root = await fs.realpath(cwd);
  const changeDir = path.join(root, "rasen", "changes", change);
  const ephemeraDir = path.join(root, ".rasen", "changes", change, "ephemera");
  await localPath(root, changeDir);
  if (!(await fs.stat(changeDir)).isDirectory())
    throw new AutoPreflightError("Rasen workflow change must be a local directory");
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
    throw new AutoPreflightError(
      "Rasen workflow state is outside the supported local state directories",
    );
  const statePath = path.join(runStateDir, "auto-run.json");
  const before = await readState(root, statePath, signal);
  let state: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(before);
    if (!record(parsed)) throw new AutoPreflightError();
    state = parsed;
  } catch {
    return result("invalid", "Rasen run-state is invalid JSON");
  }
  const plan = await command(
    root,
    // This is structural observation, not admission to Rasen's foreign dispatcher.
    // --for-execution probes foreign binaries and installed workflow profiles.
    ["pipeline", "show", resume.pipeline, "--json"],
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

/** A legacy default is observational metadata, never permission to launch Claude. */
function nativeRoute(stage: WorkflowStage): boolean {
  if (stage.runtime === "omp")
    return (
      (stage.runtimeSource === undefined || stage.runtimeSource === "host") &&
      (stage.dispatchMode === undefined || stage.dispatchMode === "native")
    );
  return (
    (stage.runtime === undefined ||
      (stage.runtime === "claude" && stage.runtimeSource === "legacy-default")) &&
    (stage.runtimeSource === undefined || stage.runtimeSource === "legacy-default") &&
    (stage.dispatchMode === undefined || stage.dispatchMode === "legacy-fallback")
  );
}

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
      !nativeRoute(stage) ||
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

export type HostAutoPhase =
  | "apply"
  | "verify"
  | "review"
  | "triage"
  | "fix"
  | "delta-review"
  | "settled"
  | "blocked";

/** Only the native result adapter may bind semantic requests to this provenance. */
export interface HostTaskEvidence {
  reviewRequestId: string;
  revision: number;
  requiredCheck: string;
  /** Native identity is provenance, never the identity of a semantic review. */
  producer: {
    agentId: string;
    sessionId?: string;
    receiptId: string;
    artifactSha256?: string;
  };
  snapshotFingerprint: string;
  workflowFingerprint: string;
  settled: boolean;
  success: boolean;
  evidence: string;
}
export interface HostVerificationEvidence extends HostTaskEvidence {
  role: "omp-reviewer";
  /** A single explicitly scoped verification task may cover multiple checks. */
  stages?: string[];
}
export interface HostFixEvidence extends HostTaskEvidence {
  role: "omp-worker";
}
export interface HostWorkflowState {
  phase: HostAutoPhase;
  stage: string | null;
  source: "builtin" | "rasen";
  pipeline: string;
  readyForReview: boolean;
  reason: string | null;
  instruction: string;
  fingerprint: string;
  snapshotFingerprint: string;
  workflowFingerprint: string;
  revision: number;
  cycle: number;
  requiredVerification: string[];
  verifiedStages: string[];
  findings: string[];
}

const phaseInstructions: Record<HostAutoPhase, string> = {
  apply:
    "Apply the remaining prepared-change tasks with native omp-worker leaves, then request a fresh auto_step observation",
  verify:
    "Dispatch an independent native omp-reviewer for the current ready verification stage, await its factual result, then call auto_step",
  review:
    "Submit the complete native evidence file to architect_checkpoint phase=completion and await its independent verdict",
  triage:
    "Triage the Architect findings, then call auto_step with transition=triage to enter the authorized fix phase",
  fix: "Fix the triaged findings with native omp-worker leaves, await their results, then call auto_step for fresh verification",
  "delta-review":
    "Submit fresh current-state or delta evidence to architect_checkpoint phase=completion using the existing review budget",
  settled:
    "Host review is approved; return a factual summary for fresh stop-time settlement before claiming completion",
  blocked: "Stop and report the blocker; this workflow grants no additional permissions",
};

function tasksComplete(snapshot: RasenSnapshot): boolean {
  return (
    snapshot.state === "all_done" &&
    snapshot.tasks.length > 0 &&
    snapshot.tasks.length === snapshot.progress.total &&
    snapshot.tasks.every((task) => task.done) &&
    snapshot.progress.complete === snapshot.progress.total &&
    snapshot.progress.remaining === 0
  );
}

/**
 * A real extension-owned default, not an invented external Rasen run-state.
 * Nothing is persisted, and no generated rasen-auto skill or full profile is needed.
 * The Architect checkpoint, represented by HostAutoPhase, owns the sole review loop.
 */
export function fallbackWorkflow(
  snapshot: RasenSnapshot,
): Extract<RasenWorkflow, { kind: "present" }> {
  const done = tasksComplete(snapshot);
  const stages: WorkflowStage[] = [
    {
      id: "apply",
      kind: "standard",
      skill: "rasen-apply-change",
      role: "implementer",
      runtime: "omp",
      runtimeSource: "host",
      dispatchMode: "native",
      requires: [],
      status: done ? "done" : "pending",
    },
    {
      id: "verify",
      kind: "standard",
      skill: "rasen-verify-change",
      role: "reviewer",
      runtime: "omp",
      runtimeSource: "host",
      dispatchMode: "native",
      requires: ["apply"],
      status: "pending",
    },
  ];
  const facts = {
    change: snapshot.change,
    pipeline: "omp-prepared-change",
    // Empty deliberately: this workflow has no source ledger or project sidecar.
    runStateDir: "",
    stages,
    completed: done ? ["apply"] : [],
    next: done ? "verify" : "apply",
    ready: [done ? "verify" : "apply"],
    remaining: done ? ["verify"] : ["apply", "verify"],
    inProgressStages: [],
    escalatedStages: [],
    openFindings: [],
    rounds: 0,
  };
  return { kind: "present", ...facts, fingerprint: digest(facts) };
}

/**
 * The extension's deterministic prepared-change workflow. Public Rasen state is
 * input, not the controller: source completion bits never supply native proof.
 * No round budget lives here. Architect's existing min/max reviews are final.
 */
export class HostAutoWorkflow {
  private phase: HostAutoPhase = "apply";
  private snapshot: RasenSnapshot | undefined;
  private source: RasenWorkflow | undefined;
  private definition: Extract<RasenWorkflow, { kind: "present" }> | undefined;
  private identity = "";
  private workflowIdentity = "";
  private reason: string | null = null;
  private verification = new Map<string, HostVerificationEvidence>();
  private consumedEvidence = new Set<string>();
  private revision = 0;
  private findings: string[] = [];
  private cycle = 0;
  private needsDelta = false;
  private fixOrigin: { snapshot: string; workflow: string } | undefined;

  constructor(readonly change: string) {}

  observe(
    snapshot: RasenSnapshot,
    source: RasenWorkflow,
    options: { settledBoundary?: boolean } = {},
  ): HostWorkflowState {
    if (this.phase === "blocked") return this.statusView();
    if (snapshot.change !== this.change || source.change !== this.change)
      return this.block("Prepared-change identity changed; explicitly start a new run");
    const identity = digest({
      change: snapshot.change,
      root: snapshot.root,
      schema: snapshot.schema,
      tasks: snapshot.tasks.map(({ id, description }) => ({ id, description })),
    });
    if (this.identity && this.identity !== identity)
      return this.block("Prepared-change task scope changed; explicitly start a new run");
    this.identity = identity;
    const changed =
      this.snapshot?.fingerprint !== snapshot.fingerprint ||
      this.source?.fingerprint !== source.fingerprint;
    this.snapshot = structuredClone(snapshot);
    this.source = structuredClone(source);
    if (source.kind === "invalid") return this.block(source.reason);
    this.definition =
      source.kind === "present" ? structuredClone(source) : fallbackWorkflow(snapshot);
    const workflowIdentity = digest({
      source: source.kind,
      pipeline: this.definition.pipeline,
      stages: this.definition.stages.map(({ status, note, ...stage }) => stage),
    });
    if (this.workflowIdentity && workflowIdentity !== this.workflowIdentity)
      return this.block("Source workflow definition changed; explicitly start a new run");
    this.workflowIdentity = workflowIdentity;
    const scope = assessWorkflowScope(this.definition);
    if (scope.unsupported.length)
      return this.block(`${scope.reason}: ${scope.unsupported.join(", ")}`);
    if (
      !this.definition.stages.some((stage) => stage.skill === "rasen-apply-change") ||
      !this.definition.stages.some((stage) => verification.has(stage.skill ?? ""))
    )
      return this.block(
        "Prepared-change workflow requires implementation and non-loop verification",
      );
    const topologyError = this.topologyError();
    if (topologyError) return this.block(topologyError);
    if (snapshot.state === "blocked")
      return this.block("Rasen prepared-change prerequisites are blocked");
    if (this.definition.inProgressStages.length || this.definition.escalatedStages.length)
      return this.block(
        "Source workflow has active or escalated work; resolve it before host execution",
      );
    if (
      this.definition.openFindings.some(
        (finding) => !finding.severity || ["blocker", "major"].includes(finding.severity),
      )
    )
      return this.block("Source workflow has unresolved blocking or unclassified findings");
    // A prepared change does not authorize executing an unfinished upstream
    // proposal, shipping step, or other stage outside this start's scope.
    const scoped = new Set(
      this.definition.stages
        .filter(
          (stage) =>
            stage.skill === "rasen-apply-change" ||
            verification.has(stage.skill ?? "") ||
            stage.loop?.kind === "review-cycle",
        )
        .map((stage) => stage.id),
    );
    const unavailable = this.definition.stages
      .filter((stage) => scoped.has(stage.id))
      .flatMap((stage) => stage.requires)
      .filter((id) => !scoped.has(id) && !this.definition!.completed.includes(id));
    if (unavailable.length)
      return this.block(
        `Source workflow has unfinished out-of-scope prerequisites: ${[...new Set(unavailable)].join(", ")}`,
      );
    if (changed && this.phase !== "fix") this.invalidateVerification();
    // The native adapter consumes a successful prior fix receipt before this
    // settled boundary. A failed fixer may still edit code: the next admitted
    // retry must bind these fresh facts, rather than an obsolete fix baseline.
    // Diagnostics may observe mid-flight and must preserve the dispatch baseline.
    if (this.phase === "fix" && options.settledBoundary === true) {
      if (
        this.fixOrigin?.snapshot !== snapshot.fingerprint ||
        this.fixOrigin?.workflow !== source.fingerprint
      )
        this.invalidateVerification();
      this.fixOrigin = { snapshot: snapshot.fingerprint, workflow: source.fingerprint };
    }
    if (this.phase !== "triage" && this.phase !== "fix" && this.phase !== "settled")
      this.phase = tasksComplete(snapshot)
        ? this.verified()
          ? this.needsDelta
            ? "delta-review"
            : "review"
          : "verify"
        : "apply";
    this.reason = null;
    return this.statusView();
  }

  /** Native verification is accepted only against the exact freshly observed facts. */
  recordVerification(evidence: HostVerificationEvidence): boolean {
    if (
      this.phase !== "verify" ||
      !this.snapshot ||
      !this.source ||
      !tasksComplete(this.snapshot) ||
      evidence.role !== "omp-reviewer" ||
      !this.validReceipt(evidence) ||
      evidence.snapshotFingerprint !== this.snapshot.fingerprint ||
      evidence.workflowFingerprint !== this.source.fingerprint
    )
      return false;
    const ready = this.readyVerificationStages();
    // A generic receipt covers exactly its requested check. Explicit
    // parallel coverage is allowed only for already-ready independent stages.
    const stages = evidence.stages ?? [evidence.requiredCheck];
    if (
      !stages.length ||
      !stages.includes(evidence.requiredCheck) ||
      new Set(stages).size !== stages.length ||
      stages.some((stage) => !ready.includes(stage))
    )
      return false;
    this.consumedEvidence.add(this.evidenceKey(evidence));
    const admitted = { ...structuredClone(evidence), stages: [...stages] };
    for (const stage of stages) this.verification.set(stage, admitted);
    if (this.verified()) this.phase = this.needsDelta ? "delta-review" : "review";
    return true;
  }

  /** Native receipt provenance is factual; its prose findings still need Architect review. */
  verificationEvidence(): HostVerificationEvidence[] {
    return [
      ...new Map(
        [...this.verification.values()].map((item) => [this.evidenceKey(item), item]),
      ).values(),
    ].map((item) => structuredClone(item));
  }

  /** Invalidate also on code edits not represented by the public task ledger. */
  invalidateVerification(): void {
    this.revision++;
    this.verification.clear();
    if (["review", "delta-review", "settled"].includes(this.phase))
      this.phase = this.snapshot && tasksComplete(this.snapshot) ? "verify" : "apply";
  }

  recordReview(
    verdict: Verdict,
    result: { approved: boolean; exhausted?: boolean },
  ): HostWorkflowState {
    if (!["review", "delta-review"].includes(this.phase) || !this.verified())
      return this.statusView();
    // A boundary identifier, not another budget: final-round approval must win.
    this.cycle++;
    if (verdict.decision === "approve" && result.approved) {
      this.findings = [];
      this.phase = "settled";
      return this.statusView();
    }
    if (result.exhausted) return this.block("Architect completion review budget exhausted");
    if (verdict.decision === "blocked") return this.block(verdict.summary);
    this.needsDelta = true;
    // Architect may translate a clean verdict into this exact minimum-round
    // request. More independent reviews need no fabricated edit or fix task.
    const minimumOnly =
      verdict.decision === "approve" ||
      (verdict.issues.length === 1 &&
        verdict.issues[0] === "Minimum independent review rounds not yet met");
    if (minimumOnly) {
      this.phase = "delta-review";
      return this.statusView();
    }
    this.findings = verdict.issues.length ? [...verdict.issues] : [verdict.summary];
    this.invalidateVerification();
    this.phase = "triage";
    return this.statusView();
  }

  /** The adapter exposes this one explicit transition; summaries cannot skip it. */
  acknowledgeTriage(): HostWorkflowState {
    if (this.phase === "triage" && this.snapshot && this.source) {
      this.phase = "fix";
      this.fixOrigin = {
        snapshot: this.snapshot.fingerprint,
        workflow: this.source.fingerprint,
      };
    }
    return this.statusView();
  }

  /** Only a successful native fix receipt, never task checkbox churn, ends fix. */
  recordFix(evidence: HostFixEvidence): boolean {
    if (
      this.phase !== "fix" ||
      evidence.role !== "omp-worker" ||
      evidence.requiredCheck !== "fix" ||
      !this.validReceipt(evidence) ||
      !this.fixOrigin ||
      evidence.snapshotFingerprint !== this.fixOrigin.snapshot ||
      evidence.workflowFingerprint !== this.fixOrigin.workflow
    )
      return false;
    this.consumedEvidence.add(this.evidenceKey(evidence));
    this.fixOrigin = undefined;
    this.invalidateVerification();
    this.phase = this.snapshot && tasksComplete(this.snapshot) ? "verify" : "apply";
    return true;
  }

  block(reason: string): HostWorkflowState {
    this.phase = "blocked";
    this.reason = reason;
    this.verification.clear();
    return this.statusView();
  }

  /** An in-memory host projection only. This never rewrites auto-run.json. */
  effectiveWorkflow(): RasenWorkflow {
    if (!this.definition || !this.snapshot)
      return (
        this.source ?? {
          kind: "absent",
          change: this.change,
          reason: "No prepared-change observation is available",
          fingerprint: digest({ change: this.change, kind: "unobserved" }),
        }
      );
    const projected = structuredClone(this.definition);
    for (const stage of projected.stages) {
      if (stage.skill === "rasen-apply-change")
        stage.status = tasksComplete(this.snapshot) ? "done" : "pending";
      else if (verification.has(stage.skill ?? "")) {
        if (this.verification.has(stage.id)) stage.status = "done";
        else if (this.requiredVerification().includes(stage.id)) stage.status = "pending";
      } else if (stage.loop?.kind === "review-cycle")
        stage.status = this.phase === "settled" ? "done" : "pending";
    }
    projected.completed = projected.stages
      .filter((stage) => completedStatus(stage.status))
      .map((stage) => stage.id);
    projected.remaining = projected.stages
      .filter((stage) => !completedStatus(stage.status))
      .map((stage) => stage.id);
    projected.ready = projected.stages
      .filter(
        (stage) =>
          !completedStatus(stage.status) &&
          stage.requires.every((id) => projected.completed.includes(id)),
      )
      .map((stage) => stage.id);
    projected.next = projected.ready[0] ?? null;
    // Scope readiness must remain false if the host failed closed, even when
    // external completion bits happen to look complete.
    if (this.phase === "blocked")
      projected.openFindings.push({
        severity: "blocker",
        summary: this.reason ?? "Host workflow blocked",
      });
    projected.fingerprint = digest({
      source: this.source?.fingerprint,
      stages: projected.stages,
      phase: this.phase,
    });
    return projected;
  }

  /** Jev caches semantic boundaries; exact admission continues using statusView().fingerprint. */
  semanticBoundaryKey(): string {
    const state = this.statusView();
    return digest({
      phase: state.phase,
      stage: state.stage,
      source: state.source,
      pipeline: state.pipeline,
      cycle: state.cycle,
      requiredVerification: state.requiredVerification,
      verifiedStages: state.verifiedStages,
      findings: state.findings,
      reason: state.reason,
      sourceStages:
        this.source?.kind === "present"
          ? this.source.stages.map(({ id, status, condition, note }) => ({
              id,
              status,
              condition,
              note,
            }))
          : [],
      sourceFindings: this.source?.kind === "present" ? this.source.openFindings : [],
    });
  }

  statusView(): HostWorkflowState {
    const required = this.requiredVerification();
    const verified = required.filter((id) => this.verification.has(id));
    const phase = this.phase;
    const state = {
      phase,
      stage:
        phase === "apply"
          ? (this.definition?.stages.find((stage) => stage.skill === "rasen-apply-change")?.id ??
            "apply")
          : phase === "verify"
            ? (this.readyVerificationStages()[0] ?? "verify")
            : ["settled", "blocked"].includes(phase)
              ? null
              : phase,
      source: this.source?.kind === "present" ? ("rasen" as const) : ("builtin" as const),
      pipeline: this.definition?.pipeline ?? "omp-prepared-change",
      readyForReview: ["review", "delta-review"].includes(phase) && this.verified(),
      reason: this.reason,
      instruction: phaseInstructions[phase],
      snapshotFingerprint: this.snapshot?.fingerprint ?? "",
      workflowFingerprint: this.source?.fingerprint ?? "",
      revision: this.revision,
      cycle: this.cycle,
      requiredVerification: required,
      verifiedStages: verified,
      findings: [...this.findings],
    };
    return { ...state, fingerprint: digest(state) };
  }

  /** Admit only the prepared-change topology the host phase engine can execute. */
  private topologyError(): string | undefined {
    const stages = this.definition?.stages ?? [];
    const applies = stages.filter((stage) => stage.skill === "rasen-apply-change");
    if (applies.length !== 1)
      return "Unsupported prepared-change topology: exactly one implementation stage is required";
    const apply = applies[0].id;
    const byId = new Map(stages.map((stage) => [stage.id, stage]));
    const memo = new Map<string, Set<string>>();
    const ancestors = (id: string, active = new Set<string>()): Set<string> | undefined => {
      if (active.has(id)) return;
      if (memo.has(id)) return memo.get(id);
      const stage = byId.get(id);
      if (!stage) return;
      const seen = new Set(active).add(id);
      const result = new Set<string>();
      for (const required of stage.requires) {
        result.add(required);
        const nested = ancestors(required, seen);
        if (!nested) return;
        for (const ancestor of nested) result.add(ancestor);
      }
      memo.set(id, result);
      return result;
    };
    for (const stage of stages) {
      const upstream = ancestors(stage.id);
      if (!upstream)
        return "Unsupported prepared-change topology: dependencies must be an acyclic known-stage graph";
      if (!verification.has(stage.skill ?? "")) continue;
      if (!upstream.has(apply))
        return `Unsupported prepared-change topology: verification stage ${stage.id} must depend on implementation`;
      if ([...upstream].some((id) => byId.get(id)?.loop?.kind === "review-cycle"))
        return `Unsupported prepared-change topology: verification stage ${stage.id} cannot depend on host review`;
    }
    return undefined;
  }

  private readyVerificationStages(): string[] {
    if (!this.definition || !this.snapshot || !tasksComplete(this.snapshot)) return [];
    const required = this.requiredVerification();
    const byId = new Map(this.definition.stages.map((stage) => [stage.id, stage]));
    const memo = new Map<string, boolean>();
    const settled = (id: string, active = new Set<string>()): boolean => {
      if (memo.has(id)) return memo.get(id)!;
      const stage = byId.get(id);
      if (!stage || active.has(id)) return false;
      if (stage.skill === "rasen-apply-change") return true;
      if (verification.has(stage.skill ?? "")) {
        if (this.verification.has(id)) return true;
        if (required.includes(id)) return false;
      } else if (!completedStatus(stage.status)) return false;
      // A conditional skip cannot make an unfinished upstream check disappear.
      const complete = stage.requires.every((dependency) =>
        settled(dependency, new Set(active).add(id)),
      );
      memo.set(id, complete);
      return complete;
    };
    return required.filter(
      (id) =>
        !this.verification.has(id) &&
        byId.get(id)!.requires.every((dependency) => settled(dependency)),
    );
  }

  private requiredVerification(): string[] {
    const checks =
      this.definition?.stages.filter((stage) => verification.has(stage.skill ?? "")) ?? [];
    const required = checks.filter(
      (stage) =>
        !(
          stage.status === "skipped" &&
          !!stage.note?.trim() &&
          ((!!stage.condition && stage.condition !== "always") || stage.verifyPolicy === "light")
        ),
    );
    // Even a fully conditional source DAG needs one current independent check.
    return (required.length ? required : checks.slice(0, 1)).map((stage) => stage.id);
  }

  private verified(): boolean {
    return (
      !!this.snapshot &&
      tasksComplete(this.snapshot) &&
      this.requiredVerification().every((stage) => this.verification.has(stage))
    );
  }

  private evidenceKey(evidence: HostTaskEvidence): string {
    return JSON.stringify([evidence.reviewRequestId, evidence.revision, evidence.requiredCheck]);
  }

  private validReceipt(evidence: HostTaskEvidence): boolean {
    const producer = evidence.producer;
    return (
      string(evidence.reviewRequestId) &&
      Number.isSafeInteger(evidence.revision) &&
      evidence.revision === this.revision &&
      string(evidence.requiredCheck) &&
      !!producer &&
      string(producer.agentId) &&
      string(producer.receiptId) &&
      (producer.sessionId === undefined || string(producer.sessionId)) &&
      (producer.artifactSha256 === undefined || /^[a-f0-9]{64}$/.test(producer.artifactSha256)) &&
      !this.consumedEvidence.has(this.evidenceKey(evidence)) &&
      evidence.settled === true &&
      evidence.success === true &&
      string(evidence.evidence) &&
      evidence.evidence.trim().length > 0
    );
  }
}

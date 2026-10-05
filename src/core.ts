import { createHash, randomUUID } from "node:crypto";
import type { Config } from "./config.ts";

export type Phase = "plan" | "recovery" | "completion";
export interface Verdict {
  decision: "approve" | "revise" | "blocked";
  summary: string;
  issues: string[];
}
export interface ReviewMaterial {
  ref: string;
  sha256: string;
  bytes: number;
  content: string;
  source: "authored" | "auto";
}
export interface ReviewRequest {
  phase: Phase;
  evidence: string;
  material: ReviewMaterial;
  canonicalPlan: string[];
  invocationId: string;
  revision: number;
}
export type ReviewStatus =
  | "input_rejected"
  | "provider_verdict"
  | "caller_cancelled"
  | "timed_out"
  | "stale"
  | "unavailable"
  | "cache_hit"
  | "budget_exhausted"
  | "in_flight";
export interface ReviewOutcome {
  invocationId: string;
  phase: Phase;
  status: ReviewStatus;
  charged: boolean;
  attempt: number;
  revision: number;
  artifactRef: string | null;
  sha256: string | null;
  verdict: Verdict | null;
}
export type Reviewer = (request: ReviewRequest, signal: AbortSignal) => Promise<Verdict>;

function cancellationStatus(signal: AbortSignal): "timed_out" | "caller_cancelled" {
  return signal.reason instanceof Error && signal.reason.name === "TimeoutError"
    ? "timed_out"
    : "caller_cancelled";
}

export function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
export function errorFingerprint(tool: string, text: string): string {
  return digest(
    `${tool}\n${text
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/^Wall time:.*$/gim, "")
      .replace(/^Elapsed(?: time)?:.*$/gim, "")
      .replace(/0x[0-9a-f]+/gi, "<address>")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000)}`,
  );
}
export function parseVerdict(text: string): Verdict {
  const value: unknown = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (!value || typeof value !== "object") throw new Error("Architect returned no verdict");
  const v = value as Record<string, unknown>;
  if (
    !["approve", "revise", "blocked"].includes(String(v.decision)) ||
    typeof v.summary !== "string" ||
    !v.summary.trim() ||
    !Array.isArray(v.issues) ||
    !v.issues.every((x) => typeof x === "string")
  )
    throw new Error("Architect returned an invalid verdict");
  if (v.decision === "approve" && v.issues.length)
    throw new Error("Architect approved with unresolved issues");
  return {
    decision: v.decision as Verdict["decision"],
    summary: v.summary.slice(0, 4000),
    issues: v.issues.map((x) => x.slice(0, 2000)).slice(0, 20),
  };
}
const readOnlyTools = new Set([
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "web_search",
  "fetch",
  "architect_checkpoint",
  "auto_status",
]);
export function planSteps(input: Record<string, unknown>): string[] {
  if (input.op !== "init" && input.op !== "append") return [];
  if (Array.isArray(input.items))
    return input.items.filter((x): x is string => typeof x === "string");
  if (Array.isArray(input.list))
    return input.list.flatMap((p) =>
      p && typeof p === "object" && Array.isArray(p.items)
        ? p.items.filter((x: unknown): x is string => typeof x === "string")
        : [],
    );
  return [];
}
export function routeAgent(agent: string, config: Config): string | undefined {
  if (agent === "omp-worker") return `@${config.roles.implementation}`;
  if (agent === "omp-reviewer") return `@${config.roles.architect}`;
  if (agent === "omp-explorer") return `@${config.roles.research}`;
  return undefined;
}

const omitted = " [... omitted ...] ";
function jsonSize(value: unknown, nested = false): number {
  const json = JSON.stringify(value);
  return nested ? JSON.stringify(json).length : json.length;
}
function boundedText(text: string, limit: number, nested = false): string {
  if (text.length <= limit && jsonSize(text, nested) <= limit) return text;
  let result = omitted;
  let low = 0;
  let high = Math.min(text.length, limit);
  while (low <= high) {
    const retained = Math.floor((low + high) / 2);
    let start = Math.ceil(retained / 2);
    let end = text.length - Math.floor(retained / 2);
    const before = text.charCodeAt(start - 1);
    const after = text.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff) start--;
    if (after >= 0xdc00 && after <= 0xdfff) end++;
    const candidate = text.slice(0, start) + omitted + text.slice(end);
    if (jsonSize(candidate, nested) <= limit) {
      result = candidate;
      low = retained + 1;
    } else {
      high = retained - 1;
    }
  }
  return result;
}
function boundedPlan(steps: string[], limit: number): string[] {
  if (jsonSize(steps) <= limit) return steps;
  const result: string[] = [];
  let remaining = limit - jsonSize([omitted]);
  for (const step of steps) {
    if (remaining < jsonSize(omitted) + 1) {
      result.push(omitted);
      break;
    }
    const bounded = boundedText(step, remaining - 1);
    result.push(bounded);
    remaining -= jsonSize(bounded) + 1;
  }
  return result;
}
function boundedStructure(value: unknown, limit: number): unknown {
  if (jsonSize(value, true) <= limit) return value;
  const preview = { truncated: true, preview: "" };
  if (jsonSize(preview, true) + jsonSize(omitted, true) - jsonSize("", true) > limit)
    return jsonSize({ truncated: true }, true) <= limit ? { truncated: true } : null;
  preview.preview = boundedText(
    JSON.stringify(value),
    limit - jsonSize(preview, true) + jsonSize("", true),
    true,
  );
  return preview;
}
function boundedEvidence(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  limit: number,
  denied = false,
  hostMetadata?: unknown,
): string {
  const record: {
    tool: string;
    toolCallId: string;
    input: unknown;
    output: string;
    isError: boolean;
    kind?: string;
    executed?: boolean;
    hostMetadata?: unknown;
  } = {
    tool: boundedText(tool, Math.min(100, Math.floor(limit / 10)), true),
    toolCallId: boundedText(id, Math.min(200, Math.floor(limit / 10)), true),
    input: {},
    output: "",
    isError,
    ...(denied ? { kind: "gate_denial", executed: false } : {}),
  };
  // Reserve the minimum explicit-loss output before assigning structured field budgets.
  const outputReserve = jsonSize(omitted, true) - jsonSize("", true);
  if (hostMetadata !== undefined) {
    let metadata: unknown;
    try {
      metadata = JSON.parse(JSON.stringify(hostMetadata));
    } catch {
      metadata = { truncated: true };
    }
    record.hostMetadata = {};
    const metadataLimit =
      Math.floor((limit - jsonSize(record, true) - outputReserve) / 3) + jsonSize({}, true);
    record.hostMetadata = boundedStructure(metadata, metadataLimit);
  }
  const inputLimit = Math.min(
    Math.floor(limit / 4),
    limit - jsonSize(record, true) - outputReserve + jsonSize({}, true),
  );
  record.input = boundedStructure(input, inputLimit);
  // Include the second JSON encoding: evidence records remain strings in the snapshot.
  record.output = boundedText(output, limit - jsonSize(record, true) + jsonSize("", true), true);
  return JSON.stringify(record);
}

export class Orchestrator {
  revision = 0;
  reviewCount = 0;
  stopContinuations = 0;
  completionRevision = -1;
  phaseRounds: Record<Phase, number> = { plan: 0, recovery: 0, completion: 0 };
  phaseReviews: Record<Phase, number> = { plan: 0, recovery: 0, completion: 0 };
  pendingRecovery = false;
  pendingPlan: string[] = [];
  approvedPlan = "";
  #approvedSteps: string[] = [];
  blocked = "";
  lastReview: ReviewOutcome | null = null;
  request = "";
  evidence: string[] = [];
  #seen = new Set<string>();
  #failures = new Map<string, { key: string; count: number }>();
  #cache = new Map<string, Verdict>();
  #inFlight = false;
  #latestInvocation = 0;
  #evidenceChars = 0;
  #omittedEvidence = 0;
  constructor(readonly config: Config) {}

  /** Conservative preflight for callers that require the whole request in every review. */
  canRetainRequest(request: string): boolean {
    const limit = Math.max(0, Math.floor((this.config.maxEvidenceChars - 512) / 6));
    return boundedText(request, limit) === request;
  }

  begin(request: string): void {
    this.request = request;
    this.revision++;
    this.#latestInvocation++;
    this.lastReview = null;
    this.reviewCount = 0;
    this.stopContinuations = 0;
    this.completionRevision = -1;
    this.phaseRounds = { plan: 0, recovery: 0, completion: 0 };
    this.phaseReviews = { plan: 0, recovery: 0, completion: 0 };
    this.pendingRecovery = false;
    this.pendingPlan = [];
    this.approvedPlan = "";
    this.#approvedSteps = [];
    this.blocked = "";
    this.evidence = [];
    this.#evidenceChars = 0;
    this.#omittedEvidence = 0;
    this.#seen.clear();
    this.#failures.clear();
    this.#cache.clear();
  }
  setPendingPlan(steps: string[]): void {
    if (JSON.stringify(steps) !== JSON.stringify(this.pendingPlan)) {
      this.pendingPlan = [...steps];
      this.invalidate();
    }
  }
  invalidate(): void {
    this.revision++;
    this.completionRevision = -1;
  }
  observe(
    id: string,
    tool: string,
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
    hostMetadata?: unknown,
  ): boolean {
    if (tool === "architect_checkpoint" || this.#seen.has(id)) return false;
    this.#seen.add(id);
    this.invalidate();
    this.recordEvidence(id, tool, input, output, isError, false, hostMetadata);
    if (!isError) {
      this.#failures.delete(tool);
      return false;
    }
    const key = errorFingerprint(tool, output);
    const old = this.#failures.get(tool);
    const count = old?.key === key ? old.count + 1 : 1;
    this.#failures.set(tool, { key, count });
    if (count >= this.config.repeatedErrorThreshold) this.pendingRecovery = true;
    return this.pendingRecovery;
  }
  /** Admission denials are evidence, not executed tool errors or recovery streaks. */
  deny(id: string, tool: string, input: Record<string, unknown>, reason: string): void {
    if (this.#seen.has(id)) return;
    this.#seen.add(id);
    this.invalidate();
    this.recordEvidence(id, tool, input, reason, true, true);
  }
  private recordEvidence(
    id: string,
    tool: string,
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
    denied = false,
    hostMetadata?: unknown,
  ): void {
    // One record cannot consume the ring or the space reserved for checkpoint context.
    const entry = boundedEvidence(
      id,
      tool,
      input,
      output,
      isError,
      Math.floor(this.config.maxEvidenceChars / 3),
      denied,
      hostMetadata,
    );
    this.evidence.push(entry);
    this.#evidenceChars += jsonSize(entry) + 1;
    while (this.#evidenceChars > this.config.maxEvidenceChars) {
      this.#evidenceChars -= jsonSize(this.evidence.shift()!) + 1;
      this.#omittedEvidence++;
    }
  }
  get planApproved(): boolean {
    return (
      this.pendingPlan.length > 0 && digest(JSON.stringify(this.pendingPlan)) === this.approvedPlan
    );
  }
  planStatus() {
    return {
      pending: this.pendingPlan.length
        ? {
            id: digest(JSON.stringify(this.pendingPlan)),
            steps: [...this.pendingPlan],
            approved: this.planApproved,
          }
        : null,
      approved: this.approvedPlan
        ? { id: this.approvedPlan, steps: [...this.#approvedSteps] }
        : null,
    };
  }
  get reviewInProgress(): boolean {
    return this.#inFlight;
  }
  get terminalReason(): string | undefined {
    if (this.#inFlight) return;
    const unresolved: Record<Phase, boolean> = {
      plan: this.pendingPlan.length > 0 && !this.planApproved,
      recovery: this.pendingRecovery,
      completion: !this.completionApproved,
    };
    for (const phase of ["plan", "recovery", "completion"] as const) {
      if (unresolved[phase] && this.phaseReviews[phase] >= this.config.reviews.max) {
        const detail = this.lastReview?.phase === phase ? this.lastReview.verdict?.summary : "";
        return `Architect ${phase} review budget exhausted with unresolved work. ${detail ?? ""}`.trim();
      }
    }
  }
  gate(tool: string, input: Record<string, unknown>): string | undefined {
    if (tool === "architect_checkpoint") return;
    if (
      this.pendingPlan.length &&
      !this.planApproved &&
      !readOnlyTools.has(tool) &&
      tool !== "todo"
    )
      return `Pending plan is not approved. Call architect_checkpoint phase=plan before execution. Pending plan ID: ${digest(JSON.stringify(this.pendingPlan))}; approved plan ID: ${this.approvedPlan || "none"}. Read auto_status for canonical steps; review the pending steps or restore the exact approved steps with todo. Await successful todo registration before executing; do not batch them.`;
    if (this.pendingRecovery && !readOnlyTools.has(tool))
      return "Repeated tool failure: call architect_checkpoint with phase recovery before retrying or changing files.";
    if (tool === "todo") {
      const steps = planSteps(input);
      if (steps.length && digest(JSON.stringify(steps)) === this.approvedPlan) {
        // Restoring the exact approved payload is safe; never infer semantic equivalence.
        this.setPendingPlan(steps);
      } else if (
        steps.length &&
        (steps.length >= this.config.substantialPlanSteps || this.pendingPlan.length)
      ) {
        this.setPendingPlan(steps);
        const mismatch = this.approvedPlan
          ? steps.length !== this.#approvedSteps.length
            ? `Step count differs: approved ${this.#approvedSteps.length}, received ${steps.length}.`
            : `Step ${steps.findIndex((step, index) => step !== this.#approvedSteps[index]) + 1} differs from the approved text (including punctuation and whitespace).`
          : "No exact plan has been approved.";
        return `Substantial plan: call architect_checkpoint with phase plan to review these pending steps before recording or executing them. ${mismatch} Pending plan ID: ${digest(JSON.stringify(steps))}; approved plan ID: ${this.approvedPlan || "none"}. Read auto_status for canonical steps. Retry todo with the exact approved steps, or review the changed pending steps. Await todo success before execution; never batch registration with execution.`;
      }
    }
  }
  snapshot(phase: Phase): string {
    const snapshot = {
      phase,
      request: "",
      pendingPlan: [] as string[],
      pendingRecovery: this.pendingRecovery,
      recentToolEvidence: [] as string[],
      omittedToolEvidence: this.#omittedEvidence + this.evidence.length,
    };
    // Reserve at least half the available space for whole, newest-first evidence.
    const contextLimit = Math.floor((this.config.maxEvidenceChars - jsonSize(snapshot)) / 6);
    snapshot.request = boundedText(this.request, contextLimit);
    snapshot.pendingPlan = boundedPlan(this.pendingPlan, contextLimit);
    let remaining = this.config.maxEvidenceChars - jsonSize(snapshot);
    for (let i = this.evidence.length - 1; i >= 0; i--) {
      const entry = this.evidence[i]!;
      const size = jsonSize(entry) + (snapshot.recentToolEvidence.length ? 1 : 0);
      if (size > remaining) break;
      snapshot.recentToolEvidence.push(entry);
      snapshot.omittedToolEvidence--;
      remaining -= size;
    }
    snapshot.recentToolEvidence.reverse();
    return JSON.stringify(snapshot);
  }
  revokeApproval(phase: Phase): void {
    this.#cache.clear();
    this.completionRevision = -1;
    if (phase === "plan") {
      this.approvedPlan = "";
      this.#approvedSteps = [];
    }
    if (phase === "recovery") this.pendingRecovery = true;
  }
  private recordReview(
    invocation: number,
    outcome: Omit<ReviewOutcome, "verdict">,
    verdict: Verdict | null,
  ): Verdict | null {
    const bounded = verdict === null ? null : parseVerdict(JSON.stringify(verdict));
    if (invocation === this.#latestInvocation) {
      this.lastReview = { ...outcome, verdict: bounded };
      this.blocked = bounded && bounded.decision !== "approve" ? bounded.summary : "";
    }
    return bounded;
  }
  /** Record an artifact/schema preflight failure without admitting a provider attempt. */
  rejectReview(
    phase: Phase,
    invocationId: string,
    message: string,
    status: "input_rejected" | "caller_cancelled" = "input_rejected",
  ): Verdict {
    const invocation = ++this.#latestInvocation;
    this.revokeApproval(phase);
    if (this.#inFlight) this.invalidate();
    return this.recordReview(
      invocation,
      {
        invocationId: invocationId.slice(0, 200),
        phase,
        status,
        charged: false,
        attempt: this.phaseReviews[phase],
        revision: this.revision,
        artifactRef: null,
        sha256: null,
      },
      {
        decision: "blocked",
        summary: message.trim() || "Architect review input rejected",
        issues: [],
      },
    )!;
  }
  async review(
    phase: Phase,
    material: ReviewMaterial,
    reviewer: Reviewer,
    signal?: AbortSignal,
    invocationId: string = randomUUID(),
  ): Promise<Verdict> {
    const invocation = ++this.#latestInvocation;
    const outcome: Omit<ReviewOutcome, "verdict"> = {
      invocationId: invocationId.slice(0, 200),
      phase,
      status: "input_rejected",
      charged: false,
      attempt: this.phaseReviews[phase],
      revision: this.revision,
      artifactRef: typeof material?.ref === "string" ? material.ref.slice(0, 2000) : null,
      sha256: typeof material?.sha256 === "string" ? material.sha256.slice(0, 64) : null,
    };
    const finish = (status: ReviewStatus, verdict: Verdict): Verdict =>
      this.recordReview(invocation, { ...outcome, status }, verdict)!;
    const reject = (summary: string, issues: string[] = []): Verdict => {
      this.revokeApproval(phase);
      if (this.#inFlight) this.invalidate();
      outcome.revision = this.revision;
      return finish("input_rejected", { decision: "blocked", summary, issues });
    };
    if (
      !material ||
      typeof material.ref !== "string" ||
      !material.ref.trim() ||
      typeof material.content !== "string" ||
      !material.content.trim() ||
      !Number.isSafeInteger(material.bytes) ||
      material.bytes !== Buffer.byteLength(material.content, "utf8") ||
      material.bytes > this.config.maxReviewBytes ||
      typeof material.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(material.sha256) ||
      material.sha256 !== digest(material.content) ||
      (material.source !== "authored" && material.source !== "auto")
    )
      return reject(
        `Architect review requires a non-empty, verified artifact with matching SHA-256 and UTF-8 byte length, at most ${this.config.maxReviewBytes} bytes. No review round was charged.`,
      );
    // Take an immutable copy so the admitted body and cache identity cannot diverge.
    const accepted = Object.freeze({ ...material });
    if (signal?.aborted) {
      this.revokeApproval(phase);
      if (this.#inFlight) this.invalidate();
      outcome.revision = this.revision;
      const status = cancellationStatus(signal);
      return finish(status, {
        decision: "blocked",
        summary: `Architect review ${status === "timed_out" ? "timed out" : "cancelled"} before admission. No review round was charged.`,
        issues: [],
      });
    }
    if (
      phase === "plan" &&
      (!this.pendingPlan.length || this.pendingPlan.some((step) => !step.trim()))
    )
      return reject(
        "Plan checkpoint requires non-empty steps. Pass steps explicitly, or stage a substantial todo first. No review round was charged.",
        ["No valid canonical plan steps to approve"],
      );
    if (
      this.pendingPlan.length > 30 ||
      this.pendingPlan.some((step) => step.length > 1000) ||
      Buffer.byteLength(JSON.stringify(this.pendingPlan), "utf8") > this.config.maxReviewBytes
    )
      return reject(
        `Canonical plan exceeds the review limit: at most 30 steps, 1000 characters per step, and ${this.config.maxReviewBytes} UTF-8 bytes. No review round was charged.`,
      );
    const canonicalPlan = [...this.pendingPlan];
    Object.freeze(canonicalPlan);
    const planKey = digest(JSON.stringify(canonicalPlan));
    if (
      phase === "completion" &&
      (this.pendingRecovery ||
        (this.pendingPlan.length && digest(JSON.stringify(this.pendingPlan)) !== this.approvedPlan))
    )
      return reject("Resolve the pending plan or recovery checkpoint before completion", [
        "Earlier checkpoint is unresolved",
      ]);
    const evidence = this.snapshot(phase);
    const key = digest(`${this.revision}:${accepted.sha256}:${planKey}:${evidence}`);
    const cached = this.#cache.get(key);
    if (
      cached &&
      (phase !== "completion" || cached.decision !== "approve" || this.completionApproved)
    )
      return finish("cache_hit", cached);
    this.revokeApproval(phase);
    if (this.#inFlight) {
      this.invalidate();
      outcome.revision = this.revision;
      return finish("in_flight", {
        decision: "blocked",
        summary: "Another architect review is in progress. No review round was charged.",
        issues: [],
      });
    }
    if (
      this.phaseReviews[phase] >= this.config.reviews.max ||
      this.reviewCount >= 3 * this.config.reviews.max
    )
      return finish("budget_exhausted", {
        decision: "blocked",
        summary:
          "Architect review budget exhausted. Report the unresolved work; ask the operator for a new request.",
        issues: [],
      });
    this.#inFlight = true;
    this.reviewCount++;
    this.phaseReviews[phase]++;
    outcome.charged = true;
    outcome.attempt = this.phaseReviews[phase];
    this.recordReview(invocation, { ...outcome, status: "in_flight" }, null);
    const revision = this.revision;
    const timeout = new AbortController();
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(
      () => timeout.abort(new DOMException("Architect review timed out", "TimeoutError")),
      this.config.reviewTimeoutMs,
    );
    const interrupted = (): Verdict | undefined => {
      if (
        this.revision !== revision ||
        invocation !== this.#latestInvocation ||
        digest(JSON.stringify(this.pendingPlan)) !== planKey
      )
        return finish("stale", {
          decision: "blocked",
          summary: "Review became stale while evidence changed; run a new checkpoint",
          issues: [],
        });
      if (combined.aborted) {
        const status = cancellationStatus(combined);
        return finish(status, {
          decision: "blocked",
          summary:
            status === "timed_out" ? "Architect review timed out" : "Architect review cancelled",
          issues: [],
        });
      }
    };
    let onAbort: (() => void) | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(combined.reason ?? new Error("Architect review cancelled"));
        combined.addEventListener("abort", onAbort, { once: true });
      });
      const returned = await Promise.race([
        reviewer(
          { phase, evidence, material: accepted, canonicalPlan, invocationId, revision },
          combined,
        ),
        cancelled,
      ]);
      const interruption = interrupted();
      if (interruption) return interruption;
      const verdict = parseVerdict(JSON.stringify(returned));
      this.phaseRounds[phase]++;
      if (verdict.decision === "approve") {
        if (this.phaseRounds[phase] < this.config.reviews.min)
          return finish("provider_verdict", {
            decision: "revise",
            summary: `${phase} review round ${this.phaseRounds[phase]}/${this.config.reviews.min}; request an independent current-state or delta review`,
            issues: ["Minimum independent review rounds not yet met"],
          });
        if (phase === "completion" && !this.pendingRecovery) this.completionRevision = revision;
        if (phase === "recovery") {
          this.pendingRecovery = false;
          this.#failures.clear();
        }
        if (phase === "plan") {
          this.approvedPlan = digest(JSON.stringify(this.pendingPlan));
          this.#approvedSteps = [...this.pendingPlan];
        }
      }
      this.#cache.set(key, verdict);
      return finish("provider_verdict", verdict);
    } catch (error) {
      const interruption = interrupted();
      if (interruption) return interruption;
      return finish("unavailable", {
        decision: "blocked",
        summary: `Architect unavailable: ${error instanceof Error ? error.message : String(error)}`,
        issues: [],
      });
    } finally {
      clearTimeout(timer);
      if (onAbort) combined.removeEventListener("abort", onAbort);
      this.#inFlight = false;
    }
  }
  get completionApproved(): boolean {
    return (
      this.completionRevision === this.revision &&
      !this.pendingRecovery &&
      (!this.pendingPlan.length || digest(JSON.stringify(this.pendingPlan)) === this.approvedPlan)
    );
  }
}

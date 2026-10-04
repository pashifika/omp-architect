import { createHash } from "node:crypto";
import type { Config } from "./config.ts";

export type Phase = "plan" | "recovery" | "completion";
export interface Verdict {
  decision: "approve" | "revise" | "blocked";
  summary: string;
  issues: string[];
}
export interface ReviewRequest {
  phase: Phase;
  evidence: string;
  revision: number;
}
export type Reviewer = (request: ReviewRequest, signal: AbortSignal) => Promise<Verdict>;

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
function boundedEvidence(
  tool: string,
  input: Record<string, unknown>,
  output: string,
  isError: boolean,
  limit: number,
): string {
  const record = {
    tool: boundedText(tool, Math.min(100, Math.floor(limit / 8)), true),
    input,
    output: "",
    isError,
  };
  const inputText = JSON.stringify(input);
  const inputLimit = Math.floor(limit / 4);
  if (inputText.length > inputLimit || jsonSize(inputText) > inputLimit) {
    const preview = { truncated: true, preview: "" };
    preview.preview = boundedText(
      inputText,
      inputLimit - jsonSize(preview, true) + jsonSize("", true),
      true,
    );
    record.input = preview;
  }
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
  blocked = "";
  request = "";
  evidence: string[] = [];
  #seen = new Set<string>();
  #failures = new Map<string, { key: string; count: number }>();
  #cache = new Map<string, Verdict>();
  #inFlight = false;
  #evidenceChars = 0;
  #omittedEvidence = 0;
  constructor(readonly config: Config) {}

  begin(request: string): void {
    this.request = request;
    this.revision++;
    this.reviewCount = 0;
    this.stopContinuations = 0;
    this.completionRevision = -1;
    this.phaseRounds = { plan: 0, recovery: 0, completion: 0 };
    this.phaseReviews = { plan: 0, recovery: 0, completion: 0 };
    this.pendingRecovery = false;
    this.pendingPlan = [];
    this.approvedPlan = "";
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
  ): boolean {
    if (tool === "architect_checkpoint" || this.#seen.has(id)) return false;
    this.#seen.add(id);
    this.invalidate();
    // One record cannot consume the ring or the space reserved for checkpoint context.
    const entry = boundedEvidence(
      tool,
      input,
      output,
      isError,
      Math.floor(this.config.maxEvidenceChars / 3),
    );
    this.evidence.push(entry);
    this.#evidenceChars += jsonSize(entry) + 1;
    while (this.#evidenceChars > this.config.maxEvidenceChars) {
      this.#evidenceChars -= jsonSize(this.evidence.shift()!) + 1;
      this.#omittedEvidence++;
    }
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
  gate(tool: string, input: Record<string, unknown>): string | undefined {
    if (tool === "architect_checkpoint") return;
    if (
      this.pendingPlan.length &&
      digest(JSON.stringify(this.pendingPlan)) !== this.approvedPlan &&
      !readOnlyTools.has(tool) &&
      tool !== "todo"
    )
      return "Pending plan is not approved. Call architect_checkpoint phase=plan before execution.";
    if (this.pendingRecovery && !readOnlyTools.has(tool))
      return "Repeated tool failure: call architect_checkpoint with phase recovery before retrying or changing files.";
    if (tool === "todo") {
      const steps = planSteps(input);
      if (
        steps.length >= this.config.substantialPlanSteps &&
        digest(JSON.stringify(steps)) !== this.approvedPlan
      ) {
        this.setPendingPlan(steps);
        return "Substantial plan: call architect_checkpoint with phase plan to review these pending steps before recording or executing them.";
      }
    }
  }
  snapshot(phase: Phase, summary: string): string {
    const snapshot = {
      phase,
      request: "",
      summary: "",
      pendingPlan: [] as string[],
      pendingRecovery: this.pendingRecovery,
      recentToolEvidence: [] as string[],
      omittedToolEvidence: this.#omittedEvidence + this.evidence.length,
    };
    // Reserve at least half the available space for whole, newest-first evidence.
    const contextLimit = Math.floor((this.config.maxEvidenceChars - jsonSize(snapshot)) / 6);
    snapshot.request = boundedText(this.request, contextLimit);
    snapshot.summary = boundedText(summary, contextLimit);
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
    if (phase === "plan") this.approvedPlan = "";
    if (phase === "recovery") this.pendingRecovery = true;
  }
  async review(
    phase: Phase,
    summary: string,
    reviewer: Reviewer,
    signal?: AbortSignal,
  ): Promise<Verdict> {
    if (signal?.aborted) {
      this.revokeApproval(phase);
      return { decision: "blocked", summary: "Architect review cancelled", issues: [] };
    }
    if (
      phase === "completion" &&
      (this.pendingRecovery ||
        (this.pendingPlan.length && digest(JSON.stringify(this.pendingPlan)) !== this.approvedPlan))
    ) {
      this.completionRevision = -1;
      return {
        decision: "blocked",
        summary: "Resolve the pending plan or recovery checkpoint before completion",
        issues: ["Earlier checkpoint is unresolved"],
      };
    }
    const evidence = this.snapshot(phase, summary);
    const key = digest(`${this.revision}:${evidence}`);
    const cached = this.#cache.get(key);
    if (
      cached &&
      (phase !== "completion" || cached.decision !== "approve" || this.completionApproved)
    )
      return cached;
    this.revokeApproval(phase);
    if (this.#inFlight) {
      this.invalidate();
      return {
        decision: "blocked",
        summary: "Another architect review is in progress",
        issues: [],
      };
    }
    if (
      this.phaseReviews[phase] >= this.config.reviews.max ||
      this.reviewCount >= 3 * this.config.reviews.max
    ) {
      this.blocked =
        "Architect review budget exhausted. Report the unresolved work; ask the operator for a new request.";
      return { decision: "blocked", summary: this.blocked, issues: [] };
    }
    if (phase === "completion") this.completionRevision = -1;
    this.#cache.clear();
    this.#inFlight = true;
    this.reviewCount++;
    this.phaseReviews[phase]++;
    const revision = this.revision;
    const timeout = new AbortController();
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(
      () => timeout.abort(new Error("Architect review timed out")),
      this.config.reviewTimeoutMs,
    );
    try {
      const cancelled = new Promise<never>((_, reject) => {
        combined.addEventListener(
          "abort",
          () => reject(combined.reason ?? new Error("Architect review cancelled")),
          { once: true },
        );
      });
      const verdict = await Promise.race([
        reviewer({ phase, evidence, revision }, combined),
        cancelled,
      ]);
      if (combined.aborted || this.revision !== revision)
        return {
          decision: "blocked",
          summary: "Review became stale while evidence changed; run a new checkpoint",
          issues: [],
        };

      this.phaseRounds[phase]++;
      this.blocked = verdict.decision === "blocked" ? verdict.summary : "";
      if (verdict.decision === "approve") {
        if (this.phaseRounds[phase] < this.config.reviews.min)
          return {
            decision: "revise",
            summary: `${phase} review round ${this.phaseRounds[phase]}/${this.config.reviews.min}; request an independent current-state or delta review`,
            issues: ["Minimum independent review rounds not yet met"],
          };
        if (phase === "completion" && !this.pendingRecovery) this.completionRevision = revision;
        if (phase === "recovery") {
          this.pendingRecovery = false;
          this.#failures.clear();
        }
        if (phase === "plan") this.approvedPlan = digest(JSON.stringify(this.pendingPlan));
      }
      this.#cache.set(key, verdict);
      return verdict;
    } catch (error) {
      if (this.revision !== revision)
        return {
          decision: "blocked",
          summary: "Review became stale after cancellation or evidence change",
          issues: [],
        };
      this.blocked = combined.aborted
        ? "Architect review cancelled or timed out"
        : `Architect unavailable: ${error instanceof Error ? error.message : String(error)}`;
      return { decision: "blocked", summary: this.blocked, issues: [] };
    } finally {
      clearTimeout(timer);
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

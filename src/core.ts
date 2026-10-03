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
    this.evidence.push(JSON.stringify({ tool, input, output: output.slice(0, 4000), isError }));
    while (this.evidence.join("\n").length > this.config.maxEvidenceChars) this.evidence.shift();
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
    return JSON.stringify(
      {
        phase,
        request: this.request.slice(0, 8000),
        summary: summary.slice(0, 8000),
        pendingPlan: this.pendingPlan,
        pendingRecovery: this.pendingRecovery,
        recentToolEvidence: this.evidence,
      },
      null,
      2,
    ).slice(0, this.config.maxEvidenceChars);
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

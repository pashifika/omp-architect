import type { AutoConfig } from "./config.ts";
import type { Decision, DecisionProvider, DecisionEvidence } from "./decision.ts";
import type { RasenSnapshot } from "./rasen.ts";

export type AutoStatus =
  | "running"
  | "completed"
  | "needs_user"
  | "uncertain"
  | "stalled"
  | "budget_exhausted"
  | "cancelled"
  | "blocked";

/** Session-local, code-owned budget. Model judgments never mutate its limits. */
export class AutoRun {
  status: AutoStatus = "running";
  reason = "";
  steps = 1;
  toolCalls = 0;
  decisions = 0;
  fallbacks = 0;
  stalls = 0;
  readonly startedAt: number;
  readonly id = crypto.randomUUID();
  snapshot: RasenSnapshot;
  #completed: Set<string>;
  #taskIds: Set<string>;
  #scope: string;
  #identity: string;
  #seenTools = new Set<string>();
  #deciding = false;

  constructor(
    readonly config: AutoConfig,
    snapshot: RasenSnapshot,
    readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.snapshot = snapshot;
    this.#taskIds = new Set(snapshot.tasks.map((task) => task.id));
    this.#identity = `${snapshot.root}\0${snapshot.schema}`;
    this.#scope = JSON.stringify(
      snapshot.tasks.map(({ id, description }) => ({ id, description })),
    );
    this.#completed = new Set(snapshot.tasks.filter((task) => task.done).map((task) => task.id));
  }

  stop(status: Exclude<AutoStatus, "running">, reason: string): void {
    if (this.status !== "running") return;
    this.status = status;
    this.reason = reason;
  }

  checkTime(): boolean {
    if (this.status === "running" && this.now() - this.startedAt >= this.config.maxDurationMs)
      this.stop("budget_exhausted", "Run deadline reached");
    return this.status === "running";
  }

  toolCall(id: string): boolean {
    if (!this.checkTime()) return false;
    if (this.#seenTools.has(id)) return true;
    if (this.toolCalls >= this.config.maxToolCalls) {
      this.stop("budget_exhausted", "Tool-call budget reached");
      return false;
    }
    this.#seenTools.add(id);
    this.toolCalls++;
    return true;
  }

  observe(snapshot: RasenSnapshot): void {
    if (!this.checkTime()) return;
    // The run's scope is fixed. Removing/replacing tasks cannot manufacture progress.
    const ids = new Set(snapshot.tasks.map((task) => task.id));
    if (
      `${snapshot.root}\0${snapshot.schema}` !== this.#identity ||
      ids.size !== this.#taskIds.size ||
      [...ids].some((id) => !this.#taskIds.has(id)) ||
      JSON.stringify(snapshot.tasks.map(({ id, description }) => ({ id, description }))) !==
        this.#scope
    ) {
      this.stop("needs_user", "Rasen task scope changed; review it and explicitly start a new run");
      return;
    }
    const completed = new Set(snapshot.tasks.filter((task) => task.done).map((task) => task.id));
    const progress = [...completed].some((id) => !this.#completed.has(id));
    this.stalls = progress || snapshot.state === "all_done" ? 0 : this.stalls + 1;
    for (const id of completed) this.#completed.add(id);
    this.snapshot = snapshot;
    if (snapshot.state === "blocked") this.stop("blocked", "Rasen prerequisites are blocked");
  }

  continue(): boolean {
    if (!this.checkTime()) return false;
    if (this.steps >= this.config.maxSteps) {
      this.stop("budget_exhausted", "Turn budget reached");
      return false;
    }
    if (this.stalls >= this.config.maxStalls) {
      this.stop("stalled", "No completed-task progress within the stall budget");
      return false;
    }
    this.steps++;
    return true;
  }

  async decide(
    evidence: DecisionEvidence,
    primary: DecisionProvider,
    fallback: DecisionProvider | undefined,
    signal: AbortSignal,
  ): Promise<Decision | undefined> {
    if (!this.checkTime()) return;
    if (this.#deciding) {
      this.stop("blocked", "Concurrent decision rejected");
      return;
    }
    this.#deciding = true;
    let decision: Decision | undefined;
    const acceptable = (value: Decision | undefined): value is Decision =>
      !!value &&
      ["continue", "replan", "needs_user", "uncertain"].includes(value.choice) &&
      Number.isFinite(value.confidence) &&
      value.confidence >= this.config.minConfidence &&
      value.confidence <= 1 &&
      value.choice !== "uncertain";
    try {
      this.decisions++;
      try {
        decision = await this.bounded(primary, evidence, signal);
      } catch {
        // Failed calls consume the same fixed budget. Never echo provider errors/secrets.
      }
      if (signal.aborted) {
        this.stop("cancelled", "Decision cancelled or timed out");
        return;
      }
      if (!acceptable(decision)) {
        if (
          fallback &&
          this.config.fallback === "architect" &&
          this.fallbacks < this.config.maxFallbacks &&
          this.checkTime()
        ) {
          this.fallbacks++;
          try {
            decision = await this.bounded(fallback, evidence, signal);
          } catch {
            decision = undefined;
          }
        } else decision = undefined;
      }
      if (signal.aborted) this.stop("cancelled", "Decision cancelled or timed out");
      else if (!acceptable(decision)) this.stop("uncertain", "No sufficiently certain next action");
      else if (decision.choice === "needs_user")
        this.stop("needs_user", "User input or authorization is required");
      return this.checkTime() ? decision : undefined;
    } finally {
      this.#deciding = false;
    }
  }

  private async bounded(
    provider: DecisionProvider,
    evidence: DecisionEvidence,
    signal: AbortSignal,
  ): Promise<Decision> {
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    combined.throwIfAborted();
    const timer = setTimeout(() => timeout.abort(), this.config.decisionTimeoutMs);
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Decision cancelled"));
        combined.addEventListener("abort", abort, { once: true });
        if (combined.aborted) abort();
      });
      return await Promise.race([
        Promise.resolve().then(() => provider(evidence, combined)),
        cancelled,
      ]);
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
    }
  }

  statusView() {
    return {
      change: this.snapshot.change,
      status: this.status,
      reason: this.reason || null,
      progress: this.snapshot.progress,
      steps: `${this.steps}/${this.config.maxSteps}`,
      toolCalls: `${this.toolCalls}/${this.config.maxToolCalls}`,
      decisions: this.decisions,
      fallbacks: `${this.fallbacks}/${this.config.maxFallbacks}`,
      stalls: `${this.stalls}/${this.config.maxStalls}`,
      elapsedMs: this.now() - this.startedAt,
      completionVerified: this.status === "completed",
    };
  }
}

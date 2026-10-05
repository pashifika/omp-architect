import type { AutoConfig } from "./config.ts";
import {
  sealDecisionEvidence,
  type Decision,
  type DecisionProvider,
  type DecisionEvidence,
} from "./decision.ts";
import {
  DecisionFailure,
  decisionFailureCode,
  type DecisionAttempt,
} from "./decision-diagnostics.ts";
import type { RasenSnapshot } from "./rasen.ts";

export type AutoStatus =
  | "running"
  | "draining"
  | "paused"
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
  outcome: Exclude<AutoStatus, "running" | "draining" | "paused"> | undefined;
  steps = 0;
  toolCalls = 0;
  decisions = 0;
  fallbacks = 0;
  stalls = 0;
  readonly startedAt: number;
  observedAt: number;
  lastActivityAt: number;
  observationError: string | null = null;
  #initialStop: { at: number; status: Exclude<AutoStatus, "running">; reason: string } | undefined;
  #completionFingerprint = "";
  readonly id = crypto.randomUUID();
  snapshot: RasenSnapshot;
  #completed: Set<string>;
  #progressToken = "";
  #actionAdvanced = false;
  #identity: string;
  #seenTools = new Set<string>();
  #deciding = false;
  #decisionAttempts: DecisionAttempt[] = [];

  constructor(
    readonly config: AutoConfig,
    snapshot: RasenSnapshot,
    readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
    this.observedAt = this.startedAt;
    this.lastActivityAt = this.startedAt;
    this.snapshot = snapshot;
    this.#identity = `${snapshot.change}\0${snapshot.root}\0${snapshot.schema}`;
    this.#completed = new Set(snapshot.tasks.filter((task) => task.done).map((task) => task.id));
  }

  stop(status: Exclude<AutoStatus, "running">, reason: string): void {
    if (this.status !== "running") return;
    this.#initialStop = { at: this.now(), status, reason };
    if (status === "completed") this.#completionFingerprint = this.snapshot.fingerprint;
    this.status = status;
    this.reason = reason;
  }

  /** Revoke semantic scheduling; native execution remains owned by OMP. */
  beginDrain(): void {
    if (this.status === "running" || this.status === "draining" || this.status === "paused") return;
    this.outcome = this.status;
    this.status = "draining";
  }

  finishDrain(completed = false): void {
    if (this.status !== "draining") return;
    this.status = completed && this.outcome === "completed" ? "completed" : "paused";
  }

  checkTime(): boolean {
    if (this.status === "running" && this.now() - this.startedAt >= this.config.maxDurationMs)
      this.stop("budget_exhausted", "Run deadline reached");
    if (
      this.status === "running" &&
      this.now() - this.lastActivityAt >= this.config.noOutputTimeoutMs
    )
      this.stop("stalled", "No native model/tool output within the activity timeout");
    return this.status === "running";
  }

  activity(): void {
    if (this.status === "running") this.lastActivityAt = this.now();
  }

  toolCall(id: string): boolean {
    if (!this.checkTime()) return false;
    if (this.#seenTools.has(id)) return true;
    if (this.config.maxToolCalls !== null && this.toolCalls >= this.config.maxToolCalls) {
      this.stop("budget_exhausted", "Tool-call budget reached");
      return false;
    }
    this.#seenTools.add(id);
    this.toolCalls++;
    return true;
  }

  private sameScope(snapshot: RasenSnapshot): boolean {
    // Planning skills own their task list. Only the selected change/root/schema
    // identity is fixed; changing a legitimate plan is not a new Auto run.
    return `${snapshot.change}\0${snapshot.root}\0${snapshot.schema}` === this.#identity;
  }

  /** Observe a native action boundary, independently of apply checkboxes. */
  actionProgress(token: string): void {
    if (this.status !== "running") return;
    if (token !== this.#progressToken) {
      this.#progressToken = token;
      this.#actionAdvanced = true;
      this.stalls = 0;
    }
  }

  /** Fresh read-only facts may change after execution stops. Never resume or approve here. */
  reconcile(snapshot: RasenSnapshot): boolean {
    if (!this.sameScope(snapshot)) {
      this.observationError =
        "Rasen change identity changed; current progress cannot be reconciled";
      return false;
    }
    this.snapshot = snapshot;
    this.observedAt = this.now();
    this.observationError = null;
    return true;
  }

  observe(snapshot: RasenSnapshot, countStall = true): void {
    if (!this.checkTime()) return;
    if (!this.sameScope(snapshot)) {
      this.stop("needs_user", "Rasen change identity changed; explicitly start a new run");
      return;
    }
    const completed = new Set(snapshot.tasks.filter((task) => task.done).map((task) => task.id));
    const progress = [...completed].some((id) => !this.#completed.has(id));
    this.stalls = progress || this.#actionAdvanced ? 0 : this.stalls + (countStall ? 1 : 0);
    this.#actionAdvanced = false;
    for (const id of completed) this.#completed.add(id);
    this.reconcile(snapshot);
  }

  continue(): boolean {
    if (!this.checkTime()) return false;
    if (this.config.maxSteps !== null && this.steps >= this.config.maxSteps) {
      this.stop("budget_exhausted", "Action-admission budget reached");
      return false;
    }
    if (this.config.maxStalls !== null && this.stalls >= this.config.maxStalls) {
      this.stop("stalled", "No native action or completed-task progress within the stall budget");
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
    fallbackTimeoutMs = this.config.decisionTimeoutMs,
  ): Promise<Decision | undefined> {
    if (!this.checkTime()) return;
    if (this.#deciding) {
      this.stop("blocked", "Concurrent decision rejected");
      return;
    }
    this.#deciding = true;
    let decision: Decision | undefined;
    let state: DecisionEvidence;
    let choices: Record<string, string>;
    const acceptable = (value: Decision | undefined): value is Decision =>
      !!value &&
      typeof value.choice === "string" &&
      Object.hasOwn(choices, value.choice) &&
      Number.isFinite(value.confidence) &&
      value.confidence >= this.config.minConfidence &&
      value.confidence <= 1 &&
      value.choice !== "uncertain";
    const attempt = async (provider: DecisionProvider, name: DecisionAttempt["provider"]) => {
      const started = this.now();
      const timeoutMs = name === "architect" ? fallbackTimeoutMs : this.config.decisionTimeoutMs;
      try {
        const value = await this.bounded(provider, state, signal, timeoutMs);
        const valid =
          !!value &&
          typeof value.choice === "string" &&
          Object.hasOwn(choices, value.choice) &&
          Number.isFinite(value.confidence) &&
          value.confidence >= 0 &&
          value.confidence <= 1;
        const accepted: boolean = acceptable(value);
        this.#decisionAttempts.push({
          provider: name,
          timeoutMs,
          outcome: !valid
            ? "invalid_response"
            : accepted
              ? "accepted"
              : value.choice === "uncertain"
                ? "uncertain"
                : "low_confidence",
          ...(valid ? { choice: value.choice, confidence: value.confidence } : {}),
          elapsedMs: Math.max(0, this.now() - started),
        });
        return valid ? value : undefined;
      } catch (error) {
        this.#decisionAttempts.push({
          provider: name,
          timeoutMs,
          outcome: "error",
          errorCode: decisionFailureCode(error),
          elapsedMs: Math.max(0, this.now() - started),
        });
        return undefined;
      }
    };
    try {
      this.decisions++;
      this.#decisionAttempts = [];
      try {
        if (signal.aborted) throw new DecisionFailure("DECISION_CANCELLED");
        state = sealDecisionEvidence(evidence, this.config.maxEvidenceChars);
        choices = state.choices!;
      } catch (error) {
        const errorCode = decisionFailureCode(error);
        this.#decisionAttempts.push({
          provider: "jev",
          timeoutMs: this.config.decisionTimeoutMs,
          outcome: "error",
          errorCode,
          elapsedMs: 0,
        });
        this.stop(
          signal.aborted ? "cancelled" : "uncertain",
          signal.aborted
            ? "Decision cancelled or timed out"
            : `Decision evidence or catalog rejected (${errorCode}); inspect decisionDiagnostics before explicitly restarting`,
        );
        return;
      }
      decision = await attempt(primary, "jev");
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
          decision = await attempt(fallback, "architect");
        } else decision = undefined;
      }
      if (signal.aborted) this.stop("cancelled", "Decision cancelled or timed out");
      else if (!acceptable(decision)) {
        const detail = this.#decisionAttempts
          .map(
            (item) =>
              `${item.provider}: ${item.errorCode ?? item.outcome}${item.confidence === undefined ? "" : ` (${item.choice}, confidence ${item.confidence})`}`,
          )
          .join("; ");
        this.stop(
          "uncertain",
          `No sufficiently certain next action (${detail}); inspect decisionDiagnostics before explicitly restarting`,
        );
      } else if (decision.choice === "needs_user")
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
    timeoutMs: number,
  ): Promise<Decision> {
    const timeout = new AbortController();
    const combined = AbortSignal.any([signal, timeout.signal]);
    if (combined.aborted) throw new DecisionFailure("DECISION_CANCELLED");
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    let abort: () => void = () => {};
    try {
      const cancelled = new Promise<never>((_, reject) => {
        abort = () =>
          reject(new DecisionFailure(signal.aborted ? "DECISION_CANCELLED" : "DECISION_TIMEOUT"));
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
      outcome: this.outcome ?? null,
      initialStop: this.#initialStop ? { ...this.#initialStop } : null,
      progress: this.snapshot.progress,
      steps:
        this.config.maxSteps === null ? `${this.steps}` : `${this.steps}/${this.config.maxSteps}`,
      toolCalls:
        this.config.maxToolCalls === null
          ? `${this.toolCalls}`
          : `${this.toolCalls}/${this.config.maxToolCalls}`,
      decisions: this.decisions,
      decisionDiagnostics: {
        minConfidence: this.config.minConfidence,
        timeoutMs: this.config.decisionTimeoutMs,
        attempts: this.#decisionAttempts.map((item) => ({ ...item })),
      },
      fallbacks: `${this.fallbacks}/${this.config.maxFallbacks}`,
      stalls:
        this.config.maxStalls === null
          ? `${this.stalls}`
          : `${this.stalls}/${this.config.maxStalls}`,
      elapsedMs: this.now() - this.startedAt,
      completionVerified:
        this.status === "completed" &&
        this.snapshot.fingerprint === this.#completionFingerprint &&
        !this.observationError,
      observation: { at: this.observedAt, error: this.observationError },
      supervision: {
        maxDurationMs: this.config.maxDurationMs,
        noOutputTimeoutMs: this.config.noOutputTimeoutMs,
        lastActivityAt: this.lastActivityAt,
      },
    };
  }
}

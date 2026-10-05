import type {
  AgentRegistry,
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

type Ref = NonNullable<ReturnType<AgentRegistry["get"]>>;
export interface NativeAsyncHost {
  session: AgentSession;
  registry: AgentRegistry;
}

/** Resolve the native owning session, never the process-global job manager. */
export function nativeAsyncHost(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): NativeAsyncHost | undefined {
  const registry = pi.pi.AgentRegistry.global();
  const session = registry.get(ctx.agent.id)?.session;
  if (
    !session ||
    session.sessionId !== ctx.sessionManager.getSessionId() ||
    session.getAgentId() !== ctx.agent.id ||
    !session.asyncJobManager
  )
    return;
  return { session, registry };
}

/**
 * Observe native settlement without taking ownership of execution or delivery.
 * Shared-owner work may delay Auto; it is never cancelled or appropriated.
 */
export class NativeQuiescence {
  private calls = new Map<string, string>();
  private interrupted = new Set<string>();
  readonly owner: string;
  readonly sessionId: string;

  constructor(readonly host: NativeAsyncHost) {
    this.owner = host.session.getAgentId()!;
    this.sessionId = host.session.sessionId;
  }

  get uncertainty(): readonly string[] {
    return [...this.interrupted];
  }

  callStarted(id: string, tool: string): void {
    this.calls.set(id, tool);
  }

  callEnded(id: string, interrupted = false): void {
    const tool = this.calls.get(id);
    this.calls.delete(id);
    // An interrupted dispatch can outlive its caller (notably parked IRC
    // revival). Existing SDK queries cannot prove that hidden dispatch ended.
    // tool_result can add interruption metadata after tool_execution_end has
    // already removed the active call. Missing metadata cannot prove safety.
    if (interrupted && (!tool || ["task", "bash", "eval", "write", "send", "irc"].includes(tool)))
      this.interrupted.add(id);
  }

  private current(): boolean {
    return (
      this.host.registry.get(this.owner)?.session === this.host.session &&
      this.host.session.sessionId === this.sessionId
    );
  }

  private descendants(): Ref[] {
    const refs = this.host.registry.list();
    const ids = new Set([this.owner]);
    const result: Ref[] = [];
    for (;;) {
      const next = refs.filter(
        (ref) => ref.kind === "sub" && !ids.has(ref.id) && ref.parentId && ids.has(ref.parentId),
      );
      if (!next.length) return result;
      for (const ref of next) {
        ids.add(ref.id);
        result.push(ref);
      }
    }
  }

  /**
   * Safe in Main tool/event callbacks. False is NOT a completion certificate:
   * Main's active prompt and hidden foreground jobs require the detached drain.
   */
  pending(exceptCalls: ReadonlySet<string> = new Set()): boolean {
    if (!this.current() || this.interrupted.size) return true;
    if ([...this.calls.keys()].some((id) => !exceptCalls.has(id))) return true;
    const main = this.host.session;
    if (main.hasPendingAsyncWork()) return true;
    const refs = this.descendants();
    const owners = new Set([this.owner, ...refs.map((ref) => ref.id)]);
    if (
      main
        .asyncJobManager!.getAllJobs()
        .some((job) => owners.has(job.ownerId ?? "") && job.status === "running")
    )
      return true;
    return refs.some(
      (ref) =>
        ref.status === "running" ||
        ref.session?.isStreaming ||
        ref.session?.hasAdmittedSubmission ||
        ref.session?.hasPendingAsyncWork(),
    );
  }

  /**
   * ONLY invoke detached after the awaited Main tool/event callback returns.
   * Native idle/submission waits otherwise wait on their own caller. Abort only
   * stops this observation; it never aborts a session, job, or pending delivery.
   */
  async waitForDrain(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !this.current() || this.interrupted.size) return false;
    let aborted: () => void = () => {};
    const cancellation = new Promise<never>((_, reject) => {
      aborted = () => reject(new Error("Native drain observation interrupted"));
      signal.addEventListener("abort", aborted, { once: true });
      if (signal.aborted) aborted();
    });
    const wait = <T>(value: Promise<T>) => Promise.race([value, cancellation]);
    try {
      for (;;) {
        if (!this.current() || this.interrupted.size || signal.aborted) return false;
        const refs = this.descendants();
        const sessions = [
          ...new Set([
            this.host.session,
            ...refs.flatMap((ref) => (ref.session ? [ref.session] : [])),
          ]),
        ];
        // Admission and IRC relay obligations can precede a visible job row.
        await wait(Promise.all(sessions.map((session) => session.waitForAdmittedSubmissions())));
        await wait(Promise.all(sessions.map((session) => session.waitForIrcReplies())));
        // Unlike hasPendingAsyncWork(), this includes suppressed/foreground
        // bodies. Cancelled job status alone is not proof of process exit.
        await wait(
          Promise.all(
            [this.owner, ...refs.map((ref) => ref.id)].map((owner) =>
              this.host.session.asyncJobManager!.waitForOwnerJobs(owner),
            ),
          ),
        );
        await wait(Promise.all(sessions.map((session) => session.settleAsyncWork())));
        await wait(Promise.all(sessions.map((session) => session.waitForIdle())));
        // A delivery follow-up may have created another hidden foreground body
        // under an existing owner; the public pending query cannot see it.
        await wait(
          Promise.all(
            [this.owner, ...refs.map((ref) => ref.id)].map((owner) =>
              this.host.session.asyncJobManager!.waitForOwnerJobs(owner),
            ),
          ),
        );
        if (!this.current() || this.interrupted.size) return false;
        const next = this.descendants();
        const changed =
          next.length !== refs.length ||
          next.some(
            (ref, index) => ref !== refs[index] || (ref.session && !sessions.includes(ref.session)),
          );
        if (
          !changed &&
          !this.pending() &&
          !this.host.session.hasAdmittedSubmission &&
          !this.host.session.isStreaming
        )
          return true;
        // Native follow-ups may admit more work; re-read instead of treating
        // one generation's idle as terminal. Yield also avoids stale-ref spins.
        await wait(new Promise((resolve) => setTimeout(resolve, 20)));
      }
    } catch {
      return false;
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  }
}

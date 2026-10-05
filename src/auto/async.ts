import type {
  AgentRegistry,
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

type Manager = NonNullable<AgentSession["asyncJobManager"]>;
type Job = NonNullable<ReturnType<Manager["getJob"]>>;
type Ref = NonNullable<ReturnType<AgentRegistry["get"]>>;
export interface NativeAsyncHost {
  session: AgentSession;
  registry: AgentRegistry;
}

/** Use the SDK's owning session, never the process-global job manager. */
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

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * Provenance ledger for one Auto run. Host task/wait/delivery scheduling remains
 * native. A retired ledger stays alive for late receipts: session ownership is
 * not run ownership, and an after/before snapshot delta would steal other jobs.
 */
export class AutoAsyncScope {
  readonly calls = new Map<string, { tool: string; active: boolean }>();
  readonly children = new Map<string, { callId: string; ref?: Ref; done: boolean }>();
  readonly jobs = new Map<Job, { callId?: string; settled: boolean }>();
  readonly manager: Manager;
  readonly owner: string;
  readonly sessionId: string;
  readonly settlementUnverified = new Set<string>();
  private unreceiptedErrors = new Set<string>();
  readonly baseline: Set<Job>;
  stopped = false;
  private stoppedAt = Number.POSITIVE_INFINITY;
  private sealed = false;
  private pendingChildren = new Map<string, { parent: string; status: string }>();
  private requested = new Map<string, string>();
  private aborting = new Set<Promise<unknown>>();
  private childFences = new Map<string, Promise<unknown>>();

  constructor(readonly host: NativeAsyncHost) {
    this.manager = host.session.asyncJobManager!;
    this.owner = host.session.getAgentId()!;
    this.sessionId = host.session.sessionId;
    this.baseline = new Set(this.manager.getAllJobs());
  }

  call(id: string, tool: string, active = false) {
    if (this.sealed) return;
    const existing = this.calls.get(id);
    if (!existing) this.calls.set(id, { tool, active });
    else if (active) existing.active = true;
    for (const [child, event] of this.pendingChildren) {
      if (event.parent === id) {
        this.pendingChildren.delete(child);
        this.lifecycle(child, id, event.status);
      }
    }
  }

  lifecycle(id: string, parent: string, status: string): boolean {
    if (this.sealed) return false;
    if (this.calls.get(parent)?.tool !== "task") {
      // Speculative tasks can emit before tool_call admission. Only a matching
      // streamed Main task id may later admit this event; arbitrary ids cannot.
      if (!this.stopped) this.pendingChildren.set(id, { parent, status });
      return false;
    }
    const ref = this.host.registry.get(id);
    if (!ref || ref.parentId !== this.owner) return false;
    const prior = this.children.get(id);
    if (prior && (prior.callId !== parent || prior.done || (prior.ref && prior.ref !== ref)))
      return false;
    const child = prior ?? { callId: parent, ref, done: false };
    child.ref = ref;
    this.children.set(id, child);
    // Discover jobs belonging to this child turn before closing its lifecycle.
    // OMP can reuse the same registry object for a later, unrelated wake turn.
    this.reconcile();
    if (status !== "started") {
      child.done = true;
      // Hidden foreground-backed leaf jobs may outlive the native task's bounded
      // cleanup. Snapshot this one-shot child's public owner join at its boundary.
      const fence = this.manager.waitForOwnerJobs(id);
      this.childFences.set(id, fence);
      void fence.finally(() => {
        if (this.childFences.get(id) === fence) this.childFences.delete(id);
      });
    }
    return true;
  }

  result(id: string, details: unknown, terminal = true, failed = false) {
    const call = this.calls.get(id);
    if (this.sealed || !call) return;
    if (terminal) call.active = false;
    const data = record(details);
    const async = record(data?.async);
    if (typeof async?.jobId === "string") {
      this.requested.set(async.jobId, id);
      this.settlementUnverified.delete(id);
      this.unreceiptedErrors.delete(id);
    } else if (terminal && !failed) this.settlementUnverified.delete(id);
    else if (
      terminal &&
      data?.__interrupted === true &&
      data.execution === "started" &&
      ["bash", "eval"].includes(call.tool)
    )
      this.settlementUnverified.add(id);
    if (
      terminal &&
      failed &&
      ["bash", "eval"].includes(call.tool) &&
      !async?.jobId &&
      data?.__synthetic !== true &&
      Object.keys(data ?? {}).length === 0
    )
      this.unreceiptedErrors.add(id);
    if (call.tool === "task") {
      // Batch receipts expose every agent in progress/results; async.jobId is
      // only the first job and may differ from the requested agent id.
      for (const items of [data?.progress, data?.results]) {
        if (!Array.isArray(items)) continue;
        for (const value of items) {
          const item = record(value);
          if (typeof item?.id !== "string" || this.children.has(item.id)) continue;
          const ref = this.host.registry.get(item.id);
          if (!ref || ref.parentId === this.owner)
            this.children.set(item.id, { callId: id, ref, done: false });
        }
      }
    }
    this.reconcile();
  }

  private track(job: Job, callId?: string) {
    if (this.jobs.has(job) || this.baseline.has(job)) return;
    const state = { callId, settled: false };
    this.jobs.set(job, state);
    // A cancelled status is not a join: the actual body must finish unwinding.
    void job.promise.then(
      () => {
        state.settled = true;
        this.reconcile();
      },
      () => {
        state.settled = true;
        this.reconcile();
      },
    );
  }

  reconcile() {
    for (const [id, call] of this.requested) {
      const job = this.manager.getJob(id);
      if (job?.ownerId === this.owner) {
        this.track(job, call);
        this.requested.delete(id);
      }
    }
    for (const job of this.sealed ? [] : this.manager.getAllJobs()) {
      const child = job.agentId ? this.children.get(job.agentId) : undefined;
      if (
        job.ownerId === this.owner &&
        child &&
        !child.done &&
        this.host.registry.get(job.agentId!) === child.ref
      )
        this.track(job, child.callId);
      else if (job.ownerId) {
        const owner = this.children.get(job.ownerId);
        if (owner && !owner.done && this.host.registry.get(job.ownerId) === owner.ref)
          this.track(job);
      }
    }
    if (!this.stopped) return;
    for (const [job] of this.jobs) {
      // Never suppress/cancel a replacement that reused a retired job id.
      if (this.manager.getJob(job.id) !== job) continue;
      this.manager.acknowledgeDeliveries([job.id]);
      this.manager.cancel(job.id, { ownerId: job.ownerId });
    }
    for (const child of this.children.values()) {
      const ref = child.ref;
      if (child.done || !ref || this.host.registry.get(ref.id) !== ref || ref.status !== "running")
        continue;
      // The public native registry tombstone reaches the task run monitor even
      // before a speculative child has entered prompt() or acquired a job row.
      this.host.registry.setStatus(ref.id, "aborted", ref);
      if (ref.session) {
        const pending = ref.session.abort().catch(() => {});
        this.aborting.add(pending);
        void pending.finally(() => this.aborting.delete(pending));
      }
    }
  }

  seal() {
    this.sealed = true;
    this.pendingChildren.clear();
    this.requested.clear();
  }

  staleDelivery(id: string, timestamp: number): boolean {
    // Only a batch assembled before our first stop can have bypassed the native
    // suppression flag. Future reuse/eviction of a job ID cannot stale new work.
    return (
      this.stopped &&
      timestamp <= this.stoppedAt &&
      [...this.jobs.keys()].some(
        (job) =>
          job.id === id &&
          timestamp >= job.startTime &&
          (!this.manager.getJob(id) ||
            this.manager.getJob(id) === job ||
            timestamp < this.manager.getJob(id)!.startTime),
      )
    );
  }

  nextAssistant() {
    this.unreceiptedErrors.clear();
  }

  interrupted() {
    for (const id of this.unreceiptedErrors) this.settlementUnverified.add(id);
  }

  stop() {
    for (const [id, call] of this.calls) {
      if (
        call.active &&
        ["bash", "eval"].includes(call.tool) &&
        ![...this.jobs.values()].some((job) => job.callId === id)
      )
        this.settlementUnverified.add(id);
    }
    if (!this.stopped) this.stoppedAt = Date.now();
    this.stopped = true;
    this.reconcile();
  }

  pending(exceptCalls: ReadonlySet<string> = new Set()): boolean {
    this.reconcile();
    return (
      this.aborting.size > 0 ||
      this.childFences.size > 0 ||
      [...this.calls].some(
        ([id, call]) =>
          call.active && ["task", "bash", "eval"].includes(call.tool) && !exceptCalls.has(id),
      ) ||
      [...this.jobs].some(
        ([, job]) => !job.settled && (!job.callId || !exceptCalls.has(job.callId)),
      ) ||
      [...this.children.values()].some(
        (child) => !child.done && child.ref?.status === "running" && !exceptCalls.has(child.callId),
      )
    );
  }

  async join(): Promise<void> {
    this.reconcile();
    await Promise.all([...this.jobs.keys()].map((job) => job.promise));
    await Promise.all([...this.aborting, ...this.childFences.values()]);
    this.reconcile();
  }

  callSettlement(id: string): Promise<void> | undefined {
    this.reconcile();
    const jobs = [...this.jobs].filter(([, state]) => state.callId === id && !state.settled);
    return jobs.length ? Promise.all(jobs.map(([job]) => job.promise)).then(() => {}) : undefined;
  }

  ownsChild(id: string): boolean {
    return this.children.has(id);
  }
  ownsCall(id: string): boolean {
    return this.calls.has(id);
  }
}

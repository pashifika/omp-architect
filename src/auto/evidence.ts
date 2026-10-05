import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { createHash } from "node:crypto";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { NativeAsyncHost } from "./async.ts";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
  nativeResultModel,
  type NativeModelRoute,
  type NativeProducerModel,
  type NativeRecipientProvenance,
} from "./model-route.ts";

/** Sealed skill selection captured when the caller admitted native work. */
export interface NativeActionAdmission {
  actionId: string;
  skillName: string;
  inputFingerprint: string;
  selectionFingerprint: string;
  allowedRoles: string[];
  modelRoute?: NativeModelRoute;
  roleRoutes?: Record<string, NativeModelRoute>;
}

/** Native provenance and raw output only; the selected skill owns its semantics. */
export interface NativeActionReceipt {
  admission: NativeActionAdmission;
  role: string;
  requestId: string;
  producer: {
    agentId: string;
    sessionId?: string;
    receiptId: string;
    artifactSha256: string;
    model?: NativeProducerModel;
  };
  evidence: string;
  settled: true;
  success: true;
}

type Producer = NonNullable<ReturnType<NativeAsyncHost["registry"]["get"]>>;

type Dispatch = {
  requestId: string;
  admission: NativeActionAdmission;
  at: number;
  message?: string;
  recipients: Set<string>;
  taskProducers: Map<string, Producer>;
  results: Map<string, Record<string, unknown>>;
  progress: Map<string, Record<string, unknown>>;
  consumed: Set<string>;
  incoming: Map<string, string>;
  priorOutcomes: ReadonlySet<object>;
  priorJobs: ReadonlySet<object>;
  asyncJobId?: string;
  taskJobs: Map<string, AsyncJob>;
  taskModels: Map<string, NativeProducerModel>;
  registrationWatches: Map<string, () => void>;
  pendingTaskRoles: Map<string, string>;
  rejectedTaskIds: Set<string>;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Observe native write's actual target normalization without executing the write. */
export function nativeWriteTarget(input: object): string | undefined {
  if (!("path" in input) || typeof input.path !== "string") return;
  try {
    return InternalUrlRouter.instance().peelWriteSelector(
      unwrapHashlineHeaderPath(input.path),
      "write",
    );
  } catch {
    return;
  }
}

/** Observe the same path forms as native write; never wrap or execute it. */
export function nativeAgentMessagePath(input: Record<string, unknown>): string | undefined {
  const path = nativeWriteTarget(input);
  return path && /^agent:\/\//i.test(path) ? path : undefined;
}

/** Complete, call-specific native yield payload; metadata alone is not evidence. */
function yieldEvidence(values: unknown[]): string | undefined {
  const items = values.map(record);
  const terminal = items.at(-1);
  if (
    !terminal ||
    terminal.status !== "success" ||
    (Array.isArray(terminal.type) && terminal.complete !== true) ||
    items.some((item) => !item || item.status !== "success" || item.data === undefined)
  )
    return;
  if (items.length === 1)
    return typeof terminal.data === "string" ? terminal.data : JSON.stringify(terminal.data);
  return JSON.stringify(items);
}

/** Action-scoped native evidence, never a workflow or cancellation ledger. */
export class NativeActionEvidence {
  private readonly requests = new Map<string, Dispatch>();
  private readonly incomingOwners = new Map<string, string>();
  private readonly acceptedReceipts = new Set<string>();
  private readonly producerRoles = new WeakMap<object, string>();
  private readonly producerSessionFiles = new WeakMap<object, string>();
  private readonly consumedTasks = new WeakSet<object>();
  constructor(readonly host: NativeAsyncHost) {}

  admit(
    callId: string,
    tool: string,
    input: Record<string, unknown>,
    admission: NativeActionAdmission,
  ) {
    if (this.requests.has(callId)) return;
    const message =
      tool === "write" && nativeAgentMessagePath(input) !== undefined
        ? input.content
        : tool === "send" || tool === "irc"
          ? input.message
          : undefined;
    if (tool !== "task" && typeof message !== "string") return;
    this.requests.set(callId, {
      requestId: crypto.randomUUID(),
      admission: {
        ...admission,
        allowedRoles: [...admission.allowedRoles],
        ...(admission.modelRoute ? { modelRoute: { ...admission.modelRoute } } : {}),
        ...(admission.roleRoutes
          ? {
              roleRoutes: Object.fromEntries(
                Object.entries(admission.roleRoutes).map(([role, route]) => [role, { ...route }]),
              ),
            }
          : {}),
      },
      at: Date.now(),
      ...(typeof message === "string" ? { message } : {}),
      recipients: new Set(),
      taskProducers: new Map(),
      results: new Map(),
      progress: new Map(),
      consumed: new Set(),
      incoming: new Map(),
      taskJobs: new Map(),
      taskModels: new Map(),
      registrationWatches: new Map(),
      pendingTaskRoles: new Map(),
      rejectedTaskIds: new Set(),
      priorJobs: new Set(this.host.session.asyncJobManager?.getAllJobs() ?? []),
      // Historical terminal outcomes cannot certify a later semantic request,
      // including when millisecond timestamps collide. This never owns jobs.
      priorOutcomes: new Set(
        this.host.session.asyncJobManager
          ?.getAllJobs()
          .filter(
            (job) =>
              job.type === "task" &&
              job.ownerId === this.host.session.getAgentId() &&
              job.status !== "running",
          ) ?? [],
      ),
    });
  }

  receipt(callId: string, details: unknown) {
    const request = this.requests.get(callId);
    const envelope = record(details);
    const data = record(envelope?.message) ?? envelope;
    if (!request || !data) return;
    if (data.op === "send" && data.from === this.host.session.getAgentId()) {
      for (const item of Array.isArray(data.receipts) ? data.receipts : []) {
        const receipt = record(item);
        if (typeof receipt?.to === "string" && receipt.outcome !== "failed")
          request.recipients.add(receipt.to);
      }
    }
    for (const key of ["results", "progress"]) {
      for (const item of Array.isArray(data[key]) ? data[key] : []) {
        const result = record(item);
        if (typeof result?.id !== "string") continue;
        request.recipients.add(result.id);
        if (
          request.message === undefined &&
          !request.asyncJobId &&
          key === "progress" &&
          result.status === "pending" &&
          typeof record(data.async)?.jobId === "string" &&
          typeof result.agent === "string" &&
          request.admission.allowedRoles.includes(result.agent)
        )
          request.pendingTaskRoles.set(result.id, result.agent);
        const ref = this.host.registry.get(result.id);
        if (request.message === undefined && ref && !request.taskProducers.has(result.id))
          request.taskProducers.set(result.id, ref);
        if (
          request.taskProducers.get(result.id) === ref &&
          ref?.sessionFile &&
          !this.producerSessionFiles.has(ref)
        )
          this.producerSessionFiles.set(ref, ref.sessionFile);
        if (
          request.message === undefined &&
          ref &&
          request.taskProducers.get(result.id) === ref &&
          ref.parentId === this.host.session.getAgentId() &&
          typeof result.agent === "string"
        )
          this.producerRoles.set(ref, result.agent);
        if (request.message === undefined && (key === "results" || result.status === "completed")) {
          const model = nativeResultModel(result, this.host);
          if (model) request.taskModels.set(result.id, model);
          else request.taskModels.delete(result.id);
        }
        if (key === "results") request.results.set(result.id, result);
        else request.progress.set(result.id, result);
      }
    }
    const async = record(data.async);
    if (typeof async?.jobId === "string") {
      const job = this.host.session.asyncJobManager?.getJob(async.jobId);
      if (
        job?.agentId &&
        job.type === "task" &&
        job.ownerId === this.host.session.getAgentId() &&
        !request.priorJobs.has(job)
      ) {
        request.recipients.add(job.agentId);
        if (request.message === undefined) {
          request.asyncJobId ??= job.id;
          if (!request.taskJobs.has(job.agentId)) request.taskJobs.set(job.agentId, job);
          this.watchTaskRegistration(request, job);
        }
      }
    }
    this.observeBatchJobs(request);
  }

  /** A native pending row precedes per-job details in queued batch launches. */
  private matchingBatch(request: Dispatch, job: AsyncJob): boolean {
    if (!job.agentId || request.rejectedTaskIds.has(job.agentId)) return false;
    const async = job.latestDetails?.async;
    if (async !== undefined && record(async)?.jobId !== request.asyncJobId) {
      if (request.taskJobs.get(job.agentId) === job || request.pendingTaskRoles.has(job.agentId))
        request.rejectedTaskIds.add(job.agentId);
      return false;
    }
    return (
      async !== undefined ||
      job.id === request.asyncJobId ||
      request.pendingTaskRoles.has(job.agentId)
    );
  }

  /** Discover exact same-batch jobs, or uniquely correlated native pending rows. */
  private observeBatchJobs(request: Dispatch): void {
    if (request.message !== undefined || !request.asyncJobId) return;
    const manager = this.host.session.asyncJobManager;
    const candidates = new Map<string, AsyncJob[]>();
    for (const job of manager?.getAllJobs() ?? []) {
      if (
        job.type !== "task" ||
        job.ownerId !== this.host.session.getAgentId() ||
        !job.agentId ||
        request.priorJobs.has(job) ||
        manager?.getJob(job.id) !== job
      )
        continue;
      const peers = candidates.get(job.agentId) ?? [];
      peers.push(job);
      candidates.set(job.agentId, peers);
    }
    for (const [id, jobs] of candidates) {
      const bound = request.taskJobs.get(id);
      if (!bound && jobs.length !== 1) {
        if (request.pendingTaskRoles.has(id)) request.rejectedTaskIds.add(id);
        continue;
      }
      const job = bound ?? jobs[0];
      if (!jobs.includes(job) || !this.matchingBatch(request, job)) continue;
      if (!bound) request.taskJobs.set(id, job);
      this.watchTaskRegistration(request, job);
    }
  }

  /** A detached task can return its pending row before native registration. */
  private watchTaskRegistration(request: Dispatch, job: AsyncJob): void {
    const id = job.agentId;
    if (
      !id ||
      job.status !== "running" ||
      request.taskProducers.has(id) ||
      request.registrationWatches.has(id) ||
      this.host.registry.get(id)
    )
      return;
    const role = request.pendingTaskRoles.get(id) ?? request.progress.get(id)?.agent;
    if (typeof role !== "string" || !request.admission.allowedRoles.includes(role)) return;
    const stop = this.host.registry.onChange((event) => {
      if (event.type !== "registered" || event.ref.id !== id) return;
      request.registrationWatches.get(id)?.();
      request.registrationWatches.delete(id);
      if (
        this.host.session.asyncJobManager?.getJob(job.id) !== job ||
        job.type !== "task" ||
        job.ownerId !== this.host.session.getAgentId() ||
        job.agentId !== id ||
        job.status !== "running" ||
        request.priorJobs.has(job) ||
        !this.matchingBatch(request, job)
      )
        return;
      // Capture the first exact ref. Even an unexpected parent cannot be replaced
      // later by a same-ID ref and inherit this dispatch's provenance.
      request.taskProducers.set(id, event.ref);
      if (event.ref.parentId !== this.host.session.getAgentId()) return;
      this.producerRoles.set(event.ref, role);
      if (event.ref.sessionFile) this.producerSessionFiles.set(event.ref, event.ref.sessionFile);
    });
    request.registrationWatches.set(id, stop);
    const release = () => {
      request.registrationWatches.get(id)?.();
      request.registrationWatches.delete(id);
    };
    // Registration observers never outlive their admitted native operation.
    void job.promise.then(release, release);
  }

  /**
   * Native task receipts, not a requested display name, bind the recipient role.
   * Detached completion details may arrive only on the actual native job. Read
   * those before IRC admission so active/idle/parked peers remain native-owned.
   */
  recipient(id: string): { role: string; provenance?: NativeRecipientProvenance } | undefined {
    const ref = this.host.registry.get(id);
    if (!ref || ref.parentId !== this.host.session.getAgentId()) return;
    for (const [callId, request] of this.requests) {
      if (request.message !== undefined) continue;
      this.observeBatchJobs(request);
      if (request.rejectedTaskIds.has(id)) return;
      const job = request.taskJobs.get(id);
      if (
        job &&
        (job.status === "running" || job.status === "completed") &&
        job.latestDetails &&
        this.host.session.asyncJobManager?.getJob(job.id) === job &&
        job.ownerId === this.host.session.getAgentId() &&
        job.agentId === id &&
        !request.priorJobs.has(job)
      ) {
        const own = (items: unknown) =>
          Array.isArray(items) ? items.filter((item) => record(item)?.id === id) : [];
        this.receipt(callId, {
          ...job.latestDetails,
          progress: own(job.latestDetails.progress),
          results: own(job.latestDetails.results),
        });
      }
      if (request.taskProducers.get(id) !== ref) continue;
      const role = this.producerRoles.get(ref) ?? ref.history?.agent;
      if (!role || !request.admission.allowedRoles.includes(role)) continue;
      const model = request.taskModels.get(id);
      const sessionFile = this.producerSessionFiles.get(ref);
      return {
        role,
        ...(model && sessionFile
          ? {
              provenance: { ref, sessionFile, model: { ...model } },
            }
          : {}),
      };
    }
    // A native-restored role may support a live route check; it cannot manufacture
    // the exact task attribution required for disk-only parked admission.
    return ref.history?.agent ? { role: ref.history.agent } : undefined;
  }

  async consume(maxBytes: number, signal: AbortSignal): Promise<NativeActionReceipt[]> {
    const receipts: NativeActionReceipt[] = [];
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return receipts;
    for (const [callId, request] of this.requests) {
      if (signal.aborted) return receipts;
      // Detached spawns stop emitting tool events after the original call
      // returns. Their exact native jobs retain the terminal details, including
      // complete yields, even when Auto scheduling is held. Never borrow a
      // later wake's job, mutable output artifact, or a historical outcome.
      if (request.message === undefined && request.asyncJobId) {
        this.observeBatchJobs(request);
        for (const job of request.taskJobs.values()) {
          if (job.status !== "completed" || !this.matchingBatch(request, job)) continue;
          try {
            await job.promise;
          } catch {
            continue;
          }
          if (signal.aborted) return receipts;
          if (job.status === "completed" && job.latestDetails) {
            // A batched job's snapshot also contains its peers. Only this
            // exact job's own terminal row is fresh; another peer's cached
            // running row must not overwrite a later settled row.
            const own = (value: unknown) =>
              Array.isArray(value) ? value.filter((item) => record(item)?.id === job.agentId) : [];
            this.receipt(callId, {
              ...job.latestDetails,
              progress: own(job.latestDetails.progress),
              results: own(job.latestDetails.results),
            });
          }
        }
      }
      for (const id of request.recipients) {
        if (request.consumed.has(id) || request.rejectedTaskIds.has(id)) continue;
        const ref = this.host.registry.get(id);
        if (!ref || ref.parentId !== this.host.session.getAgentId()) continue;
        if (ref.status !== "idle" && ref.status !== "parked") continue;
        const role = ref.history?.agent ?? this.producerRoles.get(ref);
        if (!role || !request.admission.allowedRoles.includes(role)) continue;
        if (
          request.message === undefined &&
          (request.taskProducers.get(id) !== ref || this.consumedTasks.has(ref))
        )
          continue;
        const acceptedAt = ref.lifecycle?.acceptedAt;
        const terminalAt = ref.lifecycle?.terminalAt;
        const producerSession = ref.session;
        let output: string | undefined;
        let producerModel = request.taskModels.get(id);
        let receiptId = `task:${callId}:${id}`;
        if (request.message !== undefined) {
          // A native receipt admits the send; the recipient's native incoming
          // record and a later terminal response prove which request it answered.
          // An echoed request ID in model text is never provenance.
          const messages =
            ref.session?.messages ??
            (ref.sessionFile ? await loadSessionMessagesReadOnly(ref.sessionFile) : []);
          const bound = request.incoming.get(id);
          const incoming = messages.findIndex((message) => {
            if (message.role !== "custom" || message.customType !== "irc:incoming") return false;
            const details = record(message.details);
            if (typeof details?.id !== "string") return false;
            if (bound) return details.id === bound;
            return (
              message.timestamp >= request.at &&
              details.from === this.host.session.getAgentId() &&
              details.message === request.message &&
              !this.incomingOwners.has(details.id)
            );
          });
          if (incoming < 0) continue;
          const nativeIncoming = messages[incoming];
          const incomingId = String(
            record(nativeIncoming.role === "custom" ? nativeIncoming.details : undefined)?.id,
          );
          request.incoming.set(id, incomingId);
          this.incomingOwners.set(incomingId, callId);
          const tail = messages.slice(incoming + 1);
          // Later native input supersedes the answer boundary. Never attach a
          // later wake result to an older semantic request.
          if (
            tail.some(
              (message) => message.role === "custom" && message.customType === "irc:incoming",
            )
          )
            continue;
          const lastAssistant = tail.findLast((message) => message.role === "assistant");
          if (
            !lastAssistant ||
            lastAssistant.role !== "assistant" ||
            lastAssistant.stopReason === "aborted" ||
            lastAssistant.stopReason === "error"
          )
            continue;
          const yielded = tail.findLast(
            (message) => message.role === "toolResult" && message.toolName === "yield",
          );
          if (!yielded || yielded.role !== "toolResult" || yielded.isError) continue;
          const result = record(yielded.details);
          if (
            result?.status !== "success" ||
            (Array.isArray(result.type) && result.complete !== true) ||
            !ref.lifecycle?.acceptedAt ||
            ref.lifecycle.acceptedAt < nativeIncoming.timestamp
          )
            continue;
          const outcome = this.host.session.asyncJobManager
            ?.getAllJobs()
            .filter(
              (job) =>
                job.type === "task" &&
                !request.priorOutcomes.has(job) &&
                job.agentId === id &&
                job.ownerId === this.host.session.getAgentId() &&
                job.endTime !== undefined &&
                job.endTime >= nativeIncoming.timestamp &&
                job.endTime >= ref.lifecycle!.acceptedAt! &&
                job.startTime <= (ref.lifecycle!.terminalAt ?? ref.lifecycle!.acceptedAt!),
            )
            .sort(
              (a, b) =>
                b.startTime - a.startTime ||
                b.endTime! - a.endTime! ||
                Number(a.status === "completed") - Number(b.status === "completed"),
            )[0];
          // Yield acceptance precedes native finalization. Only its successful
          // native task outcome can make the receipt eligible as action evidence.
          if (!outcome || outcome.status !== "completed") continue;
          try {
            await outcome.promise;
          } catch {
            continue;
          }
          if (signal.aborted) return receipts;
          if (outcome.status !== "completed") continue;
          // The native transcript carries the full original yields. Agent
          // outputPath is mutable across wakes and is not request provenance.
          const yields = tail.flatMap((message, index) => {
            if (message.role !== "toolResult" || message.toolName !== "yield" || message.isError)
              return [];
            const details = record(message.details);
            if (!details || details.status !== "success") return [];
            if (details.data !== undefined) return [details];
            if (details.useLastTurn !== true) return [details];
            const prose = tail
              .slice(0, index)
              .findLast(
                (entry) =>
                  entry.role === "assistant" &&
                  !entry.content.some((part) => part.type === "toolCall"),
              );
            const data =
              prose?.role === "assistant"
                ? prose.content
                    .flatMap((part) => (part.type === "text" ? [part.text] : []))
                    .join("\n")
                : undefined;
            return [{ ...details, data: data?.trim() ? data : undefined }];
          });
          const serving = ref.session?.servingModel;
          producerModel = serving
            ? nativeResultModel(
                {
                  resolvedModelIdentity: serving.modelIdentity,
                  resolvedThinkingLevel: serving.thinkingLevel,
                },
                this.host,
              )
            : undefined;
          // The final native assistant is additional evidence against attributing
          // a response to a newly selected model that never produced this turn.
          if (
            producerModel &&
            (lastAssistant.provider !== producerModel.provider ||
              lastAssistant.model !== producerModel.id)
          )
            producerModel = undefined;
          output = yieldEvidence(yields);
          receiptId = `yield:${id}:${outcome.id}:${outcome.startTime}:${yielded.toolCallId}:${yielded.timestamp}`;
          if (this.acceptedReceipts.has(receiptId)) continue;
        } else {
          const taskJob = request.taskJobs.get(id);
          if (taskJob && taskJob.status !== "completed") continue;
          const result = request.results.get(id);
          if (result && (result.exitCode !== 0 || result.error || result.aborted)) continue;
          if (!result) {
            const progress = request.progress.get(id);
            if (progress?.status !== "completed") continue;
            const extracted = record(progress.extractedToolData);
            const yields = Array.isArray(extracted?.yield) ? extracted.yield : [];
            // The original native job's complete extracted yields survive
            // later wakes. useLastTurn without its body fails closed.
            output = yieldEvidence(yields);
          } else if (result.truncated !== true && typeof result.output === "string")
            output = result.output;
          else {
            const extracted = record(result.extractedToolData);
            output = yieldEvidence(Array.isArray(extracted?.yield) ? extracted.yield : []);
          }
        }
        if (!output?.trim() || Buffer.byteLength(output) > maxBytes || signal.aborted) continue;
        if (
          this.host.registry.get(id) !== ref ||
          ref.parentId !== this.host.session.getAgentId() ||
          (ref.history?.agent ?? this.producerRoles.get(ref)) !== role ||
          ref.session !== producerSession ||
          (ref.status !== "idle" && ref.status !== "parked") ||
          ref.lifecycle?.acceptedAt !== acceptedAt ||
          ref.lifecycle?.terminalAt !== terminalAt
        )
          continue;
        // A concurrent collector may have settled this same native receipt
        // while transcript loading or finalization was awaited.
        if (request.consumed.has(id) || this.acceptedReceipts.has(receiptId)) continue;
        receipts.push({
          admission: structuredClone(request.admission),
          role,
          requestId: request.requestId,
          producer: {
            agentId: id,
            sessionId: ref.session?.sessionId,
            receiptId,
            artifactSha256: createHash("sha256").update(output).digest("hex"),
            ...(producerModel ? { model: { ...producerModel } } : {}),
          },
          settled: true,
          success: true,
          evidence: output,
        });
        request.consumed.add(id);
        this.acceptedReceipts.add(receiptId);
        // Native task spawns are single-use evidence producers. Subsequent
        // work in the same child needs its own native IRC input/yield boundary.
        if (request.message === undefined) this.consumedTasks.add(ref);
      }
    }
    return receipts;
  }
}

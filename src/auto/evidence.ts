import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { unwrapHashlineHeaderPath } from "@oh-my-pi/pi-coding-agent/tools/plan-mode-guard";
import { createHash } from "node:crypto";
import { loadSessionMessagesReadOnly } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import type { NativeAsyncHost } from "./async.ts";
import type { HostAutoWorkflow, HostWorkflowState } from "./workflow.ts";

type Dispatch = {
  requestId: string;
  phase: HostWorkflowState;
  at: number;
  message?: string;
  recipients: Set<string>;
  results: Map<string, Record<string, unknown>>;
  progress: Map<string, Record<string, unknown>>;
  consumed: Set<string>;
  incoming: Map<string, string>;
  priorOutcomes: ReadonlySet<object>;
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Observe the same path forms as native write; never wrap or execute it. */
export function nativeAgentMessagePath(input: Record<string, unknown>): string | undefined {
  if (typeof input.path !== "string") return;
  const unwrapped = unwrapHashlineHeaderPath(input.path);
  if (!/^agent:\/\//i.test(unwrapped)) return;
  try {
    return InternalUrlRouter.instance().peelWriteSelector(unwrapped, "write");
  } catch {
    return;
  }
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

/** Semantic evidence requests, not an execution or cancellation ledger. */
export class NativeReviewEvidence {
  private readonly requests = new Map<string, Dispatch>();
  private readonly incomingOwners = new Map<string, string>();
  private readonly acceptedReceipts = new Set<string>();
  private readonly producerRoles = new WeakMap<object, string>();
  constructor(readonly host: NativeAsyncHost) {}

  admit(callId: string, tool: string, input: Record<string, unknown>, phase: HostWorkflowState) {
    if (!["verify", "fix"].includes(phase.phase) || this.requests.has(callId)) return;
    const message =
      tool === "write" && nativeAgentMessagePath(input) !== undefined
        ? input.content
        : tool === "send" || tool === "irc"
          ? input.message
          : undefined;
    if (tool !== "task" && typeof message !== "string") return;
    this.requests.set(callId, {
      requestId: crypto.randomUUID(),
      phase: { ...phase },
      at: Date.now(),
      ...(typeof message === "string" ? { message } : {}),
      recipients: new Set(),
      results: new Map(),
      progress: new Map(),
      consumed: new Set(),
      incoming: new Map(),
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
        const ref = this.host.registry.get(result.id);
        if (
          request.message === undefined &&
          ref &&
          ref.parentId === this.host.session.getAgentId() &&
          typeof result.agent === "string"
        )
          this.producerRoles.set(ref, result.agent);
        if (key === "results") request.results.set(result.id, result);
        else request.progress.set(result.id, result);
      }
    }
    const async = record(data.async);
    if (typeof async?.jobId === "string") {
      const job = this.host.session.asyncJobManager?.getJob(async.jobId);
      if (job?.agentId) request.recipients.add(job.agentId);
    }
  }

  async consume(workflow: HostAutoWorkflow, maxBytes: number, signal: AbortSignal) {
    for (const [callId, request] of this.requests) {
      if (signal.aborted) return;
      for (const id of request.recipients) {
        if (request.consumed.has(id)) continue;
        const ref = this.host.registry.get(id);
        if (!ref || ref.parentId !== this.host.session.getAgentId()) continue;
        if (ref.status !== "idle" && ref.status !== "parked") continue;
        const role = ref.history?.agent ?? this.producerRoles.get(ref);
        const acceptedAt = ref.lifecycle?.acceptedAt;
        const terminalAt = ref.lifecycle?.terminalAt;
        const producerSession = ref.session;
        let output: string | undefined;
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
          // native task outcome can make the receipt eligible as review evidence.
          if (!outcome || outcome.status !== "completed") continue;
          await outcome.promise;
          if (signal.aborted) return;
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
          output = yieldEvidence(yields);
          receiptId = `yield:${id}:${outcome.id}:${outcome.startTime}:${yielded.toolCallId}:${yielded.timestamp}`;
          if (this.acceptedReceipts.has(receiptId)) continue;
        } else {
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
          ref.session !== producerSession ||
          (ref.status !== "idle" && ref.status !== "parked") ||
          ref.lifecycle?.acceptedAt !== acceptedAt ||
          ref.lifecycle?.terminalAt !== terminalAt
        )
          continue;
        const phase = request.phase;
        const proof = {
          reviewRequestId: request.requestId,
          revision: phase.revision,
          requiredCheck: phase.phase === "fix" ? "fix" : (phase.stage ?? ""),
          producer: {
            agentId: id,
            sessionId: ref.session?.sessionId,
            receiptId,
            artifactSha256: createHash("sha256").update(output).digest("hex"),
          },
          snapshotFingerprint: phase.snapshotFingerprint,
          workflowFingerprint: phase.workflowFingerprint,
          settled: true,
          success: true,
          evidence: output,
        };
        const accepted =
          phase.phase === "verify" && role === "omp-reviewer"
            ? workflow.recordVerification({
                ...proof,
                role,
                stages: phase.stage ? [phase.stage] : [],
              })
            : phase.phase === "fix" && role === "omp-worker"
              ? workflow.recordFix({ ...proof, role })
              : false;
        if (accepted) {
          request.consumed.add(id);
          this.acceptedReceipts.add(receiptId);
        }
      }
    }
  }
}

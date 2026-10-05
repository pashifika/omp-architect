import { nativeAsyncHost } from "./auto/async.ts";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, type Config } from "./config.ts";
import {
  Orchestrator,
  routeAgent,
  type Reviewer,
  type Phase,
  type ReviewMaterial,
} from "./core.ts";
import {
  loadReviewMaterial,
  saveReviewMaterial,
  reviewWrite,
  reviewCarrier,
  completionCarrier,
} from "./artifacts.ts";
import { createReviewer } from "./reviewer.ts";
import { createAutoController, autoStepCarrier, type AutoDependencies } from "./auto/extension.ts";
import instructions from "./prompts/orchestration.md" with { type: "text" };

// Only the documented canonical devices share their native tool identity.
function effectiveToolName(toolName: string, input: object): string {
  if (toolName === "write" && "path" in input) {
    if (input.path === "xd://architect_checkpoint") return "architect_checkpoint";
    if (input.path === "xd://auto_status") return "auto_status";
    if (input.path === "xd://auto_step") return "auto_step";
  }
  return toolName;
}

type ReviewerFactory = (pi: ExtensionAPI, ctx: ExtensionContext, config: Config) => Reviewer;
function captureMetadata(details: unknown): unknown {
  if (!details || typeof details !== "object" || !("meta" in details)) return;
  const meta = details.meta;
  if (!meta || typeof meta !== "object") return;
  const pick = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const result: Record<string, string | number | boolean> = {};
    for (const key of [
      "artifactId",
      "artifactElidedBytes",
      "totalBytes",
      "outputBytes",
      "elidedBytes",
      "partialLine",
    ])
      if (key in value) {
        const field = (value as Record<string, unknown>)[key];
        if (
          typeof field === "number" ||
          typeof field === "boolean" ||
          (typeof field === "string" && field.length <= 100)
        )
          result[key] = field;
      }
    return result;
  };
  const source = meta as Record<string, unknown>;
  const limits = source.limits as { columnTruncated?: unknown } | undefined;
  return {
    truncation: pick(source.truncation),
    columnTruncated: pick(limits?.columnTruncated),
    artifactCaptureFailed: !!source.artifactError,
  };
}
export function extensionFactory(
  reviewerFactory: ReviewerFactory = createReviewer,
  autoDependencies?: AutoDependencies,
) {
  return (pi: ExtensionAPI): void => {
    let state: Orchestrator | undefined;
    let configError = "";
    let lifetime = new AbortController();
    let stopped = false;
    let generation = 0;
    let expectedContinuation = "";
    let acceptedPrompt = "";
    let newUserRequest = false;
    const activeEvals = new Map<string, Record<string, unknown>>();
    const autoCompletionCarriers = new Set<string>();
    let queuedCompletion:
      | {
          material: ReviewMaterial;
          invocationId: string;
          generation: number;
          signal: AbortSignal;
          detach: () => void;
        }
      | undefined;
    const clearQueuedCompletion = () => {
      queuedCompletion?.detach();
      queuedCompletion = undefined;
    };
    const continueWith = (text: string) => {
      acceptedPrompt = "";
      expectedContinuation = `${text}\n\nArchitect continuation: ${crypto.randomUUID()}`;
      return { continue: true, additionalContext: expectedContinuation };
    };
    const stopBlocked = (reason: string, ctx: ExtensionContext) => {
      if (stopped) return;
      stopped = true;
      newUserRequest = false;
      clearQueuedCompletion();
      if (state) {
        state.blocked = reason;
        state.invalidate();
      }
      acceptedPrompt = "";
      expectedContinuation = "";
      auto.architectBlocked(reason, ctx);
      pi.sendMessage(
        {
          customType: "omp-architect",
          content: `Blocked: ${reason}. Completion remains unverified. Start a new request after resolving the blocker.\n${JSON.stringify({ lastReview: state?.lastReview ?? null, stopOrigin: "architect_terminal" })}`,
          display: true,
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      ctx.ui.notify(`OMP Architect blocked: ${reason}. Completion remains unverified.`, "warning");
      if (!auto.handlesCompletion()) ctx.abort();
    };
    const initialize = async (ctx: ExtensionContext) => {
      generation++;
      activeEvals.clear();
      autoCompletionCarriers.clear();
      clearQueuedCompletion();
      stopped = false;
      newUserRequest = false;
      acceptedPrompt = "";
      expectedContinuation = "";
      lifetime.abort();
      lifetime = new AbortController();
      state = undefined;
      configError = "";
      await auto.initialize(ctx);
      try {
        state = new Orchestrator(await loadConfig(ctx.cwd));
      } catch (error) {
        configError = `OMP Architect configuration error: ${error instanceof Error ? error.message : String(error)}`;
        ctx.ui.notify(configError, "error");
      }
    };
    const review = async (
      phase: Phase,
      material: ReviewMaterial,
      ctx: ExtensionContext,
      signal?: AbortSignal,
      invocationId?: string,
    ) => {
      if (!state)
        return {
          decision: "blocked" as const,
          summary: configError || "OMP Architect not initialized",
          issues: [],
        };
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      return state.review(
        phase,
        material,
        reviewerFactory(pi, ctx, state.config),
        combined,
        invocationId,
      );
    };
    const auto = createAutoController(
      pi,
      {
        state: () => state,
        instructions: () => instructions,
        acceptInternal: (text, ctx) => prepareStart(text, ctx),
        review: async (phase, body, ctx, signal, invocationId) => {
          const current = state;
          const requestGeneration = generation;
          if (!current) return review(phase, {} as ReviewMaterial, ctx, signal, invocationId);
          try {
            const material = await saveReviewMaterial(
              ctx,
              body,
              current.config.maxReviewBytes,
              "auto",
              signal,
            );
            if (state !== current || generation !== requestGeneration)
              return {
                decision: "blocked",
                summary: "Auto review input was superseded",
                issues: [],
              };
            return await review(phase, material, ctx, signal, invocationId);
          } catch (error) {
            if (state !== current || generation !== requestGeneration)
              return {
                decision: "blocked",
                summary: "Auto review input was superseded",
                issues: [],
              };
            return current.rejectReview(
              phase,
              invocationId ?? crypto.randomUUID(),
              error instanceof Error ? error.message : String(error),
              signal?.aborted ? "caller_cancelled" : "input_rejected",
            );
          }
        },
        invalidateStart: () => {
          acceptedPrompt = "";
        },
      },
      autoDependencies,
    );
    pi.on("session_start", async (_, ctx) => {
      if (ctx.agent.kind === "main") await initialize(ctx);
    });
    pi.on("session_switch", async (_, ctx) => {
      if (ctx.agent.kind === "main") await initialize(ctx);
    });
    pi.on("session_branch", async (_, ctx) => {
      if (ctx.agent.kind === "main") await initialize(ctx);
    });
    pi.on("session_shutdown", () => {
      auto.shutdown();
      lifetime.abort();
      clearQueuedCompletion();
      activeEvals.clear();
      autoCompletionCarriers.clear();
    });
    pi.on("input", (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.source === "extension") return;
      // These commands are consumed by our handlers. Status/usage errors must not
      // impersonate a new model request; start/stop invalidate ownership themselves.
      if (!event.images?.length && /^\/(?:auto|architect)(?:\s|$)/.test(event.text.trim())) {
        if (/^\/auto\s+stop\s*$/.test(event.text.trim())) acceptedPrompt = "";
        return;
      }
      acceptedPrompt = "";
      expectedContinuation = "";
      newUserRequest = true;
      clearQueuedCompletion();
      auto.userInput();
    });
    pi.on("turn_start", (_, ctx) => {
      if (ctx.agent.kind === "main") acceptedPrompt = "";
    });
    const prepareStart = (text: string, ctx: ExtensionContext) => {
      if (!acceptedPrompt || text !== acceptedPrompt) {
        const autoStart = auto.beforeStart(text, ctx);
        if (autoStart === "blocked") stopped = true;
        // A preparation/queued-delivery hook alone is not a new user request.
        // A confirmed Auto start has its own exact bootstrap ownership check.
        if (
          stopped &&
          autoStart !== "blocked" &&
          !newUserRequest &&
          !auto.request() &&
          !auto.handlesCompletion()
        ) {
          acceptedPrompt = "";
          expectedContinuation = "";
          ctx.abort();
          return;
        }
        newUserRequest = false;
        const expected = expectedContinuation;
        expectedContinuation = "";
        const unexpected = expected !== "" && text !== expected;
        if (unexpected)
          stopBlocked("Unexpected continuation context; a new user request is required", ctx);
        const preserving =
          autoStart !== "new" || (expected !== "" && text === expected) || unexpected;
        if (!preserving) {
          stopped = false;
          generation++;
          activeEvals.clear();
          autoCompletionCarriers.clear();
          clearQueuedCompletion();
          state?.begin(auto.request() ?? text);
        }
        if (!unexpected && autoStart !== "blocked") acceptedPrompt = text;
        else acceptedPrompt = "";
      }
    };
    pi.on("context", (event, ctx) => {
      if (ctx.agent.kind !== "main") return;
      return { messages: auto.context(event, ctx) };
    });
    pi.on("before_agent_start", async (event, ctx) => {
      if (ctx.agent.kind !== "main") return;
      if (!state && !configError) await initialize(ctx);
      prepareStart(event.prompt, ctx);
      return {
        systemPrompt: [
          ...event.systemPrompt,
          instructions,
          ...(auto.instructions() ? [auto.instructions()] : []),
          ...(configError ? [configError] : []),
        ],
      };
    });
    pi.on("before_subagent_spawn", (event, ctx) => {
      if (ctx.agent.kind !== "main" || !state) return;
      const autoGate = auto.spawnGate(event.agent, event.invocationKind);
      if (autoGate) return { block: true, reason: autoGate };
      const role = routeAgent(event.agent, state.config);
      if (!role) return;
      if (!ctx.models.resolve(role))
        return {
          block: true,
          reason: `Configure authenticated modelRoles.${role.slice(1)} before spawning ${event.agent}`,
        };
      return { model: role, note: `OMP Architect: ${event.agent} uses ${role}` };
    });
    pi.on("tool_call", (event, ctx) => {
      if (ctx.agent.kind !== "main") return;
      if (configError) return { block: true, reason: configError };
      const toolName = effectiveToolName(event.toolName, event.input);
      // Diagnostics must remain available even after Auto or Architect stops.
      if (toolName === "auto_status" && (stopped || !auto.isRunning())) return;
      const deny = (reason: string) => {
        state?.deny(event.toolCallId, toolName, { ...event.input }, reason);
        return { block: true as const, reason };
      };
      if (
        stopped &&
        auto.handlesCompletion() &&
        ["wait", "read", "grep", "glob", "find", "ls"].includes(toolName)
      )
        return;
      if (stopped)
        return deny(
          "OMP Architect stopped this request; start a new user request after resolving the blocker",
        );
      const autoReason = auto.toolCall(event.toolCallId, toolName, { ...event.input }, ctx);
      if (autoReason) return deny(autoReason);
      const input: Record<string, unknown> = { ...event.input };
      if (toolName === "architect_checkpoint") {
        let checkpointInput: unknown = input;
        if (event.toolName === "write" && typeof input.content === "string") {
          try {
            checkpointInput = JSON.parse(input.content);
          } catch {
            checkpointInput = undefined;
          }
        }
        if (
          checkpointInput &&
          typeof checkpointInput === "object" &&
          !Array.isArray(checkpointInput) &&
          Object.keys(checkpointInput).some(
            (key) => !["phase", "evidenceRef", "steps"].includes(key),
          )
        ) {
          const reason =
            "Checkpoint accepts only phase, evidenceRef and optional canonical steps; inline summary/body is unsupported";
          const phase = (checkpointInput as { phase?: string }).phase;
          state?.rejectReview(
            phase === "plan" || phase === "recovery" ? phase : "completion",
            `${ctx.sessionManager.getSessionId()}:${generation}:${event.toolCallId}`.slice(0, 200),
            reason,
          );
          return deny(reason);
        }
      }
      const reviewOnly =
        state &&
        ((toolName === "write" && reviewWrite(input, state.config.maxReviewBytes)) ||
          (toolName === "eval" && reviewCarrier(input, state.config.maxReviewBytes)));
      const reason = state?.gate(reviewOnly ? "architect_checkpoint" : toolName, input);
      if (reason) return deny(reason);
      if (toolName === "eval") activeEvals.set(event.toolCallId, input);
    });
    const nativeSettlement = (details: unknown, ctx: ExtensionContext) => {
      const id = (details as { async?: { jobId?: string } } | undefined)?.async?.jobId;
      return id
        ? nativeAsyncHost(pi, ctx)?.session.asyncJobManager?.getJob(id)?.promise
        : undefined;
    };
    pi.on("tool_result", (event, ctx) => {
      if (ctx.agent.kind !== "main" || !state) return;
      const toolName = effectiveToolName(event.toolName, event.input);
      if (toolName === "eval") {
        const pending = nativeSettlement(event.details, ctx);
        if (pending) {
          const input = activeEvals.get(event.toolCallId);
          void pending.then(() => {
            if (activeEvals.get(event.toolCallId) === input) activeEvals.delete(event.toolCallId);
            autoCompletionCarriers.delete(event.toolCallId);
          });
        } else activeEvals.delete(event.toolCallId);
        if (autoCompletionCarriers.has(event.toolCallId)) {
          if (!pending) autoCompletionCarriers.delete(event.toolCallId);
          return;
        }
      }
      if (toolName === "eval" && auto.isRunning() && !event.isError && autoStepCarrier(event.input))
        return;
      if (
        toolName === "auto_status" ||
        toolName === "architect_checkpoint" ||
        (toolName === "auto_step" && !event.isError)
      )
        return;
      const text = event.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      // Native task envelopes may omit isError even when a child failed. Keep
      // the ordinary repeated-failure recovery gate effective for Auto leaves.
      const results =
        event.details && typeof event.details === "object" && "results" in event.details
          ? event.details.results
          : undefined;
      const failedLeaf =
        auto.isRunning() &&
        toolName === "task" &&
        Array.isArray(results) &&
        results.some(
          (result) =>
            result &&
            typeof result === "object" &&
            ((typeof result.exitCode === "number" && result.exitCode !== 0) ||
              (typeof result.error === "string" && result.error.length > 0)),
        );
      const repeated = state.observe(
        event.toolCallId,
        toolName,
        event.input,
        text,
        event.isError || failedLeaf,
        captureMetadata(event.details),
      );
      if (repeated)
        return {
          additionalContext:
            "OMP Architect detected repeated tool failure. Call architect_checkpoint phase=recovery with the failure and a different approach before further execution. A review never grants permission.",
        };
    });
    pi.on("agent_end", (event, ctx) => {
      if (ctx.agent.kind === "main" && !event.willContinue) clearQueuedCompletion();
    });
    pi.on("tool_execution_end", (event, ctx) => {
      if (ctx.agent.kind !== "main" || event.toolName !== "eval") return;
      const input = activeEvals.get(event.toolCallId);
      if (nativeSettlement((event.result as { details?: unknown })?.details, ctx)) return; // Initial native background receipt, not settlement.
      if (!input) return; // The normal tool_result already recorded this execution.
      activeEvals.delete(event.toolCallId);
      state?.observe(
        event.toolCallId,
        "eval",
        input,
        "Eval execution ended without an observed tool_result; its output and effects are unverified",
        true,
      );
      clearQueuedCompletion();
    });
    const { Type } = pi.typebox;
    pi.registerTool({
      name: "architect_checkpoint",
      label: "Architect checkpoint",
      description:
        "Independent bounded review using a complete native OMP file. Write the body to local://architect-review/NAME.md, then pass evidenceRef only (or an artifact://ID from this session). Default maxReviewBytes is 131072 UTF-8 bytes; oversized files are rejected, never truncated. Inline summary is unsupported. Plan requires canonical steps. Completion inside Eval is queued until its outer execution finishes. Use phase=blocked with a file describing the blocker to stop without review.",
      approval: "read",
      parameters: Type.Object(
        {
          phase: Type.Union([
            Type.Literal("plan"),
            Type.Literal("recovery"),
            Type.Literal("completion"),
            Type.Literal("blocked"),
          ]),
          evidenceRef: Type.String({
            minLength: 1,
            maxLength: 160,
            description:
              "Complete native file reference: artifact://ID from the originating session or local://architect-review/NAME.md (NAME: 1–80 letters, digits, underscores or hyphens). Default 131072-byte full-body limit; no inline body or summary.",
          }),
          steps: Type.Optional(
            Type.Array(
              Type.String({
                minLength: 1,
                maxLength: 1000,
                description: "Exact canonical step, 1–1000 characters",
              }),
              { minItems: 1, maxItems: 30, description: "1–30 exact canonical steps" },
            ),
          ),
        },
        { additionalProperties: false },
      ),
      async execute(id, params, signal, _update, ctx) {
        if (ctx.agent.kind !== "main")
          return {
            content: [
              {
                type: "text",
                text: "Architect checkpoints belong to the main session; workers cannot invoke them.",
              },
            ],
            isError: true,
          };
        if (Object.keys(params).some((key) => !["phase", "evidenceRef", "steps"].includes(key))) {
          const invocationId = `${ctx.sessionManager.getSessionId()}:${generation}:${id}`.slice(
            0,
            200,
          );
          const verdict = state?.rejectReview(
            params.phase === "blocked" ? "completion" : params.phase,
            invocationId,
            "Checkpoint accepts only phase, evidenceRef and optional canonical steps; inline summary/body is unsupported",
          );
          const result = { ...verdict, status: "input_rejected", charged: false, invocationId };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: true,
          };
        }
        const admissionState = state;
        const admissionGeneration = generation;
        const invocationId = `${ctx.sessionManager.getSessionId()}:${generation}:${id}`.slice(
          0,
          200,
        );
        let material: ReviewMaterial;
        try {
          material = await loadReviewMaterial(
            ctx,
            params.evidenceRef,
            state?.config.maxReviewBytes ?? 131072,
            signal,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const verdict =
            state === admissionState && generation === admissionGeneration
              ? state?.rejectReview(
                  params.phase === "blocked" ? "completion" : params.phase,
                  invocationId,
                  message,
                  signal?.aborted ? "caller_cancelled" : "input_rejected",
                )
              : undefined;
          const result = {
            ...(verdict ?? { decision: "blocked", summary: message, issues: [] }),
            invocationId,
            status: signal?.aborted ? "caller_cancelled" : "input_rejected",
            charged: false,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: true,
          };
        }
        if (
          state !== admissionState ||
          generation !== admissionGeneration ||
          newUserRequest ||
          signal?.aborted
        ) {
          const result = {
            decision: "blocked",
            status: "caller_cancelled",
            charged: false,
            invocationId,
            summary: "Checkpoint input belongs to a cancelled or superseded request",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: true,
          };
        }
        if (params.phase === "blocked") {
          const reason =
            material.content.length > 4000
              ? `${material.content.slice(0, 3900)} [continued in ${material.ref}]`
              : material.content;
          stopBlocked(reason, ctx);
          const result = {
            decision: "blocked",
            summary: reason,
            issues: [],
            invocationId,
            status: "operator_blocked",
            charged: false,
            artifactRef: material.ref,
            sha256: material.sha256,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: true,
          };
        }
        if (
          params.phase === "completion" &&
          !auto.handlesCompletion() &&
          (ctx.getAsyncJobSnapshot?.()?.running.length ?? 0) > 0
        ) {
          const verdict = state?.rejectReview(
            "completion",
            invocationId,
            "Background jobs remain active; await their completion and submit fresh review evidence",
          );
          const result = { ...verdict, invocationId, status: "input_rejected", charged: false };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: true,
          };
        }
        if (params.phase === "completion" && auto.handlesCompletion()) {
          if (
            activeEvals.size &&
            (activeEvals.size !== 1 ||
              ![...activeEvals.values()].every((input) =>
                completionCarrier(input, state?.config.maxReviewBytes ?? 131072),
              ))
          ) {
            const verdict = state?.rejectReview(
              "completion",
              invocationId,
              "Auto completion inside Eval requires one dedicated JavaScript reset=true single-call native checkpoint carrier; await all other effects first",
            );
            const result = { ...verdict, invocationId, status: "input_rejected", charged: false };
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: result,
              isError: true,
            };
          }
          for (const evalId of activeEvals.keys()) autoCompletionCarriers.add(evalId);
          const current = state;
          const requestGeneration = generation;
          const verdict = await auto.complete(
            material,
            ctx,
            signal,
            invocationId,
            new Set([id, ...autoCompletionCarriers]),
          );
          if (
            state &&
            state === current &&
            generation === requestGeneration &&
            state.terminalReason
          )
            stopBlocked(state.terminalReason, ctx);
          const result = {
            ...verdict,
            invocationId,
            review: state?.lastReview?.invocationId === invocationId ? state.lastReview : null,
            next:
              verdict.decision === "approve"
                ? "Return a factual final summary; Auto will settle only if fresh Rasen facts still match this approval"
                : "Address the finding or required independent round and resubmit native completion evidence within this LEAD turn",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: verdict.decision !== "approve",
          };
        }
        if (params.phase === "completion" && activeEvals.size) {
          if (queuedCompletion) {
            const result = {
              decision: "blocked",
              status: "input_rejected",
              charged: false,
              invocationId,
              summary: "A completion checkpoint is already queued for this boundary",
            };
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
              details: result,
              isError: true,
            };
          }
          const queueSignal = signal ?? lifetime.signal;
          const onAbort = () => {
            if (queuedCompletion?.invocationId === invocationId) clearQueuedCompletion();
          };
          queuedCompletion = {
            material,
            invocationId,
            generation,
            signal: queueSignal,
            detach: () => queueSignal.removeEventListener("abort", onAbort),
          };
          queueSignal.addEventListener("abort", onAbort, { once: true });
          const result = {
            status: "queued",
            charged: false,
            invocationId,
            artifactRef: material.ref,
            sha256: material.sha256,
            summary:
              "Completion is unverified. Review will run once at the turn boundary after all Eval results are observed. Return factual progress; do not claim approval.",
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            details: result,
            isError: false,
          };
        }
        if (params.phase === "plan" && params.steps !== undefined && !params.steps.length) {
          // Do not erase an existing gate when rejecting an empty replacement plan.
          state?.revokeApproval("plan");
          const verdict = {
            decision: "blocked" as const,
            summary: "Plan checkpoint requires non-empty steps. No review round was charged.",
            issues: ["An empty replacement plan cannot clear the pending checkpoint"],
          };
          return {
            content: [{ type: "text", text: JSON.stringify(verdict) }],
            details: verdict,
            isError: true,
          };
        }
        if (params.phase === "plan" && params.steps !== undefined && state)
          state.setPendingPlan(params.steps);
        const current = state;
        const requestGeneration = generation;
        const verdict = await review(params.phase, material, ctx, signal, invocationId);
        if (state && state === current && generation === requestGeneration && state.terminalReason)
          stopBlocked(state.terminalReason, ctx);
        const reviewOutcome =
          state?.lastReview?.invocationId === invocationId ? state.lastReview : null;
        const result =
          params.phase === "plan" && state === current
            ? {
                ...verdict,
                invocationId,
                review: reviewOutcome,
                plan: state?.planStatus(),
                next:
                  verdict.decision === "approve"
                    ? "Copy the canonical approved steps exactly into todo; await successful registration before execution. Do not batch todo registration with execution."
                    : "Review the pending canonical steps with phase=plan and address the findings, or stop with phase=blocked. Approval requires exact steps, including punctuation, whitespace and order.",
              }
            : { ...verdict, invocationId, review: reviewOutcome };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
          isError: verdict.decision !== "approve",
        };
      },
    });
    pi.on("session_stop", async (event, ctx) => {
      if (ctx.agent.kind !== "main") return;
      if (stopped || state?.reviewInProgress) return;
      if (state?.terminalReason) {
        stopBlocked(state.terminalReason, ctx);
        return;
      }
      const queued = queuedCompletion;
      clearQueuedCompletion();
      if (
        queued &&
        !event.signal.aborted &&
        !queued.signal.aborted &&
        queued.generation === generation &&
        !activeEvals.size &&
        !auto.handlesCompletion() &&
        !(ctx.getAsyncJobSnapshot?.()?.running.length ?? 0)
      ) {
        const current = state;
        const timeout = new AbortController();
        const timer = setTimeout(
          () =>
            timeout.abort(
              new DOMException("Deferred completion boundary timed out", "TimeoutError"),
            ),
          24000,
        );
        let verdict;
        try {
          verdict = await review(
            "completion",
            queued.material,
            ctx,
            AbortSignal.any([event.signal, queued.signal, timeout.signal]),
            queued.invocationId,
          );
        } finally {
          clearTimeout(timer);
        }
        if (state !== current || queued.generation !== generation) return;
        if (state?.terminalReason) {
          stopBlocked(state.terminalReason, ctx);
          return;
        }
        pi.sendMessage(
          {
            customType: "omp-architect",
            content: JSON.stringify({
              ...verdict,
              invocationId: queued.invocationId,
              review:
                state?.lastReview?.invocationId === queued.invocationId ? state.lastReview : null,
            }),
            display: true,
          },
          { triggerTurn: false, deliverAs: "nextTurn" },
        );
      }
      const autoResult = await auto.onStop(event, ctx);
      if (autoResult.handled) return autoResult.result;
      if (event.signal.aborted || state?.completionApproved) return;
      // This is only a backstop: already-streamed assistant text cannot be retracted.
      if (
        !state ||
        state.stopContinuations >= state.config.reviews.max ||
        state.phaseReviews.completion >= state.config.reviews.max
      ) {
        const reason =
          configError ||
          state?.blocked ||
          "Architect review limit reached; completion remains unverified";
        stopBlocked(reason, ctx);
        return;
      }
      state.stopContinuations++;
      if (state.pendingRecovery)
        return continueWith(
          "OMP Architect: unresolved repeated failure. Run architect_checkpoint phase=recovery, or call architect_checkpoint phase=blocked with the honest blocker to stop. Do not claim completion.",
        );
      const pendingPlan = state.gate("write", {});
      if (pendingPlan)
        return continueWith(
          `OMP Architect: ${pendingPlan} Resolve the pending checkpoint before completion. Do not claim completion.`,
        );
      return continueWith(
        "OMP Architect: completion remains unverified. Run architect_checkpoint phase=completion with factual evidence, address any findings, or report the blocker honestly. Do not claim completion before approval. To stop with an honest blocker, call architect_checkpoint phase=blocked.",
      );
    });
    pi.registerCommand("architect", {
      description: "Show role routing, review budget, and checkpoint status",
      handler: async (_args, ctx) => {
        if (ctx.agent.kind !== "main") return;
        const status = state
          ? {
              roles: state.config.roles,
              reviews: `${state.reviewCount}/${3 * state.config.reviews.max}`,
              lastReview: state.lastReview,
              completionApproved: state.completionApproved,
              pendingRecovery: state.pendingRecovery,
              plan: state.planStatus(),
              stopped,
              blocked: state.blocked || null,
              mainModel: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
            }
          : { blocked: configError || "Not initialized" };
        if (auto.isRunning() || !ctx.isIdle()) {
          ctx.ui.notify(JSON.stringify(status, null, 2), "info");
          return;
        }
        pi.sendMessage(
          { customType: "omp-architect", content: JSON.stringify(status, null, 2), display: true },
          { triggerTurn: false },
        );
      },
    });
  };
}
export default extensionFactory();

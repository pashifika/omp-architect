import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, type Config } from "./config.ts";
import { Orchestrator, routeAgent, type Reviewer, type Phase } from "./core.ts";
import { createReviewer } from "./reviewer.ts";
import { createAutoController, type AutoDependencies } from "./auto/extension.ts";
import instructions from "./prompts/orchestration.md" with { type: "text" };

// Only the documented canonical devices share their native tool identity.
function effectiveToolName(toolName: string, input: object): string {
  if (toolName === "write" && "path" in input) {
    if (input.path === "xd://architect_checkpoint") return "architect_checkpoint";
    if (input.path === "xd://auto_status") return "auto_status";
  }
  return toolName;
}

type ReviewerFactory = (pi: ExtensionAPI, ctx: ExtensionContext, config: Config) => Reviewer;
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
    const continueWith = (text: string) => {
      acceptedPrompt = "";
      expectedContinuation = `${text}\n\nArchitect continuation: ${crypto.randomUUID()}`;
      return { continue: true, additionalContext: expectedContinuation };
    };
    const stopBlocked = (reason: string, ctx: ExtensionContext) => {
      if (stopped) return;
      stopped = true;
      acceptedPrompt = "";
      expectedContinuation = "";
      auto.architectBlocked(reason, ctx);
      pi.sendMessage(
        {
          customType: "omp-architect",
          content: `Blocked: ${reason}. Completion remains unverified. Start a new request after resolving the blocker.`,
          display: true,
        },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
      ctx.ui.notify(`OMP Architect blocked: ${reason}. Completion remains unverified.`, "warning");
      ctx.abort();
    };
    const initialize = async (ctx: ExtensionContext) => {
      generation++;
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
      summary: string,
      ctx: ExtensionContext,
      signal?: AbortSignal,
    ) => {
      if (!state)
        return {
          decision: "blocked" as const,
          summary: configError || "OMP Architect not initialized",
          issues: [],
        };
      const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      return state.review(phase, summary, reviewerFactory(pi, ctx, state.config), combined);
    };
    const auto = createAutoController(
      pi,
      {
        state: () => state,
        review,
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
      auto.userInput();
    });
    pi.on("turn_start", (_, ctx) => {
      if (ctx.agent.kind === "main") acceptedPrompt = "";
    });
    pi.on("before_agent_start", async (event, ctx) => {
      if (ctx.agent.kind !== "main") return;
      if (!state && !configError) await initialize(ctx);
      if (!acceptedPrompt || event.prompt !== acceptedPrompt) {
        const autoStart = auto.beforeStart(event.prompt, ctx);
        const expected = expectedContinuation;
        expectedContinuation = "";
        const unexpected = expected !== "" && event.prompt !== expected;
        if (unexpected)
          stopBlocked("Unexpected continuation context; a new user request is required", ctx);
        const preserving =
          autoStart !== "new" || (expected !== "" && event.prompt === expected) || unexpected;
        if (!preserving) {
          stopped = false;
          generation++;
          state?.begin(event.prompt);
        }
        if (!unexpected && autoStart !== "blocked") acceptedPrompt = event.prompt;
        else acceptedPrompt = "";
      }
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
      const autoGate = auto.spawnGate();
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
      if (stopped && toolName !== "auto_status")
        return {
          block: true,
          reason:
            "OMP Architect stopped this request; start a new user request after resolving the blocker",
        };
      const autoReason = auto.toolCall(event.toolCallId, toolName, { ...event.input }, ctx);
      if (autoReason) return { block: true, reason: autoReason };
      const reason = state?.gate(toolName, { ...event.input });
      if (reason) return { block: true, reason };
    });
    pi.on("tool_result", (event, ctx) => {
      if (ctx.agent.kind !== "main" || !state) return;
      const toolName = effectiveToolName(event.toolName, event.input);
      if (toolName === "auto_status" || toolName === "architect_checkpoint") return;
      const text = event.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const repeated = state.observe(event.toolCallId, toolName, event.input, text, event.isError);
      if (repeated)
        return {
          additionalContext:
            "OMP Architect detected repeated tool failure. Call architect_checkpoint phase=recovery with the failure and a different approach before further execution. A review never grants permission.",
        };
    });
    const { Type } = pi.typebox;
    pi.registerTool({
      name: "architect_checkpoint",
      label: "Architect checkpoint",
      description:
        "Independent architect review before a substantial plan, after repeated failure, or before claiming completion. Uses configured architect model; no tools, mutations, or recursive agents. Pass factual evidence, not unsupported success claims.",
      approval: "read",
      parameters: Type.Object({
        phase: Type.Union([
          Type.Literal("plan"),
          Type.Literal("recovery"),
          Type.Literal("completion"),
        ]),
        summary: Type.String({ minLength: 1, maxLength: 8000 }),
        steps: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 30 }),
        ),
      }),
      async execute(_id, params, signal, _update, ctx) {
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
        if (params.phase === "completion" && auto.handlesCompletion())
          return {
            content: [
              {
                type: "text",
                text: "OMP Auto will collect fresh Rasen CLI validation and perform this completion checkpoint at the turn boundary. No review round was charged. Return a factual progress summary; do not claim completion yet.",
              },
            ],
            isError: false,
          };
        if (params.phase === "plan" && params.steps?.length && state)
          state.setPendingPlan(params.steps);
        const current = state;
        const requestGeneration = generation;
        const verdict = await review(params.phase, params.summary, ctx, signal);
        if (
          state &&
          state === current &&
          generation === requestGeneration &&
          !signal?.aborted &&
          verdict.decision !== "approve" &&
          state.phaseReviews[params.phase] >= state.config.reviews.max
        )
          stopBlocked(verdict.summary, ctx);
        return {
          content: [{ type: "text", text: JSON.stringify(verdict) }],
          details: verdict,
          isError: verdict.decision !== "approve",
        };
      },
    });
    pi.on("session_stop", async (event, ctx) => {
      if (ctx.agent.kind !== "main") return;
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
          "OMP Architect: unresolved repeated failure. Run architect_checkpoint phase=recovery, or report the blocker honestly. Do not claim completion.",
        );
      const pendingPlan = state.gate("write", {});
      if (pendingPlan)
        return continueWith(
          `OMP Architect: ${pendingPlan} Resolve the pending checkpoint before completion. Do not claim completion.`,
        );
      return continueWith(
        "OMP Architect: completion remains unverified. Run architect_checkpoint phase=completion with factual evidence, address any findings, or report the blocker honestly. Do not claim completion before approval.",
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
              completionApproved: state.completionApproved,
              pendingRecovery: state.pendingRecovery,
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

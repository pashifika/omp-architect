import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, type Config } from "./config.ts";
import { Orchestrator, routeAgent, type Reviewer, type Phase } from "./core.ts";
import { createReviewer } from "./reviewer.ts";
import instructions from "./prompts/orchestration.md" with { type: "text" };

type ReviewerFactory = (pi: ExtensionAPI, ctx: ExtensionContext, config: Config) => Reviewer;
export function extensionFactory(reviewerFactory: ReviewerFactory = createReviewer) {
  return (pi: ExtensionAPI): void => {
    let state: Orchestrator | undefined;
    let configError = "";
    let lifetime = new AbortController();
    let stopped = false;
    let generation = 0;
    const stopBlocked = (reason: string, ctx: ExtensionContext) => {
      if (stopped) return;
      stopped = true;
      pi.sendMessage(
        {
          customType: "omp-architect",
          content: `Blocked: ${reason}. Completion remains unverified. Start a new request after resolving the blocker.`,
          display: true,
        },
        { triggerTurn: false },
      );
      ctx.abort();
    };
    const initialize = async (ctx: ExtensionContext) => {
      generation++;
      lifetime.abort();
      lifetime = new AbortController();
      state = undefined;
      configError = "";
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
      lifetime.abort();
    });
    pi.on("before_agent_start", async (event, ctx) => {
      if (ctx.agent.kind !== "main") return;
      if (!state && !configError) await initialize(ctx);
      stopped = false;
      generation++;
      state?.begin(event.prompt);
      return {
        systemPrompt: [...event.systemPrompt, instructions, ...(configError ? [configError] : [])],
      };
    });
    pi.on("before_subagent_spawn", (event, ctx) => {
      if (ctx.agent.kind !== "main" || !state) return;
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
      const reason = state?.gate(event.toolName, { ...event.input });
      if (reason) return { block: true, reason };
    });
    pi.on("tool_result", (event, ctx) => {
      if (ctx.agent.kind !== "main" || !state) return;
      const text = event.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      const repeated = state.observe(
        event.toolCallId,
        event.toolName,
        event.input,
        text,
        event.isError,
      );
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
      if (ctx.agent.kind !== "main" || event.signal.aborted || state?.completionApproved) return;
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
        return {
          continue: true,
          additionalContext:
            "OMP Architect: unresolved repeated failure. Run architect_checkpoint phase=recovery, or report the blocker honestly. Do not claim completion.",
        };
      const message = event.last_assistant_message;
      const summary =
        message && "content" in message && Array.isArray(message.content)
          ? message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n")
          : "No completion summary was supplied.";
      const current = state;
      const requestGeneration = generation;
      const verdict = await review("completion", summary, ctx, event.signal);
      if (event.signal.aborted || state !== current || generation !== requestGeneration) return;
      if (
        verdict.decision !== "approve" &&
        state.phaseReviews.completion >= state.config.reviews.max
      ) {
        stopBlocked(verdict.summary, ctx);
        return;
      }
      if (verdict.decision !== "approve")
        return {
          continue: true,
          additionalContext: `OMP Architect completion review: ${JSON.stringify(verdict)}. Address the findings and run architect_checkpoint, or clearly report that work is blocked.`,
        };
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
        pi.sendMessage(
          { customType: "omp-architect", content: JSON.stringify(status, null, 2), display: true },
          { triggerTurn: false },
        );
      },
    });
  };
}
export default extensionFactory();

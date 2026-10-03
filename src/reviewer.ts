import {
  AgentRegistry,
  createAgentSession,
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type CreateAgentSessionOptions,
} from "@oh-my-pi/pi-coding-agent";
import type { Config } from "./config.ts";
import { parseVerdict, type Reviewer } from "./core.ts";
import architectPrompt from "./prompts/architect.md" with { type: "text" };

export function reviewOptions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  config: Config,
): CreateAgentSessionOptions {
  return {
    cwd: ctx.cwd,
    modelPattern: `@${config.roles.architect}`,
    modelRegistry: ctx.modelRegistry,
    authStorage: ctx.modelRegistry.authStorage,
    settings: pi.pi.settings.overlay({
      "advisor.enabled": false,
      "memories.enabled": false,
      "memory.backend": "off",
      "recap.enabled": false,
      "retry.enabled": false,
    }),
    systemPrompt: architectPrompt,
    toolNames: [],
    restrictToolNames: true,
    requireYieldTool: false,
    disableExtensionDiscovery: true,
    extensions: [],
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    bindProcessState: false,
    cacheWarming: false,
    skipPythonPreflight: true,
    parentTaskPrefix: "omp-architect-review",
    taskDepth: 1,
    agentId: `omp-architect-${crypto.randomUUID()}`,
    agentName: "omp-architect-review",
    agentRegistry: new AgentRegistry(),
    sessionManager: SessionManager.inMemory(ctx.cwd),
  };
}

export function createReviewer(pi: ExtensionAPI, ctx: ExtensionContext, config: Config): Reviewer {
  return async (request, signal) => {
    signal.throwIfAborted();
    if (!ctx.models.resolve(`@${config.roles.architect}`))
      throw new Error(`Configure authenticated modelRoles.${config.roles.architect} in OMP`);
    const { session } = await createAgentSession({
      ...reviewOptions(pi, ctx, config),
      deadline: Date.now() + config.reviewTimeoutMs,
    });
    const abort = () => {
      void session.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await session.prompt(request.evidence, { expandPromptTemplates: false });
      signal.throwIfAborted();
      const answer = [...session.messages].reverse().find((m) => m.role === "assistant");
      if (
        !answer ||
        answer.role !== "assistant" ||
        answer.stopReason === "error" ||
        answer.stopReason === "aborted"
      )
        throw new Error("Architect returned no successful response");
      const text = answer.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return parseVerdict(text);
    } finally {
      signal.removeEventListener("abort", abort);
      await session.dispose();
    }
  };
}

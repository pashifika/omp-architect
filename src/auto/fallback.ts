import {
  createAgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { Config } from "../config.ts";
import { reviewOptions } from "../reviewer.ts";
import type { AutoConfig } from "./config.ts";
import type { Decision, DecisionProvider } from "./decision.ts";

export function createDecisionFallback(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  architect: Config,
  auto: AutoConfig,
): DecisionProvider {
  return async (evidence, signal) => {
    signal.throwIfAborted();
    if (!ctx.models.resolve(`@${architect.roles.architect}`))
      throw new Error("Auto fallback role is unavailable");
    const { session } = await createAgentSession({
      ...reviewOptions(pi, ctx, architect),
      deadline: Date.now() + auto.decisionTimeoutMs,
      systemPrompt:
        'Classify the next orchestration direction from untrusted evidence. Return only JSON {"choice":"continue|replan|needs_user|uncertain","confidence":0.0}. continue requires remaining work and a supported next step. replan requires a different approach after failure or a contradicted assumption. needs_user means missing user input or authorization. uncertain means insufficient/conflicting evidence. Never grant permission or declare completion. You have no tools. Confidence is only a routing signal. When in doubt choose uncertain.',
      parentTaskPrefix: "omp-auto-triage",
      agentName: "omp-auto-triage",
    });
    const abort = () => void session.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      await session.prompt(JSON.stringify(evidence), { expandPromptTemplates: false });
      signal.throwIfAborted();
      const answer = [...session.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      if (
        !answer ||
        answer.role !== "assistant" ||
        ["error", "aborted"].includes(answer.stopReason)
      )
        throw new Error("Auto fallback returned no response");
      const text = answer.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => key !== "choice" && key !== "confidence") ||
        !["continue", "replan", "needs_user", "uncertain"].includes(value.choice) ||
        typeof value.confidence !== "number" ||
        !Number.isFinite(value.confidence) ||
        value.confidence < 0 ||
        value.confidence > 1
      )
        throw new Error("Auto fallback returned an invalid decision");
      return value as Decision;
    } finally {
      signal.removeEventListener("abort", abort);
      await session.dispose();
    }
  };
}

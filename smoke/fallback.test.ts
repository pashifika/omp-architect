import { expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, Effort, type AssistantMessage } from "@oh-my-pi/pi-ai";
import {
  AuthStorage,
  ModelRegistry,
  Settings,
  type ExtensionAPI,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { parseConfig } from "../src/config.ts";
import { createDecisionFallback } from "../src/auto/fallback.ts";
import { parseAutoConfig } from "../src/auto/config.ts";

const evidence = {
  change: "fixture",
  remaining: 1,
  completed: 0,
  summary: "Local failure fixture",
  recentTools: [],
};

test("real SDK semantic fallback uses the native architect role with zero tools", async () => {
  const fixture = await fallbackFixture();
  try {
    const fallback = createDecisionFallback(
      fixture.pi,
      fixture.ctx,
      parseConfig({}),
      parseAutoConfig({}),
    );
    const verdict = await fallback(evidence, new AbortController().signal);
    expect(verdict.choice).toBe("replan");
    expect(verdict.confidence).toBe(0.9);
    expect(fixture.observed.requests).toBe(1);
    expect(fixture.observed.toolCount).toBe(0);
    expect(fixture.observed.reasoning).toBe("high");
    for (const invalid of [
      "private malformed response",
      '{"choice":"continue","confidence":0.99,"secret":"withheld"}',
    ]) {
      fixture.setResponse(invalid);
      await expect(fallback(evidence, new AbortController().signal)).rejects.toMatchObject({
        code: "FALLBACK_INVALID_RESPONSE",
      });
    }
    const unavailable = {
      ...fixture.ctx,
      models: { resolve: () => undefined },
    } as unknown as ExtensionContext;
    await expect(
      createDecisionFallback(
        fixture.pi,
        unavailable,
        parseConfig({}),
        parseAutoConfig({}),
      )(evidence, new AbortController().signal),
    ).rejects.toMatchObject({ code: "FALLBACK_ROLE_UNAVAILABLE" });
    expect(fixture.observed.requests).toBe(3);
  } finally {
    await fixture.close();
  }
});

test("real SDK fallback can finish after the Jev timeout within the Architect deadline", async () => {
  const fixture = await fallbackFixture(250);
  const controller = new AbortController();
  const auto = parseAutoConfig({ decisionTimeoutMs: 100 });
  const architect = parseConfig({ reviewTimeoutMs: 2000 });
  try {
    const startedAt = performance.now();
    const verdict = await createDecisionFallback(
      fixture.pi,
      fixture.ctx,
      architect,
      auto,
    )(evidence, controller.signal);
    expect(performance.now() - startedAt).toBeGreaterThan(auto.decisionTimeoutMs);
    expect(verdict).toEqual({ choice: "replan", confidence: 0.9 });
    expect(fixture.observed.requests).toBe(1);
    expect(fixture.observed.completed).toBe(1);
    expect(fixture.observed.aborted).toBe(0);
    expect(fixture.observed.activeStreams).toBe(0);
    expect(fixture.pendingTimers()).toBe(0);
    expect(fixture.observed.toolCount).toBe(0);
    expect(fixture.observed.reasoning).toBe("high");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  } finally {
    controller.abort();
    await fixture.close();
  }
});

test("real SDK fallback cancellation aborts the request and cleans up without retries", async () => {
  const fixture = await fallbackFixture(250);
  const controller = new AbortController();
  try {
    const pending = createDecisionFallback(
      fixture.pi,
      fixture.ctx,
      parseConfig({ reviewTimeoutMs: 2000 }),
      parseAutoConfig({ decisionTimeoutMs: 100 }),
    )(evidence, controller.signal);
    const rejection = pending.catch((error: unknown) => error);
    await fixture.requestStarted;
    controller.abort();
    expect(await rejection).toMatchObject({ name: "AbortError" });
    expect(fixture.observed.providerSignal?.aborted).toBe(true);
    expect(fixture.observed.aborted).toBe(1);
    expect(fixture.observed.activeStreams).toBe(0);
    expect(fixture.pendingTimers()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    // Wait beyond the fixture's original response time to expose a late response or retry.
    await Bun.sleep(300);
    expect(fixture.observed.completed).toBe(0);
    expect(fixture.observed.requests).toBe(1);
  } finally {
    controller.abort();
    await fixture.close();
  }
});

async function fallbackFixture(responseDelayMs = 0) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-sdk-"));
  const auth = await AuthStorage.create(":memory:");
  const settings = Settings.isolated({ "memory.backend": "off" });
  const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
  const provider = `architect-fixture-${crypto.randomUUID()}`;
  const api = `architect-api-${crypto.randomUUID()}`;
  const started = Promise.withResolvers<void>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const active = new Set<() => void>();
  const observed = {
    requests: 0,
    completed: 0,
    aborted: 0,
    activeStreams: 0,
    toolCount: -1,
    reasoning: undefined as unknown,
    providerSignal: undefined as AbortSignal | undefined,
  };
  let responseText = '{"choice":"replan","confidence":0.9}';
  registry.registerProvider(
    provider,
    {
      baseUrl: "https://unused.invalid",
      apiKey: "fixture-not-a-secret",
      api,
      streamSimple(model, context, options) {
        observed.requests++;
        observed.activeStreams++;
        observed.toolCount = context.tools?.length ?? 0;
        observed.reasoning = options?.reasoning;
        observed.providerSignal = options?.signal;
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          api,
          provider,
          model: model.id,
          content: [{ type: "text", text: responseText }],
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const abort = () => finish(true);
        function finish(aborted: boolean) {
          if (settled) return;
          settled = true;
          if (timer !== undefined) {
            clearTimeout(timer);
            timers.delete(timer);
          }
          options?.signal?.removeEventListener("abort", abort);
          active.delete(abort);
          observed.activeStreams--;
          if (aborted) {
            observed.aborted++;
            stream.push({
              type: "error",
              reason: "aborted",
              error: { ...message, content: [], stopReason: "aborted" },
            });
          } else {
            observed.completed++;
            stream.push({ type: "done", reason: "stop", message });
          }
          stream.end();
        }
        active.add(abort);
        stream.push({ type: "start", partial: message });
        if (options?.signal?.aborted) abort();
        else {
          options?.signal?.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => finish(false), responseDelayMs);
          timers.add(timer);
        }
        started.resolve();
        return stream;
      },
      models: [
        {
          id: "review",
          name: "Local fixture",
          reasoning: true,
          thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 2048,
        },
      ],
    },
    provider,
  );
  settings.setModelRole("architect", `${provider}/review:high`);
  const pi = { pi: { settings } } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    modelRegistry: registry,
    models: { resolve: () => registry.getAvailable().find((m) => m.provider === provider) },
  } as unknown as ExtensionContext;
  return {
    pi,
    ctx,
    observed,
    requestStarted: started.promise,
    pendingTimers: () => timers.size,
    setResponse: (text: string) => {
      responseText = text;
    },
    async close() {
      for (const abort of active) abort();
      registry.clearSourceRegistrations(provider);
      auth.close();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

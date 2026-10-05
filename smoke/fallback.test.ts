import { expect, test } from "bun:test";
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

test("real SDK semantic fallback uses the native architect role with zero tools", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-sdk-"));
  const auth = await AuthStorage.create(":memory:");
  const settings = Settings.isolated({ "memory.backend": "off" });
  const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
  const provider = `architect-fixture-${crypto.randomUUID()}`;
  const api = `architect-api-${crypto.randomUUID()}`;
  let requests = 0;
  let responseText = '{"choice":"replan","confidence":0.9}';
  let observedToolCount = -1;
  let observedReasoning: unknown;
  registry.registerProvider(
    provider,
    {
      baseUrl: "https://unused.invalid",
      apiKey: "fixture-not-a-secret",
      api,
      streamSimple(model, context, options) {
        requests++;
        observedToolCount = context.tools?.length ?? 0;
        observedReasoning = options?.reasoning;
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant",
          api,
          provider,
          model: model.id,
          content: [
            {
              type: "text",
              text: responseText,
            },
          ],
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
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
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
  try {
    const verdict = await createDecisionFallback(
      pi,
      ctx,
      parseConfig({}),
      parseAutoConfig({}),
    )(
      {
        change: "fixture",
        remaining: 1,
        completed: 0,
        summary: "Local failure fixture",
        recentTools: [],
      },
      new AbortController().signal,
    );
    expect(verdict.choice).toBe("replan");
    expect(verdict.confidence).toBe(0.9);
    expect(requests).toBe(1);
    expect(observedToolCount).toBe(0);
    expect(observedReasoning).toBe("high");
    const evidence = {
      change: "fixture",
      remaining: 1,
      completed: 0,
      summary: "Local fixture",
      recentTools: [],
    };
    for (const invalid of [
      "private malformed response",
      '{"choice":"continue","confidence":0.99,"secret":"withheld"}',
    ]) {
      responseText = invalid;
      await expect(
        createDecisionFallback(
          pi,
          ctx,
          parseConfig({}),
          parseAutoConfig({}),
        )(evidence, new AbortController().signal),
      ).rejects.toMatchObject({ code: "FALLBACK_INVALID_RESPONSE" });
    }
    const unavailable = {
      ...ctx,
      models: { resolve: () => undefined },
    } as unknown as ExtensionContext;
    await expect(
      createDecisionFallback(
        pi,
        unavailable,
        parseConfig({}),
        parseAutoConfig({}),
      )(evidence, new AbortController().signal),
    ).rejects.toMatchObject({ code: "FALLBACK_ROLE_UNAVAILABLE" });
  } finally {
    registry.clearSourceRegistrations(provider);
    auth.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

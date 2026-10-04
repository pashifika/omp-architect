import { expect, jest, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  Settings,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { cfgBashAutoBackgroundEnabled } from "@oh-my-pi/pi-coding-agent/exec/settings";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { AutoConfig } from "../src/auto/config.ts";
import type { AutoDependencies } from "../src/auto/extension.ts";
import { readRasenSnapshot, validateRasenChange, type RasenSnapshot } from "../src/auto/rasen.ts";
import { createJevProvider } from "../src/auto/decision.ts";
import type { Reviewer } from "../src/core.ts";
import { extensionFactory } from "../src/extension.ts";

const approved = { decision: "approve" as const, summary: "Fixture evidence checked", issues: [] };

function snapshot(complete = 0): RasenSnapshot {
  return {
    change: "fixture-change",
    root: "/local-fixture",
    schema: "spec-driven",
    state: complete === 2 ? "all_done" : "ready",
    progress: { total: 2, complete, remaining: 2 - complete },
    tasks: [
      { id: "1.1", description: "Implement the scoped change", done: complete >= 1 },
      { id: "1.2", description: "Test the scoped change", done: complete >= 2 },
    ],
    instruction: "Read the context and implement only the remaining tasks",
    skill: "---\nname: rasen-apply-change\n---\nUse the generated apply workflow",
    contextFiles: [{ path: "rasen/changes/fixture-change/tasks.md", content: "Fixture tasks" }],
    fingerprint: `fixture-${complete}`,
  };
}

async function project(
  config: Partial<AutoConfig> | null = {},
  minReviews = 1,
  maxReviews = Math.max(2, minReviews),
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-smoke-"));
  if (config !== null) await Bun.write(path.join(cwd, ".omp", "auto.json"), JSON.stringify(config));
  await Bun.write(
    path.join(cwd, ".omp", "architect.json"),
    JSON.stringify({ reviews: { min: minReviews, max: maxReviews } }),
  );
  return cwd;
}

// These tests run the real OMP extension loader, then explicitly deliver lifecycle
// events. They do not pretend to execute the host's model/continuation loop.
async function loaderFixture(
  config: Partial<AutoConfig> | null = {},
  overrides: {
    dependencies?: AutoDependencies;
    reviewer?: Reviewer;
    minReviews?: number;
    maxReviews?: number;
    modelRegistry?: ModelRegistry;
    prepare?: (cwd: string) => Promise<void>;
  } = {},
) {
  const cwd = await project(config, overrides.minReviews, overrides.maxReviews);
  await overrides.prepare?.(cwd);
  const runtime = new ExtensionRuntime();
  const messages: Array<{ customType: string; content: unknown }> = [];
  const bootstraps: string[] = [];
  let reads = 0;
  let decisions = 0;
  let aborts = 0;
  runtime.sendMessage = (...args: unknown[]) => {
    messages.push(args[0] as { customType: string; content: unknown });
  };
  runtime.sendUserMessage = (...args: unknown[]) => {
    bootstraps.push(String(args[0]));
  };
  const extension = await loadExtensionFromFactory(
    extensionFactory(() => overrides.reviewer ?? (async () => approved), {
      snapshot: async () => {
        reads++;
        return snapshot();
      },
      validate: async () => {
        throw new Error("Incomplete fixtures must never validate");
      },
      decision: () => async () => {
        decisions++;
        return { choice: "continue", confidence: 0.99 };
      },
      fallback: () => async () => {
        throw new Error("Unexpected fallback");
      },
      backgroundEnabled: () => false,
      ...overrides.dependencies,
    }),
    cwd,
    new EventBus(),
    runtime,
  );
  const ctx = {
    cwd,
    modelRegistry: overrides.modelRegistry,
    agent: { kind: "main", id: "main", name: "main", depth: 0 },
    hasUI: true,
    isIdle: () => true,
    ui: { notify() {}, confirm: async () => true },
    abort() {
      aborts++;
    },
  } as unknown as ExtensionCommandContext;
  await extension.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
  const status = async (context: ExtensionContext = ctx) => {
    const result = await extension.tools
      .get("auto_status")!
      .definition.execute("status", {}, undefined, undefined, context);
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Status did not contain text");
    return result.isError ? { error: content.text } : JSON.parse(content.text);
  };
  const stop = async (context: ExtensionContext = ctx) =>
    extension.handlers.get("session_stop")![0](
      {
        type: "session_stop",
        signal: new AbortController().signal,
        last_assistant_message: {
          role: "assistant",
          content: [{ type: "text", text: "One bounded unit" }],
        },
      },
      context,
    );
  const start = async () => {
    await extension.commands.get("auto")!.handler("start fixture-change", ctx);
    expect(bootstraps).toHaveLength(1);
    await extension.handlers.get("before_agent_start")![0](
      {
        type: "before_agent_start",
        prompt: bootstraps[0],
        systemPrompt: [],
      },
      ctx,
    );
    await extension.handlers.get("turn_start")![0](
      { type: "turn_start", turnIndex: 0, timestamp: Date.now() },
      ctx,
    );
  };
  return {
    cwd,
    extension,
    ctx,
    messages,
    bootstraps,
    status,
    start,
    stop,
    counts: () => ({ reads, decisions, aborts }),
    async close() {
      await extension.handlers.get("session_shutdown")![0]({ type: "session_shutdown" }, ctx);
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

const loginFixtureKey = "synthetic-typesafe-login-not-a-secret";

for (const mode of ["missing", "disabled", "invalid", "declined"] as const) {
  test(`real loader ${mode} config only starts after explicit consent`, async () => {
    const fixture = await loaderFixture(
      mode === "missing" ? null : mode === "disabled" ? { enabled: false } : {},
      {
        prepare:
          mode === "invalid"
            ? async (cwd) => {
                await Bun.write(path.join(cwd, ".omp/auto.json"), "{");
              }
            : undefined,
      },
    );
    let confirms = 0;
    const ctx = {
      ...fixture.ctx,
      ui: {
        ...fixture.ctx.ui,
        confirm: async () => {
          confirms++;
          return mode !== "declined";
        },
      },
    };
    try {
      expect(await fixture.status()).toMatchObject({
        status: "idle",
        enabled: mode !== "disabled" && mode !== "invalid",
      });
      if (mode === "invalid") expect((await fixture.status()).error).toContain("Invalid");
      expect(fixture.bootstraps).toHaveLength(0);
      await fixture.extension.commands.get("auto")!.handler("start fixture-change", ctx);
      expect(confirms).toBe(mode === "disabled" || mode === "invalid" ? 0 : 1);
      expect(fixture.bootstraps).toHaveLength(mode === "missing" ? 1 : 0);
      expect(fixture.counts().reads).toBe(mode === "missing" ? 1 : 0);
    } finally {
      await fixture.close();
    }
  });
}

test("real loader rejects broken or oversized brief instructions before consent or CLI", async () => {
  const fixture = await loaderFixture();
  let confirms = 0;
  const ctx = {
    ...fixture.ctx,
    ui: {
      ...fixture.ctx.ui,
      confirm: async () => {
        confirms++;
        return true;
      },
    },
  };
  try {
    await fixture.extension.commands
      .get("auto")!
      .handler("start fixture-change --brief missing", ctx);
    await fixture.extension.commands
      .get("auto")!
      .handler(`start fixture-change ${"x".repeat(11000)}`, ctx);
    expect(confirms).toBe(0);
    expect(fixture.counts().reads).toBe(0);
    expect(fixture.bootstraps).toEqual([]);
  } finally {
    await fixture.close();
  }
});

for (const cancel of ["stop", "input", "session"] as const) {
  test(`real loader ${cancel} cancels pending confirmation and repeated starts cannot reset it`, async () => {
    const fixture = await loaderFixture();
    const deferred = Promise.withResolvers<boolean>();
    let confirms = 0;
    const ctx = {
      ...fixture.ctx,
      ui: {
        ...fixture.ctx.ui,
        confirm: async () => {
          confirms++;
          return deferred.promise;
        },
      },
    };
    try {
      const first = fixture.extension.commands
        .get("auto")!
        .handler("start fixture-change Keep original", ctx);
      await Promise.resolve();
      await fixture.extension.commands
        .get("auto")!
        .handler("start fixture-change Replace original", ctx);
      expect(confirms).toBe(1);
      if (cancel === "stop") await fixture.extension.commands.get("auto")!.handler("stop", ctx);
      else if (cancel === "input")
        await fixture.extension.handlers.get("input")![0](
          { type: "input", text: "new request", source: "interactive" },
          ctx,
        );
      else
        await fixture.extension.handlers.get("session_switch")![0](
          { type: "session_switch", reason: "resume" },
          ctx,
        );
      deferred.resolve(true);
      await first;
      expect(fixture.bootstraps).toEqual([]);
      expect(fixture.counts().reads).toBe(0);
    } finally {
      deferred.resolve(false);
      await fixture.close();
    }
  });
}

test("brief is frozen after consent; new runs replace instructions and stopped runs keep their budgets", async () => {
  const fixture = await loaderFixture(
    {},
    {
      prepare: async (cwd) => {
        await Bun.write(path.join(cwd, ".omp/brief/example/_shared.md"), "Frozen {var}\n{blocks}");
      },
    },
  );
  try {
    const ctx = {
      ...fixture.ctx,
      ui: {
        ...fixture.ctx.ui,
        confirm: async (title: string, content: string) => {
          expect(content).toContain("Frozen fixture-change");
          await Bun.write(path.join(fixture.cwd, ".omp/brief/example/_shared.md"), "MUTATED");
          return true;
        },
      },
    };
    await fixture.extension.commands
      .get("auto")!
      .handler("start fixture-change --brief example -- Preserve me", ctx);
    expect(fixture.bootstraps[0]).toContain("Frozen fixture-change");
    expect(fixture.bootstraps[0]).not.toContain("MUTATED");
    await fixture.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: fixture.bootstraps[0], systemPrompt: [] },
      fixture.ctx,
    );
    const next = (await fixture.stop()) as { additionalContext: string };
    expect(next.additionalContext).toContain("Frozen fixture-change");
    expect(next.additionalContext).toContain("Preserve me");
    await fixture.extension.commands
      .get("auto")!
      .handler("start fixture-change Replace me", fixture.ctx);
    expect(fixture.bootstraps).toHaveLength(1);
    expect((await fixture.status()).steps).toBe("2/8");
    await fixture.extension.commands.get("auto")!.handler("stop", fixture.ctx);
    await fixture.extension.commands
      .get("auto")!
      .handler("start fixture-change New guidance", fixture.ctx);
    expect(fixture.bootstraps).toHaveLength(2);
    expect(fixture.bootstraps[1]).toContain("New guidance");
    expect(fixture.bootstraps[1]).not.toContain("Preserve me");
  } finally {
    await fixture.close();
  }
});

for (const delivery of ["bootstrap", "continuation"] as const) {
  for (const cancel of ["stop", "session", "new-input"] as const) {
    test(`real loader rejects queued ${delivery} after ${cancel} without ordinary-request fallback`, async () => {
      const fixture = await loaderFixture();
      try {
        await fixture.extension.commands
          .get("auto")!
          .handler("start fixture-change Old instructions", fixture.ctx);
        let text = fixture.bootstraps[0];
        if (delivery === "continuation") {
          await fixture.extension.handlers.get("before_agent_start")![0](
            { type: "before_agent_start", prompt: text, systemPrompt: [] },
            fixture.ctx,
          );
          text = ((await fixture.stop()) as { additionalContext: string }).additionalContext;
        }
        if (cancel === "stop")
          await fixture.extension.commands.get("auto")!.handler("stop", fixture.ctx);
        else if (cancel === "session")
          await fixture.extension.handlers.get("session_switch")![0](
            { type: "session_switch", reason: "resume" },
            fixture.ctx,
          );
        else
          await fixture.extension.handlers.get("input")![0](
            { type: "input", text: "Unrelated task", source: "interactive" },
            fixture.ctx,
          );
        await fixture.extension.handlers.get("before_agent_start")![0](
          { type: "before_agent_start", prompt: text, systemPrompt: [] },
          fixture.ctx,
        );
        expect(
          await fixture.extension.handlers.get("tool_call")![0](
            {
              type: "tool_call",
              toolName: "write",
              toolCallId: "stale",
              input: { path: "x", content: "y" },
            },
            fixture.ctx,
          ),
        ).toMatchObject({ block: true });
        expect(fixture.counts().aborts).toBeGreaterThan(0);
        expect(fixture.bootstraps).toHaveLength(1);
        await fixture.extension.handlers.get("input")![0](
          { type: "input", text: "Fresh unrelated request", source: "interactive" },
          fixture.ctx,
        );
        await fixture.extension.handlers.get("before_agent_start")![0](
          { type: "before_agent_start", prompt: "Fresh unrelated request", systemPrompt: [] },
          fixture.ctx,
        );
        expect(
          await fixture.extension.handlers.get("tool_call")![0](
            {
              type: "tool_call",
              toolName: "write",
              toolCallId: "fresh",
              input: { path: "x", content: "y" },
            },
            fixture.ctx,
          ),
        ).toBeUndefined();
      } finally {
        await fixture.close();
      }
    });
  }
}

const envFixtureKey = "synthetic-typesafe-env-not-a-secret";

async function jevAuthFixture(
  options: {
    loginKey?: string;
    envKey?: string;
    fallback?: AutoConfig["fallback"];
    configureKeys?: (auth: AuthStorage) => void;
  } = {},
) {
  const authDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-auth-smoke-"));
  const originalEnvKey = process.env.TYPESAFE_API_KEY;
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let auth: AuthStorage | undefined;
  let closeFixture: (() => Promise<void>) | undefined;
  let fallbacks = 0;
  const close = async () => {
    try {
      await closeFixture?.();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnvKey === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = originalEnvKey;
      try {
        auth?.close();
      } finally {
        await fs.rm(authDir, { recursive: true, force: true });
      }
    }
  };
  try {
    if (options.envKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = options.envKey;
    // Preserve Bun's ancillary fetch properties, including non-enumerable ones.
    globalThis.fetch = Object.defineProperties(
      (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        requests.push({ url: String(input), init });
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              next: {
                type: "choice",
                choice: "continue",
                confidence: 0.99,
                probabilities: {
                  continue: 0.97,
                  replan: 0.01,
                  needs_user: 0.01,
                  uncertain: 0.01,
                },
              },
            },
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      }) as typeof fetch,
      Object.getOwnPropertyDescriptors(originalFetch),
    );
    auth = await AuthStorage.create(path.join(authDir, "agent.db"));
    if (options.loginKey !== undefined)
      await auth.credentials.set("typesafe", {
        type: "api_key",
        key: options.loginKey,
        source: "login",
      });
    const settings = Settings.isolated({
      "memory.backend": "off",
      "bash.autoBackground.enabled": false,
    });
    const registry = new ModelRegistry(auth, path.join(authDir, "models.yml"), { settings });
    // ModelRegistry installs the host resolver; inject faults only after that.
    options.configureKeys?.(auth);
    const fixture = await loaderFixture(
      { maxSteps: 2, decisionTimeoutMs: 500, fallback: options.fallback ?? "architect" },
      {
        modelRegistry: registry,
        dependencies: {
          // Remove the loader fixture's decision override, not the production provider.
          decision: undefined,
          fallback: () => async () => {
            fallbacks++;
            throw new Error("Unexpected authentication fallback");
          },
        },
      },
    );
    closeFixture = fixture.close;
    return { ...fixture, requests, fallbacks: () => fallbacks, close };
  } catch (error) {
    await close();
    throw error;
  }
}

interface JevAuthCase {
  scenario: string;
  loginKey?: string;
  envKey?: string;
  expectedKey: string;
}

const jevAuthCases: JevAuthCase[] = [
  {
    scenario: "uses an OMP /login TypeSafe key with TYPESAFE_API_KEY unset",
    loginKey: loginFixtureKey,
    expectedKey: loginFixtureKey,
  },
  {
    scenario: "prefers the OMP /login TypeSafe key over TYPESAFE_API_KEY",
    loginKey: loginFixtureKey,
    envKey: envFixtureKey,
    expectedKey: loginFixtureKey,
  },
  {
    scenario: "retains TYPESAFE_API_KEY-only compatibility",
    envKey: envFixtureKey,
    expectedKey: envFixtureKey,
  },
];

test.each(jevAuthCases)("real loader default Jev $scenario", async (testCase) => {
  const fixture = await jevAuthFixture(testCase);
  try {
    expect(process.env.TYPESAFE_API_KEY).toBe(testCase.envKey);
    await fixture.start();
    const continuation = (await fixture.stop()) as {
      continue: boolean;
      additionalContext: string;
    };
    expect(continuation).toMatchObject({ continue: true });
    expect(fixture.requests).toHaveLength(1);
    const request = fixture.requests[0]!;
    expect(request.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(request.init?.headers).get("Authorization")).toBe(
      `Bearer ${testCase.expectedKey}`,
    );
    const status = await fixture.status();
    expect(status).toMatchObject({
      status: "running",
      decisions: 1,
      completionVerified: false,
    });
    expect(fixture.fallbacks()).toBe(0);
    const visible = JSON.stringify({ status, continuation, messages: fixture.messages });
    expect(visible).not.toContain(loginFixtureKey);
    expect(visible).not.toContain(envFixtureKey);
  } finally {
    await fixture.close();
  }
});

test("real loader default Jev fails closed without TypeSafe credentials or network", async () => {
  const fixture = await jevAuthFixture({ fallback: "stop" });
  try {
    await fixture.start();
    expect(await fixture.stop()).toBeUndefined();
    const status = await fixture.status();
    expect(status).toMatchObject({
      status: "uncertain",
      decisions: 1,
      completionVerified: false,
    });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.fallbacks()).toBe(0);
    expect(fixture.bootstraps).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("real loader default Jev fails closed when OMP key resolution rejects without leaking keys", async () => {
  const resolvedKeys: string[] = [];
  const fixture = await jevAuthFixture({
    loginKey: loginFixtureKey,
    envKey: envFixtureKey,
    fallback: "stop",
    configureKeys(auth) {
      auth.keys.setResolver(async (key) => {
        resolvedKeys.push(key);
        throw new Error(`Resolver rejected ${key} while ${envFixtureKey} was set`);
      });
    },
  });
  try {
    await fixture.start();
    expect(await fixture.stop()).toBeUndefined();
    const status = await fixture.status();
    expect(status).toMatchObject({
      status: "uncertain",
      decisions: 1,
      completionVerified: false,
    });
    expect(resolvedKeys).toEqual([loginFixtureKey]);
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.fallbacks()).toBe(0);
    expect(fixture.bootstraps).toHaveLength(1);
    const visible = JSON.stringify({ status, messages: fixture.messages });
    expect(visible).not.toContain(loginFixtureKey);
    expect(visible).not.toContain(envFixtureKey);
    expect(visible).not.toContain("Resolver rejected");
  } finally {
    await fixture.close();
  }
});

test("real loader stops Auto at its turn cap without another decision or retry", async () => {
  const fixture = await loaderFixture({ maxSteps: 1 });
  try {
    await fixture.start();
    expect(await fixture.stop()).toBeUndefined();
    expect(await fixture.status()).toMatchObject({
      status: "budget_exhausted",
      steps: "1/1",
      completionVerified: false,
    });
    expect(fixture.counts()).toEqual({ reads: 2, decisions: 0, aborts: 0 });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.counts()).toEqual({ reads: 2, decisions: 0, aborts: 0 });
    expect(fixture.messages.filter((message) => message.customType === "omp-auto")).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("real loader stops Auto on tool denial without decision, continuation, or workaround", async () => {
  const fixture = await loaderFixture();
  try {
    await fixture.start();
    await fixture.extension.handlers.get("tool_approval_resolved")![0](
      {
        type: "tool_approval_resolved",
        toolName: "bash",
        toolCallId: "denied",
        approved: false,
      },
      fixture.ctx,
    );
    expect(await fixture.status()).toMatchObject({
      status: "needs_user",
      completionVerified: false,
    });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.counts()).toEqual({ reads: 1, decisions: 0, aborts: 1 });
    expect(fixture.bootstraps).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("real loader gives an unrelated user request ownership and cancels the existing Auto run", async () => {
  const fixture = await loaderFixture();
  try {
    await fixture.start();
    await fixture.extension.handlers.get("input")![0](
      { type: "input", text: "Explain this unrelated function", source: "interactive" },
      fixture.ctx,
    );
    await fixture.extension.handlers.get("before_agent_start")![0](
      {
        type: "before_agent_start",
        prompt: "Explain this unrelated function",
        systemPrompt: [],
      },
      fixture.ctx,
    );
    expect(await fixture.status()).toMatchObject({
      status: "cancelled",
      reason: "Superseded by new user input",
    });
    await fixture.stop();
    expect(fixture.counts()).toEqual({ reads: 1, decisions: 0, aborts: 0 });
  } finally {
    await fixture.close();
  }
});

test("real loader denies subagents Auto ownership, status, and lifecycle continuation", async () => {
  const fixture = await loaderFixture();
  const child = {
    ...fixture.ctx,
    agent: { kind: "sub", id: "child", name: "omp-worker", depth: 1 },
  } as ExtensionCommandContext;
  try {
    await fixture.extension.commands.get("auto")!.handler("start fixture-change", child);
    expect(fixture.bootstraps).toHaveLength(0);
    expect(fixture.counts().reads).toBe(0);
    await fixture.start();
    expect(await fixture.status(child)).toMatchObject({
      error: "Auto belongs to the main session",
    });
    expect(await fixture.stop(child)).toBeUndefined();
    await fixture.extension.handlers.get("before_agent_start")![0](
      {
        type: "before_agent_start",
        prompt: "Child work",
        systemPrompt: [],
      },
      child,
    );
    await fixture.extension.handlers.get("tool_approval_resolved")![0](
      {
        type: "tool_approval_resolved",
        toolName: "bash",
        toolCallId: "child-denied",
        approved: false,
      },
      child,
    );
    await fixture.extension.commands.get("auto")!.handler("stop", child);
    expect(await fixture.status()).toMatchObject({ status: "running", steps: "1/8" });
    expect(fixture.counts()).toEqual({ reads: 1, decisions: 0, aborts: 0 });
  } finally {
    await fixture.close();
  }
});

for (const boundary of ["confirmation", "preflight"] as const) {
  for (const invalidation of ["stop", "user", "input", "session"] as const) {
    test(`real loader rejects stale Auto ${boundary} after ${invalidation}`, async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const fixture = await loaderFixture(
        {},
        {
          dependencies: {
            snapshot: async () => {
              if (boundary === "preflight") {
                entered.resolve();
                await release.promise;
              }
              return snapshot();
            },
          },
        },
      );
      fixture.ctx.ui.confirm = async () => {
        if (boundary === "confirmation") {
          entered.resolve();
          await release.promise;
        }
        return true;
      };
      try {
        const starting = fixture.extension.commands
          .get("auto")!
          .handler("start fixture-change", fixture.ctx);
        await entered.promise;
        if (invalidation === "stop") {
          await fixture.extension.commands.get("auto")!.handler("stop", fixture.ctx);
        } else if (invalidation === "user" || invalidation === "input") {
          await fixture.extension.handlers.get("input")![0](
            { type: "input", text: "A different user request", source: "interactive" },
            fixture.ctx,
          );
          if (invalidation === "user")
            await fixture.extension.handlers.get("before_agent_start")![0](
              {
                type: "before_agent_start",
                prompt: "A different user request",
                systemPrompt: [],
              },
              fixture.ctx,
            );
        } else {
          await fixture.extension.handlers.get("session_start")![0](
            { type: "session_start" },
            fixture.ctx,
          );
        }
        release.resolve();
        await starting;
        expect(fixture.bootstraps).toHaveLength(0);
        expect(await fixture.status()).toMatchObject({ status: "idle" });
      } finally {
        release.resolve();
        await fixture.close();
      }
    });
  }
}

for (const valid of [true, false]) {
  test(`real loader reserves sole completion review until strict validation ${valid ? "passes" : "fails"}`, async () => {
    let reads = 0;
    let reviews = 0;
    let validations = 0;
    const fixture = await loaderFixture(
      {},
      {
        minReviews: 1,
        maxReviews: 1,
        reviewer: async () => {
          reviews++;
          return approved;
        },
        dependencies: {
          snapshot: async () => snapshot(reads++ === 0 ? 0 : 2),
          validate: async () => {
            validations++;
            if (!valid) throw new Error("Strict validation fixture failed");
          },
        },
      },
    );
    try {
      await fixture.start();
      const explicit = await fixture.extension.tools
        .get("architect_checkpoint")!
        .definition.execute(
          "completion",
          { phase: "completion", summary: "Claimed done before CLI validation" },
          undefined,
          undefined,
          fixture.ctx,
        );
      expect(explicit.isError).toBe(false);
      expect(reviews).toBe(0);
      expect(validations).toBe(0);
      expect(await fixture.stop()).toBeUndefined();
      expect(validations).toBe(1);
      expect(reviews).toBe(valid ? 1 : 0);
      expect(await fixture.status()).toMatchObject({
        status: valid ? "completed" : "blocked",
        completionVerified: valid,
      });
    } finally {
      await fixture.close();
    }
  });
}

test("real loader keeps Auto completion within 24s despite the normal 120s review deadline", async () => {
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  let reads = 0;
  let reviews = 0;
  let validations = 0;
  let reviewSignal: AbortSignal | undefined;
  let cancelReview = () => {};
  const fixture = await loaderFixture(
    {},
    {
      minReviews: 1,
      reviewer: async (_request, signal) => {
        reviews++;
        reviewSignal = signal;
        const { promise, reject } = Promise.withResolvers<never>();
        const aborted = () => reject(signal.reason ?? new Error("Fixture review cancelled"));
        cancelReview = () => reject(new Error("Fixture review cleanup"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
        markStarted();
        try {
          return await promise;
        } finally {
          signal.removeEventListener("abort", aborted);
        }
      },
      dependencies: {
        snapshot: async () => snapshot(reads++ === 0 ? 0 : 2),
        validate: async () => {
          validations++;
        },
      },
    },
  );
  let stopping: Promise<unknown> | undefined;
  try {
    // Load and start the real SDK fixture before replacing the clock; retain normal review defaults.
    await fixture.start();
    jest.useFakeTimers();
    let settled = false;
    stopping = fixture.stop();
    void stopping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started;
    expect(reviews).toBe(1);
    expect(validations).toBe(1);
    jest.advanceTimersByTime(23_999);
    await Promise.resolve();
    expect(reviewSignal?.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(await fixture.status()).toMatchObject({ status: "running", completionVerified: false });

    jest.advanceTimersByTime(2);
    await expect(stopping).resolves.toBeUndefined();
    expect(reviewSignal?.aborted).toBe(true);
    expect(await fixture.status()).toMatchObject({
      status: "blocked",
      reason: "Auto boundary cancelled or timed out",
      completionVerified: false,
    });
    expect(await fixture.stop()).toBeUndefined();
    expect(reviews).toBe(1);
    expect(validations).toBe(1);
    expect(reads).toBe(2);
    expect(fixture.counts().decisions).toBe(0);
    expect(fixture.bootstraps).toHaveLength(1);
    expect(fixture.messages.filter((message) => message.customType === "omp-auto")).toHaveLength(1);
  } finally {
    try {
      cancelReview();
      await stopping?.catch(() => {});
    } finally {
      jest.useRealTimers();
      await fixture.close();
    }
  }
});

test("real loader blocks subagent spawning and background-capable tool paths during Auto", async () => {
  const fixture = await loaderFixture();
  try {
    await fixture.start();
    expect(
      await fixture.extension.handlers.get("before_subagent_spawn")![0](
        {
          type: "before_subagent_spawn",
          agent: "omp-worker",
          task: "Delegate implementation",
        },
        fixture.ctx,
      ),
    ).toMatchObject({ block: true });
    for (const [toolName, input] of [
      ["task", { task: "Work in a child" }],
      ["bash", { command: "echo hello", async: true }],
      ["bash", { command: "echo hello", name: "fixture-service" }],
    ] as const) {
      expect(
        await fixture.extension.handlers.get("tool_call")![0](
          {
            type: "tool_call",
            toolName,
            toolCallId: `${toolName}-${JSON.stringify(input)}`,
            input,
          },
          fixture.ctx,
        ),
      ).toMatchObject({ block: true });
    }
    expect(await fixture.status()).toMatchObject({ status: "running" });
  } finally {
    await fixture.close();
  }
});

test("real loader preserves identical preparation retries but rejects replay after a turn starts", async () => {
  const fixture = await loaderFixture();
  try {
    await fixture.extension.commands.get("auto")!.handler("start fixture-change", fixture.ctx);
    const event = { type: "before_agent_start", prompt: fixture.bootstraps[0], systemPrompt: [] };
    await fixture.extension.handlers.get("before_agent_start")![0](event, fixture.ctx);
    await fixture.extension.handlers.get("before_agent_start")![0](event, fixture.ctx);
    expect(await fixture.status()).toMatchObject({ status: "running", steps: "1/8" });
    await fixture.extension.handlers.get("turn_start")![0](
      { type: "turn_start", turnIndex: 0, timestamp: Date.now() },
      fixture.ctx,
    );
    await fixture.extension.handlers.get("before_agent_start")![0](event, fixture.ctx);
    expect(await fixture.status()).toMatchObject({ status: "cancelled", steps: "1/8" });
    expect(fixture.counts()).toEqual({ reads: 1, decisions: 0, aborts: 1 });
  } finally {
    await fixture.close();
  }
});

for (const interrupt of ["status", "unexpected-hidden", "new-user"] as const) {
  test(`real loader ${interrupt} preserves the correct continuation ownership`, async () => {
    const fixture = await loaderFixture();
    try {
      await fixture.start();
      const continuation = (await fixture.stop()) as {
        continue: boolean;
        additionalContext: string;
      };
      expect(continuation.continue).toBe(true);
      expect(await fixture.status()).toMatchObject({ status: "running", steps: "2/8" });
      if (interrupt === "status") {
        await fixture.extension.handlers.get("input")![0](
          {
            type: "input",
            text: "/auto status",
            source: "interactive",
          },
          fixture.ctx,
        );
        await fixture.extension.commands.get("auto")!.handler("status", fixture.ctx);
      } else if (interrupt === "new-user") {
        await fixture.extension.handlers.get("input")![0](
          {
            type: "input",
            text: "Work on a different user request",
            source: "interactive",
          },
          fixture.ctx,
        );
      }
      await fixture.extension.handlers.get("before_agent_start")![0](
        {
          type: "before_agent_start",
          prompt:
            interrupt === "status"
              ? continuation.additionalContext
              : "Work on a different user request",
          systemPrompt: [],
        },
        fixture.ctx,
      );
      if (interrupt === "status") {
        expect(await fixture.status()).toMatchObject({ status: "running", steps: "2/8" });
        expect(await fixture.stop()).toMatchObject({ continue: true });
        expect(await fixture.status()).toMatchObject({ status: "running", steps: "3/8" });
        expect(fixture.counts().decisions).toBe(2);
      } else {
        expect(await fixture.status()).toMatchObject({ status: "cancelled", steps: "2/8" });
        expect(fixture.counts().decisions).toBe(1);
        expect(fixture.counts().aborts).toBe(interrupt === "unexpected-hidden" ? 1 : 0);
      }
    } finally {
      await fixture.close();
    }
  });
}

// A real OMP AgentSession plus local stream transport: /auto dispatch, extension
// lifecycle, hidden continuation delivery, and agent-end handling are host code.
// The combined case runs the pinned actual Rasen CLI and actual OMP write tools;
// only model transports and the architect verdict are deterministic fixtures.
for (const mode of [
  "snapshots",
  "real-cli",
  "max-cap",
  "config-free",
  "brief",
  "cancel-delivery",
] as const) {
  test(`real OMP session ${mode === "cancel-delivery" ? "rejects cancelled queued delivery before model inference" : mode === "max-cap" ? "enforces a two-turn cap without terminal retry" : `completes ${mode} with two architect reviews`}`, async () => {
    let executable: string | undefined;
    if (mode === "real-cli") {
      executable = process.env.RASEN_BIN;
      if (!executable) {
        const stamp = await Bun.file(
          path.resolve(import.meta.dir, "../node_modules/.cache/omp-architect/rasen-build.json"),
        ).json();
        expect(stamp.commit).toBe("f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd");
        executable = stamp.executable;
      }
    }
    const cwd = await project(
      mode === "config-free" || mode === "brief"
        ? null
        : {
            ...(executable ? { rasenExecutable: executable } : {}),
            ...(mode === "max-cap" ? { maxSteps: 2 } : {}),
          },
      2,
    );
    const guidance = "  Keep changes small  and preserve spacing\n  Report facts in Japanese\n";
    const briefText = "Apply fixture-change\n  TS for fixture-change\nUnknown {untouched}\n";
    if (mode === "brief") {
      await Bun.write(
        path.join(cwd, ".omp/brief/example/_shared.md"),
        "---\nvariable: change\n---\nApply {change}\n{blocks}\nUnknown {untouched}\n",
      );
      await Bun.write(
        path.join(cwd, ".omp/brief/example/ts.md"),
        "---\naliases: typescript\n---\n  TS for {change}\n",
      );
    }
    const taskPath = path.join(cwd, "rasen", "changes", "fixture-change", "tasks.md");
    const tasks = (complete: number) =>
      `## 1. Local integration fixture\n\n- [${complete >= 1 ? "x" : " "}] 1.1 Mark fixture unit one\n- [${complete >= 2 ? "x" : " "}] 1.2 Mark fixture unit two\n`;
    if (executable) {
      const cli = (args: string[]) => {
        const result = spawnSync(executable!, args, {
          cwd,
          shell: false,
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
          env: {
            ...process.env,
            HOME: path.join(cwd, "isolated-home"),
            XDG_CONFIG_HOME: path.join(cwd, "isolated-config"),
            RASEN_TELEMETRY: "0",
            DO_NOT_TRACK: "1",
            CI: "1",
            NO_COLOR: "1",
          },
        });
        if (result.error || result.status !== 0)
          throw new Error(`Real Rasen fixture ${args[0]} failed`);
        return result.stdout;
      };
      expect(cli(["--version"]).trim()).toMatch(/^0\.1\.8 \(dev\.local f0ae20d[0-9a-f]*\)$/);
      cli(["init", "--tools", "omp"]);
      cli(["new", "change", "fixture-change", "--schema", "spec-driven", "--json"]);
      await Bun.write(taskPath, tasks(0));
      await Bun.write(
        path.join(path.dirname(taskPath), "specs", "fixture-progress", "spec.md"),
        "## ADDED Requirements\n\n### Requirement: Fixture progress\nThe fixture SHALL record the completion of its local units.\n\n#### Scenario: Unit completed\n- **WHEN** a local fixture unit finishes\n- **THEN** its task checkbox is checked\n",
      );
    }
    const auth = await AuthStorage.create(":memory:");
    const settings = Settings.isolated({
      "memory.backend": "off",
      "bash.autoBackground.enabled": false,
    });
    const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
    const provider = `auto-fixture-${crypto.randomUUID()}`;
    const api = `auto-api-${crypto.randomUUID()}`;
    auth.keys.setRuntime(provider, "fixture-not-a-secret");
    let requests = 0;
    let reads = 0;
    let validations = 0;
    let decisions = 0;
    let reviews = 0;
    const reviewEvidence: string[] = [];
    let confirms = 0;
    let beforeStarts = 0;
    const stops: boolean[] = [];
    const errors: unknown[] = [];
    const sends: Promise<unknown>[] = [];
    const contexts: string[] = [];
    const prompts: string[] = [];
    const providerConfig: Parameters<ModelRegistry["registerProvider"]>[1] = {
      baseUrl: "https://unused.invalid",
      apiKey: "fixture-not-a-secret",
      api,
      streamSimple(model, context) {
        requests++;
        contexts.push(JSON.stringify(context.messages));
        const stream = createAssistantMessageEventStream();
        const toolStep = mode === "real-cli" && (requests === 1 || requests === 3);
        const message: AssistantMessage = {
          role: "assistant",
          api,
          provider,
          model: model.id,
          content: toolStep
            ? [
                {
                  type: "toolCall",
                  id: `fixture-write-${requests}`,
                  name: "write",
                  arguments: { path: taskPath, content: tasks(requests === 1 ? 1 : 2) },
                },
              ]
            : [{ type: "text", text: `Bounded implementation fixture turn ${requests}` }],
          stopReason: toolStep ? "toolUse" : "stop",
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
        if (toolStep) {
          const toolCall = message.content[0];
          if (toolCall.type !== "toolCall") throw new Error("Missing fixture write call");
          stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
          stream.push({
            type: "toolcall_delta",
            contentIndex: 0,
            delta: JSON.stringify(toolCall.arguments),
            partial: message,
          });
          stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
        }
        stream.push({ type: "done", reason: toolStep ? "toolUse" : "stop", message });
        stream.end();
        return stream;
      },
      models: [
        {
          id: "implementation",
          name: "Local Auto fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 64000,
          maxTokens: 1024,
        },
      ],
    };
    registry.registerProvider(provider, providerConfig, provider);
    const dependencies: AutoDependencies = {
      snapshot: async (...args) => {
        reads++;
        return mode === "real-cli"
          ? readRasenSnapshot(...args)
          : snapshot(mode === "max-cap" ? 0 : Math.min(reads - 1, 2));
      },
      validate: async (...args) => {
        validations++;
        if (mode === "real-cli") await validateRasenChange(...args);
      },
      decision: () =>
        mode === "real-cli"
          ? createJevProvider(
              { model: "jev-latest", timeoutMs: 500, maxEvidenceChars: 12000 },
              {
                readApiKey: () => "local-fixture-not-a-secret",
                fetch: async (url, init) => {
                  decisions++;
                  expect(url).toBe("https://api.typesafe.ai/v1/systemone");
                  expect(JSON.parse(String(init.body)).state).toMatchObject({
                    change: "fixture-change",
                    completed: 1,
                    remaining: 1,
                  });
                  return new Response(
                    JSON.stringify({
                      model: "jev-latest",
                      answers: {
                        next: {
                          type: "choice",
                          choice: "continue",
                          confidence: 0.99,
                          probabilities: {
                            continue: 0.97,
                            replan: 0.01,
                            needs_user: 0.01,
                            uncertain: 0.01,
                          },
                        },
                      },
                      usage: { input_tokens: 1, output_tokens: 1 },
                    }),
                  );
                },
              },
            )
          : async () => {
              decisions++;
              return { choice: "continue", confidence: 0.99 };
            },
      fallback: () => async () => {
        throw new Error("Unexpected fallback");
      },
      // SDK callers can isolate settings without binding OMP's process-global CLI settings.
      backgroundEnabled: () => cfgBashAutoBackgroundEnabled.get(settings),
    };
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const created = await createAgentSession({
        cwd,
        agentDir: path.join(cwd, "isolated-agent"),
        authStorage: auth,
        modelRegistry: registry,
        model: registry.getAvailable().find((model) => model.provider === provider),
        settings,
        sessionManager: SessionManager.inMemory(cwd),
        extensions: [
          (pi) => {
            if (mode === "cancel-delivery")
              pi.on("before_agent_start", async () => {
                // Stop after sendUserMessage queued the bootstrap, before Auto accepts delivery.
                await session!
                  .extensionRunner!.getCommand("auto")!
                  .handler("stop", session!.extensionRunner!.createCommandContext());
              });
          },
          extensionFactory(
            () => async (request) => {
              reviews++;
              reviewEvidence.push(request.evidence);
              return approved;
            },
            dependencies,
          ),
          (pi) => {
            pi.registerProvider(provider, providerConfig);
            pi.on("before_agent_start", (event) => {
              beforeStarts++;
              prompts.push(event.prompt);
            });
            pi.on("session_stop", (event) => {
              stops.push(event.stop_hook_active);
            });
          },
        ],
        disableExtensionDiscovery: true,
        skills: [],
        rules: [],
        contextFiles: [],
        promptTemplates: [],
        slashCommands: [],
        enableMCP: false,
        enableLsp: false,
        enableIrc: false,
        skipPythonPreflight: true,
        spawns: "",
        toolNames: mode === "real-cli" ? ["write"] : [],
        autoApprove: mode === "real-cli",
        cacheWarming: false,
        bindProcessState: false,
        systemPrompt: "Execute only the local smoke-test fixture",
        hasUI: true,
      });
      session = created.session;
      expect(created.extensionsResult.errors).toEqual([]);
      await initializeExtensions(session, {
        reportSendError: (_action, error) => {
          errors.push(error);
        },
        reportRuntimeError: (error) => {
          errors.push(error);
        },
        trackExtensionSend: (task) => {
          sends.push(task);
        },
        uiContext: {
          ...session.extensionRunner!.getUIContext(),
          notify: (message: string, type: string) => {
            if (type === "error") errors.push(message);
          },
          confirm: async () => {
            confirms++;
            return true;
          },
        } as unknown as ExtensionUIContext,
      });
      await session.prompt(
        mode === "brief"
          ? `/auto start fixture-change --brief example typescript -- ${guidance}`
          : `/auto start fixture-change ${guidance}`,
      );
      await Promise.all(sends);
      await session.waitForIdle();
      expect(errors).toEqual([]);
      if (mode === "cancel-delivery") {
        expect(requests).toBe(0);
        expect(reads).toBe(1);
        expect(decisions).toBe(0);
        expect(reviews).toBe(0);
        expect(session.isStreaming).toBe(false);
        return;
      }
      for (const prompt of prompts) {
        expect(prompt).toContain(guidance);
        if (mode === "brief") expect(prompt).toContain(briefText);
      }
      for (const evidence of reviewEvidence) {
        expect(JSON.parse(evidence).request).toContain(guidance);
        if (mode === "brief") expect(JSON.parse(evidence).request).toContain(briefText);
      }
      expect(confirms).toBe(1);
      expect(requests).toBe(mode === "max-cap" ? 2 : mode === "real-cli" ? 5 : 3);
      expect(reads).toBe(mode === "max-cap" ? 3 : 4);
      expect(decisions).toBe(1);
      expect(validations).toBe(mode === "max-cap" ? 0 : 2);
      expect(reviews).toBe(mode === "max-cap" ? 0 : 2);
      expect(beforeStarts).toBe(mode === "max-cap" ? 2 : 3);
      expect(stops).toEqual(mode === "max-cap" ? [false, true] : [false, true, true]);
      expect(contexts[mode === "real-cli" ? 2 : 1]).toContain(
        "Semantic triage supports the next bounded task",
      );
      if (mode !== "max-cap")
        expect(contexts[mode === "real-cli" ? 4 : 2]).toContain(
          "Minimum independent review rounds not yet met",
        );
      const tool = session.extensionRunner!.getRegisteredTool("auto_status")!.definition;
      const result = await tool.execute(
        "status",
        {},
        undefined,
        undefined,
        session.extensionRunner!.createContext(),
      );
      expect(result.content[0].type).toBe("text");
      if (result.content[0].type !== "text") throw new Error("Missing status text");
      expect(JSON.parse(result.content[0].text)).toMatchObject({
        status: mode === "max-cap" ? "budget_exhausted" : "completed",
        steps: mode === "max-cap" ? "2/2" : "3/8",
        completionVerified: mode !== "max-cap",
      });
      if (mode === "real-cli") {
        expect(await Bun.file(taskPath).text()).toBe(tasks(2));
        for (const evidence of reviewEvidence) {
          expect(evidence).toContain("Mark fixture unit one");
          expect(evidence).toContain("Mark fixture unit two");
          expect(evidence).toContain("Strict CLI artifact validation passed");
        }
        expect(JSON.parse(result.content[0].text).toolCalls).toBe("2/80");
        const failures = session.agent.state.messages.filter(
          (message) => message.role === "toolResult" && message.isError,
        );
        expect(failures).toEqual([]);
      }
    } finally {
      await session?.dispose();
      registry.clearSourceRegistrations(provider);
      auth.close();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 30000);
}

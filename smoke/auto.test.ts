import { expect, jest, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import {
  AgentRegistry,
  type AgentSession,
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
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { readRasenWorkflow, type RasenWorkflow } from "../src/auto/workflow.ts";
import type { AutoConfig } from "../src/auto/config.ts";
import { autoStepCarrier, type AutoDependencies } from "../src/auto/extension.ts";
import { readRasenSnapshot, validateRasenChange, type RasenSnapshot } from "../src/auto/rasen.ts";
import { buildJevRequest, createJevProvider } from "../src/auto/decision.ts";
import type { Reviewer } from "../src/core.ts";
import { extensionFactory } from "../src/extension.ts";
import { withAgentDir } from "./isolated-host.ts";

import { supportsSymlinks } from "../test/fixtures/symlink-support.ts";
import { readWorkspaceEvidence } from "../src/auto/workspace.ts";

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

function workflow(complete = false): RasenWorkflow {
  const stages = [
    {
      id: "apply",
      skill: "rasen-apply-change",
      role: "apply",
      kind: "standard",
      requires: [],
      status: complete ? "done" : "pending",
    },
    {
      id: "verify",
      skill: "rasen-verify-change",
      role: "verify",
      kind: "standard",
      requires: ["apply"],
      status: complete ? "done" : "pending",
    },
    {
      id: "review-loop",
      skill: "rasen-review-cycle",
      role: "verify",
      kind: "standard",
      requires: ["verify"],
      status: "pending",
      loop: { kind: "review-cycle", maxRounds: 3 },
    },
    {
      id: "ship",
      skill: "rasen-ship",
      role: "ship",
      kind: "standard",
      requires: ["review-loop"],
      status: "pending",
    },
  ];
  return {
    kind: "present",
    change: "fixture-change",
    pipeline: "small-feature",
    runStateDir: "/fixture/auto-run",
    stages,
    completed: complete ? ["apply", "verify"] : [],
    remaining: complete ? ["review-loop", "ship"] : ["apply", "verify", "review-loop", "ship"],
    ready: [complete ? "review-loop" : "apply"],
    next: complete ? "review-loop" : "apply",
    inProgressStages: [],
    escalatedStages: [],
    openFindings: [],
    rounds: 0,
    fingerprint: `workflow-${complete}`,
  } as RasenWorkflow;
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
    prepare?: (cwd: string, agentDir: string) => Promise<void>;
  } = {},
) {
  const cwd = await project(config, overrides.minReviews, overrides.maxReviews);
  const agentDir = path.join(cwd, ".test-host-profile", "agent");
  await overrides.prepare?.(cwd, agentDir);
  const runtime = new ExtensionRuntime();
  const messages: Array<{ customType: string; content: unknown }> = [];
  const bootstraps: string[] = [];
  const deliveries: Array<Record<string, unknown>> = [];
  let reads = 0;
  let completed = 0;
  let decisions = 0;
  let aborts = 0;
  runtime.sendMessage = (...args: unknown[]) => {
    const message = args[0] as { customType: string; content: unknown };
    if (message.customType === "omp-auto-run") {
      expect(args[1]).toEqual({ triggerTurn: true, deliverAs: "nextTurn" });
      deliveries.push({ ...message, role: "custom", timestamp: Date.now() });
      bootstraps.push(String(message.content));
    } else messages.push(message);
  };
  runtime.sendUserMessage = () => {
    throw new Error("Auto must never fabricate a user message");
  };
  const nativeManager = new AsyncJobManager({});
  const nativeRegistry = new AgentRegistry();
  const nativeSession = {
    asyncJobManager: nativeManager,
    getAgentId: () => "main",
  } as AgentSession;
  const factory = extensionFactory(() => overrides.reviewer ?? (async () => approved), {
    snapshot: async () => {
      reads++;
      return snapshot(completed);
    },
    workflow: async () => workflow(true),
    validate: async () => {},
    decision: () => async () => {
      decisions++;
      return { choice: "continue", confidence: 0.99 };
    },
    fallback: () => async () => {
      throw new Error("Unexpected fallback");
    },
    nativeHost: () => ({ session: nativeSession, registry: nativeRegistry }),
    ...overrides.dependencies,
  });
  const extension = await loadExtensionFromFactory(
    withAgentDir(factory, agentDir),
    cwd,
    new EventBus(),
    runtime,
  );
  const sessionManager = SessionManager.create(cwd, path.join(cwd, ".test-sessions"));
  Object.defineProperty(nativeSession, "sessionId", { get: () => sessionManager.getSessionId() });
  const ctx = {
    cwd,
    sessionManager,
    modelRegistry: overrides.modelRegistry,
    agent: { kind: "main", id: "main", name: "main", depth: 0 },
    hasUI: true,
    isIdle: () => true,
    ui: { notify() {}, custom: async <T>() => true as T },
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
  const step = async (summary = "Recorded pipeline stage frontier", transition?: "triage") => {
    const result = await extension.tools
      .get("auto_step")!
      .definition.execute(
        "step",
        { summary, ...(transition ? { transition } : {}) },
        undefined,
        undefined,
        ctx,
      );
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Missing stage advice");
    return { ...JSON.parse(content.text), isError: !!result.isError };
  };
  const verify = async () => {
    // This loader fixture deliberately delivers lifecycle events. The real
    // AgentSession cases below exercise actual native reviewer workers instead.
    expect(await step("Observe the completed loader-fixture task set")).toMatchObject({
      allowedNextPhase: "verify",
      isError: false,
    });
    const toolCallId = `fixture-reviewer-${crypto.randomUUID()}`;
    const input = {
      agent: "omp-reviewer",
      task: "Independently inspect the current fixture",
      solutionSpace: "Read-only fixture verification",
    };
    for (const handler of extension.handlers.get("tool_call") ?? [])
      expect(
        await handler({ type: "tool_call", toolName: "task", toolCallId, input }, ctx),
      ).toBeUndefined();
    const details = {
      results: [
        {
          id: toolCallId,
          agent: "omp-reviewer",
          exitCode: 0,
          aborted: false,
          output:
            "Inspected current loader-fixture implementation and task evidence; no blocking findings",
        },
      ],
    };
    for (const handler of extension.handlers.get("tool_result") ?? [])
      await handler(
        {
          type: "tool_result",
          toolName: "task",
          toolCallId,
          input,
          content: [{ type: "text", text: "Independent fixture verification complete" }],
          details,
          isError: false,
        },
        ctx,
      );
    expect(await step("Record the settled independent loader-fixture receipt")).toMatchObject({
      allowedNextPhase: "review",
      isError: false,
    });
  };
  return {
    cwd,
    extension,
    ctx,
    runtime,
    nativeManager,
    async evidence(content: string): Promise<string> {
      const id = await sessionManager.saveArtifact(content, "architect-review");
      if (!id) throw new Error("Fixture review artifact was not saved");
      return `artifact://${id}`;
    },
    messages,
    bootstraps,
    complete() {
      completed = 2;
    },
    setProgress(value: number) {
      completed = value;
    },
    step,
    verify,
    deliveries,
    async checkpoint(signal?: AbortSignal) {
      const id = await sessionManager.saveArtifact(
        "Full implementation, verification findings, and test evidence",
        "architect-review",
      );
      return extension.tools
        .get("architect_checkpoint")!
        .definition.execute(
          `checkpoint-${crypto.randomUUID()}`,
          { phase: "completion", evidenceRef: `artifact://${id}` },
          signal,
          undefined,
          ctx,
        );
    },
    status,
    start,
    stop,
    counts: () => ({ reads, decisions, aborts }),
    async close() {
      await extension.handlers.get("session_shutdown")![0]({ type: "session_shutdown" }, ctx);
      nativeManager.dispose();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

for (const stage of ["confirmation", "change snapshot", "workflow", "artifact storage"] as const) {
  test(`preflight ${stage} failures identify the boundary without leaking host error text`, async () => {
    const fail = async () => {
      throw Object.assign(new Error("PRIVATE HOST TOKEN"), { code: "EACCES" });
    };
    const fixture = await loaderFixture(
      {},
      {
        dependencies: {
          ...(stage === "change snapshot" ? { snapshot: fail } : {}),
          ...(stage === "workflow" ? { workflow: fail } : {}),
        },
      },
    );
    const notifications: string[] = [];
    fixture.ctx.ui.notify = (message) => notifications.push(message);
    if (stage === "confirmation") fixture.ctx.ui.custom = fail;
    if (stage === "artifact storage") fixture.ctx.sessionManager.saveArtifact = fail;
    try {
      await fixture.extension.commands.get("auto")!.handler("start fixture-change", fixture.ctx);
      expect(notifications.join(" ")).toContain(`[${stage}]`);
      expect(notifications.join(" ")).toContain("EACCES");
      expect(notifications.join(" ")).not.toContain("PRIVATE HOST TOKEN");
      expect(fixture.bootstraps).toHaveLength(0);
      expect((await fixture.status()).status).toBe("idle");
    } finally {
      await fixture.close();
    }
  });
}

test("real loader admits extension-owned Auto without any installed rasen-auto skill", async () => {
  const fixture = await loaderFixture();
  try {
    await expect(fs.lstat(path.join(fixture.cwd, ".omp/skills/rasen-auto"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fixture.start();
    expect(await fixture.status()).toMatchObject({ status: "running" });
    expect(fixture.bootstraps).toHaveLength(1);
    expect(fixture.bootstraps[0]).not.toContain("installed rasen-auto workflow");
    expect(fixture.bootstraps[0]).toContain("fixture-change");
  } finally {
    await fixture.close();
  }
});

for (const queued of [false, true]) {
  test(`native delivery failure cancels admission and queued payload, queued=${queued}`, async () => {
    const fixture = await loaderFixture();
    const send = fixture.runtime.sendMessage;
    const notifications: string[] = [];
    fixture.ctx.ui.notify = (message) => notifications.push(message);
    fixture.runtime.sendMessage = (...args) => {
      if (queued) send(...args);
      throw new Error("PRIVATE DELIVERY ERROR");
    };
    try {
      await fixture.extension.commands.get("auto")!.handler("start fixture-change", fixture.ctx);
      expect(notifications.join(" ")).toContain("[native delivery]");
      expect(notifications.join(" ")).not.toContain("PRIVATE DELIVERY ERROR");
      expect((await fixture.status()).status).toBe("cancelled");
      if (queued) {
        const result = await fixture.extension.handlers.get("context")![0](
          { type: "context", messages: fixture.deliveries },
          fixture.ctx,
        );
        expect(result).toEqual({ messages: [] });
        // Leave the transport broken while any asynchronous status callback settles.
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      fixture.runtime.sendMessage = send;
      fixture.bootstraps.length = 0;
      await fixture.start();
      expect((await fixture.status()).status).toBe("running");
    } finally {
      fixture.runtime.sendMessage = send;
      await fixture.close();
    }
  });
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
        custom: async <T>() => {
          confirms++;
          return (mode !== "declined") as T;
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

test("real loader uses host profile defaults with selective project overrides", async () => {
  const fixture = await loaderFixture(
    { noOutputTimeoutMs: 240000, maxSteps: null },
    {
      prepare: async (_cwd, agentDir) => {
        await Bun.write(
          path.join(agentDir, "auto.json"),
          JSON.stringify({ maxDurationMs: 7200000, noOutputTimeoutMs: 300000, maxSteps: 12 }),
        );
      },
    },
  );
  try {
    expect(fixture.bootstraps).toEqual([]);
    expect(await fixture.status()).toMatchObject({ status: "idle", enabled: true, error: null });
    await fixture.start();
    expect(await fixture.status()).toMatchObject({
      status: "running",
      supervision: { maxDurationMs: 7200000, noOutputTimeoutMs: 240000 },
      steps: "1",
    });
  } finally {
    await fixture.close();
  }
});

for (const mode of ["disabled", "invalid", "overridden"] as const) {
  test(`real loader ${mode} global config preserves consent and disabled-state checks`, async () => {
    let globalFile = "";
    const fixture = await loaderFixture(mode === "overridden" ? { enabled: true } : {}, {
      prepare: async (_cwd, agentDir) => {
        globalFile = path.join(agentDir, "auto.json");
        await Bun.write(globalFile, mode === "invalid" ? "{" : '{"enabled":false}');
      },
    });
    let confirms = 0;
    const notifications: string[] = [];
    const ctx = {
      ...fixture.ctx,
      ui: {
        ...fixture.ctx.ui,
        notify: (message: string) => notifications.push(message),
        custom: async <T>() => {
          confirms++;
          return true as T;
        },
      },
    };
    try {
      expect(await fixture.status()).toMatchObject({
        status: "idle",
        enabled: mode === "overridden",
      });
      expect(fixture.bootstraps).toEqual([]);
      await fixture.extension.commands.get("auto")!.handler("start fixture-change", ctx);
      expect(confirms).toBe(mode === "overridden" ? 1 : 0);
      expect(fixture.bootstraps).toHaveLength(mode === "overridden" ? 1 : 0);
      expect(fixture.counts().reads).toBe(mode === "overridden" ? 1 : 0);
      if (mode === "invalid") {
        expect((await fixture.status()).error).toContain(globalFile);
        expect(notifications[0]).toContain(globalFile);
      }
      if (mode === "disabled") expect(notifications[0]).toContain("explicitly disabled");
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
      custom: async <T>() => {
        confirms++;
        return true as T;
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
        custom: async <T>() => {
          confirms++;
          return deferred.promise as Promise<T>;
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
      minReviews: 2,
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
        custom: async <T>() => {
          await Bun.write(path.join(fixture.cwd, ".omp/brief/example/_shared.md"), "MUTATED");
          return true as T;
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
    fixture.complete();
    await fixture.verify();
    const next = (await fixture.stop()) as { additionalContext: string };
    expect(next.additionalContext).toContain("Frozen fixture-change");
    expect(next.additionalContext).toContain("Preserve me");
    await fixture.extension.commands
      .get("auto")!
      .handler("start fixture-change Replace me", fixture.ctx);
    expect(fixture.bootstraps).toHaveLength(1);
    expect((await fixture.status()).steps).toBe("2");
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
      const fixture = await loaderFixture({}, { minReviews: 2 });
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
          fixture.complete();
          await fixture.verify();
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
      "async.enabled": false,
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
    const continuation = await fixture.step();
    expect(continuation).toMatchObject({ choice: "continue", isError: false });
    expect(await fixture.step("same frontier, different prose")).toMatchObject({
      choice: "continue",
      cached: true,
    });
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
    expect((await fixture.step()).isError).toBe(true);
    const status = await fixture.status();
    expect(status).toMatchObject({
      status: "uncertain",
      decisions: 1,
      completionVerified: false,
    });
    expect((await fixture.step()).isError).toBe(true);
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
    expect((await fixture.step()).isError).toBe(true);
    const status = await fixture.status();
    expect(status).toMatchObject({
      status: "uncertain",
      decisions: 1,
      completionVerified: false,
    });
    expect(resolvedKeys).toEqual([loginFixtureKey]);
    expect((await fixture.step()).isError).toBe(true);
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
  const fixture = await loaderFixture({ maxSteps: 1 }, { minReviews: 2 });
  try {
    await fixture.start();
    fixture.complete();
    await fixture.verify();
    expect(await fixture.stop()).toBeUndefined();
    expect(await fixture.status()).toMatchObject({
      status: "budget_exhausted",
      steps: "1/1",
      completionVerified: false,
    });
    expect(fixture.counts()).toMatchObject({ decisions: 2, aborts: 0 });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.counts()).toMatchObject({ decisions: 2, aborts: 0 });
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
    expect(fixture.counts()).toMatchObject({ decisions: 0, aborts: 1 });
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
    expect(fixture.counts()).toMatchObject({ decisions: 0, aborts: 0 });
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
    expect(await fixture.status()).toMatchObject({ status: "running", steps: "1" });
    expect(fixture.counts()).toMatchObject({ decisions: 0, aborts: 0 });
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
      fixture.ctx.ui.custom = async <T>() => {
        if (boundary === "confirmation") {
          entered.resolve();
          await release.promise;
        }
        return true as T;
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
  test(`real loader completion checkpoint requires fresh strict validation ${valid ? "passes" : "fails"}`, async () => {
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
      await fixture.verify();
      const explicit = await fixture.extension.tools
        .get("architect_checkpoint")!
        .definition.execute(
          "completion",
          {
            phase: "completion",
            evidenceRef: await fixture.evidence("Claimed done before CLI validation"),
          },
          undefined,
          undefined,
          fixture.ctx,
        );
      expect(explicit.isError).toBe(!valid);
      expect(validations).toBe(1);
      expect(reviews).toBe(valid ? 1 : 0);
      await fixture.stop();
      expect(validations).toBe(2);
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

test("Auto step Eval carriers require one reset-safe literal call and reject batching", () => {
  const input = {
    path: "xd://auto_step",
    content: JSON.stringify({ summary: "Inspect the current allowed host phase" }),
  };
  const literal = `await tool.write(${JSON.stringify(input)})`;
  expect(autoStepCarrier({ language: "js", reset: true, code: literal })).toBe(true);
  expect(autoStepCarrier({ language: "js", reset: true, code: `console.log(${literal});` })).toBe(
    true,
  );
  for (const candidate of [
    { language: "js", reset: false, code: literal },
    { language: "js", reset: true, async: true, code: literal },
    {
      language: "js",
      reset: true,
      code: `${literal}; await tool.write({"path":"fixture.ts","content":"changed"})`,
    },
    {
      language: "js",
      reset: true,
      code: `const args = ${JSON.stringify(input)}; await tool.write(args)`,
    },
    {
      language: "js",
      reset: true,
      code: `await tool.write(${JSON.stringify({ ...input, extra: true })})`,
    },
  ])
    expect(autoStepCarrier(candidate)).toBe(false);
});

for (const phase of ["unadmitted", "apply", "verify", "review", "triage", "fix"] as const) {
  test(`Main mutations obey the extension-owned ${phase} phase boundary`, async () => {
    const fixture = await loaderFixture(
      {},
      {
        reviewer: async () => ({
          decision: "revise",
          summary: "A scoped correction is needed",
          issues: ["Repair the fixture output"],
        }),
      },
    );
    try {
      await fixture.start();
      if (phase !== "unadmitted") await fixture.step();
      if (["verify", "review", "triage", "fix"].includes(phase)) {
        fixture.complete();
        if (phase === "verify") await fixture.step();
        else await fixture.verify();
      }
      if (phase === "triage" || phase === "fix") {
        expect((await fixture.checkpoint()).isError).toBe(true);
        expect(await fixture.status()).toMatchObject({ hostWorkflow: { phase: "triage" } });
      }
      if (phase === "fix")
        expect(await fixture.step("Triage the recorded scoped finding", "triage")).toMatchObject({
          allowedNextPhase: "fix",
        });
      for (const [toolName, input] of [
        ["write", { path: "fixture.ts", content: "changed" }],
        ["edit", { path: "fixture.ts", oldText: "old", newText: "new" }],
        ["bash", { command: "printf changed > fixture.ts" }],
      ] as const) {
        const admission = await fixture.extension.handlers.get("tool_call")![0](
          { type: "tool_call", toolName, input, toolCallId: `${phase}-${toolName}` },
          fixture.ctx,
        );
        if (phase === "apply" || phase === "fix") expect(admission).toBeUndefined();
        else expect(admission).toMatchObject({ block: true });
      }
      for (const [toolName, input] of [
        ["write", { path: "agent://finished-leaf", content: "Resume untracked work" }],
        ["send", { agent: "finished-leaf", message: "Resume untracked work" }],
        ["irc", { target: "finished-leaf", message: "Resume untracked work" }],
      ] as const)
        expect(
          await fixture.extension.handlers.get("tool_call")![0](
            { type: "tool_call", toolName, input, toolCallId: `${phase}-revive-${toolName}` },
            fixture.ctx,
          ),
        ).toMatchObject({ block: true });
      expect(await fixture.status()).toMatchObject({
        status: "running",
        completionVerified: false,
      });
    } finally {
      await fixture.close();
    }
  });
}

test("parallel reviewer receipts stay bound to their admitted sequential verification stage", async () => {
  const observed = workflow(true);
  if (observed.kind !== "present") throw new Error("Expected workflow fixture");
  observed.stages.splice(2, 0, {
    id: "verify-extra",
    skill: "rasen-cso",
    kind: "standard",
    role: "verify",
    requires: ["verify"],
    status: "done",
  });
  observed.stages.find((stage) => stage.id === "review-loop")!.requires = ["verify-extra"];
  observed.completed.push("verify-extra");
  observed.fingerprint = "sequential-verify-fixture";
  const fixture = await loaderFixture(
    {},
    { dependencies: { snapshot: async () => snapshot(2), workflow: async () => observed } },
  );
  const input = {
    agent: "omp-reviewer",
    task: "Verify only the admitted stage",
    solutionSpace: "The current stage",
  };
  const dispatch = async (toolCallId: string) => {
    for (const handler of fixture.extension.handlers.get("tool_call") ?? [])
      expect(
        await handler({ type: "tool_call", toolName: "task", toolCallId, input }, fixture.ctx),
      ).toBeUndefined();
  };
  const receipt = async (toolCallId: string) => {
    for (const handler of fixture.extension.handlers.get("tool_result") ?? [])
      await handler(
        {
          type: "tool_result",
          toolName: "task",
          toolCallId,
          input,
          content: [],
          isError: false,
          details: {
            results: [
              {
                id: toolCallId,
                agent: "omp-reviewer",
                exitCode: 0,
                aborted: false,
                output: "Finished the admitted stage's independent verification",
              },
            ],
          },
        },
        fixture.ctx,
      );
  };
  try {
    await fixture.start();
    expect(await fixture.step()).toMatchObject({
      hostWorkflow: { phase: "verify", stage: "verify" },
    });
    await dispatch("first-check-a");
    await dispatch("first-check-b");
    await receipt("first-check-a");
    await receipt("first-check-b");
    expect(await fixture.step()).toMatchObject({
      hostWorkflow: { phase: "verify", stage: "verify-extra", verifiedStages: ["verify"] },
    });
    expect((await fixture.checkpoint()).isError).toBe(true);
    await dispatch("second-check");
    await receipt("second-check");
    expect(await fixture.step()).toMatchObject({
      hostWorkflow: {
        phase: "review",
        readyForReview: true,
        verifiedStages: ["verify", "verify-extra"],
      },
    });
  } finally {
    await fixture.close();
  }
});

test("uncharged oversized enriched completion evidence can be corrected within the same host review phase", async () => {
  let reviews = 0;
  const fixture = await loaderFixture(
    {},
    {
      prepare: async (cwd) => {
        await Bun.write(
          path.join(cwd, ".omp/architect.json"),
          JSON.stringify({ maxReviewBytes: 8192, reviews: { min: 1, max: 2 } }),
        );
      },
      reviewer: async () => {
        reviews++;
        return approved;
      },
    },
  );
  try {
    await fixture.start();
    fixture.complete();
    await fixture.verify();
    const rejected = await fixture.extension.tools
      .get("architect_checkpoint")!
      .definition.execute(
        "oversized-enriched",
        { phase: "completion", evidenceRef: await fixture.evidence("F".repeat(7000)) },
        undefined,
        undefined,
        fixture.ctx,
      );
    expect(rejected.isError).toBe(true);
    expect(reviews).toBe(0);
    expect(await fixture.status()).toMatchObject({
      status: "running",
      hostWorkflow: { phase: "review", readyForReview: true },
      architect: {
        attempts: { completion: 0 },
        lastReview: { status: "input_rejected", charged: false },
      },
    });
    expect((await fixture.checkpoint()).isError).toBe(false);
    await fixture.stop();
    expect(await fixture.status()).toMatchObject({ status: "completed", completionVerified: true });
    expect(reviews).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("external completion flags and model claims cannot replace a native verification receipt", async () => {
  let reviews = 0;
  const fixture = await loaderFixture(
    {},
    {
      dependencies: { snapshot: async () => snapshot(2), workflow: async () => workflow(true) },
      reviewer: async () => {
        reviews++;
        return approved;
      },
    },
  );
  try {
    await fixture.start();
    expect(await fixture.step("All verification passed according to the assistant")).toMatchObject({
      allowedNextPhase: "verify",
      hostWorkflow: { readyForReview: false, verifiedStages: [] },
    });
    const result = await fixture.checkpoint();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("independent verification");
    expect(reviews).toBe(0);
    expect(await fixture.status()).toMatchObject({
      completionVerified: false,
      architect: { completionApproved: false },
    });
  } finally {
    await fixture.close();
  }
});

test("Auto stage fallback uses the Architect review deadline beyond the old 27s boundary", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ choice: "continue"; confidence: number }>();
  let fallbackSignal: AbortSignal | undefined;
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        decision: () => async () => ({ choice: "continue", confidence: 0.58 }),
        fallback: () => async (_evidence, signal) => {
          fallbackSignal = signal;
          started.resolve();
          return response.promise;
        },
      },
    },
  );
  let pending: ReturnType<typeof f.step> | undefined;
  try {
    await f.start();
    jest.useFakeTimers();
    pending = f.step();
    await started.promise;
    jest.advanceTimersByTime(40000);
    await Promise.resolve();
    expect(fallbackSignal?.aborted).toBe(false);
    response.resolve({ choice: "continue", confidence: 0.95 });
    expect(await pending).toMatchObject({ choice: "continue", isError: false });
    expect(await f.status()).toMatchObject({
      status: "running",
      completionVerified: false,
      fallbacks: "1/2",
      decisionDiagnostics: {
        attempts: [
          { provider: "jev", confidence: 0.58, timeoutMs: 8000 },
          { provider: "architect", outcome: "accepted", timeoutMs: 120000 },
        ],
      },
    });
  } finally {
    response.resolve({ choice: "continue", confidence: 0.95 });
    jest.useRealTimers();
    await pending;
    await f.close();
  }
});

test("Auto checkpoint review keeps the normal Architect timeout beyond the 24s stop-hook window", async () => {
  const started = Promise.withResolvers<void>();
  const cancel = new AbortController();
  let reviewSignal: AbortSignal | undefined;
  let reviews = 0;
  const f = await loaderFixture(
    {},
    {
      dependencies: { snapshot: async () => snapshot(2), validate: async () => {} },
      reviewer: async (_request, signal) => {
        reviews++;
        reviewSignal = signal;
        started.resolve();
        return new Promise((_resolve, reject) => {
          const abort = () => reject(signal.reason ?? new Error("Canceled fixture review"));
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      },
    },
  );
  let pending: ReturnType<typeof f.checkpoint> | undefined;
  try {
    await f.start();
    await f.verify();
    jest.useFakeTimers();
    let settled = false;
    pending = f.checkpoint(cancel.signal);
    void pending.then(() => {
      settled = true;
    });
    await started.promise;
    jest.advanceTimersByTime(24001);
    await Promise.resolve();
    expect(reviewSignal?.aborted).toBe(false);
    expect(settled).toBe(false);
    expect(reviews).toBe(1);
    cancel.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(reviewSignal?.aborted).toBe(true);
    expect(await f.status()).toMatchObject({
      completionVerified: false,
      architect: { completionApproved: false },
    });
  } finally {
    cancel.abort();
    jest.useRealTimers();
    await pending?.catch(() => {});
    await f.close();
  }
});

test("real loader blocks unregistered spawning while preserving native async tool paths during Auto", async () => {
  const fixture = await loaderFixture();
  try {
    await fixture.start();
    await fixture.step();
    expect(
      await fixture.extension.handlers.get("before_subagent_spawn")![0](
        {
          type: "before_subagent_spawn",
          agent: "unregistered-worker",
          task: "Delegate implementation",
        },
        fixture.ctx,
      ),
    ).toMatchObject({ block: true });
    for (const [toolName, input] of [
      ["task", { task: "Detached work in a child", async: true }],
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
      ).toBeUndefined();
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
    expect(await fixture.status()).toMatchObject({ status: "running", steps: "1" });
    await fixture.extension.handlers.get("turn_start")![0](
      { type: "turn_start", turnIndex: 0, timestamp: Date.now() },
      fixture.ctx,
    );
    await fixture.extension.handlers.get("before_agent_start")![0](event, fixture.ctx);
    expect(await fixture.status()).toMatchObject({ status: "cancelled", steps: "1" });
    expect(fixture.counts()).toMatchObject({ decisions: 0, aborts: 1 });
  } finally {
    await fixture.close();
  }
});

for (const interrupt of ["status", "unexpected-hidden", "new-user"] as const) {
  test(`real loader ${interrupt} preserves the correct continuation ownership`, async () => {
    const fixture = await loaderFixture({}, { minReviews: 3 });
    try {
      await fixture.start();
      fixture.complete();
      await fixture.verify();
      const continuation = (await fixture.stop()) as {
        continue: boolean;
        additionalContext: string;
      };
      expect(continuation.continue).toBe(true);
      expect(await fixture.status()).toMatchObject({ status: "running", steps: "2" });
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
        expect(await fixture.status()).toMatchObject({ status: "running", steps: "2" });
        expect(await fixture.stop()).toMatchObject({ continue: true });
        expect(await fixture.status()).toMatchObject({ status: "running", steps: "3" });
        expect(fixture.counts().decisions).toBe(2);
      } else {
        expect(await fixture.status()).toMatchObject({ status: "cancelled", steps: "2" });
        expect(fixture.counts().decisions).toBe(2);
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
  test(`real OMP session ${mode === "cancel-delivery" ? "rejects cancelled queued delivery before model inference" : mode === "max-cap" ? "enforces an explicit one-turn cap without terminal retry" : `completes ${mode} with two architect reviews`}`, async () => {
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
            ...(mode === "max-cap" ? { maxSteps: 1 } : {}),
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
    const implementationPath = path.join(cwd, "fixture-output.txt");
    const taskCount = mode === "real-cli" ? 15 : 2;
    const tasks = (complete: number) =>
      `## 1. Local integration fixture\n\n${Array.from(
        { length: taskCount },
        (_, index) =>
          `- [${complete > index ? "x" : " "}] 1.${index + 1} Mark fixture unit ${index + 1}\n`,
      ).join("")}`;
    let workflowPath = "";
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
            XDG_DATA_HOME: path.join(cwd, "isolated-data"),
            XDG_STATE_HOME: path.join(cwd, "isolated-state"),
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
      // Install only the generated apply skill. rasen-auto is never installed.
      cli(["config", "set", "profile", "custom"]);
      cli(["config", "set", "workflows", '["apply"]']);
      cli(["init", "--tools", "omp", "--profile", "custom"]);
      await expect(fs.lstat(path.join(cwd, ".omp/skills/rasen-auto"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      cli(["new", "change", "fixture-change", "--schema", "spec-driven", "--json"]);
      await Bun.write(taskPath, tasks(0));
      await Promise.all(
        Array.from({ length: 85 }, (_, i) =>
          Bun.write(
            path.join(cwd, "fixture-sources", `${i}.txt`),
            `Fixture source ${i}: inspect this scoped module\n`,
          ),
        ),
      );
      const status = JSON.parse(cli(["status", "--change", "fixture-change", "--json"]));
      workflowPath = path.join(status.ephemeraDir, "auto-run.json");
      await expect(fs.lstat(workflowPath)).rejects.toMatchObject({ code: "ENOENT" });
      await Bun.write(
        path.join(path.dirname(taskPath), "specs", "fixture-progress", "spec.md"),
        "## ADDED Requirements\n\n### Requirement: Fixture progress\nThe fixture SHALL record the completion of its local units.\n\n#### Scenario: Unit completed\n- **WHEN** a local fixture unit finishes\n- **THEN** its task checkbox is checked\n",
      );
    }
    if (mode === "real-cli") {
      const initialized = spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" });
      expect(initialized.status).toBe(0);
      // Exercise the real default snapshot reader with the common tracked
      // CLAUDE.md -> AGENTS.md convention, not a mocked workspace snapshot.
      if (supportsSymlinks) {
        await fs.writeFile(path.join(cwd, "AGENTS.md"), "Local fixture instructions\n");
        await fs.symlink("AGENTS.md", path.join(cwd, "CLAUDE.md"), "file");
        expect(spawnSync("git", ["add", "AGENTS.md", "CLAUDE.md"], { cwd }).status).toBe(0);
      }
      await Bun.write(
        path.join(cwd, ".gitignore"),
        ".test-artifacts/\nisolated-agent/\nisolated-home/\nisolated-config/\nisolated-data/\nisolated-state/\n",
      );
    }
    const auth = await AuthStorage.create(":memory:");
    const provider = `auto-fixture-${crypto.randomUUID()}`;
    const api = `auto-api-${crypto.randomUUID()}`;
    const settings = Settings.isolated({
      "memory.backend": "off",
      "bash.autoBackground.enabled": false,
      "async.enabled": mode === "real-cli",
      // This fixture exercises in-process jobs, not the separate service broker.
      // The container forbids its native FileLock; do not change user settings.
      "launch.enabled": false,
      "tools.xdev": mode === "brief",
      "task.speculativeLaunch": false,
      "task.maxRuntimeMs": 30000,
      "task.agentIdleTtlMs": 1,
      modelRoles: Object.fromEntries(
        [
          "default",
          "implementation",
          "architect",
          "research",
          "task",
          "smol",
          "tiny",
          "title",
          "compaction",
        ].map((role) => [role, `${provider}/${role === "default" ? "main" : role}`]),
      ),
    });
    for (const agent of ["omp-worker", "omp-reviewer"])
      await Bun.write(
        path.join(cwd, ".omp/agents", `${agent}.md`),
        (await Bun.file(path.resolve(import.meta.dir, "../agents", `${agent}.md`)).text()).replace(
          "spawns: []",
          "spawns: []\nblocking: false",
        ),
      );
    const workerPrefix = `auto_${crypto.randomUUID().replaceAll("-", "")}`;
    const workerIds = ["apply", "verify", "fix", "delta"].map(
      (phase) => `${workerPrefix}_${phase}`,
    );
    const childStorage = new MemorySessionStorage();
    const originalOpen = SessionManager.open.bind(SessionManager);
    const open = spyOn(SessionManager, "open").mockImplementation(
      (file, directory, backend, options) =>
        originalOpen(
          file,
          directory,
          workerIds.some((id) => path.basename(file) === `${id}.jsonl`) ? childStorage : backend,
          options,
        ),
    );
    // Native child journals use the same supported in-memory test backend as
    // auto-native-worker.test.ts. Native tasks, tools and result receipts are real.
    const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
    auth.keys.setRuntime(provider, "fixture-not-a-secret");
    let requests = 0;
    let reads = 0;
    let validations = 0;
    let decisions = 0;
    let reviews = 0;
    const reviewEvidence: string[] = [];
    const reviewMaterials: string[] = [];
    let confirms = 0;
    let beforeStarts = 0;
    const stops: boolean[] = [];
    const errors: unknown[] = [];
    const sends: Promise<unknown>[] = [];
    const contexts: string[] = [];
    const prompts: string[] = [];
    const childTurns = new Map<string, number>();
    const nativeTaskResults: unknown[] = [];
    // Native consumed jobs are evicted after 30 seconds. Preserve receipts when
    // observed, rather than treating the live job cache as a durable journal.
    const nativeJobReceipts = new Map<
      string,
      { agentId?: string; type: string; status: string; resultText?: string }
    >();
    const captureNativeReceipts = () => {
      for (const job of session?.asyncJobManager?.getAllJobs() ?? []) {
        if (workerIds.includes(job.agentId ?? "") && job.status !== "running")
          nativeJobReceipts.set(job.id, {
            agentId: job.agentId,
            type: job.type,
            status: job.status,
            resultText: job.resultText,
          });
      }
    };
    const realCliSteps = [1, "reads", 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16] as const;
    let realCliCursor = 0;
    let scriptFailed = false;
    const executedRealCliSteps: Array<number | string> = [];
    const phaseResults: unknown[] = [];
    const decisionStates: Array<Record<string, unknown>> = [];
    const providerConfig: Parameters<ModelRegistry["registerProvider"]>[1] = {
      baseUrl: "https://unused.invalid",
      apiKey: "fixture-not-a-secret",
      api,
      streamSimple(model, context) {
        const child = context.tools?.some((tool) => tool.name === "yield");
        const main = model.id === "main";
        if (main) {
          requests++;
          contexts.push(JSON.stringify(context.messages));
        }
        const stream = createAssistantMessageEventStream();
        const calls: Array<{
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        }> = [];
        const call = (name: string, args: Record<string, unknown>) => {
          calls.push({
            type: "toolCall",
            id: `${name}-${crypto.randomUUID()}`,
            name,
            arguments: args,
          });
        };
        if (child) {
          const serialized = JSON.stringify(context.messages);
          const assignment = workerIds
            .filter((id) => serialized.includes(id))
            .sort((a, b) => serialized.lastIndexOf(b) - serialized.lastIndexOf(a))[0];
          if (!assignment)
            throw new Error("Native child did not receive its named fixture assignment");
          const turn = (childTurns.get(assignment) ?? 0) + 1;
          childTurns.set(assignment, turn);
          const applying = assignment.endsWith("_apply");
          const fixing = assignment.endsWith("_fix");
          if (turn === 1) {
            if (applying) {
              call("write", { path: taskPath, content: tasks(taskCount) });
              call("write", { path: implementationPath, content: "Scoped fixture output\n" });
            } else if (fixing)
              call("write", {
                path: implementationPath,
                content: "Scoped fixture output\nVerified footer\n",
              });
            else {
              call("read", { path: taskPath });
              call("read", { path: implementationPath });
            }
          } else {
            const report = `Native ${assignment}: ${applying ? "Completed the actual implementation and task-file update" : fixing ? "Added the requested footer" : "Read the actual implementation and completed task file"}`;
            call("yield", {
              data:
                mode === "real-cli" && !applying && !fixing
                  ? {
                      report,
                      // More lines than OMP's native 5000-line preview limit;
                      // the full retained artifact still fits Auto's 128 KiB bound.
                      checks: Array.from({ length: 6000 }, () => "ok"),
                      finalFinding: assignment.endsWith("_verify")
                        ? "LATE_NATIVE_FINDING: add the missing fixture footer"
                        : "LATE_NATIVE_DELTA: verified footer; no remaining blocking findings",
                    }
                  : report,
            });
          }
        } else if (main) {
          captureNativeReceipts();
          // Background settlement may take any number of wait calls. Advance
          // the deterministic model script by completed actions, never by a
          // transport request index or wall-clock-dependent wait count.
          const pendingNative = session?.asyncJobManager
            ?.getAllJobs()
            .some((job) => workerIds.includes(job.agentId ?? "") && job.status === "running");
          const step =
            mode === "real-cli"
              ? scriptFailed
                ? undefined
                : pendingNative
                  ? "wait"
                  : realCliSteps[realCliCursor++]
              : requests;
          if (mode === "real-cli" && step !== "wait" && step !== undefined)
            executedRealCliSteps.push(step);
          if (requests === 1)
            call("auto_step", { summary: "Initial extension-owned prepared-change frontier" });
          else if (step === "wait") call("wait", {});
          else if (step === "reads") {
            for (let i = 0; i < 85; i++)
              call("read", { path: path.join(cwd, "fixture-sources", `${i}.txt`) });
          } else {
            const assignment = (phase: number, agent: string) =>
              call("task", {
                name: workerIds[phase],
                agent,
                task: `${workerIds[phase]}: ${phase === 0 ? "Complete the scoped fixture tasks" : "Independently inspect the scoped completed tasks"}`,
                solutionSpace: "Only the fixture task file and one terminal native yield",
              });
            if (step === 2) assignment(0, "omp-worker");
            if (step === 3)
              call("auto_step", {
                summary: "Native implementation completed the actual fixture tasks",
              });
            if (step === 4) assignment(1, "omp-reviewer");
            if (step === 5)
              call("auto_step", {
                summary: "Independent native verification settled with its actual receipt",
              });
            if ((mode !== "max-cap" && step === 6) || (mode === "real-cli" && step === 13))
              call("write", {
                path: "local://architect-review/auto-result.md",
                content: `${step === 6 ? "Initial" : "Delta"} evidence: native implementation completed the scoped task file; an independent native reviewer read the completed tasks and reported no blocking findings. Downstream shipping is pending.`,
              });
            if (step === 7 || (mode === "real-cli" && step === 14))
              call("architect_checkpoint", {
                phase: "completion",
                evidenceRef: "local://architect-review/auto-result.md",
              });
            if (mode === "real-cli") {
              if (step === 8)
                call("auto_step", {
                  summary: "Triage the missing-footer review finding",
                  transition: "triage",
                });
              if (step === 9) assignment(2, "omp-worker");
              if (step === 10)
                call("auto_step", { summary: "Native fixer added the requested footer" });
              if (step === 11) assignment(3, "omp-reviewer");
              if (step === 12)
                call("auto_step", {
                  summary: "Independent delta verification settled with its actual receipt",
                });
              if (step === 15)
                call("auto_step", {
                  summary:
                    "Confirm the approved host settlement before returning the final summary",
                });
            } else {
              if (step === 8)
                call("auto_step", {
                  summary: "Proceed to the configured additional independent review round",
                });
              if (step === 9)
                call("architect_checkpoint", {
                  phase: "completion",
                  evidenceRef: "local://architect-review/auto-result.md",
                });
              if (step === 10) {
                const summary =
                  "Confirm the approved host settlement before returning the final summary";
                if (mode === "brief")
                  call("eval", {
                    language: "js",
                    reset: true,
                    code: `console.log(await tool.write(${JSON.stringify({ path: "xd://auto_step", content: JSON.stringify({ summary }) })}))`,
                    timeout: 20,
                  });
                else call("auto_step", { summary });
              }
            }
          }
        }
        const toolStep = calls.length > 0;
        const message: AssistantMessage = {
          role: "assistant",
          api,
          provider,
          model: model.id,
          content: toolStep
            ? calls
            : [{ type: "text", text: `Supervised workflow fixture response ${requests}` }],
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
        for (const [contentIndex, toolCall] of calls.entries()) {
          stream.push({ type: "toolcall_start", contentIndex, partial: message });
          stream.push({
            type: "toolcall_delta",
            contentIndex,
            delta: JSON.stringify(toolCall.arguments),
            partial: message,
          });
          stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
        }
        stream.push({ type: "done", reason: toolStep ? "toolUse" : "stop", message });
        stream.end();
        return stream;
      },
      models: [
        "main",
        "implementation",
        "architect",
        "research",
        "task",
        "smol",
        "tiny",
        "title",
        "compaction",
      ].map((name) => ({
        id: name,
        name: `Local Auto fixture ${name}`,
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 1024,
      })),
    };
    registry.registerProvider(provider, providerConfig, provider);
    const dependencies: AutoDependencies = {
      workflow:
        mode === "real-cli"
          ? async (...args) => {
              try {
                const value = await readRasenWorkflow(...args);
                if (value.kind === "invalid") errors.push(value);
                return value;
              } catch (error) {
                errors.push({ phase: "workflow", error: String(error) });
                throw error;
              }
            }
          : async () => workflow(requests >= 2),
      ...(mode !== "real-cli"
        ? {
            snapshot: async () => {
              reads++;
              return snapshot(requests >= 2 ? 2 : 0);
            },
          }
        : {}),
      validate: async (...args) => {
        validations++;
        try {
          if (mode === "real-cli") await validateRasenChange(...args);
        } catch (error) {
          errors.push({ phase: "validation", error: String(error) });
          throw error;
        }
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
                  const state = JSON.parse(String(init.body)).state;
                  expect(state.change).toBe("fixture-change");
                  expect(Number.isInteger(state.completed)).toBe(true);
                  expect(Number.isInteger(state.remaining)).toBe(true);
                  decisionStates.push(state);
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
    };
    // Keep the journal isolated in memory while native review artifacts remain readable on disk.
    const sessionManager = SessionManager.inMemory(cwd);
    sessionManager.adoptArtifactManager(new ArtifactManager(path.join(cwd, ".test-artifacts")));
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      const created = await createAgentSession({
        cwd,
        agentDir: path.join(cwd, "isolated-agent"),
        authStorage: auth,
        modelRegistry: registry,
        model: registry
          .getAvailable()
          .find((model) => model.provider === provider && model.id === "main"),
        settings,
        sessionManager,
        extensions: [
          (pi) => {
            if (mode === "cancel-delivery")
              pi.on("context", async () => {
                // Stop after native sendMessage dispatch, before Auto admits provider context.
                await session!
                  .extensionRunner!.getCommand("auto")!
                  .handler("stop", session!.extensionRunner!.createCommandContext());
              });
          },
          withAgentDir(
            extensionFactory(
              () => async (request) => {
                reviews++;
                reviewEvidence.push(request.evidence);
                reviewMaterials.push(request.material.content);
                return mode === "real-cli" && reviews === 1
                  ? {
                      decision: "revise",
                      summary: "Add the missing fixture footer",
                      issues: ["The output needs the verified footer before completion"],
                    }
                  : approved;
              },
              dependencies,
            ),
            path.join(cwd, "isolated-agent"),
          ),
          (pi) => {
            pi.registerProvider(provider, providerConfig);
            pi.on("before_agent_start", (event, ctx) => {
              if (ctx.agent.kind !== "main") return;
              beforeStarts++;
              prompts.push(event.prompt);
            });
            pi.on("session_stop", (event, ctx) => {
              if (ctx.agent.kind === "main") stops.push(event.stop_hook_active);
            });
            pi.on("tool_result", (event, ctx) => {
              if (ctx.agent.kind !== "main") return;
              captureNativeReceipts();
              if (mode === "real-cli" && event.isError) {
                const expectedRevision =
                  event.toolName === "architect_checkpoint" &&
                  reviews === 1 &&
                  (event.details as { review?: { charged?: boolean } })?.review?.charged === true;
                if (!expectedRevision) {
                  scriptFailed = true;
                  errors.push({
                    tool: event.toolName,
                    content: event.content,
                    details: event.details,
                  });
                }
              }
              if (event.toolName === "task") nativeTaskResults.push(event.details);
              if (event.toolName === "auto_step") phaseResults.push(event.content);
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
        spawns: "omp-worker,omp-reviewer",
        toolNames:
          mode === "real-cli"
            ? ["task", "wait", "read", "write"]
            : mode === "brief"
              ? ["task", "read", "write", "eval"]
              : ["task", "write"],
        autoApprove: true,
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
          custom: async <T>() => {
            confirms++;
            return true as T;
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
        expect(reads).toBeGreaterThanOrEqual(1);
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
      const delivered = session.agent.state.messages.filter(
        (message) => message.role === "custom" && message.customType === "omp-auto-run",
      );
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toMatchObject({
        role: "custom",
        display: false,
        attribution: "agent",
      });
      expect(session.agent.state.messages.filter((message) => message.role === "user")).toEqual([]);
      const firstContext = JSON.parse(contexts[0]);
      const payload = firstContext.find((message: { content: unknown }) =>
        JSON.stringify(message.content).includes("Auto run:"),
      );
      expect(payload.role).toBe("developer");
      expect(JSON.stringify(payload.content)).toContain("Register the exact approved todo steps");
      expect(JSON.stringify(payload.content)).not.toContain("installed rasen-auto workflow");
      expect(JSON.stringify(payload.content)).not.toContain(
        "Complete installed rasen-auto fixture body",
      );
      await expect(fs.lstat(path.join(cwd, ".omp/skills/rasen-auto"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const native = delivered[0];
      if (native.role !== "custom") throw new Error("Expected internal native message");
      const ref = (native.details as { ref: string }).ref;
      const saved = await Bun.file((await sessionManager.getArtifactPath(ref.slice(11)))!).text();
      expect(saved).toContain("Auto run:");
      expect(saved).not.toContain("installed rasen-auto workflow");
      expect(confirms).toBe(1);
      if (mode === "real-cli") expect(executedRealCliSteps).toEqual([...realCliSteps]);
      else expect(requests).toBe(mode === "max-cap" ? 6 : 11);
      if (mode !== "real-cli") expect(reads).toBeGreaterThanOrEqual(mode === "max-cap" ? 3 : 4);
      expect(decisions).toBe(mode === "max-cap" ? 3 : mode === "real-cli" ? 6 : 4);
      expect(validations).toBe(mode === "max-cap" ? 1 : 3);
      expect(reviews).toBe(mode === "max-cap" ? 0 : 2);
      expect(beforeStarts).toBe(0);
      expect(stops).toEqual([false]);
      if (mode === "brief") {
        const evalResults = session.agent.state.messages.filter(
          (message) => message.role === "toolResult" && message.toolName === "eval",
        );
        expect(evalResults).toHaveLength(1);
        expect(evalResults[0]).toMatchObject({ isError: false });
        expect(JSON.stringify(evalResults[0])).toContain("settled");
      }
      if (mode !== "max-cap")
        expect(contexts.at(-1)).toContain(
          mode === "real-cli"
            ? "Add the missing fixture footer"
            : "Minimum independent review rounds not yet met",
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
        steps: mode === "max-cap" ? "1/1" : "1",
        completionVerified: mode !== "max-cap",
        hostWorkflow: { phase: mode === "max-cap" ? "review" : "settled" },
      });
      const phases = phaseResults.map((content) => {
        const text = (content as Array<{ type: string; text?: string }>).find(
          (part) => part.type === "text",
        );
        return JSON.parse(text!.text!).hostWorkflow.phase;
      });
      expect(phases).toEqual(
        mode === "max-cap"
          ? ["apply", "verify", "review"]
          : mode === "real-cli"
            ? ["apply", "verify", "review", "fix", "verify", "delta-review", "settled"]
            : ["apply", "verify", "review", "delta-review", "settled"],
      );
      if (mode === "real-cli") {
        expect(await Bun.file(taskPath).text()).toBe(tasks(15));
        expect((await readRasenSnapshot(cwd, "fixture-change", { executable })).progress).toEqual({
          total: 15,
          complete: 15,
          remaining: 0,
        });
        expect((await readRasenWorkflow(cwd, "fixture-change", { executable })).kind).toBe(
          "absent",
        );
        await expect(fs.lstat(workflowPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(nativeTaskResults).toHaveLength(4);
        captureNativeReceipts();
        const nativeJobs = [...nativeJobReceipts.values()];
        expect(nativeJobs).toHaveLength(4);
        expect(nativeJobs.map((job) => job.agentId).sort()).toEqual([...workerIds].sort());
        expect(nativeJobs.every((job) => job.type === "task" && job.status === "completed")).toBe(
          true,
        );
        expect(childTurns.size).toBe(4);
        expect(reviewMaterials[0]).toContain("LATE_NATIVE_FINDING: add the missing fixture footer");
        expect(reviewMaterials[1]).toContain(
          "LATE_NATIVE_DELTA: verified footer; no remaining blocking findings",
        );
        const verificationJobs = nativeJobs.filter(
          (job) => job.agentId?.endsWith("_verify") || job.agentId?.endsWith("_delta"),
        );
        expect(verificationJobs).toHaveLength(2);
        for (const job of verificationJobs) expect(job.resultText).not.toContain("LATE_NATIVE_");
        expect(
          decisionStates.map((state) => JSON.parse(String(state.summary)).allowedPhase),
        ).toEqual(phases.slice(0, -1));
        expect(JSON.parse(result.content[0].text)).toMatchObject({
          hostWorkflow: { source: "builtin", phase: "settled", verifiedStages: ["verify"] },
          workflow: { kind: "absent" },
        });
        expect(await Bun.file(implementationPath).text()).toBe(
          "Scoped fixture output\nVerified footer\n",
        );
        for (const evidence of reviewEvidence) {
          expect(evidence).toContain("Mark fixture unit 1");
          expect(evidence).toContain("Mark fixture unit 15");
          expect(evidence).toContain("Strict CLI artifact validation passed");
        }
        expect(Number(JSON.parse(result.content[0].text).toolCalls)).toBeGreaterThan(80);
        if (supportsSymlinks) {
          const before = await readWorkspaceEvidence(cwd);
          await fs.writeFile(path.join(cwd, "AGENTS.md"), "Changed fixture instructions\n");
          expect((await readWorkspaceEvidence(cwd)).fingerprint).not.toBe(before.fingerprint);
          const refreshed = await tool.execute(
            "status-after-link-target-edit",
            {},
            undefined,
            undefined,
            session.extensionRunner!.createContext(),
          );
          if (refreshed.content[0].type !== "text") throw new Error("Missing refreshed status");
          expect(JSON.parse(refreshed.content[0].text)).toMatchObject({
            status: "completed",
            completionVerified: false,
          });
        }
        const readResults = session.agent.state.messages.filter(
          (message) => message.role === "toolResult" && message.toolName === "read",
        );
        expect(readResults).toHaveLength(85);
        // Preparation, 85 reads, implementation and both completion checkpoints
        // stayed in the same LEAD turn, with no tool-count forced stop.
        expect(stops).toEqual([false]);
        const failures = session.agent.state.messages.filter(
          (message) => message.role === "toolResult" && message.isError,
        );
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatchObject({
          toolName: "architect_checkpoint",
          details: { decision: "revise", review: { charged: true, attempt: 1 } },
        });
        expect(JSON.stringify(failures[0])).toContain("Add the missing fixture footer");
      }
    } finally {
      await session?.dispose();
      for (const id of workerIds) {
        const child = AgentRegistry.global().get(id);
        await child?.session?.dispose();
        AgentRegistry.global().unregister(id);
      }
      open.mockRestore();
      registry.clearSourceRegistrations(provider);
      auth.close();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }, 60000);
}

test.each([
  "blocked",
  "plan",
  "recovery",
] as const)("Auto respects terminal architect %s before additional boundary work", async (phase) => {
  let reviews = 0;
  const f = await loaderFixture(
    {},
    {
      maxReviews: 1,
      reviewer: async () => {
        reviews++;
        return {
          decision: "blocked",
          summary: "Unresolved fixture blocker",
          issues: ["Need operator input"],
        };
      },
    },
  );
  try {
    await f.start();
    const tool = f.extension.tools.get("architect_checkpoint")!.definition;
    const result = await tool.execute(
      "terminal",
      {
        phase,
        evidenceRef: await f.evidence("Operator decision required"),
        ...(phase === "plan" ? { steps: ["Inspect", "Implement", "Verify"] } : {}),
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(result.isError).toBe(true);
    expect(await f.status()).toMatchObject({
      status: "blocked",
      architect: { completionApproved: false },
    });
    expect(await f.stop()).toBeUndefined();
    expect(await f.stop()).toBeUndefined();
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 1 });
    expect(reviews).toBe(phase === "blocked" ? 0 : 1);
    const messages = f.messages.length;
    const gate = f.extension.handlers.get("tool_call")![0];
    for (const event of [
      { toolName: "auto_status", input: {} },
      { toolName: "write", input: { path: "xd://auto_status", content: "{}" } },
    ])
      expect(
        await gate({ type: "tool_call", toolCallId: crypto.randomUUID(), ...event }, f.ctx),
      ).toBeUndefined();
    expect(
      await gate(
        {
          type: "tool_call",
          toolCallId: "blocked-file",
          toolName: "write",
          input: { path: "proposal.md", content: "x" },
        },
        f.ctx,
      ),
    ).toMatchObject({ block: true });
    expect(f.messages).toHaveLength(messages);
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 1 });
  } finally {
    await f.close();
  }
});

test("Auto cancelled final recovery attempt stops without CLI or decision retry", async () => {
  const c = new AbortController();
  const f = await loaderFixture(
    {},
    {
      maxReviews: 1,
      reviewer: async () => {
        queueMicrotask(() => c.abort());
        return new Promise(() => {});
      },
    },
  );
  try {
    await f.start();
    await f.extension.tools
      .get("architect_checkpoint")!
      .definition.execute(
        "cancelled",
        { phase: "recovery", evidenceRef: await f.evidence("Attempt recovery") },
        c.signal,
        undefined,
        f.ctx,
      );
    expect(await f.status()).toMatchObject({ status: "blocked" });
    expect(await f.stop()).toBeUndefined();
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 1 });
  } finally {
    await f.close();
  }
});

test("explicitly confirmed Auto restart can begin after a terminal architect stop", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    await f.extension.tools
      .get("architect_checkpoint")!
      .definition.execute(
        "stop",
        { phase: "blocked", evidenceRef: await f.evidence("Old run needs a decision") },
        undefined,
        undefined,
        f.ctx,
      );
    await f.extension.commands.get("auto")!.handler("start fixture-change", f.ctx);
    expect(f.bootstraps).toHaveLength(2);
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: f.bootstraps[1], systemPrompt: [] },
      f.ctx,
    );
    const gate = await f.extension.handlers.get("tool_call")![0](
      {
        type: "tool_call",
        toolCallId: "new-run-read",
        toolName: "read",
        input: { path: "context.md" },
      },
      f.ctx,
    );
    expect(gate).toBeUndefined();
    expect(await f.status()).toMatchObject({ status: "running", architect: { blocked: null } });
  } finally {
    await f.close();
  }
});

test("active Auto status calls keep their tool budget, and terminal diagnostics remain available", async () => {
  const f = await loaderFixture({ maxToolCalls: 1 });
  try {
    await f.start();
    const gate = f.extension.handlers.get("tool_call")![0];
    expect(
      await gate(
        { type: "tool_call", toolCallId: "active-status", toolName: "auto_status", input: {} },
        f.ctx,
      ),
    ).toBeUndefined();
    expect(
      await gate(
        { type: "tool_call", toolCallId: "exhaust-budget", toolName: "auto_status", input: {} },
        f.ctx,
      ),
    ).toMatchObject({ block: true });
    expect(await f.status()).toMatchObject({ status: "budget_exhausted" });
    expect(
      await gate(
        { type: "tool_call", toolCallId: "terminal-status", toolName: "auto_status", input: {} },
        f.ctx,
      ),
    ).toBeUndefined();
    expect(
      await gate(
        {
          type: "tool_call",
          toolCallId: "terminal-xd-status",
          toolName: "write",
          input: { path: "xd://auto_status", content: "{}" },
        },
        f.ctx,
      ),
    ).toBeUndefined();
    expect(await f.stop()).toBeUndefined();
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 1 });
  } finally {
    await f.close();
  }
});

test("delayed Auto native artifact admission cannot alter a newer request after session switch", async () => {
  let reviews = 0;
  const f = await loaderFixture(
    {},
    {
      reviewer: async () => {
        reviews++;
        return approved;
      },
      dependencies: { snapshot: async () => snapshot(2), validate: async () => {} },
    },
  );
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const manager = f.ctx.sessionManager;
  const original = manager.saveArtifact.bind(manager);
  let stopping: ReturnType<typeof f.checkpoint> | undefined;
  try {
    await f.start();
    await f.verify();
    const evidenceRef = await f.evidence(
      "Full scoped verification evidence before the delayed admission",
    );
    manager.saveArtifact = async (content, kind) => {
      entered.resolve();
      await release.promise;
      return original(content, kind);
    };
    stopping = f.extension.tools
      .get("architect_checkpoint")!
      .definition.execute(
        "delayed-completion",
        { phase: "completion", evidenceRef },
        undefined,
        undefined,
        f.ctx,
      );
    await entered.promise;
    await f.extension.handlers.get("session_switch")![0](
      { type: "session_switch", reason: "resume", previousSessionFile: undefined },
      f.ctx,
    );
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: "A completely new request", systemPrompt: [] },
      f.ctx,
    );
    const before = await f.status();
    expect(before.architect).toMatchObject({
      completionApproved: false,
      lastReview: null,
      attempts: { completion: 0 },
    });
    release.resolve();
    await stopping;
    const after = await f.status();
    expect(after.architect).toEqual(before.architect);
    expect(after.status).toBe("idle");
    expect(reviews).toBe(0);
    expect(f.counts().aborts).toBe(0);
  } finally {
    release.resolve();
    await stopping?.catch(() => {});
    manager.saveArtifact = original;
    await f.close();
  }
});

test("internal Auto payload uses a verified session artifact and context admission without a user prompt", async () => {
  const f = await loaderFixture();
  try {
    const guidance = "日本語の案内  空白\n\n- そのまま保持\n";
    await f.extension.commands.get("auto")!.handler(`start fixture-change ${guidance}`, f.ctx);
    expect(f.deliveries).toHaveLength(1);
    const delivery = f.deliveries[0];
    expect(delivery).toMatchObject({ role: "custom", display: false, attribution: "agent" });
    const details = delivery.details as { ref: string; sessionId: string; bytes: number };
    expect(details.sessionId).toBe(f.ctx.sessionManager.getSessionId());
    const file = await f.ctx.sessionManager.getArtifactPath(details.ref.slice(11));
    expect(await Bun.file(file!).text()).toBe(String(delivery.content));
    expect(details.bytes).toBe(Buffer.byteLength(String(delivery.content)));
    expect(delivery.content).toContain(guidance);
    await expect(fs.lstat(path.join(f.cwd, ".rasen"))).rejects.toMatchObject({ code: "ENOENT" });
    const event = { type: "context", messages: [delivery] };
    for (let n = 0; n < 2; n++) {
      const result = await f.extension.handlers.get("context")![0](event, f.ctx);
      expect(result).toEqual({ messages: [delivery] });
    }
    expect(await f.status()).toMatchObject({ status: "running", steps: "1" });
    expect(f.counts().aborts).toBe(0);
  } finally {
    await f.close();
  }
});

for (const interrupt of [
  "stop",
  "session",
  "input",
  "changed-content",
  "changed-session",
] as const) {
  test(`internal Auto context rejects ${interrupt} delivery and removes it from later user history`, async () => {
    const f = await loaderFixture();
    try {
      await f.extension.commands.get("auto")!.handler("start fixture-change", f.ctx);
      const delivery = structuredClone(f.deliveries[0]);
      if (interrupt === "stop") await f.extension.commands.get("auto")!.handler("stop", f.ctx);
      else if (interrupt === "session")
        await f.extension.handlers.get("session_switch")![0](
          { type: "session_switch", reason: "resume" },
          f.ctx,
        );
      else if (interrupt === "input")
        await f.extension.handlers.get("input")![0](
          { type: "input", text: "New request", source: "interactive" },
          f.ctx,
        );
      else if (interrupt === "changed-content") delivery.content = `${delivery.content}\nmodified`;
      else (delivery.details as { sessionId: string }).sessionId = "another-session";
      const aborts = f.counts().aborts;
      expect(
        await f.extension.handlers.get("context")![0](
          { type: "context", messages: [delivery] },
          f.ctx,
        ),
      ).toEqual({ messages: [] });
      expect(f.counts().aborts).toBe(aborts + 1);
      const user = {
        role: "user",
        content: [{ type: "text", text: "New request" }],
        timestamp: Date.now(),
      };
      expect(
        await f.extension.handlers.get("context")![0](
          { type: "context", messages: [delivery, user] },
          f.ctx,
        ),
      ).toEqual({ messages: [user] });
      expect(f.counts().aborts).toBe(aborts + 1);
    } finally {
      await f.close();
    }
  });
}

test("Auto fails closed when native payload storage is unavailable", async () => {
  const f = await loaderFixture();
  const save = jest.spyOn(f.ctx.sessionManager, "saveArtifact").mockResolvedValue(undefined);
  try {
    await f.extension.commands.get("auto")!.handler("start fixture-change", f.ctx);
    expect(f.deliveries).toEqual([]);
    expect(await f.status()).toMatchObject({ status: "idle" });
  } finally {
    save.mockRestore();
    await f.close();
  }
});

for (const interrupt of ["stop", "session", "input"] as const) {
  test(`Auto rechecks ${interrupt} after payload persistence before internal dispatch`, async () => {
    const f = await loaderFixture();
    const save = f.ctx.sessionManager.saveArtifact.bind(f.ctx.sessionManager);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const spy = jest
      .spyOn(f.ctx.sessionManager, "saveArtifact")
      .mockImplementation(async (...args) => {
        const id = await save(...args);
        entered.resolve();
        await release.promise;
        return id;
      });
    try {
      const starting = f.extension.commands.get("auto")!.handler("start fixture-change", f.ctx);
      await entered.promise;
      if (interrupt === "stop") await f.extension.commands.get("auto")!.handler("stop", f.ctx);
      else if (interrupt === "session")
        await f.extension.handlers.get("session_switch")![0](
          { type: "session_switch", reason: "resume" },
          f.ctx,
        );
      else
        await f.extension.handlers.get("input")![0](
          { type: "input", text: "New request", source: "interactive" },
          f.ctx,
        );
      release.resolve();
      await starting;
      expect(f.deliveries).toEqual([]);
      expect(await f.status()).toMatchObject({ status: "idle" });
    } finally {
      release.resolve();
      spy.mockRestore();
      await f.close();
    }
  });
}

for (const userKind of ["text", "skill"] as const) {
  test(`new ${userKind} user wins over canceled internal bootstrap and pending continuation companions`, async () => {
    const f = await loaderFixture({}, { minReviews: 2 });
    try {
      await f.start();
      f.complete();
      await f.verify();
      const next = (await f.stop()) as { additionalContext: string };
      const continuation = {
        role: "custom",
        customType: "session-stop-continuation",
        content: next.additionalContext,
        display: false,
        attribution: "agent",
        timestamp: Date.now(),
      };
      await f.extension.handlers.get("input")![0](
        { type: "input", text: "My new request", source: "interactive" },
        f.ctx,
      );
      await f.extension.handlers.get("before_agent_start")![0](
        { type: "before_agent_start", prompt: "My new request", systemPrompt: [] },
        f.ctx,
      );
      await f.extension.handlers.get("turn_start")![0](
        { type: "turn_start", turnIndex: 0, timestamp: Date.now() },
        f.ctx,
      );
      const user = {
        ...(userKind === "text"
          ? { role: "user" }
          : { role: "custom", customType: "skill-prompt", attribution: "user", display: true }),
        content: [{ type: "text", text: "My new request" }],
        timestamp: Date.now(),
      };
      expect(
        await f.extension.handlers.get("context")![0](
          { type: "context", messages: [f.deliveries[0], user, continuation] },
          f.ctx,
        ),
      ).toEqual({ messages: [user] });
      expect(f.counts().aborts).toBe(0);
      expect(await f.status()).toMatchObject({ status: "cancelled" });
      await f.extension.handlers.get("agent_end")![0](
        { type: "agent_end", messages: [], willContinue: false },
        f.ctx,
      );
      const assistant = {
        role: "assistant",
        content: [{ type: "text", text: "Finished new request" }],
      };
      expect(
        await f.extension.handlers.get("context")![0](
          { type: "context", messages: [user, assistant, continuation] },
          f.ctx,
        ),
      ).toEqual({ messages: [user, assistant] });
      expect(f.counts().aborts).toBe(1);
    } finally {
      await f.close();
    }
  });
}

test("Jev selects recorded stage frontiers, caches task-only churn, and never substitutes for approvals", async () => {
  let observed = workflow(false);
  const f = await loaderFixture({}, { dependencies: { workflow: async () => observed } });
  try {
    await f.start();
    expect(await f.step()).toMatchObject({ choice: "continue", cached: false, ready: ["apply"] });
    expect(f.counts().decisions).toBe(1);
    f.setProgress(1);
    expect(await f.step("One checkbox changed without a stage transition")).toMatchObject({
      cached: true,
    });
    expect(f.counts().decisions).toBe(1);
    observed = workflow(true);
    expect(
      await f.step("External stage claims changed while a task remains incomplete"),
    ).toMatchObject({
      cached: false,
      ready: ["apply"],
      allowedNextPhase: "apply",
    });
    expect(f.counts().decisions).toBe(2);
    expect(await f.status()).toMatchObject({
      status: "running",
      progress: { complete: 1, remaining: 1 },
      architect: { completionApproved: false },
    });
    expect(await f.stop()).toBeUndefined();
    expect(await f.status()).toMatchObject({ status: "needs_user", completionVerified: false });
    expect(f.counts().decisions).toBe(2);
  } finally {
    await f.close();
  }
});

for (const choice of ["replan", "needs_user"] as const) {
  test(`stage Jev ${choice} preserves recovery/authorization gates`, async () => {
    const f = await loaderFixture(
      {},
      { dependencies: { decision: () => async () => ({ choice, confidence: 0.99 }) } },
    );
    try {
      await f.start();
      const advice = await f.step();
      expect(await f.status()).toMatchObject(
        choice === "replan"
          ? { status: "running", architect: { pendingRecovery: true, completionApproved: false } }
          : { status: "needs_user", completionVerified: false },
      );
      if (choice === "replan") expect(advice.instruction).toContain("recovery");
      else expect(advice.isError).toBe(true);
      expect(
        await f.extension.handlers.get("tool_call")![0](
          {
            type: "tool_call",
            toolCallId: "ungated-write",
            toolName: "write",
            input: { path: "x", content: "y" },
          },
          f.ctx,
        ),
      ).toMatchObject({ block: true });
    } finally {
      await f.close();
    }
  });
}

test("premature LEAD stop requires user input without an invented task loop or routine Jev call", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    expect(await f.stop()).toBeUndefined();
    expect(await f.status()).toMatchObject({
      status: "needs_user",
      steps: "1",
      decisions: 0,
      completionVerified: false,
    });
    expect(f.bootstraps).toHaveLength(1);
    expect(f.counts().decisions).toBe(0);
  } finally {
    await f.close();
  }
});

test("terminal tool cap retains fresh CLI progress and diagnostic failures never resume the run", async () => {
  let completed = 0;
  let unavailable = false;
  const f = await loaderFixture(
    { maxToolCalls: 1 },
    {
      dependencies: {
        snapshot: async () => {
          if (unavailable) throw new Error("Fixture CLI unavailable");
          return snapshot(completed);
        },
      },
    },
  );
  try {
    await f.start();
    const gate = f.extension.handlers.get("tool_call")![0];
    expect(
      await gate(
        { type: "tool_call", toolCallId: "first", toolName: "read", input: { path: "tasks.md" } },
        f.ctx,
      ),
    ).toBeUndefined();
    completed = 1;
    expect(
      await gate(
        { type: "tool_call", toolCallId: "excess", toolName: "read", input: { path: "tasks.md" } },
        f.ctx,
      ),
    ).toMatchObject({ block: true });
    expect(await f.status()).toMatchObject({
      status: "budget_exhausted",
      toolCalls: "1/1",
      progress: { total: 2, complete: 1, remaining: 1 },
      completionVerified: false,
    });
    completed = 2;
    expect(await f.status()).toMatchObject({
      status: "budget_exhausted",
      progress: { complete: 2, remaining: 0 },
      completionVerified: false,
    });
    unavailable = true;
    expect(await f.status()).toMatchObject({
      status: "budget_exhausted",
      progress: { complete: 2 },
      observation: { error: expect.stringContaining("last known") },
      completionVerified: false,
    });
    expect(await f.stop()).toBeUndefined();
    expect(f.counts().decisions).toBe(0);
  } finally {
    await f.close();
  }
});

test("native registered implementation/research/reviewer leaves preserve configured model routing", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    await f.step();
    const ctx = {
      ...f.ctx,
      models: { resolve: () => ({ model: { id: "fixture" } }) },
    } as unknown as ExtensionContext;
    for (const [agent, model] of [
      ["omp-worker", "@implementation"],
      ["omp-explorer", "@research"],
    ]) {
      expect(
        await f.extension.handlers.get("before_subagent_spawn")![0](
          { type: "before_subagent_spawn", agent, invocationKind: "task" },
          ctx,
        ),
      ).toMatchObject({ model });
    }
    f.complete();
    expect(await f.step()).toMatchObject({ allowedNextPhase: "verify" });
    expect(
      await f.extension.handlers.get("before_subagent_spawn")![0](
        { type: "before_subagent_spawn", agent: "omp-reviewer", invocationKind: "task" },
        ctx,
      ),
    ).toMatchObject({ model: "@architect" });
    expect(
      await f.extension.handlers.get("before_subagent_spawn")![0](
        { type: "before_subagent_spawn", agent: "other-agent", invocationKind: "task" },
        ctx,
      ),
    ).toMatchObject({ block: true });
    expect(await f.status()).toMatchObject({ status: "running", completionVerified: false });
  } finally {
    await f.close();
  }
});

test("status refresh during a delayed completion review cannot approve different task/workflow facts", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let revision = "A";
  let reviews = 0;
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        snapshot: async () => ({ ...snapshot(2), fingerprint: `tasks-${revision}` }),
        workflow: async () => ({ ...workflow(true), fingerprint: `workflow-${revision}` }),
        validate: async () => {},
      },
      reviewer: async () => {
        reviews++;
        entered.resolve();
        await release.promise;
        return approved;
      },
    },
  );
  let reviewing: ReturnType<typeof f.checkpoint> | undefined;
  try {
    await f.start();
    await f.verify();
    reviewing = f.checkpoint();
    await entered.promise;
    revision = "B";
    expect(await f.status()).toMatchObject({ status: "running", completionVerified: false });
    release.resolve();
    const result = await reviewing;
    expect(result.isError).toBe(true);
    expect(await f.status()).toMatchObject({
      completionVerified: false,
      architect: { completionApproved: false },
    });
    await f.stop();
    expect(await f.status()).not.toMatchObject({ status: "completed" });
    expect(reviews).toBe(1);
  } finally {
    release.resolve();
    await reviewing?.catch(() => {});
    await f.close();
  }
});

test("fresh status diagnostics do not reset the no-output watchdog", async () => {
  let now = 100000;
  const f = await loaderFixture({ noOutputTimeoutMs: 1000 }, { dependencies: { now: () => now } });
  try {
    await f.start();
    const before = await f.status();
    now += 500;
    expect(await f.status()).toMatchObject({
      status: "running",
      supervision: { lastActivityAt: before.supervision.lastActivityAt },
    });
    now += 501;
    expect(
      await f.extension.handlers.get("tool_call")![0](
        {
          type: "tool_call",
          toolCallId: "after-no-output",
          toolName: "read",
          input: { path: "tasks.md" },
        },
        f.ctx,
      ),
    ).toMatchObject({ block: true });
    expect(await f.status()).toMatchObject({
      status: "stalled",
      reason: expect.stringContaining("output"),
      completionVerified: false,
      supervision: { lastActivityAt: before.supervision.lastActivityAt },
    });
  } finally {
    await f.close();
  }
});

for (const active of [true, false]) {
  test(`${active ? "Auto" : "ordinary"} task envelopes account for nonzero child exits without fabricated top-level errors`, async () => {
    const f = await loaderFixture();
    try {
      if (active) await f.start();
      else
        await f.extension.handlers.get("before_agent_start")![0](
          { type: "before_agent_start", prompt: "An ordinary request", systemPrompt: [] },
          f.ctx,
        );
      for (let i = 0; i < 2; i++) {
        for (const handler of f.extension.handlers.get("tool_result")!)
          await handler(
            {
              type: "tool_result",
              toolCallId: `failed-leaf-${i}`,
              toolName: "task",
              input: {
                agent: "omp-worker",
                tasks: [{ id: "work", task: "Implement scoped module" }],
              },
              content: [{ type: "text", text: "Child exited without a usable result" }],
              details: { results: [{ exitCode: 1, error: "Child execution failed" }] },
              isError: false,
            },
            f.ctx,
          );
      }
      expect(await f.status()).toMatchObject({
        architect: { pendingRecovery: active, completionApproved: false },
      });
      if (active)
        expect(
          await f.extension.handlers.get("tool_call")![0](
            {
              type: "tool_call",
              toolCallId: "write-after-repeated-failure",
              toolName: "write",
              input: { path: "result.ts", content: "unreviewed workaround" },
            },
            f.ctx,
          ),
        ).toMatchObject({ block: true });
    } finally {
      await f.close();
    }
  });
}

test("Jev advice rejects an in-flight stage-status change even when completed/ready lists are unchanged", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let observed = workflow(false);
  let decisions = 0;
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        workflow: async () => observed,
        decision: () => async () => {
          decisions++;
          entered.resolve();
          await release.promise;
          return { choice: decisions === 1 ? "replan" : "continue", confidence: 0.99 };
        },
      },
    },
  );
  let pending: ReturnType<typeof f.step> | undefined;
  try {
    await f.start();
    pending = f.step();
    await entered.promise;
    if (observed.kind !== "present") throw new Error("Expected workflow fixture");
    observed = {
      ...observed,
      stages: observed.stages.map((stage) =>
        stage.id === "apply" ? { ...stage, status: "in_progress" } : stage,
      ),
      inProgressStages: ["apply"],
      fingerprint: "changed-stage-status",
    };
    await f.status();
    release.resolve();
    expect(await pending).toMatchObject({
      isError: true,
      error: expect.stringContaining("changed"),
    });
    expect(await f.status()).toMatchObject({
      status: "running",
      architect: { pendingRecovery: false },
    });
    expect(await f.step()).toMatchObject({ status: "needs_user", isError: true });
    expect(decisions).toBe(1);
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    await f.close();
  }
});

for (const mixed of [false, true]) {
  test(`stale Auto async delivery preserves a newer active user turn, mixed=${mixed}`, async () => {
    const f = await loaderFixture();
    try {
      await f.start();
      await f.step();
      await f.extension.handlers.get("tool_call")![0](
        { type: "tool_call", toolName: "bash", toolCallId: "owned", input: { command: "fixture" } },
        f.ctx,
      );
      const id = f.nativeManager.register("bash", "owned", async () => "old", { ownerId: "main" });
      for (const handler of f.extension.handlers.get("tool_result") ?? [])
        await handler(
          {
            type: "tool_result",
            toolName: "bash",
            toolCallId: "owned",
            input: {},
            content: [],
            details: { async: { jobId: id } },
            isError: false,
          },
          f.ctx,
        );
      await f.nativeManager.getJob(id)!.promise;
      const delivery = {
        role: "custom",
        customType: "async-result",
        attribution: "agent",
        display: true,
        content: "STALE BODY plus unrelated",
        details: { jobs: [{ jobId: id }, ...(mixed ? [{ jobId: "unrelated-job" }] : [])] },
        timestamp: Date.now(),
      };
      await f.extension.handlers.get("input")![0](
        { type: "input", text: "New user task", source: "interactive" },
        f.ctx,
      );
      await f.extension.handlers.get("before_agent_start")![0](
        { type: "before_agent_start", prompt: "New user task", systemPrompt: [] },
        f.ctx,
      );
      const messages = [
        { role: "user", content: "New user task", timestamp: Date.now() },
        { role: "assistant", content: [], stopReason: "toolUse", timestamp: Date.now() },
        {
          role: "toolResult",
          toolCallId: "new-read",
          toolName: "read",
          content: [],
          isError: false,
          timestamp: Date.now(),
        },
      ];
      const aborts = f.counts().aborts;
      const result = await f.extension.handlers.get("context")![0](
        { type: "context", messages: [...messages, delivery] },
        f.ctx,
      );
      expect(f.counts().aborts).toBe(aborts);
      expect(JSON.stringify(result)).not.toContain("STALE BODY");
      if (mixed) expect(JSON.stringify(result)).toContain("unrelated-job");
      else expect(result).toEqual({ messages });
    } finally {
      await f.close();
    }
  });
}

test("unreceipted interrupted native work cannot pass Auto completion", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    await f.step();
    expect(
      await f.extension.handlers.get("tool_call")![0](
        {
          type: "tool_call",
          toolName: "bash",
          toolCallId: "interrupted",
          input: { command: "fixture" },
        },
        f.ctx,
      ),
    ).toBeUndefined();
    for (const handler of f.extension.handlers.get("tool_execution_end") ?? [])
      await handler(
        {
          type: "tool_execution_end",
          toolName: "bash",
          toolCallId: "interrupted",
          isError: true,
          result: { content: [], details: { __interrupted: true, execution: "started" } },
        },
        f.ctx,
      );
    f.complete();
    const result = await f.checkpoint();
    expect(result.isError).toBe(true);
    expect(await f.status()).toMatchObject({
      completionVerified: false,
      nativeWork: { settlementUnverified: ["interrupted"] },
    });
  } finally {
    await f.close();
  }
});

test("built-in apply sends its native host route to Jev even without external run-state", async () => {
  let request: ReturnType<typeof buildJevRequest> | undefined;
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        workflow: async () => ({
          kind: "absent",
          change: "fixture-change",
          reason: "No external run-state",
          fingerprint: "absent",
        }),
        decision: () =>
          createJevProvider(
            { model: "jev-latest", timeoutMs: 500, maxEvidenceChars: 12000 },
            {
              readApiKey: () => "fixture-not-a-secret",
              fetch: async (_url, init) => {
                request = JSON.parse(String(init.body));
                return new Response(
                  JSON.stringify({
                    model: "jev-latest",
                    answers: {
                      next: {
                        type: "choice",
                        choice: "continue",
                        confidence: 0.95,
                        probabilities: {
                          continue: 0.95,
                          replan: 0.01,
                          needs_user: 0.02,
                          uncertain: 0.02,
                        },
                      },
                    },
                    usage: { input_tokens: 1, output_tokens: 1 },
                  }),
                );
              },
            },
          ),
      },
    },
  );
  try {
    await f.start();
    expect(await f.step("Need to apply remaining prepared tasks")).toMatchObject({
      choice: "continue",
      allowedNextPhase: "apply",
    });
    const facts = JSON.parse(request!.state.summary);
    expect(facts).toMatchObject({
      allowedPhase: "apply",
      hostSource: "builtin",
      hostBlocker: null,
      stage: { role: "implementer", runtime: "omp", dispatchMode: "native" },
      nativeWorkSettled: true,
    });
    expect(facts.nextStep).toContain("native omp-worker");
    expect(facts.workflowContext).toContain("external Rasen run-state is not required");
    expect(await f.status()).toMatchObject({
      status: "running",
      decisionDiagnostics: {
        attempts: [{ provider: "jev", outcome: "accepted", confidence: 0.95 }],
      },
    });
  } finally {
    await f.close();
  }
});

test("small decision evidence budgets preserve complete JSON and built-in next-step facts", async () => {
  const f = await loaderFixture(
    { maxEvidenceChars: 1000 },
    {
      dependencies: {
        workflow: async () => ({
          kind: "absent",
          change: "fixture-change",
          reason: "No external run-state",
          fingerprint: "absent",
        }),
        decision: () => async (evidence) => {
          const request = buildJevRequest(evidence, {
            model: "jev-latest",
            maxEvidenceChars: 1000,
          });
          const facts = JSON.parse(request.state.summary);
          expect(facts).toMatchObject({
            hostSource: "builtin",
            allowedPhase: "apply",
            externalRunStateRequired: false,
            truncated: true,
          });
          expect(facts.nextStep).toContain("native omp-worker");
          return { choice: "continue", confidence: 0.95 };
        },
      },
    },
  );
  try {
    await f.start();
    for (const handler of f.extension.handlers.get("tool_result") ?? []) {
      await handler(
        {
          type: "tool_result",
          toolName: "read",
          toolCallId: "escaped-evidence",
          input: { path: "tasks.md" },
          content: [{ type: "text", text: '\"'.repeat(1000) }],
          isError: false,
        },
        f.ctx,
      );
    }
    expect(await f.step("Untrusted claim ".repeat(1000))).toMatchObject({ choice: "continue" });
  } finally {
    await f.close();
  }
});

import { expect, jest, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentRegistry,
  type AgentSession,
  AuthStorage,
  ModelRegistry,
  SessionManager,
  Settings,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { RasenSkill } from "../src/auto/skills.ts";
import type { DecisionEvidence } from "../src/auto/decision.ts";
import { AUTO_JOURNAL_TYPE } from "../src/auto/journal.ts";
import type { AutoConfig } from "../src/auto/config.ts";
import { autoStepCarrier, type AutoDependencies } from "../src/auto/extension.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";
import { digest, type Reviewer } from "../src/core.ts";
import { extensionFactory } from "../src/extension.ts";
import { withAgentDir } from "./isolated-host.ts";

const approved = { decision: "approve" as const, summary: "Fixture evidence checked", issues: [] };

type TerminalResult = {
  actionId: string;
  status: "progress" | "success" | "blocked" | "needs_user" | "failed" | "cancelled";
  note: string;
};

function selectSkill(evidence: DecisionEvidence, name: string) {
  const choice = Object.entries(evidence.choices ?? {}).find(([, criterion]) =>
    criterion.startsWith(`Execute existing native skill ${name}:`),
  )?.[0];
  if (!choice) throw new Error(`No native skill option for ${name}`);
  return { choice, confidence: 0.99 };
}

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

// The real OMP extension loader and native session/artifact journal are used here.
// Tool and child results are explicitly delivered fixtures, not real child execution.
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
  const sessionManager = SessionManager.create(cwd, path.join(cwd, ".test-sessions"));
  const runtime = new ExtensionRuntime();
  runtime.appendEntry = ((type: string, data: unknown) =>
    sessionManager.appendCustomEntry(type, data)) as unknown as typeof runtime.appendEntry;
  const messages: Array<{ customType: string; content: unknown }> = [];
  const bootstraps: string[] = [];
  const deliveries: Array<Record<string, unknown>> = [];
  const observed: DecisionEvidence[] = [];
  const notifications: string[] = [];
  let reads = 0;
  let completed = 0;
  let decisions = 0;
  let aborts = 0;
  let desired = "rasen-verify-change";
  const skills: RasenSkill[] = await Promise.all(
    [
      ["rasen-verify-change", "Verify actual implementation against requirements"],
      ["rasen-apply-change", "Implement remaining change tasks"],
      ["rasen-review-cycle", "Own the complete review, fix, and strategy loop"],
      ["pack/rasen-continue~2", "Continue preparation of missing change artifacts"],
      ["rasen-ship", "Publish only after the normal explicit user authorization"],
    ].map(async ([name, description]) => {
      const filePath = path.join(cwd, "native-skills", name.replaceAll("/", "-"), "SKILL.md");
      await Bun.write(
        filePath,
        `---\nname: ${name}\ndescription: ${description}\n---\nComplete ${name} instructions; preserve native tools and skill records.`,
      );
      return {
        name,
        description,
        filePath,
        baseDir: path.dirname(filePath),
        source: "fixture-native-loader",
        reference: `skill://${name}`,
      };
    }),
  );
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
  const model = {
    provider: "openai",
    id: "fixture-model",
    name: "Fixture model",
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: false,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } as NonNullable<AgentSession["model"]>;
  const nativeSession = {
    asyncJobManager: nativeManager,
    getAgentId: () => "main",
    sessionId: sessionManager.getSessionId(),
    skills,
    model,
    modelRegistry: { getAvailable: () => [model] },
    hasPendingAsyncWork: () => nativeManager.getAllJobs().some((job) => job.status === "running"),
    waitForAdmittedSubmissions: async () => {},
    waitForIrcReplies: async () => {},
    settleAsyncWork: async () => {},
    waitForIdle: async () => {},
  } as unknown as AgentSession;
  nativeRegistry.register({
    id: "main",
    displayName: "Main",
    kind: "main",
    session: nativeSession,
  });
  const factory = extensionFactory(() => overrides.reviewer ?? (async () => approved), {
    snapshot: async () => {
      reads++;
      return { ...snapshot(completed), root: cwd };
    },
    decision: () => async (facts) => {
      decisions++;
      observed.push(structuredClone(facts));
      return desired.startsWith("rasen-") || desired.includes("/rasen-")
        ? selectSkill(facts, desired)
        : { choice: desired, confidence: 0.99 };
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
  const ctx = {
    cwd,
    sessionManager,
    modelRegistry: overrides.modelRegistry,
    models: { resolve: () => model, list: () => [model], current: () => model },
    agent: { kind: "main", id: "main", name: "main", depth: 0 },
    hasUI: true,
    isIdle: () => true,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async <T>() => true as T,
      confirm: async () => true,
    },
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
    if (content.type !== "text") throw new Error("Missing status");
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
    const previous = bootstraps.length;
    await extension.commands.get("auto")!.handler("start fixture-change", ctx);
    expect(bootstraps).toHaveLength(previous + 1);
    await extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: bootstraps.at(-1), systemPrompt: [] },
      ctx,
    );
    await extension.handlers.get("turn_start")![0](
      { type: "turn_start", turnIndex: 0, timestamp: Date.now() },
      ctx,
    );
  };
  const step = async (
    summary = "Observe the current change and select an existing skill",
    terminal?: TerminalResult,
  ) => {
    const result = await extension.tools
      .get("auto_step")!
      .definition.execute(
        crypto.randomUUID(),
        { summary, ...(terminal ? { result: terminal } : {}) },
        undefined,
        undefined,
        ctx,
      );
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Missing action response");
    return { ...JSON.parse(content.text), isError: !!result.isError };
  };
  const registerNativeChild = (id: string, agent = "omp-reviewer") =>
    nativeRegistry.register({
      id,
      displayName: id,
      kind: "sub",
      parentId: "main",
      status: "idle",
      session: null,
      history: { agent },
      lifecycle: { acceptedAt: Date.now(), terminalAt: Date.now() },
    });
  const gate = async (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string = crypto.randomUUID(),
  ) => {
    for (const handler of extension.handlers.get("tool_call") ?? []) {
      const result = await handler({ type: "tool_call", toolName, toolCallId, input }, ctx);
      if (result) return result;
    }
  };
  const toolResult = async (
    toolName: string,
    input: Record<string, unknown>,
    toolCallId: string,
    result: Record<string, unknown>,
  ) => {
    for (const handler of extension.handlers.get("tool_result") ?? [])
      await handler(
        { type: "tool_result", toolName, toolCallId, input, isError: false, ...result },
        ctx,
      );
  };
  const mainResult = async (
    toolName = "read",
    input: Record<string, unknown> = { path: "tasks.md" },
    output = "Actual native tool output",
  ) => {
    const id = crypto.randomUUID();
    expect(await gate(toolName, input, id)).toBeUndefined();
    await toolResult(toolName, input, id, { content: [{ type: "text", text: output }] });
  };
  const nativeResult = async (
    options: { role?: string; id?: string; output?: string; admitted?: boolean } = {},
  ) => {
    const state = await status();
    const action = state.selectedAction;
    if (!action) throw new Error("No selected action");
    const role = options.role ?? "omp-reviewer";
    const id = options.id ?? crypto.randomUUID();
    const input = {
      agent: role,
      task: `Auto action: ${action.actionId}\nInspect the scoped fixture`,
      model: action.admission.roleRoutes[role].selector,
      solutionSpace: "Scoped fixture evidence",
    };
    if (!options.admitted) expect(await gate("task", input, id)).toBeUndefined();
    registerNativeChild(id, role);
    const output = options.output ?? "Complete scoped native evidence, with limitations";
    await toolResult("task", input, id, {
      content: [{ type: "text", text: output }],
      details: {
        results: [
          {
            id,
            agent: role,
            exitCode: 0,
            aborted: false,
            output,
            resolvedModelIdentity: `openai/${model.id}`,
          },
        ],
      },
    });
    return id;
  };
  const finish = (actionId: string, report: Partial<Omit<TerminalResult, "actionId">> = {}) =>
    step("Main reports the selected skill's natural boundary", {
      actionId,
      status: "success",
      note: "Main completed the selected skill using settled native evidence",
      ...report,
    });
  const settled = async () => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const value = await status();
      if (value.status !== "draining") return value;
      if (Date.now() >= deadline)
        throw new Error(`Native fixture did not settle: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const evidence = async (content: string) => {
    const id = await sessionManager.saveArtifact(content, "architect-review");
    if (!id) throw new Error("Fixture review artifact was not saved");
    return `artifact://${id}`;
  };
  return {
    cwd,
    extension,
    ctx,
    runtime,
    nativeManager,
    nativeRegistry,
    nativeSession,
    skills,
    observed,
    notifications,
    messages,
    bootstraps,
    deliveries,
    registerNativeChild,
    nativeResult,
    mainResult,
    toolResult,
    gate,
    finish,
    settled,
    evidence,
    choose(name: string) {
      desired = name;
    },
    complete() {
      completed = 2;
    },
    setProgress(value: number) {
      completed = value;
    },
    step,
    status,
    start,
    stop,
    appendJournal: (event: unknown) => sessionManager.appendCustomEntry(AUTO_JOURNAL_TYPE, event),
    journal: () =>
      sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom" && entry.customType === AUTO_JOURNAL_TYPE)
        .map((entry) => (entry as { data: any }).data),
    async checkpoint(signal?: AbortSignal) {
      return extension.tools.get("architect_checkpoint")!.definition.execute(
        crypto.randomUUID(),
        {
          phase: "completion",
          evidenceRef: await evidence("Full implementation and test evidence"),
        },
        signal,
        undefined,
        ctx,
      );
    },
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
          ...(stage === "workflow"
            ? {
                skills: () => {
                  throw Object.assign(new Error("PRIVATE HOST TOKEN"), { code: "EACCES" });
                },
              }
            : {}),
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
      expect(await fixture.status()).toMatchObject({ status: "draining", outcome: "needs_user" });
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
      expect(await fixture.settled()).toMatchObject({ status: "paused", outcome: "needs_user" });
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
      steps: "0",
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

for (const delivery of ["bootstrap"] as const) {
  for (const cancel of ["stop", "session", "new-input"] as const) {
    test(`real loader rejects queued ${delivery} after ${cancel} without ordinary-request fallback`, async () => {
      const fixture = await loaderFixture({}, { minReviews: 2 });
      try {
        await fixture.extension.commands
          .get("auto")!
          .handler("start fixture-change Old instructions", fixture.ctx);
        let text = fixture.bootstraps[0];
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
        expect(fixture.counts().aborts).toBe(0);
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
        const request = JSON.parse(String(init?.body));
        const criteria = request.questions.next.criteria as Record<string, string>;
        const choice = Object.entries(criteria).find(([, value]) =>
          value.startsWith("Execute existing native skill rasen-verify-change:"),
        )![0];
        return new Response(
          JSON.stringify({
            model: "jev-latest",
            answers: {
              next: {
                type: "choice",
                choice,
                confidence: 0.99,
                probabilities: Object.fromEntries(
                  Object.keys(criteria).map((key) => [
                    key,
                    key === choice ? 0.99 : 0.01 / (Object.keys(criteria).length - 1),
                  ]),
                ),
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
    expect(continuation).toMatchObject({
      action: { skill: { name: "rasen-verify-change" } },
      isError: false,
    });
    expect(await fixture.step("same frontier, different prose")).toMatchObject({
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
      status: "draining",
      outcome: "uncertain",
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
      status: "draining",
      outcome: "uncertain",
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
      status: "draining",
      outcome: "needs_user",
      completionVerified: false,
    });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.counts()).toMatchObject({ decisions: 0, aborts: 0 });
    expect(fixture.bootstraps).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});

test("real loader gives an unrelated user request ownership while holding the existing Auto run", async () => {
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
      status: "draining",
      outcome: "needs_user",
      reason: "Superseded by new user input",
    });
    await fixture.stop();
    expect(fixture.counts()).toMatchObject({ decisions: 0, aborts: 0 });
  } finally {
    await fixture.close();
  }
});

test("input and start hooks preserve the first timeout cause and bounded input provenance", async () => {
  let now = 100000;
  const f = await loaderFixture({ noOutputTimeoutMs: 1000 }, { dependencies: { now: () => now } });
  const idle = Promise.withResolvers<void>();
  f.nativeSession.waitForIdle = async () => idle.promise;
  try {
    await f.start();
    now += 1001;
    await f.extension.handlers.get("tool_call")![0](
      { type: "tool_call", toolCallId: "expired", toolName: "read", input: { path: "tasks.md" } },
      f.ctx,
    );
    const first = await f.status();
    expect(first).toMatchObject({
      status: "draining",
      outcome: "stalled",
      inputEvent: null,
      initialStop: { at: now, status: "stalled", reason: first.reason },
    });
    now += 1;
    const text = "/PRIVATE_COMMAND private brief and prompt";
    await f.extension.handlers.get("input")![0]({ type: "input", text, source: "rpc" }, f.ctx);
    const inputEvent = {
      at: now,
      source: "rpc",
      kind: "command",
      textLength: text.length,
      imageCount: 0,
      statusBefore: "draining",
      outcomeBefore: "stalled",
    };
    now += 1;
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: text, systemPrompt: [] },
      f.ctx,
    );
    // A second user request and a hidden native start must not replace the
    // event that first arrived after the original hold.
    await f.extension.handlers.get("input")![0](
      { type: "input", text: "Another request", source: "interactive" },
      f.ctx,
    );
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: "Native result follow-up", systemPrompt: [] },
      f.ctx,
    );
    idle.resolve();
    const held = await f.settled();
    expect(held).toMatchObject({
      status: "paused",
      outcome: "stalled",
      reason: first.reason,
      initialStop: first.initialStop,
      inputEvent,
      completionVerified: false,
    });
    expect(
      JSON.stringify({ inputEvent: held.inputEvent, initialStop: held.initialStop }),
    ).not.toContain("PRIVATE_COMMAND");
    expect(f.counts().aborts).toBe(0);
  } finally {
    idle.resolve();
    await f.close();
  }
});

for (const source of ["interactive", "rpc"] as const) {
  test(`empty ${source} input leaves Auto running but image-only input pauses it`, async () => {
    const f = await loaderFixture();
    try {
      await f.start();
      for (const text of ["", " \t\n"]) {
        await f.extension.handlers.get("input")![0]({ type: "input", text, source }, f.ctx);
        expect(await f.status()).toMatchObject({
          status: "running",
          initialStop: null,
          inputEvent: null,
        });
      }
      await f.extension.handlers.get("input")![0](
        {
          type: "input",
          text: "",
          source,
          images: [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }],
        },
        f.ctx,
      );
      const first = await f.status();
      expect(first).toMatchObject({
        outcome: "needs_user",
        reason: "Superseded by new user input",
        inputEvent: {
          source,
          kind: "images",
          textLength: 0,
          imageCount: 1,
          statusBefore: "running",
          outcomeBefore: null,
        },
        initialStop: { status: "needs_user", reason: "Superseded by new user input" },
      });
      await f.extension.handlers.get("before_agent_start")![0](
        { type: "before_agent_start", prompt: "", systemPrompt: [] },
        f.ctx,
      );
      expect(await f.status()).toMatchObject({
        outcome: first.outcome,
        reason: first.reason,
        initialStop: first.initialStop,
        inputEvent: first.inputEvent,
      });
      expect(JSON.stringify(first.inputEvent)).not.toContain("PRIVATE_IMAGE");
      expect(f.counts().aborts).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("Auto start resets old input provenance and internal hooks cannot fabricate a user stop", async () => {
  const f = await loaderFixture();
  try {
    await f.extension.handlers.get("input")![0](
      { type: "input", text: "Earlier request", source: "interactive" },
      f.ctx,
    );
    await f.start();
    await f.extension.handlers.get("input")![0](
      { type: "input", text: "Native notification", source: "extension" },
      f.ctx,
    );
    await f.extension.handlers.get("input")![0](
      { type: "input", text: "/auto status", source: "interactive" },
      f.ctx,
    );
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: "Native IRC result follow-up", systemPrompt: [] },
      f.ctx,
    );
    expect(await f.status()).toMatchObject({
      status: "running",
      reason: null,
      initialStop: null,
      inputEvent: null,
    });
    await f.extension.handlers.get("input")![0](
      { type: "input", text: "New request after Auto started", source: "interactive" },
      f.ctx,
    );
    expect(await f.settled()).toMatchObject({
      status: "paused",
      initialStop: { status: "needs_user" },
      inputEvent: { kind: "text", source: "interactive" },
    });
    await f.extension.commands.get("auto")!.handler("start fixture-change", f.ctx);
    expect(f.bootstraps).toHaveLength(2);
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: f.bootstraps[1], systemPrompt: [] },
      f.ctx,
    );
    expect(await f.status()).toMatchObject({
      status: "running",
      reason: null,
      initialStop: null,
      inputEvent: null,
    });
    expect(f.counts().aborts).toBe(0);
  } finally {
    await f.close();
  }
});

test("new user input releases Main while hidden native starts cannot reset or resume held Auto", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    await f.step();
    await f.extension.commands.get("auto")!.handler("stop", f.ctx);
    const held = await f.settled();
    expect(held).toMatchObject({ status: "paused", outcome: "needs_user" });
    await f.extension.handlers.get("input")![0](
      { type: "input", text: "Inspect another scoped change", source: "interactive" },
      f.ctx,
    );
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: "Inspect another scoped change", systemPrompt: [] },
      f.ctx,
    );
    expect(
      await f.extension.handlers.get("tool_call")![0](
        {
          type: "tool_call",
          toolName: "write",
          toolCallId: "new-user-write",
          input: { path: "new-request.txt", content: "Authorized Main work" },
        },
        f.ctx,
      ),
    ).toBeUndefined();
    const plan = await f.extension.tools.get("architect_checkpoint")!.definition.execute(
      "new-user-plan",
      {
        phase: "plan",
        evidenceRef: await f.evidence("Inspect another scoped change"),
        steps: ["Inspect", "Implement", "Verify"],
      },
      undefined,
      undefined,
      f.ctx,
    );
    expect(plan.isError).toBe(false);
    expect(await f.status()).toMatchObject({
      status: "paused",
      outcome: "needs_user",
      architect: { attempts: { plan: 1 } },
    });
    await f.extension.handlers.get("turn_start")![0](
      { type: "turn_start", turnIndex: 1, timestamp: Date.now() },
      f.ctx,
    );
    await f.extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: "Native IRC result follow-up", systemPrompt: [] },
      f.ctx,
    );
    expect(await f.status()).toMatchObject({
      status: "paused",
      outcome: "needs_user",
      steps: held.steps,
      decisions: held.decisions,
      architect: { attempts: { plan: 1 } },
    });
    expect((await f.step()).isError).toBe(true);
    expect(f.bootstraps).toHaveLength(1);
    expect(f.counts().aborts).toBe(0);
  } finally {
    await f.close();
  }
});

test("Auto stop drains native work without cancelling or consuming its result", async () => {
  const f = await loaderFixture();
  const body = Promise.withResolvers<string>();
  const mainIdle = Promise.withResolvers<void>();
  const idleWaitStarted = Promise.withResolvers<void>();
  let nativeSignal: AbortSignal | undefined;
  const cancel = spyOn(f.nativeManager, "cancel");
  const cancelAll = spyOn(f.nativeManager, "cancelAll");
  const acknowledge = spyOn(f.nativeManager, "acknowledgeDeliveries");
  const consume = spyOn(f.nativeManager, "consumeJobResults");
  f.nativeSession.waitForIdle = async () => {
    idleWaitStarted.resolve();
    await mainIdle.promise;
  };
  try {
    await f.start();
    const id = f.nativeManager.register(
      "bash",
      "native operation",
      async ({ signal }) => {
        nativeSignal = signal;
        return body.promise;
      },
      { ownerId: "main" },
    );
    await f.extension.commands.get("auto")!.handler("stop", f.ctx);
    expect(await f.status()).toMatchObject({
      status: "draining",
      outcome: "needs_user",
      completionVerified: false,
      nativeWork: { pending: true },
    });
    expect(nativeSignal?.aborted).toBe(false);
    expect(f.nativeManager.getJob(id)?.status).toBe("running");
    await f.extension.commands.get("auto")!.handler("start fixture-change", f.ctx);
    expect(f.bootstraps).toHaveLength(1);
    const gate = f.extension.handlers.get("tool_call")![0];
    expect(
      await gate(
        {
          type: "tool_call",
          toolName: "write",
          toolCallId: "late-auto-write",
          input: { path: "fixture.ts", content: "late" },
        },
        f.ctx,
      ),
    ).toMatchObject({ block: true });
    expect(
      await gate(
        { type: "tool_call", toolName: "wait", toolCallId: "native-wait", input: {} },
        f.ctx,
      ),
    ).toBeUndefined();
    body.resolve("Native result is still deliverable");
    await f.nativeManager.getJob(id)!.promise;
    await idleWaitStarted.promise;
    expect(await f.status()).toMatchObject({ status: "draining", outcome: "needs_user" });
    mainIdle.resolve();
    expect(await f.settled()).toMatchObject({
      status: "paused",
      outcome: "needs_user",
      completionVerified: false,
    });
    expect(f.nativeManager.getJob(id)).toMatchObject({
      status: "completed",
      resultText: "Native result is still deliverable",
    });
    expect(f.nativeManager.isJobResultConsumed(id)).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(cancelAll).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(f.counts().aborts).toBe(0);
    expect(f.bootstraps).toHaveLength(1);
  } finally {
    body.resolve("cleanup");
    mainIdle.resolve();
    cancel.mockRestore();
    cancelAll.mockRestore();
    acknowledge.mockRestore();
    consume.mockRestore();
    await f.close();
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
    expect(await fixture.status()).toMatchObject({ status: "running", steps: "0" });
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

test("real loader preserves identical preparation retries but rejects replay after a turn starts", async () => {
  const fixture = await loaderFixture();
  try {
    await fixture.extension.commands.get("auto")!.handler("start fixture-change", fixture.ctx);
    const event = { type: "before_agent_start", prompt: fixture.bootstraps[0], systemPrompt: [] };
    await fixture.extension.handlers.get("before_agent_start")![0](event, fixture.ctx);
    await fixture.extension.handlers.get("before_agent_start")![0](event, fixture.ctx);
    expect(await fixture.status()).toMatchObject({ status: "running", steps: "0" });
    await fixture.extension.handlers.get("turn_start")![0](
      { type: "turn_start", turnIndex: 0, timestamp: Date.now() },
      fixture.ctx,
    );
    await fixture.extension.handlers.get("before_agent_start")![0](event, fixture.ctx);
    expect(await fixture.status()).toMatchObject({
      status: "draining",
      outcome: "needs_user",
      steps: "0",
    });
    expect(fixture.counts()).toMatchObject({ decisions: 0, aborts: 0 });
  } finally {
    await fixture.close();
  }
});

for (const interrupt of ["status", "unexpected-hidden", "new-user"] as const) {
  test(`real loader ${interrupt} preserves native action ownership`, async () => {
    const f = await loaderFixture();
    try {
      await f.start();
      await f.step();
      const before = await f.status();
      if (interrupt === "status") {
        await f.extension.handlers.get("input")![0](
          { type: "input", text: "/auto status", source: "interactive" },
          f.ctx,
        );
        await f.extension.commands.get("auto")!.handler("status", f.ctx);
        expect(await f.status()).toMatchObject({
          status: "running",
          steps: before.steps,
          selectedAction: before.selectedAction,
        });
      } else {
        if (interrupt === "new-user")
          await f.extension.handlers.get("input")![0](
            { type: "input", text: "A different request", source: "interactive" },
            f.ctx,
          );
        await f.extension.handlers.get("before_agent_start")![0](
          { type: "before_agent_start", prompt: "A different request", systemPrompt: [] },
          f.ctx,
        );
        expect(await f.status()).toMatchObject(
          interrupt === "new-user"
            ? { status: "draining", outcome: "needs_user", steps: before.steps }
            : { status: "running", steps: before.steps, selectedAction: before.selectedAction },
        );
      }
      expect(f.counts()).toMatchObject({ decisions: 1, aborts: 0 });
    } finally {
      await f.close();
    }
  });
}

// Full native OMP child execution is covered by the separate native suites.

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
      status: "draining",
      outcome: "blocked",
      architect: { completionApproved: false },
    });
    expect(await f.stop()).toBeUndefined();
    expect(await f.stop()).toBeUndefined();
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 0 });
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
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 0 });
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
    expect(await f.status()).toMatchObject({ status: "draining", outcome: "blocked" });
    expect(await f.stop()).toBeUndefined();
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 0 });
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
    expect(await f.status()).toMatchObject({ status: "draining", outcome: "blocked" });
    await f.extension.commands.get("auto")!.handler("start fixture-change", f.ctx);
    expect(f.bootstraps).toHaveLength(1);
    expect(await f.settled()).toMatchObject({ status: "paused", outcome: "blocked" });
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
    expect(await f.status()).toMatchObject({ status: "draining", outcome: "budget_exhausted" });
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
    expect(f.counts()).toMatchObject({ decisions: 0, aborts: 0 });
  } finally {
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
    expect(await f.status()).toMatchObject({ status: "running", steps: "0" });
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
      expect(f.counts().aborts).toBe(aborts);
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
      expect(f.counts().aborts).toBe(aborts);
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
      const tag = (f.deliveries[0]!.details as { controller: string }).controller;
      const continuation = {
        role: "custom",
        customType: "session-stop-continuation",
        content: `Old continuation\n\nAuto continuation: ${tag}:retired-run:2`,
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
      expect(await f.status()).toMatchObject({ status: "draining", outcome: "needs_user" });
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
      expect(f.counts().aborts).toBe(0);
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
      status: "draining",
      outcome: "needs_user",
      steps: "0",
      decisions: 0,
      completionVerified: false,
    });
    expect(f.bootstraps).toHaveLength(1);
    expect(f.counts().decisions).toBe(0);
  } finally {
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
      status: "draining",
      outcome: "stalled",
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

// Pipeline-free action-selection contract. Assertions target observable native
// facts; no fixture-owned DAG or phase state is manufactured for the controller.
test("missing pipeline and auto-run still start; Jev receives exact native catalogue and selects a non-first skill", async () => {
  const f = await loaderFixture();
  try {
    await expect(
      fs.stat(path.join(f.cwd, "rasen/changes/fixture-change/auto-run.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await f.start();
    expect(f.journal().map((event) => event.kind)).toEqual(["run-start"]);
    expect(f.observed).toHaveLength(0);
    const boundary = await f.step();
    expect(boundary).toMatchObject({
      isError: false,
      action: { skill: { name: "rasen-verify-change" } },
    });
    const choices = f.observed[0].choices!;
    const skillOptions = Object.entries(choices).filter(([key]) => key.startsWith("skill_"));
    expect(skillOptions.map(([, criterion]) => criterion)).toEqual(
      [...f.skills]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((skill) => `Execute existing native skill ${skill.name}: ${skill.description}`),
    );
    expect(boundary.decision.choice).not.toBe(skillOptions[0][0]);
    expect(boundary.decision.criterion).toBe(choices[boundary.decision.choice]);
    expect(boundary.decision.evidenceRefs).toContain("change:fixture-0");
    expect(f.journal().map((event) => event.kind)).toEqual([
      "run-start",
      "action-selected",
      "action-admitted",
    ]);
    expect(boundary.instruction).toContain(`Auto action: ${boundary.action.actionId}`);
    expect(await f.status()).not.toHaveProperty("workflow");
  } finally {
    await f.close();
  }
});

for (const skill of ["rasen-apply-change", "rasen-verify-change", "pack/rasen-continue~2"]) {
  test(`all_done does not predetermine completion or prevent Jev choosing ${skill}`, async () => {
    const f = await loaderFixture();
    try {
      f.complete();
      f.choose(skill);
      await f.start();
      const boundary = await f.step();
      expect(boundary.action.skill.name).toBe(skill);
      expect(boundary.finishProposed).toBeUndefined();
      expect(await f.status()).toMatchObject({ status: "running", completionVerified: false });
      expect(JSON.parse(f.observed[0].summary).changeFacts.state).toBe("all_done");
    } finally {
      await f.close();
    }
  });
}

test("Jev selection precedes skill loading and admission; execution cannot race a pending selection", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        decision: () => async (facts) => {
          entered.resolve();
          await release.promise;
          return selectSkill(facts, "rasen-review-cycle");
        },
        skill: async (skill) => {
          reads++;
          return {
            ...skill,
            text: "Full selected review-cycle body",
            sha256: digest("Full selected review-cycle body"),
          };
        },
      },
    },
  );
  let pending: ReturnType<typeof f.step> | undefined;
  try {
    await f.start();
    pending = f.step();
    await entered.promise;
    expect(reads).toBe(0);
    expect(f.journal().map((event) => event.kind)).toEqual(["run-start"]);
    expect(await f.gate("write", { path: "early.txt", content: "Too early" })).toMatchObject({
      block: true,
    });
    release.resolve();
    const selected = await pending;
    expect(selected.action.skill.name).toBe("rasen-review-cycle");
    expect(reads).toBe(1);
  } finally {
    release.resolve();
    await pending;
    await f.close();
  }
});

test("legitimate task and skill-owned record updates retain one invocation until its boundary", async () => {
  let revision = 0;
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        snapshot: async () => ({
          ...snapshot(revision > 0 ? 1 : 0),
          fingerprint: `task-and-record-${revision}`,
          skillRecord: {
            kind: "valid",
            path: "/local-fixture/auto-run.json",
            sha256: digest(String(revision)),
            content: { rounds: revision },
          },
        }),
      },
    },
  );
  try {
    await f.start();
    const first = await f.step();
    revision++;
    const observed = await f.status();
    expect(observed.status).toBe("running");
    expect(observed.selectedAction.actionId).toBe(first.action.actionId);
    const again = await f.step("The existing skill is still executing");
    expect(again).toMatchObject({ cached: true, action: { actionId: first.action.actionId } });
    expect(f.observed).toHaveLength(1);
    await f.mainResult();
    f.choose("rasen-apply-change");
    const next = await f.finish(first.action.actionId, { status: "progress" });
    expect(next.action.skill.name).toBe("rasen-apply-change");
    expect(next.action.actionId).not.toBe(first.action.actionId);
    expect(f.journal().find((event) => event.kind === "action-settled")).toMatchObject({
      outcome: "progress",
      outputFingerprint: "task-and-record-1",
    });
  } finally {
    await f.close();
  }
});

test("a skill may create and update auto-run.json without a pipeline; native evidence stays usable", async () => {
  const f = await loaderFixture();
  try {
    f.choose("rasen-review-cycle");
    await f.start();
    const first = await f.step();
    const file = path.join(f.cwd, "rasen/changes/fixture-change/auto-run.json");
    const content = JSON.stringify({
      reviewCycle: { rounds: 2, state: "clean" },
      ui: { status: "reviewed" },
    });
    const id = crypto.randomUUID();
    const input = { path: file, content };
    expect(await f.gate("write", input, id)).toBeUndefined();
    await Bun.write(file, content);
    await f.toolResult("write", input, id, {
      content: [{ type: "text", text: "Wrote native skill report" }],
    });
    expect(await Bun.file(file).json()).not.toHaveProperty("pipeline");
    f.choose("rasen-verify-change");
    const next = await f.finish(first.action.actionId);
    expect(next).toMatchObject({
      isError: false,
      action: { skill: { name: "rasen-verify-change" } },
    });
    expect(await Bun.file(file).json()).toEqual(JSON.parse(content));
    expect(await f.status()).toMatchObject({
      status: "running",
      completionVerified: false,
      history: { valid: true },
    });
  } finally {
    await f.close();
  }
});

test("the same existing skill can be selected again as a distinct native action", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    const first = await f.step();
    await f.nativeResult();
    const next = await f.finish(first.action.actionId);
    expect(next).toMatchObject({
      isError: false,
      action: { skill: { name: first.action.skill.name } },
    });
    expect(next.action.actionId).not.toBe(first.action.actionId);
    const records = f.journal();
    expect(records.filter((event) => event.kind === "action-admitted")).toHaveLength(2);
    expect(records.filter((event) => event.kind === "action-settled")).toHaveLength(1);
    expect(
      records.find((event) => event.kind === "action-settled").nativeReceipts[0].artifactRef,
    ).toStartWith("artifact://");
  } finally {
    await f.close();
  }
});

test("the complete review-cycle remains one action across native reviewer and worker rounds", async () => {
  const f = await loaderFixture();
  try {
    f.choose("rasen-review-cycle");
    await f.start();
    const first = await f.step();
    expect(first.instruction).toContain("Do not checkpoint the skill's internal review/fix rounds");
    await f.nativeResult({ role: "omp-reviewer", output: "Round 1: concrete findings" });
    await f.nativeResult({ role: "omp-worker", output: "Round 1: fixes and tests" });
    await f.nativeResult({
      role: "omp-reviewer",
      output: "Round 2: accepted-known minor findings, no blocking issue",
    });
    expect((await f.step()).action.actionId).toBe(first.action.actionId);
    expect(f.counts().decisions).toBe(1);
    expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(1);
    f.choose("finish");
    expect(await f.finish(first.action.actionId)).toMatchObject({
      finishProposed: true,
      decision: { choice: "finish" },
    });
    expect(f.journal().filter((event) => event.kind === "action-settled")).toHaveLength(1);
    expect(await f.status()).toMatchObject({
      architect: { attempts: { completion: 0 } },
      completionVerified: false,
    });
  } finally {
    await f.close();
  }
});

for (const changed of ["snapshot", "catalogue"] as const) {
  test(`a Jev choice is refused when ${changed} changes in flight, without admitting stale work`, async () => {
    let revision = 0;
    let fixture: Awaited<ReturnType<typeof loaderFixture>>;
    fixture = await loaderFixture(
      {},
      {
        dependencies: {
          snapshot: async () => ({ ...snapshot(), fingerprint: `revision-${revision}` }),
          decision: () => async (facts) => {
            const selected = selectSkill(facts, "rasen-verify-change");
            if (changed === "snapshot") revision++;
            else fixture.skills[0].description = "Changed native description";
            return selected;
          },
        },
      },
    );
    try {
      await fixture.start();
      expect(await fixture.step()).toMatchObject({
        isError: true,
        error: expect.stringContaining("changed during selection"),
      });
      expect(fixture.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
      expect(await fixture.status()).toMatchObject({ status: "running", selectedAction: null });
    } finally {
      await fixture.close();
    }
  });
}

test("unknown Jev choices and stale action results cannot admit or settle work", async () => {
  const f = await loaderFixture();
  try {
    f.choose("unknown_native_skill");
    await f.start();
    expect((await f.step()).isError).toBe(true);
    expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
    expect(await f.settled()).toMatchObject({ completionVerified: false });
  } finally {
    await f.close();
  }
  const g = await loaderFixture();
  try {
    await g.start();
    const selected = await g.step();
    await g.mainResult();
    expect(await g.finish(`stale-${selected.action.actionId}`)).toMatchObject({ isError: true });
    expect(g.journal().filter((event) => event.kind === "action-settled")).toHaveLength(0);
  } finally {
    await g.close();
  }
});

for (const proof of ["bare", "status", "step", "removed-record", "unadmitted-task"] as const) {
  test(`${proof} cannot manufacture native execution proof for Main's action result`, async () => {
    const f = await loaderFixture();
    try {
      await f.start();
      const selected = await f.step();
      if (proof === "status") await f.mainResult("auto_status", {}, "Success");
      if (proof === "step")
        await f.mainResult("auto_step", { summary: "Claim progress" }, "Success");
      if (proof === "removed-record") {
        expect(f.extension.tools.has("auto_record")).toBe(false);
        await f.toolResult("auto_record", {}, "invented-record", {
          content: [{ type: "text", text: "Success" }],
        });
      }
      if (proof === "unadmitted-task") {
        f.registerNativeChild("unadmitted");
        await f.toolResult("task", {}, "never-admitted", {
          content: [{ type: "text", text: "Success" }],
          details: {
            results: [{ id: "unadmitted", agent: "omp-reviewer", exitCode: 0, output: "Success" }],
          },
        });
      }
      expect(await f.finish(selected.action.actionId)).toMatchObject({
        isError: true,
        error: expect.stringContaining("actual native tool/task evidence"),
      });
      expect(f.journal().filter((event) => event.kind === "action-settled")).toHaveLength(0);
      expect(await f.status()).toMatchObject({ completionVerified: false });
    } finally {
      await f.close();
    }
  });
}

for (const finishChoice of [false, true]) {
  test(`all_done at stop ${finishChoice ? "can complete only after explicit finish selection" : "cannot self-complete without Jev finish"}`, async () => {
    const f = await loaderFixture();
    try {
      f.complete();
      await f.start();
      if (finishChoice) {
        f.choose("finish");
        expect((await f.step()).finishProposed).toBe(true);
      }
      await f.stop();
      expect(await f.settled()).toMatchObject({
        status: finishChoice ? "completed" : "paused",
        outcome: finishChoice ? "completed" : "needs_user",
        completionVerified: finishChoice,
        architect: { completionApproved: false, attempts: { completion: 0 } },
      });
    } finally {
      await f.close();
    }
  });
}

for (const fresh of [true, false]) {
  test(`finish waits detached Main settlement and ${fresh ? "certifies fresh" : "rejects changed"} evidence`, async () => {
    const idle = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    let changed = false;
    const f = await loaderFixture(
      {},
      {
        dependencies: {
          snapshot: async () => ({
            ...snapshot(2),
            fingerprint: changed ? "changed-after-finish" : "stable",
          }),
        },
      },
    );
    f.nativeSession.waitForIdle = async () => {
      waiting.resolve();
      await idle.promise;
    };
    try {
      await f.start();
      f.choose("finish");
      expect((await f.step()).finishProposed).toBe(true);
      await f.stop();
      await waiting.promise;
      expect(await f.status()).toMatchObject({ status: "draining", completionVerified: false });
      changed = !fresh;
      idle.resolve();
      expect(await f.settled()).toMatchObject({
        status: fresh ? "completed" : "paused",
        completionVerified: fresh,
      });
      expect(f.counts().aborts).toBe(0);
    } finally {
      idle.resolve();
      await f.close();
    }
  });
}

test("pending native work prevents both action settlement and an additional Jev decision", async () => {
  const f = await loaderFixture();
  const work = Promise.withResolvers<string>();
  try {
    await f.start();
    const first = await f.step();
    const id = f.nativeManager.register("bash", "native work", async () => work.promise, {
      ownerId: "main",
    });
    expect(await f.finish(first.action.actionId)).toMatchObject({
      pending: true,
      action: { actionId: first.action.actionId },
    });
    expect(f.counts().decisions).toBe(1);
    expect(f.journal().filter((event) => event.kind === "action-settled")).toHaveLength(0);
    work.resolve("Done");
    await f.nativeManager.getJob(id)!.promise;
    await f.mainResult();
    f.choose("finish");
    expect((await f.finish(first.action.actionId)).finishProposed).toBe(true);
  } finally {
    work.resolve("cleanup");
    await f.close();
  }
});

test("held action recovery offers resume from native history without a pipeline or reset", async () => {
  const f = await loaderFixture();
  try {
    f.choose("rasen-review-cycle");
    await f.start();
    const initial = await f.step();
    await f.mainResult();
    await f.extension.commands.get("auto")!.handler("stop", f.ctx);
    await f.settled();
    expect(f.journal().find((event) => event.kind === "action-held")).toMatchObject({
      actionId: initial.action.actionId,
      skill: "rasen-review-cycle",
    });
    f.choose("resume");
    await f.start();
    const resumed = await f.step();
    expect(resumed).toMatchObject({
      isError: false,
      decision: { choice: "resume" },
      action: { skill: { name: "rasen-review-cycle" } },
    });
    expect(resumed.action.actionId).not.toBe(initial.action.actionId);
    expect(resumed.instruction).toContain(initial.action.actionId);
    expect(resumed.instruction).toContain("do not reset counters or replay uncertain side effects");
  } finally {
    await f.close();
  }
});

test("normal authorization denial still pauses a selected ship skill without fallback", async () => {
  const f = await loaderFixture();
  try {
    f.choose("rasen-ship");
    await f.start();
    expect((await f.step()).action.skill.name).toBe("rasen-ship");
    expect(f.bootstraps[0]).toContain("no available skill is blanket-authorized");
    await f.extension.handlers.get("tool_approval_resolved")![0](
      { type: "tool_approval_resolved", approved: false },
      f.ctx,
    );
    expect(await f.settled()).toMatchObject({
      status: "paused",
      outcome: "needs_user",
      completionVerified: false,
    });
    expect(f.counts().decisions).toBe(1);
    expect((await f.step()).isError).toBe(true);
  } finally {
    await f.close();
  }
});

test("Auto step Eval carriers accept only one reset-safe literal action boundary", () => {
  const input = {
    path: "xd://auto_step",
    content: JSON.stringify({ summary: "Inspect current skill evidence" }),
  };
  const literal = `await tool.write(${JSON.stringify(input)})`;
  expect(autoStepCarrier({ language: "js", reset: true, code: literal })).toBe(true);
  expect(autoStepCarrier({ language: "js", reset: true, code: `console.log(${literal});` })).toBe(
    true,
  );
  const result = {
    summary: "Skill reports progress",
    result: { actionId: "current-action", status: "progress", note: "Native evidence is ready" },
  };
  expect(
    autoStepCarrier({
      language: "js",
      reset: true,
      code: `await tool.write(${JSON.stringify({ ...input, content: JSON.stringify(result) })})`,
    }),
  ).toBe(true);
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
    ...["stage", "transition", "leadReview", "outcome"].map((key) => ({
      language: "js",
      reset: true,
      code: `await tool.write(${JSON.stringify({ ...input, content: JSON.stringify({ summary: "Obsolete controller field", [key]: "verify" }) })})`,
    })),
  ])
    expect(autoStepCarrier(candidate)).toBe(false);
});

test("Auto action fallback retains the configured Architect deadline past 40 seconds", async () => {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ choice: string; confidence: number }>();
  let fallbackSignal: AbortSignal | undefined;
  let choice = "";
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        decision: () => async (facts) => ({
          ...selectSkill(facts, "rasen-verify-change"),
          confidence: 0.58,
        }),
        fallback: () => async (facts, signal) => {
          choice = selectSkill(facts, "rasen-verify-change").choice;
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
    response.resolve({ choice, confidence: 0.95 });
    expect(await pending).toMatchObject({
      action: { skill: { name: "rasen-verify-change" } },
      isError: false,
    });
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
    response.resolve({ choice, confidence: 0.95 });
    jest.useRealTimers();
    await pending;
    await f.close();
  }
});

for (const interrupt of ["stop", "input", "session"] as const) {
  test(`delayed skill loading cannot admit an action after ${interrupt}`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = await loaderFixture(
      {},
      {
        dependencies: {
          skill: async (skill) => {
            entered.resolve();
            await release.promise;
            return {
              ...skill,
              text: "Complete selected skill body",
              sha256: digest("Complete selected skill body"),
            };
          },
        },
      },
    );
    let pending: ReturnType<typeof f.step> | undefined;
    try {
      await f.start();
      pending = f.step();
      await entered.promise;
      if (interrupt === "stop") await f.extension.commands.get("auto")!.handler("stop", f.ctx);
      else if (interrupt === "input")
        await f.extension.handlers.get("input")![0](
          { type: "input", text: "New user request", source: "interactive" },
          f.ctx,
        );
      else
        await f.extension.handlers.get("session_switch")![0](
          { type: "session_switch", reason: "resume" },
          f.ctx,
        );
      release.resolve();
      expect(await pending).toMatchObject({ isError: true });
      expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
      expect(f.bootstraps).toHaveLength(1);
      expect(f.counts().aborts).toBe(0);
    } finally {
      release.resolve();
      await pending;
      await f.close();
    }
  });
}

for (const interrupt of ["stop", "input"] as const) {
  test(`late admitted native results after ${interrupt} are retained without resuming or self-completing`, async () => {
    const f = await loaderFixture();
    const body = Promise.withResolvers<string>();
    try {
      await f.start();
      const first = await f.step();
      const taskId = crypto.randomUUID();
      expect(
        await f.gate(
          "task",
          {
            agent: "omp-reviewer",
            task: `Auto action: ${first.action.actionId}\nInspect native evidence`,
            model: first.action.admission.roleRoutes["omp-reviewer"].selector,
            solutionSpace: "Scoped evidence",
          },
          taskId,
        ),
      ).toBeUndefined();
      const jobId = f.nativeManager.register(
        "bash",
        "fixture native pending work",
        async () => body.promise,
        { ownerId: "main" },
      );
      if (interrupt === "stop") await f.extension.commands.get("auto")!.handler("stop", f.ctx);
      else
        await f.extension.handlers.get("input")![0](
          { type: "input", text: "New request wins", source: "interactive" },
          f.ctx,
        );
      expect(await f.status()).toMatchObject({ status: "draining", nativeWork: { pending: true } });
      await f.nativeResult({
        id: taskId,
        admitted: true,
        output: "Late native evidence remains available",
      });
      body.resolve("Native job finished");
      await f.nativeManager.getJob(jobId)!.promise;
      expect(await f.settled()).toMatchObject({
        status: "paused",
        completionVerified: false,
        selectedAction: { actionId: first.action.actionId },
      });
      expect(f.journal().filter((event) => event.kind === "action-settled")).toHaveLength(0);
      const held = f.journal().find((event) => event.kind === "action-held");
      expect(held.nativeReceipts[0].count).toBe(1);
      const bundlePath = await f.ctx.sessionManager.getArtifactPath(
        held.nativeReceipts[0].artifactRef.slice("artifact://".length),
      );
      expect(bundlePath).toBeTruthy();
      const bundleText = await Bun.file(bundlePath!).text();
      expect(digest(bundleText)).toBe(held.nativeReceipts[0].sha256);
      const bundle = JSON.parse(bundleText);
      expect(bundle).toMatchObject({
        actionId: first.action.actionId,
        receipts: [
          {
            agentId: taskId,
            role: "omp-reviewer",
          },
        ],
      });
      expect(typeof bundle.receipts[0].artifactRef).toBe("string");
      expect(bundle.receipts[0].artifactRef).toStartWith("artifact://");
      const evidencePath = await f.ctx.sessionManager.getArtifactPath(
        bundle.receipts[0].artifactRef.slice("artifact://".length),
      );
      expect(evidencePath).toBeTruthy();
      const retained = await Bun.file(evidencePath!).text();
      expect(retained).toBe("Late native evidence remains available");
      expect(digest(retained)).toBe(bundle.receipts[0].artifactSha256);
      expect(f.counts()).toMatchObject({ decisions: 1, aborts: 0 });
      expect(f.bootstraps).toHaveLength(1);
      expect((await f.step()).isError).toBe(true);
    } finally {
      body.resolve("cleanup");
      await f.close();
    }
  });
}

for (const kind of ["deadline", "no-output"] as const) {
  test(`the real ${kind} timer holds idle Auto without waiting for another tool call`, async () => {
    const f = await loaderFixture(
      kind === "deadline"
        ? { maxDurationMs: 1000, noOutputTimeoutMs: 2000 }
        : { noOutputTimeoutMs: 1000 },
    );
    try {
      await f.start();
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await f.settled()).toMatchObject({
        status: "paused",
        outcome: kind === "deadline" ? "budget_exhausted" : "stalled",
        completionVerified: false,
      });
      expect(f.counts()).toMatchObject({ decisions: 0, aborts: 0 });
    } finally {
      await f.close();
    }
  });
}

for (const route of [
  "auto_record",
  "xd://auto_record",
  "[xd://auto_record#ABCD]",
  "XD://auto_record:raw",
  "opaque-eval",
] as const) {
  test(`${route} cannot supply self-minted controller execution proof`, async () => {
    const f = await loaderFixture();
    try {
      await f.start();
      const selected = await f.step();
      const tool =
        route === "auto_record" ? "auto_record" : route === "opaque-eval" ? "eval" : "write";
      const input =
        route === "auto_record"
          ? { facts: "Controller bookkeeping only" }
          : route === "opaque-eval"
            ? { language: "js", reset: true, code: "console.log('Controller bookkeeping only')" }
            : { path: route, content: "Controller bookkeeping only" };
      const id = crypto.randomUUID();
      expect(await f.gate(tool, input, id)).toBeUndefined();
      await f.toolResult(tool, input, id, {
        content: [{ type: "text", text: "Controller bookkeeping recorded" }],
      });
      expect((await f.status()).selectedAction.mainReceipts).toEqual([]);
      expect(await f.finish(selected.action.actionId)).toMatchObject({
        isError: true,
        error: expect.stringContaining("actual native tool/task evidence"),
      });
    } finally {
      await f.close();
    }
  });
}

for (const successful of [false, true]) {
  test(`Main's native command result ${successful ? "supports factual action progress" : "cannot turn failure into successful action progress"}`, async () => {
    const f = await loaderFixture();
    try {
      await f.start();
      const selected = await f.step();
      const id = crypto.randomUUID();
      const input = { command: "Run the selected skill's scoped native verification" };
      expect(await f.gate("bash", input, id)).toBeUndefined();
      await f.toolResult("bash", input, id, {
        isError: !successful,
        content: [
          { type: "text", text: successful ? "Scoped checks passed" : "Scoped command failed" },
        ],
      });
      expect((await f.status()).selectedAction.mainReceipts).toMatchObject([
        { toolCallId: id, tool: "bash", isError: !successful, sha256: expect.any(String) },
      ]);
      f.choose("rasen-apply-change");
      const next = await f.finish(selected.action.actionId, { status: "progress" });
      expect(next.isError).toBe(!successful);
      expect(f.journal().filter((event) => event.kind === "action-settled")).toHaveLength(
        successful ? 1 : 0,
      );
      expect(await f.status()).toMatchObject({ completionVerified: false });
    } finally {
      await f.close();
    }
  });
}

test("native action leaves preserve role selectors and admitted queued spawns across a scheduling hold", async () => {
  const f = await loaderFixture();
  const queued = Promise.withResolvers<string>();
  const models = ["worker", "reviewer", "explorer"].map((id) => ({
    ...f.nativeSession.model!,
    provider: "fixture",
    id,
    reasoning: true,
    thinking: { efforts: ["low", "high", "xhigh"] },
  }));
  const selectors: Record<string, string> = {
    implementation: "fixture/worker:xhigh",
    architect: "fixture/reviewer:high",
    research: "fixture/explorer:low",
  };
  Object.defineProperty(f.nativeSession, "settings", {
    value: { getModelRole: (role: string) => selectors[role] },
  });
  f.ctx.models.resolve = ((selector: string) => {
    const expanded = selector.startsWith("@") ? selectors[selector.slice(1)] : selector;
    return models.find((model) => expanded?.split(":")[0] === `${model.provider}/${model.id}`);
  }) as typeof f.ctx.models.resolve;
  try {
    await f.start();
    const selected = await f.step();
    expect(selected.action.admission.roleRoutes).toMatchObject({
      "omp-worker": { selector: selectors.implementation, thinkingLevel: "xhigh" },
      "omp-reviewer": { selector: selectors.architect, thinkingLevel: "high" },
      "omp-explorer": { selector: selectors.research, thinkingLevel: "low" },
    });
    const tasks = ["omp-worker", "omp-reviewer"].map((agent, index) => ({
      agent,
      name: `queued-${index}`,
      task: `Auto action: ${selected.action.actionId}\nExecute a scoped leaf`,
      model: selected.action.admission.roleRoutes[agent].selector,
      solutionSpace: "Scoped native work",
    }));
    expect(await f.gate("task", { tasks }, "parallel-call")).toBeUndefined();
    const job = f.nativeManager.register("task", "queued native task", async () => queued.promise, {
      ownerId: "main",
    });
    await f.extension.commands.get("auto")!.handler("stop", f.ctx);
    const spawn = f.extension.handlers.get("before_subagent_spawn")![0];
    for (const task of tasks)
      expect(
        await spawn(
          {
            type: "before_subagent_spawn",
            agent: task.agent,
            invocationKind: "task",
            spawnKey: task.name,
            patterns: [task.model],
          },
          f.ctx,
        ),
      ).toMatchObject({ model: task.model });
    expect(
      await spawn(
        {
          type: "before_subagent_spawn",
          agent: "omp-worker",
          invocationKind: "task",
          spawnKey: "unadmitted",
          patterns: [],
        },
        f.ctx,
      ),
    ).toMatchObject({ block: true });
    expect(await f.gate("task", tasks[0])).toMatchObject({ block: true });
    queued.resolve("Native queue drained normally");
    await f.nativeManager.getJob(job)!.promise;
    expect(await f.settled()).toMatchObject({ status: "paused", completionVerified: false });
    expect(f.counts()).toMatchObject({ decisions: 1, aborts: 0 });
  } finally {
    queued.resolve("cleanup");
    await f.close();
  }
});

for (const during of ["decision", "skill-loading"] as const) {
  test(`native Auto history changes during ${during} invalidate the pending selection even after status refresh`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let first = true;
    const f = await loaderFixture(
      {},
      {
        dependencies: {
          decision: () => async (facts) => {
            if (during === "decision" && first) {
              first = false;
              entered.resolve();
              await release.promise;
            }
            return selectSkill(facts, "rasen-verify-change");
          },
          skill: async (skill) => {
            if (during === "skill-loading" && first) {
              first = false;
              entered.resolve();
              await release.promise;
            }
            return {
              ...skill,
              text: "Complete selected skill body",
              sha256: digest("Complete selected skill body"),
            };
          },
        },
      },
    );
    let pending: ReturnType<typeof f.step> | undefined;
    try {
      await f.start();
      pending = f.step();
      await entered.promise;
      const start = f.journal()[0];
      f.appendJournal({
        ...start,
        eventId: crypto.randomUUID(),
        kind: "action-held",
        actionId: crypto.randomUUID(),
        skill: "rasen-apply-change",
        reason: "Another native observation records unresolved prior action evidence",
      });
      expect(await f.status()).toMatchObject({ history: { valid: true, records: 2 } });
      release.resolve();
      expect(await pending).toMatchObject({ isError: true });
      expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
      expect(await f.status()).toMatchObject({
        status: "running",
        selectedAction: null,
        steps: "0",
        history: { valid: true },
      });
      const retry = await f.step("Reconsider the new native evidence");
      expect(retry).toMatchObject({
        isError: false,
        action: { skill: { name: "rasen-verify-change" } },
      });
      expect(await f.status()).toMatchObject({ steps: "1", history: { valid: true } });
    } finally {
      release.resolve();
      await pending;
      await f.close();
    }
  });
}

test("workspace changes observed by status during skill loading cannot mismatch action journal fingerprints", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let revision = 0;
  let first = true;
  const f = await loaderFixture(
    {},
    {
      dependencies: {
        snapshot: async () => ({ ...snapshot(), fingerprint: `workspace-${revision}` }),
        skill: async (skill) => {
          if (first) {
            first = false;
            entered.resolve();
            await release.promise;
          }
          return {
            ...skill,
            text: "Complete selected skill body",
            sha256: digest("Complete selected skill body"),
          };
        },
      },
    },
  );
  let pending: ReturnType<typeof f.step> | undefined;
  try {
    await f.start();
    pending = f.step();
    await entered.promise;
    revision = 1;
    expect(await f.status()).toMatchObject({ selectedAction: null, history: { valid: true } });
    release.resolve();
    expect(await pending).toMatchObject({ isError: true });
    expect(
      f
        .journal()
        .filter((event) => event.kind === "action-selected" || event.kind === "action-admitted"),
    ).toHaveLength(0);
    expect(await f.status()).toMatchObject({
      status: "running",
      steps: "0",
      history: { valid: true },
    });
    const retry = await f.step("Choose again from the new workspace");
    expect(retry.action.admission.inputFingerprint).toBe("workspace-1");
    await f.mainResult();
    f.choose("finish");
    expect(await f.finish(retry.action.actionId)).toMatchObject({
      isError: false,
      finishProposed: true,
    });
    const actionRecords = f.journal().filter((event) => event.actionId === retry.action.actionId);
    expect(actionRecords.map((event) => event.kind)).toEqual([
      "action-selected",
      "action-admitted",
      "action-settled",
    ]);
    expect(actionRecords.every((event) => event.inputFingerprint === "workspace-1")).toBe(true);
    expect(await f.status()).toMatchObject({
      steps: "1",
      history: { valid: true, diagnostics: [] },
    });
    await f.stop();
    expect(await f.settled()).toMatchObject({
      status: "completed",
      completionVerified: true,
      history: { valid: true },
    });
  } finally {
    release.resolve();
    await pending;
    await f.close();
  }
});

for (const next of ["finish", "rasen-verify-change"] as const) {
  test(`maxSteps two admits exactly two actions and ${next === "finish" ? "permits uncharged finish selection" : "refuses a third admission"}`, async () => {
    const f = await loaderFixture({ maxSteps: 2 });
    try {
      await f.start();
      expect(await f.status()).toMatchObject({ steps: "0/2" });
      const first = await f.step();
      expect(await f.status()).toMatchObject({ steps: "1/2" });
      expect((await f.step("Same action, no extra admission")).action.actionId).toBe(
        first.action.actionId,
      );
      expect(await f.status()).toMatchObject({ steps: "1/2" });
      await f.mainResult();
      const second = await f.finish(first.action.actionId);
      expect(second.action.actionId).not.toBe(first.action.actionId);
      expect(await f.status()).toMatchObject({ steps: "2/2" });
      await f.mainResult();
      f.choose(next);
      const last = await f.finish(second.action.actionId);
      expect(last.isError).toBe(next !== "finish");
      if (next === "finish") {
        expect(last.finishProposed).toBe(true);
        await f.stop();
      }
      expect(await f.settled()).toMatchObject({
        steps: "2/2",
        outcome: next === "finish" ? "completed" : "budget_exhausted",
        completionVerified: next === "finish",
      });
      expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(2);
      expect(f.journal().filter((event) => event.kind === "action-settled")).toHaveLength(2);
    } finally {
      await f.close();
    }
  });
}

for (const boundary of ["finish", "skill-failure"] as const) {
  test(`${boundary} does not charge an unadmitted action`, async () => {
    const f = await loaderFixture(
      { maxSteps: 2 },
      boundary === "skill-failure"
        ? {
            dependencies: {
              skill: async () => {
                throw new Error("Synthetic skill body failure");
              },
            },
          }
        : {},
    );
    try {
      await f.start();
      if (boundary === "finish") f.choose("finish");
      const result = await f.step();
      expect(result.isError).toBe(boundary === "skill-failure");
      expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
      expect(await f.status()).toMatchObject({ steps: "0/2" });
    } finally {
      await f.close();
    }
  });
}

for (const complete of [false, true]) {
  for (const outcome of ["failed", "blocked"] as const) {
    test(`maxStalls one admits initial work but stops an unchanged ${complete ? "all_done" : "ready"} action reported ${outcome}`, async () => {
      const f = await loaderFixture({ maxStalls: 1 });
      try {
        if (complete) f.complete();
        await f.start();
        expect(await f.status()).toMatchObject({ steps: "0", stalls: "0/1" });
        const first = await f.step();
        expect(first).toMatchObject({
          isError: false,
          action: { skill: { name: "rasen-verify-change" } },
        });
        expect(await f.status()).toMatchObject({ status: "running", steps: "1", stalls: "0/1" });
        expect((await f.step("Read-only check of the same invocation")).action.actionId).toBe(
          first.action.actionId,
        );
        const repeated = await f.finish(first.action.actionId, {
          status: outcome,
          note: "The selected skill made no progress; the existing evidence is unchanged",
        });
        expect(repeated.isError).toBe(true);
        expect(await f.settled()).toMatchObject({
          status: "paused",
          outcome: "stalled",
          steps: "1",
          stalls: "1/1",
          completionVerified: false,
        });
        expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(1);
        expect(f.journal().filter((event) => event.kind === "action-settled")).toMatchObject([
          { actionId: first.action.actionId, outcome },
        ]);
        expect((await f.step()).isError).toBe(true);
        expect(f.bootstraps).toHaveLength(1);
      } finally {
        await f.close();
      }
    });
  }
}

for (const provider of ["jev", "fallback"] as const) {
  test(`accepted ${provider} needs_user retains its exact criterion and confidence in native stop history`, async () => {
    let supplied: DecisionEvidence | undefined;
    const confidence = provider === "jev" ? 0.97 : 0.93;
    const f = await loaderFixture(
      {},
      {
        dependencies: {
          decision: () => async (facts) => {
            supplied = structuredClone(facts);
            return provider === "jev"
              ? { choice: "needs_user", confidence }
              : { ...selectSkill(facts, "rasen-verify-change"), confidence: 0.51 };
          },
          fallback: () => async (facts) => {
            supplied = structuredClone(facts);
            return { choice: "needs_user", confidence };
          },
        },
      },
    );
    try {
      await f.start();
      expect((await f.step()).isError).toBe(true);
      const status = await f.settled();
      expect(status).toMatchObject({
        status: "paused",
        outcome: "needs_user",
        steps: "0",
        completionVerified: false,
        lastDecision: {
          choice: "needs_user",
          criterion: supplied!.choices!.needs_user,
          confidence,
        },
      });
      const stop = f.journal().find((event) => event.kind === "run-stop");
      expect(stop.decision).toEqual(status.lastDecision);
      expect(stop.decision.evidenceRefs).toContain("change:fixture-0");
      expect(
        stop.decision.evidenceRefs.some((ref: string) => ref.startsWith("native-event:")),
      ).toBe(true);
      expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
    } finally {
      await f.close();
    }
  });
}

for (const when of ["before-stop", "during-drain", "after-completion"] as const) {
  test(`native history changed ${when} invalidates a finish proposal without resuming Auto`, async () => {
    const f = await loaderFixture();
    const idle = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<void>();
    if (when === "during-drain")
      f.nativeSession.waitForIdle = async () => {
        waiting.resolve();
        await idle.promise;
      };
    try {
      await f.start();
      f.choose("finish");
      expect(await f.step()).toMatchObject({ isError: false, finishProposed: true });
      if (when !== "before-stop") {
        await f.stop();
        if (when === "during-drain") {
          await waiting.promise;
          expect(await f.status()).toMatchObject({
            status: "draining",
            outcome: "completed",
            completionVerified: false,
          });
        } else {
          expect(await f.settled()).toMatchObject({
            status: "completed",
            completionVerified: true,
          });
          // The controller's own terminal journal append is included in its
          // completion binding, so a second diagnostic still verifies it.
          expect(await f.status()).toMatchObject({ status: "completed", completionVerified: true });
        }
      }
      const start = f.journal()[0];
      f.appendJournal({
        ...start,
        eventId: crypto.randomUUID(),
        kind: "action-held",
        actionId: crypto.randomUUID(),
        skill: "rasen-review-cycle",
        reason: "New native review evidence requires attention after the finish proposal",
      });
      expect(await f.status()).toMatchObject({
        completionVerified: false,
        history: { valid: true },
      });
      if (when === "before-stop") await f.stop();
      idle.resolve();
      expect(await f.settled()).toMatchObject({
        status: when === "after-completion" ? "completed" : "paused",
        completionVerified: false,
      });
      expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
      expect(f.counts()).toMatchObject({ decisions: 1, aborts: 0 });
      expect(f.bootstraps).toHaveLength(1);
      expect((await f.step()).isError).toBe(true);
    } finally {
      idle.resolve();
      await f.close();
    }
  });
}

for (const scenario of ["decision-skill", "decision-finish", "body-skill"] as const) {
  test(`native work arriving during ${scenario} defers admission and finishing until a new quiescent selection`, async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const jobBody = Promise.withResolvers<string>();
    let first = true;
    let selections = 0;
    const f = await loaderFixture(
      {},
      {
        dependencies: {
          decision: () => async (facts) => {
            selections++;
            if (scenario.startsWith("decision") && first) {
              first = false;
              entered.resolve();
              await release.promise;
            }
            return scenario === "decision-finish"
              ? { choice: "finish", confidence: 0.99 }
              : selectSkill(facts, "rasen-verify-change");
          },
          skill: async (skill) => {
            if (scenario === "body-skill" && first) {
              first = false;
              entered.resolve();
              await release.promise;
            }
            return {
              ...skill,
              text: "Complete selected skill body",
              sha256: digest("Complete selected skill body"),
            };
          },
        },
      },
    );
    let pending: ReturnType<typeof f.step> | undefined;
    try {
      await f.start();
      pending = f.step();
      await entered.promise;
      const jobId = f.nativeManager.register(
        "bash",
        "New native work admitted by the host",
        async () => jobBody.promise,
        { ownerId: "main" },
      );
      release.resolve();
      const deferred = await pending;
      expect(deferred).toMatchObject({ pending: true, isError: false });
      expect(deferred.finishProposed).toBeUndefined();
      expect(deferred.action).toBeUndefined();
      expect(await f.status()).toMatchObject({
        status: "running",
        selectedAction: null,
        steps: "0",
        completionVerified: false,
        nativeWork: { pending: true },
      });
      expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
      expect(await f.step("Still waiting for the existing native job")).toMatchObject({
        pending: true,
      });
      expect(selections).toBe(1);
      jobBody.resolve("Native work is now settled");
      await f.nativeManager.getJob(jobId)!.promise;
      const retry = await f.step("Reconsider after normal native settlement");
      expect(retry.isError).toBe(false);
      expect(selections).toBe(2);
      if (scenario === "decision-finish") {
        expect(retry.finishProposed).toBe(true);
        expect(await f.status()).toMatchObject({ steps: "0", selectedAction: null });
      } else {
        expect(retry.action.skill.name).toBe("rasen-verify-change");
        expect(await f.status()).toMatchObject({ steps: "1" });
      }
      expect(f.nativeManager.isJobResultConsumed(jobId)).toBe(false);
      expect(f.counts().aborts).toBe(0);
    } finally {
      release.resolve();
      jobBody.resolve("cleanup");
      await pending;
      await f.close();
    }
  });
}

test("a newer replan choice revokes an earlier finish proposal and preserves recovery gating", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    f.choose("finish");
    expect(await f.step()).toMatchObject({ finishProposed: true, decision: { choice: "finish" } });
    f.choose("replan");
    expect(await f.step("New evidence requires recovery before completion")).toMatchObject({
      decision: { choice: "replan" },
    });
    expect(await f.status()).toMatchObject({
      status: "running",
      steps: "0",
      completionVerified: false,
      architect: { pendingRecovery: true, attempts: { completion: 0, recovery: 0 } },
    });
    await f.stop();
    expect(await f.settled()).toMatchObject({
      status: "paused",
      outcome: "needs_user",
      completionVerified: false,
      architect: { pendingRecovery: true },
    });
    expect(f.journal().find((event) => event.kind === "run-stop").decision.choice).toBe("replan");
    expect(f.counts().decisions).toBe(2);
  } finally {
    await f.close();
  }
});

test("Jev finish cannot bypass an existing pending recovery gate", async () => {
  const f = await loaderFixture();
  try {
    await f.start();
    f.choose("replan");
    expect(await f.step()).toMatchObject({ decision: { choice: "replan" } });
    f.choose("finish");
    const proposed = await f.step("Ask whether the requested outcome is complete");
    expect(proposed).toMatchObject({ blocked: true, decision: { choice: "finish" } });
    expect(proposed.finishProposed).toBeUndefined();
    expect(await f.status()).toMatchObject({
      status: "running",
      steps: "0",
      completionVerified: false,
      architect: { pendingRecovery: true, attempts: { completion: 0, recovery: 0 } },
    });
    await f.stop();
    expect(await f.settled()).toMatchObject({
      status: "paused",
      outcome: "needs_user",
      completionVerified: false,
    });
    expect(f.journal().filter((event) => event.kind === "action-admitted")).toHaveLength(0);
    expect(f.counts().decisions).toBe(2);
  } finally {
    await f.close();
  }
});

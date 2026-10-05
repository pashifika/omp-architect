import { expect, spyOn, test } from "bun:test";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
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
  type ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { extensionFactory } from "../src/extension.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";
import { fallbackWorkflow } from "../src/auto/workflow.ts";
import { withAgentDir } from "./isolated-host.ts";

type Mode =
  | "success"
  | "prompt"
  | "deny"
  | "held-yield"
  | "child-abort"
  | "recursion"
  | "nested-bash"
  | "messages";
type NativeEvent = {
  id: string;
  event: {
    type: string;
    toolName?: string;
    isError?: boolean;
    result?: { content?: Array<{ type: string; text?: string }> };
  };
};
type NativeLifecycle = {
  id: string;
  parentToolCallId?: string;
  detached?: boolean;
  status: string;
};

/**
 * Real task tool, agent discovery/routing, child loop, approvals and cancellation.
 * Only the fixture child's journal backend is swapped to the SDK's supported
 * MemorySessionStorage: this container denies native OS publish locks with EPERM.
 * This does not claim to verify persistent child journals or OS file locking.
 */
async function nativeFixture(
  mode: Mode,
  options: {
    detached?: boolean;
    mainMode?: "pause" | "wait" | "stream";
    parked?: boolean;
    verification?: boolean;
    activeSteering?: boolean;
  } = {},
) {
  const detached = options.detached ?? false;
  const mainMode = options.mainMode ?? "pause";
  const verification = options.verification ?? false;
  const activeSteering = options.activeSteering ?? false;
  const agent = verification ? "omp-reviewer" : "omp-worker";
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-native-"));
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (mode === "nested-bash") {
    process.env.PI_CODING_AGENT_DIR = path.join(cwd, "isolated-agent");
    refreshDirsFromEnv();
  }
  const id = `leaf_${crypto.randomUUID().replaceAll("-", "")}`;
  const provider = `auto-native-${crypto.randomUUID()}`;
  const api = `auto-native-api-${crypto.randomUUID()}`;
  const storage = new MemorySessionStorage();
  const originalOpen = SessionManager.open.bind(SessionManager);
  const open = spyOn(SessionManager, "open").mockImplementation(
    (file, directory, backend, options) =>
      originalOpen(
        file,
        directory,
        path.basename(file) === `${id}.jsonl` ? storage : backend,
        options,
      ),
  );
  const auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime(provider, "local-fake-provider-not-a-secret");
  const settings = Settings.isolated({
    "memory.backend": "off",
    "async.enabled": detached,
    "bash.autoBackground.enabled": false,
    // Exercise native async Bash jobs, not named-service process launching.
    "launch.enabled": false,
    "tools.approvalMode": "yolo",
    "tools.approval.bash": mode === "nested-bash" ? "allow" : mode === "prompt" ? "prompt" : "deny",
    "task.speculativeLaunch": false,
    "task.maxRuntimeMs": 30000,
    // Park once before rerequest, then consume the revived session's evidence
    // while live. MemorySessionStorage does not verify disk-only transcript reads.
    "task.agentIdleTtlMs": mode === "messages" ? (options.parked ? 1000 : 60000) : 1,
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
      ].map((role) => [role, `${provider}/${role === "default" ? "main" : "leaf"}`]),
    ),
  });
  await Bun.write(
    path.join(cwd, `.omp/agents/${agent}.md`),
    await Bun.file(path.resolve(import.meta.dir, `../agents/${agent}.md`)).text(),
  );
  const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
  const lifecycles: NativeLifecycle[] = [];
  const childEvents: NativeEvent[] = [];
  const childTools: string[][] = [];
  const mainContexts: string[] = [];
  const mainEnds: Array<{ isTerminal?: boolean; awaitingAsyncWork?: boolean }> = [];
  const mainTools: string[] = [];
  const leafResult = `Synthetic native leaf result ${id}`;
  let releaseChild: (() => void) | undefined;
  let releaseMain: (() => void) | undefined;
  const messageResults: Array<{ isError: boolean; details: unknown }> = [];
  const childContexts: string[] = [];
  const taskResults: Array<{ isError: boolean; details: unknown }> = [];
  const errors: unknown[] = [];
  const sends: Promise<unknown>[] = [];
  let mainRequests = 0;
  let childRequests = 0;
  let childAborted = false;
  let reviews = 0;
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  const providerConfig: Parameters<ModelRegistry["registerProvider"]>[1] = {
    baseUrl: "https://unused.invalid",
    apiKey: "local-fake-provider-not-a-secret",
    api,
    models: ["main", "leaf"].map((name) => ({
      id: name,
      name,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 64000,
      maxTokens: 1024,
    })),
    streamSimple(model, context, options) {
      // The native task label helper uses the same fake provider with no yield tool.
      // Do not count that request as a child turn or let it consume scripted actions.
      const child = model.id === "leaf" && context.tools?.some((tool) => tool.name === "yield");
      const main = model.id === "main";
      const request = child ? ++childRequests : main ? ++mainRequests : 0;
      if (main) mainContexts.push(JSON.stringify(context.messages));
      if (child) {
        childTools.push((context.tools ?? []).map((tool) => tool.name));
        childContexts.push(JSON.stringify(context.messages));
        childStarted();
      }
      const stream = createAssistantMessageEventStream();
      const call = (name: string, args: Record<string, unknown>) => ({
        type: "toolCall" as const,
        id: `${id}-${child ? "child" : "main"}-${request}`,
        name,
        arguments: args,
      });
      const calls =
        main && request === 1
          ? [call("auto_step", { summary: "Admit the extension-owned implementation boundary" })]
          : main && request === 2
            ? [
                call("task", {
                  name: id,
                  agent,
                  task: "Execute the local fake-provider test assignment once",
                  solutionSpace: "Only the fixture action and one terminal yield",
                }),
              ]
            : main &&
                verification &&
                (activeSteering ? request === 4 : request === 3 || request === 6)
              ? [call("wait", {})]
              : main &&
                  verification &&
                  (activeSteering ? request === 5 : request === 4 || request === 7)
                ? [
                    call("auto_step", {
                      summary: "Consume only the newly settled native verification receipt",
                    }),
                  ]
                : main &&
                    mode === "messages" &&
                    request === (verification && !activeSteering ? 5 : 3)
                  ? [
                      call("write", {
                        path: `agent://${id}`,
                        content: "Recheck the native fixture and yield a fresh result",
                      }),
                    ]
                  : main && detached && mainMode === "wait" && request === 3
                    ? [call("wait", {})]
                    : child && mode === "nested-bash" && request === 1
                      ? [
                          call("bash", {
                            command: "sleep 1; printf native-descendant-finished",
                            async: true,
                            timeout: 30,
                            intent: "Exercise draining a native child-owned async job",
                          }),
                        ]
                      : child && mode === "recursion" && request === 1
                        ? [
                            call("task", {
                              agent: "omp-worker",
                              task: "Forbidden nested fixture",
                              solutionSpace: "Must be rejected",
                            }),
                          ]
                        : child && (mode === "prompt" || mode === "deny") && request === 1
                          ? [
                              call("bash", {
                                command: "printf synthetic-test",
                                intent: "Verify native approval denial",
                              }),
                            ]
                          : child
                            ? [
                                call(
                                  "yield",
                                  mode === "child-abort"
                                    ? { error: "Synthetic child cancellation" }
                                    : { data: leafResult },
                                ),
                              ]
                            : [];
      const message: AssistantMessage = {
        role: "assistant",
        api,
        provider,
        model: model.id,
        content: calls.length
          ? calls
          : [
              {
                type: "text",
                text: main
                  ? "Native leaf attempt ended; remaining work is unverified"
                  : "Local task label",
              },
            ],
        stopReason: calls.length ? "toolUse" : "stop",
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
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        if (child) childAborted = true;
        stream.push({
          type: "error",
          reason: "aborted",
          error: {
            ...message,
            stopReason: "aborted",
            errorMessage:
              typeof options?.signal?.reason === "string"
                ? options.signal.reason
                : "Synthetic stream cancelled",
          },
        });
        stream.end();
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
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
        stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
        stream.end();
      };
      const heldChild =
        child &&
        ((mode === "held-yield" && request === 1) ||
          (mode === "nested-bash" && request <= 2) ||
          (mode === "messages" && request <= 2) ||
          (detached && request === 1));
      const heldMain =
        main &&
        detached &&
        mainMode === "stream" &&
        (request === 3 ||
          (mode === "messages" && request === (verification && !activeSteering ? 6 : 4)));
      if (heldChild || heldMain) {
        if (heldChild) releaseChild = finish;
        if (heldMain) releaseMain = finish;
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) abort();
      } else finish();
      return stream;
    },
  };
  registry.registerProvider(provider, providerConfig, provider);
  const snapshot: RasenSnapshot = {
    change: "fixture-change",
    root: cwd,
    schema: "spec-driven",
    state: "ready",
    progress: { total: 1, complete: 0, remaining: 1 },
    tasks: [{ id: "1.1", description: "Complete the scoped fixture", done: false }],
    instruction: "Perform the scoped fixture",
    skill: "Synthetic apply skill",
    contextFiles: [],
    fingerprint: "fixture-ready",
  };
  if (verification) {
    snapshot.state = "all_done";
    snapshot.progress = { total: 1, complete: 1, remaining: 0 };
    snapshot.tasks[0]!.done = true;
  }
  const verificationWorkflow = fallbackWorkflow(snapshot);
  verificationWorkflow.fingerprint = "two-sequential-checks";
  if (!activeSteering)
    verificationWorkflow.stages.push({
      id: "security",
      kind: "standard",
      skill: "rasen-verify-change",
      role: "research",
      runtime: "omp",
      dispatchMode: "native",
      requires: ["verify"],
      status: "pending",
    });
  if (!activeSteering) verificationWorkflow.remaining.push("security");
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.adoptArtifactManager(new ArtifactManager(path.join(cwd, ".test-artifacts")));
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
      withAgentDir(
        extensionFactory(
          () => async () => {
            reviews++;
            return { decision: "approve", summary: "Unexpected fixture review", issues: [] };
          },
          {
            snapshot: async () => snapshot,
            workflow: async () =>
              verification
                ? verificationWorkflow
                : {
                    kind: "absent",
                    change: "fixture-change",
                    reason: "Synthetic pipeline not yet recorded",
                    fingerprint: "absent",
                  },
            validate: async () => {},
            decision: () => async () => ({ choice: "continue", confidence: 0.99 }),
          },
        ),
        path.join(cwd, "isolated-agent"),
      ),
      (pi) => {
        pi.registerProvider(provider, providerConfig);
        pi.events.on("task:subagent:lifecycle", (data) => {
          if ((data as NativeLifecycle).id === id) lifecycles.push(data as NativeLifecycle);
        });
        pi.events.on("task:subagent:event", (data) => {
          if ((data as NativeEvent).id === id) childEvents.push(data as NativeEvent);
        });
        pi.on("tool_execution_start", (event, ctx) => {
          if (ctx.agent.kind === "main") mainTools.push(event.toolName);
        });
        pi.on("tool_result", (event, ctx) => {
          if (ctx.agent.kind === "main" && event.toolName === "task")
            taskResults.push({ isError: event.isError, details: event.details });
          if (ctx.agent.kind === "main" && event.toolName === "write")
            messageResults.push({ isError: event.isError, details: event.details });
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
    enableIrc: mode === "messages",
    skipPythonPreflight: true,
    spawns: agent,
    toolNames: mode === "messages" ? ["task", "wait", "write"] : ["task", "wait"],
    cacheWarming: false,
    bindProcessState: false,
    systemPrompt: "Execute only this local fake-provider fixture",
    hasUI: true,
  });
  const session = created.session;
  const nativeExecutors = new Map(
    ["task", "wait", "write"].map((name) => [name, session.getToolByName(name)?.execute]),
  );
  // awaitingAsyncWork belongs to public session events. Extension agent_end
  // notifications expose willContinue but deliberately omit that native marker.
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "agent_end") mainEnds.push(event);
  });
  await initializeExtensions(session, {
    reportSendError: (_action, error) => {
      errors.push(error);
    },
    reportRuntimeError: (error) => {
      errors.push(error);
    },
    trackExtensionSend: (promise) => {
      sends.push(promise);
    },
    uiContext: {
      ...session.extensionRunner!.getUIContext(),
      select: async () => "Approve",
      custom: async <T>() => true as T,
    } as ExtensionUIContext,
  });
  const start = async () => {
    await session.prompt("/auto start fixture-change");
    await Promise.all(sends);
    await session.waitForIdle();
  };
  return {
    id,
    session,
    nativeExecutors,
    started,
    start,
    lifecycles,
    childEvents,
    childTools,
    mainContexts,
    mainEnds,
    mainTools,
    leafResult,
    releaseChild() {
      if (!releaseChild) throw new Error("Native child stream has not reached its fixture gate");
      releaseChild();
    },
    releaseMain() {
      if (!releaseMain) throw new Error("Native Main has not reached its fixture gate");
      releaseMain();
    },
    messageResults,
    childContexts,
    taskResults,
    errors,
    counts: () => ({ mainRequests, childRequests, childAborted, reviews }),
    async status() {
      const result = await session
        .extensionRunner!.getRegisteredTool("auto_status")!
        .definition.execute(
          "fixture-status",
          {},
          undefined,
          undefined,
          session.extensionRunner!.createContext(),
        );
      const text = result.content.find((part) => part.type === "text");
      return JSON.parse(text?.type === "text" ? text.text : "null");
    },
    async close() {
      unsubscribe();
      await session.abort();
      await session.dispose();
      const child = AgentRegistry.global().get(id);
      if (child?.session) await child.session.dispose();
      AgentRegistry.global().unregister(id);
      open.mockRestore();
      auth.close();
      if (mode === "nested-bash") {
        if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
        refreshDirsFromEnv();
      }
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

for (const mode of ["success", "prompt", "deny", "child-abort", "recursion"] as const) {
  test(`Auto supervises actual native leaf ${mode} with an in-memory child journal`, async () => {
    const fixture = await nativeFixture(mode);
    try {
      await fixture.start();
      expect(fixture.errors).toEqual([]);
      expect(
        fixture.lifecycles.some((event) => event.status === "started" && event.detached === false),
      ).toBe(true);
      expect(fixture.childTools.length).toBeGreaterThan(0);

      expect(fixture.counts().reviews).toBe(0);
      const status = await pausedStatus(fixture);
      expect(status.completionVerified).toBe(false);
      if (mode === "success" || mode === "recursion") {
        const result = fixture.taskResults[0]?.details as {
          results: Array<{ exitCode: number; aborted: boolean; modelRole: string }>;
        };
        expect(result.results[0]).toMatchObject({
          exitCode: 0,
          aborted: false,
          modelRole: "implementation",
        });
        expect(fixture.counts().childRequests).toBe(mode === "recursion" ? 2 : 1);
        if (mode === "recursion") {
          const nested = fixture.childEvents.find(
            ({ event }) => event.type === "tool_execution_end" && event.toolName === "task",
          );
          expect(nested).toBeDefined();
          expect(JSON.stringify(nested)).toMatch(
            /not allowed|disabled|cannot spawn|not available/i,
          );
        }
      } else {
        expect(status.status).toBe("paused");
        expect(status.outcome).toBe("needs_user");
        expect(status.reason).toMatch(/native|worker|authoriz|cancel|scoped workflow/i);
        if (mode === "prompt" || mode === "deny") {
          const refusal = fixture.childEvents.find(
            ({ event }) =>
              event.type === "tool_execution_end" && event.toolName === "bash" && event.isError,
          );
          expect(refusal).toBeDefined();
          expect(JSON.stringify(refusal)).toMatch(/requires approval|blocked by user policy/);
          expect(fixture.counts().childRequests).toBe(2);
        } else {
          const result = fixture.taskResults[0]?.details as {
            results: Array<{ aborted: boolean; abortReason: string }>;
          };
          expect(result.results[0].aborted).toBe(true);
          expect(fixture.taskResults[0]?.isError).toBe(false);
        }
      }
    } finally {
      await fixture.close();
    }
  }, 30000);
}

test("Auto stop drains an in-flight foreground native leaf without aborting it", async () => {
  const fixture = await nativeFixture("held-yield");
  let running: Promise<void> | undefined;
  try {
    running = fixture.start();
    await fixture.started;
    await stopNativeAuto(fixture);
    expect(fixture.counts()).toMatchObject({ childRequests: 1, childAborted: false, reviews: 0 });
    expect(await fixture.status()).toMatchObject({ status: "draining", completionVerified: false });
    fixture.releaseChild();
    await running;
    expect(fixture.counts().childAborted).toBe(false);
    expect(fixture.taskResults[0]?.details).toMatchObject({
      results: [expect.objectContaining({ exitCode: 0, aborted: false })],
    });
    expect(JSON.stringify(fixture.session.messages)).toContain(fixture.leafResult);
    expect(await pausedStatus(fixture)).toMatchObject({
      status: "paused",
      completionVerified: false,
    });
  } finally {
    await fixture.close();
    await running?.catch(() => {});
  }
}, 30000);

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(10);
  }
}

type NativeFixture = Awaited<ReturnType<typeof nativeFixture>>;

async function pausedStatus(fixture: NativeFixture) {
  const deadline = Date.now() + 8000;
  for (;;) {
    const status = await fixture.status();
    if (status.status !== "draining") return status;
    if (Date.now() >= deadline)
      throw new Error(`Auto did not finish its detached drain: ${JSON.stringify(status)}`);
    await Bun.sleep(10);
  }
}

async function detachedJob(fixture: NativeFixture, mainMode: "pause" | "wait" | "stream") {
  await waitUntil(
    () => fixture.counts().childRequests === 1 && fixture.counts().mainRequests >= 3,
    "native detached child and Main's next provider call",
  );
  if (mainMode === "wait") {
    await waitUntil(() => fixture.mainTools.includes("wait"), "Main's native wait tool");
  } else if (mainMode === "pause") {
    await waitUntil(
      () => fixture.mainEnds.some((event) => event.awaitingAsyncWork === true),
      "native async scheduling pause",
    );
    await fixture.session.waitForIdle();
  }
  expect(fixture.errors).toEqual([]);
  expect(
    fixture.lifecycles.filter((event) => event.status === "started" && event.detached === true),
  ).toHaveLength(1);
  expect(await fixture.status()).toMatchObject({ status: "running", completionVerified: false });
  const row = fixture.session
    .getAsyncJobSnapshot()
    ?.running.find((job) => job.agentId === fixture.id);
  expect(row).toBeDefined();
  const job = fixture.session.asyncJobManager!.getJob(row!.id)!;
  expect(job.ownerId).toBe(fixture.session.getAgentId());
  expect(job.status).toBe("running");
  return job;
}

for (const [mode, mainMode] of [
  ["success", "pause"],
  ["success", "wait"],
  ["recursion", "wait"],
  ["prompt", "wait"],
  ["deny", "wait"],
  ["child-abort", "wait"],
] as const) {
  test(`Auto supervises detached native ${mode} through Main ${mainMode}`, async () => {
    const fixture = await nativeFixture(mode, { detached: true, mainMode });
    let running: Promise<void> | undefined;
    try {
      running = fixture.start();
      const job = await detachedJob(fixture, mainMode);
      // Release only after the real host has detached the child and Main has
      // entered a native wait or emitted an awaitingAsyncWork scheduling pause.
      fixture.releaseChild();
      await job.promise;
      await running;
      await fixture.session.settleAsyncWork();
      await fixture.session.waitForIdle();
      expect(fixture.errors).toEqual([]);
      expect(fixture.counts().reviews).toBe(0);
      const status = await pausedStatus(fixture);
      expect(status.completionVerified).toBe(false);
      expect(status.status).toBe("paused");
      expect(status.outcome).toBe("needs_user");
      if (mode === "success" || mode === "recursion") {
        expect(job.status).toBe("completed");
        expect(job.resultText).toContain(fixture.leafResult);
        // Verify actual provider input, not merely a job-manager result row.
        expect(
          fixture.mainContexts.slice(2).some((text) => text.includes(fixture.leafResult)),
        ).toBe(true);
        expect(fixture.counts().childRequests).toBe(mode === "recursion" ? 2 : 1);
        expect(fixture.counts().childAborted).toBe(false);
        if (mainMode === "pause") {
          expect(
            fixture.mainEnds.some((event) => event.isTerminal === false && event.awaitingAsyncWork),
          ).toBe(true);
          expect(
            fixture.session.messages.some(
              (message) => message.role === "custom" && message.customType === "async-result",
            ),
          ).toBe(true);
        }
        if (mode === "recursion") {
          const nested = fixture.childEvents.find(
            ({ event }) => event.type === "tool_execution_end" && event.toolName === "task",
          );
          expect(nested).toBeDefined();
          expect(JSON.stringify(nested)).toMatch(
            /not allowed|disabled|cannot spawn|not available/i,
          );
        }
      } else if (mode === "prompt" || mode === "deny") {
        const refusal = fixture.childEvents.find(
          ({ event }) =>
            event.type === "tool_execution_end" && event.toolName === "bash" && event.isError,
        );
        expect(refusal).toBeDefined();
        expect(JSON.stringify(refusal)).toMatch(/requires approval|blocked by user policy/);
        expect(fixture.counts().childRequests).toBe(2);
        expect(status.reason).toMatch(/authoriz|denied|policy|scoped workflow/i);
      } else {
        expect(fixture.lifecycles.some((event) => event.status === "aborted")).toBe(true);
        expect(status.reason).toMatch(/native|worker|cancel|scoped workflow/i);
      }
    } finally {
      await fixture.close();
      await running?.catch(() => {});
    }
  }, 30000);
}

async function stopNativeAuto(fixture: NativeFixture) {
  await fixture.session
    .extensionRunner!.getCommand("auto")!
    .handler("stop", fixture.session.extensionRunner!.createCommandContext());
}

for (const interruption of ["auto stop", "new user input"] as const) {
  test(`Auto ${interruption} drains its detached child and preserves unrelated native work`, async () => {
    const fixture = await nativeFixture("held-yield", { detached: true, mainMode: "pause" });
    let running: Promise<void> | undefined;
    let unrelatedAborted = false;
    const releaseUnrelated = Promise.withResolvers<void>();
    try {
      const manager = fixture.session.asyncJobManager!;
      running = fixture.start();
      const owned = await detachedJob(fixture, "pause");
      const unrelatedId = manager.register(
        "bash",
        "Unrelated same-Main fixture",
        async ({ signal }) => {
          signal.addEventListener(
            "abort",
            () => {
              unrelatedAborted = true;
            },
            { once: true },
          );
          await releaseUnrelated.promise;
          return "Unrelated fixture completed naturally";
        },
        { id: fixture.id, ownerId: fixture.session.getAgentId() },
      );
      const unrelated = manager.getJob(unrelatedId)!;
      expect(owned.id).not.toBe(unrelated.id);
      if (interruption === "auto stop") await fixture.session.prompt("/auto stop");
      else {
        const text = "Replace the Auto request with this new user request";
        // OMP's interactive/RPC input controller emits input before prompt();
        // the lower-level public prompt API intentionally does not synthesize it.
        await fixture.session.extensionRunner!.emitInput(text, undefined, "interactive");
        await fixture.session.prompt(text);
      }
      expect(owned.status).toBe("running");
      expect(unrelated.status).toBe("running");
      expect(fixture.counts().childAborted).toBe(false);
      expect(await fixture.status()).toMatchObject({
        status: "draining",
        completionVerified: false,
      });
      fixture.releaseChild();
      await owned.promise;
      expect(owned.status).toBe("completed");
      expect(owned.resultText).toContain(fixture.leafResult);
      expect(unrelated.status).toBe("running");
      expect(unrelatedAborted).toBe(false);
      releaseUnrelated.resolve();
      await unrelated.promise;
      await running;
      await fixture.session.settleAsyncWork();
      await fixture.session.waitForIdle();
      expect(fixture.errors).toEqual([]);
      expect(fixture.counts()).toMatchObject({ childRequests: 1, childAborted: false, reviews: 0 });
      expect(JSON.stringify(fixture.session.messages)).toContain(fixture.leafResult);
      expect(await pausedStatus(fixture)).toMatchObject({
        status: "paused",
        completionVerified: false,
      });
    } finally {
      releaseUnrelated.resolve();
      await fixture.close();
      await running?.catch(() => {});
    }
  }, 30000);
}

for (const cancellation of ["Main interrupt", "explicit native job cancellation"] as const) {
  test(`OMP retains ${cancellation} behavior independently of Auto`, async () => {
    const fixture = await nativeFixture("held-yield", { detached: true, mainMode: "stream" });
    let running: Promise<void> | undefined;
    try {
      running = fixture.start();
      const job = await detachedJob(fixture, "stream");
      if (cancellation === "Main interrupt") {
        await fixture.session.abort({ reason: USER_INTERRUPT_LABEL });
        expect(
          fixture.session.messages.some(
            (message) =>
              message.role === "assistant" && message.errorMessage === USER_INTERRUPT_LABEL,
          ),
        ).toBe(true);
        // A Main interrupt is not an extension-owned child cancellation request.
        expect(job.status).toBe("running");
        expect(fixture.counts().childAborted).toBe(false);
        fixture.releaseChild();
      } else {
        expect(fixture.session.cancelAsyncJob(job.id)).toBe(true);
        fixture.releaseMain();
      }
      await job.promise;
      await running;
      await fixture.session.settleAsyncWork();
      expect(job.status).toBe(cancellation === "Main interrupt" ? "completed" : "cancelled");
      expect(fixture.counts().childAborted).toBe(cancellation !== "Main interrupt");
      expect(fixture.counts().reviews).toBe(0);
      expect((await fixture.status()).completionVerified).toBe(false);
    } finally {
      await fixture.close();
      await running?.catch(() => {});
    }
  }, 30000);
}

test("Auto stop drains a real child-owned native async Bash descendant", async () => {
  const fixture = await nativeFixture("nested-bash", { detached: true, mainMode: "wait" });
  let running: Promise<void> | undefined;
  try {
    running = fixture.start();
    const owned = await detachedJob(fixture, "wait");
    fixture.releaseChild();
    const manager = fixture.session.asyncJobManager!;
    await waitUntil(
      () =>
        fixture.counts().childRequests === 2 &&
        manager.getRunningJobs({ ownerId: fixture.id }).some((job) => job.type === "bash"),
      "child-owned native Bash job",
    );
    const descendant = manager
      .getRunningJobs({ ownerId: fixture.id })
      .find((job) => job.type === "bash")!;
    await stopNativeAuto(fixture);
    expect(owned.status).toBe("running");
    expect(descendant.status).toBe("running");
    expect(fixture.counts().childAborted).toBe(false);
    expect(await fixture.status()).toMatchObject({ status: "draining", completionVerified: false });
    await descendant.promise;
    fixture.releaseChild();
    await Promise.all([owned.promise, running]);
    await fixture.session.settleAsyncWork();
    expect(owned.status).toBe("completed");
    expect(descendant.status).toBe("completed");
    expect(descendant.resultText).toContain("native-descendant-finished");
    expect(fixture.counts()).toMatchObject({ childAborted: false, reviews: 0 });
    // Native async-result delivery may add a third turn before terminal yield.
    expect(fixture.counts().childRequests).toBeGreaterThanOrEqual(2);
    expect(await pausedStatus(fixture)).toMatchObject({
      status: "paused",
      completionVerified: false,
    });
  } finally {
    await fixture.close();
    await running?.catch(() => {});
  }
}, 30000);

for (const targetState of ["active", "idle", "parked"] as const) {
  test(`Auto Main native agent:// rereview reaches the same ${targetState} child without premature completion`, async () => {
    const fixture = await nativeFixture("messages", {
      detached: true,
      mainMode: "stream",
      parked: targetState === "parked",
    });
    let running: Promise<void> | undefined;
    try {
      running = fixture.start();
      const firstJob = await detachedJob(fixture, "stream");
      const initialRef = AgentRegistry.global().get(fixture.id)!;
      const initialSession = initialRef.session;
      if (targetState !== "active") {
        fixture.releaseChild();
        await firstJob.promise;
        await waitUntil(
          () => AgentRegistry.global().get(fixture.id)?.status === targetState,
          `${targetState} child`,
        );
      }
      fixture.releaseMain();
      await waitUntil(
        () => fixture.messageResults.length === 1,
        "Main native agent:// message receipt",
      );
      expect(fixture.messageResults[0]!.isError).toBe(false);
      for (const [name, execute] of fixture.nativeExecutors) {
        expect(fixture.session.getToolByName(name)?.execute).toBe(execute);
      }
      const details = fixture.messageResults[0]!.details as {
        message: { receipts: Array<{ outcome: string }> };
      };
      expect(details.message.receipts[0]!.outcome).toBe(
        targetState === "active" ? "injected" : targetState === "parked" ? "revived" : "woken",
      );
      if (targetState === "active") fixture.releaseChild();
      await waitUntil(
        () => fixture.counts().childRequests >= 2 && fixture.counts().mainRequests >= 4,
        "native rereview and Main provider gates",
      );
      expect(AgentRegistry.global().get(fixture.id)).toBe(initialRef);
      if (targetState === "idle") expect(initialRef.session).toBe(initialSession);
      if (targetState === "parked") expect(initialRef.session).not.toBe(initialSession);
      expect(fixture.childContexts.at(-1)).toContain("Recheck the native fixture");
      expect(await fixture.status()).toMatchObject({
        status: "running",
        completionVerified: false,
      });
      expect(fixture.counts().reviews).toBe(0);
      await stopNativeAuto(fixture);
      expect(fixture.counts().childAborted).toBe(false);
      expect(await fixture.status()).toMatchObject({
        status: "draining",
        completionVerified: false,
      });
      fixture.releaseChild();
      await initialRef.session!.waitForIdle();
      fixture.releaseMain();
      await running;
      await fixture.session.settleAsyncWork();
      expect(fixture.counts().childAborted).toBe(false);
      expect(fixture.errors).toEqual([]);
      expect(await pausedStatus(fixture)).toMatchObject({
        status: "paused",
        completionVerified: false,
      });
    } finally {
      await fixture.close();
      await running?.catch(() => {});
    }
  }, 30000);
}

for (const targetState of ["idle", "parked"] as const) {
  test(`Auto consumes a fresh ${targetState} reviewer rerequest for the next sequential check`, async () => {
    const fixture = await nativeFixture("messages", {
      detached: true,
      mainMode: "stream",
      parked: targetState === "parked",
      verification: true,
    });
    let running: Promise<void> | undefined;
    try {
      running = fixture.start();
      const firstJob = await detachedJob(fixture, "stream");
      const ref = AgentRegistry.global().get(fixture.id)!;
      const initialSession = ref.session;
      expect((await fixture.status()).hostWorkflow).toMatchObject({
        phase: "verify",
        stage: "verify",
        verifiedStages: [],
      });
      fixture.releaseChild();
      await firstJob.promise;
      await waitUntil(() => ref.status === targetState, `first reviewer ${targetState}`);
      fixture.releaseMain();
      await waitUntil(
        () =>
          fixture.messageResults.length === 1 &&
          fixture.counts().mainRequests >= 6 &&
          fixture.counts().childRequests === 2,
        "second check requested from the same native reviewer",
      ).catch(async (error) => {
        throw new Error(
          `${error.message}; counts=${JSON.stringify(fixture.counts())}; status=${JSON.stringify(await fixture.status())}`,
        );
      });
      expect(fixture.messageResults[0]!.isError).toBe(false);
      expect(AgentRegistry.global().get(fixture.id)).toBe(ref);
      if (targetState === "idle") expect(ref.session).toBe(initialSession);
      else expect(ref.session).not.toBe(initialSession);
      // The original task receipt certifies only verify. Reusing its producer,
      // while the new native request is running, cannot certify security.
      expect(await fixture.status()).toMatchObject({
        completionVerified: false,
        hostWorkflow: {
          phase: "verify",
          stage: "security",
          verifiedStages: ["verify"],
          readyForReview: false,
        },
      });
      fixture.releaseChild();
      await ref.session!.waitForIdle();
      await waitUntil(
        () => ref.status === "idle" || ref.status === "parked",
        "accepted native rereview result",
      );
      fixture.releaseMain();
      await running;
      await fixture.session.settleAsyncWork();
      const status = await pausedStatus(fixture);
      expect(status.hostWorkflow).toMatchObject({
        phase: "review",
        verifiedStages: ["verify", "security"],
        readyForReview: true,
      });
      expect(status.completionVerified).toBe(false);
      expect(fixture.counts()).toMatchObject({ childRequests: 2, childAborted: false, reviews: 0 });
      expect(fixture.errors).toEqual([]);
    } finally {
      await fixture.close();
      await running?.catch(() => {});
    }
  }, 30000);
}

test("Auto accepts the original native reviewer task after active steering settles", async () => {
  const fixture = await nativeFixture("messages", {
    detached: true,
    mainMode: "stream",
    verification: true,
    activeSteering: true,
  });
  let running: Promise<void> | undefined;
  try {
    running = fixture.start();
    const original = await detachedJob(fixture, "stream");
    fixture.releaseMain();
    await waitUntil(
      () => fixture.messageResults.length === 1 && fixture.counts().mainRequests >= 4,
      "active steering and native Main wait gate",
    );
    expect(fixture.messageResults[0]).toMatchObject({
      isError: false,
      details: { message: { receipts: [{ to: fixture.id, outcome: "injected" }] } },
    });
    fixture.releaseChild();
    await waitUntil(
      () => fixture.counts().childRequests === 2,
      "original reviewer processes its injected steering",
    );
    expect(fixture.childContexts.at(-1)).toContain("Recheck the native fixture");
    // Native delivery may accept the original yield before its injected follow-up
    // finishes. The semantic boundary must still await all native work.
    expect(await fixture.status()).toMatchObject({
      completionVerified: false,
      nativeWork: { pending: true },
      hostWorkflow: { phase: "verify", verifiedStages: [], readyForReview: false },
    });
    fixture.releaseChild();
    await original.promise;
    await fixture.session.asyncJobManager!.waitForOwnerJobs(fixture.session.getAgentId()!);
    expect(original.status).toBe("completed");
    fixture.releaseMain();
    await running;
    await fixture.session.settleAsyncWork();
    expect((await pausedStatus(fixture)).hostWorkflow).toMatchObject({
      phase: "review",
      verifiedStages: ["verify"],
      readyForReview: true,
    });
    expect(fixture.lifecycles.filter((event) => event.status === "started")).toHaveLength(1);
    expect(fixture.counts()).toMatchObject({ childRequests: 2, childAborted: false, reviews: 0 });
    expect(fixture.errors).toEqual([]);
  } finally {
    await fixture.close();
    await running?.catch(() => {});
  }
}, 30000);

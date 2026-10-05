import { expect, spyOn, test } from "bun:test";
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
import { extensionFactory } from "../src/extension.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";

type Mode = "success" | "prompt" | "deny" | "cancel" | "child-abort" | "recursion";
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
async function nativeFixture(mode: Mode) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-native-"));
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
    "async.enabled": false,
    "bash.autoBackground.enabled": false,
    "tools.approvalMode": "yolo",
    "tools.approval.bash": mode === "prompt" ? "prompt" : "deny",
    "task.speculativeLaunch": false,
    "task.maxRuntimeMs": 10000,
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
      ].map((role) => [role, `${provider}/${role === "default" ? "main" : "leaf"}`]),
    ),
  });
  await Bun.write(
    path.join(cwd, ".omp/agents/omp-worker.md"),
    await Bun.file(path.resolve(import.meta.dir, "../agents/omp-worker.md")).text(),
  );
  const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
  const lifecycles: NativeLifecycle[] = [];
  const childEvents: NativeEvent[] = [];
  const childTools: string[][] = [];
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
      if (child) {
        childTools.push((context.tools ?? []).map((tool) => tool.name));
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
          ? [
              call("task", {
                name: id,
                agent: "omp-worker",
                task: "Execute the local fake-provider test assignment once",
                solutionSpace: "Only the fixture action and one terminal yield",
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
              : child && mode !== "cancel"
                ? [
                    call(
                      "yield",
                      mode === "child-abort"
                        ? { error: "Synthetic child cancellation" }
                        : { data: "Synthetic native leaf result" },
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
      if (child && mode === "cancel") {
        const abort = () => {
          childAborted = true;
          stream.push({
            type: "error",
            reason: "aborted",
            error: {
              ...message,
              stopReason: "aborted",
              errorMessage: "Synthetic child stream cancelled",
            },
          });
          stream.end();
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) abort();
        return stream;
      }
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
      extensionFactory(
        () => async () => {
          reviews++;
          return { decision: "approve", summary: "Unexpected fixture review", issues: [] };
        },
        {
          snapshot: async () => snapshot,
          workflow: async () => ({
            kind: "absent",
            change: "fixture-change",
            reason: "Synthetic pipeline not yet recorded",
            fingerprint: "absent",
          }),
          skill: async () => ({
            message: "Synthetic complete Auto skill",
            path: "fixture",
            bytes: 29,
            sha256: "fixture",
          }),
          validate: async () => {},
          decision: () => async () => ({ choice: "continue", confidence: 0.99 }),
          backgroundEnabled: () => false,
          asyncEnabled: () => false,
        },
      ),
      (pi) => {
        pi.registerProvider(provider, providerConfig);
        pi.events.on("task:subagent:lifecycle", (data) => {
          if ((data as NativeLifecycle).id === id) lifecycles.push(data as NativeLifecycle);
        });
        pi.events.on("task:subagent:event", (data) => {
          if ((data as NativeEvent).id === id) childEvents.push(data as NativeEvent);
        });
        pi.on("tool_result", (event, ctx) => {
          if (ctx.agent.kind === "main" && event.toolName === "task")
            taskResults.push({ isError: event.isError, details: event.details });
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
    spawns: "omp-worker",
    toolNames: ["task"],
    cacheWarming: false,
    bindProcessState: false,
    systemPrompt: "Execute only this local fake-provider fixture",
    hasUI: true,
  });
  const session = created.session;
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
    started,
    start,
    lifecycles,
    childEvents,
    childTools,
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
      await session.abort();
      await session.dispose();
      const child = AgentRegistry.global().get(id);
      if (child?.session) await child.session.dispose();
      AgentRegistry.global().unregister(id);
      open.mockRestore();
      auth.close();
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
      const status = await fixture.status();
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
        expect(status.status).toBe("needs_user");
        expect(status.reason).toMatch(/native|worker|authoriz|cancel/i);
        if (mode === "prompt" || mode === "deny") {
          const refusal = fixture.childEvents.find(
            ({ event }) =>
              event.type === "tool_execution_end" && event.toolName === "bash" && event.isError,
          );
          expect(refusal).toBeDefined();
          expect(JSON.stringify(refusal)).toMatch(/requires approval|blocked by user policy/);
          expect(fixture.counts().childRequests).toBe(1);
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

test("Auto stop aborts an in-flight actual native leaf before further model work", async () => {
  const fixture = await nativeFixture("cancel");
  let running: Promise<void> | undefined;
  try {
    running = fixture.start();
    await Promise.race([
      fixture.started,
      Bun.sleep(10000).then(() => {
        throw new Error("Native fixture child did not start");
      }),
    ]);
    await fixture.session
      .extensionRunner!.getCommand("auto")!
      .handler("stop", fixture.session.extensionRunner!.createCommandContext());
    await running;
    expect(fixture.counts()).toMatchObject({ childRequests: 1, childAborted: true, reviews: 0 });
    expect(fixture.lifecycles.some((event) => event.status === "aborted")).toBe(true);
    expect(await fixture.status()).toMatchObject({
      status: "cancelled",
      completionVerified: false,
    });
  } finally {
    await fixture.close();
    await running?.catch(() => {});
  }
}, 30000);

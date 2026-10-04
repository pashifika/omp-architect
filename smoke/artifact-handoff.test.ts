import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeVmContextsByOwner } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
  ExtensionToolWrapper,
  wrapRegisteredTool,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { TodoPhase, TodoToolDetails } from "@oh-my-pi/pi-tui/tools/todo";
import type { WriteToolDetails } from "@oh-my-pi/pi-tui/tools/write";
import type { EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { Config } from "../src/config.ts";
import { digest, type Reviewer, type ReviewRequest } from "../src/core.ts";
import { extensionFactory } from "../src/extension.ts";

const approved = {
  decision: "approve" as const,
  summary: "Current host evidence verified",
  issues: [],
};
const steps = ["Inspect the fixture", "Implement the fixture", "Verify the fixture"];
const ref = "local://architect-review/completion.md";

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n");
}

function carrier(input: Record<string, unknown>): string {
  return `console.log(await tool.write(${JSON.stringify(input)}))`;
}

function checkpointInput(evidenceRef = ref, phase = "completion", plan?: string[]) {
  return {
    path: "xd://architect_checkpoint",
    content: JSON.stringify({ phase, evidenceRef, ...(plan ? { steps: plan } : {}) }),
  };
}

async function fixture(
  options: {
    reviewer?: Reviewer;
    config?: Partial<Config>;
    abortSignal?: AbortController;
    runningJobs?: () => boolean;
  } = {},
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-artifact-handoff-"));
  const owner = `artifact-handoff-${crypto.randomUUID()}`;
  await Bun.write(
    path.join(cwd, ".omp", "architect.json"),
    JSON.stringify({ reviews: { min: 1, max: 3 }, ...options.config }),
  );
  const runtime = new ExtensionRuntime();
  const notices: Array<{ customType: string; content: unknown }> = [];
  runtime.sendMessage = (...args: unknown[]) => {
    notices.push(args[0] as (typeof notices)[number]);
  };
  const requests: ReviewRequest[] = [];
  const extension = await loadExtensionFromFactory(
    extensionFactory(() => async (request, signal) => {
      requests.push(request);
      return options.reviewer ? options.reviewer(request, signal) : approved;
    }),
    cwd,
    new EventBus(),
    runtime,
  );
  const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
  const sessionManager = SessionManager.create(cwd, path.join(cwd, ".test-sessions"));
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    cwd,
    sessionManager,
    { getAvailable: () => [] } as unknown as ModelRegistry,
    undefined,
    settings,
    undefined,
    () => ({
      running: options.runningJobs?.()
        ? [
            {
              id: "background-fixture",
              type: "bash",
              status: "running",
              label: "Pending verification",
              startTime: 0,
            },
          ]
        : [],
      recent: [],
      delivery: { queued: 0, delivering: false, pendingJobIds: [] },
    }),
  );
  const errors: string[] = [];
  runner.onError((error) => errors.push(error.error));
  let aborts = 0;
  const actions = new ExtensionRuntime();
  actions.sendMessage = runtime.sendMessage;
  runner.initialize(actions, {
    getModel: () => undefined,
    isIdle: () => true,
    abort: () => {
      aborts++;
      options.abortSignal?.abort(new DOMException("Host terminal stop", "AbortError"));
    },
    hasPendingMessages: () => false,
    shutdown() {},
    getContextUsage: () => undefined,
    compact: async () => {},
    getSystemPrompt: () => [],
  });
  const checkpoint = new ExtensionToolWrapper(
    wrapRegisteredTool(extension.tools.get("architect_checkpoint")!, runner),
    runner,
  );
  const statusTool = new ExtensionToolWrapper(
    wrapRegisteredTool(extension.tools.get("auto_status")!, runner),
    runner,
  );
  const xdev: XdevState = {
    tools: new Map([
      [checkpoint.name, checkpoint],
      [statusTool.name, statusTool],
    ]),
    mountedNames: new Set([checkpoint.name, statusTool.name]),
    builtInNames: new Set(),
    isActive: () => false,
  };
  let phases: TodoPhase[] = [];
  const session = {
    cwd,
    hasUI: false,
    settings,
    sessionManager,
    enableLsp: false,
    xdev,
    localProtocolOptions: {
      getArtifactsDir: () => sessionManager.getArtifactsDir(),
      getSessionId: () => sessionManager.getSessionId(),
    },
    getSessionFile: () => sessionManager.getSessionFile(),
    getSessionId: () => sessionManager.getSessionId(),
    getTodoPhases: () => phases,
    setTodoPhases: (next: TodoPhase[]) => {
      phases = next;
    },
    getEvalKernelOwnerId: () => owner,
    getEvalSessionId: () => owner,
  } as unknown as ToolSession;
  const write = new ExtensionToolWrapper<WriteTool["parameters"], WriteToolDetails>(
    new WriteTool(session),
    runner,
  );
  const todo = new ExtensionToolWrapper<TodoTool["parameters"], TodoToolDetails>(
    new TodoTool(session),
    runner,
  );
  session.getToolForEvalBridge = ((name: string) =>
    name === "write"
      ? write
      : name === "todo"
        ? todo
        : undefined) as unknown as ToolSession["getToolForEvalBridge"];
  const evalTool = new ExtensionToolWrapper<EvalTool["parameters"], EvalToolDetails | undefined>(
    new EvalTool(session),
    runner,
  );
  await runner.emit({ type: "session_start" });
  await runner.emitBeforeAgentStart(
    "Implement and verify this isolated host fixture",
    undefined,
    [],
  );
  return {
    cwd,
    requests,
    notices,
    checkpoint,
    write,
    todo,
    runner,
    aborts: () => aborts,
    eval: (id: string, code: string, signal?: AbortSignal, reset?: boolean) =>
      evalTool.execute(
        id,
        { language: "js", code, timeout: 20, ...(reset !== undefined ? { reset } : {}) },
        signal,
      ),
    status: async () => JSON.parse(text(await statusTool.execute(crypto.randomUUID(), {}))),
    stop: (signal = new AbortController().signal) =>
      runner.emit({
        type: "session_stop",
        messages: [],
        turn_id: 1,
        session_id: sessionManager.getSessionId(),
        stop_hook_active: false,
        signal,
      }),
    async close() {
      try {
        await disposeVmContextsByOwner(owner);
        await runner.emit({ type: "session_shutdown" });
        expect(errors).toEqual([]);
      } finally {
        runner.clearManagedTimers();
        runner.disposeFileFallbacks();
        await fs.rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

test("real Eval queues native-file completion until the finished outer result reaches the boundary", async () => {
  const f = await fixture();
  const body = [
    "# Complete authored review",
    ...Array.from({ length: 18 }, (_, index) =>
      [
        `## Scenario ${index + 1}`,
        `WHEN fixture scenario ${index + 1} reaches its final state`,
        `THEN all evidence and acceptance conditions must remain intact`,
        `BEGIN_MIDDLE_MARKER_${index + 1}`,
        'Unicode 界 日本語; quotes "checked" and escapes \\ remain exact. '.repeat(35),
        `END_MIDDLE_MARKER_${index + 1}`,
      ].join("\n"),
    ),
    "Final verification status: PASS",
  ].join("\n\n");
  expect(body.length).toBeGreaterThan(28_678);
  expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(131_072);
  try {
    expect((await f.write.execute("author-body", { path: ref, content: body })).isError).not.toBe(
      true,
    );
    const result = await f.eval("queue-completion", carrier(checkpointInput()));
    expect(text(result)).toContain('"status":"queued"');
    expect(text(result)).toContain('"charged":false');
    expect(text(result)).not.toContain('"decision":"approve"');
    expect(f.requests).toHaveLength(0);
    expect((await f.status()).architect).toMatchObject({
      completionApproved: false,
      attempts: { completion: 0 },
    });
    expect(await f.stop()).toBeUndefined();
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].material).toMatchObject({
      content: body,
      sha256: digest(body),
      bytes: Buffer.byteLength(body, "utf8"),
      source: "authored",
    });
    const snapshot = JSON.parse(f.requests[0].evidence);
    expect(snapshot).not.toHaveProperty("summary");
    expect(snapshot.recentToolEvidence.map((item: string) => JSON.parse(item))).toContainEqual(
      expect.objectContaining({ tool: "eval", toolCallId: "queue-completion" }),
    );
    expect((await f.status()).architect).toMatchObject({
      completionApproved: true,
      attempts: { completion: 1 },
      lastReview: {
        status: "provider_verdict",
        charged: true,
        revision: f.requests[0].revision,
        invocationId: f.requests[0].invocationId,
        verdict: approved,
      },
    });
    expect(await f.stop()).toBeUndefined();
    expect(f.requests).toHaveLength(1);
    expect(f.notices).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("real Eval mutations after queued completion are observed before review and revoke prior approval", async () => {
  const file = "changed-after-queue.txt";
  const f = await fixture({
    reviewer: async (request) =>
      request.evidence.includes("MUTATION_AFTER_QUEUE")
        ? {
            decision: "blocked",
            summary: "Mutation needs fresh verification",
            issues: ["Verify the changed file"],
          }
        : approved,
  });
  try {
    await f.write.execute("author-body", {
      path: ref,
      content: "Review the exact final project state",
    });
    await f.write.execute("prior-direct-approval", checkpointInput());
    expect((await f.status()).architect.completionApproved).toBe(true);
    const result = await f.eval(
      "queue-and-mutate",
      `${carrier(checkpointInput())};\nawait tool.write(${JSON.stringify({ path: file, content: "MUTATION_AFTER_QUEUE" })});`,
    );
    expect(text(result)).toContain('"status":"queued"');
    expect(await Bun.file(path.join(f.cwd, file)).text()).toBe("MUTATION_AFTER_QUEUE");
    expect(f.requests).toHaveLength(1);
    expect((await f.status()).architect.completionApproved).toBe(false);
    expect((await f.stop())?.continue).toBe(true);
    expect(f.requests).toHaveLength(2);
    expect(f.requests[1].revision).toBeGreaterThan(f.requests[0].revision);
    const records = JSON.parse(f.requests[1].evidence).recentToolEvidence.map((item: string) =>
      JSON.parse(item),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        tool: "write",
        input: { path: file, content: "MUTATION_AFTER_QUEUE" },
        isError: false,
      }),
    );
    expect((await f.status()).architect).toMatchObject({
      completionApproved: false,
      lastReview: {
        status: "provider_verdict",
        charged: true,
        verdict: { decision: "blocked", summary: "Mutation needs fresh verification" },
      },
    });
    await f.stop();
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test.each([
  "cancel",
  "agent-end",
  "new-input",
  "session-switch",
] as const)("real Eval queued completion is discarded by %s", async (interruption) => {
  const f = await fixture();
  try {
    await f.write.execute("author-body", {
      path: ref,
      content: "This queued review must never run",
    });
    const cancelled = new AbortController();
    expect(text(await f.eval("queue", carrier(checkpointInput()), cancelled.signal))).toContain(
      '"status":"queued"',
    );
    if (interruption === "cancel") {
      cancelled.abort();
      await f.runner.emit({ type: "agent_end", messages: [], willContinue: false });
      expect(await f.stop(cancelled.signal)).toBeUndefined();
    } else if (interruption === "agent-end") {
      await f.runner.emit({ type: "agent_end", messages: [], willContinue: false });
    } else if (interruption === "new-input") {
      await f.runner.emitInput("Replace the previous task", undefined, "interactive");
      await f.runner.emitBeforeAgentStart("Replace the previous task", undefined, []);
    } else {
      await f.runner.emit({
        type: "session_switch",
        reason: "resume",
        previousSessionFile: undefined,
      });
      await f.runner.emitBeforeAgentStart("A newly resumed task", undefined, []);
    }
    await f.stop();
    expect(f.requests).toHaveLength(0);
    expect((await f.status()).architect).toMatchObject({
      completionApproved: false,
      attempts: { completion: 0 },
    });
  } finally {
    await f.close();
  }
});

test.each([
  "plan",
  "recovery",
] as const)("pending %s admits only native review files and single-call Eval carriers", async (phase) => {
  const f = await fixture();
  try {
    if (phase === "plan")
      await expect(f.todo.execute("stage-plan", { op: "init", items: steps })).rejects.toThrow(
        "Substantial plan",
      );
    else
      for (let index = 0; index < 2; index++)
        await f.runner.emitToolResult({
          type: "tool_result",
          toolCallId: `failed-${index}`,
          toolName: "bash",
          input: { command: "fixture-check" },
          content: [{ type: "text", text: "Identical fixture check failed" }],
          isError: true,
          details: undefined,
        });
    const pending = phase === "plan" ? "Pending plan" : "Repeated";
    await expect(
      f.write.execute("blocked-project-write", {
        path: "unapproved.txt",
        content: "Must not execute",
      }),
    ).rejects.toThrow(pending);
    await expect(
      f.eval("blocked-generic-eval", 'console.log("Must not execute")', undefined, true),
    ).rejects.toThrow(pending);
    expect(
      (
        await f.write.execute("native-review-file", {
          path: ref,
          content: "First complete review body",
        })
      ).isError,
    ).not.toBe(true);
    expect(
      text(
        await f.eval(
          "allowed-single-write",
          carrier({ path: ref, content: "Final complete review body" }),
          undefined,
          true,
        ),
      ),
    ).toContain("Successfully wrote");
    await expect(
      f.eval("blocked-retained-kernel", carrier({ path: ref, content: "Unreset carrier" })),
    ).rejects.toThrow(pending);
    await expect(
      f.eval(
        "blocked-multiple-calls",
        `${carrier({ path: ref, content: "Rejected replacement" })}; console.log("extra")`,
        undefined,
        true,
      ),
    ).rejects.toThrow(pending);
    const reviewed = await f.eval(
      "allowed-review-carrier",
      carrier(checkpointInput(ref, phase, phase === "plan" ? steps : undefined)),
      undefined,
      true,
    );
    expect(text(reviewed)).toContain('"decision":"approve"');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].material.content).toBe("Final complete review body");
    expect(await Bun.file(path.join(f.cwd, "unapproved.txt")).exists()).toBe(false);
    if (phase === "plan")
      await f.todo.execute("register-approved-plan", { op: "init", items: steps });
    expect(
      (
        await f.write.execute("approved-project-write", {
          path: "approved.txt",
          content: "Approved execution",
        })
      ).isError,
    ).not.toBe(true);
  } finally {
    await f.close();
  }
});

test("terminal native xd abort preserves the completed provider verdict in durable notice and status", async () => {
  const controller = new AbortController();
  const verdict = {
    decision: "revise" as const,
    summary: "Completed review found failing verification",
    issues: ["Fix the failing check"],
  };
  const f = await fixture({
    config: { reviews: { min: 1, max: 1 } },
    reviewer: async () => verdict,
    abortSignal: controller,
  });
  try {
    await f.write.execute("author-body", {
      path: ref,
      content: "Review the unsuccessful verification honestly",
    });
    await expect(
      f.write.execute("terminal-checkpoint", checkpointInput(), controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(controller.signal.aborted).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect(f.aborts()).toBe(1);
    const status = await f.status();
    expect(status.architect).toMatchObject({
      completionApproved: false,
      attempts: { completion: 1 },
      lastReview: {
        status: "provider_verdict",
        charged: true,
        invocationId: f.requests[0].invocationId,
        verdict,
      },
    });
    expect(f.notices).toHaveLength(1);
    const notice = String(f.notices[0].content);
    expect(notice).toContain('"status":"provider_verdict"');
    expect(notice).toContain('"charged":true');
    expect(notice).toContain(f.requests[0].invocationId);
    expect(notice).toContain(verdict.summary);
    expect(notice).not.toContain('"status":"caller_cancelled"');
    expect(await f.stop()).toBeUndefined();
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("native xd rejects the old inline summary schema and oversized review files without attempts", async () => {
  const f = await fixture({ config: { maxReviewBytes: 1024 } });
  try {
    await expect(
      f.write.execute("old-summary", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({ phase: "completion", summary: "Inline payload is unsupported" }),
      }),
    ).rejects.toThrow("inline summary/body is unsupported");
    await f.write.execute("small-native-file", {
      path: ref,
      content: "A complete native review body",
    });
    await expect(
      f.write.execute("mixed-inline-summary", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "completion",
          evidenceRef: ref,
          summary: "Inline is still unsupported",
        }),
      }),
    ).rejects.toThrow("inline summary/body is unsupported");
    expect(f.requests).toHaveLength(0);
    expect((await f.status()).architect.attempts.completion).toBe(0);
    await f.write.execute("oversized-native-file", { path: ref, content: "界".repeat(400) });
    const oversized = await f.write.execute("oversized-checkpoint", checkpointInput());
    expect(oversized.isError).toBe(true);
    expect(text(oversized)).toContain("maxReviewBytes");
    expect(f.requests).toHaveLength(0);
    expect((await f.status()).architect).toMatchObject({
      completionApproved: false,
      attempts: { completion: 0 },
      lastReview: { status: "input_rejected", charged: false },
    });
  } finally {
    await f.close();
  }
});

test("reset-only native Eval carriers discard a replaced retained dispatcher before opening a plan gate", async () => {
  const f = await fixture();
  try {
    const target = path.join(f.cwd, "unapproved-side-effect.txt");
    const primed = await f.eval(
      "prime-dispatcher",
      `globalThis.__omp_call_tool__ = async () => { await (await import("node:fs/promises")).writeFile(${JSON.stringify(target)}, "UNAPPROVED"); return "hijacked"; }; console.log("dispatcher replaced");`,
    );
    expect(text(primed)).toContain("dispatcher replaced");
    await expect(f.todo.execute("stage-plan", { op: "init", items: steps })).rejects.toThrow(
      "Substantial plan",
    );
    const input = carrier({ path: ref, content: "Review body written by the genuine native host" });
    await expect(f.eval("denied-retained-dispatcher", input)).rejects.toThrow("Pending plan");
    const restored = await f.eval("reset-before-native-carrier", input, undefined, true);
    expect(text(restored)).toContain("Successfully wrote");
    expect(text(restored)).not.toContain("hijacked");
    expect(await Bun.file(target).exists()).toBe(false);
    const result = await f.eval(
      "review-genuine-native-body",
      carrier(checkpointInput(ref, "plan", steps)),
      undefined,
      true,
    );
    expect(text(result)).toContain('"decision":"approve"');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].material.content).toBe("Review body written by the genuine native host");
    expect(await Bun.file(target).exists()).toBe(false);
  } finally {
    await f.close();
  }
});

test("deferred checkpoint caller cancellation during the boundary review cannot become approval", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let providerAborted = false;
  const f = await fixture({
    reviewer: async (_request, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          providerAborted = true;
        },
        { once: true },
      );
      entered.resolve();
      await release.promise;
      return approved;
    },
  });
  const controller = new AbortController();
  let stopping: ReturnType<typeof f.stop> | undefined;
  const outer = { language: "js", code: carrier(checkpointInput()) };
  try {
    await f.write.execute("author-body", { path: ref, content: "Review this deferred invocation" });
    // The direct wrapper retains its caller signal while an outer Eval is active.
    await f.runner.emitToolCall({
      type: "tool_call",
      toolCallId: "outer-eval",
      toolName: "eval",
      input: outer,
    });
    const queued = await f.checkpoint.execute(
      "deferred-caller",
      { phase: "completion", evidenceRef: ref },
      controller.signal,
    );
    const receipt = JSON.parse(text(queued));
    expect(receipt).toMatchObject({ status: "queued", charged: false });
    await f.runner.emitToolResult({
      type: "tool_result",
      toolCallId: "outer-eval",
      toolName: "eval",
      input: outer,
      content: [{ type: "text", text: "Outer Eval completed" }],
      isError: false,
      details: undefined,
    });
    stopping = f.stop();
    await entered.promise;
    controller.abort(new DOMException("Caller cancelled this queued invocation", "AbortError"));
    release.resolve();
    await stopping;
    expect(providerAborted).toBe(true);
    expect(f.requests).toHaveLength(1);
    expect((await f.status()).architect).toMatchObject({
      completionApproved: false,
      attempts: { completion: 1 },
      lastReview: { invocationId: receipt.invocationId, status: "caller_cancelled", charged: true },
    });
    expect((await f.status()).architect.lastReview.verdict?.decision).not.toBe("approve");
    await f.stop();
    expect(f.requests).toHaveLength(1);
  } finally {
    release.resolve();
    await stopping?.catch(() => {});
    await f.close();
  }
});

test("active native background jobs reject direct completion without a review attempt", async () => {
  let running = true;
  const f = await fixture({ runningJobs: () => running });
  try {
    await f.write.execute("author-body", {
      path: ref,
      content: "Review only after background work settles",
    });
    const rejected = await f.write.execute("busy-direct-completion", checkpointInput());
    expect(rejected).toMatchObject({
      isError: true,
      details: { xdev: { inner: { status: "input_rejected", charged: false } } },
    });
    expect(text(rejected)).toContain("Background jobs remain active");
    expect(f.requests).toHaveLength(0);
    expect((await f.status()).architect).toMatchObject({
      completionApproved: false,
      attempts: { completion: 0 },
      lastReview: { status: "input_rejected", charged: false },
    });
    running = false;
    expect(
      (await f.write.execute("settled-direct-completion", checkpointInput())).isError,
    ).not.toBe(true);
    expect(f.requests).toHaveLength(1);
    expect((await f.status()).architect.completionApproved).toBe(true);
  } finally {
    await f.close();
  }
});

test("background jobs at the native boundary discard queued completion without later replay", async () => {
  let running = false;
  const f = await fixture({ runningJobs: () => running });
  try {
    await f.write.execute("author-body", {
      path: ref,
      content: "Review the final background result",
    });
    expect(text(await f.eval("queue-before-background", carrier(checkpointInput())))).toContain(
      '"status":"queued"',
    );
    running = true;
    expect((await f.stop())?.continue).toBe(true);
    expect(f.requests).toHaveLength(0);
    expect((await f.status()).architect).toMatchObject({
      completionApproved: false,
      attempts: { completion: 0 },
    });
    running = false;
    await f.stop();
    expect(f.requests).toHaveLength(0);
    expect(
      (await f.write.execute("fresh-completion-after-jobs", checkpointInput())).isError,
    ).not.toBe(true);
    expect(f.requests).toHaveLength(1);
    expect((await f.status()).architect).toMatchObject({
      completionApproved: true,
      attempts: { completion: 1 },
    });
  } finally {
    await f.close();
  }
});

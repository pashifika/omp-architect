import { expect, jest, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import {
  ExtensionToolWrapper,
  wrapRegisteredTool,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TodoTool } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { ReadToolDetails } from "@oh-my-pi/pi-tui/tools/read";
import type { TodoPhase, TodoToolDetails } from "@oh-my-pi/pi-tui/tools/todo";
import type { WriteToolDetails } from "@oh-my-pi/pi-tui/tools/write";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { extensionFactory } from "../src/extension.ts";
import type { Reviewer, ReviewRequest, Verdict } from "../src/core.ts";

test("explicit checkpoints at max publish blocked status and abort without another round", async () => {
  const fixture = await xdCheckpointFixture({ min: 1, max: 1 }, async () => ({
    decision: "revise",
    summary: "Tests still fail",
    issues: ["Fix failing test"],
  }));
  try {
    await expect(
      fixture.checkpoint.execute("first-completion", { phase: "completion", summary: "Done" }),
    ).resolves.toMatchObject({ isError: true, details: { decision: "revise" } });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.aborts()).toBe(1);
    expect(fixture.notices()).toBe(1);
    await expect(
      fixture.checkpoint.execute("blocked-retry", { phase: "completion", summary: "Retry" }),
    ).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.notices()).toBe(1);
    await expect(
      fixture.childCheckpoint.execute("child-completion", {
        phase: "completion",
        summary: "Worker",
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(fixture.requests).toHaveLength(1);

    await fixture.before("New request");
    const continuation = await fixture.stop();
    expect(continuation?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    await fixture.before(continuation!.additionalContext!);
    await expect(
      fixture.write.execute("continued-completion", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({ phase: "completion", summary: "All done" }),
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { xdev: { inner: { decision: "revise" } } },
    });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.aborts()).toBe(2);
    expect(fixture.notices()).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("ordinary Architect preserves minimum rounds across host before_agent_start continuation delivery", async () => {
  const fixture = await xdCheckpointFixture({ min: 2, max: 2 });
  try {
    const first = await fixture.stop();
    expect(first?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(0);
    await fixture.before(first!.additionalContext!);
    await expect(
      fixture.write.execute("completion-round-1", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({ phase: "completion", summary: "Actual fixture evidence" }),
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { xdev: { inner: { decision: "revise" } } },
    });
    expect(fixture.requests).toHaveLength(1);
    const second = await fixture.stop();
    expect(second?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    await fixture.before(second!.additionalContext!);
    await expect(
      fixture.write.execute("completion-round-2", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "completion",
          summary: "Independent current-state evidence",
        }),
      }),
    ).resolves.toMatchObject({
      isError: false,
      details: { xdev: { inner: { decision: "approve" } } },
    });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.aborts()).toBe(0);
    // Genuine interactive input cannot impersonate the stored continuation.
    await fixture.input(first!.additionalContext!);
    await fixture.before(first!.additionalContext!);
    const fresh = await fixture.stop();
    expect(fresh?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(2);
    await fixture.before(fresh!.additionalContext!);
    await expect(
      fixture.checkpoint.execute("new-request-round-1", {
        phase: "completion",
        summary: "Evidence for the new request",
      }),
    ).resolves.toMatchObject({ isError: true, details: { decision: "revise" } });
    expect(fixture.requests).toHaveLength(3);
  } finally {
    await fixture.close();
  }
});

async function xdCheckpointFixture(
  reviews?: { min: number; max: number },
  reviewer?: Reviewer,
  initialPrompt = "Implement the isolated fixture plan",
) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-xd-"));
  try {
    if (reviews)
      await Bun.write(path.join(cwd, ".omp", "architect.json"), JSON.stringify({ reviews }));
    let notices = 0;
    let aborts = 0;
    const runtime = new ExtensionRuntime();
    runtime.sendMessage = () => {
      notices++;
    };
    const requests: ReviewRequest[] = [];
    const extension = await loadExtensionFromFactory(
      extensionFactory(() => async (request, signal) => {
        requests.push(request);
        if (reviewer) return reviewer(request, signal);
        return { decision: "approve", summary: "Independent fixture review approved", issues: [] };
      }),
      cwd,
      new EventBus(),
      runtime,
    );
    const settings = Settings.isolated({ "tools.approvalMode": "yolo" });
    const sessionManager = SessionManager.inMemory(cwd);
    // No model or credentials are needed: only the independent reviewer is synthetic.
    const modelRegistry = { getAvailable: () => [] } as unknown as ModelRegistry;
    const runner = new ExtensionRunner(
      [extension],
      runtime,
      cwd,
      sessionManager,
      modelRegistry,
      undefined,
      settings,
    );
    const errors: string[] = [];
    runner.onError((error) => errors.push(error.error));
    const actions = new ExtensionRuntime();
    actions.sendMessage = runtime.sendMessage;
    runner.initialize(actions, {
      getModel: () => undefined,
      isIdle: () => true,
      abort: () => {
        aborts++;
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
    const status = new ExtensionToolWrapper(
      wrapRegisteredTool(extension.tools.get("auto_status")!, runner),
      runner,
    );
    const childRunner = new ExtensionRunner(
      [extension],
      runtime,
      cwd,
      sessionManager,
      modelRegistry,
      undefined,
      settings,
      undefined,
      undefined,
      { kind: "sub", id: "child", name: "omp-worker", depth: 1 },
    );
    childRunner.onError((error) => errors.push(error.error));
    const childCheckpoint = new ExtensionToolWrapper(
      wrapRegisteredTool(extension.tools.get("architect_checkpoint")!, childRunner),
      childRunner,
    );
    const xdev: XdevState = {
      tools: new Map([
        [checkpoint.name, checkpoint],
        [status.name, status],
      ]),
      mountedNames: new Set([checkpoint.name, status.name]),
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
      getSessionFile: () => sessionManager.getSessionFile(),
      getSessionId: () => sessionManager.getSessionId(),
      getTodoPhases: () => phases,
      setTodoPhases: (next: typeof phases) => {
        phases = next;
      },
    } as unknown as ToolSession;
    const read = new ExtensionToolWrapper<ReadTool["parameters"], ReadToolDetails>(
      new ReadTool(session),
      runner,
    );
    const write = new ExtensionToolWrapper<WriteTool["parameters"], WriteToolDetails>(
      new WriteTool(session),
      runner,
    );
    const todo = new ExtensionToolWrapper<TodoTool["parameters"], TodoToolDetails>(
      new TodoTool(session),
      runner,
    );
    await runner.emit({ type: "session_start" });
    await runner.emitBeforeAgentStart(initialPrompt, undefined, []);
    expect(errors).toEqual([]);
    return {
      cwd,
      requests,
      checkpoint,
      childCheckpoint,
      status,
      notices: () => notices,
      aborts: () => aborts,
      before: (prompt: string) => runner.emitBeforeAgentStart(prompt, undefined, []),
      input: (text: string) => runner.emitInput(text, undefined, "interactive"),
      write,
      read,
      todo,
      phases: () => phases,
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
          await runner.emit({ type: "session_shutdown" });
          expect(errors).toEqual([]);
        } finally {
          runner.clearManagedTimers();
          childRunner.clearManagedTimers();
          runner.disposeFileFallbacks();
          await fs.rm(cwd, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await fs.rm(cwd, { recursive: true, force: true });
    throw error;
  }
}

test("xd checkpoint reviews staged substantial todo before allowing filesystem execution", async () => {
  const fixture = await xdCheckpointFixture({ min: 2, max: 2 });
  const steps = ["Implement fixture behavior", "Add fixture coverage", "Record fixture evidence"];
  const pending =
    "Pending plan is not approved. Call architect_checkpoint phase=plan before execution.";
  const file = path.join(fixture.cwd, "result.txt");
  try {
    await expect(fixture.todo.execute("stage-plan", { op: "init", items: steps })).rejects.toThrow(
      "Substantial plan: call architect_checkpoint with phase plan to review these pending steps before recording or executing them.",
    );
    expect(fixture.phases()).toEqual([]);
    await expect(
      fixture.write.execute("blocked-file", { path: file, content: "fixture evidence\n" }),
    ).rejects.toThrow(pending);
    expect(await Bun.file(file).exists()).toBe(false);
    expect(fixture.requests).toHaveLength(0);
    const continuation = await fixture.stop();
    expect(continuation?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(0);
    await fixture.before(continuation!.additionalContext!);

    // Exercise the documented transport, not a direct call to the registered checkpoint.
    await expect(
      fixture.write.execute("plan-round-1", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({ phase: "plan", summary: "Review the staged fixture steps" }),
      }),
    ).resolves.toMatchObject({
      isError: true,
      details: { xdev: { tool: "architect_checkpoint", inner: { decision: "revise" } } },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.parse(fixture.requests[0].evidence).pendingPlan).toEqual(steps);
    await expect(
      fixture.write.execute("still-blocked-file", { path: file, content: "fixture evidence\n" }),
    ).rejects.toThrow(pending);
    await expect(
      fixture.write.execute("plan-round-2", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "plan",
          summary: "Independent current-state fixture review",
        }),
      }),
    ).resolves.toMatchObject({
      isError: false,
      details: { xdev: { tool: "architect_checkpoint", inner: { decision: "approve" } } },
    });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.map((request) => request.phase)).toEqual(["plan", "plan"]);
    const recorded = await fixture.todo.execute("record-approved-plan", {
      op: "init",
      items: steps,
    });
    expect(recorded.isError).not.toBe(true);
    expect(fixture.phases().flatMap((phase) => phase.tasks.map((task) => task.content))).toEqual(
      steps,
    );
    const executed = await fixture.write.execute("execute-approved-plan", {
      path: file,
      content: "fixture evidence\n",
    });
    expect(executed.isError).not.toBe(true);
    expect(await Bun.file(file).text()).toBe("fixture evidence\n");
    expect(fixture.requests).toHaveLength(2);
  } finally {
    await fixture.close();
  }
});

test("xd completion approval survives its outer write result but fresh filesystem evidence invalidates it", async () => {
  const fixture = await xdCheckpointFixture({ min: 1, max: 2 });
  try {
    await expect(
      fixture.write.execute("completion-review", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "completion",
          summary: "Review the completed fixture evidence",
        }),
      }),
    ).resolves.toMatchObject({
      isError: false,
      details: { xdev: { tool: "architect_checkpoint", inner: { decision: "approve" } } },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(await fixture.stop()).toBeUndefined();
    // The outer write tool_result must not spend another completion review.
    expect(fixture.requests).toHaveLength(1);

    const file = path.join(fixture.cwd, "fresh-evidence.txt");
    await fixture.write.execute("fresh-file-evidence", { path: file, content: "new evidence\n" });
    expect(await Bun.file(file).text()).toBe("new evidence\n");
    const continuation = await fixture.stop();
    expect(continuation?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    await fixture.before(continuation!.additionalContext!);
    await expect(
      fixture.write.execute("fresh-completion-review", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "completion",
          summary: "Review the new filesystem evidence",
        }),
      }),
    ).resolves.toMatchObject({
      isError: false,
      details: { xdev: { inner: { decision: "approve" } } },
    });
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.map((request) => request.phase)).toEqual(["completion", "completion"]);
    expect(fixture.requests[1].revision).toBeGreaterThan(fixture.requests[0].revision);
    const evidence = JSON.parse(fixture.requests[1].evidence);
    expect(evidence.recentToolEvidence.map((entry: string) => JSON.parse(entry))).toContainEqual(
      expect.objectContaining({
        tool: "write",
        input: { path: file, content: "new evidence\n" },
        isError: false,
        output: expect.stringContaining("Successfully wrote"),
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("xd completion reviews the newest actual write despite oversized input and accumulated evidence", async () => {
  const steps = ["Write prior evidence", "Write the current result", "Review filesystem evidence"];
  const latestContent = 'Current result: "verified" \\ \t日本語\n'.repeat(1_500);
  let latestPath = "";
  let latestOutput = "";
  const fixture = await xdCheckpointFixture(
    { min: 1, max: 2 },
    async (request) => {
      expect(request.evidence.length).toBeLessThanOrEqual(24_000);
      const snapshot = JSON.parse(request.evidence);
      const records = snapshot.recentToolEvidence.map((entry: string) => JSON.parse(entry));
      if (request.phase === "plan") {
        expect(snapshot.pendingPlan).toEqual(steps);
      } else {
        expect(request.phase).toBe("completion");
        expect(await fs.readFile(latestPath, "utf8")).toBe(latestContent);
        expect(latestOutput).toContain(
          `Successfully wrote ${Buffer.byteLength(latestContent, "utf8")} bytes`,
        );
        expect(latestOutput).toContain(path.basename(latestPath));
        expect(records.at(-1)).toMatchObject({
          tool: "write",
          isError: false,
          output: latestOutput,
        });
      }
      return { decision: "approve", summary: "Actual filesystem evidence retained", issues: [] };
    },
    "Implement and verify the current filesystem result. ".repeat(200),
  );
  try {
    await expect(
      fixture.todo.execute("stage-evidence-plan", { op: "init", items: steps }),
    ).rejects.toThrow("Substantial plan");
    await expect(
      fixture.write.execute("approve-evidence-plan", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({ phase: "plan", summary: "Review the staged evidence plan" }),
      }),
    ).resolves.toMatchObject({
      isError: false,
      details: { xdev: { inner: { decision: "approve" } } },
    });
    const recorded = await fixture.todo.execute("record-evidence-plan", {
      op: "init",
      items: steps,
    });
    expect(recorded.isError).not.toBe(true);
    for (let index = 0; index < 6; index++) {
      const result = await fixture.write.execute(`prior-evidence-${index}`, {
        path: path.join(fixture.cwd, `prior-${index}.txt`),
        content: `Prior filesystem evidence ${index}\n${"old data ".repeat(350)}`,
      });
      expect(result.isError).not.toBe(true);
    }
    latestPath = path.join(fixture.cwd, "latest-confirmed-result.txt");
    const latest = await fixture.write.execute("latest-filesystem-evidence", {
      path: latestPath,
      content: latestContent,
    });
    expect(latest.isError).not.toBe(true);
    latestOutput = latest.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(await fs.readFile(latestPath, "utf8")).toBe(latestContent);
    await expect(
      fixture.write.execute("review-latest-filesystem-evidence", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "completion",
          summary:
            "Review the current successful filesystem write and its observed result. ".repeat(100),
        }),
      }),
    ).resolves.toMatchObject({
      isError: false,
      details: { xdev: { tool: "architect_checkpoint", inner: { decision: "approve" } } },
    });
    expect(fixture.requests.map((request) => request.phase)).toEqual(["plan", "completion"]);
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.aborts()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("xd completion retains the beginning and final status of a real SDK read result", async () => {
  const report = [
    "Filesystem verification report: current-result",
    ...Array.from({ length: 100 }, (_, index) => `Checked item ${index}: ${"detail ".repeat(15)}`),
    "Final filesystem verification status: PASS current-result",
  ].join("\n");
  let reportPath = "";
  let observedOutput = "";
  const fixture = await xdCheckpointFixture({ min: 1, max: 1 }, async (request) => {
    expect(request.phase).toBe("completion");
    expect(request.evidence.length).toBeLessThanOrEqual(24_000);
    const snapshot = JSON.parse(request.evidence);
    const records = snapshot.recentToolEvidence.map((entry: string) => JSON.parse(entry));
    const latest = records.at(-1);
    expect(latest).toMatchObject({
      tool: "read",
      input: { path: `${reportPath}:raw` },
      isError: false,
    });
    expect(await fs.readFile(reportPath, "utf8")).toBe(report);
    expect(latest.output.startsWith(observedOutput.slice(0, 128))).toBe(true);
    expect(latest.output.endsWith(observedOutput.slice(-128))).toBe(true);
    expect(latest.output).toContain("Final filesystem verification status: PASS current-result");
    expect(latest.output.length).toBeLessThan(observedOutput.length);
    expect(latest.output).toMatch(/omitt|truncat/i);
    return {
      decision: "approve",
      summary: "Actual read result retains its final status",
      issues: [],
    };
  });
  try {
    reportPath = path.join(fixture.cwd, "verification-report.txt");
    const written = await fixture.write.execute("write-verification-report", {
      path: reportPath,
      content: report,
    });
    expect(written.isError).not.toBe(true);
    const read = await fixture.read.execute("read-verification-report", {
      path: `${reportPath}:raw`,
    });
    expect(read.isError).not.toBe(true);
    observedOutput = read.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    expect(observedOutput.length).toBeGreaterThan(8_000);
    expect(observedOutput).toContain("Filesystem verification report: current-result");
    expect(observedOutput).toContain("Final filesystem verification status: PASS current-result");
    await expect(
      fixture.write.execute("review-final-read-status", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "completion",
          summary: "Review the actual report including its final verification status",
        }),
      }),
    ).resolves.toMatchObject({
      isError: false,
      details: { xdev: { tool: "architect_checkpoint", inner: { decision: "approve" } } },
    });
    expect(fixture.requests).toHaveLength(1);
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.aborts()).toBe(0);
  } finally {
    await fixture.close();
  }
});

test("xd slow explicit plan checkpoint approves beyond timeout and hook budgets before releasing staged execution", async () => {
  const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
  let cancelProvider = () => {};
  let providerAborted = false;
  const slowReviewer: Reviewer = (_request, signal) => {
    const { promise, resolve, reject } = Promise.withResolvers<Verdict>();
    let finished = false;
    const finish = (error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else
        resolve({
          decision: "approve",
          summary: "Independent slow fixture review approved",
          issues: [],
        });
    };
    const aborted = () => {
      providerAborted = true;
      finish(signal.reason ?? new Error("Fixture provider cancelled"));
    };
    // This callback runs only after useFakeTimers(), so no wall-clock delay is scheduled.
    const timer = setTimeout(() => finish(), 35_000);
    cancelProvider = () => finish(new Error("Fixture provider cleanup"));
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    markStarted();
    return promise;
  };
  // Load and initialize real SDK hooks before replacing the clock; keep production defaults.
  const fixture = await xdCheckpointFixture(undefined, slowReviewer);
  const steps = ["Implement slow fixture", "Cover slow fixture", "Record slow fixture evidence"];
  const file = path.join(fixture.cwd, "slow-result.txt");
  let checkpoint: Promise<unknown> | undefined;
  try {
    jest.useFakeTimers();
    let settled = false;
    checkpoint = fixture.write.execute("slow-plan-review", {
      path: "xd://architect_checkpoint",
      content: JSON.stringify({
        phase: "plan",
        summary: "Independent review of the staged slow fixture plan",
        steps,
      }),
    });
    void checkpoint.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await started;
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.parse(fixture.requests[0].evidence).pendingPlan).toEqual(steps);
    await expect(
      fixture.write.execute("blocked-during-slow-review", {
        path: file,
        content: "slow evidence\n",
      }),
    ).rejects.toThrow(
      "Pending plan is not approved. Call architect_checkpoint phase=plan before execution.",
    );
    jest.advanceTimersByTime(24_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(providerAborted).toBe(false);
    // Cross both the old 25s architect deadline and the SDK's 30s hook wait budget.
    jest.advanceTimersByTime(10_001);
    await expect(checkpoint).resolves.toMatchObject({
      isError: false,
      details: {
        xdev: {
          tool: "architect_checkpoint",
          inner: { decision: "approve", summary: "Independent slow fixture review approved" },
        },
      },
    });
    expect(providerAborted).toBe(false);
    expect(fixture.requests).toHaveLength(1);
    const execution = await fixture.write.execute("execute-slow-approved-plan", {
      path: file,
      content: "slow evidence\n",
    });
    expect(execution.isError).not.toBe(true);
    expect(await Bun.file(file).text()).toBe("slow evidence\n");
    expect(fixture.requests).toHaveLength(1);
  } finally {
    try {
      cancelProvider();
      await checkpoint?.catch(() => {});
    } finally {
      jest.useRealTimers();
      await fixture.close();
    }
  }
});

test.each([
  { scenario: "unknown xd device remains plan-gated", destination: "xd://unknown_device" },
  {
    scenario: "checkpoint name suffix remains plan-gated",
    destination: "xd://architect_checkpoint_extra",
  },
  {
    scenario: "checkpoint subpath remains plan-gated",
    destination: "xd://architect_checkpoint/extra",
  },
  { scenario: "status name suffix remains plan-gated", destination: "xd://auto_status_extra" },
  { scenario: "status subpath remains plan-gated", destination: "xd://auto_status/extra" },
])("$scenario", async ({ destination }) => {
  const fixture = await xdCheckpointFixture();
  try {
    await expect(
      fixture.todo.execute("stage-plan", { op: "init", items: ["Inspect", "Implement", "Test"] }),
    ).rejects.toThrow("Substantial plan");
    await expect(
      fixture.write.execute("noncanonical-device", { path: destination, content: "{}" }),
    ).rejects.toThrow("Pending plan");
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.phases()).toEqual([]);
  } finally {
    await fixture.close();
  }
});

test("native and xd status remain read-only through pending plans, approval, and bounded stop exhaustion", async () => {
  const fixture = await xdCheckpointFixture({ min: 1, max: 2 });
  const checkStatus = async (id: string) => {
    const native = await fixture.status.execute(`native-${id}`, {});
    const remote = await fixture.write.execute(`xd-${id}`, {
      path: "xd://auto_status",
      content: "{}",
    });
    expect(native.isError).not.toBe(true);
    expect(remote.isError).not.toBe(true);
    expect(remote.content).toEqual(native.content);
    expect(remote.details).toMatchObject({ xdev: { tool: "auto_status" } });
  };
  try {
    await expect(
      fixture.todo.execute("stage-plan", { op: "init", items: ["Inspect", "Implement", "Test"] }),
    ).rejects.toThrow("Substantial plan");
    await checkStatus("pending-plan");
    expect(fixture.requests).toHaveLength(0);
    await expect(
      fixture.checkpoint.execute("approve-plan", { phase: "plan", summary: "Review staged steps" }),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      fixture.checkpoint.execute("approve-completion", {
        phase: "completion",
        summary: "Review current fixture evidence",
      }),
    ).resolves.toMatchObject({ isError: false });
    await checkStatus("approved-completion");
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);

    await fixture.before("New request without a checkpoint");
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await fixture.stop(cancelled.signal)).toBeUndefined();
    const first = await fixture.stop();
    expect(first?.continue).toBe(true);
    await fixture.before(first!.additionalContext!);
    const second = await fixture.stop();
    expect(second?.continue).toBe(true);
    await fixture.before(second!.additionalContext!);
    expect(await fixture.stop()).toBeUndefined();
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.notices()).toBe(1);
    expect(fixture.aborts()).toBe(1);
    await checkStatus("stopped-request");
    await expect(
      fixture.write.execute("stopped-file", {
        path: path.join(fixture.cwd, "denied.txt"),
        content: "Must not be written",
      }),
    ).rejects.toThrow();
    expect(await Bun.file(path.join(fixture.cwd, "denied.txt")).exists()).toBe(false);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.notices()).toBe(1);
    expect(fixture.aborts()).toBe(1);
  } finally {
    await fixture.close();
  }
});

test("xd checkpoint failures do not become ordinary repeated tool failures", async () => {
  let rounds = 0;
  const fixture = await xdCheckpointFixture({ min: 1, max: 3 }, async () => {
    rounds++;
    return rounds < 3
      ? { decision: "revise", summary: "Missing verification", issues: ["Verify the change"] }
      : { decision: "approve", summary: "Current evidence reviewed", issues: [] };
  });
  try {
    // Distinct summaries bypass the evidence cache without an ordinary tool result between reviews.
    for (const id of ["first-review", "second-review"])
      await expect(
        fixture.write.execute(id, {
          path: "xd://architect_checkpoint",
          content: JSON.stringify({
            phase: "completion",
            summary: `Review current evidence independently (${id})`,
          }),
        }),
      ).resolves.toMatchObject({
        isError: true,
        details: { xdev: { inner: { decision: "revise" } } },
      });
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.aborts()).toBe(0);
    const file = path.join(fixture.cwd, "new-verification.txt");
    const result = await fixture.write.execute("ordinary-evidence", {
      path: file,
      content: "Verified fixture evidence\n",
    });
    expect(result.isError).not.toBe(true);
    expect(await Bun.file(file).text()).toBe("Verified fixture evidence\n");
    await expect(
      fixture.write.execute("approved-review", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({ phase: "completion", summary: "Review the new verification" }),
      }),
    ).resolves.toMatchObject({ isError: false });
    expect(fixture.requests.map((request) => request.phase)).toEqual([
      "completion",
      "completion",
      "completion",
    ]);
    expect(JSON.parse(fixture.requests[2].evidence).pendingRecovery).toBe(false);
    expect(await fixture.stop()).toBeUndefined();
  } finally {
    await fixture.close();
  }
});

test("ordinary stop returns a continuation without invoking or waiting on the provider", async () => {
  const provider = Promise.withResolvers<Verdict>();
  const invoked = Promise.withResolvers<never>();
  const fixture = await xdCheckpointFixture(undefined, async () => {
    invoked.reject(new Error("Ordinary stop invoked provider work"));
    return provider.promise;
  });
  const stopping = fixture.stop();
  try {
    const result = await Promise.race([stopping, invoked.promise]);
    expect(result?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(0);
    expect(fixture.aborts()).toBe(0);
    await fixture.before(result!.additionalContext!);
    expect(fixture.requests).toHaveLength(0);
  } finally {
    provider.resolve({ decision: "approve", summary: "Fixture cleanup", issues: [] });
    await stopping.catch(() => {});
    await fixture.close();
  }
});

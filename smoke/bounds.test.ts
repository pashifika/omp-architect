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
      fixture.checkpoint.execute("first-completion", {
        phase: "completion",
        evidenceRef: await fixture.evidence("Done"),
      }),
    ).resolves.toMatchObject({ isError: true, details: { decision: "revise" } });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.aborts()).toBe(1);
    expect(fixture.notices()).toBe(1);
    await expect(
      fixture.checkpoint.execute("blocked-retry", {
        phase: "completion",
        evidenceRef: await fixture.evidence("Retry"),
      }),
    ).rejects.toThrow();
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.notices()).toBe(1);
    await expect(
      fixture.childCheckpoint.execute("child-completion", {
        phase: "completion",
        evidenceRef: await fixture.evidence("Worker"),
      }),
    ).resolves.toMatchObject({ isError: true });
    expect(fixture.requests).toHaveLength(1);

    await fixture.input("New request");
    await fixture.before("New request");
    const continuation = await fixture.stop();
    expect(continuation?.continue).toBe(true);
    expect(fixture.requests).toHaveLength(1);
    await fixture.before(continuation!.additionalContext!);
    await expect(
      fixture.write.execute("continued-completion", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "completion",
          evidenceRef: await fixture.evidence("All done"),
        }),
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
        content: JSON.stringify({
          phase: "completion",
          evidenceRef: await fixture.evidence("Actual fixture evidence"),
        }),
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
          evidenceRef: await fixture.evidence("Independent current-state evidence"),
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
        evidenceRef: await fixture.evidence("Evidence for the new request"),
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
    const sessionManager = SessionManager.create(cwd, path.join(cwd, ".test-sessions"));
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
      async evidence(content: string): Promise<string> {
        const id = await sessionManager.saveArtifact(content, "architect-review");
        if (!id) throw new Error("Fixture review artifact was not saved");
        return `artifact://${id}`;
      },
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
        content: JSON.stringify({
          phase: "plan",
          evidenceRef: await fixture.evidence("Review the staged fixture steps"),
        }),
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
          evidenceRef: await fixture.evidence("Independent current-state fixture review"),
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
          evidenceRef: await fixture.evidence("Review the completed fixture evidence"),
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
          evidenceRef: await fixture.evidence("Review the new filesystem evidence"),
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
        content: JSON.stringify({
          phase: "plan",
          evidenceRef: await fixture.evidence("Review the staged evidence plan"),
        }),
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
          evidenceRef: await fixture.evidence(
            "Review the current successful filesystem write and its observed result. ".repeat(100),
          ),
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
          evidenceRef: await fixture.evidence(
            "Review the actual report including its final verification status",
          ),
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
    // Gate denials are now evidence; stage them before review so it stays current.
    await expect(
      fixture.todo.execute("stage-slow-plan", { op: "init", items: steps }),
    ).rejects.toThrow("Substantial plan");
    await expect(
      fixture.write.execute("blocked-before-slow-review", {
        path: file,
        content: "slow evidence\n",
      }),
    ).rejects.toThrow("Pending plan is not approved");
    jest.useFakeTimers();
    let settled = false;
    checkpoint = fixture.write.execute("slow-plan-review", {
      path: "xd://architect_checkpoint",
      content: JSON.stringify({
        phase: "plan",
        evidenceRef: await fixture.evidence("Independent review of the staged slow fixture plan"),
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
      fixture.checkpoint.execute("approve-plan", {
        phase: "plan",
        evidenceRef: await fixture.evidence("Review staged steps"),
      }),
    ).resolves.toMatchObject({ isError: false });
    await expect(
      fixture.checkpoint.execute("approve-completion", {
        phase: "completion",
        evidenceRef: await fixture.evidence("Review current fixture evidence"),
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
    // Distinct review artifacts bypass the evidence cache without an ordinary tool result between reviews.
    for (const id of ["first-review", "second-review"])
      await expect(
        fixture.write.execute(id, {
          path: "xd://architect_checkpoint",
          content: JSON.stringify({
            phase: "completion",
            evidenceRef: await fixture.evidence(`Review current evidence independently (${id})`),
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
        content: JSON.stringify({
          phase: "completion",
          evidenceRef: await fixture.evidence("Review the new verification"),
        }),
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

const canonicalSteps = [
  "Inspect proposal context",
  "Draft planning artifacts",
  "Validate artifacts",
];

for (const transport of ["native", "xd"] as const)
  test(`${transport} plan revision must repair canonical steps, not only review prose`, async () => {
    const original = [
      "Implement the prepared change",
      "Verify implementation and review the results",
      "5.2 Reconcile requirements, retain verification evidence, deliver the product PR and commit/push planning separately",
    ];
    const corrected = [
      ...original.slice(0, 2),
      "5.2 Reconcile requirements and retain verification evidence. Commit/push/PR delivery and planning-Git publication are blocked pending separate user authorization; keep those portions pending and do not mark 5.2 complete",
    ];
    const f = await xdCheckpointFixture(
      { min: 1, max: 3 },
      async ({ canonicalPlan }) =>
        canonicalPlan[2] === corrected[2]
          ? { decision: "approve", summary: "Authorized scope is explicit", issues: [] }
          : {
              decision: "revise",
              summary: "The review body defers publication, but canonical step 5.2 does not",
              issues: ["Mark only the unauthorized portions of 5.2 blocked pending authorization"],
            },
      "Resume implementation, verification and review only; publication needs separate authorization",
    );
    try {
      const checkpoint = async (id: string, body: string, steps?: string[]) => {
        const params = {
          phase: "plan" as const,
          evidenceRef: await f.evidence(body),
          ...(steps ? { steps } : {}),
        };
        const result =
          transport === "native"
            ? await f.checkpoint.execute(id, params)
            : await f.write.execute(id, {
                path: "xd://architect_checkpoint",
                content: JSON.stringify(params),
              });
        const content = result.content[0];
        if (content.type !== "text") throw new Error("Missing checkpoint result");
        return { isError: result.isError, ...JSON.parse(content.text) };
      };
      const first = await checkpoint(
        "initial-plan",
        "Review implementation and verification",
        original,
      );
      expect(first).toMatchObject({
        isError: true,
        decision: "revise",
        review: { status: "provider_verdict", charged: true, attempt: 1 },
        plan: { pending: { steps: original, approved: false }, approved: null },
      });
      expect(first.next).toContain("full corrected steps array");
      expect(first.next).toContain("editing only the review body does not replace");
      expect(first.next).toContain("Keep authorized work executable");
      const body =
        "Implement and verify. Publication is deferred pending separate user authorization";
      const proseOnly = await checkpoint("prose-only-repair", body);
      expect(proseOnly).toMatchObject({
        isError: true,
        decision: "revise",
        review: { status: "provider_verdict", charged: true, attempt: 2 },
        plan: { pending: { id: first.plan.pending.id, steps: original, approved: false } },
      });
      await expect(
        f.write.execute("still-gated", {
          path: path.join(f.cwd, "implementation.md"),
          content: "Not yet admitted",
        }),
      ).rejects.toThrow("Pending plan");
      expect(await Bun.file(path.join(f.cwd, "implementation.md")).exists()).toBe(false);

      const repaired = await checkpoint("canonical-repair", body, corrected);
      expect(repaired).toMatchObject({
        isError: false,
        decision: "approve",
        review: { status: "provider_verdict", charged: true, attempt: 3 },
        plan: { pending: { steps: corrected, approved: true }, approved: { steps: corrected } },
      });
      expect(repaired.plan.pending.id).not.toBe(first.plan.pending.id);
      expect(f.requests.map((request) => request.canonicalPlan)).toEqual([
        original,
        original,
        corrected,
      ]);
      expect(f.requests[1].material.content).toBe(body);
      expect(f.requests[2].material.content).toBe(body);
      expect(f.aborts()).toBe(0);
      await f.todo.execute("register-repaired", {
        op: "init",
        items: repaired.plan.approved.steps,
      });
      await f.write.execute("authorized-part", {
        path: path.join(f.cwd, "implementation.md"),
        content: "Authorized implementation evidence",
      });
      expect(await Bun.file(path.join(f.cwd, "implementation.md")).text()).toBe(
        "Authorized implementation evidence",
      );
      expect(f.phases().flatMap((phase) => phase.tasks)[2]).toMatchObject({
        content: corrected[2],
        status: "pending",
      });
      const status = await f.status.execute("no-spurious-recovery", {});
      const content = status.content[0];
      if (content.type !== "text") throw new Error("Missing status");
      expect(JSON.parse(content.text).architect.pendingRecovery).toBe(false);
      expect(f.requests).toHaveLength(3);
    } finally {
      await f.close();
    }
  });

test("real host returns canonical plan identity, explains punctuation mismatch and restores approved todo", async () => {
  const f = await xdCheckpointFixture();
  try {
    const result = await f.checkpoint.execute("approve-canonical", {
      phase: "plan",
      evidenceRef: await f.evidence("Planning only"),
      steps: canonicalSteps,
    });
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Missing plan result");
    const approved = JSON.parse(content.text).plan.approved;
    expect(approved.steps).toEqual(canonicalSteps);
    expect(approved.id).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      f.todo.execute("mismatch", {
        op: "init",
        items: [canonicalSteps[0] + ".", ...canonicalSteps.slice(1)],
      }),
    ).rejects.toThrow("Step 1 differs");
    await expect(
      f.write.execute("blocked-proposal", {
        path: path.join(f.cwd, "proposal.md"),
        content: "Draft",
      }),
    ).rejects.toThrow(approved.id);
    const status = await f.status.execute("diagnose", {});
    const statusContent = status.content[0];
    if (statusContent.type !== "text") throw new Error("Missing status");
    expect(JSON.parse(statusContent.text).architect.plan.approved).toEqual(approved);
    await f.todo.execute("restore", { op: "init", items: approved.steps });
    await f.write.execute("proposal", { path: path.join(f.cwd, "proposal.md"), content: "Draft" });
    expect(f.phases().flatMap((p) => p.tasks.map((t) => t.content))).toEqual(canonicalSteps);
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("real host rejects prose-only and empty replacement plans without charging or clearing a gate", async () => {
  const f = await xdCheckpointFixture();
  try {
    expect(
      await f.checkpoint.execute("prose-only", {
        phase: "plan",
        evidenceRef: await f.evidence("Inspect, implement, verify"),
      }),
    ).toMatchObject({ isError: true, details: { decision: "blocked" } });
    expect(f.requests).toHaveLength(0);
    await expect(f.todo.execute("stage", { op: "init", items: canonicalSteps })).rejects.toThrow(
      "Substantial plan",
    );
    expect(
      await f.checkpoint.execute("empty", {
        phase: "plan",
        evidenceRef: await f.evidence("Empty replacement"),
        steps: [],
      }),
    ).toMatchObject({ isError: true });
    await expect(
      f.write.execute("must-stay-blocked", { path: path.join(f.cwd, "blocked"), content: "x" }),
    ).rejects.toThrow("Pending plan");
    expect(f.requests).toHaveLength(0);
    expect(
      await f.checkpoint.execute("review-staged", {
        phase: "plan",
        evidenceRef: await f.evidence("Review staged actual steps"),
      }),
    ).toMatchObject({ isError: false });
    const snapshot = JSON.parse(f.requests[0].evidence);
    expect(snapshot.pendingPlan).toEqual(canonicalSteps);
    expect(snapshot.pendingRecovery).toBe(false);
    const denied = snapshot.recentToolEvidence.map((item: string) => JSON.parse(item));
    expect(denied).toHaveLength(2);
    expect(
      denied.every(
        (item: { kind: string; executed: boolean }) =>
          item.kind === "gate_denial" && item.executed === false,
      ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

for (const todoFirst of [true, false])
  test(`host batch admission remains order-dependent; sequential canonical registration is required (${todoFirst})`, async () => {
    const f = await xdCheckpointFixture();
    try {
      await f.checkpoint.execute("approve", {
        phase: "plan",
        evidenceRef: await f.evidence("Review"),
        steps: canonicalSteps,
      });
      const file = path.join(f.cwd, "batch.md");
      const todo = () =>
        f.todo.execute("changed-todo", {
          op: "init",
          items: [canonicalSteps[0] + ".", ...canonicalSteps.slice(1)],
        });
      const write = () => f.write.execute("batch-write", { path: file, content: "Fixture" });
      const results = await Promise.allSettled(todoFirst ? [todo(), write()] : [write(), todo()]);
      expect(results[todoFirst ? 0 : 1].status).toBe("rejected");
      expect(results[todoFirst ? 1 : 0].status).toBe(todoFirst ? "rejected" : "fulfilled");
      expect(await Bun.file(file).exists()).toBe(!todoFirst);
      await f.todo.execute("restore-exact", { op: "init", items: canonicalSteps });
      await f.write.execute("sequential-write", {
        path: file,
        content: "Sequential canonical fixture",
      });
      expect(await Bun.file(file).text()).toBe("Sequential canonical fixture");
    } finally {
      await f.close();
    }
  });

test.each([
  "plan",
  "recovery",
  "completion",
] as const)("terminal %s stops once without futile continuations", async (phase) => {
  const f = await xdCheckpointFixture({ min: 1, max: 2 }, async () => ({
    decision: "blocked",
    summary: "Unresolved fixture blocker",
    issues: ["Need evidence"],
  }));
  try {
    for (let i = 0; i < 2; i++)
      await f.checkpoint.execute(`review-${i}`, {
        phase,
        evidenceRef: await f.evidence(`Independent review ${i}`),
        ...(phase === "plan" ? { steps: canonicalSteps } : {}),
      });
    expect(f.aborts()).toBe(1);
    expect(f.notices()).toBe(1);
    expect(await f.stop()).toBeUndefined();
    expect(await f.stop()).toBeUndefined();
    await expect(
      f.checkpoint.execute("retry", { phase, evidenceRef: await f.evidence("Futile retry") }),
    ).rejects.toThrow("stopped this request");
    expect(f.requests).toHaveLength(2);
    expect(f.aborts()).toBe(1);
    expect(f.notices()).toBe(1);
    expect((await f.status.execute("stopped-status", {})).isError).not.toBe(true);
  } finally {
    await f.close();
  }
});

test.each([
  "plan",
  "recovery",
  "completion",
] as const)("cancelled final %s attempt is terminal without another provider call", async (phase) => {
  let controller: AbortController;
  const f = await xdCheckpointFixture({ min: 1, max: 2 }, async () => {
    queueMicrotask(() => controller.abort(new Error("Fixture cancellation")));
    return new Promise<Verdict>(() => {});
  });
  try {
    for (let i = 0; i < 2; i++) {
      controller = new AbortController();
      expect(
        await f.checkpoint.execute(
          `cancel-${i}`,
          {
            phase,
            evidenceRef: await f.evidence(`Attempt ${i}`),
            ...(phase === "plan" ? { steps: canonicalSteps } : {}),
          },
          controller.signal,
        ),
      ).toMatchObject({ isError: true });
      expect(f.aborts()).toBe(i === 0 ? 0 : 1);
    }
    expect(await f.stop()).toBeUndefined();
    expect(f.requests).toHaveLength(2);
    expect(f.notices()).toBe(1);
  } finally {
    await f.close();
  }
});

test("last-round approvals remain usable across all three phases", async () => {
  const f = await xdCheckpointFixture({ min: 1, max: 1 });
  try {
    await f.checkpoint.execute("plan", {
      phase: "plan",
      evidenceRef: await f.evidence("Review exact plan"),
      steps: canonicalSteps,
    });
    await f.todo.execute("register", { op: "init", items: canonicalSteps });
    await f.checkpoint.execute("recovery", {
      phase: "recovery",
      evidenceRef: await f.evidence("Review recovered approach"),
    });
    await f.write.execute("execute", { path: path.join(f.cwd, "last-round"), content: "verified" });
    await f.checkpoint.execute("completion", {
      phase: "completion",
      evidenceRef: await f.evidence("Review actual evidence"),
    });
    expect(await f.stop()).toBeUndefined();
    expect(f.requests).toHaveLength(3);
    expect(f.aborts()).toBe(0);
    expect(f.notices()).toBe(0);
  } finally {
    await f.close();
  }
});

test("below-budget blocked recovery remains retriable", async () => {
  const f = await xdCheckpointFixture({ min: 1, max: 2 }, async (request) =>
    request.material.content.includes("Additional evidence")
      ? { decision: "approve", summary: "Reviewed", issues: [] }
      : { decision: "blocked", summary: "Need evidence", issues: ["Inspect"] },
  );
  try {
    await f.checkpoint.execute("first", {
      phase: "recovery",
      evidenceRef: await f.evidence("Initial evidence"),
    });
    const next = await f.stop();
    expect(next?.continue).toBe(true);
    await f.before(next!.additionalContext!);
    expect(
      await f.checkpoint.execute("second", {
        phase: "recovery",
        evidenceRef: await f.evidence("Additional evidence"),
      }),
    ).toMatchObject({ isError: false });
    expect(f.aborts()).toBe(0);
    expect(f.requests).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("new denial on final in-flight plan review is terminal stale evidence", async () => {
  const deferred = Promise.withResolvers<Verdict>();
  const started = Promise.withResolvers<void>();
  const f = await xdCheckpointFixture({ min: 1, max: 1 }, async () => {
    started.resolve();
    return deferred.promise;
  });
  try {
    const pending = f.checkpoint.execute("last-plan", {
      phase: "plan",
      evidenceRef: await f.evidence("Review"),
      steps: canonicalSteps,
    });
    await started.promise;
    await expect(
      f.write.execute("blocked-during-review", { path: path.join(f.cwd, "denied"), content: "x" }),
    ).rejects.toThrow("Pending plan");
    deferred.resolve({ decision: "approve", summary: "Stale approval", issues: [] });
    expect(await pending).toMatchObject({
      isError: true,
      details: { summary: expect.stringContaining("stale") },
    });
    expect(await f.stop()).toBeUndefined();
    expect(f.aborts()).toBe(1);
    expect(f.requests).toHaveLength(1);
  } finally {
    deferred.resolve({ decision: "blocked", summary: "Cleanup", issues: [] });
    await f.close();
  }
});

test("structured blocked checkpoint ends an honest report without reviewing or claiming completion", async () => {
  const f = await xdCheckpointFixture();
  try {
    await f.checkpoint.execute("prior-approval", {
      phase: "completion",
      evidenceRef: await f.evidence("Prior evidence"),
    });
    expect(
      await f.write.execute("honest-blocker", {
        path: "xd://architect_checkpoint",
        content: JSON.stringify({
          phase: "blocked",
          evidenceRef: await f.evidence("Operator authorization is missing"),
        }),
      }),
    ).toMatchObject({ isError: true });
    expect(await f.stop()).toBeUndefined();
    expect(await f.stop()).toBeUndefined();
    expect(f.requests).toHaveLength(1);
    expect(f.aborts()).toBe(1);
    expect(f.notices()).toBe(1);
    const status = await f.status.execute("status", {});
    const content = status.content[0];
    if (content.type !== "text") throw new Error("Missing status");
    expect(JSON.parse(content.text).architect.completionApproved).toBe(false);
  } finally {
    await f.close();
  }
});

test("final allowed review is not terminal while it is still in flight", async () => {
  const deferred = Promise.withResolvers<Verdict>();
  const started = Promise.withResolvers<void>();
  const f = await xdCheckpointFixture({ min: 1, max: 1 }, async () => {
    started.resolve();
    return deferred.promise;
  });
  try {
    const pending = f.checkpoint.execute("final-in-flight", {
      phase: "completion",
      evidenceRef: await f.evidence("Review current evidence"),
    });
    await started.promise;
    const status = await f.status.execute("status-during-review", {});
    const content = status.content[0];
    if (content.type !== "text") throw new Error("Missing status");
    expect(JSON.parse(content.text).architect.terminalReason).toBeNull();
    expect(await f.stop()).toBeUndefined();
    expect(f.aborts()).toBe(0);
    deferred.resolve({ decision: "approve", summary: "Current evidence approved", issues: [] });
    expect(await pending).toMatchObject({ isError: false });
    expect(await f.stop()).toBeUndefined();
    expect(f.aborts()).toBe(0);
  } finally {
    deferred.resolve({ decision: "blocked", summary: "Cleanup", issues: [] });
    await f.close();
  }
});

test("stale ordinary continuation cannot restart a terminal request without genuine user input", async () => {
  const f = await xdCheckpointFixture();
  try {
    const queued = await f.stop();
    expect(queued?.continue).toBe(true);
    await f.checkpoint.execute("stop-before-delivery", {
      phase: "blocked",
      evidenceRef: await f.evidence("Need user decision"),
    });
    await f.before(queued!.additionalContext!);
    await expect(
      f.checkpoint.execute("stale-retry", {
        phase: "completion",
        evidenceRef: await f.evidence("Must not review"),
      }),
    ).rejects.toThrow("stopped this request");
    expect(await f.stop()).toBeUndefined();
    expect(f.requests).toHaveLength(0);
    expect(f.notices()).toBe(1);
    // Genuine input may deliberately reuse the old text and still starts a fresh request.
    await f.input(queued!.additionalContext!);
    await f.before(queued!.additionalContext!);
    expect(
      await f.checkpoint.execute("new-user-review", {
        phase: "completion",
        evidenceRef: await f.evidence("New request evidence"),
      }),
    ).toMatchObject({ isError: false });
    expect(f.requests).toHaveLength(1);
    expect(await f.stop()).toBeUndefined();
  } finally {
    await f.close();
  }
});

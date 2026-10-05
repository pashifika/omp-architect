import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { createAutoController } from "../src/auto/extension.ts";
import {
  AutoPreflightError,
  type AutoCompletionStage,
  type AutoStepStage,
} from "../src/auto/diagnostics.ts";
import type { NativeAsyncHost } from "../src/auto/async.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";
import type { RasenWorkflow } from "../src/auto/workflow.ts";
import { Orchestrator, digest, type ReviewMaterial } from "../src/core.ts";
import { parseConfig } from "../src/config.ts";

const material: ReviewMaterial = {
  ref: "artifact://1",
  content: "Independent fixture verification evidence",
  sha256: digest("Independent fixture verification evidence"),
  bytes: Buffer.byteLength("Independent fixture verification evidence"),
  source: "authored",
};
const approved = { decision: "approve" as const, summary: "Verified", issues: [] };

// Exercise the controller directly with local artifact storage and inert native
// adapters. No CLI, provider, model, or host loader is needed for failure injection.
async function fixture(verify = true) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-completion-unit-"));
  const artifacts = path.join(cwd, "artifacts");
  await fs.mkdir(artifacts);
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const notifications: string[] = [];
  const pi = {
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
      commands.set(name, command),
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    events: { on() {} },
    sendMessage() {},
    pi: { getAgentDir: () => path.join(cwd, "agent") },
    typebox: {
      Type: { Object() {}, String() {}, Optional() {}, Literal() {} },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    agent: { kind: "main", id: "main" },
    hasUI: true,
    isIdle: () => true,
    abort() {},
    ui: { custom: async () => true, notify: (message: string) => notifications.push(message) },
    sessionManager: {
      getSessionId: () => "fixture-session",
      getArtifactsDir: () => artifacts,
      getArtifactManager: () => ({}),
      getArtifactPath: async () => path.join(artifacts, "1.txt"),
      saveArtifact: async (content: string) => {
        await fs.writeFile(path.join(artifacts, "1.txt"), content);
        return "1";
      },
    },
  } as unknown as ExtensionCommandContext;
  const nativeHost = {
    session: {
      sessionId: "fixture-session",
      getAgentId: () => "main",
      asyncJobManager: { getAllJobs: () => [] },
    },
    registry: { get: () => undefined },
  } as unknown as NativeAsyncHost;
  const snapshot: RasenSnapshot = {
    change: "fixture-change",
    root: cwd,
    schema: "spec-driven",
    state: "all_done",
    progress: { total: 1, complete: 1, remaining: 0 },
    tasks: [{ id: "1.1", description: "Implement the fixture", done: true }],
    instruction: "Apply prepared tasks",
    skill: "Prepared apply guidance",
    contextFiles: [],
    fingerprint: "snapshot-1",
  };
  const workflow: RasenWorkflow = {
    kind: "absent",
    change: snapshot.change,
    reason: "No recorded pipeline",
    fingerprint: "workflow-1",
  };
  const architect = new Orchestrator(parseConfig({}));
  architect.begin("Verify the prepared fixture");
  let failure: { stage: AutoCompletionStage | AutoStepStage; error: unknown } | undefined;
  let reviews = 0;
  const fail = (stage: AutoCompletionStage | AutoStepStage) => {
    if (failure?.stage === stage) throw failure.error;
  };
  const controller = createAutoController(
    pi,
    {
      invalidateStart() {},
      acceptInternal() {},
      instructions: () => "Fixture instructions",
      state: () => architect,
      review: async (_phase, _summary, _ctx, signal, invocationId) => {
        fail("review");
        reviews++;
        return architect.review("completion", material, async () => approved, signal, invocationId);
      },
    },
    {
      snapshot: async () => {
        fail("change snapshot");
        return snapshot;
      },
      workflow: async () => {
        fail("workflow");
        return workflow;
      },
      validate: async () => fail("validation"),
      decision: () => {
        fail("advice");
        return async () => ({ choice: "continue", confidence: 0.99 });
      },
      fallback: () => async () => {
        throw new Error("Unexpected fixture fallback");
      },
      nativeHost: () => nativeHost,
    },
  );
  const close = async () => {
    controller.shutdown();
    await fs.rm(cwd, { recursive: true, force: true });
  };
  try {
    await controller.initialize(ctx);
    await commands.get("auto")!.handler("start fixture-change", ctx);
    expect(notifications).toEqual([]);
    expect(controller.isRunning()).toBe(true);
    const step = async () => {
      const result = await tools
        .get("auto_step")!
        .execute("step", { summary: "Recorded fixture stage" }, undefined, undefined, ctx);
      expect(result.isError).toBe(false);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    if (verify) {
      expect((await step()).allowedNextPhase).toBe("verify");
      expect(controller.toolCall("verify-task", "task", {}, ctx)).toBeUndefined();
      for (const handler of handlers.get("tool_result") ?? [])
        await handler(
          {
            toolName: "task",
            toolCallId: "verify-task",
            details: {
              results: [
                {
                  id: "verify-task",
                  agent: "omp-reviewer",
                  exitCode: 0,
                  output: "Independent fixture inspection passed with no blocking findings",
                },
              ],
            },
          } as never,
          ctx,
        );
      expect((await step()).allowedNextPhase).toBe("review");
    }
    return {
      architect,
      controller,
      step: (signal?: AbortSignal) =>
        tools
          .get("auto_step")!
          .execute("step", { summary: "Observe fixture stage" }, signal, undefined, ctx),
      inject(stage: AutoCompletionStage | AutoStepStage, error: unknown) {
        failure = { stage, error };
      },
      checkpoint: (signal?: AbortSignal) =>
        controller.complete(material, ctx, signal, "completion-fixture"),
      reviews: () => reviews,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const stage of ["change snapshot", "workflow", "validation", "review"] as const) {
  test(`completion ${stage} preserves trusted timeout diagnostics without review charges`, async () => {
    const f = await fixture();
    try {
      const message = "rasen status --change fixture-change --json timed out after 5000 ms";
      f.inject(stage, new AutoPreflightError(message));
      const verdict = await f.checkpoint();
      expect(verdict.decision).toBe("blocked");
      expect(verdict.summary).toContain(`[${stage}]`);
      expect(verdict.summary).toContain(message);
      expect(verdict.summary).toContain("No completion approval is available");
      expect(f.architect.completionApproved).toBe(false);
      expect(f.architect.phaseReviews.completion).toBe(0);
      expect(f.architect.lastReview).toMatchObject({ status: "input_rejected", charged: false });
      expect(f.reviews()).toBe(0);
    } finally {
      await f.close();
    }
  });

  test(`completion ${stage} withholds arbitrary exception contents`, async () => {
    const f = await fixture();
    try {
      f.inject(stage, Object.assign(new Error("PRIVATE PROVIDER TOKEN"), { code: "EACCES" }));
      const verdict = await f.checkpoint();
      expect(verdict.decision).toBe("blocked");
      expect(verdict.summary).toContain(`[${stage}]`);
      expect(verdict.summary).toContain("EACCES");
      expect(verdict.summary).toContain("raw error details withheld");
      expect(JSON.stringify(verdict)).not.toContain("PRIVATE PROVIDER TOKEN");
      expect(JSON.stringify(f.architect.lastReview)).not.toContain("PRIVATE PROVIDER TOKEN");
      expect(f.architect.completionApproved).toBe(false);
      expect(f.architect.phaseReviews.completion).toBe(0);
      expect(f.reviews()).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("successful completion still admits exactly one semantic review", async () => {
  const f = await fixture();
  try {
    expect((await f.checkpoint()).decision).toBe("approve");
    expect(f.architect.completionApproved).toBe(true);
    expect(f.architect.phaseReviews.completion).toBe(1);
    expect(f.architect.lastReview).toMatchObject({ charged: true, attempt: 1 });
    expect(f.reviews()).toBe(1);
  } finally {
    await f.close();
  }
});

test("failed completion revokes earlier approval without resetting or charging its budget", async () => {
  const f = await fixture();
  try {
    await f.architect.review("completion", material, async () => approved);
    expect(f.architect.completionApproved).toBe(true);
    expect(f.architect.phaseReviews.completion).toBe(1);
    f.inject("validation", new AutoPreflightError("Rasen validation did not pass"));
    expect((await f.checkpoint()).decision).toBe("blocked");
    expect(f.architect.completionApproved).toBe(false);
    expect(f.architect.phaseReviews.completion).toBe(1);
    expect(f.architect.lastReview).toMatchObject({ charged: false, attempt: 1 });
    expect(f.reviews()).toBe(0);
  } finally {
    await f.close();
  }
});

test("completion cancellation withholds arbitrary abort reasons and never charges review", async () => {
  const f = await fixture();
  try {
    const abort = new AbortController();
    abort.abort(new Error("PRIVATE CANCELLATION CONTENT"));
    f.inject("workflow", abort.signal.reason);
    const verdict = await f.checkpoint(abort.signal);
    expect(verdict.decision).toBe("blocked");
    expect(verdict.summary).toContain("[workflow]");
    expect(verdict.summary).toContain("cancelled or superseded");
    expect(verdict.summary).not.toContain("PRIVATE CANCELLATION CONTENT");
    expect(f.architect.completionApproved).toBe(false);
    expect(f.architect.phaseReviews.completion).toBe(0);
    expect(f.architect.lastReview).toMatchObject({ status: "caller_cancelled", charged: false });
    expect(f.reviews()).toBe(0);
  } finally {
    await f.close();
  }
});

for (const stage of ["change snapshot", "workflow", "advice"] as const) {
  test(`auto_step ${stage} preserves trusted failures and stops without review`, async () => {
    const f = await fixture(false);
    try {
      const message = "Rasen process timed out after 5000 ms";
      f.inject(stage, new AutoPreflightError(message));
      const result = await f.step();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(`[${stage}]`);
      expect(JSON.stringify(result)).toContain(message);
      expect(f.controller.isRunning()).toBe(false);
      expect(f.architect.completionApproved).toBe(false);
      expect(f.architect.phaseReviews.completion).toBe(0);
      expect(f.reviews()).toBe(0);
    } finally {
      await f.close();
    }
  });

  test(`auto_step ${stage} withholds arbitrary provider and host exceptions`, async () => {
    const f = await fixture(false);
    try {
      f.inject(stage, new Error("PRIVATE AUTO_STEP PROVIDER TOKEN"));
      const result = await f.step();
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain(`[${stage}]`);
      expect(JSON.stringify(result)).toContain("raw error details withheld");
      expect(JSON.stringify(result)).not.toContain("PRIVATE AUTO_STEP PROVIDER TOKEN");
      expect(f.controller.isRunning()).toBe(false);
      expect(f.architect.completionApproved).toBe(false);
      expect(f.architect.phaseReviews.completion).toBe(0);
      expect(f.reviews()).toBe(0);
    } finally {
      await f.close();
    }
  });
}

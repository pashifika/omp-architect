import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentRegistry,
  SessionManager,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { createAutoController } from "../src/auto/extension.ts";
import { AutoPreflightError, type AutoStepStage } from "../src/auto/diagnostics.ts";
import type { NativeAsyncHost } from "../src/auto/async.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";
import type { RasenSkill } from "../src/auto/skills.ts";
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
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-completion-unit-"));
  const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
  const handlers = new Map<string, Array<(event: never, ctx: ExtensionContext) => unknown>>();
  const notifications: string[] = [];
  const statuses: Array<{ status: string; outcome: string | null }> = [];
  const paused = Promise.withResolvers<{ status: string; outcome: string | null }>();
  let aborts = 0;
  const pi = {
    registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
      commands.set(name, command),
    registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
    on: (name: string, handler: (event: never, ctx: ExtensionContext) => unknown) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    events: { on() {} },
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
    sendMessage(message: { customType: string; content: string }) {
      if (message.customType !== "omp-auto") return;
      const status = JSON.parse(message.content);
      statuses.push(status);
      if (status.status === "paused") paused.resolve(status);
    },
    pi: { getAgentDir: () => path.join(cwd, "agent") },
    typebox: {
      Type: {
        Object() {},
        String() {},
        Optional() {},
        Literal() {},
        Union() {},
        Boolean() {},
        Array() {},
        Integer() {},
      },
    },
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    agent: { kind: "main", id: "main" },
    hasUI: true,
    isIdle: () => true,
    abort() {
      aborts++;
    },
    ui: { custom: async () => true, notify: (message: string) => notifications.push(message) },
    sessionManager,
  } as unknown as ExtensionCommandContext;
  const registry = new AgentRegistry();
  const manager = { getAllJobs: () => [], waitForOwnerJobs: async () => {} };
  const session = (id: string) =>
    ({
      sessionId: id === "main" ? sessionManager.getSessionId() : `fixture-session-${id}`,
      getAgentId: () => id,
      asyncJobManager: manager,
      isStreaming: false,
      hasAdmittedSubmission: false,
      hasPendingAsyncWork: () => false,
      waitForAdmittedSubmissions: async () => {},
      waitForIrcReplies: async () => {},
      settleAsyncWork: async () => {},
      waitForIdle: async () => {},
      abort: async () => {
        aborts++;
      },
    }) as unknown as AgentSession;
  const main = session("main");
  registry.register({ id: "main", displayName: "Main", kind: "main", session: main });
  const nativeHost: NativeAsyncHost = { session: main, registry };
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
  const skill: RasenSkill = {
    name: "rasen-verify-change",
    description: "Independently inspect implementation and specification evidence",
    baseDir: cwd,
    filePath: path.join(cwd, "verify.md"),
    source: "fixture",
    reference: "skill://rasen-verify-change",
  };
  const architect = new Orchestrator(parseConfig({}));
  architect.begin("Verify the prepared fixture");
  let failure: { stage: AutoStepStage | "validation"; error: unknown } | undefined;
  let reviews = 0;
  const fail = (stage: AutoStepStage | "validation") => {
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
        reviews++;
        return architect.review("completion", material, async () => approved, signal, invocationId);
      },
    },
    {
      snapshot: async () => {
        fail("change snapshot");
        return snapshot;
      },
      skills: () => [skill],
      skill: async (selected) => ({
        ...selected,
        text: "Complete verification skill",
        sha256: digest("Complete verification skill"),
      }),
      decision: () => {
        fail("advice");
        return async (evidence) => ({
          choice: Object.keys(evidence.choices!).find((key) =>
            evidence.choices![key].includes(`existing native skill ${skill.name}:`),
          )!,
          confidence: 0.99,
        });
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
    return {
      architect,
      controller,
      sessionManager,
      ctx,
      statuses,
      paused: () => paused.promise,
      aborts: () => aborts,
      step: (signal?: AbortSignal) =>
        tools
          .get("auto_step")!
          .execute("step", { summary: "Observe fixture stage" }, signal, undefined, ctx),
      inject(stage: AutoStepStage | "validation", error: unknown) {
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

test("Auto completion checkpoint redirects to the selected skill without an outer semantic review", async () => {
  const f = await fixture();
  try {
    const verdict = await f.checkpoint();
    expect(verdict.decision).toBe("blocked");
    expect(verdict.summary).toContain("auto_step");
    expect(verdict.summary).toContain("no outer Architect completion loop");
    expect(f.architect.completionApproved).toBe(false);
    expect(f.architect.phaseReviews.completion).toBe(0);
    expect(f.reviews()).toBe(0);
    expect(f.controller.isRunning()).toBe(true);
  } finally {
    await f.close();
  }
});

test("first Auto boundary asks Jev before admitting an action in native history", async () => {
  const f = await fixture();
  try {
    const result = await f.step();
    expect(result.isError).toBe(false);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    expect(body).toMatchObject({
      decision: { choice: "skill_0", criterion: expect.stringContaining("rasen-verify-change") },
      action: {
        skill: { name: "rasen-verify-change" },
        admission: { allowedRoles: ["omp-worker", "omp-reviewer", "omp-explorer"] },
      },
    });
    expect(body.instruction).toContain(`Auto action: ${body.action.actionId}`);
    expect(
      f.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "custom")
        .map((entry) => (entry as { data?: { kind: string } }).data?.kind),
    ).toEqual(["run-start", "action-selected", "action-admitted"]);
    expect(f.reviews()).toBe(0);
  } finally {
    await f.close();
  }
});

for (const stage of ["change snapshot", "advice"] as const) {
  test(`auto_step ${stage} preserves trusted failures and stops without review`, async () => {
    const f = await fixture();
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
      expect(f.statuses.at(-1)).toMatchObject({ status: "draining", outcome: "blocked" });
      expect(await f.paused()).toMatchObject({ status: "paused", outcome: "blocked" });
      expect(f.aborts()).toBe(0);
    } finally {
      await f.close();
    }
  });

  test(`auto_step ${stage} withholds arbitrary provider and host exceptions`, async () => {
    const f = await fixture();
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
      expect(f.statuses.at(-1)).toMatchObject({ status: "draining", outcome: "blocked" });
      expect(await f.paused()).toMatchObject({ status: "paused", outcome: "blocked" });
      expect(f.aborts()).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("paused Auto preserves native result and IRC context without physically aborting execution", async () => {
  const f = await fixture();
  try {
    f.inject("advice", new AutoPreflightError("Stage advice unavailable"));
    await f.step();
    await f.paused();
    const messages: Parameters<typeof f.controller.context>[0]["messages"] = [
      {
        role: "custom",
        customType: "async-result",
        content: "Native task result received after the Auto scheduling pause",
        display: true,
        timestamp: Date.now(),
      },
      {
        role: "custom",
        customType: "irc:incoming",
        content: "Native incoming peer response",
        display: true,
        details: { from: "verify-child", id: "late-native-incoming", message: "Review result" },
        timestamp: Date.now(),
      },
      {
        role: "custom",
        customType: "irc:relay",
        content: "Native relayed result",
        display: true,
        timestamp: Date.now(),
      },
    ];
    expect(f.controller.context({ type: "context", messages }, f.ctx)).toEqual(messages);
    expect(f.aborts()).toBe(0);
  } finally {
    await f.close();
  }
});

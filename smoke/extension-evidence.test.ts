import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  AgentRegistry,
  SessionManager,
  type AgentSession,
  type ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { RasenSnapshot } from "../src/auto/rasen.ts";
import { digest, type ReviewRequest } from "../src/core.ts";
import type { RasenSkill } from "../src/auto/skills.ts";
import { extensionFactory } from "../src/extension.ts";
import { withAgentDir } from "./isolated-host.ts";

// Exercise the native extension loader and its admission/result hooks. CLI and
// model replies are deterministic; this fixture does not claim child execution.
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-recovery-evidence-"));
  const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const snapshot: RasenSnapshot = {
    change: "fixture-change",
    root: cwd,
    schema: "spec-driven",
    state: "ready",
    progress: { total: 1, complete: 0, remaining: 1 },
    tasks: [{ id: "1.1", description: "Implement the prepared change", done: false }],
    instruction: "Implement remaining work",
    skill: "Prepared change guidance",
    contextFiles: [],
    fingerprint: "pending-change",
  };
  const skill: RasenSkill = {
    name: "rasen-apply-change",
    description: "Implement the existing change tasks",
    baseDir: cwd,
    filePath: path.join(cwd, "SKILL.md"),
    source: "fixture",
    reference: "skill://rasen-apply-change",
  };
  const registry = new AgentRegistry();
  const session = {
    asyncJobManager: new AsyncJobManager({}),
    getAgentId: () => "main",
    sessionId: sessionManager.getSessionId(),
    hasPendingAsyncWork: () => false,
    waitForAdmittedSubmissions: async () => {},
    waitForIrcReplies: async () => {},
    settleAsyncWork: async () => {},
    waitForIdle: async () => {},
  } as unknown as AgentSession;
  registry.register({ id: "main", displayName: "Main", kind: "main", session });
  const runtime = new ExtensionRuntime();
  runtime.appendEntry = ((type: string, data: unknown) =>
    sessionManager.appendCustomEntry(type, data)) as unknown as typeof runtime.appendEntry;
  let bootstrap = "";
  runtime.sendMessage = (...args: unknown[]) => {
    const message = args[0] as { customType: string; content: unknown };
    if (message.customType === "omp-auto-run") bootstrap = String(message.content);
  };
  const requests: ReviewRequest[] = [];
  const extension = await loadExtensionFromFactory(
    withAgentDir(
      extensionFactory(
        () => async (request) => {
          requests.push(request);
          return { decision: "approve", summary: "Recovery facts reviewed", issues: [] };
        },
        {
          snapshot: async () => snapshot,
          skills: () => [skill],
          skill: async (selected) => ({
            ...selected,
            text: "Complete apply guidance",
            sha256: digest("Complete apply guidance"),
          }),
          decision: () => async (facts) => ({
            choice: Object.entries(facts.choices!).find(([, value]) =>
              value.startsWith(`Execute existing native skill ${skill.name}:`),
            )![0],
            confidence: 0.99,
          }),
          nativeHost: () => ({ session, registry }),
        },
      ),
      path.join(cwd, "agent"),
    ),
    cwd,
    new EventBus(),
    runtime,
  );
  const ctx = {
    cwd,
    sessionManager,
    agent: { kind: "main", id: "main", name: "main", depth: 0 },
    models: { resolve: () => undefined },
    hasUI: true,
    isIdle: () => true,
    ui: { notify() {}, custom: async <T>() => true as T },
    abort() {},
  } as unknown as ExtensionCommandContext;
  await extension.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
  const status = async () => {
    const result = await extension.tools
      .get("auto_status")!
      .definition.execute("inspect-status", {}, undefined, undefined, ctx);
    const content = result.content[0];
    if (content.type !== "text") throw new Error("Missing native status");
    return { result, value: JSON.parse(content.text) };
  };
  return {
    extension,
    ctx,
    requests,
    status,
    async start() {
      await extension.commands.get("auto")!.handler("start fixture-change", ctx);
      expect(bootstrap).not.toBe("");
      await extension.handlers.get("before_agent_start")![0](
        { type: "before_agent_start", prompt: bootstrap, systemPrompt: [] },
        ctx,
      );
      const result = await extension.tools
        .get("auto_step")!
        .definition.execute(
          "initial-step",
          { summary: "Admit the Jev-selected apply action" },
          undefined,
          undefined,
          ctx,
        );
      expect(result.isError).not.toBe(true);
      expect((await status()).value).toMatchObject({
        status: "running",
        selectedAction: { skill: { name: "rasen-apply-change" } },
      });
    },
    async result(toolCallId: string, toolName: string, input: object, result: object) {
      for (const handler of extension.handlers.get("tool_result") ?? [])
        await handler(
          { type: "tool_result", toolCallId, toolName, input, isError: false, ...result },
          ctx,
        );
    },
    async recovery() {
      const id = await sessionManager.saveArtifact("Diagnose the host admission refusal", "review");
      expect(id).toBeTruthy();
      return extension.tools
        .get("architect_checkpoint")!
        .definition.execute(
          "recovery",
          { phase: "recovery", evidenceRef: `artifact://${id}` },
          undefined,
          undefined,
          ctx,
        );
    },
    async close() {
      await extension.handlers.get("session_shutdown")![0]({ type: "session_shutdown" }, ctx);
      session.asyncJobManager!.dispose();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

test("Auto recovery sees native spawn refusals and both status transports without duplicate failures", async () => {
  const f = await fixture();
  try {
    await f.start();
    let reason = "";
    for (const spawnKey of ["HostVerify", "FrontendVerify"]) {
      const denied = await f.extension.handlers.get("before_subagent_spawn")![0](
        {
          type: "before_subagent_spawn",
          agent: "omp-reviewer",
          invocationKind: "eval",
          patterns: [],
          spawnKey,
        },
        f.ctx,
      );
      expect(denied).toMatchObject({
        block: true,
        reason: expect.stringContaining("No matching admitted native Auto task"),
      });
      reason = (denied as { reason: string }).reason;
    }
    expect((await f.status()).value.architect.pendingRecovery).toBe(false);
    const failure = {
      content: [{ type: "text", text: reason }],
      isError: false,
      details: {
        results: [{ id: "HostVerify", agent: "omp-reviewer", exitCode: 1, error: reason }],
      },
    };
    await f.result("task-error-1", "task", { agent: "omp-reviewer" }, failure);
    await f.result("task-error-1", "task", { agent: "omp-reviewer" }, failure);
    expect((await f.status()).value.architect.pendingRecovery).toBe(false);
    for (const [id, toolName, input] of [
      ["native-status", "auto_status", {}],
      ["xd-status", "write", { path: "xd://auto_status", content: "{}" }],
    ] as const) {
      const { result } = await f.status();
      await f.result(id, toolName, input, result);
      // Native XD dispatch can expose inner and outer results with one call ID.
      await f.result(id, "auto_status", {}, result);
    }
    expect((await f.status()).value.architect.pendingRecovery).toBe(false);
    await f.result("task-error-2", "task", { agent: "omp-reviewer" }, failure);
    expect((await f.status()).value).toMatchObject({
      selectedAction: { skill: { name: "rasen-apply-change" } },
      completionVerified: false,
      architect: { pendingRecovery: true, completionApproved: false },
    });
    expect((await f.recovery()).isError).not.toBe(true);
    expect(f.requests).toHaveLength(1);
    const snapshot = JSON.parse(f.requests[0].evidence);
    expect(snapshot.pendingRecovery).toBe(true);
    const records = snapshot.recentToolEvidence.map((entry: string) => JSON.parse(entry));
    expect(records).toHaveLength(6);
    const denials = records.filter((record: { kind: string }) => record.kind === "gate_denial");
    expect(denials).toHaveLength(2);
    expect(denials.map((record: { input: { spawnKey: string } }) => record.input.spawnKey)).toEqual(
      ["HostVerify", "FrontendVerify"],
    );
    for (const record of denials)
      expect(record).toMatchObject({
        tool: "before_subagent_spawn",
        executed: false,
        isError: true,
        output: reason,
        input: { agent: "omp-reviewer", invocationKind: "eval" },
      });
    const diagnostics = records.filter((record: { kind: string }) => record.kind === "diagnostic");
    expect(diagnostics).toHaveLength(2);
    for (const record of diagnostics) {
      expect(record).toMatchObject({ tool: "auto_status", isError: false });
      expect(JSON.parse(record.output)).toMatchObject({
        selectedAction: { skill: { name: "rasen-apply-change" } },
        completionVerified: false,
      });
    }
    expect(records.filter((record: { tool: string }) => record.tool === "task")).toHaveLength(2);
    expect((await f.status()).value).toMatchObject({
      completionVerified: false,
      architect: { pendingRecovery: false, completionApproved: false },
    });
  } finally {
    await f.close();
  }
});

test("missing-model admission refusal is recovery evidence even without a task result or spawn key", async () => {
  const f = await fixture();
  try {
    const reason = "Configure authenticated modelRoles.implementation before spawning omp-worker";
    expect(
      await f.extension.handlers.get("before_subagent_spawn")![0](
        {
          type: "before_subagent_spawn",
          agent: "omp-worker",
          invocationKind: "task",
          patterns: [],
        },
        f.ctx,
      ),
    ).toEqual({ block: true, reason });
    expect((await f.recovery()).isError).not.toBe(true);
    const snapshot = JSON.parse(f.requests[0].evidence);
    expect(snapshot.pendingRecovery).toBe(false);
    expect(snapshot.recentToolEvidence).toHaveLength(1);
    expect(JSON.parse(snapshot.recentToolEvidence[0])).toMatchObject({
      tool: "before_subagent_spawn",
      kind: "gate_denial",
      executed: false,
      isError: true,
      input: { agent: "omp-worker", invocationKind: "task" },
      output: reason,
    });
  } finally {
    await f.close();
  }
});

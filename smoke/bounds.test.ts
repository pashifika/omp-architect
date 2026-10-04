import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  ExtensionRuntime,
  loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { extensionFactory } from "../src/extension.ts";

test("explicit and automatic checkpoints at max publish blocked status and abort without another round", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-bound-"));
  await Bun.write(
    path.join(cwd, ".omp", "architect.json"),
    JSON.stringify({ reviews: { min: 1, max: 1 } }),
  );
  const runtime = new ExtensionRuntime();
  let notices = 0;
  let aborts = 0;
  let reviews = 0;
  runtime.sendMessage = () => {
    notices++;
  };
  const extension = await loadExtensionFromFactory(
    extensionFactory(() => async () => {
      reviews++;
      return { decision: "revise", summary: "Tests still fail", issues: ["Fix failing test"] };
    }),
    cwd,
    new EventBus(),
    runtime,
  );
  const ctx = {
    cwd,
    agent: { kind: "main", id: "main", name: "main", depth: 0 },
    ui: { notify() {} },
    abort() {
      aborts++;
    },
  } as unknown as ExtensionContext;
  try {
    await extension.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
    const tool = extension.tools.get("architect_checkpoint")!.definition;
    const result = await tool.execute(
      "a",
      { phase: "completion", summary: "Done" },
      undefined,
      undefined,
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(reviews).toBe(1);
    expect(aborts).toBe(1);
    expect(notices).toBe(1);
    await tool.execute("b", { phase: "completion", summary: "Retry" }, undefined, undefined, ctx);
    expect(reviews).toBe(1);
    expect(notices).toBe(1);
    const childCtx = {
      ...ctx,
      agent: { kind: "sub", id: "child", name: "omp-worker", depth: 1 },
    } as ExtensionContext;
    const childResult = await tool.execute(
      "c",
      { phase: "completion", summary: "Worker" },
      undefined,
      undefined,
      childCtx,
    );
    expect(childResult.isError).toBe(true);
    expect(reviews).toBe(1);
    await extension.handlers.get("before_agent_start")![0](
      { type: "before_agent_start", prompt: "New request", systemPrompt: [] },
      ctx,
    );
    const stopResult = await extension.handlers.get("session_stop")![0](
      {
        type: "session_stop",
        signal: new AbortController().signal,
        last_assistant_message: {
          role: "assistant",
          content: [{ type: "text", text: "All done" }],
        },
      },
      ctx,
    );
    expect(stopResult).toBeUndefined();
    expect(reviews).toBe(2);
    expect(aborts).toBe(2);
    expect(notices).toBe(2);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("ordinary Architect preserves minimum rounds across host before_agent_start continuation delivery", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-continuation-"));
  await Bun.write(
    path.join(cwd, ".omp", "architect.json"),
    JSON.stringify({ reviews: { min: 2, max: 2 } }),
  );
  const runtime = new ExtensionRuntime();
  let reviews = 0;
  runtime.sendMessage = () => {};
  const extension = await loadExtensionFromFactory(
    extensionFactory(() => async () => {
      reviews++;
      return { decision: "approve", summary: "Evidence reviewed", issues: [] };
    }),
    cwd,
    new EventBus(),
    runtime,
  );
  const ctx = {
    cwd,
    agent: { kind: "main", id: "main", name: "main", depth: 0 },
    ui: { notify() {} },
    abort() {},
  } as unknown as ExtensionContext;
  const before = extension.handlers.get("before_agent_start")![0];
  const stop = extension.handlers.get("session_stop")![0];
  const event = {
    type: "session_stop",
    signal: new AbortController().signal,
    last_assistant_message: {
      role: "assistant",
      content: [{ type: "text", text: "Actual fixture evidence" }],
    },
  };
  try {
    await extension.handlers.get("session_start")![0]({ type: "session_start" }, ctx);
    await before(
      { type: "before_agent_start", prompt: "Real user request", systemPrompt: [] },
      ctx,
    );
    const first = (await stop(event, ctx)) as { continue?: boolean; additionalContext: string };
    expect(first.continue).toBe(true);
    expect(reviews).toBe(1);
    await before(
      { type: "before_agent_start", prompt: first.additionalContext, systemPrompt: [] },
      ctx,
    );
    expect(await stop(event, ctx)).toBeUndefined();
    expect(reviews).toBe(2);
    // A genuine interactive user input cannot impersonate the stored continuation.
    await extension.handlers.get("input")![0](
      { type: "input", text: first.additionalContext, source: "interactive" },
      ctx,
    );
    await before(
      { type: "before_agent_start", prompt: first.additionalContext, systemPrompt: [] },
      ctx,
    );
    expect(((await stop(event, ctx)) as { continue?: boolean }).continue).toBe(true);
    expect(reviews).toBe(3);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

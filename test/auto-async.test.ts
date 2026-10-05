import { expect, test } from "bun:test";
import {
  AgentRegistry,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { NativeQuiescence, nativeAsyncHost } from "../src/auto/async.ts";

function fixture() {
  const registry = new AgentRegistry();
  const manager = new AsyncJobManager({});
  const makeSession = (id: string) =>
    ({
      asyncJobManager: manager,
      getAgentId: () => id,
      sessionId: `session-${id}`,
      isStreaming: false,
      hasAdmittedSubmission: false,
      hasPendingAsyncWork: () => false,
      waitForAdmittedSubmissions: async () => {},
      waitForIrcReplies: async () => {},
      settleAsyncWork: async () => {},
      waitForIdle: async () => {},
    }) as unknown as AgentSession;
  const session = makeSession("Main");
  registry.register({ id: "Main", displayName: "Main", kind: "main", session });
  const host = { session, registry };
  const scope = new NativeQuiescence(host);
  const child = (id: string, parentId = "Main") => {
    const session = makeSession(id);
    const ref = registry.register({ id, parentId, displayName: id, kind: "sub", session });
    registry.setStatus(id, "idle");
    return { session, ref };
  };
  const job = (ownerId: string, foreground = false) => {
    const done = Promise.withResolvers<string>();
    let aborted = false;
    const id = manager.register(
      "bash",
      "fixture",
      ({ signal }) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return done.promise;
      },
      { ownerId, foreground },
    );
    return { id, done, aborted: () => aborted, row: manager.getJob(id)! };
  };
  return { host, registry, manager, session, scope, child, job };
}

const signal = () => new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("native host resolves only the exact session and scoped manager", () => {
  const f = fixture();
  const pi = { pi: { AgentRegistry: { global: () => f.registry } } } as unknown as ExtensionAPI;
  const ctx = {
    agent: { id: "Main" },
    sessionManager: { getSessionId: () => "session-Main" },
  } as unknown as ExtensionContext;
  expect(nativeAsyncHost(pi, ctx)).toEqual(f.host);
  expect(
    nativeAsyncHost(pi, {
      ...ctx,
      sessionManager: { getSessionId: () => "other" },
    } as ExtensionContext),
  ).toBeUndefined();
  f.manager.dispose();
});

test("in-callback pending excludes only the current carrier without waiting on Main idle", () => {
  const f = fixture();
  f.session.waitForIdle = () => {
    throw new Error("must not call inline");
  };
  f.scope.callStarted("checkpoint", "eval");
  expect(f.scope.pending()).toBe(true);
  expect(f.scope.pending(new Set(["checkpoint"]))).toBe(false);
  f.scope.callStarted("parallel", "write");
  expect(f.scope.pending(new Set(["checkpoint"]))).toBe(true);
  f.scope.callEnded("parallel");
  f.scope.callEnded("checkpoint");
  f.manager.dispose();
});

test("shared-owner and descendant work is awaited without cancellation or suppression", async () => {
  const f = fixture();
  f.child("leaf");
  f.child("nested", "leaf");
  const jobs = [f.job("Main"), f.job("leaf"), f.job("nested")];
  let finished = false;
  const drain = f.scope.waitForDrain(signal()).then((value) => {
    finished = true;
    return value;
  });
  await tick();
  expect(finished).toBe(false);
  expect(f.scope.pending()).toBe(true);
  expect(jobs.every((job) => !job.aborted())).toBe(true);
  expect(jobs.every((job) => !f.manager.isDeliverySuppressed(job.id))).toBe(true);
  for (const job of jobs) job.done.resolve("done");
  expect(await drain).toBe(true);
  f.manager.dispose();
});

test("detached drain includes hidden foreground bodies omitted by callback query", async () => {
  const f = fixture();
  const job = f.job("Main", true);
  expect(f.manager.getAllJobs()).toHaveLength(0);
  expect(f.scope.pending()).toBe(false);
  let finished = false;
  const drain = f.scope.waitForDrain(signal()).then((value) => {
    finished = true;
    return value;
  });
  await tick();
  expect(finished).toBe(false);
  job.done.resolve("done");
  expect(await drain).toBe(true);
  expect(job.aborted()).toBe(false);
  f.manager.dispose();
});

test("native relay fence precedes late yield-time job registration", async () => {
  const f = fixture();
  const leaf = f.child("leaf");
  const relay = Promise.withResolvers<void>();
  leaf.session.waitForIrcReplies = () => relay.promise;
  let finished = false;
  const drain = f.scope.waitForDrain(signal()).then((value) => {
    finished = true;
    return value;
  });
  await tick();
  expect(finished).toBe(false);
  const job = f.job("Main");
  relay.resolve();
  await tick();
  expect(finished).toBe(false);
  job.done.resolve("rereview");
  expect(await drain).toBe(true);
  f.manager.dispose();
});

test("drain rescans descendants admitted while native work settles", async () => {
  const f = fixture();
  let added = false;
  let late: ReturnType<typeof f.job>;
  f.session.settleAsyncWork = async () => {
    if (added) return;
    added = true;
    f.child("late");
    late = f.job("late");
  };
  let finished = false;
  const drain = f.scope.waitForDrain(signal()).then((value) => {
    finished = true;
    return value;
  });
  await tick();
  expect(finished).toBe(false);
  late!.done.resolve("done");
  expect(await drain).toBe(true);
  f.manager.dispose();
});

test("interrupted dispatch remains unverified even if visible work is idle", async () => {
  const f = fixture();
  f.scope.callStarted("late-revival", "write");
  f.scope.callEnded("late-revival", true);
  expect(f.scope.uncertainty).toEqual(["late-revival"]);
  expect(f.scope.pending()).toBe(true);
  expect(await f.scope.waitForDrain(signal())).toBe(false);
  f.manager.dispose();
});

test("aborting observation never cancels native work", async () => {
  const f = fixture();
  const job = f.job("Main");
  const abort = new AbortController();
  const drain = f.scope.waitForDrain(abort.signal);
  await tick();
  abort.abort();
  expect(await drain).toBe(false);
  expect(job.aborted()).toBe(false);
  job.done.resolve("done");
  await job.row.promise;
  f.manager.dispose();
});

test("session replacement invalidates settlement rather than joining another Main", async () => {
  const f = fixture();
  f.registry.unregister("Main");
  expect(f.scope.pending()).toBe(true);
  expect(await f.scope.waitForDrain(signal())).toBe(false);
  f.manager.dispose();
});

test("delivery follow-up hidden work under an existing owner is fenced again", async () => {
  const f = fixture();
  let late: ReturnType<typeof f.job> | undefined;
  f.session.settleAsyncWork = async () => {
    late ??= f.job("Main", true);
  };
  let finished = false;
  const drain = f.scope.waitForDrain(signal()).then((value) => {
    finished = true;
    return value;
  });
  await tick();
  expect(finished).toBe(false);
  expect(late).toBeDefined();
  late!.done.resolve("done");
  expect(await drain).toBe(true);
  f.manager.dispose();
});

test("already aborted observation returns false without starting native waits", async () => {
  const f = fixture();
  f.session.waitForIdle = () => {
    throw new Error("must not start");
  };
  const abort = new AbortController();
  abort.abort();
  expect(await f.scope.waitForDrain(abort.signal)).toBe(false);
  f.manager.dispose();
});

test("later tool_result interruption metadata survives an earlier execution-end event", async () => {
  const f = fixture();
  f.scope.callStarted("send", "write");
  f.scope.callEnded("send");
  f.scope.callEnded("send", true);
  expect(f.scope.uncertainty).toEqual(["send"]);
  expect(await f.scope.waitForDrain(signal())).toBe(false);
  f.manager.dispose();
});

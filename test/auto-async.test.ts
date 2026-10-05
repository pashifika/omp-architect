import { expect, test } from "bun:test";
import {
  AgentRegistry,
  type AgentSession,
  type ExtensionAPI,
  type ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AutoAsyncScope, nativeAsyncHost } from "../src/auto/async.ts";

function fixture() {
  const registry = new AgentRegistry();
  const manager = new AsyncJobManager({});
  const session = {
    asyncJobManager: manager,
    getAgentId: () => "Main",
    sessionId: "session-a",
  } as AgentSession;
  const host = { registry, session };
  registry.register({ id: "Main", displayName: "Main", kind: "main", session });
  const job = (ownerId: string, id: string, agentId?: string) => {
    const ended = Promise.withResolvers<string>();
    let aborted = false;
    const actual = manager.register(
      agentId ? "task" : "bash",
      "fixture",
      ({ signal }) => {
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
        return ended.promise;
      },
      { id, ownerId, agentId },
    );
    return { id: actual, ended, aborted: () => aborted, row: manager.getJob(actual)! };
  };
  const child = (id: string, parentId = "Main") =>
    registry.register({
      id,
      parentId,
      displayName: id,
      kind: "sub",
      session: null,
    });
  return { registry, manager, session, host, job, child };
}

test("native host resolution requires the exact Main session and scoped manager", () => {
  const f = fixture();
  const pi = { pi: { AgentRegistry: { global: () => f.registry } } } as unknown as ExtensionAPI;
  const ctx = {
    agent: { id: "Main" },
    sessionManager: { getSessionId: () => "session-a" },
  } as unknown as ExtensionContext;
  expect(nativeAsyncHost(pi, ctx)?.session).toBe(f.session);
  expect(
    nativeAsyncHost(pi, {
      ...ctx,
      sessionManager: { getSessionId: () => "session-b" },
    } as unknown as ExtensionContext),
  ).toBeUndefined();
  f.manager.dispose();
});

test("exact batch child mapping cancels all owned jobs, leaving same-Main work untouched", async () => {
  const f = fixture();
  const foreign = f.job("Main", "child-a");
  const scope = new AutoAsyncScope(f.host);
  scope.call("task-batch", "task");
  f.child("child-a");
  f.child("child-b");
  const a = f.job("Main", "child-a", "child-a");
  const b = f.job("Main", "child-b", "child-b");
  const nested = f.job("child-a", "nested-bash");
  scope.result("task-batch", {
    progress: [{ id: "child-a" }, { id: "child-b" }],
    async: { jobId: a.id },
  });
  expect(a.id).not.toBe(foreign.id);
  expect(scope.jobs.size).toBe(3);
  scope.stop();
  expect([a.aborted(), b.aborted(), nested.aborted()]).toEqual([true, true, true]);
  expect(foreign.aborted()).toBe(false);
  // Cancellation status is already terminal, but real job bodies are not joined.
  expect(scope.pending()).toBe(true);
  for (const job of [a, b, nested]) job.ended.resolve("done");
  await scope.join();
  expect(scope.pending()).toBe(false);
  expect(foreign.row.status).toBe("running");
  foreign.ended.resolve("unrelated done");
  await foreign.row.promise;
  f.manager.dispose();
});

test("retired call receipts cancel late Bash/Eval jobs without snapshot-delta ownership", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("old-bash", "bash", true);
  scope.stop();
  const unrelated = f.job("Main", "unrelated-after-stop");
  const late = f.job("Main", "late-owned");
  scope.result("old-bash", { async: { jobId: late.id } });
  expect(late.aborted()).toBe(true);
  expect(unrelated.aborted()).toBe(false);
  expect(f.manager.isDeliverySuppressed(late.id)).toBe(true);
  late.ended.resolve("late result");
  await scope.join();
  expect(scope.pending()).toBe(false);
  unrelated.ended.resolve("unrelated");
  await unrelated.row.promise;
  f.manager.dispose();
});

test("late speculative child is associated only with its observed Main task call", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  const own = f.child("owned");
  const other = f.child("other", "SomeOtherMain");
  scope.lifecycle("owned", "streaming-task", "started");
  scope.lifecycle("other", "streaming-task", "started");
  scope.stop();
  scope.call("streaming-task", "task");
  expect(own.status).toBe("aborted");
  expect(other.status).toBe("running");
  expect(scope.ownsChild("other")).toBe(false);
  const late = f.job("Main", "owned-job", "owned");
  scope.result("streaming-task", { async: { jobId: late.id } });
  expect(late.aborted()).toBe(true);
  late.ended.resolve("done");
  await scope.join();
  f.manager.dispose();
});

test("completion excludes only its exact dedicated carrier, and unrelated jobs do not block", async () => {
  const f = fixture();
  const unrelated = f.job("Main", "unrelated");
  const scope = new AutoAsyncScope(f.host);
  expect(scope.pending()).toBe(false);
  scope.call("checkpoint-carrier", "eval", true);
  const carrier = f.job("Main", "carrier");
  scope.result("checkpoint-carrier", { async: { jobId: carrier.id } });
  expect(scope.pending()).toBe(true);
  expect(scope.pending(new Set(["checkpoint-carrier"]))).toBe(false);
  scope.call("other-eval", "eval", true);
  expect(scope.pending(new Set(["checkpoint-carrier"]))).toBe(true);
  scope.result("other-eval", {});
  carrier.ended.resolve("approved");
  unrelated.ended.resolve("done");
  await Promise.all([scope.join(), unrelated.row.promise]);
  expect(scope.pending()).toBe(false);
  f.manager.dispose();
});

test("retired scope cannot cancel a replacement same-id job or child registry generation", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("task", "task");
  const oldRef = f.child("leaf");
  scope.lifecycle("leaf", "task", "started");
  const newRef = f.child("leaf");
  scope.stop();
  expect(oldRef).not.toBe(newRef);
  expect(newRef.status).toBe("running");
  f.manager.dispose();
});

test("terminal child reuse cannot give a stopped scope ownership of another turn", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("old-task", "task");
  const ref = f.child("reusable-leaf");
  scope.lifecycle(ref.id, "old-task", "started");
  scope.lifecycle(ref.id, "old-task", "completed");
  f.registry.setStatus(ref.id, "idle", ref);
  await scope.join();
  scope.stop();
  scope.seal();
  f.registry.setStatus(ref.id, "running", ref);
  const future = f.job(ref.id, "future-bash");
  scope.lifecycle(ref.id, "old-task", "started");
  scope.reconcile();
  expect(future.row.status).toBe("running");
  expect(future.aborted()).toBe(false);
  expect(scope.pending()).toBe(false);
  future.ended.resolve("unrelated done");
  await future.row.promise;
  f.manager.dispose();
});

test("queued batch receipts own every child before registry admission", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("batch", "task");
  const first = f.job("Main", "queued-a", "child-a");
  const second = f.job("Main", "queued-b", "child-b");
  scope.result("batch", {
    progress: [{ id: "child-a" }, { id: "child-b" }],
    async: { jobId: first.id },
  });
  scope.stop();
  expect(first.aborted()).toBe(true);
  expect(second.aborted()).toBe(true);
  first.ended.resolve("done");
  await first.row.promise;
  expect(scope.pending()).toBe(true);
  second.ended.resolve("done");
  await scope.join();
  expect(scope.pending()).toBe(false);
  f.manager.dispose();
});

test("cancelled in-flight native calls without receipts expose unverified settlement", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("hidden", "bash", true);
  scope.stop();
  scope.result("hidden", {}, true, true);
  expect([...scope.settlementUnverified]).toEqual(["hidden"]);
  expect(scope.pending()).toBe(false); // Unknown termination is not proof of running work.
  const late = f.job("Main", "late-receipt");
  scope.result("hidden", { async: { jobId: late.id } }, true, true);
  expect(scope.settlementUnverified.size).toBe(0);
  expect(late.aborted()).toBe(true);
  late.ended.resolve("done");
  await scope.join();
  f.manager.dispose();
});

test("ordinary errors and successful completion do not invent a cancellation fence", () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("failed", "bash", true);
  scope.result("failed", {}, true, true);
  scope.stop();
  expect(scope.settlementUnverified.size).toBe(0);
  const completed = new AutoAsyncScope(f.host);
  completed.call("done", "eval", true);
  completed.stop();
  completed.result("done", {}, true, false);
  expect(completed.settlementUnverified.size).toBe(0);
  f.manager.dispose();
});

test("terminal child owner join includes hidden foreground-backed work", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("task", "task");
  f.child("leaf");
  scope.lifecycle("leaf", "task", "started");
  const ended = Promise.withResolvers<string>();
  const hidden = f.manager.register("bash", "hidden", () => ended.promise, {
    ownerId: "leaf",
    foreground: true,
  });
  expect(f.manager.getAllJobs()).toEqual([]);
  scope.lifecycle("leaf", "task", "completed");
  expect(scope.pending()).toBe(true);
  ended.resolve("done");
  await scope.join();
  expect(scope.pending()).toBe(false);
  expect(f.manager.getJob(hidden)?.status).toBe("completed");
  f.manager.dispose();
});

test("structured interruption fences missing receipts but subsequent assistant work clears candidates", () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("failed", "bash", true);
  scope.result("failed", {}, true, true);
  scope.nextAssistant();
  scope.interrupted();
  expect(scope.settlementUnverified.size).toBe(0);
  scope.call("cancelled", "eval", true);
  scope.result("cancelled", {}, true, true);
  scope.interrupted();
  expect([...scope.settlementUnverified]).toEqual(["cancelled"]);
  f.manager.dispose();
});

test("job ID reuse and eviction cannot retroactively stale a newer delivery", async () => {
  const f = fixture();
  const scope = new AutoAsyncScope(f.host);
  scope.call("old", "bash");
  const old = f.job("Main", "reused");
  scope.result("old", { async: { jobId: old.id } });
  old.ended.resolve("done");
  await scope.join();
  const oldTimestamp = Date.now();
  scope.stop();
  expect(scope.staleDelivery(old.id, oldTimestamp)).toBe(true);
  f.manager.evictCompletedJobs();
  await Bun.sleep(2);
  const next = f.job("Main", "reused");
  const newTimestamp = Date.now();
  expect(scope.staleDelivery(next.id, newTimestamp)).toBe(false);
  expect(scope.staleDelivery(old.id, oldTimestamp)).toBe(true);
  next.ended.resolve("unrelated");
  await next.row.promise;
  f.manager.evictCompletedJobs();
  expect(scope.staleDelivery(next.id, newTimestamp)).toBe(false);
  f.manager.dispose();
});

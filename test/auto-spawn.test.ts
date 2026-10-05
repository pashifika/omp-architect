import { expect, test } from "bun:test";
import { NativeSpawnAdmissions } from "../src/auto/spawn.ts";
import type { BeforeSubagentSpawnEvent } from "@oh-my-pi/pi-coding-agent";
const event = (agent: string, model: string, spawnKey: string): BeforeSubagentSpawnEvent => ({
  type: "before_subagent_spawn",
  agent,
  patterns: [model],
  invocationKind: "task",
  spawnKey,
});

test("deferred parallel spawns retain the model and role captured for their own native task", () => {
  const admissions = new NativeSpawnAdmissions();
  admissions.admit("call-a", "action-call-a", [
    { agent: "omp-worker", model: "provider/first:high", constrained: true, name: "a" },
  ]);
  admissions.admit("call-b", "action-call-b", [
    { agent: "omp-reviewer", model: "provider/second:low", constrained: true, name: "b" },
  ]);
  expect(admissions.resolve(event("omp-reviewer", "provider/second:low", "b"))).toEqual({
    model: "provider/second:low",
  });
  expect(admissions.resolve(event("omp-worker", "provider/first:high", "a"))).toEqual({
    model: "provider/first:high",
  });
  expect(admissions.resolve(event("omp-worker", "provider/first:high", "a"))).toEqual({
    model: "provider/first:high",
  });
  expect(admissions.resolve(event("omp-worker", "provider/second:low", "new"))).toBeUndefined();
});
test("queued admissions survive semantic stop while new unadmitted native work has no permit", () => {
  const admissions = new NativeSpawnAdmissions();
  admissions.admit("call-before-stop", "action-call-before-stop", [
    { agent: "omp-worker", model: "@implementation", constrained: false },
  ]);
  // Auto stopping is intentionally not an input: OMP already owns this task.
  expect(admissions.resolve(event("omp-worker", "provider/worker", "late-child"))).toEqual({
    model: "@implementation",
  });
  expect(
    admissions.resolve(event("omp-worker", "provider/worker", "unadmitted-child")),
  ).toBeUndefined();
  admissions.clear();
  expect(admissions.resolve(event("omp-worker", "provider/worker", "late-child"))).toBeUndefined();
});
test("denied task permits are revoked and Eval cannot borrow task admission", () => {
  const admissions = new NativeSpawnAdmissions();
  admissions.admit("denied", "action-denied", [
    { agent: "omp-worker", model: "@implementation", constrained: false },
  ]);
  admissions.reject("denied");
  expect(admissions.resolve(event("omp-worker", "provider/worker", "missing"))).toBeUndefined();
  admissions.admit("task", "action-task", [
    { agent: "omp-worker", model: "@implementation", constrained: false },
  ]);
  expect(
    admissions.resolve({
      ...event("omp-worker", "provider/worker", "eval"),
      invocationKind: "eval",
    }),
  ).toBeUndefined();
  expect(admissions.resolve(event("omp-worker", "provider/worker", "task"))).toEqual({
    model: "@implementation",
  });
});
test("same-role queued tasks with different exact routes never borrow the selected sibling's route", () => {
  const admissions = new NativeSpawnAdmissions();
  admissions.admit("first", "action-first", [
    { agent: "omp-worker", model: "provider/first", constrained: true },
  ]);
  admissions.admit("second", "action-second", [
    { agent: "omp-worker", model: "provider/second", constrained: true },
  ]);
  expect(admissions.resolve(event("omp-worker", "provider/first", "opaque-native-a"))).toEqual({
    model: "provider/first",
  });
  expect(admissions.resolve(event("omp-worker", "provider/second", "opaque-native-b"))).toEqual({
    model: "provider/second",
  });
});

test("accepted action task policy cannot be rebound by later selection or caller mutation", () => {
  const admissions = new NativeSpawnAdmissions();
  const tasks = [
    { agent: "omp-worker", model: "provider/original:high", constrained: true, name: "child" },
  ];
  admissions.admit("call", "original-action", tasks);
  Object.assign(tasks[0], {
    agent: "omp-reviewer",
    model: "provider/replacement:low",
    constrained: false,
    name: "replacement",
  });
  admissions.admit("call", "replacement-action", tasks);
  expect(
    admissions.resolve(event("omp-reviewer", "provider/replacement:low", "replacement")),
  ).toBeUndefined();
  expect(admissions.resolve(event("omp-worker", "provider/original:high", "child"))).toEqual({
    model: "provider/original:high",
  });
});

test("rejecting unstarted tasks retains already claimed native action policy", () => {
  const admissions = new NativeSpawnAdmissions();
  admissions.admit("call", "selected-action", [
    { agent: "omp-worker", model: "provider/worker", constrained: true, name: "accepted" },
    { agent: "omp-reviewer", model: "provider/reviewer", constrained: true, name: "denied" },
  ]);
  const accepted = event("omp-worker", "provider/worker", "accepted");
  expect(admissions.resolve(accepted)).toEqual({ model: "provider/worker" });
  admissions.reject("call");
  expect(admissions.resolve(accepted)).toEqual({ model: "provider/worker" });
  expect(admissions.resolve(event("omp-reviewer", "provider/reviewer", "denied"))).toBeUndefined();
  expect(admissions.resolve({ ...accepted, agent: "omp-reviewer" })).toBeUndefined();
});

test("native task spawns without keys consume each action permit once", () => {
  const admissions = new NativeSpawnAdmissions();
  admissions.admit("call", "selected-action", [
    { agent: "omp-worker", model: "@implementation", constrained: false },
  ]);
  const unkeyed = { ...event("omp-worker", "provider/worker", "unused"), spawnKey: undefined };
  expect(admissions.resolve(unkeyed)).toEqual({ model: "@implementation" });
  expect(admissions.resolve(unkeyed)).toBeUndefined();
});

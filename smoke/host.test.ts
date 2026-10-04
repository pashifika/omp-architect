import { expect, test } from "bun:test";
import * as path from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { resolveSpawnPolicy } from "@oh-my-pi/pi-coding-agent/task/spawn-policy";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";

const root = path.resolve(import.meta.dir, "..");
test("real OMP loader registers checkpoint, routing and stop handlers without inference", async () => {
  const loaded = await loadExtensions([path.join(root, "index.ts")], root);
  expect(loaded.errors).toEqual([]);
  const extension = loaded.extensions[0];
  expect(extension.tools.has("architect_checkpoint")).toBe(true);
  expect(extension.tools.has("auto_status")).toBe(true);
  expect(extension.commands.has("auto")).toBe(true);
  for (const name of [
    "before_agent_start",
    "before_subagent_spawn",
    "tool_call",
    "tool_result",
    "session_stop",
  ])
    expect(extension.handlers.has(name)).toBe(true);
  expect(extension.commands.has("architect")).toBe(true);
});
test("real OMP discovery accepts package agents and restricts explorer without child spawning", async () => {
  const result = await discoverAgents(root, "/tmp/omp-architect-empty-home", {
    explicit: [root],
    mode: "explicit-only",
    configured: [],
    configuredLevel: "project",
  });
  const worker = result.agents.find((agent) => agent.name === "omp-worker");
  const explorer = result.agents.find((agent) => agent.name === "omp-explorer");
  expect(worker?.model).toEqual(["@implementation"]);
  expect(explorer?.model).toEqual(["@research"]);
  expect(explorer?.tools).toEqual(["read", "grep", "find", "ls", "yield"]);
  expect(
    resolveSpawnPolicy(worker?.spawns === "*" ? "*" : (worker?.spawns?.join(",") ?? "")).enabled,
  ).toBe(false);
  expect(
    resolveSpawnPolicy(explorer?.spawns === "*" ? "*" : (explorer?.spawns?.join(",") ?? ""))
      .enabled,
  ).toBe(false);
});

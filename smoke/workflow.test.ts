import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assessWorkflowScope,
  readRasenWorkflow,
  type RasenWorkflow,
} from "../src/auto/workflow.ts";

const change = "workflow-smoke";
let temp: string;
let cwd: string;
let executable = process.env.RASEN_BIN ?? "";
let stateFile: string;
let count = 0;
let observed: Extract<RasenWorkflow, { kind: "present" }>;
let resume: Record<string, unknown>;
let plan: Record<string, unknown>;

function cli(args: string[]): string {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    shell: false,
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      XDG_CONFIG_HOME: path.join(temp, "config"),
      XDG_DATA_HOME: path.join(temp, "data"),
      XDG_STATE_HOME: path.join(temp, "state"),
      RASEN_AGENT_RUNTIME: "omp",
      RASEN_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      CI: "1",
      NO_COLOR: "1",
    },
  });
  if (result.error || result.status !== 0)
    throw new Error(`Real Rasen workflow fixture failed (${args[0]}, exit ${result.status})`);
  return result.stdout;
}

function state(verify: "pending" | "done" = "done") {
  return {
    pipeline: "small-feature",
    hostRuntime: "omp",
    stages: {
      propose: { status: "skipped", note: "Existing prepared artifacts; no propose execution" },
      apply: {
        status: "done",
        worker: { role: "implementer", dispatchMode: "native", hostRuntime: "omp" },
      },
      verify: { status: verify },
      "review-loop": { status: "pending" },
      ship: { status: "pending" },
      archive: { status: "pending" },
    },
    rounds: 0,
    openFindings: [],
  };
}

async function writeState(value: unknown = state()) {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(value));
}

async function script(body: string) {
  const file = path.join(temp, `workflow-cli-${++count}.mjs`);
  await fs.writeFile(file, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return file;
}

async function fake(overrides: { resume?: unknown; plan?: unknown } = {}) {
  return script(`if (process.env.RASEN_AGENT_RUNTIME !== 'omp') process.exit(9);
const args = process.argv.slice(2);
if (args[0] !== 'pipeline') process.exit(10);
if (args[1] === 'resume') console.log(JSON.stringify(${JSON.stringify(overrides.resume ?? resume)}));
else if (args[1] === 'show' && args.includes('--for-execution') && args.includes('--json')) console.log(JSON.stringify(${JSON.stringify(overrides.plan ?? plan)}));
else process.exit(11);`);
}

beforeAll(async () => {
  if (!executable) {
    const stamp = await Bun.file(
      path.resolve(import.meta.dir, "../node_modules/.cache/omp-architect/rasen-build.json"),
    ).json();
    expect(stamp.commit).toBe("f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd");
    executable = stamp.executable;
  }
  await fs.access(executable);
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workflow-smoke-"));
  await fs.mkdir(path.join(temp, "project"));
  cwd = await fs.realpath(path.join(temp, "project"));
  cli(["init", "--tools", "omp"]);
  cli(["new", "change", change, "--schema", "spec-driven", "--json"]);
  const status = JSON.parse(cli(["status", "--change", change, "--json"]));
  stateFile = path.join(status.ephemeraDir, "auto-run.json");
  plan = JSON.parse(cli(["pipeline", "show", "small-feature", "--for-execution", "--json"]));
  expect(plan.hostRuntime).toBe("omp");
  expect(
    (plan.stages as Array<Record<string, unknown>>).every(
      (stage) => stage.dispatchMode === "legacy-fallback",
    ),
  ).toBe(true);
}, 30000);

afterAll(async () => {
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

test("real public pipeline reads distinguish absent, invalid and pipeline-less state", async () => {
  expect((await readRasenWorkflow(cwd, change, { executable })).kind).toBe("absent");
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, "{broken");
  expect((await readRasenWorkflow(cwd, change, { executable })).kind).toBe("invalid");
  await writeState({ retention: "off" });
  const noPipeline = await readRasenWorkflow(cwd, change, { executable });
  expect(noPipeline.kind).toBe("absent");
  expect(assessWorkflowScope(noPipeline).ready).toBe(false);
}, 30000);

test("real OMP workflow frontier and fresh evidence stay distinct from host completion", async () => {
  await writeState(state("pending"));
  const pending = await readRasenWorkflow(cwd, change, { executable });
  expect(pending.kind).toBe("present");
  if (pending.kind !== "present") throw new Error("Missing real workflow");
  expect(pending.next).toBe("verify");
  expect(pending.ready).toEqual(["verify"]);
  expect(assessWorkflowScope(pending).remaining).toEqual(["verify"]);
  const priorFingerprint = pending.fingerprint;
  await writeState();
  const complete = await readRasenWorkflow(cwd, change, { executable });
  expect(complete.kind).toBe("present");
  if (complete.kind !== "present") throw new Error("Missing real workflow");
  observed = complete;
  expect(complete.next).toBe("review-loop");
  expect(complete.ready).toEqual(["review-loop"]);
  expect(complete.remaining).toEqual(["review-loop", "ship", "archive"]);
  expect(complete.stages.find((stage) => stage.id === "review-loop")?.loop).toEqual({
    kind: "review-cycle",
    maxRounds: 3,
  });
  expect(complete.stages.find((stage) => stage.id === "review-loop")?.status).toBe("pending");
  expect(complete.fingerprint).not.toBe(priorFingerprint);
  expect(assessWorkflowScope(complete)).toEqual({
    ready: true,
    reviewLoopReady: true,
    remaining: [],
    unsupported: [],
    reason: null,
  });
  const unchanged = await fs.readFile(stateFile, "utf8");
  expect((await readRasenWorkflow(cwd, change, { executable })).fingerprint).toBe(
    complete.fingerprint,
  );
  expect(await fs.readFile(stateFile, "utf8")).toBe(unchanged);
  resume = JSON.parse(cli(["pipeline", "resume", change, "--json"]));
}, 30000);

test("scope guard rejects missing checks, unclassified blockers and unsupported stages", () => {
  const copy = () => structuredClone(observed);
  for (const findings of [
    [{ severity: "blocker" }],
    [{ severity: "major" }],
    [{ summary: "Unclassified" }],
  ]) {
    expect(assessWorkflowScope({ ...copy(), openFindings: findings }).ready).toBe(false);
  }
  expect(
    assessWorkflowScope({
      ...copy(),
      openFindings: [{ severity: "minor", summary: "accepted-known" }],
    }).ready,
  ).toBe(true);
  expect(assessWorkflowScope({ ...copy(), inProgressStages: ["verify"] }).ready).toBe(false);
  expect(assessWorkflowScope({ ...copy(), escalatedStages: ["verify"] }).ready).toBe(false);
  const skipped = copy();
  skipped.stages.find((stage) => stage.id === "verify")!.status = "skipped";
  skipped.stages.find((stage) => stage.id === "verify")!.note = "No need to check";
  expect(assessWorkflowScope(skipped).ready).toBe(false);
  const unsafe = copy();
  unsafe.stages.push({
    id: "extra",
    kind: "standard",
    skill: "custom-unsafe",
    requires: [],
    status: "pending",
  });
  expect(assessWorkflowScope(unsafe).unsupported).toEqual(["extra"]);
  unsafe.stages.pop();
  unsafe.stages[0].kind = "decompose";
  expect(assessWorkflowScope(unsafe).unsupported).toEqual(["propose"]);
  const noVerify = copy();
  noVerify.stages = noVerify.stages.filter((stage) => stage.id !== "verify");
  expect(assessWorkflowScope(noVerify).ready).toBe(false);
});

test("explicit foreign runtime routes fail closed instead of silently mapping to OMP", async () => {
  expect(
    observed.stages.every(
      (stage) =>
        stage.runtime === "claude" &&
        stage.runtimeSource === "legacy-default" &&
        stage.dispatchMode === "legacy-fallback",
    ),
  ).toBe(true);
  for (const routing of [
    { runtime: "codex", runtimeSource: "stage", dispatchMode: "legacy-fallback" },
    { runtime: "claude", runtimeSource: "stage", dispatchMode: "legacy-fallback" },
    { runtime: "claude", runtimeSource: "legacy-default", dispatchMode: "exec-bridge" },
  ]) {
    const changed = structuredClone(observed);
    Object.assign(changed.stages.find((stage) => stage.id === "apply")!, routing);
    expect(assessWorkflowScope(changed).unsupported).toEqual(["apply"]);
  }
  const stages = structuredClone(plan.stages) as Array<Record<string, unknown>>;
  stages.find((stage) => stage.id === "apply")!.runtimeSource = "stage";
  const explicit = await readRasenWorkflow(cwd, change, {
    executable: await fake({ plan: { ...plan, stages } }),
  });
  expect(explicit.kind).toBe("present");
  expect(assessWorkflowScope(explicit).unsupported).toEqual(["apply"]);
});

test("conditional experts need skip evidence; no source loop still requires a host review", () => {
  const conditional = structuredClone(observed);
  conditional.stages.push({
    id: "cso",
    kind: "standard",
    skill: "rasen-cso",
    role: "reviewer",
    requires: ["apply"],
    condition: "security-relevant",
    status: "skipped",
    note: "No security-sensitive changes in reviewed diff",
  });
  conditional.completed.push("cso");
  expect(assessWorkflowScope(conditional).ready).toBe(true);
  conditional.stages.at(-1)!.note = "";
  expect(assessWorkflowScope(conditional).ready).toBe(false);
  const noLoop = structuredClone(observed);
  noLoop.stages = noLoop.stages.filter((stage) => stage.id !== "review-loop");
  expect(assessWorkflowScope(noLoop).reviewLoopReady).toBe(true);
});

test("workflow CLI evidence rejects wrong identity, stale state, graph and malformed findings", async () => {
  for (const value of [
    { ...resume, change: "another-change" },
    { ...resume, completed: [] },
    { ...resume, remaining: [] },
    { ...resume, ready: ["ship"] },
    { ...resume, next: "ship" },
    { ...resume, openFindings: [{ severity: "critical" }] },
  ]) {
    expect(
      (await readRasenWorkflow(cwd, change, { executable: await fake({ resume: value }) })).kind,
    ).toBe("invalid");
  }
  const stages = structuredClone(plan.stages) as Array<Record<string, unknown>>;
  stages[0].requires = ["archive"];
  expect(
    (
      await readRasenWorkflow(cwd, change, {
        executable: await fake({ plan: { ...plan, stages } }),
      })
    ).kind,
  ).toBe("invalid");
  const changed = await script(`import fs from 'node:fs';
if (process.argv[3] === 'resume') console.log(JSON.stringify(${JSON.stringify(resume)}));
else { fs.appendFileSync(${JSON.stringify(stateFile)}, ' '); console.log(JSON.stringify(${JSON.stringify(plan)})); }`);
  const stale = await readRasenWorkflow(cwd, change, { executable: changed });
  expect(stale.kind).toBe("invalid");
  if (stale.kind !== "present") expect(stale.reason).toContain("changed during observation");
  await writeState();
});

test("workflow state paths cannot escape or traverse symlinks", async () => {
  await expect(readRasenWorkflow(cwd, "../escape", { executable })).rejects.toThrow("kebab-case");
  await expect(
    readRasenWorkflow(cwd, change, {
      executable: await fake({ resume: { ...resume, runStateDir: temp } }),
    }),
  ).rejects.toThrow("supported local");
  const saved = await fs.readFile(stateFile, "utf8");
  const external = path.join(temp, "state-external.json");
  await fs.writeFile(external, saved);
  await fs.rm(stateFile);
  try {
    await fs.symlink(external, stateFile);
    await expect(readRasenWorkflow(cwd, change, { executable })).rejects.toThrow("symlinks");
  } finally {
    await fs.rm(stateFile, { force: true });
    await fs.writeFile(stateFile, saved);
  }
});

test("workflow commands enforce output/time/cancellation limits without echoing diagnostics", async () => {
  const oversized = await script('process.stdout.write("x".repeat(10000));');
  await expect(
    readRasenWorkflow(cwd, change, { executable: oversized, maxOutputBytes: 1024 }),
  ).rejects.toThrow("output limit");
  const invalid = await script('console.log("not-json");');
  await expect(readRasenWorkflow(cwd, change, { executable: invalid })).rejects.toThrow(
    "invalid JSON",
  );
  const failure = await script('process.stderr.write("SECRET_TOKEN=do-not-echo");process.exit(2);');
  try {
    await readRasenWorkflow(cwd, change, { executable: failure });
    throw new Error("Expected process failure");
  } catch (error) {
    expect(String(error)).toContain(
      "rasen pipeline resume workflow-smoke --json exited with code 2",
    );
    expect(String(error)).not.toContain("SECRET_TOKEN");
  }
  const hanging = await script("setTimeout(() => {}, 30000);");
  await expect(
    readRasenWorkflow(cwd, change, { executable: hanging, timeoutMs: 25 }),
  ).rejects.toThrow("timed out");
  const controller = new AbortController();
  const running = readRasenWorkflow(cwd, change, { executable: hanging }, controller.signal);
  setTimeout(() => controller.abort(), 50);
  await expect(running).rejects.toThrow("aborted");
  await expect(readRasenWorkflow(cwd, change, { executable }, controller.signal)).rejects.toThrow();
  await expect(readRasenWorkflow(cwd, change, { executable, timeoutMs: 5001 })).rejects.toThrow(
    "process limits",
  );
});

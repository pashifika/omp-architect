import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readRasenSnapshot, validateRasenChange } from "../src/auto/rasen.ts";

const sourceSha = "f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd";
let executable = process.env.RASEN_BIN ?? "";
const change = "adapter-smoke";
let temp: string;
let cwd: string;
let changeDir: string;
let skillPath: string;
let rawStatus: Record<string, unknown>;
let rawApply: Record<string, unknown>;
let scriptCount = 0;
const pendingTasks =
  "## 1. Smoke implementation\n\n- [ ] 1.1 Add deterministic echo\n- [ ] 1.2 Test deterministic echo\n";
const validSpec = `## ADDED Requirements

### Requirement: Deterministic echo
The system SHALL return the supplied text without modification.

#### Scenario: Text is provided
- **WHEN** a caller supplies the text "hello"
- **THEN** the system returns "hello"
`;

function cli(args: string[]): string {
  const result = spawnSync(executable, args, {
    cwd,
    shell: false,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      XDG_CONFIG_HOME: path.join(temp, "config"),
      XDG_DATA_HOME: path.join(temp, "data"),
      XDG_STATE_HOME: path.join(temp, "state"),
      RASEN_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      CI: "1",
      NO_COLOR: "1",
    },
  });
  if (result.error || result.status !== 0)
    throw new Error(`Real Rasen ${args[0]} fixture setup failed (exit ${result.status})`);
  return result.stdout;
}

async function fakeScript(body: string): Promise<string> {
  const script = path.join(temp, `fake-rasen-${++scriptCount}.mjs`);
  await fs.writeFile(script, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return script;
}

async function fakeApply(apply: Record<string, unknown>): Promise<string> {
  return fakeScript(
    `console.log(JSON.stringify(process.argv[2] === "status" ? ${JSON.stringify(rawStatus)} : ${JSON.stringify(apply)}));`,
  );
}

beforeAll(async () => {
  // An absent development build is a failed smoke test, never a skipped fake pass.
  if (!executable) {
    const stamp = JSON.parse(
      await fs.readFile(
        path.resolve(import.meta.dir, "../node_modules/.cache/omp-architect/rasen-build.json"),
        "utf8",
      ),
    );
    expect(stamp.commit).toBe(sourceSha);
    executable = stamp.executable;
  }
  await fs.access(executable);
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-rasen-"));
  cwd = await fs.realpath(
    await fs
      .mkdir(path.join(temp, "project"), { recursive: true })
      .then(() => path.join(temp, "project")),
  );
  changeDir = path.join(cwd, "rasen", "changes", change);
  skillPath = path.join(cwd, ".omp", "skills", "rasen-apply-change", "SKILL.md");
  const version = cli(["--version"]).trim();
  const buildCommit = version.match(/^0\.1\.8 \(dev\.local ([a-f0-9]{7,40})\)$/)?.[1];
  expect(buildCommit).toBeDefined();
  expect(sourceSha.startsWith(buildCommit!)).toBe(true);
  cli(["init", "--tools", "omp"]);
  const created = JSON.parse(cli(["new", "change", change, "--schema", "spec-driven", "--json"]));
  expect(created.change.id).toBe(change);
  expect(created.change.path).toBe(changeDir);
}, 30_000);

afterAll(async () => {
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

test("pinned Rasen dev/0.1.8 change facts, blocked/ready/all_done and strict validation without a pipeline", async () => {
  const options = { executable };
  const blocked = await readRasenSnapshot(cwd, change, options);
  expect(blocked.state).toBe("blocked");
  expect(blocked.tasks).toEqual([]);
  expect(blocked.skill).toBe("");
  expect(blocked.skillRecord?.kind).toBe("absent");
  expect(blocked.isComplete).toBe(false);
  expect(blocked.artifacts?.some((artifact) => artifact.status === "ready")).toBe(true);
  expect(blocked.applyNextWorkflows).toBeArray();
  // Init still produces a native OMP skill, but observing a change does not
  // depend on discovering or loading that skill body.
  const generated = await fs.readFile(skillPath, "utf8");
  expect(generated).toContain("name: rasen-apply-change");
  expect(generated).toContain('generatedBy: "0.1.8"');

  await fs.writeFile(
    path.join(changeDir, "proposal.md"),
    `## Why
Exercise the real read-only Rasen integration contract.

## What Changes
- Add deterministic echo with tests.

## Capabilities
### New Capabilities
- \`smoke-echo\`: return input unchanged.
### Modified Capabilities
None.

## Impact
Smoke fixture only.
`,
  );
  await fs.writeFile(
    path.join(changeDir, "design.md"),
    "## Context\nA deterministic smoke fixture.\n\n## Decisions\nEcho the original string.\n",
  );
  await fs.mkdir(path.join(changeDir, "specs", "smoke-echo"), { recursive: true });
  const specPath = path.join(changeDir, "specs", "smoke-echo", "spec.md");
  await fs.writeFile(specPath, validSpec);
  await fs.writeFile(path.join(changeDir, "tasks.md"), pendingTasks);
  rawStatus = JSON.parse(cli(["status", "--change", change, "--json"]));
  rawApply = JSON.parse(cli(["instructions", "apply", "--change", change, "--json"]));

  const ready = await readRasenSnapshot(cwd, change, options);
  expect(ready.state).toBe("ready");
  expect(ready.artifacts).toEqual(rawStatus.artifacts as typeof ready.artifacts);
  expect(ready.nextWorkflows).toBeArray();
  expect(ready.ephemeraDir).toBe(rawStatus.ephemeraDir as string);
  expect(ready.skillRecord?.kind).toBe("absent");
  expect(ready.progress).toEqual({ total: 2, complete: 0, remaining: 2 });
  expect(ready.tasks.map((task) => task.id)).toEqual(["1", "2"]);
  expect(ready.contextFiles).toHaveLength(4);
  expect(ready.contextFiles.find((file) => file.path.endsWith("tasks.md"))?.content).toBe(
    pendingTasks,
  );
  expect(ready.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  expect((await readRasenSnapshot(cwd, change, options)).fingerprint).toBe(ready.fingerprint);
  await validateRasenChange(cwd, change, options);

  await fs.writeFile(
    specPath,
    "## ADDED Requirements\n\n### Requirement: Broken\nMissing normative text and scenario.\n",
  );
  await expect(validateRasenChange(cwd, change, options)).rejects.toThrow("exited with code 1");
  await fs.writeFile(specPath, validSpec);
  await fs.writeFile(path.join(changeDir, "tasks.md"), pendingTasks.replaceAll("[ ]", "[x]"));
  const done = await readRasenSnapshot(cwd, change, options);
  expect(done.state).toBe("all_done");
  expect(done.progress.remaining).toBe(0);
  expect(done.isComplete).toBe(true);
  expect(done.applyNextWorkflows).toBeArray();
  expect(done.skillRecord?.kind).toBe("absent");
  expect(done.fingerprint).not.toBe(ready.fingerprint);
  await fs.writeFile(path.join(changeDir, "tasks.md"), pendingTasks);
}, 30_000);

test("Rasen adapter fails closed on malformed output, wrong change, progress and remote artifact paths", async () => {
  for (const apply of [
    { ...rawApply, changeName: "some-other-change" },
    { ...rawApply, progress: { total: 2, complete: 2, remaining: 2 } },
    { ...rawApply, state: "all_done" },
    {
      ...rawApply,
      root: { ...(rawApply.root as object), store_id: "external-store", source: "store" },
    },
    { ...rawApply, actionContext: { ...(rawApply.actionContext as object), codeWriteRoots: [] } },
    { ...rawApply, root: { ...(rawApply.root as object), scope: { kind: "store" } } },
    {
      ...rawApply,
      actionContext: { ...(rawApply.actionContext as object), mode: "planning-only" },
    },
    { ...rawApply, tasks: [{ id: "1", description: "Task", done: true }] },
    { ...rawApply, contextFiles: { tasks: [path.join(temp, "outside-secret.md")] } },
  ]) {
    await expect(
      readRasenSnapshot(cwd, change, { executable: await fakeApply(apply) }),
    ).rejects.toThrow("Rasen");
  }
  await expect(readRasenSnapshot(cwd, "../escape", { executable })).rejects.toThrow("kebab-case");
  const malformed = await fakeScript('console.log("not-json");');
  await expect(readRasenSnapshot(cwd, change, { executable: malformed })).rejects.toThrow(
    "invalid JSON",
  );
});

test("Rasen process output, timeout, cancellation and error messages stay bounded", async () => {
  const oversized = await fakeScript('process.stdout.write("x".repeat(20000));');
  await expect(
    readRasenSnapshot(cwd, change, { executable: oversized, maxOutputBytes: 1024 }),
  ).rejects.toThrow("output limit");
  const secret = await fakeScript(
    'process.stderr.write("SECRET_ACCESS_TOKEN=do-not-echo"); process.exit(3);',
  );
  try {
    await readRasenSnapshot(cwd, change, { executable: secret });
    throw new Error("Expected failure");
  } catch (error) {
    expect(String(error)).toContain("exited with code 3");
    expect(String(error)).not.toContain("SECRET_ACCESS_TOKEN");
  }
  const hanging = await fakeScript("setTimeout(() => {}, 30000);");
  await expect(
    readRasenSnapshot(cwd, change, { executable: hanging, timeoutMs: 50 }),
  ).rejects.toThrow("timed out");
  const controller = new AbortController();
  const pending = readRasenSnapshot(cwd, change, { executable: hanging }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    await expect(pending).rejects.toThrow("aborted");
  } finally {
    clearTimeout(timer);
  }
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await expect(
    readRasenSnapshot(cwd, change, { executable }, alreadyAborted.signal),
  ).rejects.toThrow();
});

test("Rasen observation is independent of missing, oversized or globally linked generated skills", async () => {
  const original = await fs.readFile(skillPath, "utf8");
  const before = await readRasenSnapshot(cwd, change, { executable });
  try {
    await fs.rm(skillPath);
    expect((await readRasenSnapshot(cwd, change, { executable })).fingerprint).toBe(
      before.fingerprint,
    );
    await fs.writeFile(skillPath, "x".repeat(256 * 1024 + 1));
    expect((await readRasenSnapshot(cwd, change, { executable })).fingerprint).toBe(
      before.fingerprint,
    );
    const outside = path.join(temp, "outside-skill.md");
    await fs.writeFile(outside, original);
    await fs.rm(skillPath);
    await fs.symlink(outside, skillPath);
    expect((await readRasenSnapshot(cwd, change, { executable })).fingerprint).toBe(
      before.fingerprint,
    );
  } finally {
    await fs.rm(skillPath, { force: true });
    await fs.writeFile(skillPath, original);
  }
});

test("Rasen still refuses external symlink change artifacts before observation or validation", async () => {
  const outside = path.join(temp, "outside-artifact.md");
  await fs.writeFile(outside, "External content must not be read");
  const link = path.join(changeDir, "outside.md");
  await fs.symlink(outside, link);
  try {
    await expect(readRasenSnapshot(cwd, change, { executable })).rejects.toThrow("symlinks");
    await expect(validateRasenChange(cwd, change, { executable })).rejects.toThrow("symlinks");
  } finally {
    await fs.rm(link);
  }
});

test("real Rasen status locates shared review-cycle output without a pipeline and never initializes or rewrites it", async () => {
  const before = await readRasenSnapshot(cwd, change, { executable });
  expect(before.skillRecord?.kind).toBe("absent");
  expect(before.ephemeraDir).toBe(rawStatus.ephemeraDir as string);
  const ephemeraDir = before.ephemeraDir!;
  expect(path.isAbsolute(ephemeraDir)).toBe(true);
  const file = path.join(ephemeraDir, "auto-run.json");
  const legacy = path.join(changeDir, "auto-run.json");
  const content = JSON.stringify({
    rounds: 2,
    openFindings: [{ severity: "minor", summary: "Clarify empty input" }],
    stages: { review: { status: "done", worker: { runtime: "omp", agentId: "review-2" } } },
  });
  await fs.mkdir(ephemeraDir, { recursive: true });
  try {
    await fs.writeFile(file, content);
    const observed = await readRasenSnapshot(cwd, change, { executable });
    expect(observed.skillRecord).toMatchObject({
      kind: "valid",
      path: file,
      content: JSON.parse(content),
    });
    expect(observed.fingerprint).not.toBe(before.fingerprint);
    expect(observed.state).toBe("ready");
    expect(await fs.readFile(file, "utf8")).toBe(content);
    await expect(fs.access(legacy)).rejects.toThrow();

    // A malformed first source is still an observation; it must not be hidden
    // by falling back to a stale legacy file or by seeding a synthetic record.
    await fs.writeFile(legacy, '{"rounds":1}');
    await fs.writeFile(file, "{malformed PRIVATE_RECORD");
    const malformed = await readRasenSnapshot(cwd, change, { executable });
    expect(malformed.skillRecord).toMatchObject({ kind: "malformed", path: file });
    expect(JSON.stringify(malformed.skillRecord)).not.toContain("PRIVATE_RECORD");
    expect(malformed.state).toBe("ready");
    expect(await fs.readFile(file, "utf8")).toBe("{malformed PRIVATE_RECORD");
    expect(await fs.readFile(legacy, "utf8")).toBe('{"rounds":1}');
  } finally {
    await fs.rm(file, { force: true });
    await fs.rm(legacy, { force: true });
  }
  expect((await readRasenSnapshot(cwd, change, { executable })).skillRecord?.kind).toBe("absent");
});

test("Rasen strict validation requires a successful report for exactly this change", async () => {
  const reports = [
    {},
    { version: "1.0", items: [] },
    {
      version: "1.0",
      items: [{ id: "other", type: "change", valid: true, issues: [] }],
      summary: { totals: { items: 1, passed: 1, failed: 0 } },
    },
    {
      version: "1.0",
      items: [{ id: change, type: "change", valid: false, issues: [] }],
      summary: { totals: { items: 1, passed: 1, failed: 0 } },
    },
  ];
  for (const report of reports) {
    const fake = await fakeScript(`console.log(${JSON.stringify(JSON.stringify(report))});`);
    await expect(validateRasenChange(cwd, change, { executable: fake })).rejects.toThrow("Rasen");
  }
});

test("CLI admission diagnostics identify a missing executable and hide process output", async () => {
  await expect(
    readRasenSnapshot(cwd, change, { executable: path.join(temp, "not-installed") }),
  ).rejects.toThrow("could not start (ENOENT)");
  const failure = await fakeScript('console.error("PRIVATE CLI CONTENT"); process.exit(23);');
  try {
    await readRasenSnapshot(cwd, change, { executable: failure });
    throw new Error("Expected admission failure");
  } catch (error) {
    expect(String(error)).toContain("exited with code 23");
    expect(String(error)).toContain("--change adapter-smoke --json");
    expect(String(error)).not.toContain("PRIVATE CLI CONTENT");
  }
});

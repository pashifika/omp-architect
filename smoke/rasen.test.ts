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

test("pinned Rasen dev/0.1.8 init, generated OMP skill, blocked/ready/all_done and strict validation", async () => {
  const options = { executable };
  const blocked = await readRasenSnapshot(cwd, change, options);
  expect(blocked.state).toBe("blocked");
  expect(blocked.tasks).toEqual([]);
  expect(blocked.skill).toContain("name: rasen-apply-change");
  expect(blocked.skill).toContain('generatedBy: "0.1.8"');

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
  await expect(validateRasenChange(cwd, change, options)).rejects.toThrow("Rasen command failed");
  await fs.writeFile(specPath, validSpec);
  await fs.writeFile(path.join(changeDir, "tasks.md"), pendingTasks.replaceAll("[ ]", "[x]"));
  const done = await readRasenSnapshot(cwd, change, options);
  expect(done.state).toBe("all_done");
  expect(done.progress.remaining).toBe(0);
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
    expect(String(error)).toContain("Rasen command failed");
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

test("Rasen adapter refuses missing or oversized generated skills and external symlink artifacts", async () => {
  const original = await fs.readFile(skillPath, "utf8");
  try {
    await fs.rm(skillPath);
    await expect(readRasenSnapshot(cwd, change, { executable })).rejects.toThrow(
      "missing or unreadable",
    );
    await fs.writeFile(skillPath, "x".repeat(64 * 1024 + 1));
    await expect(readRasenSnapshot(cwd, change, { executable })).rejects.toThrow(
      "bounded regular text",
    );
    const outside = path.join(temp, "outside-skill.md");
    await fs.writeFile(outside, original);
    await fs.rm(skillPath);
    await fs.symlink(outside, skillPath);
    await expect(readRasenSnapshot(cwd, change, { executable })).rejects.toThrow("escapes");
    await fs.rm(skillPath);
  } finally {
    await fs.writeFile(skillPath, original);
  }
  const link = path.join(changeDir, "outside.md");
  await fs.symlink(path.join(temp, "outside-skill.md"), link);
  try {
    await expect(readRasenSnapshot(cwd, change, { executable })).rejects.toThrow("symlinks");
    await expect(validateRasenChange(cwd, change, { executable })).rejects.toThrow("symlinks");
  } finally {
    await fs.rm(link);
  }
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

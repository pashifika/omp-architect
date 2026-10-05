import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  readRasenSnapshot,
  resolveRasenChangeDirectory,
  validateRasenChange,
} from "../src/auto/rasen.ts";

const roots: string[] = [];
const change = "existing-change";
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rasen-observation-"));
  roots.push(temp);
  const root = await fs.realpath(temp);
  const changeDir = path.join(root, "rasen", "changes", change);
  await fs.mkdir(changeDir, { recursive: true });
  await fs.writeFile(
    path.join(changeDir, ".openspec.yaml"),
    "schema: spec-driven\ncreated: 2026-10-05\n",
  );
  const rootFact = { path: root, source: "repo", scope: { kind: "standalone" } };
  const actionContext = {
    version: 1,
    mode: "repo-local",
    sourceOfTruth: "repo",
    codeWriteRoots: [root],
    allowedEditRoots: [root],
    requiresAffectedAreaSelection: false,
  };
  const status: Record<string, unknown> = {
    root: rootFact,
    actionContext,
    changeName: change,
    changeRoot: changeDir,
    schemaName: "spec-driven",
    isComplete: false,
    artifacts: [
      { id: "proposal", outputPath: "proposal.md", status: "ready" },
      { id: "tasks", outputPath: "tasks.md", status: "blocked", missingDeps: ["proposal"] },
    ],
    applyRequires: ["tasks"],
    nextSteps: ["Create proposal"],
    nextWorkflows: [],
    evidenceDir: path.join(changeDir, "evidence"),
    handoffDir: path.join(changeDir, "handoff"),
    // Deliberately not the default layout: readers must use actual CLI paths.
    ephemeraDir: path.join(root, ".rasen", "reported-ephemera"),
  };
  const apply: Record<string, unknown> = {
    root: rootFact,
    actionContext,
    changeName: change,
    changeDir,
    changeRoot: changeDir,
    schemaName: "spec-driven",
    contextFiles: {},
    progress: { total: 0, complete: 0, remaining: 0 },
    tasks: [],
    instruction: "Cannot apply: proposal and tasks do not exist yet",
    state: "blocked",
    missingArtifacts: ["proposal", "tasks"],
    nextWorkflows: [{ workflow: "continue", reason: "Continue authoring" }],
  };
  const executable = path.join(root, "read-only-rasen.mjs");
  const log = path.join(root, "commands.jsonl");
  const writeCli = async (body?: string) =>
    fs.writeFile(
      executable,
      `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${body ?? `console.log(JSON.stringify(process.argv[2] === 'status' ? ${JSON.stringify(status)} : ${JSON.stringify(apply)}));`}\n`,
      { mode: 0o700 },
    );
  await writeCli();
  const archive = async (date = "2026-10-05") => {
    const dir = path.join(root, "rasen", "changes", "archive", `${date}-${change}`);
    await fs.mkdir(path.dirname(dir), { recursive: true });
    await fs.rename(changeDir, dir);
    return dir;
  };
  const observe = () => readRasenSnapshot(root, change, { executable });
  const writeRecord = async (directory: string, value: unknown) => {
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, "auto-run.json");
    await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  return {
    root,
    changeDir,
    executable,
    log,
    status,
    apply,
    archive,
    writeCli,
    observe,
    writeRecord,
  };
}

test("an existing blocked change is observable with no pipeline, run record, apply skill or .omp directory", async () => {
  const f = await fixture();
  const snapshot = await f.observe();
  expect(snapshot.state).toBe("blocked");
  expect(snapshot.tasks).toEqual([]);
  expect(snapshot.progress).toEqual({ total: 0, complete: 0, remaining: 0 });
  expect(snapshot.skill).toBe("");
  expect(snapshot.source).toBe("live-cli");
  expect(snapshot.artifacts).toEqual(f.status.artifacts as typeof snapshot.artifacts);
  expect(snapshot.applyRequires).toEqual(["tasks"]);
  expect(snapshot.nextSteps).toEqual(["Create proposal"]);
  expect(snapshot.nextWorkflows).toEqual([]);
  expect(snapshot.applyNextWorkflows).toEqual([
    { workflow: "continue", reason: "Continue authoring" },
  ]);
  expect(snapshot.skillRecord).toEqual({
    kind: "absent",
    searchedPaths: [
      path.join(f.status.ephemeraDir as string, "auto-run.json"),
      path.join(f.changeDir, "auto-run.json"),
    ],
  });
  expect((await f.observe()).fingerprint).toBe(snapshot.fingerprint);
  const calls = (await fs.readFile(f.log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    calls.every(
      (args) =>
        JSON.stringify(args) === JSON.stringify(["status", "--change", change, "--json"]) ||
        JSON.stringify(args) ===
          JSON.stringify(["instructions", "apply", "--change", change, "--json"]),
    ),
  ).toBe(true);
  await expect(fs.access(path.join(f.root, ".omp"))).rejects.toThrow();
  await expect(fs.access(f.status.ephemeraDir as string)).rejects.toThrow();
});

test("all_done and complete artifacts remain source facts with runtime next workflows", async () => {
  const f = await fixture();
  Object.assign(f.apply, {
    state: "all_done",
    progress: { total: 1, complete: 1, remaining: 0 },
    tasks: [{ id: "1", description: "Implement", done: true }],
    nextWorkflows: [{ workflow: "verify", reason: "Review implementation" }],
  });
  Object.assign(f.status, {
    isComplete: true,
    nextWorkflows: [{ workflow: "apply", reason: "Artifacts ready" }],
  });
  await f.writeCli();
  const snapshot = await f.observe();
  expect(snapshot.state).toBe("all_done");
  expect(snapshot.isComplete).toBe(true);
  expect(snapshot.nextWorkflows).toEqual(f.status.nextWorkflows as typeof snapshot.nextWorkflows);
  expect(snapshot.applyNextWorkflows).toEqual(
    f.apply.nextWorkflows as typeof snapshot.applyNextWorkflows,
  );
  expect(snapshot.archived).toBe(false);
  expect(snapshot.skillRecord?.kind).toBe("absent");
});

test("review-cycle output without a pipeline preserves rounds, findings and native worker metadata without writes", async () => {
  const f = await fixture();
  const content = {
    rounds: 2,
    openFindings: [{ severity: "major", summary: "Race", owner: "reviewer" }],
    stages: {
      review: {
        status: "done",
        worker: { runtime: "omp", agentId: "r-2", outputFile: "/native/output" },
      },
    },
  };
  const file = await f.writeRecord(f.status.ephemeraDir as string, content);
  const before = await fs.readFile(file, "utf8");
  const snapshot = await f.observe();
  expect(snapshot.skillRecord).toMatchObject({ kind: "valid", path: file, content });
  expect((snapshot.skillRecord as { sha256: string }).sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(await fs.readFile(file, "utf8")).toBe(before);
  await expect(fs.access(path.join(f.changeDir, "auto-run.json"))).rejects.toThrow();
  await f.writeRecord(f.status.ephemeraDir as string, { ...content, rounds: 3 });
  expect((await f.observe()).fingerprint).not.toBe(snapshot.fingerprint);
});

test("sticky record lookup uses status ephemera, external workDir, then changeDir without moving files", async () => {
  const f = await fixture();
  const external = await fixture();
  f.status.workDir = path.join(external.root, "legacy-work");
  await f.writeCli();
  const changeFile = await f.writeRecord(f.changeDir, { rounds: 1 });
  expect((await f.observe()).skillRecord).toMatchObject({
    kind: "valid",
    path: changeFile,
    content: { rounds: 1 },
  });
  const workFile = await f.writeRecord(f.status.workDir as string, {
    rounds: 2,
    pipeline: "legacy",
  });
  expect((await f.observe()).skillRecord).toMatchObject({
    kind: "valid",
    path: workFile,
    content: { rounds: 2, pipeline: "legacy" },
  });
  const ephemeraFile = await f.writeRecord(f.status.ephemeraDir as string, { rounds: 3 });
  expect((await f.observe()).skillRecord).toMatchObject({
    kind: "valid",
    path: ephemeraFile,
    content: { rounds: 3 },
  });
  expect(await fs.readFile(changeFile, "utf8")).toBe('{"rounds":1}');
  expect(await fs.readFile(workFile, "utf8")).toBe('{"rounds":2,"pipeline":"legacy"}');
});

test("malformed optional records stay distinguishable and never fall back to older valid records", async () => {
  const f = await fixture();
  await f.writeRecord(f.changeDir, { rounds: 1 });
  const file = await f.writeRecord(f.status.ephemeraDir as string, "{broken PRIVATE_DATA");
  for (const invalid of [
    "{broken PRIVATE_DATA",
    "[]",
    "null",
    '{"nested":' + "[".repeat(40) + "1" + "]".repeat(40) + "}",
    "x".repeat(65537),
    Buffer.from([0xff]),
  ]) {
    await fs.writeFile(file, invalid);
    const snapshot = await f.observe();
    expect(snapshot.skillRecord).toMatchObject({ kind: "malformed", path: file });
    expect(JSON.stringify(snapshot.skillRecord)).not.toContain("PRIVATE_DATA");
    expect(snapshot.state).toBe("blocked");
    expect(await fs.readFile(file)).toEqual(Buffer.from(invalid));
  }
});

test("status and apply identity/readiness metadata remain validated", async () => {
  for (const modify of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.status.changeName = "wrong";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.status.nextWorkflows = [{ workflow: "continue", reason: 1 }];
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.status.artifacts = [{ id: "proposal", status: "ready" }];
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.status.artifacts = Array.from({ length: 2 }, () => ({
        id: "same",
        outputPath: "same.md",
        status: "ready",
      }));
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.status.workDir = "../../outside";
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.apply.ephemeraDir = path.join(f.root, "other");
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      (f.status.actionContext as Record<string, unknown>).allowedEditRoots = ["/"];
    },
  ]) {
    const f = await fixture();
    modify(f);
    await f.writeCli();
    await expect(f.observe()).rejects.toThrow("unsupported or inconsistent");
  }
});

test("context is bounded UTF-8 and refuses linked change artifacts", async () => {
  const f = await fixture();
  const file = path.join(f.changeDir, "proposal.md");
  f.apply.contextFiles = { proposal: [file] };
  await f.writeCli();
  for (const invalid of ["x".repeat(65537), "\0", Buffer.from([0xff, 0xfe])]) {
    await fs.writeFile(file, invalid);
    await expect(f.observe()).rejects.toThrow();
  }
  const other = await fixture();
  await fs.writeFile(path.join(other.changeDir, "proposal.md"), "External");
  await fs.rm(file);
  await fs.symlink(path.join(other.changeDir, "proposal.md"), file);
  await expect(f.observe()).rejects.toThrow("symlinks");
});

test("archived context is observed without inventing live CLI success or pipeline completion", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.changeDir, "tasks.md"), "- [X] 1.1 Implement\n* [ ] 1.2 Check\n");
  await f.writeRecord(f.changeDir, { rounds: 3 });
  const archiveDir = await f.archive();
  const options = { executable: path.join(f.root, "no-cli-needed") };
  expect(await resolveRasenChangeDirectory(f.root, change)).toEqual({
    root: f.root,
    changeDir: archiveDir,
    archived: true,
  });
  const snapshot = await readRasenSnapshot(f.root, change, options);
  expect(snapshot.state).toBe("archived");
  expect(snapshot.source).toBe("archived-artifacts");
  expect(snapshot.archived).toBe(true);
  expect(snapshot.schema).toBe("spec-driven");
  expect(snapshot.progress).toEqual({ total: 2, complete: 1, remaining: 1 });
  expect(snapshot.tasks.map((task) => task.id)).toEqual(["1", "2"]);
  expect(
    snapshot.contextFiles.every((file) =>
      file.path.startsWith(`rasen/changes/archive/2026-10-05-${change}/`),
    ),
  ).toBe(true);
  expect(snapshot.skillRecord).toMatchObject({
    kind: "valid",
    path: path.join(archiveDir, "auto-run.json"),
    content: { rounds: 3 },
  });
  expect((await readRasenSnapshot(f.root, change, options)).fingerprint).toBe(snapshot.fingerprint);
  expect(snapshot.isComplete).toBeUndefined();
  expect(snapshot.nextWorkflows).toBeUndefined();
  await expect(fs.access(f.log)).rejects.toThrow();
  await expect(validateRasenChange(f.root, change, options)).rejects.toThrow(
    "requires an active local change",
  );
});

test("archive lookup rejects ambiguity, unsupported identity and symlinked directories", async () => {
  const f = await fixture();
  const archived = await f.archive();
  const duplicate = path.join(path.dirname(archived), `2026-10-04-${change}`);
  await fs.mkdir(duplicate);
  await expect(resolveRasenChangeDirectory(f.root, change)).rejects.toThrow("ambiguous");
  await fs.rm(duplicate, { recursive: true });
  const metadata = path.join(archived, ".openspec.yaml");
  for (const text of [
    "schema: spec-driven\nchangeName: other\n",
    "schema: spec-driven\nidentity: { version: 2 }\n",
    "schema: spec-driven\nschema: other\n",
    "schema: [invalid]\n",
  ]) {
    await fs.writeFile(metadata, text);
    await expect(f.observe()).rejects.toThrow("identity");
  }
  const linked = path.join(f.root, "archived-copy");
  await fs.rename(archived, linked);
  await fs.symlink(linked, archived, "dir");
  await expect(resolveRasenChangeDirectory(f.root, change)).rejects.toThrow(
    "regular local directory",
  );
});

test("active CLI errors never fall back to an older archive or expose raw diagnostics", async () => {
  const f = await fixture();
  await fs.mkdir(path.join(f.root, "rasen", "changes", "archive", `2026-10-04-${change}`), {
    recursive: true,
  });
  await f.writeCli("console.error('PRIVATE_DIAGNOSTIC'); process.exit(23);");
  try {
    await f.observe();
    throw new Error("Expected CLI failure");
  } catch (error) {
    expect(String(error)).toContain("exited with code 23");
    expect(String(error)).not.toContain("PRIVATE_DIAGNOSTIC");
  }
  await f.writeCli("process.stdout.write(Buffer.from([0xff]));");
  await expect(f.observe()).rejects.toThrow("invalid JSON");
});

test("missing archives, wrong date identities and cancellation stay fail-closed", async () => {
  const f = await fixture();
  await fs.rm(f.changeDir, { recursive: true });
  await expect(resolveRasenChangeDirectory(f.root, change)).rejects.toThrow("ENOENT");
  await fs.mkdir(path.join(f.root, "rasen", "changes", "archive", `2026-02-30-${change}`), {
    recursive: true,
  });
  await expect(resolveRasenChangeDirectory(f.root, change)).rejects.toThrow(
    "invalid date identity",
  );
  const controller = new AbortController();
  controller.abort();
  await expect(readRasenSnapshot(f.root, change, {}, controller.signal)).rejects.toThrow();
});

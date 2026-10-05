import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import {
  AUTO_JOURNAL_TYPE,
  MAX_AUTO_EVENT_BYTES,
  appendAutoEvent,
  readAutoHistory,
  type AutoChangeIdentity,
  type AutoEvent,
  type AutoJournalDecision,
} from "../src/auto/journal.ts";

const change: AutoChangeIdentity = { change: "fix-login", root: "/work/rasen", schema: "default" };
const decision: AutoJournalDecision = {
  choice: "apply",
  criterion: "The approved plan has unfinished implementation tasks",
  confidence: 0.96,
  evidenceRefs: ["artifact://1", "session://selected-change"],
};
const receipt = {
  toolCallId: "call-1",
  tool: "edit",
  isError: false,
  sha256: "a".repeat(64),
  model: { provider: "openai", id: "native-model", thinkingLevel: "xhigh" },
};

function event(kind: AutoEvent["kind"] = "run-start", id: string = kind): AutoEvent {
  const common = {
    version: 1 as const,
    kind,
    eventId: id,
    runId: "run-1",
    at: 1000,
    changeIdentity: { ...change },
    inputFingerprint: "input-1",
  };
  if (kind === "run-start" || kind === "run-stop") return { ...common, kind };
  const action = { ...common, actionId: "action-1", skill: "rasen-apply" };
  if (kind === "action-selected" || kind === "action-admitted")
    return { ...action, kind, decision: structuredClone(decision) };
  if (kind === "action-held") return { ...action, kind, status: "incomplete" };
  return {
    ...action,
    kind,
    outcome: "progress",
    outputFingerprint: "output-1",
    nativeReceipts: [structuredClone(receipt)],
  };
}

function fixture() {
  const manager = SessionManager.inMemory("/virtual/auto-journal");
  const api = {
    appendEntry<T>(type: string, data?: T): void {
      manager.appendCustomEntry(type, data);
    },
  };
  return { manager, api };
}

test("native branch facts retain decisions, exact receipt metadata and distinct held/settled outcomes", () => {
  const { manager, api } = fixture();
  const values = [
    event(),
    event("action-selected"),
    event("action-admitted"),
    event("action-held"),
    event("action-settled"),
    { ...event("run-stop"), status: "needs_user" },
  ];
  for (const value of values) appendAutoEvent(api, value);
  const result = readAutoHistory(manager, change);
  expect(result).toEqual({ records: values, diagnostics: [], valid: true });
  expect(result.records[4]).toMatchObject({ outcome: "progress", nativeReceipts: [receipt] });
  expect(result.records[3]).not.toHaveProperty("outcome");
  expect(manager.getBranch().every((entry) => entry.type === "custom")).toBe(true);
});

test("branch reads exclude abandoned native history and other selected changes", () => {
  const { manager, api } = fixture();
  appendAutoEvent(api, event());
  const root = manager.getLeafId()!;
  appendAutoEvent(api, event("action-selected", "abandoned-selection"));
  appendAutoEvent(api, event("action-settled", "abandoned-settlement"));
  manager.branch(root);
  const selected = event("action-held", "current-hold");
  appendAutoEvent(api, selected);
  appendAutoEvent(api, {
    ...event("run-start", "other-change"),
    changeIdentity: { ...change, change: "other" },
  });
  manager.appendCustomEntry("unrelated-extension", { outcome: "success" });
  const before = manager.getBranch().length;
  expect(readAutoHistory(manager, change)).toEqual({
    records: [event(), selected],
    diagnostics: [],
    valid: true,
  });
  expect(manager.getEntries().length).toBeGreaterThan(before);
  expect(manager.getBranch()).toHaveLength(before);
});

test("incomplete facts survive a native session reload without creating a side-state file or resuming", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-journal-"));
  const storage = new MemorySessionStorage();
  const sessionDir = path.join(cwd, "native-sessions");
  const manager = SessionManager.create(cwd, sessionDir, storage);
  let reopened: SessionManager | undefined;
  try {
    const api = {
      appendEntry: (type: string, data?: unknown) => {
        manager.appendCustomEntry(type, data);
      },
    };
    appendAutoEvent(api, event());
    appendAutoEvent(api, event("action-admitted"));
    appendAutoEvent(api, event("action-held"));
    // Native hosts materialize sessions; the extension only appends facts.
    await manager.ensureOnDisk();
    await manager.flush();
    const file = manager.getSessionFile()!;
    await manager.close();
    reopened = await SessionManager.open(file, sessionDir, storage, {
      initialCwd: cwd,
      suppressBreadcrumb: true,
    });
    const before = storage.readTextSync(file);
    const result = readAutoHistory(reopened, change);
    expect(result.valid).toBe(true);
    expect(result.records.map((item) => item.kind)).toEqual([
      "run-start",
      "action-admitted",
      "action-held",
    ]);
    expect(result.records.some((item) => item.kind === "action-settled")).toBe(false);
    expect(readAutoHistory(reopened, change)).toEqual(result);
    expect(storage.readTextSync(file)).toBe(before);
    expect(await fs.readdir(cwd)).toEqual([]);
  } finally {
    await reopened?.close();
    await manager.close();
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("append and read detach records so caller mutation cannot rewrite native history", () => {
  const { manager, api } = fixture();
  const value = event("action-selected");
  appendAutoEvent(api, value);
  value.changeIdentity.change = "mutated";
  value.decision!.criterion = "mutated";
  const first = readAutoHistory(manager, change);
  expect(first.records[0].decision!.criterion).toBe(decision.criterion);
  first.records[0].decision!.evidenceRefs.push("fake-ref");
  expect(readAutoHistory(manager, change).records[0].decision!.evidenceRefs).toEqual(
    decision.evidenceRefs,
  );
});

test("unsupported, malformed and oversized native entries are explicit invalid history", () => {
  const { manager } = fixture();
  const invalid = [
    undefined,
    { ...event(), version: 2 },
    { ...event(), kind: "completed" },
    { ...event(), inputFingerprint: "" },
    { ...event("action-admitted"), decision: { ...decision, confidence: 1.1 } },
    { ...event("action-settled"), outcome: undefined },
    { ...event("action-settled"), outputFingerprint: undefined },
    { ...event("action-held"), outcome: "success" },
    { ...event("action-settled"), nativeReceipts: [{ fileExists: true }] },
    { ...event("action-settled"), nativeReceipts: [receipt, receipt] },
    { ...event(), reason: "🧪".repeat(MAX_AUTO_EVENT_BYTES / 4 + 1) },
    { ...event(), unknownFutureField: true },
  ];
  for (const value of invalid) manager.appendCustomEntry(AUTO_JOURNAL_TYPE, value);
  const history = readAutoHistory(manager, change);
  expect(history.valid).toBe(false);
  expect(history.records).toEqual([]);
  expect(history.diagnostics).toHaveLength(invalid.length);
  expect(history.diagnostics.some((item) => item.code === "unsupported_version")).toBe(true);
  expect(history.diagnostics.some((item) => item.code === "oversized_payload")).toBe(true);
});

test("unsafe payloads fail before append and getters are never evaluated", () => {
  const { manager, api } = fixture();
  let getterCalls = 0;
  const getter = { ...event() };
  Object.defineProperty(getter, "reason", {
    enumerable: true,
    get() {
      getterCalls++;
      return "no";
    },
  });
  const cycle = { ...event(), nativeReceipts: [] as unknown[] };
  cycle.nativeReceipts.push(cycle);
  const inherited = Object.assign(Object.create({ done: true }), event());
  const poisoned = JSON.parse(
    JSON.stringify(event()).replace('"version":1', '"__proto__":{"done":true},"version":1'),
  );
  for (const value of [
    getter,
    cycle,
    inherited,
    poisoned,
    { ...event(), at: NaN },
    { ...event(), reason: () => "no" },
  ])
    expect(() => appendAutoEvent(api, value as AutoEvent)).toThrow();
  expect(getterCalls).toBe(0);
  expect(manager.getBranch()).toEqual([]);
});

test("event replay and conflicting action identities are diagnosed without fabricated completion", () => {
  const { manager, api } = fixture();
  const selected = event("action-selected");
  appendAutoEvent(api, selected);
  appendAutoEvent(api, selected);
  appendAutoEvent(api, { ...event("action-settled"), inputFingerprint: "different-input" });
  const result = readAutoHistory(manager, change);
  expect(result.valid).toBe(false);
  expect(result.records).toEqual([selected]);
  expect(result.diagnostics.map((item) => item.code)).toEqual([
    "duplicate_event",
    "conflicting_action",
  ]);
});

test("native receipt reuse is valid within one action but not proof for a different action or run", () => {
  for (const other of [{ actionId: "action-2" }, { runId: "run-2" }]) {
    const { manager, api } = fixture();
    const held = { ...event("action-held"), nativeReceipts: [receipt] };
    const settled = event("action-settled");
    appendAutoEvent(api, held);
    appendAutoEvent(api, settled);
    expect(readAutoHistory(manager, change).valid).toBe(true);
    appendAutoEvent(api, { ...settled, ...other, eventId: "replay" });
    const result = readAutoHistory(manager, change);
    expect(result.records).toEqual([held, settled]);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["replayed_receipt"]);
  }
});

test("a settled invocation cannot be repeated with an identical or contradictory terminal fact", () => {
  const settled = event("action-settled");
  for (const changed of [
    {},
    { outcome: "failed" },
    { outputFingerprint: "different-output" },
    { nativeReceipts: [] },
  ]) {
    const { manager, api } = fixture();
    appendAutoEvent(api, settled);
    appendAutoEvent(api, {
      ...settled,
      ...changed,
      eventId: "repeated-settlement",
    } as AutoEvent);
    expect(readAutoHistory(manager, change)).toMatchObject({
      records: [settled],
      valid: false,
      diagnostics: [{ code: "conflicting_action" }],
    });
  }
});

test("later selection, admission or hold cannot reopen a settled invocation", () => {
  for (const kind of ["action-selected", "action-admitted", "action-held"] as const) {
    const { manager, api } = fixture();
    const settled = event("action-settled");
    appendAutoEvent(api, settled);
    appendAutoEvent(api, event(kind, "late-action-event"));
    const before = manager.getBranch().length;
    const observed = readAutoHistory(manager, change);
    expect(observed).toMatchObject({
      records: [settled],
      valid: false,
      diagnostics: [{ code: "conflicting_action" }],
    });
    // Re-reading/reloading facts cannot change terminality or append repairs.
    expect(readAutoHistory(manager, change)).toEqual(observed);
    expect(manager.getBranch()).toHaveLength(before);
  }
});

test("terminality is scoped to the invocation and imposes no mandatory admission phases", () => {
  const { manager, api } = fixture();
  const settled = { ...event("action-settled"), nativeReceipts: [] } as AutoEvent;
  const nextRun = { ...event("action-held"), eventId: "next-run", runId: "run-2" };
  const nextAction = {
    ...event("action-admitted"),
    eventId: "next-action",
    actionId: "action-2",
  };
  for (const value of [settled, nextRun, nextAction]) appendAutoEvent(api, value);
  expect(readAutoHistory(manager, change)).toEqual({
    records: [settled, nextRun, nextAction],
    diagnostics: [],
    valid: true,
  });
});

test("empty-receipt blocker and cancellation are honest settled facts, never implicit success", () => {
  for (const outcome of ["blocked", "needs_user", "cancelled", "failed"] as const) {
    const { manager, api } = fixture();
    const value = { ...event("action-settled"), outcome, nativeReceipts: [] } as AutoEvent;
    appendAutoEvent(api, value);
    expect(readAutoHistory(manager, change)).toEqual({
      records: [value],
      diagnostics: [],
      valid: true,
    });
  }
});

test("unavailable native branch is explicit and never falls back to all entries", () => {
  let allEntriesRead = false;
  const manager = {
    getBranch() {
      throw new Error("closed");
    },
    getEntries() {
      allEntriesRead = true;
      return [];
    },
  };
  expect(readAutoHistory(manager, change)).toMatchObject({
    valid: false,
    records: [],
    diagnostics: [{ code: "unreadable_branch" }],
  });
  expect(allEntriesRead).toBe(false);
});

test("a native receipt from another change on this branch cannot become fresh proof", () => {
  const { manager, api } = fixture();
  const foreign = {
    ...event("action-settled", "other-settlement"),
    changeIdentity: { ...change, change: "other" },
  };
  appendAutoEvent(api, foreign);
  appendAutoEvent(api, event("action-settled"));
  expect(readAutoHistory(manager, change)).toMatchObject({
    records: [],
    valid: false,
    diagnostics: [{ code: "replayed_receipt" }],
  });
});

test("the same native receipt ID from distinct known native sessions is not a replay", () => {
  const { manager, api } = fixture();
  const first = {
    ...event("action-settled", "session-one"),
    nativeReceipts: [
      { receiptId: "yield-1", sessionId: "session-one", artifactSha256: "a".repeat(64) },
    ],
  };
  const second = {
    ...event("action-settled", "session-two"),
    actionId: "action-2",
    nativeReceipts: [
      { receiptId: "yield-1", sessionId: "session-two", artifactSha256: "b".repeat(64) },
    ],
  };
  appendAutoEvent(api, first);
  appendAutoEvent(api, second);
  expect(readAutoHistory(manager, change)).toEqual({
    records: [first, second],
    diagnostics: [],
    valid: true,
  });
});

test("selected criteria preserve full native descriptions within the total event cap", () => {
  const { manager, api } = fixture();
  const criterion = "Choose this existing skill when: " + "x".repeat(8192);
  const value = { ...event("action-selected"), decision: { ...decision, criterion } } as AutoEvent;
  appendAutoEvent(api, value);
  expect(readAutoHistory(manager, change).records[0].decision!.criterion).toBe(criterion);
  const tooLong = {
    ...value,
    decision: { ...decision, criterion: "x".repeat(16385) },
  } as AutoEvent;
  expect(() => appendAutoEvent(api, tooLong)).toThrow("invalid decision");
  const tooManyBytes = {
    ...value,
    decision: { ...decision, criterion: "漢".repeat(16384) },
  } as AutoEvent;
  expect(() => appendAutoEvent(api, tooManyBytes)).toThrow("byte limit");
  expect(readAutoHistory(manager, change).records).toHaveLength(1);
});

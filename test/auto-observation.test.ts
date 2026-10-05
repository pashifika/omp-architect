import { describe, expect, test } from "bun:test";
import { buildJevRequest, sealDecisionEvidence } from "../src/auto/decision.ts";
import { AutoPreflightError } from "../src/auto/diagnostics.ts";
import type { AutoEvent } from "../src/auto/journal.ts";
import { buildAutoDecisionEvidence } from "../src/auto/observation.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";

function snapshot(): RasenSnapshot {
  return {
    change: "test-change",
    schema: "spec-driven",
    root: "/project",
    state: "ready",
    progress: { total: 2, complete: 1, remaining: 1 },
    tasks: [
      { id: "1", description: "Implementation", done: true },
      { id: "2", description: "Check the result", done: false },
    ],
    instruction: "Use the actual skill's instructions",
    skill: "Compatibility guidance",
    fingerprint: "f".repeat(64),
    artifacts: [{ id: "design", outputPath: "design.md", status: "done" }],
    contextFiles: [{ path: "design.md", content: "The requested design" }],
    actionContext: { constraint: "Keep the existing API" },
    skillRecord: {
      kind: "valid",
      path: "rasen/changes/test-change/auto-run.json",
      sha256: "a".repeat(64),
      content: { note: "The selected skill owns this record" },
    },
  };
}

function event(): AutoEvent {
  return {
    version: 1,
    kind: "action-settled",
    eventId: "event-1",
    runId: "run-1",
    at: 1,
    actionId: "action-1",
    skill: "rasen-custom",
    changeIdentity: { change: "test-change", root: "/project", schema: "spec-driven" },
    inputFingerprint: "input-1",
    outputFingerprint: "output-1",
    outcome: "progress",
    reason: "One native result observed",
    nativeReceipts: [
      { receiptId: "receipt-1", artifactRef: "artifact://native-1", sha256: "hash" },
    ],
    decision: {
      choice: "skill_0",
      criterion: "The full skill description",
      confidence: 0.95,
      evidenceRefs: ["native-event:previous"],
    },
  };
}

function checkedEvidence(
  current: RasenSnapshot,
  goal: string,
  history: AutoEvent[],
  budget: number,
  claim = "Observed progress",
  tools: string[] = [],
) {
  const evidence = buildAutoDecisionEvidence(current, goal, claim, history, tools, budget);
  expect(JSON.stringify(evidence).length).toBeLessThanOrEqual(budget);
  const sealed = sealDecisionEvidence(evidence, budget);
  expect(sealed.summary).toBe(evidence.summary);
  expect(sealed.recentTools).toEqual(evidence.recentTools);
  const summary = JSON.parse(sealed.summary);
  expect(summary.goal).toBe(goal);
  expect(summary.changeFacts.state).toBe(current.state);
  expect(summary.changeFacts.progress).toEqual(current.progress);
  expect(summary.changeFacts.fingerprint).toBe(current.fingerprint);
  expect(evidence.remaining).toBe(current.progress.remaining);
  expect(evidence.completed).toBe(current.progress.complete);
  return { evidence, summary };
}

describe("bounded Auto observations", () => {
  test("preserves ordinary artifact, task, context and native observations without mutation", () => {
    const current = snapshot();
    const history = [event()];
    const original = structuredClone({ current, history });
    const { evidence, summary } = checkedEvidence(
      current,
      "Deliver the requested change",
      history,
      12000,
    );
    expect(summary.changeFacts.tasks).toEqual(current.tasks);
    expect(summary.changeFacts.artifacts).toEqual(current.artifacts);
    expect(summary.changeFacts.contextFiles).toEqual(current.contextFiles);
    expect(summary.changeFacts.actionContext).toEqual(current.actionContext);
    expect(summary.changeFacts.skillRecord).toEqual(current.skillRecord);
    expect(summary.nativeHistory[0].outcome).toBe("progress");
    expect(summary.nativeObservations[0].reason).toBe(history[0].reason);
    expect(summary.truncated).toBe(false);
    expect(evidence).not.toHaveProperty("choices");
    expect({ current, history }).toEqual(original);
  });

  test("giant raw records cannot displace goal, fresh facts, source identity or native references", () => {
    const giant = '\\"\n'.repeat(25000);
    const current = snapshot();
    if (current.skillRecord?.kind !== "valid") throw new Error("Expected a valid fixture");
    current.skillRecord.content = {
      log: giant,
      counts: { rounds: 3 },
      customFinding: "Needs a fix",
    };
    current.actionContext = { raw: giant, constraint: "Keep the existing API" };
    current.contextFiles[0].content = giant;
    current.tasks[1].description = giant;
    const record = event();
    record.reason = giant;
    record.nativeReceipts![0].output = giant;
    const goal =
      'Preserve this complete goal, including "quoted" guidance\nand its final constraint';
    const { summary } = checkedEvidence(current, goal, [record], 4000, giant, [giant]);
    expect(summary.truncated).toBe(true);
    expect(summary.changeFacts.skillRecord).toMatchObject({
      kind: "valid",
      path: current.skillRecord.path,
      sha256: current.skillRecord.sha256,
    });
    expect(summary.nativeHistory[0]).toMatchObject({
      eventId: record.eventId,
      outcome: "progress",
      evidenceRefs: ["native-event:previous"],
      nativeReceipts: [
        { receiptId: "receipt-1", artifactRef: "artifact://native-1", sha256: "hash" },
      ],
    });
    expect(summary.changeFacts.contextFiles).toBeDefined();
    expect(summary.changeFacts.skillRecord.content).toBeDefined();
    expect(summary.changeFacts.tasks).toBeDefined();
  });

  test("the supported 1000-character budget survives provider sealing as valid nested JSON", () => {
    const current = snapshot();
    const record = event();
    delete record.decision;
    delete record.outputFingerprint;
    const goal = 'Finish the requested "change"\nwith the stated constraints';
    const { summary } = checkedEvidence(current, goal, [record], 1000, "claim ".repeat(1000), [
      '\\"'.repeat(1000),
    ]);
    expect(summary.truncated).toBe(true);
    expect(summary.changeFacts.skillRecord.path).toBe("rasen/changes/test-change/auto-run.json");
    expect(summary.changeFacts.skillRecord.sha256).toBe("a".repeat(64));
  });

  test("oversized full goals fail with actionable preflight guidance instead of silent clipping", () => {
    const goal = '"\\\n'.repeat(400);
    expect(() => buildAutoDecisionEvidence(snapshot(), goal, "", [], [], 1000)).toThrow(
      AutoPreflightError,
    );
    expect(() => buildAutoDecisionEvidence(snapshot(), goal, "", [], [], 1000)).toThrow(
      "Shorten the guidance or increase auto maxEvidenceChars",
    );
  });

  test("all_done and private record assertions stay observations, never inferred success", () => {
    const current = snapshot();
    current.state = "all_done";
    current.progress = { total: 2, complete: 2, remaining: 0 };
    current.skillRecord = {
      kind: "valid",
      path: "custom.json",
      sha256: "private-hash",
      content: { success: true, complete: true, phase: "made-up", pipeline: { state: "done" } },
    };
    const record = event();
    if (record.kind !== "action-settled") throw new Error("Expected settled fixture");
    record.outcome = "failed";
    const { evidence, summary } = checkedEvidence(
      current,
      "Outcome requires actual evidence",
      [record],
      12000,
    );
    expect(summary.changeFacts.skillRecord.content).toEqual(current.skillRecord.content);
    expect(summary.nativeHistory[0].outcome).toBe("failed");
    expect(summary).not.toHaveProperty("complete");
    expect(summary.changeFacts).not.toHaveProperty("success");
    expect(evidence).not.toHaveProperty("choices");
  });

  test("exact control and skill criteria have their own separate budget", () => {
    const { evidence } = checkedEvidence(snapshot(), "Use all available descriptions", [], 1000);
    const choices = {
      skill_0: 'Exact "skill" description\n'.repeat(300),
      finish: "Propose finishing only from outcome evidence",
    };
    const sealed = sealDecisionEvidence({ ...evidence, choices }, 1000);
    expect(sealed.choices).toEqual(choices);
    expect(sealed.summary).toBe(evidence.summary);
    const request = buildJevRequest(sealed, { model: "jev-latest", maxEvidenceChars: 1000 });
    expect(request.questions.next.criteria).toEqual(choices);
    expect(JSON.parse(request.state.summary).goal).toBe("Use all available descriptions");
    expect(JSON.stringify(request.state).length).toBeLessThanOrEqual(1000);
  });

  test("many history and tool observations explicitly report truncation and keep newest evidence", () => {
    const history = Array.from({ length: 40 }, (_, i) => ({ ...event(), eventId: `event-${i}` }));
    const tools = Array.from({ length: 20 }, (_, i) => `tool-${i}: ${'\\"\n'.repeat(100)}`);
    for (const budget of [1000, 2000, 4000, 12000, 24000]) {
      const { evidence, summary } = checkedEvidence(
        snapshot(),
        "The exact goal",
        history,
        budget,
        "Observed progress",
        tools,
      );
      expect(summary.truncated).toBe(true);
      expect(evidence.recentTools.length).toBeLessThanOrEqual(8);
      expect(evidence.recentTools.every((item) => typeof item === "string")).toBe(true);
      if (summary.nativeHistory?.length) {
        expect(summary.nativeHistory.at(-1).eventId).toBe("event-39");
        expect(summary.nativeHistory.map((entry: { eventId: string }) => entry.eventId)).toEqual(
          history.slice(-summary.nativeHistory.length).map((entry) => entry.eventId),
        );
      }
    }
  });

  test("a nearly full essential envelope still fits when all optional observations are omitted", () => {
    const current = snapshot();
    const goal = "Exact user guidance ".repeat(25);
    const core = {
      change: current.change,
      remaining: current.progress.remaining,
      completed: current.progress.complete,
      summary: JSON.stringify({
        goal,
        changeFacts: {
          state: current.state,
          progress: current.progress,
          fingerprint: current.fingerprint,
        },
        truncated: false,
      }),
      recentTools: [],
    };
    const { evidence, summary } = checkedEvidence(
      current,
      goal,
      [event()],
      JSON.stringify(core).length + 1,
      "A claim",
      ["A tool observation"],
    );
    expect(summary.truncated).toBe(true);
    expect(evidence.recentTools).toEqual([]);
  });

  test("absent and malformed private records retain their observed kind and source", () => {
    const current = snapshot();
    current.skillRecord = { kind: "absent", searchedPaths: ["auto-run.json", "legacy.json"] };
    let result = checkedEvidence(current, "Inspect actual work", [], 4000);
    expect(result.summary.changeFacts.skillRecord).toEqual(current.skillRecord);
    current.skillRecord = {
      kind: "malformed",
      path: "auto-run.json",
      sha256: "hash",
      reason: "bad ".repeat(10000),
    };
    result = checkedEvidence(current, "Inspect actual work", [], 4000);
    expect(result.summary.changeFacts.skillRecord).toMatchObject({
      kind: "malformed",
      path: "auto-run.json",
      sha256: "hash",
    });
    expect(result.summary.truncated).toBe(true);
  });
});

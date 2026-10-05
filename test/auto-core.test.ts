import { expect, test } from "bun:test";
import { JevError } from "../src/auto/decision.ts";
import { DecisionFailure } from "../src/auto/decision-diagnostics.ts";
import { AutoRun } from "../src/auto/core.ts";
import { parseAutoConfig } from "../src/auto/config.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";
import type { DecisionEvidence, DecisionProvider } from "../src/auto/decision.ts";

const signal = () => new AbortController().signal;
function snapshot(done: string[] = []): RasenSnapshot {
  return {
    change: "test-change",
    root: "/fixture",
    schema: "spec-driven",
    state: done.length === 2 ? "all_done" : "ready",
    progress: { total: 2, complete: done.length, remaining: 2 - done.length },
    tasks: ["1.1", "1.2"].map((id) => ({ id, description: `Task ${id}`, done: done.includes(id) })),
    instruction: "Apply the next task",
    skill: "Generated apply guidance",
    contextFiles: [],
    fingerprint: done.join(","),
  };
}
const evidence: DecisionEvidence = {
  change: "test-change",
  remaining: 2,
  completed: 0,
  summary: "A supported next task remains",
  recentTools: [],
};
const good: DecisionProvider = async () => ({ choice: "continue", confidence: 0.95 });

test("Auto allows explicit starts by default; strict config rejects unknown keys, selectors and unbounded limits", () => {
  expect(parseAutoConfig({}).enabled).toBe(true);
  expect(parseAutoConfig({ enabled: false }).enabled).toBe(false);
  for (const invalid of [
    { enabled: "true" },
    { unknown: 1 },
    { maxSteps: 10001 },
    { maxToolCalls: 0 },
    { minConfidence: NaN },
    { minConfidence: 0.1 },
    { fallback: "always" },
    { rasenExecutable: "" },
  ]) {
    expect(() => parseAutoConfig(invalid)).toThrow();
  }
  expect(parseAutoConfig({ enabled: true, fallback: "stop", maxFallbacks: 0 }).enabled).toBe(true);
});

test("hard turn and tool caps count attempts; repeated delivery cannot reset budget", () => {
  const run = new AutoRun(parseAutoConfig({ maxSteps: 2, maxToolCalls: 2 }), snapshot());
  expect(run.toolCall("a")).toBe(true);
  expect(run.toolCall("a")).toBe(true);
  expect(run.toolCall("b")).toBe(true);
  expect(run.toolCalls).toBe(2);
  expect(run.continue()).toBe(true);
  expect(run.continue()).toBe(false);
  expect(run.status).toBe("budget_exhausted");
  expect(run.toolCall("c")).toBe(false);
  const tools = new AutoRun(parseAutoConfig({ maxToolCalls: 1 }), snapshot());
  expect(tools.toolCall("1")).toBe(true);
  expect(tools.toolCall("2")).toBe(false);
  expect(tools.status).toBe("budget_exhausted");
});

test("deadline and cancellation remain terminal despite high-confidence decisions", async () => {
  let now = 0;
  const run = new AutoRun(parseAutoConfig({ maxDurationMs: 1000 }), snapshot(), () => now);
  now = 1000;
  expect(await run.decide(evidence, good, good, signal())).toBeUndefined();
  expect(run.status).toBe("budget_exhausted");
  expect(run.decisions).toBe(0);
  run.stop("completed", "Model says done");
  expect(run.status).toBe("budget_exhausted");
  const cancelled = new AutoRun(parseAutoConfig({}), snapshot());
  const abort = new AbortController();
  abort.abort();
  expect(await cancelled.decide(evidence, good, good, abort.signal)).toBeUndefined();
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.fallbacks).toBe(0);
  expect(cancelled.statusView().decisionDiagnostics.attempts[0]).toMatchObject({
    provider: "jev",
    outcome: "error",
    errorCode: "DECISION_CANCELLED",
  });
});

test("stall budget uses new completed task IDs, not instruction/fingerprint churn or checkbox toggling", () => {
  const run = new AutoRun(parseAutoConfig({ maxStalls: 2 }), snapshot());
  run.observe({ ...snapshot(), fingerprint: "changed", instruction: "different" });
  expect(run.stalls).toBe(1);
  run.observe(snapshot(["1.1"]));
  expect(run.stalls).toBe(0);
  run.observe(snapshot());
  run.observe(snapshot(["1.1"]));
  expect(run.continue()).toBe(false);
  expect(run.status).toBe("stalled");
});

test("changing scope or removing tasks requires a new user start; all_done never self-approves", () => {
  const run = new AutoRun(parseAutoConfig({}), snapshot());
  const changed = snapshot();
  changed.tasks.pop();
  run.observe(changed);
  expect(run.status).toBe("needs_user");
  const renamed = new AutoRun(parseAutoConfig({}), snapshot());
  const changedText = snapshot();
  changedText.tasks[0].description = "Different objective";
  renamed.observe(changedText);
  expect(renamed.status).toBe("needs_user");
  for (const changedIdentity of [{ root: "/other" }, { schema: "other-schema" }]) {
    const identity = new AutoRun(parseAutoConfig({}), snapshot());
    identity.observe({ ...snapshot(), ...changedIdentity });
    expect(identity.status).toBe("needs_user");
  }
  const done = new AutoRun(parseAutoConfig({}), snapshot());
  done.observe(snapshot(["1.1", "1.2"]));
  expect(done.status).toBe("running");
  expect(done.statusView().completionVerified).toBe(false);
});

test("uncertain primary uses one bounded fallback, then uncertainty stops explicitly", async () => {
  const run = new AutoRun(parseAutoConfig({ maxFallbacks: 1 }), snapshot());
  const weak: DecisionProvider = async () => ({ choice: "continue", confidence: 0.2 });
  expect((await run.decide(evidence, weak, good, signal()))?.choice).toBe("continue");
  expect(run.fallbacks).toBe(1);
  expect(await run.decide(evidence, weak, good, signal())).toBeUndefined();
  expect(run.status).toBe("uncertain");
  expect(run.decisions).toBe(2);
  expect(run.fallbacks).toBe(1);
});

test("provider errors, unknown decisions, timeout, and disabled fallback fail closed", async () => {
  for (const primary of [
    async () => {
      throw new Error("private provider details");
    },
    async () => ({ choice: "approve", confidence: 1 }),
    async () => ({ choice: "continue", confidence: Infinity }),
    async () => ({ choice: "uncertain", confidence: 1 }),
    () => new Promise(() => {}),
  ]) {
    const run = new AutoRun(
      parseAutoConfig({ fallback: "stop", decisionTimeoutMs: 100 }),
      snapshot(),
    );
    expect(await run.decide(evidence, primary as DecisionProvider, good, signal())).toBeUndefined();
    expect(run.status).toBe("uncertain");
    expect(run.reason).not.toContain("private");
    expect(run.fallbacks).toBe(0);
  }
});

test("needs_user cannot authorize a tool or turn; concurrent decisions stop", async () => {
  const run = new AutoRun(parseAutoConfig({}), snapshot());
  await run.decide(evidence, async () => ({ choice: "needs_user", confidence: 1 }), good, signal());
  expect(run.status).toBe("needs_user");
  expect(run.continue()).toBe(false);
  expect(run.toolCall("mutation")).toBe(false);
  const concurrent = new AutoRun(parseAutoConfig({ decisionTimeoutMs: 100 }), snapshot());
  const pending = concurrent.decide(evidence, () => new Promise(() => {}), undefined, signal());
  expect(await concurrent.decide(evidence, good, good, signal())).toBeUndefined();
  expect(concurrent.status).toBe("blocked");
  await pending;
  expect(concurrent.status).toBe("blocked");
});

test("a provider's synchronous caller abort cannot escape the core deadline", async () => {
  const controller = new AbortController();
  const run = new AutoRun(parseAutoConfig({ decisionTimeoutMs: 100 }), snapshot());
  const provider: DecisionProvider = () => {
    controller.abort();
    return new Promise(() => {});
  };
  expect(await run.decide(evidence, provider, undefined, controller.signal)).toBeUndefined();
  expect(run.status).toBe("cancelled");
});

test("default supervision permits more than eighty tools and eight boundaries without count caps", () => {
  const run = new AutoRun(parseAutoConfig({}), snapshot());
  for (let i = 0; i < 125; i++) expect(run.toolCall(`read-${i}`)).toBe(true);
  for (let i = 0; i < 12; i++) expect(run.continue()).toBe(true);
  expect(run.status).toBe("running");
  expect(run.config.maxDurationMs).toBe(4 * 60 * 60 * 1000);
  expect(run.config.noOutputTimeoutMs).toBe(10 * 60 * 1000);
  expect(run.statusView().toolCalls).toBe("125");
});

test("finite output watchdog resets only with activity; absolute deadline never resets", () => {
  let now = 0;
  const run = new AutoRun(
    parseAutoConfig({ maxDurationMs: 4000, noOutputTimeoutMs: 1000 }),
    snapshot(),
    () => now,
  );
  now = 900;
  run.activity();
  now = 1500;
  expect(run.checkTime()).toBe(true);
  now = 1900;
  expect(run.checkTime()).toBe(false);
  expect(run.status).toBe("stalled");
  const absolute = new AutoRun(
    parseAutoConfig({ maxDurationMs: 2000, noOutputTimeoutMs: 1000 }),
    snapshot(),
    () => now,
  );
  now = 2800;
  absolute.activity();
  now = 3700;
  absolute.activity();
  now = 3900;
  expect(absolute.checkTime()).toBe(false);
  expect(absolute.status).toBe("budget_exhausted");
});

test("terminal reconciliation refreshes facts without resuming, spending counters or approving completion", () => {
  let now = 0;
  const run = new AutoRun(parseAutoConfig({ maxToolCalls: 1 }), snapshot(), () => now);
  run.toolCall("one");
  run.toolCall("two");
  expect(run.status).toBe("budget_exhausted");
  now = 2000;
  expect(run.reconcile(snapshot(["1.1"]))).toBe(true);
  expect(run.statusView()).toMatchObject({
    status: "budget_exhausted",
    progress: { complete: 1 },
    completionVerified: false,
    toolCalls: "1/1",
    observation: { at: 2000, error: null },
  });
  const done = new AutoRun(parseAutoConfig({}), snapshot(["1.1", "1.2"]));
  done.stop("completed", "Verified");
  expect(done.statusView().completionVerified).toBe(true);
  done.reconcile(snapshot(["1.1"]));
  expect(done.status).toBe("completed");
  expect(done.statusView().completionVerified).toBe(false);
});

test("null legacy limits are explicit and supervision caps remain finite", () => {
  expect(
    parseAutoConfig({ maxSteps: null, maxToolCalls: null, maxStalls: null }).maxToolCalls,
  ).toBeNull();
  for (const invalid of [
    { maxDurationMs: 43200001 },
    { noOutputTimeoutMs: 1800001 },
    { noOutputTimeoutMs: null },
    { maxSteps: -1 },
  ])
    expect(() => parseAutoConfig(invalid)).toThrow();
});

test("decision diagnostics preserve primary and fallback provenance without secrets", async () => {
  const run = new AutoRun(parseAutoConfig({}), snapshot());
  await run.decide(
    evidence,
    async () => {
      throw new JevError("JEV_MISSING_API_KEY");
    },
    async () => {
      throw new Error("secret credential and response body");
    },
    signal(),
  );
  expect(run.status).toBe("uncertain");
  expect(run.statusView().decisionDiagnostics).toMatchObject({
    minConfidence: 0.8,
    attempts: [
      { provider: "jev", outcome: "error", errorCode: "JEV_MISSING_API_KEY" },
      { provider: "architect", outcome: "error", errorCode: "PROVIDER_ERROR" },
    ],
  });
  expect(JSON.stringify(run.statusView())).not.toContain("secret");
  expect(run.reason).toContain("JEV_MISSING_API_KEY");
  expect(run.fallbacks).toBe(1);
  expect(run.decisions).toBe(1);
});

test("diagnostics distinguish timeout, low confidence, uncertainty and missing user input", async () => {
  for (const [provider, outcome, extra] of [
    [() => new Promise(() => {}), "error", { errorCode: "DECISION_TIMEOUT" }],
    [
      async () => ({ choice: "continue", confidence: 0.79 }),
      "low_confidence",
      { confidence: 0.79 },
    ],
    [async () => ({ choice: "uncertain", confidence: 0.99 }), "uncertain", { confidence: 0.99 }],
    [
      async () => ({ choice: "needs_user", confidence: 0.99 }),
      "accepted",
      { choice: "needs_user" },
    ],
    [
      async () => {
        throw new DecisionFailure("FALLBACK_INVALID_RESPONSE");
      },
      "error",
      { errorCode: "FALLBACK_INVALID_RESPONSE" },
    ],
  ] as const) {
    const run = new AutoRun(
      parseAutoConfig({ fallback: "stop", decisionTimeoutMs: 100 }),
      snapshot(),
    );
    await run.decide(evidence, provider as DecisionProvider, undefined, signal());
    expect(run.statusView().decisionDiagnostics.attempts[0]).toMatchObject({ outcome, ...extra });
    expect(run.status).toBe(
      "choice" in extra && extra.choice === "needs_user" ? "needs_user" : "uncertain",
    );
  }
});

test("a successful fallback remains visible and does not bypass minimum confidence", async () => {
  const run = new AutoRun(parseAutoConfig({}), snapshot());
  const result = await run.decide(
    evidence,
    async () => {
      throw new JevError("JEV_INVALID_RESPONSE");
    },
    good,
    signal(),
  );
  expect(result?.choice).toBe("continue");
  expect(run.statusView().decisionDiagnostics.attempts).toMatchObject([
    { provider: "jev", outcome: "error", errorCode: "JEV_INVALID_RESPONSE" },
    { provider: "architect", outcome: "accepted", confidence: 0.95 },
  ]);
});

test("decision status snapshots are defensive and the next decision replaces provenance", async () => {
  const run = new AutoRun(parseAutoConfig({}), snapshot());
  await run.decide(
    evidence,
    async () => {
      throw new JevError("JEV_HTTP_ERROR");
    },
    good,
    signal(),
  );
  run.statusView().decisionDiagnostics.attempts[0].errorCode = "mutated";
  expect(run.statusView().decisionDiagnostics.attempts[0].errorCode).toBe("JEV_HTTP_ERROR");
  await run.decide(evidence, good, good, signal());
  expect(run.statusView().decisionDiagnostics.attempts).toHaveLength(1);
  expect(run.statusView().decisionDiagnostics.attempts[0]).toMatchObject({
    provider: "jev",
    outcome: "accepted",
  });
});

import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import { Orchestrator, parseVerdict, routeAgent, type Verdict } from "../src/core.ts";

const approved: Verdict = {
  decision: "approve",
  summary: "Evidence supports the checkpoint",
  issues: [],
};
function controller() {
  const s = new Orchestrator(parseConfig({}));
  s.begin("Implement the requested fix");
  return s;
}

describe("bounded review evidence", () => {
  test("the reviewer receives the latest PR result after long context and older logs", async () => {
    const s = new Orchestrator(parseConfig({}));
    s.begin("request ".repeat(750));
    for (let i = 0; i < 6; i++) {
      s.observe(`old-${i}`, "read", { path: `old-${i}.ts` }, "o".repeat(2600), false);
    }
    s.observe("latest", "bash", { command: "gh pr view 5" }, "LATEST_PR_CONFIRMED", false);
    let received = "";
    await s.review("completion", "summary ".repeat(1000), async ({ evidence }) => {
      received = evidence;
      return approved;
    });

    expect(received.length).toBeLessThanOrEqual(s.config.maxEvidenceChars);
    const snapshot = JSON.parse(received);
    expect(snapshot.phase).toBe("completion");
    expect(snapshot.pendingRecovery).toBe(false);
    const records = snapshot.recentToolEvidence.map((entry: string) => JSON.parse(entry));
    expect(records.at(-1)).toEqual({
      tool: "bash",
      input: { command: "gh pr view 5" },
      output: "LATEST_PR_CONFIRMED",
      isError: false,
    });
  });

  test("oversized input cannot evict its own result or the entire evidence ring", async () => {
    const s = controller();
    s.observe("earlier", "bash", { command: "bun test" }, "EARLIER_TESTS_PASSED", false);
    s.observe(
      "latest",
      "write",
      { path: "large.txt", content: "huge input ".repeat(20000) },
      "LATEST_WRITE_SUCCEEDED",
      false,
    );
    expect(s.evidence.join("\n").length).toBeLessThanOrEqual(s.config.maxEvidenceChars);
    expect(s.evidence.map((entry) => JSON.parse(entry).output)).toEqual([
      "EARLIER_TESTS_PASSED",
      "LATEST_WRITE_SUCCEEDED",
    ]);
    let received = "";
    await s.review("completion", "Check both actual tool results", async ({ evidence }) => {
      received = evidence;
      return approved;
    });

    const records = JSON.parse(received).recentToolEvidence.map((entry: string) =>
      JSON.parse(entry),
    );
    expect(records.map((record: { output: string }) => record.output)).toEqual([
      "EARLIER_TESTS_PASSED",
      "LATEST_WRITE_SUCCEEDED",
    ]);
    expect(records[1].input).not.toEqual({
      path: "large.txt",
      content: "huge input ".repeat(20000),
    });
    expect(JSON.stringify(records[1].input)).toMatch(/omitted|truncated/i);
    expect(received.length).toBeLessThanOrEqual(s.config.maxEvidenceChars);
  });

  test("older whole records are omitted explicitly while retained records stay chronological", async () => {
    const s = new Orchestrator(parseConfig({ maxEvidenceChars: 1000 }));
    s.begin("Check recent tool results");
    for (let i = 0; i < 30; i++) {
      s.observe(`read-${i}`, "read", { index: i }, `result-${i}\n${"log ".repeat(100)}`, false);
    }
    let received = "";
    await s.review("completion", "Review the latest result", async ({ evidence }) => {
      received = evidence;
      return approved;
    });

    const snapshot = JSON.parse(received);
    const records = snapshot.recentToolEvidence.map((entry: string) => JSON.parse(entry));
    const indexes: number[] = records.map(
      (record: { input: { index: number } }) => record.input.index,
    );
    expect(indexes.at(-1)).toBe(29);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(snapshot.omittedToolEvidence).toBe(30 - records.length);
    expect(snapshot.omittedToolEvidence).toBeGreaterThan(0);
    expect(received.length).toBeLessThanOrEqual(s.config.maxEvidenceChars);
  });

  test("long tool output retains its opening and terminal status with explicit loss", async () => {
    const s = controller();
    const output = `TEST_SUITE_STARTED\n${"intermediate log\n".repeat(2000)}TESTS_PASSED_EXIT_0`;
    s.observe("tests", "bash", { command: "bun test" }, output, false);
    let received = "";
    await s.review("completion", "Verify the observed test exit", async ({ evidence }) => {
      received = evidence;
      return approved;
    });

    const [record] = JSON.parse(received).recentToolEvidence.map((entry: string) =>
      JSON.parse(entry),
    );
    expect(record.input).toEqual({ command: "bun test" });
    expect(record.output.startsWith("TEST_SUITE_STARTED\n")).toBe(true);
    expect(record.output.endsWith("TESTS_PASSED_EXIT_0")).toBe(true);
    expect(record.output).toMatch(/omitted|truncated/i);
    expect(record.output.length).toBeLessThan(output.length);
    expect(record.isError).toBe(false);
  });

  test.each([
    1000, 24000, 100000,
  ])("budget %p bounds escaped JSON while preserving phase, recovery and latest output", async (maxEvidenceChars) => {
    const s = new Orchestrator(parseConfig({ maxEvidenceChars }));
    const noise = '"\\\n\t\u0000🧪'.repeat(20000);
    s.begin(`REQUEST_START ${noise} REQUEST_END`);
    s.setPendingPlan([
      `STEP_0 ${noise}`,
      ...Array.from({ length: 100 }, (_, i) => `STEP_${i + 1}`),
    ]);
    s.observe("failure-1", "bash", {}, "same failure", true);
    s.observe("failure-2", "bash", {}, "same failure", true);
    s.observe(
      "latest",
      "bash",
      { command: "bun test" },
      `LOG_START\n${noise}\nLATEST_TEST_EXIT_0`,
      false,
    );
    let received = "";
    await s.review("recovery", `SUMMARY_START ${noise} SUMMARY_END`, async ({ evidence }) => {
      received = evidence;
      return approved;
    });

    expect(received.length).toBeLessThanOrEqual(maxEvidenceChars);
    expect(s.evidence.join("\n").length).toBeLessThanOrEqual(maxEvidenceChars);
    const snapshot = JSON.parse(received);
    expect(snapshot.phase).toBe("recovery");
    expect(snapshot.pendingRecovery).toBe(true);
    expect(snapshot.request).toContain("REQUEST_START");
    expect(snapshot.summary).toContain("SUMMARY_START");
    expect(snapshot.request).toMatch(/omitted|truncated/i);
    expect(snapshot.summary).toMatch(/omitted|truncated/i);
    expect(snapshot.pendingPlan.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot.pendingPlan)).toMatch(/omitted|truncated/i);
    const records = snapshot.recentToolEvidence.map((entry: string) => JSON.parse(entry));
    expect(records.at(-1).input).toEqual({ command: "bun test" });
    expect(records.at(-1).output.startsWith("LOG_START\n")).toBe(true);
    expect(records.at(-1).output.endsWith("\nLATEST_TEST_EXIT_0")).toBe(true);
    expect(records.at(-1).output).toMatch(/omitted|truncated/i);
    expect(records.at(-1).isError).toBe(false);
  });

  test("short context, plan and structured input reach the reviewer unchanged", async () => {
    const s = controller();
    const steps = ["inspect", "fix", "verify"];
    const input = { command: "printf", args: ['"\\\n\u0000🧪'], metadata: { ok: true } };
    s.setPendingPlan(steps);
    s.observe("short", "bash", input, "passed\n", false);
    let received = "";
    await s.review("plan", "Review these exact steps", async ({ evidence }) => {
      received = evidence;
      return approved;
    });

    const snapshot = JSON.parse(received);
    expect(snapshot.request).toBe("Implement the requested fix");
    expect(snapshot.summary).toBe("Review these exact steps");
    expect(snapshot.pendingPlan).toEqual(steps);
    expect(snapshot.pendingRecovery).toBe(false);
    expect(snapshot.recentToolEvidence).toHaveLength(1);
    expect(JSON.parse(snapshot.recentToolEvidence[0])).toEqual({
      tool: "bash",
      input,
      output: "passed\n",
      isError: false,
    });
  });
});

describe("role routing and configuration", () => {
  test("custom role names route only package workers, preserving explicit other agents", () => {
    const config = parseConfig({ roles: { implementation: "builder", research: "fast" } });
    expect(routeAgent("omp-worker", config)).toBe("@builder");
    expect(routeAgent("omp-explorer", config)).toBe("@fast");
    expect(routeAgent("m1", config)).toBeUndefined();
    expect(routeAgent("reviewer", config)).toBeUndefined();
  });
  test.each([100, 35000, 120000])("explicit review timeout %p is accepted", (reviewTimeoutMs) => {
    expect(parseConfig({ reviewTimeoutMs }).reviewTimeoutMs).toBe(reviewTimeoutMs);
  });
  test("model selectors and unknown options fail instead of forming a second model map", () => {
    for (const invalid of [
      { roles: { architect: "openai/gpt-5:high" } },
      { roles: { research: "default" } },
      { retry: 5 },
      { reviewTimeoutMs: 99 },
      { reviewTimeoutMs: 120001 },
      { reviewTimeoutMs: 100.5 },
      { repeatedErrorThreshold: 1 },
      { reviews: { min: 3, max: 2 } },
      { reviews: { min: 0, max: 2 } },
    ])
      expect(() => parseConfig(invalid)).toThrow();
  });
});

describe("checkpoints", () => {
  test("substantial todo is held until its exact plan is approved, and changed plans recheck", async () => {
    const s = controller();
    const plan = { op: "init", items: ["inspect", "implement", "test"] };
    expect(s.gate("todo", plan)).toContain("Substantial plan");
    await s.review("plan", "Review the staged plan", async () => approved);
    expect(s.gate("todo", plan)).toBeUndefined();
    expect(s.gate("todo", { ...plan, items: ["inspect", "rewrite", "test"] })).toBeDefined();
    expect(s.gate("todo", { op: "view" })).toBeUndefined();
  });
  test("completion review is deduplicated and invalidated by new evidence, edits, and failures", async () => {
    const s = controller();
    let calls = 0;
    const reviewer = async () => {
      calls++;
      return approved;
    };
    await s.review("completion", "Tests passed", reviewer);
    await s.review("completion", "Tests passed", reviewer);
    expect(calls).toBe(1);
    expect(s.completionApproved).toBe(true);
    s.observe("read-1", "read", { path: "a" }, "file", false);
    expect(s.completionApproved).toBe(false);
    s.observe("edit-1", "edit", { path: "a" }, "ok", false);
    expect(s.completionApproved).toBe(false);
    await s.review("completion", "Tests passed again", reviewer);
    expect(calls).toBe(2);
    expect(s.completionApproved).toBe(true);
    s.observe("bad-read", "read", { path: "missing" }, "missing", true);
    expect(s.completionApproved).toBe(false);
  });
  test("same-tool same-error streak escalates once per result and recovery clears only on approval", async () => {
    const s = controller();
    expect(s.observe("1", "edit", {}, "No matching text", true)).toBe(false);
    expect(s.observe("1", "edit", {}, "No matching text", true)).toBe(false);
    expect(s.observe("2", "edit", {}, "No matching text", true)).toBe(true);
    expect(s.gate("bash", { command: "retry" })).toBeDefined();
    expect(s.gate("read", { path: "file" })).toBeUndefined();
    await s.review("recovery", "Try permission bypass", async () => ({
      decision: "blocked",
      summary: "Needs user permission",
      issues: ["Access denied"],
    }));
    expect(s.pendingRecovery).toBe(true);
    await s.review("recovery", "Ask user for authorized access", async () => approved);
    expect(s.pendingRecovery).toBe(false);
    expect(s.gate("bash", {})).toBeUndefined();
  });
  test("different errors and successful same-tool results break the streak", () => {
    const s = controller();
    s.observe("1", "read", {}, "missing a", true);
    s.observe("2", "read", {}, "missing b", true);
    expect(s.pendingRecovery).toBe(false);
    s.observe("3", "read", {}, "ok", false);
    expect(s.observe("4", "read", {}, "missing b", true)).toBe(false);
  });
  test("failed requests never turn into approvals and budget ends retry loops", async () => {
    const s = new Orchestrator(parseConfig({ reviews: { min: 1, max: 1 } }));
    s.begin("work");
    const first = await s.review("completion", "done", async () => {
      throw new Error("provider down");
    });
    expect(first.decision).toBe("blocked");
    expect(s.completionApproved).toBe(false);
    let called = false;
    const second = await s.review("completion", "try again", async () => {
      called = true;
      return approved;
    });
    expect(second.summary).toContain("budget");
    expect(called).toBe(false);
  });
  test("aborts and timeouts finish blocked and notify the independent request signal", async () => {
    const s = new Orchestrator(parseConfig({ reviewTimeoutMs: 100 }));
    s.begin("work");
    const c = new AbortController();
    let aborted = false;
    const pending = s.review(
      "completion",
      "done",
      async (_, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<Verdict>(() => {});
      },
      c.signal,
    );
    c.abort();
    expect((await pending).decision).toBe("blocked");
    expect(aborted).toBe(true);
    expect(
      (await s.review("completion", "retry", async () => new Promise<Verdict>(() => {}))).summary,
    ).toContain("timed out");
  });
  test("evidence changing during a review prevents a stale approval", async () => {
    const s = controller();
    const deferred = Promise.withResolvers<Verdict>();
    const pending = s.review("completion", "done", async () => deferred.promise);
    s.observe("later", "task", {}, "worker edited a file", false);
    deferred.resolve(approved);
    expect((await pending).summary).toContain("stale");
    expect(s.completionApproved).toBe(false);
  });
  test("malformed or contradictory provider verdicts fail closed", () => {
    for (const text of [
      "done",
      '{"decision":"approve","summary":"ok","issues":["tests fail"]}',
      '{"decision":"approve"}',
    ])
      expect(() => parseVerdict(text)).toThrow();
    expect(
      parseVerdict(
        '```json\n{"decision":"revise","summary":"Missing evidence","issues":["Run tests"]}\n```',
      ).decision,
    ).toBe("revise");
  });
});

test("an unapproved pending plan blocks execution and a later rejected completion revokes approval", async () => {
  const s = controller();
  s.gate("todo", { op: "init", items: ["inspect", "implement", "test"] });
  await s.review("plan", "plan", async () => ({
    decision: "revise",
    summary: "Test the risk",
    issues: ["Missing coverage"],
  }));
  expect(s.gate("write", { path: "a" })).toContain("not approved");
  await s.review("plan", "fixed plan", async () => approved);
  await s.review("completion", "all done", async () => approved);
  expect(s.completionApproved).toBe(true);
  await s.review("completion", "actually missing a test", async () => ({
    decision: "blocked",
    summary: "Run tests",
    issues: ["Unverified"],
  }));
  expect(s.completionApproved).toBe(false);
});
test("native bash timing footers do not hide repeated command errors", () => {
  const s = controller();
  s.observe("a", "bash", { command: "test" }, "Error: missing file\nWall time: 0.12 seconds", true);
  expect(
    s.observe(
      "b",
      "bash",
      { command: "test" },
      "Error: missing file\nWall time: 1.45 seconds",
      true,
    ),
  ).toBe(true);
});
test("min counts real review-fix rounds, phases share bounds but not allowances", async () => {
  const s = new Orchestrator(parseConfig({ reviews: { min: 2, max: 2 } }));
  s.begin("work");
  await s.review("plan", "plan", async () => approved);
  await s.review("completion", "first", async () => ({
    decision: "revise",
    summary: "Fix this",
    issues: ["Failure"],
  }));
  s.observe("edit", "edit", {}, "fixed", false);
  await s.review("completion", "fixed and verified", async () => approved);
  expect(s.completionApproved).toBe(true);
  expect(s.reviewCount).toBe(3);
  expect(s.phaseReviews.completion).toBe(2);
});
test("min>1 uses an independent current-state review and cannot count a cached approval", async () => {
  const s = new Orchestrator(parseConfig({ reviews: { min: 2, max: 2 } }));
  s.begin("work");
  let calls = 0;
  const reviewer = async () => {
    calls++;
    return approved;
  };
  expect((await s.review("completion", "done", reviewer)).decision).toBe("revise");
  expect(s.completionApproved).toBe(false);
  await s.review("completion", "done", reviewer);
  expect(s.completionApproved).toBe(true);
  expect(calls).toBe(2);
  await s.review("completion", "done", reviewer);
  expect(calls).toBe(2);
});
test("an already aborted replacement checkpoint cannot preserve prior approval", async () => {
  const s = controller();
  await s.review("completion", "done", async () => approved);
  const c = new AbortController();
  c.abort();
  await s.review("completion", "changed claim", async () => approved, c.signal);
  expect(s.completionApproved).toBe(false);
});
test("an in-flight plan review cannot approve replacement steps", async () => {
  const s = controller();
  s.setPendingPlan(["A", "B", "C"]);
  const d = Promise.withResolvers<Verdict>();
  const pending = s.review("plan", "first plan", async () => d.promise);
  s.setPendingPlan(["D", "E", "F"]);
  d.resolve(approved);
  expect((await pending).summary).toContain("stale");
  expect(s.gate("write", {})).toContain("not approved");
});

test("a newer rejected plan review revokes prior plan and completion approval", async () => {
  const s = controller();
  s.setPendingPlan(["inspect", "fix", "test"]);
  await s.review("plan", "first", async () => approved);
  expect(s.gate("bash", {})).toBeUndefined();
  await s.review("completion", "done", async () => approved);
  await s.review("plan", "new risk discovered", async () => ({
    decision: "revise",
    summary: "Risk unresolved",
    issues: ["Fix design"],
  }));
  expect(s.gate("bash", {})).toContain("not approved");
  expect(s.completionApproved).toBe(false);
});

test("a cancelled plan re-review cannot reuse its revoked cached approval", async () => {
  const s = controller();
  s.setPendingPlan(["inspect", "fix", "test"]);
  let calls = 0;
  const reviewer = async () => {
    calls++;
    return approved;
  };
  await s.review("plan", "plan", reviewer);
  const c = new AbortController();
  c.abort();
  await s.review("plan", "plan", reviewer, c.signal);
  expect(s.gate("bash", {})).toBeDefined();
  await s.review("plan", "plan", reviewer);
  expect(calls).toBe(2);
  expect(s.gate("bash", {})).toBeUndefined();
});

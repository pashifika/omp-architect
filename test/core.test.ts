import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config.ts";
import {
  digest,
  Orchestrator,
  parseVerdict,
  routeAgent,
  type ReviewMaterial,
  type Verdict,
} from "../src/core.ts";

const approved: Verdict = {
  decision: "approve",
  summary: "Evidence supports the checkpoint",
  issues: [],
};
function material(content: string): ReviewMaterial {
  return {
    ref: `artifact://review/${digest(content)}`,
    sha256: digest(content),
    bytes: Buffer.byteLength(content, "utf8"),
    content,
    source: "authored",
  };
}
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
    await s.review("completion", material("summary ".repeat(1000)), async ({ evidence }) => {
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
      toolCallId: "latest",
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
    await s.review(
      "completion",
      material("Check both actual tool results"),
      async ({ evidence }) => {
        received = evidence;
        return approved;
      },
    );

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
    await s.review("completion", material("Review the latest result"), async ({ evidence }) => {
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
    await s.review(
      "completion",
      material("Verify the observed test exit"),
      async ({ evidence }) => {
        received = evidence;
        return approved;
      },
    );

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
    const received = s.snapshot("recovery");

    expect(received.length).toBeLessThanOrEqual(maxEvidenceChars);
    expect(s.evidence.join("\n").length).toBeLessThanOrEqual(maxEvidenceChars);
    const snapshot = JSON.parse(received);
    expect(snapshot.phase).toBe("recovery");
    expect(snapshot.pendingRecovery).toBe(true);
    expect(snapshot.request).toContain("REQUEST_START");
    expect(snapshot).not.toHaveProperty("summary");
    expect(snapshot.request).toMatch(/omitted|truncated/i);
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
    s.setPendingPlan([...steps]);
    s.observe("short", "bash", input, "passed\n", false);
    let received = "";
    await s.review("plan", material("Review these exact steps"), async ({ evidence }) => {
      received = evidence;
      return approved;
    });

    const snapshot = JSON.parse(received);
    expect(snapshot.request).toBe("Implement the requested fix");
    expect(snapshot).not.toHaveProperty("summary");
    expect(snapshot.pendingPlan).toEqual(steps);
    expect(snapshot.pendingRecovery).toBe(false);
    expect(snapshot.recentToolEvidence).toHaveLength(1);
    expect(JSON.parse(snapshot.recentToolEvidence[0])).toEqual({
      tool: "bash",
      toolCallId: "short",
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
    await s.review("plan", material("Review the staged plan"), async () => approved);
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
    await s.review("completion", material("Tests passed"), reviewer);
    await s.review("completion", material("Tests passed"), reviewer);
    expect(calls).toBe(1);
    expect(s.completionApproved).toBe(true);
    s.observe("read-1", "read", { path: "a" }, "file", false);
    expect(s.completionApproved).toBe(false);
    s.observe("edit-1", "edit", { path: "a" }, "ok", false);
    expect(s.completionApproved).toBe(false);
    await s.review("completion", material("Tests passed again"), reviewer);
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
    await s.review("recovery", material("Try permission bypass"), async () => ({
      decision: "blocked",
      summary: "Needs user permission",
      issues: ["Access denied"],
    }));
    expect(s.pendingRecovery).toBe(true);
    await s.review("recovery", material("Ask user for authorized access"), async () => approved);
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
    const first = await s.review("completion", material("done"), async () => {
      throw new Error("provider down");
    });
    expect(first.decision).toBe("blocked");
    expect(s.completionApproved).toBe(false);
    let called = false;
    const second = await s.review("completion", material("try again"), async () => {
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
      material("done"),
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
      (await s.review("completion", material("retry"), async () => new Promise<Verdict>(() => {})))
        .summary,
    ).toContain("timed out");
  });
  test("evidence changing during a review prevents a stale approval", async () => {
    const s = controller();
    const deferred = Promise.withResolvers<Verdict>();
    const pending = s.review("completion", material("done"), async () => deferred.promise);
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
  await s.review("plan", material("plan"), async () => ({
    decision: "revise",
    summary: "Test the risk",
    issues: ["Missing coverage"],
  }));
  expect(s.gate("write", { path: "a" })).toContain("not approved");
  await s.review("plan", material("fixed plan"), async () => approved);
  await s.review("completion", material("all done"), async () => approved);
  expect(s.completionApproved).toBe(true);
  await s.review("completion", material("actually missing a test"), async () => ({
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
  s.setPendingPlan(["inspect", "fix", "test"]);
  await s.review("plan", material("plan"), async () => approved);
  await s.review("plan", material("independent plan review"), async () => approved);
  await s.review("completion", material("first"), async () => ({
    decision: "revise",
    summary: "Fix this",
    issues: ["Failure"],
  }));
  s.observe("edit", "edit", {}, "fixed", false);
  await s.review("completion", material("fixed and verified"), async () => approved);
  expect(s.completionApproved).toBe(true);
  expect(s.reviewCount).toBe(4);
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
  expect((await s.review("completion", material("done"), reviewer)).decision).toBe("revise");
  expect(s.completionApproved).toBe(false);
  await s.review("completion", material("done"), reviewer);
  expect(s.completionApproved).toBe(true);
  expect(calls).toBe(2);
  await s.review("completion", material("done"), reviewer);
  expect(calls).toBe(2);
});
test("an already aborted replacement checkpoint cannot preserve prior approval", async () => {
  const s = controller();
  await s.review("completion", material("done"), async () => approved);
  const c = new AbortController();
  c.abort();
  await s.review("completion", material("changed claim"), async () => approved, c.signal);
  expect(s.completionApproved).toBe(false);
});
test("an in-flight plan review cannot approve replacement steps", async () => {
  const s = controller();
  s.setPendingPlan(["A", "B", "C"]);
  const d = Promise.withResolvers<Verdict>();
  const pending = s.review("plan", material("first plan"), async () => d.promise);
  s.setPendingPlan(["D", "E", "F"]);
  d.resolve(approved);
  expect((await pending).summary).toContain("stale");
  expect(s.gate("write", {})).toContain("not approved");
});

test("a newer rejected plan review revokes prior plan and completion approval", async () => {
  const s = controller();
  s.setPendingPlan(["inspect", "fix", "test"]);
  await s.review("plan", material("first"), async () => approved);
  expect(s.gate("bash", {})).toBeUndefined();
  await s.review("completion", material("done"), async () => approved);
  await s.review("plan", material("new risk discovered"), async () => ({
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
  await s.review("plan", material("plan"), reviewer);
  const c = new AbortController();
  c.abort();
  await s.review("plan", material("plan"), reviewer, c.signal);
  expect(s.gate("bash", {})).toBeDefined();
  await s.review("plan", material("plan"), reviewer);
  expect(calls).toBe(2);
  expect(s.gate("bash", {})).toBeUndefined();
});

describe("canonical plan recovery and admission evidence", () => {
  const steps = ["Inspect context", "Implement fix", "Verify behavior"];
  test.each(
    [
      ["Inspect context.", "Implement fix", "Verify behavior"],
      ["Inspect context ", "Implement fix", "Verify behavior"],
      ["Verify behavior", "Implement fix", "Inspect context"],
      ["Inspect context", "Implement fix", "Verify behavior", "Document result"],
      ["Inspect context", "Verify behavior"],
    ].map((changed) => ({ changed })),
  )("changed todo remains exact-match gated and can restore approved steps: %p", async ({
    changed,
  }) => {
    const s = controller();
    s.setPendingPlan([...steps]);
    await s.review("plan", material("Review exact steps"), async () => approved);
    const canonical = s.planStatus().approved!;
    expect(canonical.steps).toEqual(steps);
    const denial = s.gate("todo", { op: "init", items: changed });
    expect(denial).toMatch(/Step (?:\d+|count) differs/);
    expect(denial).toContain(canonical.id);
    expect(s.planStatus().pending!.id).not.toBe(canonical.id);
    expect(s.planStatus().approved).toEqual(canonical);
    for (const tool of ["write", "bash", "graph_project_list", "report_issue"])
      expect(s.gate(tool, {})).toContain("not approved");
    expect(s.gate("todo", { op: "init", items: canonical.steps })).toBeUndefined();
    expect(s.planApproved).toBe(true);
    expect(s.gate("write", {})).toBeUndefined();
    expect(s.reviewCount).toBe(1);
  });
  test.each([
    { steps: [] },
    { steps: [" ", "\t"] },
  ])("empty or blank plans cannot consume or approve a review: %p", async ({ steps }) => {
    const s = controller();
    s.setPendingPlan([...steps]);
    let calls = 0;
    const verdict = await s.review("plan", material("Only prose"), async () => {
      calls++;
      return approved;
    });
    expect(verdict.decision).toBe("blocked");
    expect(verdict.summary).toContain("non-empty steps");
    expect(calls).toBe(0);
    expect(s.reviewCount).toBe(0);
    expect(s.approvedPlan).toBe("");
  });
  test.each([
    1000, 24000,
  ])("gate denials stay bounded and separate from executed error streaks (%p)", (maxEvidenceChars) => {
    const s = new Orchestrator(parseConfig({ maxEvidenceChars }));
    s.begin("Inspect failures");
    s.observe("error-1", "bash", {}, "same execution failure", true);
    for (let i = 0; i < 20; i++) {
      s.deny(
        `denied-${i}`,
        "bash",
        { command: '\"\\\n'.repeat(10000) },
        "DENIAL_START " + '\"\\\n'.repeat(10000) + " DENIAL_END",
      );
      s.deny(`denied-${i}`, "bash", {}, "duplicate");
      s.observe(`denied-${i}`, "bash", {}, "same execution failure", true);
    }
    expect(s.pendingRecovery).toBe(false);
    const snapshotText = s.snapshot("recovery");
    expect(snapshotText.length).toBeLessThanOrEqual(maxEvidenceChars);
    const snapshot = JSON.parse(snapshotText);
    const records = snapshot.recentToolEvidence.map((entry: string) => JSON.parse(entry));
    expect(records.at(-1)).toMatchObject({ kind: "gate_denial", executed: false, isError: true });
    expect(records.at(-1).output).toContain("DENIAL_START");
    expect(records.at(-1).output).toContain("DENIAL_END");
    expect(snapshot.omittedToolEvidence).toBe(21 - records.length);
    // Admission failures neither advance nor clear the actual execution-error streak.
    expect(s.observe("error-2", "bash", {}, "same execution failure", true)).toBe(true);
  });
  test("new denied evidence makes an in-flight review stale", async () => {
    const s = controller();
    s.setPendingPlan([...steps]);
    const deferred = Promise.withResolvers<Verdict>();
    const pending = s.review(
      "plan",
      material("Review before denied attempt"),
      async () => deferred.promise,
    );
    s.deny("blocked-write", "write", {}, s.gate("write", {})!);
    deferred.resolve(approved);
    expect((await pending).summary).toContain("stale");
    expect(s.planApproved).toBe(false);
    expect(s.terminalReason).toBeUndefined();
    await s.review("plan", material("Include the denied attempt"), async () => approved);
    expect(s.planApproved).toBe(true);
  });
});

describe("verified full review material", () => {
  test("body bypasses bounded context without losing its middle, and canonical steps remain exact", async () => {
    const s = new Orchestrator(parseConfig({ maxEvidenceChars: 1000 }));
    s.begin("Review complete artifacts");
    const steps = Array.from({ length: 30 }, (_, index) => `${index}: ${"step ".repeat(180)}`);
    s.setPendingPlan([...steps]);
    const content = `BODY_START\n${"section ".repeat(6000)}MIDDLE_REQUIREMENT\n${"section ".repeat(6000)}BODY_END`;
    const body = material(content);
    await s.review(
      "plan",
      body,
      async (request) => {
        expect(request.material).toEqual(body);
        expect(request.material.content).toBe(content);
        expect(request.canonicalPlan).toEqual(steps);
        expect(request.invocationId).toBe("full-body-call");
        expect(request.evidence.length).toBeLessThanOrEqual(1000);
        expect(request.evidence).not.toContain("BODY_START");
        expect(JSON.parse(request.evidence)).not.toHaveProperty("summary");
        expect(JSON.parse(request.evidence).pendingPlan).not.toEqual(steps);
        return approved;
      },
      undefined,
      "full-body-call",
    );
    expect(s.planApproved).toBe(true);
    expect(s.lastReview).toMatchObject({
      invocationId: "full-body-call",
      phase: "plan",
      status: "provider_verdict",
      charged: true,
      attempt: 1,
      revision: s.revision,
      artifactRef: body.ref,
      sha256: body.sha256,
      verdict: approved,
    });
    expect(s.lastReview).not.toHaveProperty("content");
  });

  test("cache includes full body digest and current evidence revision", async () => {
    const s = controller();
    let calls = 0;
    const reviewer = async () => {
      calls++;
      return approved;
    };
    const first = material(`${"prefix ".repeat(3000)}FIRST_MIDDLE${" suffix".repeat(3000)}`);
    const second = material(first.content.replace("FIRST_MIDDLE", "OTHER_MIDDLE"));
    await s.review("completion", first, reviewer, undefined, "first");
    await s.review(
      "completion",
      { ...first, ref: "artifact://other-ref" },
      reviewer,
      undefined,
      "cached",
    );
    expect(calls).toBe(1);
    expect(s.lastReview).toMatchObject({
      invocationId: "cached",
      status: "cache_hit",
      charged: false,
      attempt: 1,
      artifactRef: "artifact://other-ref",
    });
    await s.review("completion", second, reviewer);
    expect(calls).toBe(2);
    s.observe("new-result", "read", {}, "new evidence", false);
    await s.review("completion", second, reviewer);
    expect(calls).toBe(3);
    expect(s.reviewCount).toBe(3);
  });

  test.each([
    { name: "empty body", value: material("") },
    { name: "blank body", value: material(" \n\t") },
    { name: "missing reference", value: { ...material("body"), ref: "" } },
    { name: "wrong digest", value: { ...material("body"), sha256: "0".repeat(64) } },
    { name: "invalid digest", value: { ...material("body"), sha256: "not-a-digest" } },
    { name: "wrong byte count", value: { ...material("🧪"), bytes: 2 } },
    { name: "nonintegral byte count", value: { ...material("body"), bytes: 4.1 } },
    { name: "invalid source", value: { ...material("body"), source: "external" } },
    { name: "legacy string", value: "body" },
    { name: "missing material", value: null },
  ])("invalid $name is uncharged and revokes a previous approval", async ({ value }) => {
    const s = controller();
    await s.review("completion", material("approved body"), async () => approved);
    let called = false;
    const result = await s.review(
      "completion",
      value as ReviewMaterial,
      async () => {
        called = true;
        return approved;
      },
      undefined,
      "invalid-body",
    );
    expect(result.decision).toBe("blocked");
    expect(called).toBe(false);
    expect(s.completionApproved).toBe(false);
    expect(s.reviewCount).toBe(1);
    expect(s.lastReview).toMatchObject({
      invocationId: "invalid-body",
      status: "input_rejected",
      charged: false,
      attempt: 1,
      verdict: result,
    });
  });

  test("material byte limit counts UTF-8 exactly and permits the full boundary", async () => {
    const s = new Orchestrator(parseConfig({ maxReviewBytes: 1024 }));
    s.begin("Review unicode");
    let calls = 0;
    const reviewer = async () => {
      calls++;
      return approved;
    };
    const over = await s.review("completion", material("🧪".repeat(257)), reviewer);
    expect(over.decision).toBe("blocked");
    expect(s.reviewCount).toBe(0);
    expect(calls).toBe(0);
    const exact = await s.review("completion", material("🧪".repeat(256)), reviewer);
    expect(exact.decision).toBe("approve");
    expect(calls).toBe(1);
    expect(s.reviewCount).toBe(1);
  });

  test.each([
    { name: "step count", steps: Array.from({ length: 31 }, () => "step") },
    { name: "step length", steps: ["x".repeat(1001)] },
    { name: "UTF-8 plan bytes", steps: ["🧪".repeat(250), "🧪".repeat(250)] },
  ])("canonical plan limits reject before admission: $name", async ({ steps }) => {
    const s = new Orchestrator(parseConfig({ maxReviewBytes: 1024 }));
    s.begin("Review bounded plan");
    s.setPendingPlan([...steps]);
    let calls = 0;
    const result = await s.review("plan", material("Review exact plan"), async () => {
      calls++;
      return approved;
    });
    expect(result.summary).toContain("Canonical plan exceeds");
    expect(calls).toBe(0);
    expect(s.reviewCount).toBe(0);
    expect(s.phaseRounds.plan).toBe(0);
    expect(s.planApproved).toBe(false);
    expect(s.lastReview?.status).toBe("input_rejected");
  });

  test("mutation cannot change the admitted body or approve a changed canonical plan", async () => {
    const s = controller();
    s.setPendingPlan(["first step"]);
    const body = material("original body");
    const original = { ...body };
    const deferred = Promise.withResolvers<Verdict>();
    const pending = s.review("plan", body, async ({ material: admitted, canonicalPlan }) => {
      await deferred.promise;
      expect(admitted).toEqual(original);
      expect(canonicalPlan).toEqual(["first step"]);
      return approved;
    });
    body.content = "changed after admission";
    s.pendingPlan[0] = "changed without using the setter";
    deferred.resolve(approved);
    expect((await pending).decision).toBe("blocked");
    expect(s.planApproved).toBe(false);
    expect(s.lastReview?.status).toBe("stale");
  });
});

describe("current invocation provenance", () => {
  test("provider failures, budget exhaustion and input rejection have distinct fresh outcomes", async () => {
    const s = new Orchestrator(parseConfig({ reviews: { min: 1, max: 1 } }));
    s.begin("Review once");
    const failed = await s.review(
      "completion",
      material("body"),
      async () => {
        throw new Error("provider unavailable now");
      },
      undefined,
      "provider-failure",
    );
    expect(s.lastReview).toMatchObject({
      invocationId: "provider-failure",
      status: "unavailable",
      charged: true,
      attempt: 1,
      verdict: failed,
    });
    const exhausted = await s.review(
      "completion",
      material("another body"),
      async () => approved,
      undefined,
      "over-budget",
    );
    expect(s.lastReview).toMatchObject({
      invocationId: "over-budget",
      status: "budget_exhausted",
      charged: false,
      attempt: 1,
      verdict: exhausted,
    });
    expect(s.blocked).toBe(exhausted.summary);
    const rejected = s.rejectReview(
      "completion",
      "missing-artifact",
      "Artifact does not exist. No round charged.",
    );
    expect(s.lastReview).toMatchObject({
      invocationId: "missing-artifact",
      status: "input_rejected",
      charged: false,
      artifactRef: null,
      sha256: null,
      verdict: rejected,
    });
    expect(s.reviewCount).toBe(1);
    expect(s.terminalReason).toContain("Artifact does not exist");
    expect(s.terminalReason).not.toContain("provider unavailable now");
  });

  test.each([
    "caller_cancelled",
    "timed_out",
    "stale",
  ] as const)("%s consumes admitted attempt and cannot leak prior verdict into terminal status", async (status) => {
    const s = new Orchestrator(parseConfig({ reviews: { min: 1, max: 2 }, reviewTimeoutMs: 100 }));
    s.begin("Review current attempt");
    await s.review("completion", material("earlier"), async () => ({
      decision: "blocked",
      summary: "OLD_PROVIDER_CLAIM",
      issues: [],
    }));
    const deferred = Promise.withResolvers<Verdict>();
    const controller = new AbortController();
    const pending = s.review(
      "completion",
      material("current"),
      async () => deferred.promise,
      controller.signal,
      "current-attempt",
    );
    expect(s.lastReview).toMatchObject({
      invocationId: "current-attempt",
      status: "in_flight",
      charged: true,
      attempt: 2,
      verdict: null,
    });
    expect(s.blocked).toBe("");
    if (status === "caller_cancelled") controller.abort();
    if (status === "stale") {
      s.observe("changed", "edit", {}, "new changes", false);
      deferred.resolve(approved);
    }
    const result = await pending;
    expect(result.decision).toBe("blocked");
    expect(s.lastReview).toMatchObject({
      invocationId: "current-attempt",
      status,
      charged: true,
      attempt: 2,
      verdict: result,
    });
    expect(s.blocked).toBe(result.summary);
    expect(s.terminalReason).toContain(result.summary);
    expect(s.terminalReason).not.toContain("OLD_PROVIDER_CLAIM");
    expect(s.reviewCount).toBe(2);
    expect(s.completionApproved).toBe(false);
    deferred.resolve(approved);
    await Promise.resolve();
    expect(s.lastReview?.verdict).toEqual(result);
  });

  test.each([
    true,
    false,
  ])("boundary deadlines stay timed_out when already aborted=%p", async (preAborted) => {
    const s = controller();
    const caller = new AbortController();
    const boundary = new AbortController();
    const signal = AbortSignal.any([caller.signal, boundary.signal]);
    const abort = () => boundary.abort(new DOMException("Boundary timed out", "TimeoutError"));
    if (preAborted) abort();
    let calls = 0;
    const pending = s.review(
      "completion",
      material("body"),
      async () => {
        calls++;
        return new Promise<Verdict>(() => {});
      },
      signal,
      "boundary-timeout",
    );
    if (!preAborted) abort();
    const result = await pending;
    expect(result.summary).toContain("timed out");
    expect(calls).toBe(preAborted ? 0 : 1);
    expect(s.reviewCount).toBe(preAborted ? 0 : 1);
    expect(s.lastReview).toMatchObject({
      invocationId: "boundary-timeout",
      status: "timed_out",
      charged: !preAborted,
      verdict: result,
    });
  });

  test("artifact reads cancelled before admission remain uncharged", () => {
    const s = controller();
    const result = s.rejectReview(
      "completion",
      "cancelled-read",
      "Artifact read cancelled",
      "caller_cancelled",
    );
    expect(s.lastReview).toMatchObject({
      invocationId: "cancelled-read",
      status: "caller_cancelled",
      charged: false,
      attempt: 0,
      artifactRef: null,
      sha256: null,
      verdict: result,
    });
    expect(s.reviewCount).toBe(0);
  });

  test("already cancelled calls have a current uncharged outcome", async () => {
    const s = controller();
    const cancelled = new AbortController();
    cancelled.abort();
    const result = await s.review(
      "completion",
      material("body"),
      async () => approved,
      cancelled.signal,
      "pre-cancelled",
    );
    expect(s.reviewCount).toBe(0);
    expect(s.lastReview).toMatchObject({
      invocationId: "pre-cancelled",
      status: "caller_cancelled",
      charged: false,
      attempt: 0,
      verdict: result,
    });
  });

  test.each([
    "input rejection",
    "concurrent review",
  ])("an older result cannot overwrite a newer %s", async (kind) => {
    const s = controller();
    const deferred = Promise.withResolvers<Verdict>();
    const pending = s.review(
      "completion",
      material("old"),
      async () => deferred.promise,
      undefined,
      "old-call",
    );
    const replacement =
      kind === "input rejection"
        ? s.rejectReview("completion", "new-call", "New artifact preflight rejected")
        : await s.review(
            "completion",
            material("new"),
            async () => approved,
            undefined,
            "new-call",
          );
    const latest = s.lastReview;
    expect(latest).toMatchObject({ invocationId: "new-call", charged: false });
    deferred.resolve(approved);
    expect((await pending).summary).toContain("stale");
    expect(s.lastReview).toEqual(latest);
    expect(s.blocked).toBe(replacement.summary);
    expect(s.reviewCount).toBe(1);
    expect(s.completionApproved).toBe(false);
  });

  test("begin clears prior provenance and a late old result cannot repopulate it", async () => {
    const s = controller();
    const deferred = Promise.withResolvers<Verdict>();
    const pending = s.review("completion", material("old task"), async () => deferred.promise);
    s.begin("A different task");
    deferred.resolve(approved);
    expect((await pending).summary).toContain("stale");
    expect(s.lastReview).toBeNull();
    expect(s.blocked).toBe("");
    expect(s.reviewCount).toBe(0);
    expect(s.completionApproved).toBe(false);
  });

  test("malformed provider responses consume one attempt and bounded provenance omits body", async () => {
    const s = controller();
    const bad = await s.review("completion", material("body"), async () => ({
      decision: "approve",
      summary: "ok",
      issues: ["unresolved"],
    }));
    expect(bad.decision).toBe("blocked");
    expect(s.lastReview?.status).toBe("unavailable");
    expect(s.lastReview?.charged).toBe(true);
    expect(s.phaseRounds.completion).toBe(0);
    const body = { ...material("new body"), ref: "r".repeat(100000) };
    await s.review(
      "completion",
      body,
      async () => {
        throw new Error("e".repeat(100000));
      },
      undefined,
      "i".repeat(100000),
    );
    expect(s.lastReview!.invocationId.length).toBeLessThanOrEqual(200);
    expect(s.lastReview!.artifactRef!.length).toBeLessThanOrEqual(2000);
    expect(s.lastReview!.verdict!.summary.length).toBeLessThanOrEqual(4000);
    expect(JSON.stringify(s.lastReview)).not.toContain("new body");
  });
});

describe("tool execution provenance", () => {
  test("records tool call identity and host truncation facts without importing artifact text", () => {
    const s = controller();
    const hostMetadata = {
      truncation: {
        artifactId: "tool-result-3",
        artifactElidedBytes: 8000,
        totalBytes: 10000,
        outputBytes: 2000,
      },
      limits: { columnTruncated: { artifactId: "column-result-3", artifactElidedBytes: 200 } },
    };
    s.observe(
      "actual-tool-call",
      "bash",
      { command: "bun test" },
      "ACTUAL_EXECUTION_OUTPUT",
      false,
      hostMetadata,
    );
    const record = JSON.parse(JSON.parse(s.snapshot("completion")).recentToolEvidence[0]);
    expect(record).toEqual({
      tool: "bash",
      toolCallId: "actual-tool-call",
      input: { command: "bun test" },
      output: "ACTUAL_EXECUTION_OUTPUT",
      isError: false,
      hostMetadata,
    });
  });

  test.each([
    1000, 24000, 100000,
  ])("oversized IDs and host metadata remain bounded at %p", (maxEvidenceChars) => {
    const s = new Orchestrator(parseConfig({ maxEvidenceChars }));
    s.begin("Observe bounded provenance");
    const noise = '"\\\n\t🧪'.repeat(20000);
    s.observe(noise, noise, { huge: noise }, `OUTPUT_START ${noise} OUTPUT_END`, false, {
      truncation: { artifactId: noise, totalBytes: 1000000 },
    });
    const snapshot = s.snapshot("completion");
    expect(snapshot.length).toBeLessThanOrEqual(maxEvidenceChars);
    expect(s.evidence.join("\n").length).toBeLessThanOrEqual(maxEvidenceChars);
    const [record] = JSON.parse(snapshot).recentToolEvidence.map((entry: string) =>
      JSON.parse(entry),
    );
    expect(record.toolCallId).toContain("omitted");
    expect(JSON.stringify(record.hostMetadata)).toMatch(/omitted|truncated/);
    expect(record.output).toContain("OUTPUT_START");
    expect(record.output).toContain("OUTPUT_END");
  });
});

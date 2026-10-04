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

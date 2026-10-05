import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assessWorkflowScope,
  fallbackWorkflow,
  readRasenWorkflow,
  HostAutoWorkflow,
  type HostFixEvidence,
  type HostVerificationEvidence,
  type RasenWorkflow,
} from "../src/auto/workflow.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";

const change = "prepared-change";
const absent: RasenWorkflow = {
  kind: "absent",
  change,
  reason: "No source auto-run.json exists",
  fingerprint: "no-run-state",
};
const approve = { decision: "approve" as const, summary: "Verified", issues: [] };
const revise = {
  decision: "revise" as const,
  summary: "Repair regression",
  issues: ["Fix the failing case"],
};
function snapshot(done = false, revision = ""): RasenSnapshot {
  return {
    change,
    root: "/fixture",
    schema: "spec-driven",
    state: done ? "all_done" : "ready",
    progress: { total: 1, complete: done ? 1 : 0, remaining: done ? 0 : 1 },
    tasks: [{ id: "1.1", description: "Implement the prepared change", done }],
    instruction: "Apply prepared tasks",
    skill: "Apply guidance only; no rasen-auto skill",
    contextFiles: [],
    fingerprint: `${done ? "done" : "pending"}:${revision}`,
  };
}
function verifier(
  host: HostAutoWorkflow,
  reviewRequestId = "review-request-1",
  extra: Partial<HostVerificationEvidence> = {},
): HostVerificationEvidence {
  const state = host.statusView();
  return {
    reviewRequestId,
    revision: state.revision,
    requiredCheck: extra.stages?.[0] ?? state.stage ?? "verify",
    producer: { agentId: "native-reviewer-child", receiptId: `receipt:${reviewRequestId}` },
    role: "omp-reviewer",
    settled: true,
    success: true,
    evidence: "Independent native task completed the tests and inspected the implementation",
    snapshotFingerprint: state.snapshotFingerprint,
    workflowFingerprint: state.workflowFingerprint,
    ...extra,
  };
}
function fixer(
  host: HostAutoWorkflow,
  reviewRequestId = "fix-request-1",
  extra: Partial<HostFixEvidence> = {},
): HostFixEvidence {
  return {
    ...verifier(host, reviewRequestId),
    requiredCheck: "fix",
    producer: { agentId: "native-fixer-child", receiptId: `receipt:${reviewRequestId}` },
    role: "omp-worker",
    ...extra,
  };
}
function ready() {
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), absent);
  expect(host.recordVerification(verifier(host))).toBe(true);
  expect(host.statusView().phase).toBe("review");
  return host;
}
function source(): Extract<RasenWorkflow, { kind: "present" }> {
  const result = fallbackWorkflow(snapshot(true));
  result.pipeline = "small-feature";
  result.runStateDir = "/fixture/.rasen/changes/prepared-change/ephemera";
  result.fingerprint = "source-state";
  result.stages.push(
    {
      id: "review-loop",
      kind: "standard",
      skill: "rasen-review-cycle",
      requires: ["verify"],
      status: "pending",
      loop: { kind: "review-cycle", maxRounds: 99 },
    },
    {
      id: "ship",
      kind: "standard",
      skill: "rasen-ship",
      requires: ["review-loop"],
      status: "pending",
    },
  );
  result.remaining.push("review-loop", "ship");
  return result;
}

test("absent source admits an ephemeral extension-owned apply/verify/review workflow", () => {
  const host = new HostAutoWorkflow(change);
  expect(host.observe(snapshot(), absent)).toMatchObject({
    phase: "apply",
    source: "builtin",
    pipeline: "omp-prepared-change",
    readyForReview: false,
  });
  const defaultWorkflow = host.effectiveWorkflow();
  expect(defaultWorkflow.kind).toBe("present");
  if (defaultWorkflow.kind !== "present") throw new Error("Expected in-memory default");
  expect(defaultWorkflow.runStateDir).toBe("");
  expect(
    defaultWorkflow.stages.every(
      (stage) => stage.runtime === "omp" && stage.dispatchMode === "native",
    ),
  ).toBe(true);
  expect(defaultWorkflow.stages.some((stage) => stage.skill === "rasen-auto" || stage.loop)).toBe(
    false,
  );
  expect(host.recordVerification(verifier(host))).toBe(false);
  expect(host.observe(snapshot(true), absent).phase).toBe("verify");
  expect(host.statusView().readyForReview).toBe(false);
  expect(host.recordReview(approve, { approved: true }).phase).toBe("verify");
  expect(host.recordVerification(verifier(host))).toBe(true);
  expect(host.statusView()).toMatchObject({ phase: "review", readyForReview: true });
  expect(assessWorkflowScope(host.effectiveWorkflow()).ready).toBe(true);
  expect(host.recordReview(approve, { approved: true }).phase).toBe("settled");
  expect(absent.kind).toBe("absent");
});

test("all_done and source done bits cannot invent independent verification", () => {
  const external = source();
  external.stages.find((stage) => stage.id === "verify")!.status = "done";
  external.completed.push("verify");
  const original = JSON.stringify(external);
  const host = new HostAutoWorkflow(change);
  expect(host.observe(snapshot(true), external).phase).toBe("verify");
  expect(assessWorkflowScope(host.effectiveWorkflow()).ready).toBe(false);
  expect(host.recordVerification(verifier(host))).toBe(true);
  const projected = host.effectiveWorkflow();
  expect(assessWorkflowScope(projected)).toMatchObject({ ready: true, reviewLoopReady: true });
  expect(JSON.stringify(external)).toBe(original);
  if (projected.kind !== "present") throw new Error("Expected host projection");
  expect(projected.stages.find((stage) => stage.id === "ship")?.status).toBe("pending");
});

test("explicit independent-check frontiers preserve pending tasks and return to apply", () => {
  const pending = snapshot();
  const original = JSON.stringify(pending);
  const host = new HostAutoWorkflow(change);
  host.observe(pending, absent);
  expect(host.beginVerification()).toMatchObject({ phase: "verify", readyForReview: false });
  const frontier = host.statusView();
  expect(host.beginVerification()).toEqual(frontier);
  expect(host.observe(pending, absent)).toEqual(frontier);
  const projection = host.effectiveWorkflow();
  expect(projection).toMatchObject({ ready: ["verify"], next: "verify" });
  if (projection.kind !== "present") throw new Error("Expected built-in projection");
  expect(projection.stages.find((stage) => stage.id === "apply")?.status).toBe("pending");
  expect(assessWorkflowScope(projection).ready).toBe(false);
  expect(host.recordReview(approve, { approved: true }).phase).toBe("verify");
  const proof = verifier(host);
  expect(host.recordVerification(proof)).toBe(true);
  expect(host.statusView()).toMatchObject({
    phase: "apply",
    verifiedStages: ["verify"],
    readyForReview: false,
  });
  expect(host.verificationEvidence()[0]?.evidence).toBe(proof.evidence);
  expect(host.observe(pending, absent).phase).toBe("apply");
  expect(JSON.stringify(pending)).toBe(original);
  expect(host.recordReview(approve, { approved: true }).phase).toBe("apply");

  // Updating the task/code facts still requires the existing fresh-proof check.
  expect(host.observe(snapshot(true), absent)).toMatchObject({
    phase: "verify",
    verifiedStages: [],
  });
  expect(host.recordVerification(proof)).toBe(false);
  expect(host.recordVerification(verifier(host, "final-current-state"))).toBe(true);
  expect(host.recordReview(approve, { approved: true }).phase).toBe("settled");
});

test("pending-task verification follows dependencies and changed facts revoke its frontier", () => {
  const external = source();
  external.stages.push({
    id: "security",
    kind: "standard",
    skill: "rasen-cso",
    requires: ["verify"],
    status: "pending",
  });
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(), external);
  host.beginVerification();
  expect(host.recordVerification(verifier(host, "too-early", { stages: ["security"] }))).toBe(
    false,
  );
  expect(host.recordVerification(verifier(host, "first-check"))).toBe(true);
  expect(host.statusView()).toMatchObject({ phase: "verify", stage: "security" });
  const stale = verifier(host, "before-edit");
  expect(host.observe(snapshot(false, "edited"), external)).toMatchObject({
    phase: "apply",
    verifiedStages: [],
    readyForReview: false,
  });
  expect(host.recordVerification(stale)).toBe(false);
  expect(host.beginVerification()).toMatchObject({ phase: "verify", stage: "verify" });
});

test("native verification receipts are successful, settled, independent and fact-bound", () => {
  for (const extra of [
    { role: "omp-worker" },
    { success: false },
    { settled: false },
    { evidence: " " },
    { reviewRequestId: "" },
    { revision: -1 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { requiredCheck: "" },
    { producer: { agentId: "", receiptId: "receipt" } },
    { producer: { agentId: "child", receiptId: "" } },
    { producer: { agentId: "child", receiptId: "receipt", sessionId: "" } },
    { producer: { agentId: "child", receiptId: "receipt", artifactSha256: "not-a-sha256" } },
    { snapshotFingerprint: "old-workspace" },
    { workflowFingerprint: "old-source" },
    { stages: ["ship"] },
    { stages: [] },
    { stages: ["verify", "verify"] },
  ]) {
    const host = new HostAutoWorkflow(change);
    host.observe(snapshot(true), absent);
    expect(
      host.recordVerification(verifier(host, "task", extra as Partial<HostVerificationEvidence>)),
    ).toBe(false);
    expect(host.statusView().phase).toBe("verify");
  }
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), absent);
  const oldEvidence = verifier(host);
  expect(host.recordVerification(oldEvidence)).toBe(true);
  host.invalidateVerification();
  expect(host.recordVerification(oldEvidence)).toBe(false);
  expect(host.recordVerification(verifier(host, "new-independent-check"))).toBe(true);
});

test("the same native reviewer can answer distinct requests for sequential required checks", () => {
  const external = source();
  external.stages.push({
    id: "security",
    kind: "standard",
    skill: "rasen-cso",
    requires: ["verify"],
    status: "pending",
  });
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), external);
  const first = verifier(host, "verify-request");
  expect(host.recordVerification(first)).toBe(true);
  const second = verifier(host, "security-request");
  expect(second.producer.agentId).toBe(first.producer.agentId);
  expect(second.producer.receiptId).not.toBe(first.producer.receiptId);
  expect(second.revision).toBe(first.revision);
  expect(host.recordVerification(second)).toBe(true);
  expect(host.statusView().phase).toBe("review");
  expect(host.verificationEvidence()).toEqual([
    { ...first, stages: ["verify"] },
    { ...second, stages: ["security"] },
  ]);
});

test("semantic evidence identity includes the required check rather than native producer identity", () => {
  const external = source();
  external.stages.push({
    id: "security",
    kind: "standard",
    skill: "rasen-cso",
    requires: ["apply"],
    status: "pending",
  });
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), external);
  const first = verifier(host, "request-for-independent-checks");
  expect(host.recordVerification(first)).toBe(true);
  expect(host.recordVerification(first)).toBe(false);
  expect(
    host.recordVerification({
      ...first,
      producer: { agentId: "another-child", receiptId: "another-native-receipt" },
    }),
  ).toBe(false);
  const second = verifier(host, first.reviewRequestId, {
    producer: { ...first.producer, receiptId: "security-native-receipt" },
  });
  expect(second.requiredCheck).toBe("security");
  expect(host.recordVerification(second)).toBe(true);
  expect(host.verificationEvidence()).toHaveLength(2);
});

test("new revisions admit fresh responses from the same child and reject stale or future proof", () => {
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), absent);
  const first = verifier(host, "original-review-request");
  expect(host.recordVerification(first)).toBe(true);
  host.invalidateVerification();
  const revision = host.statusView().revision;
  expect(revision).toBeGreaterThan(first.revision);
  expect(host.statusView().snapshotFingerprint).toBe(first.snapshotFingerprint);
  expect(host.recordVerification(first)).toBe(false);
  const fresh = verifier(host, "later-review-request", {
    producer: {
      agentId: first.producer.agentId,
      sessionId: "native-child-session",
      receiptId: "fresh-native-output-message",
      artifactSha256: "a".repeat(64),
    },
  });
  expect(host.recordVerification({ ...fresh, revision: revision + 1 })).toBe(false);
  expect(host.recordVerification(fresh)).toBe(true);
  expect(host.verificationEvidence()[0].producer).toEqual(fresh.producer);
  host.invalidateVerification();
  // Revising the same semantic request also requires a fresh revision-bound receipt.
  expect(
    host.recordVerification({
      ...fresh,
      revision: host.statusView().revision,
      producer: { ...fresh.producer, receiptId: "revised-native-output-message" },
    }),
  ).toBe(true);
});

test("explicit coverage must contain its requested check and cannot replace independent review", () => {
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), absent);
  expect(
    host.recordVerification(
      verifier(host, "mismatched-request", { requiredCheck: "security", stages: ["verify"] }),
    ),
  ).toBe(false);
  expect(host.recordVerification(verifier(host, "fixer-proof", { requiredCheck: "fix" }))).toBe(
    false,
  );
  expect(host.recordVerification(verifier(host))).toBe(true);
  expect(host.statusView()).toMatchObject({ phase: "review", readyForReview: true });
});

test("fresh workspace or source facts invalidate verification and settled approval", () => {
  const host = ready();
  host.recordReview(approve, { approved: true });
  expect(host.observe(snapshot(true), absent).phase).toBe("settled");
  expect(host.observe(snapshot(true, "code-edited"), absent).phase).toBe("verify");
  expect(host.recordVerification(verifier(host, "native-check-2"))).toBe(true);
  expect(
    host.observe(snapshot(true, "code-edited"), { ...absent, fingerprint: "new-source-facts" })
      .phase,
  ).toBe("verify");
  expect(host.statusView().verifiedStages).toEqual([]);
});

test("a real revise takes triage, successful native fix, reverify and delta-review", () => {
  const host = ready();
  expect(host.recordReview(revise, { approved: false }).phase).toBe("triage");
  expect(host.statusView().findings).toEqual(revise.issues);
  expect(host.recordVerification(verifier(host, "early-reverify"))).toBe(false);
  expect(host.observe(snapshot(true), absent).phase).toBe("triage");
  const fix = fixer(host, "native-fix");
  expect(host.recordFix(fix)).toBe(false);
  expect(host.acknowledgeTriage().phase).toBe("fix");
  expect(host.recordFix({ ...fix, success: false })).toBe(false);
  expect(host.recordFix({ ...fix, snapshotFingerprint: "not-the-dispatch-baseline" })).toBe(false);
  expect(host.recordFix(fix)).toBe(true);
  expect(host.observe(snapshot(true, "fixed-code"), absent).phase).toBe("verify");
  expect(host.statusView().phase).toBe("verify");
  expect(host.recordVerification(verifier(host, "native-check-after-fix"))).toBe(true);
  expect(host.statusView()).toMatchObject({ phase: "delta-review", readyForReview: true });
  expect(host.recordReview(approve, { approved: true }).phase).toBe("settled");
  expect(host.statusView().findings).toEqual([]);
});

test("minimum review rounds preserve proof and each real review advances a boundary", () => {
  const host = ready();
  const first = host.recordReview(approve, { approved: false });
  expect(first.phase).toBe("delta-review");
  expect(first.verifiedStages).toEqual(["verify"]);
  const second = host.recordReview(
    {
      decision: "revise",
      summary: "Another independent review",
      issues: ["Minimum independent review rounds not yet met"],
    },
    { approved: false },
  );
  expect(second.phase).toBe("delta-review");
  expect(second.fingerprint).not.toBe(first.fingerprint);
  expect(second.cycle).toBe(first.cycle + 1);
  expect(host.recordReview(approve, { approved: true, exhausted: true }).phase).toBe("settled");
});

test("Architect remains the only budget and unresolved exhausted or blocked verdicts stop", () => {
  const host = ready();
  expect(host.recordReview(revise, { approved: false, exhausted: true })).toMatchObject({
    phase: "blocked",
    reason: "Architect completion review budget exhausted",
  });
  expect(host.observe(snapshot(true), absent).phase).toBe("blocked");
  const unavailable = ready();
  expect(
    unavailable.recordReview(
      { decision: "blocked", summary: "Independent reviewer unavailable", issues: [] },
      { approved: false },
    ),
  ).toMatchObject({ phase: "blocked", reason: "Independent reviewer unavailable" });
});

test("invalid or explicit foreign source routes fail safely without default substitution", () => {
  const invalid = new HostAutoWorkflow(change);
  expect(
    invalid.observe(snapshot(), { ...absent, kind: "invalid", reason: "Invalid source state" }),
  ).toMatchObject({ phase: "blocked", reason: "Invalid source state" });
  for (const route of [
    { runtime: "claude", runtimeSource: "stage", dispatchMode: "legacy-fallback" },
    { runtime: "codex", runtimeSource: "stage", dispatchMode: "native" },
    { runtime: "claude", runtimeSource: undefined, dispatchMode: undefined },
    { runtime: "claude", runtimeSource: "legacy-default", dispatchMode: "exec-bridge" },
  ]) {
    const external = source();
    Object.assign(external.stages[0], route);
    expect(new HostAutoWorkflow(change).observe(snapshot(), external).phase).toBe("blocked");
  }
  const legacy = source();
  for (const stage of legacy.stages)
    Object.assign(stage, {
      runtime: "claude",
      runtimeSource: "legacy-default",
      dispatchMode: "legacy-fallback",
    });
  expect(new HostAutoWorkflow(change).observe(snapshot(), legacy).phase).toBe("apply");
});

test("source active work, unresolved findings and unfinished foreign prerequisites block", () => {
  for (const mutate of [
    (external: ReturnType<typeof source>) => {
      external.inProgressStages.push("apply");
    },
    (external: ReturnType<typeof source>) => {
      external.escalatedStages.push("verify");
    },
    (external: ReturnType<typeof source>) => {
      external.openFindings.push({ severity: "major", summary: "Regression" });
    },
    (external: ReturnType<typeof source>) => {
      external.openFindings.push({ summary: "Unclassified" });
    },
    (external: ReturnType<typeof source>) => {
      external.stages.unshift({
        id: "propose",
        kind: "standard",
        skill: "rasen-propose",
        requires: [],
        status: "pending",
      });
      external.stages.find((stage) => stage.id === "apply")!.requires = ["propose"];
    },
  ]) {
    const external = source();
    mutate(external);
    const host = new HostAutoWorkflow(change);
    expect(host.observe(snapshot(true), external).phase).toBe("blocked");
    expect(assessWorkflowScope(host.effectiveWorkflow()).ready).toBe(false);
  }
});

test("task or source-definition changes require a new explicitly authorized start", () => {
  for (const updated of [
    { ...snapshot(), root: "/other-project" },
    { ...snapshot(), schema: "new-schema" },
    { ...snapshot(), tasks: [{ id: "1.1", description: "Expanded scope", done: false }] },
  ]) {
    const host = new HostAutoWorkflow(change);
    host.observe(snapshot(), absent);
    expect(host.observe(updated, absent).phase).toBe("blocked");
  }
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(), source());
  const changed = source();
  changed.pipeline = "different-pipeline";
  expect(host.observe(snapshot(), changed).phase).toBe("blocked");
});

test("checkbox inconsistency and all-conditional source checks cannot skip independent evidence", () => {
  const host = new HostAutoWorkflow(change);
  const contradictory = snapshot(true);
  contradictory.tasks[0].done = false;
  expect(host.observe(contradictory, absent).phase).toBe("apply");
  const external = source();
  const check = external.stages.find((stage) => stage.id === "verify")!;
  Object.assign(check, {
    status: "skipped",
    verifyPolicy: "light",
    note: "Light source verification",
  });
  external.completed.push("verify");
  const conditional = new HostAutoWorkflow(change);
  expect(conditional.observe(snapshot(true), external).phase).toBe("verify");
  expect(conditional.statusView().requiredVerification).toEqual(["verify"]);
  expect(conditional.recordVerification(verifier(conditional))).toBe(true);
  expect(conditional.statusView().phase).toBe("review");
});

test("multiple independent checks accumulate only their explicit stage coverage", () => {
  const external = source();
  external.stages.push({
    id: "security",
    kind: "standard",
    skill: "rasen-cso",
    requires: ["apply"],
    status: "pending",
  });
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), external);
  expect(host.recordVerification(verifier(host, "test-check", { stages: ["verify"] }))).toBe(true);
  expect(host.statusView().phase).toBe("verify");
  expect(host.recordVerification(verifier(host, "security-check", { stages: ["security"] }))).toBe(
    true,
  );
  expect(host.statusView()).toMatchObject({
    phase: "review",
    verifiedStages: ["verify", "security"],
  });
});

test("source DAG observation uses actual OMP identity without foreign execution preflight", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-source-observer-"));
  try {
    await fs.mkdir(path.join(cwd, "rasen", "changes", change), { recursive: true });
    const runStateDir = path.join(cwd, ".rasen", "changes", change, "ephemera");
    await fs.mkdir(runStateDir, { recursive: true });
    const stages = fallbackWorkflow(snapshot()).stages;
    const stateFile = path.join(runStateDir, "auto-run.json");
    const ledger = JSON.stringify({
      pipeline: "small-feature",
      stages: { apply: { status: "pending" }, verify: { status: "pending" } },
      rounds: 0,
      openFindings: [],
    });
    await fs.writeFile(stateFile, ledger);
    const resume = {
      change,
      hasRunState: true,
      pipeline: "small-feature",
      runStateDir,
      completed: [],
      remaining: ["apply", "verify"],
      ready: ["apply"],
      next: "apply",
      inProgressStages: [],
      escalatedStages: [],
      openFindings: [],
    };
    const plan = {
      name: "small-feature",
      hostRuntime: "omp",
      buildOrder: ["apply", "verify"],
      stages,
    };
    const executable = path.join(cwd, "read-only-cli.mjs");
    await fs.writeFile(
      executable,
      `#!${process.execPath}\n
const args = process.argv.slice(2);
if (process.env.RASEN_AGENT_RUNTIME !== "omp" || args.includes("--for-execution")) process.exit(9);
if (args[0] !== "pipeline" || !args.includes("--json")) process.exit(10);
if (args[1] === "resume") console.log(JSON.stringify(${JSON.stringify(resume)}));
else if (args[1] === "show") console.log(JSON.stringify(${JSON.stringify(plan)}));
else process.exit(11);
`,
      { mode: 0o700 },
    );
    const observed = await readRasenWorkflow(cwd, change, { executable });
    expect(observed.kind).toBe("present");
    expect(new HostAutoWorkflow(change).observe(snapshot(), observed).phase).toBe("apply");
    expect(await fs.readFile(stateFile, "utf8")).toBe(ledger);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("verification proof retains native findings for Architect rather than treating exit zero as clean tests", () => {
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), absent);
  const evidence = verifier(host, "native-result", {
    evidence: "Verification ran: one regression test FAILED and requires a fix",
  });
  expect(host.recordVerification(evidence)).toBe(true);
  expect(host.verificationEvidence()).toEqual([{ ...evidence, stages: ["verify"] }]);
  expect(host.statusView().phase).toBe("review");
  const copy = host.verificationEvidence();
  copy[0].evidence = "forged clean result";
  expect(host.verificationEvidence()[0].evidence).toContain("FAILED");
  expect(host.recordReview(revise, { approved: false }).phase).toBe("triage");
  expect(host.verificationEvidence()).toEqual([]);
});

test("unsupported multiple-apply or unrelated-check DAGs cannot be flattened into host phases", () => {
  const multiple = source();
  multiple.stages.push({
    id: "apply-second",
    kind: "standard",
    skill: "rasen-apply-change",
    requires: ["verify"],
    status: "done",
  });
  expect(new HostAutoWorkflow(change).observe(snapshot(true), multiple)).toMatchObject({
    phase: "blocked",
    reason: "Unsupported prepared-change topology: exactly one implementation stage is required",
  });
  const unrelated = source();
  unrelated.stages.find((stage) => stage.id === "verify")!.requires = [];
  expect(new HostAutoWorkflow(change).observe(snapshot(true), unrelated).reason).toContain(
    "must depend on implementation",
  );
  const afterReview = source();
  afterReview.stages.push({
    id: "post-review-check",
    kind: "standard",
    skill: "rasen-qa",
    requires: ["review-loop"],
    status: "pending",
  });
  expect(new HostAutoWorkflow(change).observe(snapshot(true), afterReview).reason).toContain(
    "cannot depend on host review",
  );
});

test("sequential verification requires separate ready-stage receipts despite source done bits", () => {
  const external = source();
  external.stages.push({
    id: "security",
    kind: "standard",
    skill: "rasen-cso",
    requires: ["verify"],
    status: "done",
  });
  external.completed.push("security");
  const host = new HostAutoWorkflow(change);
  expect(host.observe(snapshot(true), external)).toMatchObject({
    phase: "verify",
    stage: "verify",
  });
  expect(
    host.recordVerification(verifier(host, "premature-security", { stages: ["security"] })),
  ).toBe(false);
  expect(
    host.recordVerification(
      verifier(host, "combined-dependent-checks", { stages: ["verify", "security"] }),
    ),
  ).toBe(false);
  expect(host.recordVerification(verifier(host, "test-check"))).toBe(true);
  expect(host.statusView()).toMatchObject({
    phase: "verify",
    stage: "security",
    verifiedStages: ["verify"],
  });
  expect(host.recordVerification(verifier(host, "security-check"))).toBe(true);
  expect(host.statusView()).toMatchObject({
    phase: "review",
    verifiedStages: ["verify", "security"],
  });
});

test("generic parallel receipts cover one allowed stage while explicit ready coverage may cover both", () => {
  const external = source();
  external.stages.push({
    id: "security",
    kind: "standard",
    skill: "rasen-cso",
    requires: ["apply"],
    status: "pending",
  });
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), external);
  expect(host.recordVerification(verifier(host))).toBe(true);
  expect(host.statusView()).toMatchObject({
    phase: "verify",
    stage: "security",
    verifiedStages: ["verify"],
  });
  const parallel = new HostAutoWorkflow(change);
  parallel.observe(snapshot(true), external);
  expect(
    parallel.recordVerification(
      verifier(parallel, "parallel-check", { stages: ["verify", "security"] }),
    ),
  ).toBe(true);
  expect(parallel.statusView().phase).toBe("review");
});

test("conditional skip dependencies cannot bypass unfinished upstream native checks", () => {
  const external = source();
  external.stages.push(
    {
      id: "conditional-security",
      kind: "standard",
      skill: "rasen-cso",
      requires: ["verify"],
      status: "skipped",
      condition: "security-relevant",
      note: "Not applicable",
    },
    {
      id: "qa",
      kind: "standard",
      skill: "rasen-qa",
      requires: ["conditional-security"],
      status: "pending",
    },
  );
  const host = new HostAutoWorkflow(change);
  host.observe(snapshot(true), external);
  expect(host.recordVerification(verifier(host, "early-qa", { stages: ["qa"] }))).toBe(false);
  expect(host.recordVerification(verifier(host, "base-check"))).toBe(true);
  expect(host.statusView().stage).toBe("qa");
  expect(host.recordVerification(verifier(host, "qa-check"))).toBe(true);
  expect(host.statusView().phase).toBe("review");
});

test("semantic boundaries ignore apply task ticks but exact admission fingerprints remain fresh", () => {
  const first = snapshot();
  first.tasks.push({ id: "1.2", description: "Second prepared task", done: false });
  first.progress = { total: 2, complete: 0, remaining: 2 };
  const host = new HostAutoWorkflow(change);
  const state = host.observe(first, absent);
  const semantic = host.semanticBoundaryKey();
  const ticked = structuredClone(first);
  ticked.tasks[0].done = true;
  ticked.progress = { total: 2, complete: 1, remaining: 1 };
  ticked.fingerprint = "one-complete-and-code-edited";
  const refreshed = host.observe(ticked, { ...absent, fingerprint: "observation-metadata-churn" });
  expect(refreshed.phase).toBe("apply");
  expect(refreshed.fingerprint).not.toBe(state.fingerprint);
  expect(host.semanticBoundaryKey()).toBe(semantic);
  ticked.tasks[1].done = true;
  ticked.progress = { total: 2, complete: 2, remaining: 0 };
  ticked.state = "all_done";
  ticked.fingerprint = "both-complete";
  host.observe(ticked, absent);
  expect(host.statusView().phase).toBe("verify");
  expect(host.semanticBoundaryKey()).not.toBe(semantic);
});

test("semantic boundaries retain meaningful source findings, stage status and review rounds", () => {
  const host = new HostAutoWorkflow(change);
  const external = source();
  host.observe(snapshot(), external);
  const first = host.semanticBoundaryKey();
  external.stages[0].status = "pending";
  external.openFindings.push({ severity: "minor", summary: "Observed warning" });
  external.fingerprint = "minor-finding";
  host.observe(snapshot(), external);
  expect(host.semanticBoundaryKey()).not.toBe(first);
  const reviewing = ready();
  reviewing.recordReview(approve, { approved: false });
  const roundOne = reviewing.semanticBoundaryKey();
  reviewing.recordReview(approve, { approved: false });
  expect(reviewing.semanticBoundaryKey()).not.toBe(roundOne);
});

test("a failed fixer that edits code can retry against the next fresh fix boundary", () => {
  const host = ready();
  host.recordReview(revise, { approved: false });
  host.acknowledgeTriage();
  const first = fixer(host, "failed-fixer", { success: false });
  expect(host.recordFix(first)).toBe(false);
  expect(
    host.observe(snapshot(true, "partial-failed-fix"), absent, { settledBoundary: true }).phase,
  ).toBe("fix");
  const retry = fixer(host, "successful-retry");
  expect(retry.snapshotFingerprint).not.toBe(first.snapshotFingerprint);
  expect(host.recordFix(retry)).toBe(true);
  expect(host.observe(snapshot(true, "completed-fix"), absent).phase).toBe("verify");
  expect(host.recordVerification(verifier(host, "independent-recheck"))).toBe(true);
  expect(host.statusView().phase).toBe("delta-review");
});

test("diagnostic observations during a native fix do not replace its admitted dispatch baseline", () => {
  const host = ready();
  host.recordReview(revise, { approved: false });
  host.acknowledgeTriage();
  const dispatched = fixer(host, "active-fixer");
  expect(host.observe(snapshot(true, "midflight-edits"), absent).phase).toBe("fix");
  expect(host.statusView().revision).toBe(dispatched.revision);
  expect(host.recordFix(dispatched)).toBe(true);
  expect(host.statusView().phase).toBe("verify");
  expect(host.statusView().revision).toBeGreaterThan(dispatched.revision);
});

test("settled fix retries refresh the revision even after diagnostics already observed the edits", () => {
  const host = ready();
  host.recordReview(revise, { approved: false });
  host.acknowledgeTriage();
  const old = fixer(host, "old-fix-request");
  host.observe(snapshot(true, "partial-fix"), absent);
  expect(host.statusView().revision).toBe(old.revision);
  host.observe(snapshot(true, "partial-fix"), absent, { settledBoundary: true });
  expect(host.statusView().revision).toBeGreaterThan(old.revision);
  expect(host.recordFix(old)).toBe(false);
  const fresh = fixer(host, "retry-fix-request");
  expect(fresh.producer.agentId).toBe(old.producer.agentId);
  expect(host.recordFix({ ...fresh, requiredCheck: "verify" })).toBe(false);
  expect(host.recordFix(fresh)).toBe(true);
  expect(host.recordFix(fresh)).toBe(false);
});

test("the same fixer can serve a later review cycle without inheriting stale fix evidence", () => {
  const host = ready();
  host.recordReview(revise, { approved: false });
  host.acknowledgeTriage();
  const first = fixer(host, "first-fix-request");
  expect(host.recordFix(first)).toBe(true);
  expect(host.recordVerification(verifier(host, "first-recheck-request"))).toBe(true);
  host.recordReview(revise, { approved: false });
  host.acknowledgeTriage();
  const second = fixer(host, "second-fix-request");
  expect(second.producer.agentId).toBe(first.producer.agentId);
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(host.recordFix(first)).toBe(false);
  expect(host.recordFix(second)).toBe(true);
  expect(host.recordVerification(verifier(host, "second-recheck-request"))).toBe(true);
  expect(host.recordReview(approve, { approved: true }).phase).toBe("settled");
});

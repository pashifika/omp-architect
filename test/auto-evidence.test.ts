import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { NativeReviewEvidence, nativeAgentMessagePath } from "../src/auto/evidence.ts";
import {
  HostAutoWorkflow,
  fallbackWorkflow,
  type HostFixEvidence,
  type HostVerificationEvidence,
} from "../src/auto/workflow.ts";
import type { RasenSnapshot } from "../src/auto/rasen.ts";

type Message = AgentSession["messages"][number];
const signal = () => new AbortController().signal;
const maxBytes = 65536;
const snapshot: RasenSnapshot = {
  change: "prepared-change",
  root: "/fixture",
  schema: "spec-driven",
  state: "all_done",
  progress: { total: 1, complete: 1, remaining: 0 },
  tasks: [{ id: "1.1", description: "Implement prepared task", done: true }],
  instruction: "Verify prepared task",
  skill: "Prepared-change guidance",
  contextFiles: [],
  fingerprint: "complete-snapshot",
};

function incoming(id: string, message: string, timestamp = Date.now(), from = "Main"): Message {
  return {
    role: "custom",
    customType: "irc:incoming",
    content: `<peer-message from="${from}">${message}</peer-message>`,
    display: true,
    details: { id, from, message, fromParent: from === "Main" },
    attribution: "agent",
    timestamp,
  };
}

function assistant(
  text: string,
  timestamp = Date.now(),
  stopReason: "stop" | "error" | "aborted" | "toolUse" = "stop",
): Extract<Message, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "deterministic-fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

function terminalYield(
  id: string,
  data: unknown,
  options: {
    status?: "success" | "aborted";
    isError?: boolean;
    type?: string[];
    useLastTurn?: boolean;
  } = {},
): Message[] {
  const message = assistant("", Date.now(), "toolUse");
  message.content = [{ type: "toolCall", id, name: "yield", arguments: { data } }];
  return [
    message,
    {
      role: "toolResult",
      toolCallId: id,
      toolName: "yield",
      content: [{ type: "text", text: "Result submitted." }],
      details: {
        data,
        status: options.status ?? "success",
        type: options.type,
        useLastTurn: options.useLastTurn,
      },
      isError: options.isError ?? false,
      timestamp: Date.now(),
    },
  ];
}

function sendReceipt(to = "reviewer", from = "Main", outcome = "woken") {
  return { op: "send", from, to, receipts: [{ to, outcome }] };
}

function fixture(sequential = false) {
  const registry = new AgentRegistry();
  const jobs: AsyncJob[] = [];
  const main = {
    getAgentId: () => "Main",
    sessionId: "main-session",
    asyncJobManager: {
      getAllJobs: () => [...jobs],
      getJob: (id: string) => jobs.find((job) => job.id === id),
    },
  } as unknown as AgentSession;
  registry.register({ id: "Main", displayName: "Main", kind: "main", session: main });
  const messages: Message[] = [];
  const child = {
    getAgentId: () => "reviewer",
    sessionId: "reviewer-session",
    messages,
  } as unknown as AgentSession;
  const ref = registry.register({
    id: "reviewer",
    parentId: "Main",
    displayName: "Reviewer",
    kind: "sub",
    session: child,
    status: "idle",
    history: { agent: "omp-reviewer" },
  });
  const evidence = new NativeReviewEvidence({ session: main, registry });
  const workflow = new HostAutoWorkflow(snapshot.change);
  const source = fallbackWorkflow(snapshot);
  if (sequential)
    source.stages.push({
      id: "security",
      kind: "standard",
      skill: "rasen-cso",
      requires: ["verify"],
      status: "pending",
    });
  workflow.observe(snapshot, source);
  const admit = (callId: string, body: string, tool = "send") => {
    evidence.admit(
      callId,
      tool,
      tool === "write"
        ? { path: "agent://reviewer", content: body }
        : { to: "reviewer", message: body },
      workflow.statusView(),
    );
    evidence.receipt(callId, sendReceipt());
  };
  const outcome = (extra: Partial<AsyncJob> = {}) => {
    const acceptedAt = registry.get("reviewer")?.lifecycle?.acceptedAt ?? Date.now();
    const job: AsyncJob = {
      id: `native-job-${jobs.length + 1}`,
      type: "task",
      ownerId: "Main",
      agentId: "reviewer",
      status: "completed",
      label: "Native reviewer result",
      startTime: acceptedAt,
      endTime: acceptedAt,
      abortController: new AbortController(),
      promise: Promise.resolve(),
      ...extra,
    };
    jobs.push(job);
    return job;
  };
  const append = (...items: Message[]) => {
    messages.push(...items);
    ref.lifecycle = { acceptedAt: Date.now(), terminalAt: Date.now() };
    outcome();
  };
  return { evidence, workflow, registry, ref, messages, append, admit, jobs, outcome };
}

function recordingWorkflow() {
  const accepted: HostVerificationEvidence[] = [];
  const fixed: HostFixEvidence[] = [];
  const workflow = {
    recordVerification(proof: HostVerificationEvidence) {
      accepted.push(structuredClone(proof));
      return true;
    },
    recordFix(proof: HostFixEvidence) {
      fixed.push(structuredClone(proof));
      return true;
    },
  } as unknown as HostAutoWorkflow;
  return { workflow, accepted, fixed };
}

test("native IRC evidence allows the same child to answer later semantic review requests", async () => {
  const f = fixture(true);
  f.admit("verify-call", "Verify the prepared change");
  f.append(
    incoming("incoming-verify", "Verify the prepared change"),
    ...terminalYield("verify-yield", "Tests passed"),
  );
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.statusView()).toMatchObject({ phase: "verify", stage: "security" });
  const first = f.workflow.verificationEvidence()[0];
  f.admit("security-call", "Check security independently");
  f.append(
    incoming("incoming-security", "Check security independently"),
    ...terminalYield("security-yield", "Security reviewed"),
  );
  await f.evidence.consume(f.workflow, maxBytes, signal());
  const proofs = f.workflow.verificationEvidence();
  expect(f.workflow.statusView().phase).toBe("review");
  expect(proofs).toHaveLength(2);
  expect(proofs[1].reviewRequestId).not.toBe(first.reviewRequestId);
  expect(proofs[1].producer.agentId).toBe(first.producer.agentId);
  expect(proofs[1].producer.receiptId).not.toBe(first.producer.receiptId);
  expect(proofs[1].producer.sessionId).toBe("reviewer-session");
  expect(proofs[1].producer.artifactSha256).toBe(
    createHash("sha256").update("Security reviewed").digest("hex"),
  );
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toHaveLength(2);
});

test("native task and progress roles survive output-only history on the exact reused child", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-evidence-role-"));
  try {
    for (const kind of ["results", "progress"] as const) {
      const f = fixture(true);
      const outputPath = path.join(cwd, `${kind}.txt`);
      await fs.writeFile(outputPath, "An unrelated older artifact");
      f.ref.history = { outputPath };
      f.evidence.admit("task-call", "task", {}, f.workflow.statusView());
      f.evidence.receipt("task-call", {
        [kind]: [
          kind === "results"
            ? {
                id: "reviewer",
                agent: "omp-reviewer",
                exitCode: 0,
                output: "Original native task result",
              }
            : {
                id: "reviewer",
                agent: "omp-reviewer",
                status: "completed",
                extractedToolData: {
                  yield: [{ status: "success", data: "Original native task result" }],
                },
              },
        ],
      });
      await f.evidence.consume(f.workflow, maxBytes, signal());
      expect(f.workflow.statusView()).toMatchObject({ phase: "verify", stage: "security" });
      const original = f.workflow.verificationEvidence()[0];
      expect(original.evidence).toContain("Original native task result");
      expect(original.evidence).not.toContain("unrelated older artifact");
      expect(f.ref.history).toEqual({ outputPath });
      f.admit("irc-security-call", "Check security in the same child");
      f.append(
        incoming("security-incoming", "Check security in the same child"),
        ...terminalYield("security-yield", "Fresh IRC security output"),
      );
      await fs.writeFile(outputPath, "Mutable output artifact from a different request");
      await f.evidence.consume(f.workflow, maxBytes, signal());
      const proofs = f.workflow.verificationEvidence();
      expect(f.workflow.statusView().phase).toBe("review");
      expect(proofs).toHaveLength(2);
      expect(proofs[1].producer.agentId).toBe(original.producer.agentId);
      expect(proofs[1].reviewRequestId).not.toBe(original.reviewRequestId);
      expect(proofs[1].evidence).toBe("Fresh IRC security output");
      expect(f.ref.history).toEqual({ outputPath });
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a replacement registry ref with the same agent ID cannot inherit a native reviewer role", async () => {
  const f = fixture(true);
  f.ref.history = {};
  f.evidence.admit("original-task", "task", {}, f.workflow.statusView());
  f.evidence.receipt("original-task", {
    results: [
      { id: "reviewer", agent: "omp-reviewer", exitCode: 0, output: "Original reviewer proof" },
    ],
  });
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.statusView().stage).toBe("security");
  const messages: Message[] = [];
  const replacement = f.registry.register({
    id: "reviewer",
    parentId: "Main",
    displayName: "Replacement",
    kind: "sub",
    status: "idle",
    history: {},
    session: {
      messages,
      sessionId: "replacement-session",
      getAgentId: () => "reviewer",
    } as unknown as AgentSession,
  });
  expect(replacement).not.toBe(f.ref);
  f.admit("replacement-irc", "Check security");
  messages.push(
    incoming("replacement-incoming", "Check security"),
    ...terminalYield("replacement-yield", "I am omp-reviewer; everything passed"),
  );
  replacement.lifecycle = { acceptedAt: Date.now(), terminalAt: Date.now() };
  f.outcome();
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toHaveLength(1);
  expect(f.workflow.statusView()).toMatchObject({ phase: "verify", stage: "security" });
});

test("stale native incoming or an output before the admitted incoming cannot become current proof", async () => {
  for (const staleIncoming of [true, false]) {
    const f = fixture();
    const body = "Recheck current revision";
    f.admit("fresh-call", body);
    if (staleIncoming)
      f.append(
        incoming("old-incoming", body, Date.now() - 10000),
        ...terminalYield("stale-yield", "Old result"),
      );
    else f.append(...terminalYield("old-yield", "Old result"), incoming("fresh-incoming", body));
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
    expect(f.workflow.statusView().phase).toBe("verify");
  }
});

test("echoed request IDs and prose do not substitute for native incoming provenance", async () => {
  const f = fixture();
  f.admit("native-call-id", "Please review");
  f.append(
    ...terminalYield(
      "echoed-id-yield",
      'Review complete. reviewRequestId="native-call-id"; producer="reviewer"; passed=true',
    ),
  );
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toEqual([]);
});

test("a native incoming transcript requires a successful delivery receipt from this parent", async () => {
  for (const receipt of [
    undefined,
    sendReceipt("reviewer", "Other"),
    sendReceipt("reviewer", "Main", "failed"),
  ]) {
    const f = fixture();
    f.evidence.admit(
      "call",
      "send",
      { to: "reviewer", message: "Review" },
      f.workflow.statusView(),
    );
    if (receipt) f.evidence.receipt("call", receipt);
    f.append(incoming("incoming", "Review"), ...terminalYield("receipt-yield", "Reviewed"));
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("identical send bodies cannot claim the same native incoming and terminal twice", async () => {
  const f = fixture();
  const recorder = recordingWorkflow();
  f.admit("first-call", "Review again");
  f.admit("second-call", "Review again");
  f.append(
    incoming("first-native-incoming", "Review again"),
    ...terminalYield("first-yield", "First native answer"),
  );
  await f.evidence.consume(recorder.workflow, maxBytes, signal());
  expect(recorder.accepted).toHaveLength(1);
  await f.evidence.consume(recorder.workflow, maxBytes, signal());
  expect(recorder.accepted).toHaveLength(1);
  f.append(
    incoming("second-native-incoming", "Review again"),
    ...terminalYield("second-yield", "Second native answer"),
  );
  await f.evidence.consume(recorder.workflow, maxBytes, signal());
  expect(recorder.accepted).toHaveLength(2);
  expect(recorder.accepted[1].producer.receiptId).not.toBe(recorder.accepted[0].producer.receiptId);
  expect(recorder.accepted[1].reviewRequestId).not.toBe(recorder.accepted[0].reviewRequestId);
});

test("a new native outcome may reuse a tool call ID for a distinct semantic request", async () => {
  const f = fixture();
  const recorder = recordingWorkflow();
  f.admit("first-call", "First review");
  f.append(
    incoming("first-incoming", "First review"),
    ...terminalYield("shared-yield-id", "First answer"),
  );
  await f.evidence.consume(recorder.workflow, maxBytes, signal());
  expect(recorder.accepted).toHaveLength(1);
  f.admit("later-call", "Later review");
  f.append(
    incoming("later-incoming", "Later review"),
    ...terminalYield("shared-yield-id", "Replayed answer"),
  );
  await f.evidence.consume(recorder.workflow, maxBytes, signal());
  expect(recorder.accepted).toHaveLength(2);
  expect(recorder.accepted[1].producer.receiptId).not.toBe(recorder.accepted[0].producer.receiptId);
});

test("current transcript output without native driver acceptance cannot supply evidence", async () => {
  const f = fixture();
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("unaccepted-yield", "Claimed answer"));
  f.ref.lifecycle = { acceptedAt: Date.now() - 10000 };
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toEqual([]);
});

test("failed or aborted terminal replies cannot fall back to earlier successful prose", async () => {
  for (const stopReason of ["error", "aborted"] as const) {
    const f = fixture();
    f.admit("call", "Review");
    f.append(
      incoming("incoming", "Review"),
      assistant("Preliminary inspection looks fine"),
      ...terminalYield("failed-turn-yield", "Preliminary result"),
      assistant("Review failed", Date.now(), stopReason),
    );
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("an earlier IRC request cannot claim the terminal response to a later different incoming", async () => {
  const f = fixture();
  f.admit("call", "Review current code");
  f.append(
    incoming("review-incoming", "Review current code"),
    incoming("different-incoming", "Stop reviewing; inspect unrelated docs", Date.now(), "Other"),
    ...terminalYield("unrelated-yield", "Unrelated docs inspected"),
  );
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toEqual([]);
});

test("a native successful yield-only terminal is accepted as factual evidence", async () => {
  const f = fixture();
  f.admit("yield-call", "Review with structured result");
  f.append(
    incoming("yield-incoming", "Review with structured result"),
    ...terminalYield("yield-tool", { tests: "passed", findings: ["One advisory warning"] }),
  );
  await f.evidence.consume(f.workflow, maxBytes, signal());
  const proof = f.workflow.verificationEvidence()[0];
  expect(proof).toBeDefined();
  expect(proof.evidence).toContain("passed");
  expect(proof.evidence).toContain("One advisory warning");
  expect(f.workflow.statusView().phase).toBe("review");
});

test("a successful yield followed by failed or cancelled native finalization is not evidence", async () => {
  for (const status of ["failed", "cancelled"] as const) {
    const f = fixture();
    f.admit("call", "Review");
    f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Claimed success"));
    // An older completed row cannot hide the latest native finalization failure.
    f.outcome({
      status,
      endTime: f.ref.lifecycle!.acceptedAt! + 1,
      errorText: "Native finalization failed",
    });
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("missing, evicted, foreign and mistimed native finalization outcomes fail closed", async () => {
  for (const mode of [
    "missing",
    "evicted",
    "foreign-owner",
    "other-agent",
    "early-end",
    "late-start",
  ] as const) {
    const f = fixture();
    f.admit("call", "Review");
    f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Claimed success"));
    const job = f.jobs[0];
    if (mode === "missing" || mode === "evicted") f.jobs.length = 0;
    else if (mode === "foreign-owner") job.ownerId = "Other";
    else if (mode === "other-agent") job.agentId = "Other";
    else if (mode === "early-end") job.endTime = f.ref.lifecycle!.acceptedAt! - 1;
    else job.startTime = f.ref.lifecycle!.acceptedAt! + 1;
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("native finalization must resolve before its successful yield becomes evidence", async () => {
  const f = fixture();
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Final native answer"));
  const completion = Promise.withResolvers<void>();
  f.jobs[0].promise = completion.promise;
  let finished = false;
  const consuming = f.evidence.consume(f.workflow, maxBytes, signal()).then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(f.workflow.verificationEvidence()).toEqual([]);
  completion.resolve();
  await consuming;
  expect(f.workflow.verificationEvidence()[0].evidence).toBe("Final native answer");
});

test("truncated native task results retain the full original extracted yield payload", async () => {
  const f = fixture();
  f.ref.history = { agent: "omp-reviewer", outputPath: "/nonexistent/stale-output.txt" };
  const full = `Original independent evidence\n${"Full verification line\n".repeat(300)}Critical finding at the end`;
  f.evidence.admit("task-call", "task", {}, f.workflow.statusView());
  f.evidence.receipt("task-call", {
    results: [
      {
        id: "reviewer",
        agent: "omp-reviewer",
        exitCode: 0,
        output: "Truncated display only",
        truncated: true,
        extractedToolData: { yield: [{ status: "success", data: full }] },
      },
    ],
  });
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()[0].evidence).toBe(full);
});

test("metadata-only task and progress useLastTurn receipts cannot replace missing output", async () => {
  for (const kind of ["results", "progress"] as const) {
    const f = fixture();
    f.ref.history = { agent: "omp-reviewer", outputPath: "/nonexistent/stale-output.txt" };
    f.evidence.admit("task-call", "task", {}, f.workflow.statusView());
    f.evidence.receipt("task-call", {
      [kind]: [
        {
          id: "reviewer",
          agent: "omp-reviewer",
          status: "completed",
          exitCode: 0,
          output: "Truncated display only",
          truncated: true,
          extractedToolData: { yield: [{ status: "success", useLastTurn: true }] },
        },
      ],
    });
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("IRC useLastTurn requires original transcript prose rather than yield metadata", async () => {
  for (const withProse of [true, false]) {
    const f = fixture();
    f.admit("call", "Review");
    f.append(
      incoming("incoming", "Review"),
      ...(withProse ? [assistant("Original full review prose")] : []),
      ...terminalYield("yield", undefined, { useLastTurn: true }),
    );
    await f.evidence.consume(f.workflow, maxBytes, signal());
    if (withProse)
      expect(f.workflow.verificationEvidence()[0].evidence).toBe("Original full review prose");
    else expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("aborted, errored and incomplete incremental yield results cannot become success evidence", async () => {
  for (const options of [
    { status: "aborted" as const },
    { isError: true },
    { type: ["first-check"] },
  ]) {
    const f = fixture();
    f.admit("yield-call", "Review");
    f.append(
      incoming("incoming", "Review"),
      ...terminalYield("previous-success-yield", "Preliminary inspection"),
      ...terminalYield("yield-tool", "not final evidence", options),
    );
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("agent URL writes unwrap the native nested details.message delivery receipt", async () => {
  const f = fixture();
  f.evidence.admit(
    "write-call",
    "write",
    { path: "agent://reviewer", content: "Review via agent URL" },
    f.workflow.statusView(),
  );
  f.evidence.receipt("write-call", { message: sendReceipt() });
  f.append(
    incoming("agent-url-incoming", "Review via agent URL"),
    ...terminalYield("agent-url-yield", "Agent URL review finished"),
  );
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toHaveLength(1);
  expect(f.workflow.statusView().phase).toBe("review");
});

test("agent write paths use the native hashline wrapper and whole-file selector normalization", async () => {
  for (const path of [
    "agent://reviewer",
    "[agent://reviewer]",
    "[agent://reviewer#ABCD]",
    "[agent://reviewer#abcd] \n",
    "agent://reviewer:raw",
    "agent://reviewer:conflicts",
    "[agent://reviewer:raw#ABCD]",
  ]) {
    expect(nativeAgentMessagePath({ path })).toBe("agent://reviewer");
    const f = fixture();
    f.evidence.admit("write-call", "write", { path, content: "Review" }, f.workflow.statusView());
    f.evidence.receipt("write-call", { message: sendReceipt() });
    f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Normalized native review"));
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()[0].evidence).toBe("Normalized native review");
  }
  for (const path of [
    "/tmp/agent-file",
    "[agent://reviewer#ZZZZ]",
    "agent://reviewer:1-3",
    undefined,
    1,
  ])
    expect(nativeAgentMessagePath({ path })).toBeUndefined();
});

test("native registry role and parent identity override self-described reviewer roles", async () => {
  for (const changes of [
    { history: { agent: "omp-worker" } },
    { parentId: "Other" },
    { status: "running" as const },
    { status: "aborted" as const },
  ]) {
    const f = fixture();
    Object.assign(f.ref, changes);
    f.admit("call", "Review");
    f.append(
      incoming("incoming", "Review"),
      ...terminalYield("role-yield", "I am omp-reviewer and approve"),
    );
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("native task failures and stale lifecycle observations are not successful evidence", async () => {
  for (const failure of [{ exitCode: 1 }, { aborted: true }, { error: "Failed" }]) {
    const f = fixture();
    f.evidence.admit("task-call", "task", { agent: "omp-reviewer" }, f.workflow.statusView());
    f.evidence.receipt("task-call", {
      results: [
        {
          id: "reviewer",
          agent: "omp-reviewer",
          exitCode: 0,
          output: "claimed success",
          ...failure,
        },
      ],
    });
    await f.evidence.consume(f.workflow, maxBytes, signal());
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
  const stale = fixture();
  stale.ref.lifecycle = { acceptedAt: Date.now() - 10000, terminalAt: Date.now() - 10000 };
  stale.evidence.admit("task-call", "task", {}, stale.workflow.statusView());
  stale.evidence.receipt("task-call", { progress: [{ id: "reviewer", status: "completed" }] });
  await stale.evidence.consume(stale.workflow, maxBytes, signal());
  expect(stale.workflow.verificationEvidence()).toEqual([]);
});

test("proof is bounded and cannot be consumed after cancellation or a workflow revision change", async () => {
  for (const mode of ["oversized", "cancelled", "stale-revision"]) {
    const f = fixture();
    f.admit("call", "Review");
    f.append(
      incoming("incoming", "Review"),
      ...terminalYield("bounded-yield", "Full native evidence"),
    );
    const controller = new AbortController();
    if (mode === "cancelled") controller.abort();
    if (mode === "stale-revision") f.workflow.invalidateVerification();
    await f.evidence.consume(f.workflow, mode === "oversized" ? 1 : maxBytes, controller.signal);
    expect(f.workflow.verificationEvidence()).toEqual([]);
  }
});

test("older task cleanup ending later cannot mask a newer native wake failure", async () => {
  const f = fixture();
  f.admit("review-call", "Review current changes");
  f.append(
    incoming("review-incoming", "Review current changes"),
    ...terminalYield("review-yield", "Claimed success"),
  );
  const acceptedAt = f.ref.lifecycle!.acceptedAt!;
  f.jobs.length = 0;
  f.outcome({ startTime: acceptedAt - 20, endTime: acceptedAt + 20, status: "completed" });
  f.outcome({ startTime: acceptedAt - 10, endTime: acceptedAt + 5, status: "failed" });
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toEqual([]);
});

test("native wake job may register after yield acceptance but before terminal settlement", async () => {
  const f = fixture();
  f.admit("review-call", "Review current changes");
  f.append(
    incoming("review-incoming", "Review current changes"),
    ...terminalYield("review-yield", "Full native result"),
  );
  const acceptedAt = f.ref.lifecycle!.acceptedAt!;
  f.ref.lifecycle!.terminalAt = acceptedAt + 2;
  f.jobs.length = 0;
  f.outcome({ startTime: acceptedAt + 1, endTime: acceptedAt + 3 });
  await f.evidence.consume(f.workflow, maxBytes, signal());
  expect(f.workflow.verificationEvidence()).toHaveLength(1);
});

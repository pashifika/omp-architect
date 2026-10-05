import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry, type AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import {
  NativeActionEvidence,
  nativeAgentMessagePath,
  type NativeActionReceipt,
  type NativeActionAdmission,
} from "../src/auto/evidence.ts";

type Message = AgentSession["messages"][number];
const signal = () => new AbortController().signal;
const maxBytes = 65536;
const actionAdmission = (
  skillName = "rasen-design",
  role = "omp-reviewer",
): NativeActionAdmission => ({
  actionId: `action-${skillName}`,
  skillName,
  inputFingerprint: "current-change-observation",
  selectionFingerprint: "sealed-skill-selection",
  allowedRoles: [role],
});

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

function fixture() {
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
  const evidence = new NativeActionEvidence({ session: main, registry });
  const admission = actionAdmission();
  const receipts: NativeActionReceipt[] = [];
  const collect = async (limit = maxBytes, cancellation = signal()) => {
    const next = await evidence.consume(limit, cancellation);
    receipts.push(...next);
    return next;
  };
  const admit = (callId: string, body: string, tool = "send") => {
    evidence.admit(
      callId,
      tool,
      tool === "write"
        ? { path: "agent://reviewer", content: body }
        : { to: "reviewer", message: body },
      admission,
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
  return {
    evidence,
    admission,
    receipts,
    collect,
    registry,
    ref,
    messages,
    append,
    admit,
    jobs,
    outcome,
  };
}

test("native IRC evidence binds the same child to independently admitted skill actions", async () => {
  const f = fixture();
  f.admit("verify-call", "Verify the prepared change");
  f.append(
    incoming("incoming-verify", "Verify the prepared change"),
    ...terminalYield("verify-yield", "Tests passed"),
  );
  await f.collect();
  const first = f.receipts[0];
  expect(first.admission).toEqual(actionAdmission());
  f.admission.skillName = "security";
  f.admission.actionId = "action-security";
  f.admit("security-call", "Check security independently");
  f.append(
    incoming("incoming-security", "Check security independently"),
    ...terminalYield("security-yield", "Security reviewed"),
  );
  await f.collect();
  const proofs = f.receipts;
  expect(proofs).toHaveLength(2);
  expect(proofs[1].admission.skillName).toBe("security");
  expect(proofs[1].requestId).not.toBe(first.requestId);
  expect(proofs[1].producer.agentId).toBe(first.producer.agentId);
  expect(proofs[1].producer.receiptId).not.toBe(first.producer.receiptId);
  expect(proofs[1].producer.sessionId).toBe("reviewer-session");
  expect(proofs[1].producer.artifactSha256).toBe(
    createHash("sha256").update("Security reviewed").digest("hex"),
  );
  await f.collect();
  expect(f.receipts).toHaveLength(2);
});

test("native task and progress roles survive output-only history on the exact reused child", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-evidence-role-"));
  try {
    for (const kind of ["results", "progress"] as const) {
      const f = fixture();
      const outputPath = path.join(cwd, `${kind}.txt`);
      await fs.writeFile(outputPath, "An unrelated older artifact");
      f.ref.history = { outputPath };
      f.evidence.admit("task-call", "task", {}, f.admission);
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
      await f.collect();
      const original = f.receipts[0];
      expect(original.evidence).toContain("Original native task result");
      expect(original.evidence).not.toContain("unrelated older artifact");
      expect(f.ref.history).toEqual({ outputPath });
      f.admission.skillName = "security";
      f.admission.actionId = "action-security";
      f.admit("irc-security-call", "Check security in the same child");
      f.append(
        incoming("security-incoming", "Check security in the same child"),
        ...terminalYield("security-yield", "Fresh IRC security output"),
      );
      await fs.writeFile(outputPath, "Mutable output artifact from a different request");
      await f.collect();
      const proofs = f.receipts;
      expect(proofs).toHaveLength(2);
      expect(proofs[1].producer.agentId).toBe(original.producer.agentId);
      expect(proofs[1].requestId).not.toBe(original.requestId);
      expect(proofs[1].evidence).toBe("Fresh IRC security output");
      expect(f.ref.history).toEqual({ outputPath });
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a replacement registry ref with the same agent ID cannot inherit a native reviewer role", async () => {
  const f = fixture();
  f.ref.history = {};
  f.evidence.admit("original-task", "task", {}, f.admission);
  f.evidence.receipt("original-task", {
    results: [
      { id: "reviewer", agent: "omp-reviewer", exitCode: 0, output: "Original reviewer proof" },
    ],
  });
  await f.collect();
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
  await f.collect();
  expect(f.receipts).toHaveLength(1);
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
    await f.collect();
    expect(f.receipts).toEqual([]);
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
  await f.collect();
  expect(f.receipts).toEqual([]);
});

test("a native incoming transcript requires a successful delivery receipt from this parent", async () => {
  for (const receipt of [
    undefined,
    sendReceipt("reviewer", "Other"),
    sendReceipt("reviewer", "Main", "failed"),
  ]) {
    const f = fixture();
    f.evidence.admit("call", "send", { to: "reviewer", message: "Review" }, f.admission);
    if (receipt) f.evidence.receipt("call", receipt);
    f.append(incoming("incoming", "Review"), ...terminalYield("receipt-yield", "Reviewed"));
    await f.collect();
    expect(f.receipts).toEqual([]);
  }
});

test("identical send bodies cannot claim the same native incoming and terminal twice", async () => {
  const f = fixture();
  f.admit("first-call", "Review again");
  f.admit("second-call", "Review again");
  f.append(
    incoming("first-native-incoming", "Review again"),
    ...terminalYield("first-yield", "First native answer"),
  );
  await f.collect();
  expect(f.receipts).toHaveLength(1);
  await f.collect();
  expect(f.receipts).toHaveLength(1);
  f.append(
    incoming("second-native-incoming", "Review again"),
    ...terminalYield("second-yield", "Second native answer"),
  );
  await f.collect();
  expect(f.receipts).toHaveLength(2);
  expect(f.receipts[1].producer.receiptId).not.toBe(f.receipts[0].producer.receiptId);
  expect(f.receipts[1].requestId).not.toBe(f.receipts[0].requestId);
});

test("a new native outcome may reuse a tool call ID for a distinct semantic request", async () => {
  const f = fixture();
  f.admit("first-call", "First review");
  f.append(
    incoming("first-incoming", "First review"),
    ...terminalYield("shared-yield-id", "First answer"),
  );
  await f.collect();
  expect(f.receipts).toHaveLength(1);
  f.admit("later-call", "Later review");
  f.append(
    incoming("later-incoming", "Later review"),
    ...terminalYield("shared-yield-id", "Replayed answer"),
  );
  await f.collect();
  expect(f.receipts).toHaveLength(2);
  expect(f.receipts[1].producer.receiptId).not.toBe(f.receipts[0].producer.receiptId);
});

test("current transcript output without native driver acceptance cannot supply evidence", async () => {
  const f = fixture();
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("unaccepted-yield", "Claimed answer"));
  f.ref.lifecycle = { acceptedAt: Date.now() - 10000 };
  await f.collect();
  expect(f.receipts).toEqual([]);
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
    await f.collect();
    expect(f.receipts).toEqual([]);
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
  await f.collect();
  expect(f.receipts).toEqual([]);
});

test("a native successful yield-only terminal is accepted as factual evidence", async () => {
  const f = fixture();
  f.admit("yield-call", "Review with structured result");
  f.append(
    incoming("yield-incoming", "Review with structured result"),
    ...terminalYield("yield-tool", { tests: "passed", findings: ["One advisory warning"] }),
  );
  await f.collect();
  const proof = f.receipts[0];
  expect(proof).toBeDefined();
  expect(proof.evidence).toContain("passed");
  expect(proof.evidence).toContain("One advisory warning");
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
    await f.collect();
    expect(f.receipts).toEqual([]);
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
    await f.collect();
    expect(f.receipts).toEqual([]);
  }
});

test("native finalization must resolve before its successful yield becomes evidence", async () => {
  const f = fixture();
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Final native answer"));
  const completion = Promise.withResolvers<void>();
  f.jobs[0].promise = completion.promise;
  let finished = false;
  const consuming = f.collect().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(f.receipts).toEqual([]);
  completion.resolve();
  await consuming;
  expect(f.receipts[0].evidence).toBe("Final native answer");
});

test("truncated native task results retain the full original extracted yield payload", async () => {
  const f = fixture();
  f.ref.history = { agent: "omp-reviewer", outputPath: "/nonexistent/stale-output.txt" };
  const full = `Original independent evidence\n${"Full verification line\n".repeat(300)}Critical finding at the end`;
  f.evidence.admit("task-call", "task", {}, f.admission);
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
  await f.collect();
  expect(f.receipts[0].evidence).toBe(full);
});

test("metadata-only task and progress useLastTurn receipts cannot replace missing output", async () => {
  for (const kind of ["results", "progress"] as const) {
    const f = fixture();
    f.ref.history = { agent: "omp-reviewer", outputPath: "/nonexistent/stale-output.txt" };
    f.evidence.admit("task-call", "task", {}, f.admission);
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
    await f.collect();
    expect(f.receipts).toEqual([]);
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
    await f.collect();
    if (withProse) expect(f.receipts[0].evidence).toBe("Original full review prose");
    else expect(f.receipts).toEqual([]);
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
    await f.collect();
    expect(f.receipts).toEqual([]);
  }
});

test("agent URL writes unwrap the native nested details.message delivery receipt", async () => {
  const f = fixture();
  f.evidence.admit(
    "write-call",
    "write",
    { path: "agent://reviewer", content: "Review via agent URL" },
    f.admission,
  );
  f.evidence.receipt("write-call", { message: sendReceipt() });
  f.append(
    incoming("agent-url-incoming", "Review via agent URL"),
    ...terminalYield("agent-url-yield", "Agent URL review finished"),
  );
  await f.collect();
  expect(f.receipts).toHaveLength(1);
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
    f.evidence.admit("write-call", "write", { path, content: "Review" }, f.admission);
    f.evidence.receipt("write-call", { message: sendReceipt() });
    f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Normalized native review"));
    await f.collect();
    expect(f.receipts[0].evidence).toBe("Normalized native review");
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
    await f.collect();
    expect(f.receipts).toEqual([]);
  }
});

test("native task failures and stale lifecycle observations are not successful evidence", async () => {
  for (const failure of [{ exitCode: 1 }, { aborted: true }, { error: "Failed" }]) {
    const f = fixture();
    f.evidence.admit("task-call", "task", { agent: "omp-reviewer" }, f.admission);
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
    await f.collect();
    expect(f.receipts).toEqual([]);
  }
  const stale = fixture();
  stale.ref.lifecycle = { acceptedAt: Date.now() - 10000, terminalAt: Date.now() - 10000 };
  stale.evidence.admit("task-call", "task", {}, stale.admission);
  stale.evidence.receipt("task-call", { progress: [{ id: "reviewer", status: "completed" }] });
  await stale.collect();
  expect(stale.receipts).toEqual([]);
});

test("native evidence is bounded and cannot be consumed after cancellation", async () => {
  for (const mode of ["oversized", "cancelled"]) {
    const f = fixture();
    f.admit("call", "Review");
    f.append(
      incoming("incoming", "Review"),
      ...terminalYield("bounded-yield", "Full native evidence"),
    );
    const controller = new AbortController();
    if (mode === "cancelled") controller.abort();
    await f.collect(mode === "oversized" ? 1 : maxBytes, controller.signal);
    expect(f.receipts).toEqual([]);
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
  await f.collect();
  expect(f.receipts).toEqual([]);
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
  await f.collect();
  expect(f.receipts).toHaveLength(1);
});

test("admission identity is fixed at dispatch without interpreting skill semantics", async () => {
  const f = fixture();
  const admitted = structuredClone(f.admission);
  f.admit("call", "Inspect design");
  f.admission.skillName = "apply";
  f.admission.actionId = "different-action";
  f.admission.selectionFingerprint = "changed-selection";
  f.admission.inputFingerprint = "changed-input";
  f.admission.allowedRoles.length = 0;
  f.append(incoming("incoming", "Inspect design"), ...terminalYield("yield", "Native prose"));
  const receipts = await f.collect();
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({
    admission: admitted,
    role: "omp-reviewer",
    settled: true,
    success: true,
    evidence: "Native prose",
  });
  expect(await f.collect()).toEqual([]);
});

test("any selected skill can admit its configured native role", async () => {
  for (const [skillName, role] of [
    ["apply", "omp-worker"],
    ["architecture", "omp-architect"],
    ["research", "custom-researcher"],
    ["verify", "custom-tester"],
  ]) {
    const f = fixture();
    Object.assign(f.admission, actionAdmission(skillName, role));
    f.ref.history = { agent: role };
    f.admit("call", "Invoke skill", "irc");
    f.append(incoming("incoming", "Invoke skill"), ...terminalYield("yield", { done: true }));
    expect(await f.collect()).toMatchObject([{ admission: { skillName }, role }]);
  }
});

test("an empty role allowlist cannot admit native evidence", async () => {
  const f = fixture();
  f.admission.allowedRoles = [];
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Reviewed"));
  expect(await f.collect()).toEqual([]);
});

test("several concurrently admitted task actions retain their own role and identity", async () => {
  const f = fixture();
  const admissions = [
    actionAdmission("architecture", "omp-architect"),
    actionAdmission("implementation", "omp-worker"),
    actionAdmission("security", "custom-security"),
  ];
  for (const admission of admissions) {
    const id = `child-${admission.skillName}`;
    f.registry.register({
      id,
      parentId: "Main",
      displayName: admission.skillName,
      kind: "sub",
      status: "parked",
      session: null,
      history: { agent: admission.allowedRoles[0] },
    });
    f.evidence.admit(`call-${id}`, "task", {}, admission);
    f.evidence.receipt(`call-${id}`, {
      results: [{ id, agent: admission.allowedRoles[0], exitCode: 0, output: admission.skillName }],
    });
  }
  const receipts = await f.collect();
  expect(receipts.map((receipt) => receipt.admission)).toEqual(admissions);
  expect(receipts.map((receipt) => receipt.evidence)).toEqual(
    admissions.map((item) => item.skillName),
  );
  expect(new Set(receipts.map((receipt) => receipt.requestId)).size).toBe(3);
  expect(await f.collect()).toEqual([]);
});

test("a repeated call cannot rebind its action or replay its task result", async () => {
  const f = fixture();
  f.evidence.admit("call", "task", {}, f.admission);
  f.evidence.admit("call", "task", {}, actionAdmission("another-skill"));
  const details = {
    results: [{ id: "reviewer", agent: "omp-reviewer", exitCode: 0, output: "Original result" }],
  };
  f.evidence.receipt("call", details);
  const receipts = await f.collect();
  expect(receipts).toHaveLength(1);
  expect(receipts[0].admission).toEqual(actionAdmission());
  f.evidence.receipt("call", details);
  expect(await f.collect()).toEqual([]);
  f.evidence.admit("other-call", "task", {}, actionAdmission("another-skill"));
  f.evidence.receipt("other-call", details);
  expect(await f.collect()).toEqual([]);
});

test("a task result cannot migrate to a replacement producer with the same role and ID", async () => {
  const f = fixture();
  f.evidence.admit("call", "task", {}, f.admission);
  f.evidence.receipt("call", {
    results: [{ id: "reviewer", agent: "omp-reviewer", exitCode: 0, output: "Original result" }],
  });
  f.registry.register({
    id: "reviewer",
    parentId: "Main",
    displayName: "Replacement",
    kind: "sub",
    status: "idle",
    session: null,
    history: { agent: "omp-reviewer" },
  });
  expect(await f.collect()).toEqual([]);
});

test("concurrent collectors return a native receipt only once", async () => {
  const f = fixture();
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("yield", "One answer"));
  const completion = Promise.withResolvers<void>();
  f.jobs[0].promise = completion.promise;
  const first = f.evidence.consume(maxBytes, signal());
  const second = f.evidence.consume(maxBytes, signal());
  completion.resolve();
  const receipts = (await Promise.all([first, second])).flat();
  expect(receipts).toHaveLength(1);
  expect(receipts[0].evidence).toBe("One answer");
  expect(await f.collect()).toEqual([]);
});

test("producer changes during native finalization cannot certify the old observation", async () => {
  for (const mode of ["parent", "role", "session", "lifecycle", "running", "outcome"]) {
    const f = fixture();
    f.admit("call", "Review");
    f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Old observation"));
    const completion = Promise.withResolvers<void>();
    f.jobs[0].promise = completion.promise;
    const collecting = f.collect();
    if (mode === "parent") f.ref.parentId = "Other";
    if (mode === "role") f.ref.history = { agent: "omp-worker" };
    if (mode === "session") f.ref.session = null;
    if (mode === "lifecycle") f.ref.lifecycle!.terminalAt! += 1;
    if (mode === "running") f.ref.status = "running";
    if (mode === "outcome") f.jobs[0].status = "failed";
    completion.resolve();
    expect(await collecting).toEqual([]);
  }
});

test("a historical terminal job cannot prove a later request even when timestamps collide", async () => {
  const f = fixture();
  const future = Date.now() + 1000;
  f.outcome({ startTime: future, endTime: future });
  f.admit("call", "Review");
  f.messages.push(incoming("incoming", "Review", future), ...terminalYield("yield", "Replayed"));
  f.ref.lifecycle = { acceptedAt: future, terminalAt: future };
  expect(await f.collect()).toEqual([]);
});

test("invalid output limits fail closed and UTF-8 evidence is bounded in bytes", async () => {
  const f = fixture();
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("yield", "確認"));
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1.5, 2])
    expect(await f.collect(limit)).toEqual([]);
  expect((await f.collect(6))[0].evidence).toBe("確認");
});

test("parked children retain request-specific evidence through the native read-only transcript loader", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-evidence-parked-"));
  try {
    const f = fixture();
    f.admit("call", "Review before parking");
    f.append(
      incoming("incoming", "Review before parking"),
      ...terminalYield("yield", { result: "Full parked result", detail: "x".repeat(1024) }),
    );
    const sessionFile = path.join(cwd, "parked.jsonl");
    const timestamp = new Date().toISOString();
    await fs.writeFile(
      sessionFile,
      [
        { type: "session", version: 3, id: "parked-session", timestamp, cwd },
        ...f.messages.map((message, index) => ({
          type: "message",
          id: `entry-${index}`,
          parentId: index ? `entry-${index - 1}` : null,
          timestamp,
          message,
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    f.ref.sessionFile = sessionFile;
    f.ref.session = null;
    f.ref.status = "parked";
    const receipts = await f.collect();
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0].evidence)).toEqual({
      result: "Full parked result",
      detail: "x".repeat(1024),
    });
    expect(f.ref.status).toBe("parked");
    expect(f.ref.session).toBeNull();
    expect(await f.collect()).toEqual([]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("rejected native finalization cannot produce a successful action receipt", async () => {
  const f = fixture();
  f.admit("call", "Review");
  f.append(incoming("incoming", "Review"), ...terminalYield("yield", "Claimed result"));
  const completion = Promise.withResolvers<void>();
  f.jobs[0].promise = completion.promise;
  const collecting = f.collect();
  completion.reject(new Error("Native finalization failed"));
  expect(await collecting).toEqual([]);
  expect(f.jobs[0].abortController.signal.aborted).toBe(false);
});

function modelEvidenceFixture() {
  const f = fixture();
  const model = {
    provider: "openai",
    id: "deterministic-fixture",
    name: "Deterministic",
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinking: { efforts: ["low", "medium", "high"] },
  } as unknown as NonNullable<AgentSession["model"]>;
  const main = f.registry.get("Main")!.session!;
  Object.assign(main, { modelRegistry: { getAvailable: () => [model] } });
  Object.assign(f.ref.session!, {
    model,
    thinkingLevel: "high",
    servingModel: {
      selector: "openai/deterministic-fixture:high",
      modelIdentity: "openai/deterministic-fixture",
      thinkingLevel: "high",
      isFallback: false,
    },
  });
  f.admission.modelRoute = {
    provider: model.provider,
    id: model.id,
    modelIdentity: "openai/deterministic-fixture",
    selector: "openai/deterministic-fixture:high",
    thinkingLevel: "high",
  };
  const metadata = {
    resolvedModelIdentity: "openai/deterministic-fixture",
    resolvedThinkingLevel: "high",
  };
  return { ...f, metadata };
}

for (const tool of ["send", "irc", "write"]) {
  test(`${tool} evidence retains verified native producer model and effort`, async () => {
    const f = modelEvidenceFixture();
    f.admit("model-call", "Check routed action", tool);
    f.append(
      incoming("model-incoming", "Check routed action"),
      ...terminalYield("model-yield", "Routed result"),
    );
    const [receipt] = await f.collect();
    expect(receipt.producer.model).toEqual({
      provider: "openai",
      id: "deterministic-fixture",
      modelIdentity: "openai/deterministic-fixture",
      thinkingLevel: "high",
    });
    expect(receipt.admission.modelRoute).toEqual(f.admission.modelRoute);
  });
}

test("a reused native worker reports wrong or unproven actual effort for admission validation", async () => {
  for (const level of ["medium", undefined]) {
    const f = modelEvidenceFixture();
    f.admit("model-call", "Check routed action");
    f.append(
      incoming("model-incoming", "Check routed action"),
      ...terminalYield("model-yield", "Claiming high does not prove high"),
    );
    Object.assign(f.ref.session!, {
      servingModel: { modelIdentity: "openai/deterministic-fixture", thinkingLevel: level },
    });
    const [receipt] = await f.collect();
    expect(receipt.producer.model?.thinkingLevel).not.toBe(f.admission.modelRoute?.thinkingLevel);
    expect(await f.collect()).toEqual([]);
  }
});

test("model switches that never produced the terminal assistant cannot certify IRC work", async () => {
  const f = modelEvidenceFixture();
  f.admit("model-call", "Check routed action");
  const yielded = terminalYield("model-yield", "Claimed expected model");
  Object.assign(yielded[0], { provider: "other-provider" });
  f.append(incoming("model-incoming", "Check routed action"), ...yielded);
  expect((await f.collect())[0].producer.model).toBeUndefined();
});

test("task receipts use original native resolved attribution, not a later reused session configuration", async () => {
  const f = modelEvidenceFixture();
  f.evidence.admit("model-task", "task", {}, f.admission);
  f.evidence.receipt("model-task", {
    results: [
      {
        id: "reviewer",
        agent: "omp-reviewer",
        exitCode: 0,
        output: "Native task result",
        ...f.metadata,
      },
    ],
  });
  Object.assign(f.ref.session!, { thinkingLevel: "low" });
  const [receipt] = await f.collect();
  expect(receipt.producer.model?.thinkingLevel).toBe("high");
  expect(receipt.evidence).toBe("Native task result");
});

test("fresh task model request assertions cannot replace native result model provenance", async () => {
  for (const metadata of [
    {},
    { model: "openai/deterministic-fixture:high" },
    { resolvedModelIdentity: "openai/deterministic-fixture", resolvedThinkingLevel: "medium" },
  ]) {
    const f = modelEvidenceFixture();
    f.evidence.admit(
      "model-task",
      "task",
      { model: "openai/deterministic-fixture:high" },
      f.admission,
    );
    f.evidence.receipt("model-task", {
      results: [
        {
          id: "reviewer",
          agent: "omp-reviewer",
          exitCode: 0,
          output: "Native task result",
          ...metadata,
        },
      ],
    });
    const [receipt] = await f.collect();
    expect(receipt.producer.model?.thinkingLevel).not.toBe("high");
    expect(await f.collect()).toEqual([]);
  }
});

test("detached task evidence rereads its admitted native job after scheduling is held", async () => {
  const f = modelEvidenceFixture();
  f.evidence.admit("detached-task", "task", {}, f.admission);
  const job = f.outcome({ status: "running", endTime: undefined });
  f.evidence.receipt("detached-task", {
    progress: [{ id: "reviewer", agent: "omp-reviewer", status: "running" }],
    async: { jobId: job.id },
  });
  expect(await f.collect()).toEqual([]);
  job.status = "completed";
  job.endTime = Date.now();
  job.latestDetails = {
    progress: [
      {
        id: "reviewer",
        agent: "omp-reviewer",
        status: "completed",
        ...f.metadata,
        extractedToolData: { yield: [{ status: "success", data: "Original detached yield" }] },
      },
    ],
    async: { jobId: job.id },
  };
  const [receipt] = await f.collect();
  expect(receipt.evidence).toBe("Original detached yield");
  expect(receipt.producer.model?.thinkingLevel).toBe("high");
  expect(await f.collect()).toEqual([]);
});

test("old detached jobs and later wake jobs cannot be adopted as a fresh task admission", async () => {
  const f = fixture();
  const old = f.outcome({ status: "running", endTime: undefined });
  f.evidence.admit("detached-task", "task", {}, f.admission);
  f.evidence.receipt("detached-task", { async: { jobId: old.id } });
  old.status = "completed";
  old.latestDetails = {
    progress: [
      {
        id: "reviewer",
        agent: "omp-reviewer",
        status: "completed",
        extractedToolData: { yield: [{ status: "success", data: "Historical output" }] },
      },
    ],
    async: { jobId: old.id },
  };
  expect(await f.collect()).toEqual([]);
});

test("later terminal metadata cannot silently retain an earlier model attribution", async () => {
  const f = modelEvidenceFixture();
  f.evidence.admit("model-task", "task", {}, f.admission);
  f.evidence.receipt("model-task", {
    progress: [{ id: "reviewer", agent: "omp-reviewer", status: "completed", ...f.metadata }],
  });
  f.evidence.receipt("model-task", {
    results: [
      { id: "reviewer", agent: "omp-reviewer", exitCode: 0, output: "Final native task result" },
    ],
  });
  const [receipt] = await f.collect();
  expect(receipt.producer.model).toBeUndefined();
});

test("each detached batch job supplies only its own terminal snapshot", async () => {
  const f = fixture();
  f.registry.register({
    id: "reviewer-two",
    parentId: "Main",
    kind: "sub",
    displayName: "Reviewer two",
    session: f.ref.session!,
    status: "idle",
    history: { agent: "omp-reviewer" },
  });
  f.evidence.admit("batch-task", "task", {}, f.admission);
  const first = f.outcome({ status: "running", endTime: undefined });
  const second = f.outcome({ agentId: "reviewer-two", status: "running", endTime: undefined });
  const row = (id: string, status: string) => ({
    id,
    agent: "omp-reviewer",
    status,
    extractedToolData: { yield: [{ status: "success", data: `${id} result` }] },
  });
  f.evidence.receipt("batch-task", {
    progress: [row("reviewer", "running"), row("reviewer-two", "running")],
    async: { jobId: first.id },
  });
  // The second registered job finishes first, retaining a stale running peer.
  second.status = "completed";
  second.latestDetails = {
    progress: [row("reviewer", "running"), row("reviewer-two", "completed")],
    async: { jobId: first.id },
  };
  first.status = "completed";
  first.latestDetails = {
    progress: [row("reviewer", "completed"), row("reviewer-two", "completed")],
    async: { jobId: first.id },
  };
  const receipts = await f.collect();
  expect(receipts.map((receipt) => receipt.producer.agentId).sort()).toEqual([
    "reviewer",
    "reviewer-two",
  ]);
  expect(receipts.map((receipt) => receipt.evidence).sort()).toEqual([
    "reviewer result",
    "reviewer-two result",
  ]);
});

test("the same selected skill can produce distinct action receipts on one native child", async () => {
  const f = fixture();
  const skillName = f.admission.skillName;
  for (const actionId of ["action-first", "action-second"]) {
    f.admission.actionId = actionId;
    f.admit(`call-${actionId}`, `Inspect for ${actionId}`);
    f.append(
      incoming(`incoming-${actionId}`, `Inspect for ${actionId}`),
      ...terminalYield(`yield-${actionId}`, `Native result for ${actionId}`),
    );
    const [receipt] = await f.collect();
    expect(receipt.admission).toMatchObject({ actionId, skillName });
    expect(receipt.producer.agentId).toBe("reviewer");
  }
  expect(new Set(f.receipts.map((receipt) => receipt.requestId)).size).toBe(2);
  expect(new Set(f.receipts.map((receipt) => receipt.producer.receiptId)).size).toBe(2);
  expect(await f.collect()).toEqual([]);
});

test("native receipts preserve child output without interpreting workflow claims", async () => {
  const f = fixture();
  const admitted = structuredClone(f.admission);
  const output = JSON.stringify({
    actionId: "unadmitted-action",
    skillName: "unselected-skill",
    phase: "complete",
    status: "done",
    dependencies: ["made-up-prerequisite"],
    rounds: -100,
    inputFingerprint: "child-asserted-input",
    selectionFingerprint: "child-asserted-selection",
  });
  f.evidence.admit("raw-task", "task", {}, f.admission);
  f.evidence.receipt("raw-task", {
    results: [{ id: "reviewer", agent: "omp-reviewer", exitCode: 0, output }],
  });
  const [receipt] = await f.collect();
  expect(receipt.evidence).toBe(output);
  expect(receipt.admission).toEqual(admitted);
  expect(receipt.producer.artifactSha256).toBe(createHash("sha256").update(output).digest("hex"));
});

test("action role routes stay sealed across caller and returned receipt mutation", async () => {
  const f = modelEvidenceFixture();
  f.admission.roleRoutes = { "omp-reviewer": { ...f.admission.modelRoute! } };
  const admitted = structuredClone(f.admission);
  f.admit("first-call", "First routed action request");
  f.admit("second-call", "Second routed action request");
  f.admission.modelRoute!.selector = "provider/replaced:low";
  f.admission.roleRoutes["omp-reviewer"].selector = "provider/replaced:low";
  f.admission.allowedRoles[0] = "omp-worker";
  f.append(
    incoming("first-incoming", "First routed action request"),
    ...terminalYield("first-yield", "First result"),
  );
  const [first] = await f.collect();
  expect(first.admission).toEqual(admitted);
  first.admission.roleRoutes!["omp-reviewer"].selector = "provider/receipt-mutation:low";
  first.admission.allowedRoles.length = 0;
  f.append(
    incoming("second-incoming", "Second routed action request"),
    ...terminalYield("second-yield", "Second result"),
  );
  const [second] = await f.collect();
  expect(second.admission).toEqual(admitted);
});

test("IRC admission uses native task roles when active or parked history contains only output metadata", () => {
  const f = modelEvidenceFixture();
  f.ref.history = { outputPath: "/native/result.md" };
  f.ref.sessionFile = "/native/reviewer.jsonl";
  f.evidence.admit("native-role", "task", {}, f.admission);
  const job = f.outcome({ status: "running", endTime: undefined });
  f.evidence.receipt("native-role", {
    progress: [{ id: "reviewer", agent: "omp-reviewer", status: "running" }],
    async: { jobId: job.id },
  });
  expect(f.evidence.recipient("reviewer")).toEqual({ role: "omp-reviewer" });
  job.status = "completed";
  job.latestDetails = {
    results: [{ id: "reviewer", agent: "omp-reviewer", exitCode: 0, ...f.metadata }],
  };
  f.ref.status = "parked";
  f.ref.session = null;
  const parked = f.evidence.recipient("reviewer");
  expect(parked?.role).toBe("omp-reviewer");
  expect(parked?.provenance?.ref).toBe(f.ref);
  expect(parked?.provenance).toMatchObject({
    sessionFile: "/native/reviewer.jsonl",
    model: { modelIdentity: "openai/deterministic-fixture", thinkingLevel: "high" },
  });
  f.ref.sessionFile = "/native/changed.jsonl";
  expect(f.evidence.recipient("reviewer")?.provenance?.sessionFile).toBe("/native/reviewer.jsonl");
  f.registry.register({
    id: "reviewer",
    parentId: "Main",
    displayName: "Replacement",
    kind: "sub",
    status: "parked",
    session: null,
    sessionFile: "/native/reviewer.jsonl",
  });
  expect(f.evidence.recipient("reviewer")).toBeUndefined();
});

test("pending native task progress binds its later registration before active IRC admission", async () => {
  const f = modelEvidenceFixture();
  const child = f.ref.session!;
  f.registry.unregister("reviewer");
  f.evidence.admit("registration-race", "task", {}, f.admission);
  const settled = Promise.withResolvers<void>();
  const job = f.outcome({ status: "running", endTime: undefined, promise: settled.promise });
  const pending = { id: "reviewer", agent: "omp-reviewer", status: "pending" };
  job.latestDetails = { progress: [pending], async: { jobId: job.id } };
  f.evidence.receipt("registration-race", job.latestDetails);
  expect(f.evidence.recipient("reviewer")).toBeUndefined();
  const actual = f.registry.register({
    id: "reviewer",
    parentId: "Main",
    displayName: "Not a role",
    kind: "sub",
    status: "running",
    session: child,
    sessionFile: "/native/actual.jsonl",
    history: {},
  });
  expect(f.evidence.recipient("reviewer")).toEqual({ role: "omp-reviewer" });
  // No second tool_result and no completed job was needed for active steering.
  expect(job.status).toBe("running");
  expect(actual.history).toEqual({});
  f.registry.register({
    id: "reviewer",
    parentId: "Main",
    displayName: "omp-reviewer",
    kind: "sub",
    status: "running",
    session: child,
    sessionFile: "/native/replacement.jsonl",
    history: {},
  });
  job.latestDetails = {
    progress: [{ ...pending, status: "running", ...f.metadata }],
    async: { jobId: job.id },
  };
  expect(f.evidence.recipient("reviewer")).toBeUndefined();
  settled.resolve();
  await settled.promise;
});

test("a replaced late registration cannot inherit provenance before the first recipient lookup", async () => {
  const f = modelEvidenceFixture();
  const child = f.ref.session!;
  f.registry.unregister("reviewer");
  f.evidence.admit("late-replacement", "task", {}, f.admission);
  const settled = Promise.withResolvers<void>();
  const job = f.outcome({ status: "running", promise: settled.promise });
  job.latestDetails = {
    progress: [{ id: "reviewer", agent: "omp-reviewer", status: "pending" }],
    async: { jobId: job.id },
  };
  f.evidence.receipt("late-replacement", job.latestDetails);
  for (const generation of ["actual", "replacement"])
    f.registry.register({
      id: "reviewer",
      parentId: "Main",
      displayName: "omp-reviewer",
      kind: "sub",
      status: "running",
      session: child,
      sessionFile: `/native/${generation}.jsonl`,
      history: {},
    });
  expect(f.evidence.recipient("reviewer")).toBeUndefined();
  settled.resolve();
  await settled.promise;
});

test("pending registration cannot borrow an old or replaced native async job", async () => {
  for (const prior of [true, false]) {
    const f = modelEvidenceFixture();
    const child = f.ref.session!;
    f.registry.unregister("reviewer");
    const settled = Promise.withResolvers<void>();
    const old = prior ? f.outcome({ status: "running", promise: settled.promise }) : undefined;
    f.evidence.admit("unscoped-registration", "task", {}, f.admission);
    const job = old ?? f.outcome({ status: "running", promise: settled.promise });
    const details = {
      progress: [{ id: "reviewer", agent: "omp-reviewer", status: "pending" }],
      async: { jobId: job.id },
    };
    f.evidence.receipt("unscoped-registration", details);
    if (!prior) f.jobs.splice(f.jobs.indexOf(job), 1, { ...job });
    f.registry.register({
      id: "reviewer",
      parentId: "Main",
      displayName: "omp-reviewer",
      kind: "sub",
      status: "running",
      session: child,
      history: {},
    });
    expect(f.evidence.recipient("reviewer")).toBeUndefined();
    settled.resolve();
    await settled.promise;
  }
});

test("every pending detached batch peer binds its own first native registration", async () => {
  const f = modelEvidenceFixture();
  const child = f.ref.session!;
  f.registry.unregister("reviewer");
  f.evidence.admit("batch-registration", "task", {}, f.admission);
  const settled = Promise.withResolvers<void>();
  const first = f.outcome({ status: "running", endTime: undefined, promise: settled.promise });
  const second = f.outcome({
    agentId: "reviewer-two",
    status: "running",
    endTime: undefined,
    promise: settled.promise,
  });
  const progress = ["reviewer", "reviewer-two"].map((id) => ({
    id,
    agent: "omp-reviewer",
    status: "pending",
  }));
  const details = { progress, async: { jobId: first.id } };
  first.latestDetails = details;
  second.latestDetails = details;
  f.evidence.receipt("batch-registration", details);
  for (const id of ["reviewer", "reviewer-two"])
    f.registry.register({
      id,
      parentId: "Main",
      displayName: "Not a role",
      kind: "sub",
      status: "running",
      session: child,
      sessionFile: `/native/${id}.jsonl`,
      history: {},
    });
  expect(f.evidence.recipient("reviewer")).toEqual({ role: "omp-reviewer" });
  expect(f.evidence.recipient("reviewer-two")).toEqual({ role: "omp-reviewer" });
  f.registry.register({
    id: "reviewer-two",
    parentId: "Main",
    displayName: "omp-reviewer",
    kind: "sub",
    status: "running",
    session: child,
    sessionFile: "/native/replacement.jsonl",
    history: {},
  });
  expect(f.evidence.recipient("reviewer-two")).toBeUndefined();
  settled.resolve();
  await settled.promise;
});

test("batch registration excludes foreign, prior and differently grouped jobs", async () => {
  for (const excluded of ["owner", "prior", "batch"] as const) {
    const f = modelEvidenceFixture();
    const child = f.ref.session!;
    f.registry.unregister("reviewer");
    const settled = Promise.withResolvers<void>();
    const prior =
      excluded === "prior"
        ? f.outcome({ agentId: "reviewer-two", status: "running", promise: settled.promise })
        : undefined;
    f.evidence.admit("batch-registration", "task", {}, f.admission);
    const first = f.outcome({ status: "running", promise: settled.promise });
    const second =
      prior ??
      f.outcome({
        agentId: "reviewer-two",
        ownerId: excluded === "owner" ? "Other" : "Main",
        status: "running",
        promise: settled.promise,
      });
    const progress = ["reviewer", "reviewer-two"].map((id) => ({
      id,
      agent: "omp-reviewer",
      status: "pending",
    }));
    first.latestDetails = { progress, async: { jobId: first.id } };
    second.latestDetails = {
      progress,
      async: { jobId: excluded === "batch" ? "other-batch" : first.id },
    };
    f.evidence.receipt("batch-registration", first.latestDetails);
    f.registry.register({
      id: "reviewer-two",
      parentId: "Main",
      displayName: "omp-reviewer",
      kind: "sub",
      status: "running",
      session: child,
      history: {},
    });
    expect(f.evidence.recipient("reviewer-two")).toBeUndefined();
    settled.resolve();
    await settled.promise;
  }
});

test("queued batch peers bind from native pending rows before per-job details exist", async () => {
  for (const replaceBeforeLookup of [false, true]) {
    const f = modelEvidenceFixture();
    const child = f.ref.session!;
    f.registry.unregister("reviewer");
    f.evidence.admit("queued-batch", "task", {}, f.admission);
    const settled = Promise.withResolvers<void>();
    const first = f.outcome({ status: "running", promise: settled.promise });
    const second = f.outcome({
      agentId: "reviewer-two",
      status: "running",
      promise: settled.promise,
    });
    expect(second.latestDetails).toBeUndefined();
    f.evidence.receipt("queued-batch", {
      progress: ["reviewer", "reviewer-two"].map((id) => ({
        id,
        agent: "omp-reviewer",
        status: "pending",
      })),
      async: { jobId: first.id },
    });
    const register = () =>
      f.registry.register({
        id: "reviewer-two",
        parentId: "Main",
        displayName: "Not a role",
        kind: "sub",
        status: "running",
        session: child,
        sessionFile: "/native/queued.jsonl",
        history: {},
      });
    register();
    if (replaceBeforeLookup) register();
    expect(f.evidence.recipient("reviewer-two")).toEqual(
      replaceBeforeLookup ? undefined : { role: "omp-reviewer" },
    );
    settled.resolve();
    await settled.promise;
  }
});

test("contradictory later batch metadata revokes cached recipient and execution evidence", async () => {
  for (const contradictBeforeRegistration of [false, true]) {
    const f = modelEvidenceFixture();
    const child = f.ref.session!;
    f.registry.unregister("reviewer");
    f.evidence.admit("queued-batch", "task", {}, f.admission);
    const settled = Promise.withResolvers<void>();
    const first = f.outcome({ status: "running", promise: settled.promise });
    const second = f.outcome({
      agentId: "reviewer-two",
      status: "running",
      promise: settled.promise,
    });
    f.evidence.receipt("queued-batch", {
      progress: [{ id: "reviewer-two", agent: "omp-reviewer", status: "pending" }],
      async: { jobId: first.id },
    });
    const contradiction = {
      async: { jobId: "foreign-batch" },
      results: [
        {
          id: "reviewer-two",
          agent: "omp-reviewer",
          exitCode: 0,
          output: "Must not certify this action",
          ...f.metadata,
        },
      ],
    };
    if (contradictBeforeRegistration) second.latestDetails = contradiction;
    const ref = f.registry.register({
      id: "reviewer-two",
      parentId: "Main",
      displayName: "Not a role",
      kind: "sub",
      status: "running",
      session: child,
      sessionFile: "/native/queued.jsonl",
      history: { agent: "omp-reviewer" },
    });
    if (!contradictBeforeRegistration)
      expect(f.evidence.recipient("reviewer-two")?.role).toBe("omp-reviewer");
    second.latestDetails = contradiction;
    expect(f.evidence.recipient("reviewer-two")).toBeUndefined();
    second.status = "completed";
    ref.status = "idle";
    settled.resolve();
    await settled.promise;
    expect(await f.collect()).toEqual([]);
  }
});

test("an uncorrelated or ambiguous new task job cannot inherit a queued batch row", async () => {
  for (const mode of ["uncorrelated", "ambiguous"] as const) {
    const f = modelEvidenceFixture();
    const child = f.ref.session!;
    f.registry.unregister("reviewer");
    f.evidence.admit("queued-batch", "task", {}, f.admission);
    const settled = Promise.withResolvers<void>();
    const first = f.outcome({ status: "running", promise: settled.promise });
    f.outcome({ agentId: "reviewer-two", status: "running", promise: settled.promise });
    if (mode === "ambiguous")
      f.outcome({ agentId: "reviewer-two", status: "running", promise: settled.promise });
    f.evidence.receipt("queued-batch", {
      progress: [
        {
          id: mode === "uncorrelated" ? "some-other-peer" : "reviewer-two",
          agent: "omp-reviewer",
          status: "pending",
        },
      ],
      async: { jobId: first.id },
    });
    f.registry.register({
      id: "reviewer-two",
      parentId: "Main",
      displayName: "omp-reviewer",
      kind: "sub",
      status: "running",
      session: child,
      history: {},
    });
    expect(f.evidence.recipient("reviewer-two")).toBeUndefined();
    settled.resolve();
    await settled.promise;
  }
});

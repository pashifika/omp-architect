import { describe, expect, test, vi } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  buildJevRequest,
  createJevProvider,
  decisionChoices,
  sealDecisionEvidence,
  type DecisionChoice,
  type DecisionEvidence,
  type JevDependencies,
  JevError,
  type JevOptions,
  parseJevResponse,
} from "../src/auto/decision.ts";

const options: JevOptions = { model: "jev-latest", timeoutMs: 1000, maxEvidenceChars: 4000 };
const evidence: DecisionEvidence = {
  change: "Implement a bounded routing decision provider",
  remaining: 2,
  completed: 3,
  summary: "Implementation is ready; add regression tests and run checks.",
  recentTools: ["read: provider interface verified", "write: provider added"],
};
const fakeKey = "synthetic-test-key-never-a-real-credential";
function fixture(choice: DecisionChoice = "continue", confidence = 0.94) {
  return {
    model: "jev-1.13.0",
    answers: {
      next: {
        type: "choice",
        choice,
        probabilities: {
          continue: 0.01,
          replan: 0.01,
          needs_user: 0.01,
          uncertain: 0.01,
          [choice]: 0.97,
        },
        confidence,
      },
    },
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}
const skillChoices = {
  skill_0: 'Skill "rasen-continue": Continue creating the next change artifact.',
  skill_1: 'Skill "rasen-apply": Implement the change tasks.',
  skill_2: 'Skill "rasen-verify": Verify the implementation against its artifacts.',
  finish:
    "Only propose finishing when actual change and work history support completion; the controller must validate it.",
  needs_user: "Essential user input or permission is missing.",
  uncertain: "The evidence does not support a next option.",
};
function candidateFixture(choice: string, criteria: Record<string, string> = skillChoices) {
  const base = fixture();
  return {
    ...base,
    answers: {
      next: {
        ...base.answers.next,
        choice,
        probabilities: Object.fromEntries(
          Object.keys(criteria).map((id) => [id, id === choice ? 1 : 0]),
        ),
      },
    },
  };
}

function provider(
  fetch: NonNullable<JevDependencies["fetch"]>,
  overrides: Partial<JevOptions> = {},
) {
  return createJevProvider({ ...options, ...overrides }, { fetch, readApiKey: () => fakeKey });
}
function jsonResponse(value: unknown = fixture()) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}
function errorMessage(fn: () => unknown): string {
  try {
    fn();
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(JevError);
    return (error as Error).message;
  }
}

describe("bounded Jev request", () => {
  test("preserves the legacy four-way utility question when no catalog is supplied", () => {
    const request = buildJevRequest(evidence, options);
    expect(request.model).toBe("jev-latest");
    expect(request.state).toEqual(evidence);
    expect(request.state).not.toBe(evidence);
    expect(request.state.recentTools).not.toBe(evidence.recentTools);
    expect(Object.keys(request.questions)).toEqual(["next"]);
    expect(request.questions.next.type).toBe("choice");
    expect(Object.keys(request.questions.next.criteria)).toEqual([
      "continue",
      "replan",
      "needs_user",
      "uncertain",
    ]);
    expect(request.questions.next.instructions).toContain("untrusted observations");
    expect(request.questions.next.instructions).toContain(
      "not an approval or a completion decision",
    );
    expect(request.questions.next.criteria.uncertain).toContain("no remaining work");
  });
  test("request copies prevent callers from changing the default question for later requests", () => {
    const request = buildJevRequest(evidence, options);
    request.questions.next.criteria.continue = "approve everything";
    expect(buildJevRequest(evidence, options).questions.next.criteria.continue).not.toContain(
      "approve everything",
    );
  });
  test("uses every exact loaded-skill criterion without a fixed pipeline or phase list", () => {
    const choices = { ...skillChoices };
    const request = buildJevRequest({ ...evidence, choices }, options);
    expect(request.questions.next.criteria).toEqual(choices);
    expect(request.questions.next.criteria).not.toBe(choices);
    expect(Object.hasOwn(request.questions.next.criteria, "continue")).toBe(false);
    expect(request.state).toEqual(evidence);
    expect(request.questions.next.instructions).toContain("do not impose a fixed phase order");
    expect(request.questions.next.instructions).toContain(
      "not permission, approval, or proof of completion",
    );
    expect(request.questions.next.instructions).toContain(
      "When finish is supplied, choose it when its supplied criterion is met",
    );
    expect(request.questions.next.instructions).toContain(
      "controller still verifies fresh inputs and native quiescence",
    );
    choices.skill_0 = "mutated later";
    expect(request.questions.next.criteria.skill_0).toBe(skillChoices.skill_0);
  });
  test("catalog and observation budgets are separate; descriptions are never truncated", () => {
    const choices = { skill_0: "exact description ".repeat(100), uncertain: "Unclear" };
    const request = buildJevRequest(
      { ...evidence, summary: "x".repeat(10000), choices },
      { ...options, maxEvidenceChars: 256 },
    );
    expect(JSON.stringify(request.state).length).toBeLessThanOrEqual(256);
    expect(request.questions.next.criteria).toEqual(choices);
    expect(
      errorMessage(() =>
        buildJevRequest(
          {
            ...evidence,
            choices: Object.fromEntries(
              Array.from({ length: 129 }, (_, i) => [`skill_${i}`, "Description"]),
            ),
          },
          options,
        ),
      ),
    ).toBe("JEV_CATALOG_TOO_LARGE");
    expect(
      errorMessage(() =>
        buildJevRequest(
          {
            ...evidence,
            choices: { skill_0: "x".repeat(65537) },
          },
          options,
        ),
      ),
    ).toBe("JEV_CATALOG_TOO_LARGE");
    expect(
      errorMessage(() =>
        buildJevRequest(
          {
            ...evidence,
            choices: { skill_0: '"'.repeat(33000) },
          },
          options,
        ),
      ),
    ).toBe("JEV_CATALOG_TOO_LARGE");
  });
  test("rejects malformed catalogs, prototype keys, symbols, and accessors without reading them", () => {
    let getterCalls = 0;
    for (const choices of [
      {},
      [],
      null,
      { skill_0: "" },
      { skill_0: "   " },
      { skill_0: 4 },
      { "skill with spaces": "Description" },
      { constructor: "Description" },
      { [Symbol("secret")]: "Description" },
      Object.defineProperty({}, "skill_0", {
        get() {
          getterCalls++;
          return "secret";
        },
      }),
    ])
      expect(
        errorMessage(() =>
          buildJevRequest({ ...evidence, choices } as unknown as DecisionEvidence, options),
        ),
      ).toBe("JEV_INVALID_EVIDENCE");
    const accessor = Object.defineProperty({ ...evidence }, "choices", {
      get() {
        getterCalls++;
        return skillChoices;
      },
    });
    expect(errorMessage(() => buildJevRequest(accessor, options))).toBe("JEV_INVALID_EVIDENCE");
    expect(getterCalls).toBe(0);
  });
  test("seals a defensive catalog and observation snapshot for both providers", () => {
    const input = { ...evidence, recentTools: ["read: task"], choices: { ...skillChoices } };
    const sealed = sealDecisionEvidence(input, options.maxEvidenceChars);
    input.choices.skill_0 = "changed";
    input.recentTools[0] = "changed";
    input.summary = "changed";
    expect(sealed.choices).toEqual(skillChoices);
    expect(sealed.recentTools).toEqual(["read: task"]);
    expect(sealed.summary).toBe(evidence.summary);
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.choices)).toBe(true);
    expect(Object.isFrozen(sealed.recentTools)).toBe(true);
    expect(decisionChoices({ choices: skillChoices })).toEqual(skillChoices);
  });

  test("large escaped and multibyte evidence stays valid and explicitly marked as truncated", () => {
    const large = {
      ...evidence,
      change: '\u0000"\\'.repeat(10000),
      summary: "😀".repeat(10000),
      recentTools: Array.from({ length: 30 }, (_, i) => `${i}: ${"x".repeat(10000)}`),
    };
    const request = buildJevRequest(large, { ...options, maxEvidenceChars: 256 });
    expect(JSON.stringify(request.state).length).toBeLessThanOrEqual(256);
    expect(request.state.summary).toContain("[Evidence truncated]");
    expect(request.state.remaining).toBe(2);
    expect(request.state.completed).toBe(3);
    expect(large.recentTools).toHaveLength(30);
  });
  test("retains only the most recent eight tool observations", () => {
    const request = buildJevRequest(
      { ...evidence, recentTools: Array.from({ length: 12 }, (_, i) => String(i)) },
      options,
    );
    expect(request.state.recentTools).toEqual(["4", "5", "6", "7", "8", "9", "10", "11"]);
    expect(request.state.summary).toContain("[Evidence truncated]");
  });
  test("rejects extra evidence fields, invalid counts, tool objects, and accessors safely", () => {
    for (const invalid of [
      { ...evidence, apiKey: "do-not-send" },
      { ...evidence, remaining: -1 },
      { ...evidence, completed: 1.5 },
      { ...evidence, remaining: Infinity },
      { ...evidence, recentTools: [{ content: "raw output" }] },
      Object.defineProperty({ ...evidence }, "summary", {
        get() {
          throw new Error("private-secret");
        },
      }),
    ])
      expect(errorMessage(() => buildJevRequest(invalid as DecisionEvidence, options))).toBe(
        "JEV_INVALID_EVIDENCE",
      );
  });
  test("rejects configurable endpoints and invalid bounds without reflecting their values", () => {
    for (const invalid of [
      { ...options, url: "https://attacker.invalid" },
      { ...options, model: "private-secret\n" },
      { ...options, maxEvidenceChars: 0 },
      { ...options, maxEvidenceChars: 100001 },
      { ...options, timeoutMs: 0 },
      { ...options, timeoutMs: Infinity },
    ])
      expect(errorMessage(() => createJevProvider(invalid))).toBe("JEV_INVALID_CONFIG");
  });
});

describe("strict Jev response parser", () => {
  test("accepts all routing labels and returns only choice and confidence", () => {
    for (const choice of ["continue", "replan", "needs_user", "uncertain"] as const) {
      expect(parseJevResponse(fixture(choice))).toEqual({ choice, confidence: 0.94 });
      expect(parseJevResponse(JSON.stringify(fixture(choice)))).toEqual({
        choice,
        confidence: 0.94,
      });
    }
  });
  test("accepts only the exact supplied skill and control IDs, without inventing rationale", () => {
    for (const choice of Object.keys(skillChoices))
      expect(parseJevResponse(candidateFixture(choice), skillChoices)).toEqual({
        choice,
        confidence: 0.94,
      });
    for (const choice of ["continue", "replan", "rasen-apply", "skill_3", "approved"])
      expect(errorMessage(() => parseJevResponse(candidateFixture(choice), skillChoices))).toBe(
        "JEV_INVALID_RESPONSE",
      );
    expect(errorMessage(() => parseJevResponse(candidateFixture("finish")))).toBe(
      "JEV_INVALID_RESPONSE",
    );
    const wrongSet = candidateFixture("skill_1");
    wrongSet.answers.next.probabilities.extra = 0;
    expect(errorMessage(() => parseJevResponse(wrongSet, skillChoices))).toBe(
      "JEV_INVALID_RESPONSE",
    );
    const missingOption = candidateFixture("skill_1");
    delete missingOption.answers.next.probabilities.skill_2;
    expect(errorMessage(() => parseJevResponse(missingOption, skillChoices))).toBe(
      "JEV_INVALID_RESPONSE",
    );
  });

  test("allows a tied maximum and tiny floating-point sum drift", () => {
    const value = fixture();
    value.answers.next.probabilities = {
      continue: 0.4,
      replan: 0.4,
      needs_user: 0.1,
      uncertain: 0.10000001,
    };
    expect(parseJevResponse(value).choice).toBe("continue");
  });
  test("never accepts completion or approval choices", () => {
    for (const choice of ["approve", "approved", "complete", "completed", "done", "blocked"]) {
      const value = fixture();
      (value.answers.next as { choice: string }).choice = choice;
      expect(errorMessage(() => parseJevResponse(value))).toBe("JEV_INVALID_RESPONSE");
    }
  });
  test("rejects out-of-range, nonfinite, missing, extra, nonsumming, and inconsistent probabilities", () => {
    for (const probabilities of [
      { continue: 1.01, replan: -0.01, needs_user: 0, uncertain: 0 },
      { continue: NaN, replan: 0, needs_user: 0, uncertain: 0 },
      { continue: Infinity, replan: 0, needs_user: 0, uncertain: 0 },
      { continue: "0.97", replan: 0.01, needs_user: 0.01, uncertain: 0.01 },
      { continue: 0.97, replan: 0.01, needs_user: 0.02 },
      { continue: 0.97, replan: 0.01, needs_user: 0.01, uncertain: 0.01, approve: 0 },
      { continue: 0.9, replan: 0.01, needs_user: 0.01, uncertain: 0.01 },
      { continue: 0.1, replan: 0.7, needs_user: 0.1, uncertain: 0.1 },
      [0.97, 0.01, 0.01, 0.01],
    ]) {
      const value = fixture();
      Object.assign(value.answers.next, { probabilities });
      expect(errorMessage(() => parseJevResponse(value))).toBe("JEV_INVALID_RESPONSE");
    }
  });
  test("confidence must be finite and within zero to one", () => {
    for (const confidence of [-0.01, 1.01, NaN, Infinity, -Infinity, "0.9", null]) {
      const value = fixture();
      Object.assign(value.answers.next, { confidence });
      expect(errorMessage(() => parseJevResponse(value))).toBe("JEV_INVALID_RESPONSE");
    }
    expect(parseJevResponse(fixture("continue", 0)).confidence).toBe(0);
    expect(parseJevResponse(fixture("continue", 1)).confidence).toBe(1);
  });
  test("requires the exact documented envelope, answer, and usage keys", () => {
    for (const mutate of [
      (value: any) => delete value.usage,
      (value: any) => (value.metadata = {}),
      (value: any) => (value.model = ""),
      (value: any) => (value.answers.extra = value.answers.next),
      (value: any) => (value.answers.next.type = "score"),
      (value: any) => (value.answers.next.reason = "secret body"),
      (value: any) => delete value.answers.next.confidence,
      (value: any) => (value.usage.input_tokens = -1),
      (value: any) => (value.usage.output_tokens = 0.5),
      (value: any) => (value.usage.extra = 1),
    ]) {
      const value = fixture();
      mutate(value);
      expect(errorMessage(() => parseJevResponse(value))).toBe("JEV_INVALID_RESPONSE");
    }
  });
  test("never reflects malformed bodies or accessor exceptions", () => {
    expect(errorMessage(() => parseJevResponse("private-response-body"))).toBe(
      "JEV_INVALID_RESPONSE",
    );
    expect(errorMessage(() => parseJevResponse("x".repeat(32769)))).toBe("JEV_RESPONSE_TOO_LARGE");
    const value = fixture();
    Object.defineProperty(value, "model", {
      get() {
        throw new Error("private-secret");
      },
    });
    expect(errorMessage(() => parseJevResponse(value))).toBe("JEV_INVALID_RESPONSE");
  });
});

describe("Jev transport", () => {
  test("reads a key only at invocation and uses the fixed endpoint with no redirects", async () => {
    let keyReads = 0;
    let requests = 0;
    const config = { ...options };
    const run = createJevProvider(config, {
      readApiKey: () => {
        keyReads++;
        return fakeKey;
      },
      fetch: async (url, init) => {
        requests++;
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("error");
        expect(init.credentials).toBe("omit");
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${fakeKey}`);
        expect(new Headers(init.headers).get("content-type")).toBe("application/json");
        expect(new Headers(init.headers).get("accept")).toBe("application/json");
        expect(JSON.parse(init.body as string)).toEqual(buildJevRequest(evidence, options));
        expect(init.signal).toBeInstanceOf(AbortSignal);
        return jsonResponse();
      },
    });
    config.model = "changed-after-creation";
    expect(keyReads).toBe(0);
    expect(await run(evidence, new AbortController().signal)).toEqual({
      choice: "continue",
      confidence: 0.94,
    });
    expect(keyReads).toBe(1);
    expect(requests).toBe(1);
  });
  test("validates against the sealed sent catalog even if the caller mutates it during transport", async () => {
    const choices: Record<string, string> = { ...skillChoices };
    let requests = 0;
    const run = provider(async (_url, init) => {
      requests++;
      expect(JSON.parse(init.body as string).questions.next.criteria).toEqual(skillChoices);
      delete choices.skill_1;
      choices.skill_99 = "Added after request";
      return jsonResponse(candidateFixture("skill_1"));
    });
    expect(await run({ ...evidence, choices }, new AbortController().signal)).toEqual({
      choice: "skill_1",
      confidence: 0.94,
    });
    expect(requests).toBe(1);
    const invalid = provider(async () => jsonResponse(candidateFixture("skill_99", choices)));
    await expect(
      invalid({ ...evidence, choices: skillChoices }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "JEV_INVALID_RESPONSE" });
  });
  test("catalog overflow fails before credentials or transport and never sends a partial list", async () => {
    let touched = false;
    const run = createJevProvider(options, {
      readApiKey: () => {
        touched = true;
        return fakeKey;
      },
      fetch: async () => {
        touched = true;
        return jsonResponse();
      },
    });
    await expect(
      run({ ...evidence, choices: { skill_0: "x".repeat(65537) } }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "JEV_CATALOG_TOO_LARGE" });
    expect(touched).toBe(false);
  });

  test("awaits credentials at invocation before authenticating the request", async () => {
    const { promise: credential, resolve: resolveKey } = Promise.withResolvers<string>();
    let keyReads = 0;
    let requests = 0;
    const run = createJevProvider(options, {
      readApiKey: () => {
        keyReads++;
        return credential;
      },
      fetch: async (_, init) => {
        requests++;
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${fakeKey}`);
        return jsonResponse();
      },
    });
    expect(keyReads).toBe(0);
    const pending = run(evidence, new AbortController().signal);
    expect(keyReads).toBe(1);
    expect(requests).toBe(0);
    resolveKey(fakeKey);
    expect(await pending).toEqual({ choice: "continue", confidence: 0.94 });
    expect(requests).toBe(1);
  });
  interface CredentialFailureCase {
    readonly scenario: string;
    readonly readApiKey: NonNullable<JevDependencies["readApiKey"]>;
    readonly code: "JEV_MISSING_API_KEY" | "JEV_INVALID_API_KEY";
  }
  const credentialFailures: CredentialFailureCase[] = [
    {
      scenario: "an async missing credential fails before fetch",
      readApiKey: async () => undefined,
      code: "JEV_MISSING_API_KEY",
    },
    {
      scenario: "an async empty credential fails before fetch",
      readApiKey: async () => "",
      code: "JEV_MISSING_API_KEY",
    },
    {
      scenario: "an async credential containing header injection fails before fetch",
      readApiKey: async () => `${fakeKey}\r\ninjected`,
      code: "JEV_INVALID_API_KEY",
    },
    {
      scenario: "an async oversized credential fails before fetch",
      readApiKey: async () => "x".repeat(4097),
      code: "JEV_INVALID_API_KEY",
    },
    {
      scenario: "an async credential rejection is sanitized before fetch",
      readApiKey: async () => {
        throw new Error(`${fakeKey}: ${evidence.summary}`);
      },
      code: "JEV_MISSING_API_KEY",
    },
    {
      scenario: "a synchronous credential exception is sanitized before fetch",
      readApiKey: () => {
        throw new Error(`${fakeKey}: ${evidence.summary}`);
      },
      code: "JEV_MISSING_API_KEY",
    },
  ];
  test.each(credentialFailures)("$scenario", async ({ readApiKey, code }) => {
    let requests = 0;
    const run = createJevProvider(options, {
      readApiKey,
      fetch: async () => {
        requests++;
        return jsonResponse();
      },
    });
    const error = await run(evidence, new AbortController().signal).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(JevError);
    expect((error as JevError).code).toBe(code);
    expect((error as Error).message).toBe(code);
    expect(String(error)).not.toContain(fakeKey);
    expect(String(error)).not.toContain(evidence.summary);
    expect(error).not.toHaveProperty("cause");
    expect(requests).toBe(0);
  });
  interface PendingCredentialCase {
    readonly scenario: string;
    readonly timeoutMs: number;
    readonly interrupt: (controller: AbortController) => void;
    readonly settleLate: (resolve: (key: string) => void, reject: (error: Error) => void) => void;
    readonly code: "JEV_TIMEOUT" | "JEV_ABORTED";
  }
  const pendingCredentials: PendingCredentialCase[] = [
    {
      scenario: "credential timeout prevents a later resolved key from sending HTTP",
      timeoutMs: 10,
      interrupt: () => vi.advanceTimersByTime(10),
      settleLate: (resolve) => resolve(fakeKey),
      code: "JEV_TIMEOUT",
    },
    {
      scenario: "credential timeout consumes a later credential rejection",
      timeoutMs: 10,
      interrupt: () => vi.advanceTimersByTime(10),
      settleLate: (_, reject) => reject(new Error(`${fakeKey}: ${evidence.summary}`)),
      code: "JEV_TIMEOUT",
    },
    {
      scenario: "caller cancellation prevents a later resolved key from sending HTTP",
      timeoutMs: 1000,
      interrupt: (controller) => controller.abort(new Error("private cancellation reason")),
      settleLate: (resolve) => resolve(fakeKey),
      code: "JEV_ABORTED",
    },
    {
      scenario: "caller cancellation consumes a later credential rejection",
      timeoutMs: 1000,
      interrupt: (controller) => controller.abort(new Error("private cancellation reason")),
      settleLate: (_, reject) => reject(new Error(`${fakeKey}: ${evidence.summary}`)),
      code: "JEV_ABORTED",
    },
  ];
  test.each(pendingCredentials)("$scenario", async ({ timeoutMs, interrupt, settleLate, code }) => {
    const {
      promise: credential,
      resolve: resolveKey,
      reject: rejectKey,
    } = Promise.withResolvers<string>();
    let keyReads = 0;
    let requests = 0;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const controller = new AbortController();
    const run = createJevProvider(
      { ...options, timeoutMs },
      {
        readApiKey: () => {
          keyReads++;
          return credential;
        },
        fetch: async () => {
          requests++;
          return jsonResponse();
        },
      },
    );
    process.on("unhandledRejection", onUnhandled);
    vi.useFakeTimers();
    try {
      const pending = run(evidence, controller.signal);
      expect(keyReads).toBe(1);
      expect(requests).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      interrupt(controller);
      await expect(pending).rejects.toThrow(code);
      expect(vi.getTimerCount()).toBe(0);
      expect(requests).toBe(0);
      vi.useRealTimers();
      settleLate(resolveKey, rejectKey);
      await nextTurn();
      expect(requests).toBe(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });
  test("missing and invalid synthetic keys fail before fetch", async () => {
    for (const key of [undefined, "", "secret\r\ninjected", "x".repeat(4097)]) {
      let calls = 0;
      const run = createJevProvider(options, {
        readApiKey: () => key,
        fetch: async () => {
          calls++;
          return jsonResponse();
        },
      });
      await expect(run(evidence, new AbortController().signal)).rejects.toThrow(
        key ? "JEV_INVALID_API_KEY" : "JEV_MISSING_API_KEY",
      );
      expect(calls).toBe(0);
    }
  });
  test("aborted requests never read a key or send data", async () => {
    const controller = new AbortController();
    controller.abort(new Error("private abort reason"));
    const run = createJevProvider(options, {
      readApiKey: () => {
        throw new Error("must not read");
      },
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    await expect(run(evidence, controller.signal)).rejects.toThrow("JEV_ABORTED");
  });
  test("safe errors discard response bodies and never retry HTTP failures", async () => {
    for (const status of [301, 401, 422, 429, 500, 529]) {
      let requests = 0;
      const run = provider(async () => {
        requests++;
        return new Response(`private-body ${fakeKey}`, { status });
      });
      await expect(run(evidence, new AbortController().signal)).rejects.toThrow("JEV_HTTP_ERROR");
      expect(requests).toBe(1);
    }
  });
  test("network exceptions are sanitized and never retried", async () => {
    let requests = 0;
    const run = provider(async () => {
      requests++;
      throw new Error(`${fakeKey}: ${evidence.summary}`);
    });
    await expect(run(evidence, new AbortController().signal)).rejects.toThrow("JEV_NETWORK_ERROR");
    expect(requests).toBe(1);
  });
  test("declared and streamed oversized responses are cancelled", async () => {
    for (const declared of [false, true]) {
      let cancelled = false;
      const run = provider(async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(32769));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, {
          headers: declared ? { "content-length": "32769" } : {},
        });
      });
      await expect(run(evidence, new AbortController().signal)).rejects.toThrow(
        "JEV_RESPONSE_TOO_LARGE",
      );
      expect(cancelled).toBe(true);
    }
  });
  test("times out even if fetch ignores its AbortSignal", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const run = provider(
      async (_, init) => {
        requestSignal = init.signal;
        return new Promise<Response>(() => {});
      },
      { timeoutMs: 10 },
    );
    await expect(run(evidence, new AbortController().signal)).rejects.toThrow("JEV_TIMEOUT");
    expect(requestSignal?.aborted).toBe(true);
  });
  test("caller cancellation interrupts fetch without exposing its abort reason", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const { promise: fetching, resolve: startedFetch } = Promise.withResolvers<void>();
    const run = provider(async (_, init) => {
      requestSignal = init.signal;
      startedFetch();
      return new Promise<Response>(() => {});
    });
    const pending = run(evidence, controller.signal);
    await fetching;
    controller.abort(new Error("private cancellation reason"));
    await expect(pending).rejects.toThrow("JEV_ABORTED");
    expect(requestSignal?.aborted).toBe(true);
  });
  test("response streaming is covered by timeout and its reader is cancelled", async () => {
    let cancelled = false;
    const run = provider(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"model":'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
      { timeoutMs: 10 },
    );
    await expect(run(evidence, new AbortController().signal)).rejects.toThrow("JEV_TIMEOUT");
    expect(cancelled).toBe(true);
  });
  test("success removes caller cancellation handlers and clears its deadline", async () => {
    let requestSignal: AbortSignal | null | undefined;
    const controller = new AbortController();
    const run = provider(
      async (_, init) => {
        requestSignal = init.signal;
        return jsonResponse();
      },
      { timeoutMs: 10 },
    );
    await run(evidence, controller.signal);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(requestSignal?.aborted).toBe(false);
  });
});

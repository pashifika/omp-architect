import { expect, test } from "bun:test";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { NativeAsyncHost } from "../src/auto/async.ts";
import {
  nativeProducerModel,
  nativeResultModel,
  nativeReuseError,
  nativeRouteMatches,
  nativeStageReuseError,
  nativeStageRouteMatches,
  resolveNativeRoleRoute,
} from "../src/auto/model-route.ts";

type NativeModel = NonNullable<AgentSession["model"]>;
type NativeModels = NonNullable<Parameters<typeof resolveNativeRoleRoute>[2]>;
type NativeRef = NonNullable<ReturnType<NativeAsyncHost["registry"]["get"]>>;

const model = (id: string, provider = "fixture"): NativeModel =>
  ({
    provider,
    id,
    name: id,
    api: "openai-completions",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    contextWindow: 10000,
    maxTokens: 1000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    thinking: { efforts: ["low", "medium", "high"] },
  }) as unknown as NativeModel;

/**
 * A read-only host facade fixture: resolved models are supplied by the host,
 * not by a duplicate of OMP's fuzzy matcher. No provider or full SDK runtime.
 */
function fixture(roleOverrides: Record<string, string> = {}) {
  const models = [model("sonnet"), model("worker"), model("reviewer")];
  const roles: Record<string, string> = {
    implementation: "fixture/worker:medium",
    architect: "fixture/reviewer:high",
    research: "fixture/sonnet:low",
    ...roleOverrides,
  };
  const resolved = new Map<string, NativeModel>();
  const bind = (selector: string, selected: NativeModel) => {
    resolved.set(selector, selected);
    // OMP's facade returns the model but discards suffix metadata. Invalid
    // suffixes can also resolve with a native warning; admission must reject.
    for (const level of ["off", "low", "medium", "high", "xhigh", "auto", "inherit", "typo", "hi"])
      resolved.set(`${selector}:${level}`, selected);
  };
  for (const selected of models) {
    bind(selected.id, selected);
    bind(`${selected.provider}/${selected.id}`, selected);
  }
  for (const [role, selected] of [
    ["implementation", models[1]],
    ["architect", models[2]],
    ["research", models[0]],
  ] as const) {
    bind(`@${role}`, selected);
    bind(`pi/${role}`, selected);
  }
  const refs = new Map<string, NativeRef>();
  const session = {
    model: models[1],
    thinkingLevel: "medium",
    settings: { getModelRole: (role: string) => roles[role] },
    modelRegistry: { getAvailable: () => models },
    getAgentId: () => "Main",
  } as unknown as AgentSession;
  const registry = {
    get: (id: string) => refs.get(id),
    list: () => [...refs.values()],
  } as unknown as NativeAsyncHost["registry"];
  const host: NativeAsyncHost = { session, registry };
  const query: NativeModels = {
    current: () => session.model,
    list: () => models,
    resolve: (selector: string) => resolved.get(selector),
  };
  const resolve = (role: string, selector?: string) =>
    resolveNativeRoleRoute(role, host, query, selector);
  const child = (selected: NativeModel = models[0], thinkingLevel = "high") => {
    const ref = {
      id: "leaf",
      parentId: "Main",
      kind: "sub",
      displayName: "Leaf",
      session: { model: selected, thinkingLevel } as AgentSession,
      status: "idle",
    } as NativeRef;
    refs.set(ref.id, ref);
    return ref;
  };
  return { models, roles, resolved, bind, host, query, resolve, child };
}

test("native role aliases retain the exact configured selector effort without a stage", () => {
  const { resolve } = fixture();
  expect(resolve("omp-worker").route?.selector).toBe("fixture/worker:medium");
  expect(resolve("omp-reviewer").route?.selector).toBe("fixture/reviewer:high");
  expect(resolve("omp-explorer").route?.selector).toBe("fixture/sonnet:low");
  for (const alias of ["@implementation", "pi/implementation"])
    expect(resolve("omp-worker", alias).route?.selector).toBe("fixture/worker:medium");
});

test("the supplied native role selector is authoritative", () => {
  const { resolve } = fixture();
  expect(resolve("omp-worker", "@architect").route?.selector).toBe("fixture/reviewer:high");
  expect(resolve("omp-reviewer", "  sonnet:low  ").route).toEqual({
    provider: "fixture",
    id: "sonnet",
    modelIdentity: "fixture/sonnet",
    selector: "fixture/sonnet:low",
    thinkingLevel: "low",
  });
});

test("plain native selectors do not invent an effort constraint", () => {
  const { resolve } = fixture();
  expect(resolve("omp-worker", "sonnet").route).toEqual({
    provider: "fixture",
    id: "sonnet",
    modelIdentity: "fixture/sonnet",
    selector: "fixture/sonnet",
  });
});

test("custom role aliases and fallback lists retain the selected configured suffix", () => {
  const { models, bind, resolve } = fixture({
    architect: "unavailable:low, fixture/reviewer:high",
    custom: "@architect",
  });
  bind("@custom", models[2]);
  expect(resolve("omp-reviewer", "@architect").route?.selector).toBe("fixture/reviewer:high");
  expect(resolve("custom-agent", "@custom").route?.selector).toBe("fixture/reviewer:high");
  expect(resolve("omp-worker", "unavailable:high, worker:low").route?.selector).toBe(
    "fixture/worker:low",
  );
});

test("an explicit native role suffix is preserved over its configured suffix", () => {
  const { resolve } = fixture();
  expect(resolve("omp-worker", "@implementation:high").route?.selector).toBe("fixture/worker:high");
});

test("explicit default aliases inherit the live model and effort instead of stale configured default", () => {
  const { resolve, host, models } = fixture({ default: "fixture/sonnet:high" });
  for (const alias of ["@default", "default", "*", "pi/default"]) {
    expect(resolve("omp-worker", alias).route?.selector).toBe("fixture/worker:medium");
    expect(resolve("omp-worker", `${alias}:high`).route?.selector).toBe("fixture/worker:high");
  }
  expect(resolve("omp-worker", "unavailable,@default:high").route?.selector).toBe(
    "fixture/worker:high",
  );
  Object.assign(host.session, { model: models[2], thinkingLevel: "low" });
  expect(resolve("omp-worker", "@default").route?.selector).toBe("fixture/reviewer:low");
});

test("missing facade, unknown roles and unavailable models fail closed", () => {
  const { host, resolve } = fixture();
  expect(resolveNativeRoleRoute("omp-worker", host).error).toContain("model query facade");
  expect(resolve("unknown-agent").error).toContain("cannot resolve");
  expect(resolve("omp-worker", "no-such-model").error).toContain("unavailable");
  Object.assign(host.session, { model: undefined });
  expect(resolve("omp-worker", "@default").error).toContain("unavailable");
});

test("unsupported suffixes and unavailable exact efforts are never silently downgraded", () => {
  const { resolve } = fixture();
  expect(resolve("omp-worker", "sonnet:typo").error).toContain("Unsupported native thinking");
  expect(resolve("omp-worker", "sonnet:hi").error).toContain("Unsupported native thinking");
  expect(resolve("omp-worker", "sonnet:xhigh").error).toContain("cannot honor thinking level");
  expect(resolve("omp-worker", "@default:typo").error).toContain("Unsupported native thinking");
  for (const selector of ["sonnet:auto", "sonnet:inherit", "@default:auto"])
    expect(resolve("omp-worker", selector).error).toContain("concrete supported");
});

test("dynamic configured effort cannot be replaced by synthetic action effort", () => {
  const { resolve } = fixture({ architect: "fixture/reviewer:auto" });
  expect(resolve("omp-reviewer").error).toContain("concrete supported");
  expect(resolve("omp-reviewer", "@architect:high").route?.selector).toBe("fixture/reviewer:high");
});

test("effort support comes from native capabilities, including non-reasoning off", () => {
  const { models, resolve } = fixture();
  Object.assign(models[0], { reasoning: false });
  expect(resolve("omp-worker", "sonnet:high").error).toContain("cannot honor thinking level");
  expect(resolve("omp-worker", "sonnet:off").route?.thinkingLevel).toBe("off");
});

test("literal colon model IDs are not mistaken for effort selectors", () => {
  const { models, bind, resolve } = fixture();
  const literal = model("literal:high");
  models.push(literal);
  bind("literal:high", literal);
  bind("fixture/literal:high", literal);
  for (const selector of ["literal:high", "fixture/literal:high"]) {
    expect(resolve("omp-worker", selector).route?.id).toBe("literal:high");
    expect(resolve("omp-worker", selector).route?.thinkingLevel).toBeUndefined();
  }
  expect(resolve("omp-worker", "fixture/literal:high:low").route?.thinkingLevel).toBe("low");
});

test("changed and cyclic role resolution cannot produce a fabricated route", () => {
  const changed = fixture({ architect: "fixture/worker:high" });
  expect(changed.resolve("omp-reviewer").error).toContain("resolution changed");
  const cycle = fixture({ architect: "@architect" });
  expect(cycle.resolve("omp-reviewer").error).toContain("Cyclic native model role selector");
});

test("native upstream routing metadata is exact and ambiguous routing fails closed", () => {
  const { models, bind, resolve } = fixture();
  const routed = model("routed", "gateway");
  Object.assign(routed, { compat: { openRouterRouting: { only: ["upstream-a"] } } });
  models.push(routed);
  bind("routed", routed);
  expect(resolve("omp-worker", "routed:high").route?.selector).toBe(
    "gateway/routed@upstream-a:high",
  );
  Object.assign(routed, {
    compat: {
      openRouterRouting: { only: ["upstream-a"] },
      vercelGatewayRouting: { only: ["upstream-b"] },
    },
  });
  expect(resolve("omp-worker", "routed").error).toContain("ambiguous routing metadata");
});

test("reuse requires a live direct child with matching native provider, model and effort", () => {
  const { host, resolve, child } = fixture();
  const route = resolve("omp-worker", "sonnet:high").route!;
  const ref = child();
  expect(nativeReuseError(host, "leaf", route)).toBeUndefined();
  Object.assign(ref.session!, { thinkingLevel: "medium" });
  expect(nativeReuseError(host, "leaf", route)).toContain("fresh native task");
  Object.assign(ref.session!, { thinkingLevel: "high", model: model("sonnet", "other-provider") });
  expect(nativeReuseError(host, "leaf", route)).toContain("fresh native task");
  Object.assign(ref.session!, { model: model("worker") });
  expect(nativeReuseError(host, "leaf", route)).toContain("fresh native task");
  Object.assign(ref.session!, { model: model("sonnet"), configuredThinkingLevel: () => "auto" });
  expect(nativeReuseError(host, "leaf", route)).toContain("fresh native task");
  Object.assign(ref.session!, { configuredThinkingLevel: () => "high" });
  ref.parentId = "Other";
  expect(nativeReuseError(host, "leaf", route)).toContain("fresh native task");
  ref.parentId = "Main";
  ref.session = null;
  ref.status = "parked";
  expect(nativeReuseError(host, "leaf", route)).toContain("fresh native task");
  for (const recipient of ["all", "missing", undefined])
    expect(nativeReuseError(host, recipient, route)).toContain("fresh native task");
  expect(nativeReuseError(host, "missing", undefined)).toBeUndefined();
});

test("producer matching compares exact provenance, never selector assertions", () => {
  const { resolve } = fixture();
  const route = resolve("omp-worker", "sonnet:high").route!;
  const actual = { ...route };
  expect(nativeRouteMatches(route, actual)).toBe(true);
  expect(nativeRouteMatches(route, undefined)).toBe(false);
  for (const mismatch of [
    { provider: "other" },
    { id: "sonnet-other" },
    { modelIdentity: "fixture/sonnet@another-upstream" },
    { thinkingLevel: "medium" },
    { thinkingLevel: undefined },
  ])
    expect(nativeRouteMatches(route, { ...actual, ...mismatch })).toBe(false);
  expect(nativeRouteMatches(resolve("omp-worker", "sonnet").route!, actual)).toBe(true);
});

test("native attribution uses actual result metadata instead of requested model assertions", () => {
  const { host, resolve } = fixture();
  expect(
    nativeResultModel({ model: "fixture/sonnet", modelOverride: "fixture/sonnet" }, host),
  ).toBeUndefined();
  expect(
    nativeResultModel({ resolvedModelIdentity: "sonnet", resolvedThinkingLevel: "high" }, host),
  ).toBeUndefined();
  for (const level of ["auto", "typo", 3])
    expect(
      nativeResultModel(
        { resolvedModelIdentity: "fixture/sonnet", resolvedThinkingLevel: level },
        host,
      ),
    ).toBeUndefined();
  expect(
    nativeResultModel(
      { resolvedModelIdentity: "fixture/sonnet", resolvedThinkingLevel: "high" },
      host,
    ),
  ).toEqual({
    provider: "fixture",
    id: "sonnet",
    modelIdentity: "fixture/sonnet",
    thinkingLevel: "high",
  });
  const expected = resolve("omp-worker", "sonnet:high").route!;
  expect(nativeRouteMatches(expected, nativeProducerModel(host.session))).toBe(false);
  expect(nativeProducerModel(undefined)).toBeUndefined();
});

test("native result attribution can prove a live child model absent from the registry catalog", () => {
  const { host, child } = fixture();
  const actual = model("custom-child");
  child(actual, "low");
  expect(
    nativeResultModel(
      { resolvedModelIdentity: "fixture/custom-child", resolvedThinkingLevel: "low" },
      host,
    ),
  ).toEqual({
    provider: "fixture",
    id: "custom-child",
    modelIdentity: "fixture/custom-child",
    thinkingLevel: "low",
  });
});

test("temporary compatibility helper exports preserve neutral behavior", () => {
  expect(nativeStageRouteMatches).toBe(nativeRouteMatches);
  expect(nativeStageReuseError).toBe(nativeReuseError);
});

test("role routing loads from isolated source without SDK runtime or workflow files", async () => {
  const { copyFile, mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "omp-native-role-route-"));
  try {
    const filename = join(root, "model-route.ts");
    await copyFile(join(import.meta.dir, "../src/auto/model-route.ts"), filename);
    const isolated = await import(pathToFileURL(filename).href);
    const { host, query } = fixture();
    expect(isolated.resolveNativeRoleRoute("omp-reviewer", host, query).route?.selector).toBe(
      "fixture/reviewer:high",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parked native reuse needs exact same-ref task attribution and preserved journal identity", () => {
  const { host, child, resolve } = fixture();
  const ref = child();
  const route = resolve("omp-worker", "sonnet:high").route!;
  const provenance = {
    ref,
    sessionFile: "/native/leaf.jsonl",
    model: nativeProducerModel(ref.session)!,
  };
  ref.sessionFile = provenance.sessionFile;
  ref.session = null;
  ref.status = "parked";
  expect(nativeReuseError(host, "leaf", route, provenance)).toBeUndefined();
  expect(nativeReuseError(host, "leaf", route)).toContain("fresh native task");
  expect(
    nativeReuseError(host, "leaf", route, { ...provenance, sessionFile: "/different.jsonl" }),
  ).toContain("fresh native task");
  expect(
    nativeReuseError(host, "leaf", route, {
      ...provenance,
      model: { ...provenance.model, thinkingLevel: "low" },
    }),
  ).toContain("fresh native task");
  ref.status = "aborted";
  expect(nativeReuseError(host, "leaf", route, provenance)).toContain("fresh native task");
  ref.status = "parked";
  ref.session = { model: model("worker"), thinkingLevel: "high" } as AgentSession;
  expect(nativeReuseError(host, "leaf", route, provenance)).toContain("fresh native task");
  const replacement = child();
  replacement.status = "parked";
  replacement.session = null;
  replacement.sessionFile = provenance.sessionFile;
  expect(nativeReuseError(host, "leaf", route, provenance)).toContain("fresh native task");
});

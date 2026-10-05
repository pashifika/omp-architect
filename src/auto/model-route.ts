import type { AgentSession, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { NativeAsyncHost } from "./async.ts";

type NativeModel = NonNullable<AgentSession["model"]>;
type NativeModels = Pick<ExtensionContext["models"], "resolve" | "list" | "current">;

/** Exact native identity, never a family-name substring or a worker assertion. */
export interface NativeProducerModel {
  provider: string;
  id: string;
  modelIdentity: string;
  thinkingLevel?: string;
}
export interface NativeModelRoute extends NativeProducerModel {
  /** Explicit task selector; no dependency on the optional task effort schema. */
  selector: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read native routing metadata, without model-name/family/provider guessing. */
function modelIdentity(model: NativeModel): string {
  const compat = record(model.compat);
  const upstreams = [compat?.openRouterRouting, compat?.vercelGatewayRouting].flatMap((routing) => {
    const only = record(routing)?.only;
    return Array.isArray(only) && only.length === 1 && typeof only[0] === "string" && only[0]
      ? [only[0]]
      : [];
  });
  if (new Set(upstreams).size > 1) throw new Error("Native model has ambiguous routing metadata");
  return `${model.provider}/${model.id}${upstreams.length ? `@${upstreams[0]}` : ""}`;
}

// These are protocol values, not a model matcher. Supported efforts come only
// from the model's native baked capability metadata, never its name/provider.
const concreteLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const inheritedAliases = new Set(["@default", "default", "*", "pi/default"]);
function inheritedSelector(spec: string): { level?: string } | undefined {
  const colon = spec.lastIndexOf(":");
  const base = colon < 0 ? spec : spec.slice(0, colon);
  return inheritedAliases.has(base)
    ? colon < 0
      ? {}
      : { level: spec.slice(colon + 1) }
    : undefined;
}
function knownSelectorLevel(level: string): boolean {
  return concreteLevels.has(level) || level === "auto" || level === "inherit";
}
/** Task's explicit default aliases refer to the live session, not modelRoles.default. */
function selectedModel(spec: string, models: NativeModels): NativeModel | undefined {
  if (inheritedSelector(spec)) return models.current();
  if (spec.includes(",")) {
    for (const candidate of spec
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const model = selectedModel(candidate, models);
      if (model) return model;
    }
    return;
  }
  return models.resolve(spec);
}

function supportsLevel(model: NativeModel, level: string): boolean {
  return (
    level === "off" ||
    (model.reasoning === true &&
      (model.thinking?.efforts as readonly string[] | undefined)?.includes(level) === true)
  );
}
function sameModel(left: NativeModel, right: NativeModel): boolean {
  return (
    left.provider === right.provider &&
    left.id === right.id &&
    modelIdentity(left) === modelIdentity(right)
  );
}

/** Read an explicit selector suffix while preserving literal model IDs with colons. */
function selectorLevel(
  spec: string,
  selected: NativeModel,
  models: NativeModels,
  session: AgentSession,
  seen = new Set<string>(),
): string | undefined {
  if (seen.has(spec)) throw new Error("Cyclic native model role selector");
  seen.add(spec);
  const inherited = inheritedSelector(spec);
  if (inherited) {
    if (inherited.level !== undefined && !knownSelectorLevel(inherited.level))
      throw new Error(`Unsupported native thinking selector ${inherited.level}`);
    return inherited.level ?? session.thinkingLevel;
  }

  if (models.list().some((model) => spec === model.id || spec === modelIdentity(model))) return;
  if (spec.includes(",")) {
    for (const candidate of spec
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const resolved = selectedModel(candidate, models);
      if (resolved && sameModel(resolved, selected))
        return selectorLevel(candidate, selected, models, session, seen);
    }
    throw new Error("Native selector resolution changed during admission");
  }
  const colon = spec.lastIndexOf(":");
  if (colon >= 0) {
    const level = spec.slice(colon + 1);
    const base = selectedModel(spec.slice(0, colon), models);
    if (base && sameModel(base, selected)) {
      if (!knownSelectorLevel(level))
        throw new Error(`Unsupported native thinking selector ${level}`);
      return level;
    }
  }
  // The facade intentionally discards thinking suffixes. Resolve configured
  // role candidates through that same facade, retaining their policy suffix.
  const role = spec.startsWith("@")
    ? spec.slice(1)
    : spec.startsWith("pi/")
      ? spec.slice(3)
      : undefined;
  const configured = role ? session.settings?.getModelRole(role) : undefined;
  if (configured) {
    for (const candidate of configured
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)) {
      const resolved = selectedModel(candidate, models);
      if (resolved && sameModel(resolved, selected))
        return selectorLevel(candidate, selected, models, session, seen);
    }
    throw new Error("Native role resolution changed during admission");
  }
}

/**
 * Resolve the configured native role through the public host facade. There is
 * no workflow-stage model or effort override: the native selector is authoritative.
 * Runtime imports of source SDK resolver/thinking modules break source-pruned
 * bundled OMP installations.
 */
export function resolveNativeRoleRoute(
  role: string,
  host: NativeAsyncHost,
  models?: NativeModels,
  selector?: string,
): { route?: NativeModelRoute; error?: string } {
  try {
    if (!models)
      return { error: `Native role ${role} cannot verify the native model query facade` };
    selector =
      selector?.trim() ||
      (role === "omp-reviewer"
        ? "@architect"
        : role === "omp-worker"
          ? "@implementation"
          : role === "omp-explorer"
            ? "@research"
            : undefined);
    if (!selector) return { error: `Native role ${role} cannot resolve a native model selector` };
    const model = selectedModel(selector, models);
    if (!model) return { error: `Native role ${role} model is unavailable: ${selector}` };
    const level = selectorLevel(selector, model, models, host.session);
    if (level !== undefined && !concreteLevels.has(level))
      return {
        error: `Native role ${role} needs a concrete supported native thinking level instead of ${level}; coarse/dynamic effort cannot be verified through this host facade`,
      };
    if (level !== undefined && !supportsLevel(model, level))
      return { error: `Native role ${role} model cannot honor thinking level ${level}` };
    const identity = modelIdentity(model);
    return {
      route: {
        provider: model.provider,
        id: model.id,
        modelIdentity: identity,
        ...(level !== undefined ? { thinkingLevel: level } : {}),
        selector: `${identity}${level !== undefined ? `:${level}` : ""}`,
      },
    };
  } catch (error) {
    return {
      error: `Native role ${role} model resolution failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function nativeRouteMatches(
  expected: NativeModelRoute,
  actual: NativeProducerModel | undefined,
): boolean {
  return (
    !!actual &&
    actual.provider === expected.provider &&
    actual.id === expected.id &&
    actual.modelIdentity === expected.modelIdentity &&
    (expected.thinkingLevel === undefined || actual.thinkingLevel === expected.thinkingLevel)
  );
}

/** Current live configuration is authoritative for whether a worker can be reused. */
export function nativeProducerModel(
  session: AgentSession | null | undefined,
): NativeProducerModel | undefined {
  const model = session?.model;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string") return;
  return {
    provider: model.provider,
    id: model.id,
    modelIdentity: modelIdentity(model),
    ...(session.thinkingLevel !== undefined ? { thinkingLevel: session.thinkingLevel } : {}),
  };
}

/** Read exact native result attribution; no requested-selector or fuzzy-match fallback. */
export function nativeResultModel(
  value: Record<string, unknown> | undefined,
  host: NativeAsyncHost,
): NativeProducerModel | undefined {
  if (typeof value?.resolvedModelIdentity !== "string") return;
  const models = host.session.modelRegistry?.getAvailable() ?? [];
  const liveModels = host.registry
    .list()
    .flatMap((ref) => (ref.session?.model ? [ref.session.model] : []));
  const model = [...models, ...liveModels].find(
    (candidate) => modelIdentity(candidate) === value.resolvedModelIdentity,
  );
  if (!model) return;
  const level = value.resolvedThinkingLevel;
  if (level !== undefined && (typeof level !== "string" || !concreteLevels.has(level))) return;
  return {
    provider: model.provider,
    id: model.id,
    modelIdentity: value.resolvedModelIdentity,
    ...(typeof level === "string" ? { thinkingLevel: level } : {}),
  };
}

/** Exact native task attribution retained for a same-ref parked continuation. */
export interface NativeRecipientProvenance {
  ref: NonNullable<ReturnType<NativeAsyncHost["registry"]["get"]>>;
  sessionFile: string;
  model: NativeProducerModel;
}

/**
 * Live configuration wins. A parked native continuation may use exact task
 * attribution bound to that same ref and journal; arbitrary history display
 * metadata is insufficient. Its later native receipt must still match the route.
 */
export function nativeReuseError(
  host: NativeAsyncHost,
  recipient: string | undefined,
  route: NativeModelRoute | undefined,
  provenance?: NativeRecipientProvenance,
): string | undefined {
  if (!route) return;
  const ref = recipient && recipient !== "all" ? host.registry.get(recipient.trim()) : undefined;
  const live = ref?.session;
  const matches = live
    ? nativeRouteMatches(route, nativeProducerModel(live)) &&
      !(route.thinkingLevel !== undefined && live.configuredThinkingLevel?.() === "auto")
    : ref?.status === "parked" &&
      !!provenance &&
      provenance.ref === ref &&
      !!ref.sessionFile &&
      provenance.sessionFile === ref.sessionFile &&
      nativeRouteMatches(route, provenance.model);
  if (!ref || ref.parentId !== host.session.getAgentId() || !matches)
    return `Native recipient ${recipient ?? "(unknown)"} has no verified ${route.selector} route; use a fresh native task with model=${route.selector}`;
}

// Transitional names for existing evidence consumers.
export { nativeRouteMatches as nativeStageRouteMatches, nativeReuseError as nativeStageReuseError };

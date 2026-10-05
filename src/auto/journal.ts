import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Small facts in OMP's own branch history; skill-owned files are unrelated. */
export const AUTO_JOURNAL_TYPE = "omp-architect:auto-event";
export const MAX_AUTO_EVENT_BYTES = 32768;

export interface AutoChangeIdentity {
  change: string;
  root: string;
  schema: string;
}

export interface AutoJournalDecision {
  choice: string;
  criterion: string;
  confidence: number;
  evidenceRefs: string[];
}

/** Preserve native metadata exactly. Full evidence belongs in native artifacts. */
export type AutoNativeReceipt = Record<string, unknown>;

interface AutoEventBase {
  version: 1;
  eventId: string;
  runId: string;
  at: number;
  changeIdentity: AutoChangeIdentity;
  inputFingerprint: string;
  outputFingerprint?: string;
  decision?: AutoJournalDecision;
  nativeReceipts?: AutoNativeReceipt[];
  reason?: string;
  status?: string;
}

interface AutoActionEvent extends AutoEventBase {
  actionId: string;
  skill: string;
}

export type AutoEvent =
  | (AutoEventBase & { kind: "run-start" | "run-stop" })
  | (AutoActionEvent & {
      kind: "action-selected" | "action-admitted";
      decision: AutoJournalDecision;
    })
  | (AutoActionEvent & { kind: "action-held" })
  | (AutoActionEvent & {
      kind: "action-settled";
      outcome: "progress" | "success" | "blocked" | "needs_user" | "failed" | "cancelled";
      outputFingerprint: string;
      nativeReceipts: AutoNativeReceipt[];
    });

export interface AutoHistoryDiagnostic {
  entryId: string;
  code:
    | "invalid_payload"
    | "oversized_payload"
    | "unsupported_version"
    | "duplicate_event"
    | "conflicting_action"
    | "replayed_receipt"
    | "unreadable_branch";
  message: string;
}

export interface AutoHistory {
  records: AutoEvent[];
  diagnostics: AutoHistoryDiagnostic[];
  valid: boolean;
}

type JournalWriter = Pick<ExtensionAPI, "appendEntry">;
type JournalReader = Pick<ExtensionContext["sessionManager"], "getBranch">;
type Data = Record<string, unknown>;
const object = (value: unknown): value is Data =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !value.includes("\0");
const identity = (value: unknown): value is AutoChangeIdentity =>
  object(value) && text(value.change) && text(value.root, 4096) && text(value.schema);
const sameChange = (a: AutoChangeIdentity, b: AutoChangeIdentity): boolean =>
  a.change === b.change && a.root === b.root && a.schema === b.schema;
const key = (...parts: string[]): string => JSON.stringify(parts);

class InvalidEvent extends Error {
  constructor(
    readonly code: "invalid_payload" | "oversized_payload" | "unsupported_version",
    message: string,
  ) {
    super(message);
  }
}

function invalid(message: string): never {
  throw new InvalidEvent("invalid_payload", message);
}

/** Reject executable/accessor/prototype payloads before serializing or inspecting fields. */
function boundedCopy(value: unknown): unknown {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 2048 || depth > 8)
      throw new InvalidEvent("oversized_payload", "Auto event exceeds structural limits");
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item, "utf8");
      if (bytes > MAX_AUTO_EVENT_BYTES)
        throw new InvalidEvent("oversized_payload", "Auto event exceeds byte limit");
      return;
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (typeof item !== "object") invalid("Auto event must contain only JSON data");
    if (ancestors.has(item)) invalid("Auto event contains a cycle");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      invalid("Auto event contains a non-JSON prototype");
    const keys = Reflect.ownKeys(item);
    if (keys.length > (array ? 65 : 64))
      throw new InvalidEvent("oversized_payload", "Auto event contains too many fields or items");
    ancestors.add(item);
    for (const name of keys) {
      if (array && name === "length") continue;
      if (
        typeof name !== "string" ||
        ["__proto__", "constructor", "prototype"].includes(name) ||
        (array &&
          (!/^\d+$/.test(name) || String(Number(name)) !== name || Number(name) >= item.length))
      )
        invalid("Auto event contains an unsafe field");
      const descriptor = Object.getOwnPropertyDescriptor(item, name);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        invalid("Auto event contains an accessor or hidden field");
      bytes += Buffer.byteLength(name, "utf8");
      visit(descriptor.value, depth + 1);
    }
    if (array && keys.length !== item.length + 1) invalid("Auto event contains a sparse array");
    ancestors.delete(item);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_AUTO_EVENT_BYTES)
    throw new InvalidEvent("oversized_payload", "Auto event exceeds byte limit");
  return JSON.parse(serialized);
}

function decision(value: unknown): value is AutoJournalDecision {
  return (
    object(value) &&
    text(value.choice) &&
    text(value.criterion, 16384) &&
    typeof value.confidence === "number" &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.length <= 32 &&
    value.evidenceRefs.every((ref) => text(ref, 2048))
  );
}

/** A reference identifies native evidence, never proves its success or freshness. */
function receiptKey(receipt: AutoNativeReceipt): string | undefined {
  const producer = object(receipt.producer) ? receipt.producer : receipt;
  const id = text(producer.receiptId, 2048)
    ? producer.receiptId
    : text(receipt.toolCallId, 2048)
      ? receipt.toolCallId
      : undefined;
  if (!id) return;
  const session = producer.sessionId ?? receipt.sessionId;
  if (session !== undefined && !text(session, 2048)) return;
  return key(typeof session === "string" ? session : "", id);
}

function parseEvent(value: unknown): AutoEvent {
  const data = boundedCopy(value);
  if (!object(data)) invalid("Auto event must be an object");
  if (data.version !== 1)
    throw new InvalidEvent("unsupported_version", "Unsupported Auto event version");
  if (
    !text(data.eventId) ||
    !text(data.runId) ||
    typeof data.at !== "number" ||
    !Number.isSafeInteger(data.at) ||
    data.at < 0 ||
    !identity(data.changeIdentity) ||
    !text(data.inputFingerprint)
  )
    invalid("Auto event is missing its run, change, timestamp, or input identity");
  if (data.outputFingerprint !== undefined && !text(data.outputFingerprint))
    invalid("Auto event has an invalid output fingerprint");
  if (data.decision !== undefined && !decision(data.decision))
    invalid("Auto event has an invalid decision");
  if (data.reason !== undefined && !text(data.reason, 4096)) invalid("Invalid Auto event reason");
  if (data.status !== undefined && !text(data.status)) invalid("Invalid Auto event status");
  if (
    data.nativeReceipts !== undefined &&
    (!Array.isArray(data.nativeReceipts) ||
      data.nativeReceipts.length > 32 ||
      !data.nativeReceipts.every((receipt) => object(receipt) && receiptKey(receipt)))
  )
    invalid("Auto event has invalid native receipt metadata");
  if (Array.isArray(data.nativeReceipts)) {
    const ids = data.nativeReceipts.map((receipt) => receiptKey(receipt));
    if (new Set(ids).size !== ids.length) invalid("Auto event repeats a native receipt identity");
  }
  if (data.kind === "run-start" || data.kind === "run-stop") {
    if (data.actionId !== undefined || data.skill !== undefined || data.outcome !== undefined)
      invalid("Run events cannot claim action identities or outcomes");
  } else if (
    ["action-selected", "action-admitted", "action-settled", "action-held"].includes(
      String(data.kind),
    )
  ) {
    if (!text(data.actionId) || !text(data.skill)) invalid("Action event lacks an action or skill");
    if (
      (data.kind === "action-selected" || data.kind === "action-admitted") &&
      !decision(data.decision)
    )
      invalid("Selected or admitted action lacks its decision");
    if (data.kind === "action-settled") {
      if (
        !["progress", "success", "blocked", "needs_user", "failed", "cancelled"].includes(
          String(data.outcome),
        ) ||
        !text(data.outputFingerprint) ||
        !Array.isArray(data.nativeReceipts)
      )
        invalid(
          "Settled action lacks an explicit outcome, output fingerprint, or native receipt list",
        );
    } else if (data.outcome !== undefined) invalid("Unsettled action cannot claim an outcome");
  } else invalid("Unsupported Auto event kind");
  const allowed = new Set([
    "version",
    "eventId",
    "runId",
    "at",
    "changeIdentity",
    "inputFingerprint",
    "outputFingerprint",
    "decision",
    "nativeReceipts",
    "reason",
    "status",
    "kind",
    "actionId",
    "skill",
    "outcome",
  ]);
  if (Object.keys(data).some((field) => !allowed.has(field))) invalid("Unknown Auto event field");
  return data as unknown as AutoEvent;
}

/** Validate and detach data before handing persistence to the native extension API. */
export function appendAutoEvent(api: JournalWriter, event: AutoEvent): void {
  api.appendEntry(AUTO_JOURNAL_TYPE, parseEvent(event));
}

/**
 * Return validated facts from the active OMP branch, never executable/resumable state.
 * Branch-wide integrity diagnostics make history invalid; callers must not treat partial
 * records as proof. Receipt identities are checked even across changes on this branch.
 * Incomplete and held actions stay as recorded. Reading never appends or runs anything.
 */
export function readAutoHistory(
  sessionManager: JournalReader,
  changeIdentity: AutoChangeIdentity,
): AutoHistory {
  if (!identity(boundedCopy(changeIdentity))) invalid("Invalid selected change identity");
  const records: AutoEvent[] = [];
  const diagnostics: AutoHistoryDiagnostic[] = [];
  const eventIds = new Set<string>();
  const actions = new Map<string, string>();
  const settledActions = new Set<string>();
  const receipts = new Map<string, string>();
  let entries: ReturnType<JournalReader["getBranch"]>;
  try {
    entries = sessionManager.getBranch();
  } catch {
    return {
      records,
      diagnostics: [
        { entryId: "", code: "unreadable_branch", message: "Cannot read native branch history" },
      ],
      valid: false,
    };
  }
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== AUTO_JOURNAL_TYPE) continue;
    const report = (code: AutoHistoryDiagnostic["code"], message: string): void => {
      diagnostics.push({ entryId: entry.id, code, message });
    };
    let event: AutoEvent;
    try {
      event = parseEvent(entry.data);
    } catch (error) {
      report(
        error instanceof InvalidEvent ? error.code : "invalid_payload",
        error instanceof InvalidEvent ? error.message : "Unreadable Auto event payload",
      );
      continue;
    }
    if (eventIds.has(event.eventId)) {
      report("duplicate_event", "Repeated Auto event identity");
      continue;
    }
    eventIds.add(event.eventId);
    if ("actionId" in event) {
      const action = key(
        event.changeIdentity.root,
        event.changeIdentity.change,
        event.changeIdentity.schema,
        event.runId,
        event.actionId,
      );
      const binding = key(event.skill, event.inputFingerprint);
      if (actions.has(action) && actions.get(action) !== binding) {
        report("conflicting_action", "Action identity was reused for a different skill or input");
        continue;
      }
      // A settled invocation has exactly one outcome. No selection/admission/
      // hold appended later may resurrect it, including after session reload.
      // This does not require earlier phases: partial native branches may begin
      // with a held or settled fact, and skills still own their internal process.
      if (settledActions.has(action)) {
        report("conflicting_action", "Settled Auto action was repeated or reopened");
        continue;
      }
      const nativeKeys = (event.nativeReceipts ?? []).map((receipt) => receiptKey(receipt)!);
      if (nativeKeys.some((id) => receipts.has(id) && receipts.get(id) !== action)) {
        report("replayed_receipt", "Native receipt was already associated with another action");
        continue;
      }
      actions.set(action, binding);
      if (event.kind === "action-settled") settledActions.add(action);
      for (const id of nativeKeys) receipts.set(id, action);
    }
    if (sameChange(event.changeIdentity, changeIdentity)) records.push(event);
  }
  return { records, diagnostics, valid: diagnostics.length === 0 };
}

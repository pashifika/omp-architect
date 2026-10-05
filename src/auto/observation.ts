import type { DecisionEvidence } from "./decision.ts";
import { AutoPreflightError } from "./diagnostics.ts";
import type { AutoEvent } from "./journal.ts";
import type { RasenSnapshot } from "./rasen.ts";

type Data = Record<string, unknown>;
const omitted = "[truncated]";

/** A data-only excerpt, not an interpretation of any skill's private record format. */
function project(
  value: unknown,
  chars: number,
  items: number,
  truncate: () => void,
  newest = false,
): unknown {
  let nodes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 256 || depth > 5) {
      truncate();
      return omitted;
    }
    if (typeof item === "string") {
      if (item.length <= chars) return item;
      truncate();
      return `${item.slice(0, chars)}${omitted}`;
    }
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (Array.isArray(item)) {
      const tail = newest && depth === 0;
      const result = (tail ? item.slice(-items) : item.slice(0, items)).map((entry) =>
        visit(entry, depth + 1),
      );
      if (item.length > items) {
        truncate();
        const marker = `[${item.length - items} more items truncated]`;
        if (tail) result.unshift(marker);
        else result.push(marker);
      }
      return result;
    }
    if (item && typeof item === "object") {
      const entries = Object.entries(item);
      if (entries.length > items) truncate();
      return Object.fromEntries(
        entries.slice(0, items).map(([key, entry]) => [key, visit(entry, depth + 1)]),
      );
    }
    truncate();
    return omitted;
  };
  return visit(value, 0);
}

/** Preserve reference-shaped native metadata ahead of potentially large native output. */
function receiptReferences(receipt: Data): Data {
  return Object.fromEntries(
    Object.entries(receipt)
      .filter(
        ([key]) => /(?:id|ref|refs|path|sha256|fingerprint)$/i.test(key) || key === "producer",
      )
      .map(([key, value]) => [
        key,
        key === "producer" && value && typeof value === "object" && !Array.isArray(value)
          ? receiptReferences(value as Data)
          : value,
      ]),
  );
}

/**
 * Keep the whole user goal and fresh change identity even when observations are large.
 * Criteria are intentionally absent: the controller supplies the exact skill catalog separately.
 */
export function buildAutoDecisionEvidence(
  snapshot: RasenSnapshot,
  goal: string,
  assistantClaim: string,
  historyRecords: readonly AutoEvent[],
  recentTools: readonly string[],
  maxEvidenceChars: number,
): DecisionEvidence {
  const changeFacts: Data = {
    state: snapshot.state,
    progress: { ...snapshot.progress },
    fingerprint: snapshot.fingerprint,
  };
  const summary: Data = { goal, changeFacts, truncated: false };
  const evidence: DecisionEvidence = {
    change: snapshot.change,
    remaining: snapshot.progress.remaining,
    completed: snapshot.progress.complete,
    summary: "",
    recentTools: [],
  };
  const size = () => {
    evidence.summary = JSON.stringify(summary);
    return JSON.stringify(evidence).length;
  };
  const truncate = () => {
    summary.truncated = true;
  };
  if (
    !Number.isSafeInteger(maxEvidenceChars) ||
    maxEvidenceChars < 256 ||
    maxEvidenceChars > 100000 ||
    size() > maxEvidenceChars
  )
    throw new AutoPreflightError(
      "The complete Auto goal and essential change facts exceed auto maxEvidenceChars. Shorten the guidance or increase auto maxEvidenceChars; the user goal is never silently truncated",
    );

  // Every trial measures the final nested JSON encoding, including escaped strings.
  function add(target: Data, key: string, value: unknown, allowance = maxEvidenceChars): boolean {
    if (value === undefined) return true;
    const before = size();
    const previous = target[key];
    const present = Object.hasOwn(target, key);
    target[key] = value;
    if (size() <= Math.min(maxEvidenceChars, before + allowance)) return true;
    if (present) target[key] = previous;
    else delete target[key];
    return false;
  }
  function addExcerpt(target: Data, key: string, value: unknown, allowance: number): void {
    if (add(target, key, value, allowance)) return;
    truncate();
    for (const [chars, items] of [
      [512, 16],
      [256, 8],
      [128, 4],
      [64, 2],
      [16, 1],
    ]) {
      if (
        add(
          target,
          key,
          project(
            value,
            chars,
            items,
            truncate,
            key === "recentTools" || key === "nativeObservations",
          ),
          allowance,
        )
      )
        return;
    }
  }

  // Source identity never competes with the source's own arbitrarily shaped content.
  const record = snapshot.skillRecord;
  let skillRecord: Data | undefined;
  if (record) {
    skillRecord =
      record.kind === "absent"
        ? { kind: record.kind, searchedPaths: [...record.searchedPaths] }
        : { kind: record.kind, path: record.path, sha256: record.sha256 };
    addExcerpt(changeFacts, "skillRecord", skillRecord, maxEvidenceChars);
    if (changeFacts.skillRecord !== skillRecord) skillRecord = undefined;
  }

  const history = historyRecords.slice(-8).map((entry) => ({
    eventId: entry.eventId,
    kind: entry.kind,
    ...("actionId" in entry ? { actionId: entry.actionId, skill: entry.skill } : {}),
    status: entry.status,
    ...("outcome" in entry ? { outcome: entry.outcome } : {}),
    outputFingerprint: entry.outputFingerprint,
    evidenceRefs: entry.decision?.evidenceRefs,
    nativeReceipts: entry.nativeReceipts?.map(receiptReferences),
  }));
  if (historyRecords.length > history.length) truncate();
  // Keep newest native references first under pressure; raw notes cannot displace them.
  let nativeHistory: Data[] = [];
  const historyBudget = Math.max(Math.floor((maxEvidenceChars - size()) * 0.65), 0);
  const beforeHistory = size();
  for (const entry of [...history].reverse()) {
    const candidate = [entry, ...nativeHistory];
    if (!add(summary, "nativeHistory", candidate, historyBudget + beforeHistory - size())) {
      truncate();
      break;
    }
    nativeHistory = candidate;
  }

  const candidates: Array<[Data, string, unknown]> = [
    [summary, "assistantClaim", assistantClaim],
    [changeFacts, "tasks", snapshot.tasks],
    [changeFacts, "artifacts", snapshot.artifacts],
    [changeFacts, "contextFiles", snapshot.contextFiles],
    ...(skillRecord && record?.kind === "valid"
      ? ([[skillRecord, "content", record.content]] as Array<[Data, string, unknown]>)
      : []),
    ...(skillRecord && record?.kind === "malformed"
      ? ([[skillRecord, "reason", record.reason]] as Array<[Data, string, unknown]>)
      : []),
    [changeFacts, "actionContext", snapshot.actionContext],
    [changeFacts, "instruction", snapshot.instruction],
    [changeFacts, "nextSteps", snapshot.nextSteps],
    [changeFacts, "nextWorkflows", snapshot.nextWorkflows],
    [changeFacts, "applyNextWorkflows", snapshot.applyNextWorkflows],
    [changeFacts, "applyRequires", snapshot.applyRequires],
    [changeFacts, "missingArtifacts", snapshot.missingArtifacts],
    [changeFacts, "archived", snapshot.archived],
    [changeFacts, "source", snapshot.source],
    [
      summary,
      "nativeObservations",
      historyRecords.slice(-8).map((entry) => ({
        eventId: entry.eventId,
        reason: entry.reason,
        nativeReceipts: entry.nativeReceipts,
      })),
    ],
    [evidence as unknown as Data, "recentTools", recentTools.slice(-8)],
  ];
  const observations = candidates.filter(([, , value]) => value !== undefined);
  if (recentTools.length > 8) truncate();
  for (let i = 0; i < observations.length; i++) {
    const [target, key, value] = observations[i];
    addExcerpt(
      target,
      key,
      value,
      Math.floor((maxEvidenceChars - size()) / (observations.length - i)),
    );
  }
  size();
  return evidence;
}

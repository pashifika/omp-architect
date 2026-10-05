import {
  AutoPreflightError,
  AutoObservationError,
  autoObservation,
  autoStepDiagnostic,
  type AutoStepStage,
  autoPreflightDiagnostic,
  type AutoPreflightStage,
} from "./diagnostics.ts";
import type {
  BeforeSubagentSpawnEvent,
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  SessionStopEvent,
} from "@oh-my-pi/pi-coding-agent";
import {
  routeAgent,
  type Orchestrator,
  type Phase,
  type Verdict,
  type ReviewMaterial,
} from "../core.ts";
import { autoDefaults, loadAutoConfig, type AutoConfig } from "./config.ts";
import { AutoRun } from "./core.ts";
import { createJevProvider, type DecisionProvider } from "./decision.ts";
import { buildAutoDecisionEvidence } from "./observation.ts";
import { createDecisionFallback } from "./fallback.ts";
import { readRasenSnapshot, type RasenSnapshot } from "./rasen.ts";
import {
  nativeRasenSkills,
  readRasenSkill,
  type RasenSkill,
  type RasenSkillContent,
} from "./skills.ts";
import {
  appendAutoEvent,
  readAutoHistory,
  type AutoEvent,
  type AutoHistory,
  type AutoJournalDecision,
} from "./journal.ts";
import { autoRequest, autoUsage, briefRoot, parseAutoStart, renderBrief } from "./instructions.ts";
import { completeAuto } from "./completion.ts";
import { confirmAutoStart } from "./confirmation.ts";
import { saveAutoPayload, reviewWrite, reviewCarrier } from "../artifacts.ts";
import { createCommandEditor } from "../brief/editor.ts";
import { readWorkspaceEvidence } from "./workspace.ts";
import { createHash } from "node:crypto";
import { NativeQuiescence, nativeAsyncHost, type NativeAsyncHost } from "./async.ts";
import {
  NativeActionEvidence,
  nativeAgentMessagePath,
  type NativeActionAdmission,
  type NativeActionReceipt,
} from "./evidence.ts";
import {
  resolveNativeRoleRoute,
  nativeStageReuseError,
  nativeStageRouteMatches,
} from "./model-route.ts";
import { NativeSpawnAdmissions } from "./spawn.ts";

const autoPolicy =
  "OMP Auto uses native OMP state and actual change evidence. Jev selects the next existing Rasen skill before execution; no pipeline or fixed apply/verify phase is required. Call auto_step at meaningful skill boundaries. Read the complete selected skill and let it own its internal process, including review-cycle's whole review/fix/strategy loop. Never invoke rasen-auto or add an outer Architect completion loop. Rasen skills may create/update their own reports and auto-run.json for the UI; that file is neither forbidden nor a prerequisite for Auto. Use native task/async/IRC/wait and normal approvals. Selection never grants publication permission. Stop/new input holds new scheduling while admitted native work drains.";
const safeMainTools = new Set([
  "read",
  "grep",
  "glob",
  "find",
  "ls",
  "web_search",
  "fetch",
  "todo",
  "wait",
  "auto_status",
  "auto_step",
  "architect_checkpoint",
]);
const outcomes = ["progress", "success", "blocked", "needs_user", "failed", "cancelled"] as const;
type ActionOutcome = (typeof outcomes)[number];
interface ActionResult {
  actionId: string;
  status: ActionOutcome;
  note: string;
}
interface ActiveAction {
  skill: RasenSkillContent;
  admission: NativeActionAdmission;
  decision: AutoJournalDecision;
  receipts: NativeActionReceipt[];
  evidenceArtifacts: Map<string, Awaited<ReturnType<typeof saveAutoPayload>>>;
  result?: ActionResult;
  heldRecorded?: boolean;
  resume?: string;
}
const hash = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export function autoStepCarrier(input: Record<string, unknown>): boolean {
  if (
    input.language !== "js" ||
    input.reset !== true ||
    input.async === true ||
    typeof input.code !== "string"
  )
    return false;
  const match =
    /^(?:await tool\.write\((\{[\s\S]*\})\)|console\.log\(await tool\.write\((\{[\s\S]*\})\)\));?$/.exec(
      input.code.trim(),
    );
  if (!match) return false;
  try {
    const args = JSON.parse(match[1] ?? match[2]);
    if (
      args?.path !== "xd://auto_step" ||
      typeof args.content !== "string" ||
      Object.keys(args).some((key) => !["path", "content"].includes(key))
    )
      return false;
    const params = JSON.parse(args.content);
    return (
      typeof params?.summary === "string" &&
      params.summary.length <= 4000 &&
      Object.keys(params).every((key) => ["summary", "result"].includes(key))
    );
  } catch {
    return false;
  }
}

export interface AutoDependencies {
  snapshot?: typeof readRasenSnapshot;
  skills?: (ctx: ExtensionContext, host: NativeAsyncHost) => RasenSkill[];
  skill?: typeof readRasenSkill;
  decision?: (config: AutoConfig, ctx: ExtensionContext) => DecisionProvider;
  fallback?: (config: AutoConfig, ctx: ExtensionContext) => DecisionProvider;
  now?: () => number;
  nativeHost?: (ctx: ExtensionContext) => NativeAsyncHost | undefined;
}
interface ArchitectBridge {
  invalidateStart(): void;
  acceptInternal(text: string, ctx: ExtensionContext): void;
  instructions(): string;
  state(): Orchestrator | undefined;
  review(
    phase: Phase,
    summary: string,
    ctx: ExtensionContext,
    signal?: AbortSignal,
    invocationId?: string,
  ): Promise<Verdict>;
}

export function createAutoController(
  pi: ExtensionAPI,
  bridge: ArchitectBridge,
  dependencies: AutoDependencies = {},
) {
  let config = { ...autoDefaults };
  let configError = "";
  let run: AutoRun | undefined;
  let activeAction: ActiveAction | undefined;
  let catalog: RasenSkill[] = [];
  let catalogFingerprint = "";
  let history: AutoHistory = { records: [], diagnostics: [], valid: true };
  let historyError: string | null = null;
  let lastDecision: AutoJournalDecision | undefined;
  const spawnAdmissions = new NativeSpawnAdmissions();
  const roleRouteErrors = new Map<string, Record<string, string>>();
  const mainCalls = new Map<string, { actionId: string; tool: string }>();
  const mainReceipts = new Map<
    string,
    Array<{ toolCallId: string; tool: string; isError: boolean; sha256: string }>
  >();
  const receiptErrors: string[] = [];
  const boundaryCarriers = new Set<string>();
  let nativeEvidence: NativeActionEvidence | undefined;
  let completedFacts: { snapshot: string; catalog: string; history: string } | undefined;
  let activeContext: ExtensionContext | undefined;
  let nativeWork: NativeQuiescence | undefined;
  let drain: AbortController | undefined;
  let runCwd = "";
  let diagnosticRead: { run: AutoRun; promise: Promise<void> } | undefined;
  let ownsTurn = false;
  let bootstrap = "";
  let delivery:
    | { content: string; sessionId: string; runId: string; ref: string; sha256: string }
    | undefined;
  let runInstructions = "";
  let runRequest = "";
  let expectedContinuation = "";
  let userInputObserved = false;
  let inputEvent:
    | {
        at: number;
        source: InputEvent["source"];
        kind: "text" | "command" | "images" | "text_and_images";
        textLength: number;
        imageCount: number;
        statusBefore: AutoRun["status"];
        outcomeBefore: AutoRun["outcome"] | null;
      }
    | undefined;
  let userTurnOwnsContext = false;
  const continuations = new Set<string>();
  let lifetime = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let notified = "";
  let inFlight = false;
  let generation = 0;
  const deliveryTag = crypto.randomUUID();
  let cwd = "";
  const readSnapshot =
    dependencies.snapshot ??
    (async (...args: Parameters<typeof readRasenSnapshot>) => {
      const snapshot = await readRasenSnapshot(...args);
      const workspace = await readWorkspaceEvidence(snapshot.root, args[3]);
      return {
        ...snapshot,
        workspace,
        fingerprint: hash([snapshot.fingerprint, workspace.fingerprint]),
      };
    });
  const readSkill = dependencies.skill ?? readRasenSkill;
  const resolveNativeHost =
    dependencies.nativeHost ?? ((ctx: ExtensionContext) => nativeAsyncHost(pi, ctx));
  const cliOptions = () => ({
    executable: config.rasenExecutable,
    timeoutMs: config.cliTimeoutMs,
    maxOutputBytes: 512 * 1024,
  });
  const identity = (snapshot: RasenSnapshot) => ({
    change: snapshot.change,
    root: snapshot.root,
    schema: snapshot.schema,
  });
  function observeCatalog(ctx: ExtensionContext): RasenSkill[] {
    const host = resolveNativeHost(ctx);
    if (!host) throw new AutoPreflightError("Native OMP skill catalogue is unavailable");
    return (dependencies.skills?.(ctx, host) ?? nativeRasenSkills(host.session.skills))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  function catalogueHash(skills: RasenSkill[]) {
    return hash(
      skills.map(({ name, description, filePath, reference }) => ({
        name,
        description,
        filePath,
        reference,
      })),
    );
  }
  function readHistory(ctx: ExtensionContext, snapshot: RasenSnapshot) {
    const observed = readAutoHistory(ctx.sessionManager, identity(snapshot));
    if (!observed.valid)
      throw new AutoPreflightError(
        "Native Auto history is malformed or contradictory; inspect this session before resuming",
      );
    return observed;
  }
  function journal(kind: AutoEvent["kind"], data: Record<string, unknown> = {}) {
    if (!run) return;
    appendAutoEvent(
      pi,
      json({
        version: 1,
        eventId: crypto.randomUUID(),
        kind,
        runId: run.id,
        at: run.now(),
        changeIdentity: identity(run.snapshot),
        inputFingerprint: run.snapshot.fingerprint,
        ...data,
      }) as AutoEvent,
    );
  }
  function actionView(active: ActiveAction) {
    return {
      actionId: active.admission.actionId,
      skill: {
        name: active.skill.name,
        description: active.skill.description,
        reference: active.skill.reference,
        sha256: active.skill.sha256,
      },
      admission: active.admission,
      receipts: active.receipts.slice(-4).map((r) => r.producer),
      receiptCount: active.receipts.length,
      mainReceipts: (mainReceipts.get(active.admission.actionId) ?? []).slice(-4),
      mainReceiptCount: (mainReceipts.get(active.admission.actionId) ?? []).length,
      result: active.result ?? null,
    };
  }
  function statusView() {
    if (!run) return { status: "idle", enabled: config.enabled, error: configError || null };
    return {
      ...run.statusView(),
      inputEvent: inputEvent ? { ...inputEvent } : null,
      nativeWork: {
        pending: nativeWork?.pending() ?? false,
        waitingFor: "native Main and child settlement (may include other work sharing this Main)",
        draining: run.status === "draining",
        settlementUnverified: nativeWork?.uncertainty ?? [],
      },
      completionVerified:
        run.statusView().completionVerified &&
        !historyError &&
        !bridge.state()?.gate("task", {}) &&
        !bridge.state()?.reviewInProgress &&
        !activeAction &&
        completedFacts?.snapshot === run.snapshot.fingerprint &&
        completedFacts.catalog === catalogFingerprint &&
        completedFacts.history === hash(history.records),
      selectedAction: activeAction ? actionView(activeAction) : null,
      lastDecision: lastDecision ?? null,
      history: {
        records: history.records.length,
        valid: history.valid,
        diagnostics: history.diagnostics,
      },
      historyError,
      availableSkills: catalog.slice(0, 64).map(({ name, reference }) => ({ name, reference })),
      availableSkillCount: catalog.length,
      receiptErrors: receiptErrors.slice(-8),
      receiptErrorCount: receiptErrors.length,
    };
  }
  /** Diagnostics observe native/skill records; they never schedule or rewrite them. */
  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    const current = run;
    if (!current) return;
    if (diagnosticRead?.run === current) return diagnosticRead.promise;
    const sessionId = ctx.sessionManager.getSessionId();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), config.cliTimeoutMs * 3);
    const valid = () => run === current && sessionId === ctx.sessionManager.getSessionId();
    const promise = (async () => {
      const snapshot = await readSnapshot(
        runCwd,
        current.snapshot.change,
        cliOptions(),
        abort.signal,
      );
      if (!valid()) return;
      current.reconcile(snapshot);
      catalog = observeCatalog(ctx);
      catalogFingerprint = catalogueHash(catalog);
      history = readHistory(ctx, snapshot);
      historyError = null;
    })()
      .catch(() => {
        if (valid()) {
          current.observationError =
            "Fresh change/history observation failed; showing last known facts";
          historyError = "Native Auto history or current Rasen evidence could not be observed";
        }
      })
      .finally(() => {
        clearTimeout(timer);
        if (diagnosticRead?.run === current) diagnosticRead = undefined;
      });
    diagnosticRead = { run: current, promise };
    return promise;
  }
  function clearDeadline() {
    if (deadline) clearTimeout(deadline);
    deadline = undefined;
    if (activityTimer) clearTimeout(activityTimer);
    activityTimer = undefined;
  }
  function activity(ctx: ExtensionContext) {
    if (!ownsTurn || run?.status !== "running") return;
    run.activity();
    if (activityTimer) clearTimeout(activityTimer);
    const active = run;
    activityTimer = setTimeout(() => {
      if (run !== active || !ownsTurn || active.status !== "running") return;
      active.stop("stalled", "No native model/tool output within the activity timeout");
      notify(ctx);
    }, config.noOutputTimeoutMs);
  }
  function publish(ctx: ExtensionContext) {
    if (!run) return;
    try {
      pi.sendMessage(
        { customType: "omp-auto", content: JSON.stringify(statusView(), null, 2), display: true },
        { triggerTurn: false, deliverAs: "nextTurn" },
      );
    } catch {
      // A failed native transport must not expose its private exception or
      // cancel native work. The local UI still receives the bounded status.
    }
    ctx.ui.notify(
      `OMP Auto ${run.status}: ${run.reason}`,
      run.status === "completed" ? "info" : "warning",
    );
  }
  function notify(ctx: ExtensionContext) {
    if (!run || run.status === "running" || notified === run.id) return;
    notified = run.id;
    generation++;
    inFlight = false;
    bridge.invalidateStart();
    expectedContinuation = "";
    bootstrap = "";
    clearDeadline();
    lifetime.abort(); // Only host observations/Jev/review publication, never OMP execution.
    const finished = run;
    finished.beginDrain();
    drain?.abort();
    drain = new AbortController();
    const signal = drain.signal;
    publish(ctx);
    // Detached from every awaited OMP event/tool callback: waiting for Main
    // idle here must never block the callback that Main itself is awaiting.
    const finalizationGeneration = generation;
    const observedWork = nativeWork;
    setTimeout(() => {
      void (async () => {
        while (!signal.aborted && run === finished && observedWork) {
          if (!(await observedWork.waitForDrain(signal))) {
            if (!signal.aborted && run === finished && observedWork.uncertainty.length) {
              finished.reason = `${finished.reason}; native dispatch settlement is unverified. Inspect native work before restarting`;
              publish(ctx);
            }
            return;
          }
          if (signal.aborted || run !== finished) return;
          let evidenceSettled = true;
          try {
            await collectActionEvidence(signal);
            if (finished.outcome !== "completed") await recordHeldAction(ctx, signal);
            await refreshStatus(ctx);
          } catch {
            // Execution quiescence and native history persistence are separate facts.
            // A stale/refused write or unreadable receipt must not leave settled
            // native work draining forever, nor manufacture a completion claim.
            evidenceSettled = false;
            historyError =
              "Native work settled, but native evidence could not be reconciled; retained native artifacts require attention before resume";
          }
          if (signal.aborted || run !== finished) return;
          const supportsCompletion = () =>
            evidenceSettled &&
            generation === finalizationGeneration &&
            finished.outcome === "completed" &&
            !!completedFacts &&
            completedFacts.snapshot === finished.snapshot.fingerprint &&
            completedFacts.catalog === catalogFingerprint &&
            completedFacts.history === hash(history.records) &&
            !finished.observationError &&
            !historyError &&
            !bridge.state()?.gate("task", {}) &&
            !bridge.state()?.reviewInProgress &&
            !activeAction;
          const completed = supportsCompletion();
          if (signal.aborted || run !== finished) return;
          // Fresh observations can race a new native admission. Rejoin instead
          // of abandoning the held run or pretending the old fence is atomic.
          if (
            observedWork.pending() ||
            observedWork.host.session.hasAdmittedSubmission ||
            observedWork.host.session.isStreaming
          )
            continue;
          if (finished.outcome === "completed" && !completed)
            finished.reason =
              "Fresh native settlement or workspace evidence no longer supports completion";
          finished.finishDrain(completed);
          try {
            journal("run-stop", {
              status: finished.status,
              reason: finished.reason,
              decision: lastDecision,
            });
            history = readHistory(ctx, finished.snapshot);
            if (completed && completedFacts) completedFacts.history = hash(history.records);
          } catch {
            historyError = "Native stop history could not be recorded";
          }
          spawnAdmissions.clear();
          roleRouteErrors.clear();
          mainCalls.clear();
          mainReceipts.clear();
          publish(ctx);
          return;
        }
      })().catch(() => {
        if (run === finished && !signal.aborted)
          ctx.ui.notify(
            "Auto is held; native settlement could not be verified. Inspect native work before restarting",
            "warning",
          );
      });
    }, 0);
  }
  function stop(reason: string, ctx?: ExtensionContext) {
    generation++;
    completedFacts = undefined;
    bridge.invalidateStart();
    expectedContinuation = "";
    bootstrap = "";
    inFlight = false;
    // A later user request must still invalidate provisional completion, but
    // must not relabel an existing timeout/failure or the same input's stop.
    if (run?.status === "draining" && run.outcome === "completed") {
      run.outcome = "needs_user";
      run.reason = reason;
    } else run?.stop("needs_user", reason);
    clearDeadline();
    lifetime.abort();
    const context = ctx ?? activeContext;
    if (context) notify(context);
  }
  function prompt(snapshot: RasenSnapshot, prefix = "") {
    return [
      autoPolicy,
      "Call auto_step first and at a meaningful skill boundary. Jev chooses from the actual native-loaded Rasen skill descriptions and observed change/history. Do not impose a predetermined apply/continue/verify sequence, or treat all_done as overall completion. A pipeline, if present in skill records, is context rather than a universal admission requirement.",
      "Main executes each selected existing skill with normal OMP tools and flat native leaves. Read its complete description/body/references. The skill owns internal loops and reports; in particular do not call auto_step between review-cycle rounds or add an Architect completion loop. It may create/update auto-run.json for Rasen UI even without a pipeline. Auto's own orchestration history belongs in OMP's native session, not a replacement project ledger.",
      "Report a factual skill invocation outcome via auto_step result:{actionId,status,note}; status is progress, success, blocked, needs_user, failed or cancelled. This is not a claim that all change work is complete. Preserve native outputs and skill-owned findings; do not repeat uncertain irreversible effects or reset an exhausted skill loop. Normal action permissions still apply, including ship/archive; no available skill is blanket-authorized.",
      runInstructions
        ? `Additional frozen user guidance (no extra action permissions):\n${runInstructions}`
        : "",
      prefix,
      JSON.stringify({
        change: snapshot.change,
        applyState: snapshot.state,
        progress: snapshot.progress,
        tasks: snapshot.tasks,
        contextFiles: snapshot.contextFiles,
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  function actionInstruction(active: ActiveAction) {
    const routes = active.admission.roleRoutes ?? {};
    return [
      `Jev selected the existing native skill ${active.skill.name}. Read the COMPLETE skill at ${JSON.stringify(active.skill.reference)} (native file ${JSON.stringify(active.skill.filePath)}, SHA-256 ${active.skill.sha256}); keep its meaning and internal process.`,
      `Auto action: ${active.admission.actionId}\n\nEvery native task prompt must include the exact standalone action line above. Use the normal native leaf roles ${active.admission.allowedRoles.join(", ")}. Configured native model selectors by role: ${JSON.stringify(Object.fromEntries(Object.entries(routes).map(([role, r]) => [role, r.selector])))}. Do not add conflicting coarse effort overrides.`,
      "Use OMP task/async/IRC/wait normally. Leaves return scoped evidence; only Main reports the skill boundary. A child success flag is not whole-action or whole-change completion. Never load rasen-auto or launch foreign dispatch/parking processes. The selected skill may create/update its normal files including auto-run.json; preserve those records and their UI integration.",
      active.resume
        ? `Resume context: ${active.resume}. Read existing native and skill-owned evidence before resuming; do not reset counters or replay uncertain side effects.`
        : "",
      "At the skill's natural completion/progress/blocker boundary, join admitted native work and call auto_step with summary plus result:{actionId,status,note}. Do not checkpoint the skill's internal review/fix rounds. A needs_user outcome pauses scheduling; normal approvals remain separate.",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  function goal(change: string, guidance: string) {
    return `Complete the requested outcome for existing Rasen change ${change} according to its current artifacts. User guidance:\n${guidance}`;
  }

  pi.registerCommand("auto", {
    description:
      "Supervised native Rasen Auto: /auto start <change> [instructions | --brief pack [blocks] -- instructions], status, stop",
    getArgumentCompletions: (prefix) =>
      cwd ? completeAuto(prefix, cwd, briefRoot(pi.pi.getAgentDir)) : null,
    async handler(args, ctx) {
      if (ctx.agent.kind !== "main") return;
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "stop" && parts.length === 1) {
        stop("Stopped by the user", ctx);
        return;
      }
      if ((!args.trim() || parts[0] === "status") && parts.length === 1) {
        await refreshStatus(ctx);
        const content = JSON.stringify(statusView(), null, 2);
        if ((ownsTurn && run?.status === "running") || !ctx.isIdle()) {
          ctx.ui.notify(content, "info");
        } else {
          pi.sendMessage(
            { customType: "omp-auto", content, display: true },
            { triggerTurn: false },
          );
        }
        return;
      }
      let start;
      try {
        start = parseAutoStart(args);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : autoUsage, "error");
        return;
      }
      if (configError || !config.enabled || !bridge.state()) {
        ctx.ui.notify(
          configError ||
            (!config.enabled
              ? "Auto is explicitly disabled by auto.json; change enabled in the project or active OMP agent configuration and restart the session"
              : "Initialize Architect before starting Auto"),
          "error",
        );
        return;
      }
      if (!ctx.isIdle() || run?.status === "running" || inFlight) {
        ctx.ui.notify(
          "An operation is still active; stop it before starting a new Auto run",
          "error",
        );
        return;
      }
      const nativeHost = resolveNativeHost(ctx);
      if (!nativeHost) {
        ctx.ui.notify(
          "Auto needs this Main session's native async ownership APIs; this SDK host has not exposed its matching session and job manager",
          "error",
        );
        return;
      }
      if (run?.status === "draining" || nativeWork?.pending()) {
        ctx.ui.notify(
          "Native work is still draining; wait for its normal results before starting again",
          "error",
        );
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "Auto start requires interactive confirmation of TypeSafe evidence sharing",
          "error",
        );
        return;
      }
      const commandGeneration = generation;
      inFlight = true;
      let stage: AutoPreflightStage = "confirmation";
      try {
        lifetime.abort();
        lifetime = new AbortController();
        const signal = lifetime.signal;
        let rendered = "";
        if (start.brief) {
          try {
            rendered = await renderBrief(
              ctx.cwd,
              briefRoot(pi.pi.getAgentDir),
              start.brief,
              start.change,
              signal,
            );
          } catch {
            if (commandGeneration === generation && !signal.aborted)
              ctx.ui.notify(
                "Brief could not be rendered. Check the pack, block names, UTF-8 files, paths, and size limits; no Auto run was started",
                "error",
              );
            return;
          }
        }
        const guidance = [rendered, start.instructions].filter(Boolean).join("\n\n");
        stage = "workflow";
        const selectedCatalog = observeCatalog(ctx);
        if (!selectedCatalog.length)
          throw new AutoPreflightError(
            "No existing non-Auto Rasen skills are loaded by this OMP session",
          );
        const request = autoRequest(start.change, guidance);
        if (guidance && (guidance.length > 12000 || !bridge.state()!.canRetainRequest(request))) {
          ctx.ui.notify(
            "Auto instructions exceed Architect's request-evidence budget. Shorten the brief/instructions or increase architect.json maxEvidenceChars, then restart the session. Instructions are never silently truncated",
            "error",
          );
          return;
        }
        if (commandGeneration !== generation || signal.aborted || !ctx.isIdle()) return;
        stage = "confirmation";
        const approved = await confirmAutoStart(pi.pi, ctx.ui, start.change, guidance, signal);
        if (!approved || commandGeneration !== generation || !ctx.isIdle()) return;
        stage = "change snapshot";
        const snapshot = await readSnapshot(ctx.cwd, start.change, cliOptions(), signal);
        if (commandGeneration !== generation || lifetime.signal.aborted || !ctx.isIdle()) return;
        history = readHistory(ctx, snapshot);
        buildAutoDecisionEvidence(
          snapshot,
          goal(snapshot.change, guidance),
          "",
          history.records,
          [],
          config.maxEvidenceChars,
        );
        if (commandGeneration !== generation || signal.aborted || !ctx.isIdle()) return;
        const candidate = new AutoRun(config, snapshot, dependencies.now);
        runInstructions = guidance;
        const content = `${bridge.instructions()}\n\n${autoPolicy}\n\n${prompt(snapshot)}\n\nAuto run: ${deliveryTag}:${candidate.id}`;
        const sessionId = ctx.sessionManager.getSessionId();
        stage = "artifact storage";
        const material = await saveAutoPayload(ctx, content, signal);
        // Artifact persistence is asynchronous: cancellation or session replacement must win.
        if (
          commandGeneration !== generation ||
          signal.aborted ||
          !ctx.isIdle() ||
          ctx.sessionManager.getSessionId() !== sessionId
        )
          return;
        if (resolveNativeHost(ctx)?.session !== nativeHost.session) return;
        stage = "native delivery";
        drain?.abort();
        nativeWork = new NativeQuiescence(nativeHost);
        nativeEvidence = new NativeActionEvidence(nativeHost);
        run = candidate;
        runCwd = ctx.cwd;
        catalog = selectedCatalog;
        catalogFingerprint = catalogueHash(catalog);
        activeAction = undefined;
        spawnAdmissions.clear();
        roleRouteErrors.clear();
        mainCalls.clear();
        mainReceipts.clear();
        receiptErrors.length = 0;
        boundaryCarriers.clear();
        historyError = null;
        completedFacts = undefined;
        lastDecision = undefined;
        journal("run-start", {
          reason:
            "Explicit user start; Jev chooses actions from the observed native skill catalogue",
        });
        continuations.clear();
        userTurnOwnsContext = false;
        runRequest = request;
        delivery = {
          content,
          sessionId,
          runId: run.id,
          ref: material.ref,
          sha256: material.sha256,
        };
        ownsTurn = true;
        activeContext = ctx;

        notified = "";
        clearDeadline();
        const active = run;
        deadline = setTimeout(() => {
          if (run !== active || !ownsTurn || active.status !== "running") return;
          active.stop("budget_exhausted", "Run deadline reached");
          notify(ctx);
        }, config.maxDurationMs);
        activity(ctx);
        userInputObserved = false;
        inputEvent = undefined;
        bootstrap = content;
        pi.sendMessage(
          {
            customType: "omp-auto-run",
            content,
            display: false,
            attribution: "agent",
            details: { controller: deliveryTag, sessionId, runId: run.id, ...material },
          },
          { triggerTurn: true, deliverAs: "nextTurn" },
        );
      } catch (error) {
        if (commandGeneration !== generation || lifetime.signal.aborted) return;
        const diagnostic = autoPreflightDiagnostic(stage, error);
        if (stage === "native delivery") {
          // A host may enqueue and then throw: revoke ownership and any queued payload.
          // Do not use notify() here, because it attempts another native send.
          stop("Native Auto delivery failed");
          ownsTurn = false;
          delivery = undefined;
          activeContext = undefined;
          // This diagnostic is the cancellation notification; stale delivery must
          // not schedule another native message while the host transport is broken.
          notified = run?.id ?? "";
        }
        ctx.ui.notify(diagnostic, "error");
      } finally {
        if (commandGeneration === generation) inFlight = false;
      }
    },
  });
  const { Type } = pi.typebox;
  pi.registerTool({
    name: "auto_status",
    label: "Auto status",
    description:
      "Read the bounded Rasen run status. Cannot start, resume, reset, or grant permission.",
    approval: "read",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _update, ctx) {
      if (ctx.agent.kind !== "main")
        return {
          content: [{ type: "text", text: "Auto belongs to the main session" }],
          isError: true,
        };
      await refreshStatus(ctx);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...statusView(),
              architect: bridge.state()
                ? {
                    plan: bridge.state()!.planStatus(),
                    pendingRecovery: bridge.state()!.pendingRecovery,
                    completionApproved: bridge.state()!.completionApproved,
                    blocked: bridge.state()!.blocked || null,
                    terminalReason: bridge.state()!.terminalReason ?? null,
                    lastReview: bridge.state()!.lastReview,
                    attempts: { ...bridge.state()!.phaseReviews },
                    rounds: { ...bridge.state()!.phaseRounds },
                  }
                : null,
            }),
          },
        ],
      };
    },
  });
  async function collectActionEvidence(signal: AbortSignal) {
    if (!nativeEvidence) return;
    for (const receipt of await nativeEvidence.consume(
      bridge.state()?.config.maxReviewBytes ?? 131072,
      signal,
    )) {
      const active = activeAction;
      if (
        !active ||
        receipt.admission.actionId !== active.admission.actionId ||
        receipt.admission.skillName !== active.skill.name ||
        receipt.admission.inputFingerprint !== active.admission.inputFingerprint ||
        receipt.admission.selectionFingerprint !== active.admission.selectionFingerprint
      ) {
        receiptErrors.push(
          "Native result has no matching current Auto action; its artifact remains available",
        );
        continue;
      }
      const expected = active.admission.roleRoutes?.[receipt.role];
      if (
        !active.admission.allowedRoles.includes(receipt.role) ||
        (expected && !nativeStageRouteMatches(expected, receipt.producer.model))
      ) {
        receiptErrors.push("Native producer role/model did not match its admitted action");
        continue;
      }
      if (active.receipts.some((r) => r.producer.receiptId === receipt.producer.receiptId))
        continue;
      active.receipts.push(receipt);
    }
  }
  async function receiptBundle(active: ActiveAction, ctx: ExtensionContext, signal: AbortSignal) {
    for (const receipt of active.receipts) {
      if (!active.evidenceArtifacts.has(receipt.producer.receiptId)) {
        const saved = await saveAutoPayload(ctx, receipt.evidence, signal);
        if (saved.sha256 !== receipt.producer.artifactSha256)
          throw new AutoPreflightError("Native child evidence changed before retention");
        active.evidenceArtifacts.set(receipt.producer.receiptId, saved);
      }
    }
    const receipts = json([
      ...active.receipts.map((r) => ({
        ...r.producer,
        role: r.role,
        requestId: r.requestId,
        artifactRef: active.evidenceArtifacts.get(r.producer.receiptId)!.ref,
      })),
      ...(mainReceipts.get(active.admission.actionId) ?? []),
    ]);
    const material = await saveAutoPayload(
      ctx,
      JSON.stringify({
        actionId: active.admission.actionId,
        skill: active.skill.name,
        receipts,
        result: active.result ?? null,
      }),
      signal,
    );
    return [
      {
        receiptId: `auto-bundle:${active.admission.actionId}:${material.sha256}`,
        sessionId: ctx.sessionManager.getSessionId(),
        artifactRef: material.ref,
        sha256: material.sha256,
        count: receipts.length,
      },
    ];
  }
  async function recordHeldAction(ctx: ExtensionContext, signal: AbortSignal) {
    const active = activeAction;
    if (!active || active.heldRecorded) return;
    const bundle = await receiptBundle(active, ctx, signal);
    journal("action-held", {
      actionId: active.admission.actionId,
      skill: active.skill.name,
      inputFingerprint: active.admission.inputFingerprint,
      nativeReceipts: bundle,
      reason: run?.reason ?? "Scheduling held; native evidence retained",
    });
    active.heldRecorded = true;
  }
  async function settleAction(value: ActionResult, ctx: ExtensionContext, signal: AbortSignal) {
    const active = activeAction;
    if (
      !active ||
      value.actionId !== active.admission.actionId ||
      !outcomes.includes(value.status) ||
      !value.note.trim() ||
      value.note.length > 4000
    )
      throw new AutoPreflightError(
        "An action result must identify the current admitted skill and a bounded factual outcome",
      );
    await collectActionEvidence(signal);
    const successful =
      active.receipts.length > 0 ||
      (mainReceipts.get(active.admission.actionId) ?? []).some((r) => !r.isError);
    if (["success", "progress"].includes(value.status) && !successful)
      throw new AutoPreflightError(
        "Successful progress needs actual native tool/task evidence, not a bare claim or bookkeeping result",
      );
    active.result = { ...value };
    const snapshot = await readSnapshot(runCwd, run!.snapshot.change, cliOptions(), signal);
    const bundle = await receiptBundle(active, ctx, signal);
    signal.throwIfAborted();
    journal("action-settled", {
      actionId: active.admission.actionId,
      skill: active.skill.name,
      inputFingerprint: active.admission.inputFingerprint,
      outputFingerprint: snapshot.fingerprint,
      outcome: value.status,
      nativeReceipts: bundle,
      reason: value.note,
    });
    run!.observe(snapshot);
    if (["success", "progress"].includes(value.status))
      run!.actionProgress(`action:${active.admission.actionId}`);
    activeAction = undefined;
    if (value.status === "needs_user" || value.status === "cancelled") {
      run!.stop("needs_user", `Selected skill paused: ${value.note}`);
      notify(ctx);
    }
  }
  pi.registerTool({
    name: "auto_step",
    label: "Auto next action",
    approval: "read",
    description:
      "Observe actual change/native evidence and ask Jev to choose the next loaded Rasen skill. Optional result records the current skill invocation's factual boundary, not overall completion. No pipeline is required.",
    parameters: Type.Object({
      summary: Type.String({ maxLength: 4000 }),
      result: Type.Optional(
        Type.Object({
          actionId: Type.String({ minLength: 1, maxLength: 128 }),
          status: Type.Union(outcomes.map((v) => Type.Literal(v))),
          note: Type.String({ minLength: 1, maxLength: 4000 }),
        }),
      ),
    }),
    async execute(id, params, toolSignal, _update, ctx) {
      const result = (value: unknown, isError = false) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        isError,
      });
      const current = run;
      if (ctx.agent.kind !== "main" || !ownsTurn || !current || !current.checkTime()) {
        notify(ctx);
        return result({ error: "No active Auto run; this tool cannot start or resume one" }, true);
      }
      if (inFlight) return result({ error: "Another Auto boundary is active; await it" }, true);
      inFlight = true;
      const token = generation;
      const timeout = new AbortController();
      const fallbackTimeoutMs = bridge.state()?.config.reviewTimeoutMs ?? config.decisionTimeoutMs;
      const timer = setTimeout(
        () => timeout.abort(new DOMException("Auto boundary timed out", "TimeoutError")),
        6 * config.cliTimeoutMs + config.decisionTimeoutMs + fallbackTimeoutMs + 1000,
      );
      const signal = AbortSignal.any([
        lifetime.signal,
        timeout.signal,
        ...(toolSignal ? [toolSignal] : []),
      ]);
      const valid = () => run === current && ownsTurn && generation === token && !signal.aborted;
      let step: AutoStepStage = "change snapshot";
      try {
        const boundaryCalls = new Set([id, ...boundaryCarriers]);
        if (nativeWork?.pending(boundaryCalls))
          return result({
            pending: true,
            action: activeAction ? actionView(activeAction) : null,
            instruction:
              "Native work is still admitted. Continue its normal coordination or wait for results; no new action or completion is selected.",
          });
        if (params.result) await settleAction(params.result as ActionResult, ctx, signal);
        if (!valid() || current.status !== "running") return result(statusView(), true);
        await collectActionEvidence(signal);
        if (activeAction)
          return result({
            cached: true,
            action: actionView(activeAction),
            instruction: actionInstruction(activeAction),
          });
        completedFacts = undefined; // A newer selection supersedes every provisional finish.
        const snapshot = await autoObservation("change snapshot", () =>
          readSnapshot(ctx.cwd, current.snapshot.change, cliOptions(), signal),
        );
        if (!valid()) return result({ error: "Auto observation was superseded" }, true);
        current.observe(snapshot, false);
        catalog = observeCatalog(ctx);
        catalogFingerprint = catalogueHash(catalog);
        history = readHistory(ctx, snapshot);
        historyError = null;
        const selectedCatalog = catalog;
        const selectedCatalogueHash = catalogFingerprint;
        const selectedHistoryHash = hash(history.records);
        const choices: Record<string, string> = Object.create(null);
        const targets = new Map<string, { skill: RasenSkill; resume?: string }>();
        selectedCatalog.forEach((skill, index) => {
          const key = `skill_${index}`;
          choices[key] = `Execute existing native skill ${skill.name}: ${skill.description}`;
          targets.set(key, { skill });
        });
        const lastAction = [...history.records].reverse().find((record) => "actionId" in record);
        if (lastAction && "actionId" in lastAction && lastAction.kind !== "action-settled") {
          const skill = selectedCatalog.find((s) => s.name === lastAction.skill);
          if (skill) {
            choices.resume = `Resume the unfinished ${skill.name} invocation using its native history and skill-owned records, without resetting counters or repeating ambiguous effects: ${skill.description}`;
            targets.set("resume", {
              skill,
              resume: `native action ${lastAction.actionId}; session event ${lastAction.eventId}`,
            });
          }
        }
        choices.finish =
          "The user's requested outcome is already supported by fresh actual change/native evidence, with no required work or unresolved authorization left. Propose finishing; this is not execution proof or permission, and host quiescence/freshness must still pass.";
        choices.replan =
          "A contradicted assumption or repeated failure needs the existing Architect recovery gate before choosing another approach; no tool permissions are granted.";
        choices.needs_user =
          "Essential user information, a decision, permission, or safe interpretation of incomplete evidence is missing. Pause rather than inventing progress.";
        choices.uncertain =
          "The available observations do not support a sufficiently confident next action.";
        const facts = buildAutoDecisionEvidence(
          snapshot,
          goal(snapshot.change, runInstructions),
          params.summary,
          history.records,
          bridge.state()?.evidence ?? [],
          config.maxEvidenceChars,
        );
        facts.choices = choices;
        const selectionFingerprint = hash({
          snapshot: snapshot.fingerprint,
          catalog: selectedCatalogueHash,
          goal: runRequest,
          history: history.records,
          choices,
        });
        step = "advice";
        const architect = bridge.state();
        if (!architect) throw new AutoPreflightError("Architect is unavailable");
        const primary =
          dependencies.decision?.(config, ctx) ??
          createJevProvider(
            {
              model: "jev-latest",
              timeoutMs: config.decisionTimeoutMs,
              maxEvidenceChars: config.maxEvidenceChars,
            },
            { readApiKey: () => ctx.modelRegistry.authStorage.keys.get("typesafe") },
          );
        const fallback =
          dependencies.fallback?.(config, ctx) ??
          createDecisionFallback(pi, ctx, architect.config, config);
        const auditChoice = (choice: {
          choice: string;
          confidence: number;
        }): AutoJournalDecision => ({
          choice: choice.choice,
          criterion: choices[choice.choice],
          confidence: choice.confidence,
          evidenceRefs: [
            `change:${snapshot.fingerprint}`,
            `catalogue:${selectedCatalogueHash}`,
            ...history.records.slice(-4).map((r) => `native-event:${r.eventId}`),
          ],
        });
        const decision = await current.decide(facts, primary, fallback, signal, fallbackTimeoutMs);
        if (!valid()) return result({ error: "Auto decision was superseded" }, true);
        if (!decision) {
          const accepted = current
            .statusView()
            .decisionDiagnostics.attempts.findLast((attempt) => attempt.outcome === "accepted");
          if (
            accepted?.choice &&
            accepted.confidence !== undefined &&
            Object.hasOwn(choices, accepted.choice)
          )
            lastDecision = auditChoice({
              choice: accepted.choice,
              confidence: accepted.confidence,
            });
          notify(ctx);
          return result(statusView(), true);
        }
        if (!Object.hasOwn(choices, decision.choice))
          throw new AutoPreflightError(
            "Jev returned an action outside the observed native catalogue",
          );
        const fresh = await readSnapshot(ctx.cwd, current.snapshot.change, cliOptions(), signal);
        const freshCatalog = observeCatalog(ctx);
        if (!valid()) return result({ error: "Auto decision was superseded" }, true);
        if (
          fresh.fingerprint !== snapshot.fingerprint ||
          catalogueHash(freshCatalog) !== selectedCatalogueHash ||
          hash(readHistory(ctx, fresh).records) !== selectedHistoryHash
        )
          return result(
            {
              error:
                "Change, native skill catalogue, or native history changed during selection; observe and choose again",
            },
            true,
          );
        if (nativeWork?.pending(boundaryCalls))
          return result({
            pending: true,
            instruction:
              "Native work appeared during selection; await its results before selecting another action",
          });
        const audit = auditChoice(decision);
        lastDecision = audit;
        if (decision.choice === "replan") {
          architect.pendingRecovery = true;
          return result({
            decision: audit,
            instruction:
              "Resolve the existing Architect recovery gate with actual evidence, then ask Jev to select the next skill; no pipeline transition or permission is implied.",
          });
        }
        if (decision.choice === "finish") {
          const gate = architect.gate("task", {});
          if (gate || architect.reviewInProgress)
            return result({
              blocked: true,
              decision: audit,
              instruction:
                gate ?? "Await the existing Architect review before proposing completion",
            });
          completedFacts = {
            snapshot: snapshot.fingerprint,
            catalog: selectedCatalogueHash,
            history: selectedHistoryHash,
          };
          return result({
            decision: audit,
            finishProposed: true,
            instruction:
              "Jev proposes that the requested outcome is supported. Return a factual summary with evidence and limitations; Auto still verifies fresh facts and native quiescence at stop.",
          });
        }
        const target = targets.get(decision.choice);
        if (!target) throw new AutoPreflightError("Selected Auto action is unavailable");
        const content = await readSkill(target.skill, signal);
        if (!valid()) return result({ error: "Selected skill loading was superseded" }, true);
        const ready = await readSnapshot(ctx.cwd, current.snapshot.change, cliOptions(), signal);
        if (!valid()) return result({ error: "Selected skill loading was superseded" }, true);
        if (
          ready.fingerprint !== snapshot.fingerprint ||
          catalogueHash(observeCatalog(ctx)) !== selectedCatalogueHash ||
          hash(readHistory(ctx, ready).records) !== selectedHistoryHash
        )
          return result(
            {
              error:
                "Change or native context changed while loading the skill; observe and choose again",
            },
            true,
          );
        if (nativeWork?.pending(boundaryCalls))
          return result({
            pending: true,
            instruction:
              "Native work appeared while loading the skill; await its results before selecting another action",
          });
        const roles = ["omp-worker", "omp-reviewer", "omp-explorer"];
        const routes: NonNullable<NativeActionAdmission["roleRoutes"]> = {};
        const errors: Record<string, string> = {};
        if (!nativeWork) throw new AutoPreflightError("Native OMP execution is unavailable");
        for (const role of roles) {
          const selected = resolveNativeRoleRoute(
            role,
            nativeWork.host,
            ctx.models,
            routeAgent(role, architect.config),
          );
          if (selected.error) errors[role] = selected.error;
          else if (selected.route) routes[role] = selected.route;
        }
        const admission: NativeActionAdmission = {
          actionId: crypto.randomUUID(),
          skillName: content.name,
          inputFingerprint: snapshot.fingerprint,
          selectionFingerprint,
          allowedRoles: roles,
          roleRoutes: routes,
        };
        if (!current.continue()) {
          notify(ctx);
          return result(statusView(), true);
        }
        journal("action-selected", {
          inputFingerprint: admission.inputFingerprint,
          actionId: admission.actionId,
          skill: content.name,
          decision: audit,
        });
        journal("action-admitted", {
          inputFingerprint: admission.inputFingerprint,
          actionId: admission.actionId,
          skill: content.name,
          decision: audit,
        });
        activeAction = {
          skill: content,
          admission,
          decision: audit,
          receipts: [],
          evidenceArtifacts: new Map(),
          ...(target.resume ? { resume: target.resume } : {}),
        };
        roleRouteErrors.set(admission.actionId, errors);
        completedFacts = undefined;
        activity(ctx);
        return result({
          decision: audit,
          action: actionView(activeAction),
          instruction: actionInstruction(activeAction),
        });
      } catch (error) {
        if (signal.aborted)
          error = new AutoPreflightError(
            timeout.signal.aborted
              ? "Auto action boundary timed out"
              : "Auto action boundary was superseded",
          );
        if (error instanceof AutoObservationError) {
          step = error.stage;
          error = error.cause;
        }
        const diagnostic = autoStepDiagnostic(step, error);
        if (run === current && generation === token) {
          current.stop(signal.aborted ? "cancelled" : "blocked", diagnostic);
          notify(ctx);
        }
        return result({ error: diagnostic }, true);
      } finally {
        clearTimeout(timer);
        if (generation === token) inFlight = false;
      }
    },
  });
  const resultDetails = (value: unknown) =>
    value && typeof value === "object" && "details" in value ? value.details : undefined;
  pi.on("message_update", (_event, ctx) => {
    if (ctx.agent.kind === "main") activity(ctx);
  });
  pi.on("tool_execution_start", (event, ctx) => {
    if (ctx.agent.kind === "main") nativeWork?.callStarted(event.toolCallId, event.toolName);
  });
  pi.on("tool_execution_update", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    nativeEvidence?.receipt(event.toolCallId, resultDetails(event.partialResult));
    activity(ctx);
  });
  pi.on("tool_execution_end", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const details = resultDetails(event.result) as { __interrupted?: boolean } | undefined;
    nativeWork?.callEnded(event.toolCallId, details?.__interrupted === true);
    nativeEvidence?.receipt(event.toolCallId, details);
  });
  pi.on("tool_result", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    const call = mainCalls.get(event.toolCallId);
    if (call) {
      const list = mainReceipts.get(call.actionId) ?? [];
      list.push({
        toolCallId: event.toolCallId,
        tool: call.tool,
        isError: event.isError === true,
        sha256: createHash("sha256").update(JSON.stringify(event.content)).digest("hex"),
      });
      mainReceipts.set(call.actionId, list.slice(-128));
      mainCalls.delete(event.toolCallId);
    }

    nativeWork?.callEnded(
      event.toolCallId,
      (event.details as { __interrupted?: boolean } | undefined)?.__interrupted === true,
    );
    nativeEvidence?.receipt(event.toolCallId, event.details);
    if (event.toolName === "eval") boundaryCarriers.delete(event.toolCallId);
    if (event.toolName !== "auto_status") activity(ctx);
    if (!ownsTurn || run?.status !== "running" || event.toolName !== "task") return;
    const details = event.details as
      | { results?: Array<{ aborted?: boolean; error?: string; abortReason?: string }> }
      | undefined;
    const results = Array.isArray(details?.results) ? details.results : [];
    if (
      results.some(
        (result) =>
          result.aborted === true ||
          /requires approval|blocked by (?:tool|user) policy/i.test(result.error ?? ""),
      )
    ) {
      run.stop(
        "needs_user",
        "A native leaf worker was cancelled or requires authorization; inspect its result before explicitly resuming",
      );
      notify(ctx);
    }
  });
  pi.events.on("task:subagent:event", (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !activeContext ||
      !ownsTurn ||
      run?.status !== "running"
    )
      return;
    const data = value as {
      id?: string;
      event?: {
        type?: string;
        isError?: boolean;
        result?: { content?: Array<{ type?: string; text?: string }> };
      };
    };
    if (
      !data.id ||
      !nativeWork ||
      nativeWork.host.registry.get(data.id)?.parentId !== nativeWork.owner
    )
      return;
    activity(activeContext);
    if (data.event?.type !== "tool_execution_end" || !data.event.isError) return;
    const text =
      data.event.result?.content
        ?.flatMap((part) => (part.type === "text" ? [part.text ?? ""] : []))
        .join("\n") ?? "";
    if (/requires approval but no interactive UI|blocked by (?:tool|user) policy/i.test(text)) {
      run.stop(
        "needs_user",
        "A native child tool requires authorization or was denied by policy; Auto scheduling is held",
      );
      notify(activeContext);
    }
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent.kind !== "main") return;
    if (!event.willContinue) userTurnOwnsContext = false;
    // Native async/IRC continuations are owned by OMP. Terminal observation must
    // not abort children or reinterpret a scheduling pause as cancellation.
    if (!ownsTurn || event.willContinue || inFlight || run?.status !== "running") return;
    if (
      event.messages.some(
        (message) => message.role === "assistant" && message.stopReason === "aborted",
      )
    ) {
      run.stop("needs_user", "Native execution was interrupted; Auto scheduling is held");
      notify(ctx);
    }
  });
  pi.on("tool_approval_resolved", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !ownsTurn || event.approved) return;
    run?.stop("needs_user", "A tool authorization was denied; no automatic workaround is allowed");
    notify(ctx);
  });

  return {
    async initialize(ctx: ExtensionContext) {
      cwd = ctx.cwd;
      ctx.ui.setEditorComponent?.(createCommandEditor(pi.pi.CustomEditor));
      stop("Session changed; Auto does not resume automatically");
      run = undefined;
      activeContext = undefined;
      drain?.abort();
      nativeWork = undefined;
      nativeEvidence = undefined;
      activeAction = undefined;
      catalog = [];
      catalogFingerprint = "";
      history = { records: [], diagnostics: [], valid: true };
      historyError = null;
      lastDecision = undefined;
      spawnAdmissions.clear();
      roleRouteErrors.clear();
      mainCalls.clear();
      mainReceipts.clear();
      receiptErrors.length = 0;
      boundaryCarriers.clear();
      completedFacts = undefined;
      diagnosticRead = undefined;
      delivery = undefined;
      continuations.clear();
      userTurnOwnsContext = false;
      inputEvent = undefined;
      ownsTurn = false;
      bootstrap = "";
      runInstructions = "";
      runRequest = "";
      expectedContinuation = "";
      configError = "";
      try {
        config = await loadAutoConfig(ctx.cwd, pi.pi.getAgentDir());
      } catch (error) {
        config = { ...autoDefaults, enabled: false };
        configError = `${error instanceof Error ? error.message : "Could not load Auto configuration"}; Auto is disabled until corrected and the session is restarted`;
      }
    },
    shutdown() {
      stop("Session closed");
    },
    isRunning() {
      return ownsTurn && run?.status === "running";
    },
    handlesCompletion() {
      return ownsTurn && !!run;
    },
    request() {
      return ownsTurn ? runRequest : undefined;
    },
    instructions() {
      return ownsTurn ? autoPolicy : "";
    },
    architectBlocked(reason: string, ctx: ExtensionContext) {
      if (!ownsTurn) return;
      run?.stop("blocked", reason);
      notify(ctx);
    },
    userInput(event: InputEvent) {
      // Retain the first qualifying input for this run, including when it
      // arrives after a prior hold. Never retain text, command names or images.
      if (run && !inputEvent) {
        const imageCount = event.images?.length ?? 0;
        inputEvent = {
          at: run.now(),
          source: event.source,
          kind: imageCount
            ? event.text.trim()
              ? "text_and_images"
              : "images"
            : event.text.trim().startsWith("/")
              ? "command"
              : "text",
          textLength: event.text.length,
          imageCount,
          statusBefore: run.status,
          outcomeBefore: run.outcome ?? null,
        };
      }
      stop("Superseded by new user input");
      userInputObserved = true;
      ownsTurn = false;
      userTurnOwnsContext = true;
    },
    context(event: ContextEvent, ctx: ExtensionContext): ContextEvent["messages"] {
      // Idle sendMessage starts a real agent turn without before_agent_start; queued
      // nextTurn delivery does call it. Admit both through the same exact-start gate.
      const isUser = (message: ContextEvent["messages"][number] | undefined) =>
        message?.role === "user" ||
        (message?.role === "custom" &&
          message.customType === "skill-prompt" &&
          message.attribution === "user");
      const isContinuation = (message: ContextEvent["messages"][number]) =>
        message.role === "custom" &&
        message.customType === "session-stop-continuation" &&
        typeof message.content === "string" &&
        message.content.includes(`\n\nAuto continuation: ${deliveryTag}:`);
      const latest = [...event.messages]
        .reverse()
        .find(
          (message) =>
            isUser(message) ||
            message.role === "assistant" ||
            message.role === "toolResult" ||
            (message.role === "custom" && message.customType === "omp-auto-run") ||
            isContinuation(message),
        );
      const userTail = [...event.messages]
        .reverse()
        .find(
          (message) =>
            isUser(message) || message.role === "assistant" || message.role === "toolResult",
        );
      const newUserCompanions = userTurnOwnsContext && isUser(userTail);
      return event.messages.filter((message) => {
        if (message.role === "custom" && isContinuation(message)) {
          const valid =
            ownsTurn &&
            run?.status === "running" &&
            !lifetime.signal.aborted &&
            delivery?.sessionId === ctx.sessionManager.getSessionId() &&
            message.display === false &&
            message.attribution === "agent" &&
            continuations.has(String(message.content));
          if (!valid && message === latest && !newUserCompanions) {
            stop("Stale Auto continuation in provider context", ctx);
          }
          return !!valid;
        }
        if (message.role !== "custom" || message.customType !== "omp-auto-run") return true;
        const details = message.details as
          | (Partial<typeof delivery> & { controller?: string })
          | undefined;
        const valid =
          ownsTurn &&
          run?.status === "running" &&
          delivery &&
          !lifetime.signal.aborted &&
          ctx.sessionManager.getSessionId() === delivery.sessionId &&
          message.content === delivery.content &&
          message.display === false &&
          message.attribution === "agent" &&
          details?.controller === deliveryTag &&
          details?.sessionId === delivery.sessionId &&
          details?.runId === delivery.runId &&
          details?.ref === delivery.ref &&
          details?.sha256 === delivery.sha256;
        if (!valid) {
          // Remove only our own stale instructions. Native result/IRC context is untouched.
          if (message === latest && !newUserCompanions) {
            stop("Stale or changed Auto internal delivery", ctx);
          }
          return false;
        }
        if (bootstrap) {
          if (message !== latest) {
            stop("Auto internal delivery was superseded before admission", ctx);
            return false;
          }
          bridge.acceptInternal(bootstrap, ctx);
        }
        return run?.status === "running" && !lifetime.signal.aborted;
      });
    },
    beforeStart(text: string, ctx: ExtensionContext): "new" | "continue" | "blocked" {
      if (expectedContinuation) {
        const expected = expectedContinuation;
        expectedContinuation = "";
        if (text === expected && ownsTurn && run?.status === "running") return "continue";
        if (ownsTurn) {
          stop("Unexpected continuation context; no new user request was observed");
          notify(ctx);
          return "blocked";
        }
      }
      if (bootstrap) {
        if (text === bootstrap) {
          bootstrap = "";
          return "new";
        }
        stop("Auto bootstrap changed before delivery");
        notify(ctx);
        return "blocked";
      }
      if (
        text.includes(`\n\nAuto run: ${deliveryTag}:`) ||
        text.includes(`\n\nAuto continuation: ${deliveryTag}:`)
      ) {
        stop("Stale Auto delivery after cancellation or session change");
        notify(ctx);
        return "blocked";
      }
      if (run && !userInputObserved) return "continue";
      userInputObserved = false;
      stop("Superseded by a new user request");
      ownsTurn = false;
      userTurnOwnsContext = true;
      return "new";
    },
    routeSpawn(event: BeforeSubagentSpawnEvent): {
      handled: boolean;
      reason?: string;
      model?: string;
    } {
      const admitted = spawnAdmissions.resolve(event);
      if (admitted) return { handled: true as const, ...admitted };
      if (!ownsTurn) return { handled: false as const };
      return {
        handled: true as const,
        reason:
          "No matching admitted native Auto task owns this spawn; call auto_step and submit its scoped task first",
      };
    },
    rejectToolCall(id: string) {
      spawnAdmissions.reject(id);
    },
    toolCall(id: string, tool: string, input: Record<string, unknown>, ctx: ExtensionContext) {
      if (!ownsTurn || !run) return;
      if (run.status !== "running") {
        if (["read", "grep", "glob", "find", "ls", "wait", "auto_status"].includes(tool)) return;
        return "Auto scheduling is held. Await admitted native results or send a new request; no late execution is admitted";
      }
      if (!run.toolCall(id)) {
        notify(ctx);
        return `OMP Auto ${run.status}: ${run.reason}`;
      }
      if (inFlight && !["auto_status", "wait"].includes(tool))
        return "An Auto action boundary is being recorded; await it before admitting more execution";
      const carrier = tool === "eval" && autoStepCarrier(input);
      const messaging =
        tool === "send" ||
        tool === "irc" ||
        (tool === "write" && nativeAgentMessagePath(input) !== undefined);
      const active = activeAction;
      if (carrier) boundaryCarriers.add(id);
      if (
        active &&
        ![
          "auto_step",
          "auto_record",
          "eval",
          "auto_status",
          "architect_checkpoint",
          "todo",
          "wait",
          "task",
          "send",
          "irc",
        ].includes(tool) &&
        !carrier &&
        !messaging
      )
        mainCalls.set(id, { actionId: active.admission.actionId, tool });
      if (safeMainTools.has(tool) || carrier) return;
      const reviewOnly =
        (tool === "write" && reviewWrite(input, bridge.state()?.config.maxReviewBytes ?? 131072)) ||
        (tool === "eval" && reviewCarrier(input, bridge.state()?.config.maxReviewBytes ?? 131072));
      if (reviewOnly) return;
      if (!active)
        return "Call auto_step and await admission of an Jev-selected Rasen skill before execution";
      if (tool === "task") {
        const tasks = Array.isArray(input.tasks) ? input.tasks : [input];
        for (const item of tasks) {
          if (!item || typeof item !== "object")
            return "Native action task must use an explicit Auto action admission";
          const task = item as Record<string, unknown>;
          if (
            typeof task.task !== "string" ||
            !task.task
              .split(/\r?\n/)
              .some((line) => line.trim() === `Auto action: ${active.admission.actionId}`)
          )
            return `Native task prompts must include the exact line Auto action: ${active.admission.actionId}`;
          if (!active.admission.allowedRoles.includes(String(task.agent)))
            return `Action ${active.admission.actionId} does not admit this native role`;
          const role = String(task.agent);
          const routeError = roleRouteErrors.get(active.admission.actionId)?.[role];
          if (routeError) return routeError;
          const route = active.admission.roleRoutes?.[role];
          if (route && (task.model !== route.selector || task.effort !== undefined))
            return `Preserve the configured native route for ${role} through native task model=${route.selector} without a conflicting coarse effort override`;
        }
      }
      if (messaging && nativeWork && Object.keys(active.admission.roleRoutes ?? {}).length) {
        const recipient =
          tool === "write"
            ? nativeAgentMessagePath(input)
                ?.replace(/^agent:\/\//i, "")
                .split(/[/?#]/)[0]
            : typeof input.to === "string"
              ? input.to
              : undefined;
        const verified = recipient ? nativeEvidence?.recipient(recipient) : undefined;
        const role = verified?.role;
        if (!role)
          return "The native recipient's role/model route is unverified; use a fresh scoped native task";
        const routeError = roleRouteErrors.get(active.admission.actionId)?.[role];
        if (routeError) return routeError;
        const error = nativeStageReuseError(
          nativeWork.host,
          recipient,
          active.admission.roleRoutes?.[role],
          verified?.provenance,
        );
        if (error) return error;
      }
      if (tool === "task") {
        const gate = bridge.state()?.gate("task", input);
        if (gate) return gate;
        const tasks = (Array.isArray(input.tasks) ? input.tasks : [input]) as Array<
          Record<string, unknown>
        >;
        spawnAdmissions.admit(
          id,
          active.admission.actionId,
          tasks.map((task) => ({
            agent: String(task.agent),
            ...(typeof task.name === "string" ? { name: task.name } : {}),
            model:
              active.admission.roleRoutes?.[String(task.agent)]?.selector ??
              (bridge.state() ? routeAgent(String(task.agent), bridge.state()!.config) : undefined),
            constrained: active.admission.roleRoutes?.[String(task.agent)] !== undefined,
          })),
        );
      }
      nativeEvidence?.admit(id, tool, input, active.admission);
    },
    pendingAsync(exceptCalls: ReadonlySet<string> = new Set()) {
      return nativeWork?.pending(exceptCalls) ?? false;
    },
    async complete(
      _material: ReviewMaterial,
      _ctx: ExtensionContext,
      _toolSignal: AbortSignal | undefined,
      _invocationId: string,
      _completionCalls: ReadonlySet<string> = new Set(),
    ): Promise<Verdict> {
      return {
        decision: "blocked",
        summary:
          "Auto uses actual skill outcomes and Jev's next-action selection. Call auto_step at the selected skill's boundary; no outer Architect completion loop is added.",
        issues: [],
      };
    },
    async onStop(
      event: SessionStopEvent,
      ctx: ExtensionContext,
    ): Promise<{ handled: boolean; result?: { continue: boolean; additionalContext: string } }> {
      if (!ownsTurn || !run) return { handled: false };
      const current = run;
      if (event.signal.aborted) current.stop("cancelled", "Run cancelled");
      if (!current.checkTime()) {
        notify(ctx);
        return { handled: true };
      }
      if (inFlight) {
        current.stop("blocked", "Concurrent Auto boundary rejected");
        notify(ctx);
        return { handled: true };
      }
      inFlight = true;
      const token = generation;
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), Math.max(24000, config.cliTimeoutMs * 3));
      const signal = AbortSignal.any([event.signal, lifetime.signal, timeout.signal]);
      try {
        const snapshot = await readSnapshot(ctx.cwd, current.snapshot.change, cliOptions(), signal);
        if (run !== current || !ownsTurn || signal.aborted) return { handled: true };
        current.observe(snapshot, false);
        catalog = observeCatalog(ctx);
        catalogFingerprint = catalogueHash(catalog);
        history = readHistory(ctx, snapshot);
        historyError = null;
        if (!current.checkTime()) {
          notify(ctx);
          return { handled: true };
        }
        if (nativeWork?.pending()) return { handled: true };
        await collectActionEvidence(signal);
        if (run !== current || !ownsTurn || signal.aborted) return { handled: true };
        if (
          !activeAction &&
          completedFacts?.snapshot === snapshot.fingerprint &&
          completedFacts.catalog === catalogFingerprint &&
          completedFacts.history === hash(history.records) &&
          !current.observationError &&
          !historyError &&
          !bridge.state()?.gate("task", {}) &&
          !bridge.state()?.reviewInProgress
        )
          current.stop(
            "completed",
            "Requested outcome selected from fresh evidence; admitted native work is settled",
          );
        else
          current.stop(
            "needs_user",
            "Native Main stopped without a current evidence-based finish decision; retain skill/native progress and explicitly resume when ready",
          );
        notify(ctx);
        return { handled: true };
      } catch {
        if (run === current && ownsTurn) {
          current.stop(
            event.signal.aborted ? "cancelled" : "blocked",
            "Auto observation or native boundary failed; completion is unverified",
          );
          notify(ctx);
        }
        return { handled: true };
      } finally {
        if (run === current && ownsTurn && signal.aborted && current.status === "running") {
          current.stop(
            event.signal.aborted ? "cancelled" : "blocked",
            "Auto boundary cancelled or timed out",
          );
          notify(ctx);
        }
        clearTimeout(timer);
        if (token === generation) inFlight = false;
      }
    },
  };
}

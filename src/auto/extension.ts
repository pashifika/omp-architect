import {
  AutoPreflightError,
  AutoObservationError,
  autoObservation,
  autoCompletionDiagnostic,
  type AutoCompletionStage,
  autoStepDiagnostic,
  type AutoStepStage,
  autoPreflightDiagnostic,
  type AutoPreflightStage,
} from "./diagnostics.ts";
import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStopEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { Orchestrator, Phase, Verdict, ReviewMaterial } from "../core.ts";
import { autoDefaults, loadAutoConfig, type AutoConfig } from "./config.ts";
import { AutoRun } from "./core.ts";
import {
  readRasenWorkflow,
  assessWorkflowScope,
  HostAutoWorkflow,
  type RasenWorkflow,
} from "./workflow.ts";
import { createJevProvider, type DecisionProvider, type DecisionEvidence } from "./decision.ts";
import { createDecisionFallback } from "./fallback.ts";
import { readRasenSnapshot, validateRasenChange, type RasenSnapshot } from "./rasen.ts";
import { autoRequest, autoUsage, briefRoot, parseAutoStart, renderBrief } from "./instructions.ts";
import { completeAuto } from "./completion.ts";
import { confirmAutoStart } from "./confirmation.ts";
import { saveAutoPayload, reviewWrite, reviewCarrier } from "../artifacts.ts";
import { createCommandEditor } from "../brief/editor.ts";
import { readWorkspaceEvidence } from "./workspace.ts";
import { createHash } from "node:crypto";
import { NativeQuiescence, nativeAsyncHost, type NativeAsyncHost } from "./async.ts";
import { NativeReviewEvidence, nativeAgentMessagePath } from "./evidence.ts";

const autoPolicy =
  "OMP Auto implements the prepared-change workflow in this extension. The main session is its LEAD; use native OMP leaf tasks for implementation and independent verification. Register the exact approved todo steps and await success before execution, never in the same batch. Normal plan/recovery gates and approvals remain authoritative. Auto owns the single completion review loop: do not run an additional rasen-review-cycle. Use the existing native-file architect_checkpoint phase=completion; Auto adds fresh Rasen verification before the independent review. After each actual workflow stage boundary, call auto_step for Jev next-step advice, then continue the workflow in the same native turn. Do not yield after individual tools, skill reads or task checkboxes. Use phase=blocked for an honest blocker without a review. Never claim completion until OMP Auto reports completed.";

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
      Object.keys(params).every((key) => ["summary", "transition"].includes(key)) &&
      (params.transition === undefined || params.transition === "triage")
    );
  } catch {
    return false;
  }
}

function stageInstruction(phase: string): string {
  switch (phase) {
    case "apply":
      return "Use native omp-worker leaves to implement the approved remaining tasks. Preserve scope, validate actual work and update task checkboxes truthfully. Await all native work, then call auto_step.";
    case "verify":
      return "Use an independent native omp-reviewer leaf (a fresh task or a native IRC rerequest with fresh evidence) to inspect the current diff and run relevant validation/tests for the single currently allowed verification stage shown in this response. Other stages require their own admitted boundaries. Give it the task artifacts and previous findings. It must return factual commands, results and issues through its native artifact. Await its actual receipt, then call auto_step. Failed verification is not a pass.";
    case "review":
    case "delta-review":
      return "Write the full factual native review evidence including independent verification results and current changes; call architect_checkpoint phase=completion. The host owns the one configured semantic review budget. Await its verdict; if approved, return the final factual summary. Otherwise call auto_step before the next phase.";
    case "triage":
      return "Read the independent review findings, identify necessary scoped fixes and unresolved questions, then call auto_step transition=triage with a concise disposition. Do not edit before entering fix; changed scope requires recovery/user authorization.";
    case "fix":
      return "Give the triaged findings and evidence artifacts to a native omp-worker fixer leaf separate from the reviewer. Apply only necessary authorized fixes, await its native receipt, then call auto_step for fresh independent verification.";
    case "settled":
      return "Return a factual final summary. Stop-time fresh task, code, workflow and validation checks must still pass before Auto reports completed. Do not ship, archive, publish or merge.";
    default:
      return "Stop and report the exact blocker; no execution is authorized by this phase.";
  }
}

export interface AutoDependencies {
  snapshot?: typeof readRasenSnapshot;
  workflow?: typeof readRasenWorkflow;
  validate?: typeof validateRasenChange;
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
  let workflow: RasenWorkflow | undefined;
  let hostWorkflow: HostAutoWorkflow | undefined;
  let admittedBoundary = "";
  const boundaryCarriers = new Set<string>();
  let nativeEvidence: NativeReviewEvidence | undefined;
  let workflowError: string | null = null;
  let verifiedWorkflowFingerprint = "";
  let approvedFacts: { snapshot: string; workflow: string } | undefined;
  let reviewingFacts: { snapshot: string; workflow: string } | undefined;
  let completionReminders = 0;
  let activeContext: ExtensionContext | undefined;
  let nativeWork: NativeQuiescence | undefined;
  let drain: AbortController | undefined;
  let runCwd = "";
  const adviceCache = new Map<string, unknown>();
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
  let userTurnOwnsContext = false;
  const continuations = new Set<string>();
  let lifetime = new AbortController();
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let notified = "";
  let inFlight = false;
  let generation = 0;
  // Recognize this controller's queued deliveries even after stop/session reset cleared ownership.
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
        fingerprint: createHash("sha256")
          .update(snapshot.fingerprint)
          .update(workspace.fingerprint)
          .digest("hex"),
      };
    });
  const validate = dependencies.validate ?? validateRasenChange;
  const readWorkflow = dependencies.workflow ?? readRasenWorkflow;
  const resolveNativeHost =
    dependencies.nativeHost ?? ((ctx: ExtensionContext) => nativeAsyncHost(pi, ctx));
  const cliOptions = () => ({
    executable: config.rasenExecutable,
    timeoutMs: config.cliTimeoutMs,
    maxOutputBytes: 65536,
  });

  function statusView() {
    if (!run) return { status: "idle", enabled: config.enabled, error: configError || null };
    return {
      ...run.statusView(),
      hostWorkflow: hostWorkflow?.statusView(),
      nativeWork: {
        pending: nativeWork?.pending() ?? false,
        waitingFor: "native Main and child settlement (may include other work sharing this Main)",
        draining: run.status === "draining",
        settlementUnverified: nativeWork?.uncertainty ?? [],
      },
      completionVerified:
        run.statusView().completionVerified &&
        !workflowError &&
        workflow?.fingerprint === verifiedWorkflowFingerprint,
      completionScope: "prepared-change apply/verification/host review",
      pipelineComplete: false,
      workflow:
        workflow?.kind === "present"
          ? {
              kind: workflow.kind,
              pipeline: workflow.pipeline,
              completed: workflow.completed,
              remaining: workflow.remaining,
              next: workflow.next,
              scope: assessWorkflowScope(workflow),
              reviewAuthority:
                "OMP Architect completion checkpoint; Rasen review-cycle remains pending",
            }
          : workflow
            ? { kind: workflow.kind }
            : null,
      workflowError,
    };
  }

  /** Diagnostics have their own bounded read scope, independent of stopped execution. */
  async function refreshStatus(ctx: ExtensionContext): Promise<void> {
    const current = run;
    if (!current) return;
    if (diagnosticRead?.run === current) return diagnosticRead.promise;
    const sessionId = ctx.sessionManager.getSessionId();
    const root = runCwd;
    const options = cliOptions();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Math.min(15000, config.cliTimeoutMs * 3));
    const valid = () => run === current && sessionId === ctx.sessionManager.getSessionId();
    const promise = (async () => {
      const results = await Promise.allSettled([
        readSnapshot(root, current.snapshot.change, options, abort.signal),
        readWorkflow(root, current.snapshot.change, options, abort.signal),
      ]);
      if (!valid()) return;
      if (results[0].status === "fulfilled") current.reconcile(results[0].value);
      else
        current.observationError =
          "Fresh Rasen task observation failed; showing last known progress";
      if (results[1].status === "fulfilled") {
        workflow = results[1].value;
        if (results[0].status === "fulfilled")
          hostWorkflow?.observe(results[0].value, results[1].value);
        workflowError = null;
      } else workflowError = "Fresh Rasen workflow observation failed; showing last known workflow";
      if (
        reviewingFacts &&
        (current.snapshot.fingerprint !== reviewingFacts.snapshot ||
          workflow?.fingerprint !== reviewingFacts.workflow ||
          current.observationError ||
          workflowError)
      ) {
        bridge
          .state()
          ?.observe(
            `auto-diagnostic:${crypto.randomUUID()}`,
            "rasen_observation",
            { change: current.snapshot.change },
            "Fresh diagnostic facts changed or became unavailable during completion review; its admitted evidence is stale",
            false,
          );
      }
    })()
      .catch(() => {
        if (valid()) {
          current.observationError = "Fresh Rasen observation failed; showing last known progress";
          workflowError = "Fresh Rasen workflow observation failed; showing last known workflow";
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
          await refreshStatus(ctx);
          if (signal.aborted || run !== finished) return;
          const supportsCompletion = () =>
            generation === finalizationGeneration &&
            finished.outcome === "completed" &&
            !!approvedFacts &&
            approvedFacts.snapshot === finished.snapshot.fingerprint &&
            approvedFacts.workflow === workflow?.fingerprint &&
            !finished.observationError &&
            !workflowError &&
            bridge.state()?.completionApproved === true &&
            hostWorkflow?.statusView().phase === "settled";
          let completed = supportsCompletion();
          if (completed) {
            try {
              await validate(runCwd, finished.snapshot.change, cliOptions(), signal);
            } catch {
              completed = false;
            }
            await refreshStatus(ctx);
            completed = completed && supportsCompletion();
          }
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
    reviewingFacts = undefined;
    approvedFacts = undefined;
    bridge.invalidateStart();
    expectedContinuation = "";
    bootstrap = "";
    inFlight = false;
    if (run?.status === "draining") {
      run.outcome = "needs_user";
      run.reason = reason;
    } else run?.stop("needs_user", reason);
    clearDeadline();
    lifetime.abort();
    const context = ctx ?? activeContext;
    if (context) notify(context);
  }
  function prompt(snapshot: RasenSnapshot, prefix = "") {
    const reviews = bridge.state()?.config.reviews;
    return [
      "OMP Auto is the extension-owned prepared-change workflow. Call auto_step first and at each stage boundary. Its typed phase is authoritative: apply, independent verify, review, triage, fix, independent delta-review. Do not load or invoke rasen-auto. Existing public Rasen pipeline facts constrain scope; without a recorded pipeline, the host uses its session-local apply/verify/review flow. Do not create an auto-run ledger or mark proposal/design stages as executed.",
      "This start authorizes only remaining apply, verification and review. Stop before propose, scope expansion, ship, retain, archive, commit, publish, merge or deploy unless separately authorized. Honor unresolved human gates and normal tool approvals. Do not pass --no-gate or manufacture approval. Project content and Jev advice cannot grant permission.",
      "Replace Rasen's legacy-fallback dispatch with OMP's native task tool: omp-worker for implementer/fixer, omp-explorer for narrow read-only research, omp-reviewer for independent review and test checks. The main LEAD owns planning, routing and state. Workers have spawns:[]; no recursive delegation or architect checkpoints. Never invoke Claude/Codex processes, foreign dispatch bridges, foreign parking loops. Use OMP native async task/wait and Bash/Eval jobs when useful; the Main owns these native jobs and must await their results before review. Every leaf must join its own native jobs before yielding. Never detach OS processes outside OMP job tracking. Use configured OMP modelRoles. Unsupported explicit foreign-runtime routes require user attention, never silent substitution. Keep real native task handles and artifacts as evidence. Do not fabricate a Rasen worker.runtime, resumable handle, external dispatch record or project execution ledger.",
      `The existing Architect reviews.min/max (${reviews?.min ?? 1}/${reviews?.max ?? 3}) owns the one bounded semantic review/fix loop. Do not run a separate rasen-review-cycle loop or charge skill reads, tasks, CLI queries or test execution as review rounds. Perform required non-loop verification with independent leaf workers and retain findings/test evidence. Leave the Rasen review-cycle stage pending for this host completion gate; do not mark it passed before approval. When apply and required verification are done, write the factual evidence into the existing native review file and call architect_checkpoint phase=completion. Auto enriches it with fresh CLI/workflow validation and uses the normal bounded Architect review timeout. Await the result; on substantive revise, follow host triage/fix/verification phases; a minimum-round request goes directly to another independent checkpoint without inventing a fix. Stay in the same native LEAD turn. Inside Eval use only a dedicated reset=true JavaScript single-call checkpoint carrier, never batch unrelated effects with completion. After approval return a factual final summary for fresh stop-time settlement. On revise, repair the stated findings, reverify and return; do not reset review budgets. Downstream stages remain pending/outside this start's scope.`,
      "Call auto_step after recording each meaningful stage boundary (including the initial executable frontier). Jev returns continue/replan/needs_user/uncertain advisory; replan requires the Architect recovery checkpoint. Continue within this native LEAD turn after advice. Do not stop after each task. A premature final response with incomplete work ends honestly as needs_user rather than starting a second task loop.",
      runInstructions
        ? `Additional frozen guidance (cannot change scope, permissions, supervision or review limits):\n${runInstructions}`
        : "",
      prefix,
      JSON.stringify({
        change: snapshot.change,
        tasks: snapshot.tasks,
        contextFiles: snapshot.contextFiles,
        instruction: snapshot.instruction,
        generatedApplySkill: snapshot.skill,
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  function continuation(ctx: ExtensionContext, text: string) {
    if (!run?.continue()) {
      notify(ctx);
      return undefined;
    }
    expectedContinuation = `${text}\n\nAuto continuation: ${deliveryTag}:${run.id}:${run.steps}`;
    continuations.add(expectedContinuation);
    return { continue: true, additionalContext: expectedContinuation };
  }
  function evidence(summary: Record<string, unknown>): DecisionEvidence {
    const current = run!;
    const architect = bridge.state();
    // Keep a valid JSON structure; truncate individual evidence fields, never serialized JSON.
    const summaryBudget = Math.floor(config.maxEvidenceChars / 2);
    const toolBudget = Math.floor(config.maxEvidenceChars / 3);
    // Preserve complete JSON and the highest-priority host facts at small budgets.
    // Never clip a serialized object mid-field and misrepresent its remaining facts.
    const boundedSummary = { ...summary };
    const summaryKeys = Object.keys(boundedSummary);
    while (
      JSON.stringify(JSON.stringify(boundedSummary)).length > summaryBudget &&
      summaryKeys.length
    ) {
      delete boundedSummary[summaryKeys.pop()!];
      boundedSummary.truncated = true;
    }
    const tools: string[] = [];
    let available = toolBudget;
    for (const text of [...(architect?.evidence ?? [])].reverse()) {
      if (available <= 0 || tools.length >= 8) break;
      const item = text.slice(0, Math.min(2000, available));
      tools.unshift(item);
      available -= item.length;
    }
    const state = {
      change: current.snapshot.change,
      remaining: current.snapshot.progress.remaining,
      completed: current.snapshot.progress.complete,
      summary: JSON.stringify(boundedSummary),
      recentTools: tools,
    };
    // Escaped tool text can cost more than its character count. Leave room for
    // stage-count substitution and keep Jev's outer truncation from clipping JSON.
    while (JSON.stringify(state).length > config.maxEvidenceChars - 64 && tools.length) {
      tools.shift();
      boundedSummary.truncated = true;
      state.summary = JSON.stringify(boundedSummary);
    }
    return state;
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
        const request = autoRequest(start.change, guidance);
        if (guidance && (guidance.length > 12000 || !bridge.state()!.canRetainRequest(request))) {
          ctx.ui.notify(
            "Auto instructions exceed Architect's request-evidence budget. Shorten the brief/instructions or increase architect.json maxEvidenceChars, then restart the session. Instructions are never silently truncated",
            "error",
          );
          return;
        }
        if (commandGeneration !== generation || signal.aborted || !ctx.isIdle()) return;
        const approved = await confirmAutoStart(pi.pi, ctx.ui, start.change, guidance, signal);
        if (!approved || commandGeneration !== generation || !ctx.isIdle()) return;
        stage = "change snapshot";
        const snapshot = await readSnapshot(ctx.cwd, start.change, cliOptions(), signal);
        if (commandGeneration !== generation || lifetime.signal.aborted || !ctx.isIdle()) return;
        if (snapshot.state === "blocked") {
          ctx.ui.notify(
            "Rasen prerequisites are blocked; prepare this change before starting Auto",
            "error",
          );
          return;
        }
        stage = "workflow";
        const initialWorkflow = await readWorkflow(ctx.cwd, start.change, cliOptions(), signal);
        if (initialWorkflow.kind === "invalid")
          throw new AutoPreflightError(initialWorkflow.reason);
        if (commandGeneration !== generation || signal.aborted || !ctx.isIdle()) return;
        const candidate = new AutoRun(config, snapshot, dependencies.now);
        const candidateWorkflow = new HostAutoWorkflow(snapshot.change);
        const initialPhase = candidateWorkflow.observe(snapshot, initialWorkflow);
        if (initialPhase.phase === "blocked")
          throw new AutoPreflightError(initialPhase.reason ?? "Unsupported Auto workflow");
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
        nativeEvidence = new NativeReviewEvidence(nativeHost);
        run = candidate;
        runCwd = ctx.cwd;
        workflow = initialWorkflow;
        hostWorkflow = candidateWorkflow;
        admittedBoundary = "";
        boundaryCarriers.clear();
        workflowError = null;
        approvedFacts = undefined;
        reviewingFacts = undefined;
        completionReminders = 0;
        verifiedWorkflowFingerprint = "";
        adviceCache.clear();
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
  pi.registerTool({
    name: "auto_step",
    label: "Auto stage advice",
    description:
      "At a recorded Rasen workflow stage boundary, read fresh state and ask Jev for the next direction. Remain in the same native LEAD turn. Never call per tool, skill read, or task checkbox. Repeated frontier advice is cached; advice cannot grant permission or completion.",
    approval: "read",
    parameters: Type.Object({
      summary: Type.String({ maxLength: 4000 }),
      transition: Type.Optional(Type.Literal("triage")),
    }),
    async execute(_id, params, toolSignal, _update, ctx) {
      const result = (value: unknown, isError = false) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }],
        isError,
      });
      const current = run;
      if (ctx.agent.kind !== "main" || !ownsTurn || !current || !current.checkTime()) {
        notify(ctx);
        return result(
          { error: "No active Auto LEAD run; this tool cannot start or resume one" },
          true,
        );
      }
      if (inFlight)
        return result(
          { error: "Another Auto observation or decision is in progress; await its result" },
          true,
        );
      inFlight = true;
      const boundaryGeneration = generation;
      const timeout = new AbortController();
      const fallbackTimeoutMs = bridge.state()?.config.reviewTimeoutMs ?? config.decisionTimeoutMs;
      const timer = setTimeout(
        () => timeout.abort(new DOMException("Auto stage boundary timed out", "TimeoutError")),
        2 * config.cliTimeoutMs + config.decisionTimeoutMs + fallbackTimeoutMs + 1000,
      );
      const signal = AbortSignal.any([
        lifetime.signal,
        timeout.signal,
        ...(toolSignal ? [toolSignal] : []),
      ]);
      let stage: AutoStepStage = "change snapshot";
      try {
        const [snapshot, observedWorkflow] = await Promise.all([
          autoObservation("change snapshot", () =>
            readSnapshot(ctx.cwd, current.snapshot.change, cliOptions(), signal),
          ),
          autoObservation("workflow", () =>
            readWorkflow(ctx.cwd, current.snapshot.change, cliOptions(), signal),
          ),
        ]);
        if (run !== current || signal.aborted || generation !== boundaryGeneration)
          return result({ error: "Stage advice was superseded" }, true);
        current.observe(snapshot);
        stage = "workflow";
        workflow = observedWorkflow;
        workflowError = null;
        if (!hostWorkflow) throw new Error("Host workflow unavailable");
        const boundaryCalls = new Set([_id, ...boundaryCarriers]);
        if (nativeWork?.pending(boundaryCalls))
          return result(
            {
              error:
                "Await all Native Main or child work and verified settlement before crossing a host phase boundary",
            },
            true,
          );
        stage = "native verification";
        await nativeEvidence?.consume(
          hostWorkflow,
          bridge.state()?.config.maxReviewBytes ?? 131072,
          signal,
        );
        if (nativeWork?.pending(boundaryCalls))
          return result(
            { error: "Native work resumed while collecting evidence; await its normal results" },
            true,
          );
        stage = "workflow";
        if (hostWorkflow.statusView().phase === "settled" && !bridge.state()?.completionApproved)
          hostWorkflow.invalidateVerification();
        let phase = hostWorkflow.observe(snapshot, observedWorkflow, { settledBoundary: true });
        if (!current.checkTime()) {
          notify(ctx);
          return result(statusView(), true);
        }
        if (params.transition === "triage") {
          if (phase.phase !== "triage")
            return result(
              {
                error: "Triage is allowed only after an actual review requests fixes",
                hostWorkflow: phase,
              },
              true,
            );
          phase = hostWorkflow.acknowledgeTriage();
        }
        if (phase.phase === "settled")
          return result({ hostWorkflow: phase, instruction: stageInstruction("settled") });
        if (phase.phase === "blocked") {
          current.stop("needs_user", phase.reason ?? "Host workflow blocked");
          notify(ctx);
          return result(statusView(), true);
        }
        const frontier = hostWorkflow.effectiveWorkflow();
        const scope = assessWorkflowScope(frontier);
        if (frontier.kind !== "present") throw new Error("Host workflow unavailable");
        const exactPhase = phase.fingerprint;
        const key = hostWorkflow.semanticBoundaryKey();
        if (adviceCache.has(key)) {
          if ((adviceCache.get(key) as { choice?: string }).choice === "continue")
            admittedBoundary = exactPhase;
          return result({
            ...(adviceCache.get(key) as object),
            hostWorkflow: phase,
            stage: frontier.stages.find((stage) => stage.id === phase.stage) ?? null,
            cached: true,
          });
        }
        const architect = bridge.state();
        if (!architect) throw new Error("Architect unavailable");
        stage = "advice";
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
        const context = evidence({
          hostSource: phase.source,
          allowedPhase: phase.phase,
          externalRunStateRequired: phase.source !== "builtin",
          nextStep: phase.instruction,
          workflowContext:
            phase.source === "builtin"
              ? "Built-in native OMP workflow is active. An external Rasen run-state is not required."
              : "Recorded Rasen workflow adapted to the native OMP host.",
          allowedStage: phase.stage,
          hostBlocker: phase.reason,
          stage: (() => {
            const stage = frontier.stages.find((stage) => stage.id === phase.stage);
            return stage
              ? {
                  role: stage.role,
                  runtime: stage.runtime,
                  dispatchMode: stage.dispatchMode,
                  status: stage.status,
                }
              : null;
          })(),
          nativeWorkSettled: true,
          pipeline: frontier.pipeline,
          ready: frontier.ready,
          completed: frontier.completed,
          scopedRemaining: scope.remaining,
          taskProgress: snapshot.progress,
          openFindings: frontier.openFindings.slice(0, 8),
          assistantClaim: params.summary.slice(0, 1600),
        });
        context.completed = frontier.completed.length;
        context.remaining = scope.remaining.length + (architect.completionApproved ? 0 : 1);
        const decision = await current.decide(
          context,
          primary,
          fallback,
          signal,
          fallbackTimeoutMs,
        );
        if (run !== current || signal.aborted || generation !== boundaryGeneration)
          return result({ error: "Stage advice was superseded" }, true);
        if (!decision) {
          notify(ctx);
          return result(statusView(), true);
        }
        if (hostWorkflow.statusView().fingerprint !== exactPhase)
          return result(
            {
              error:
                "Rasen stage facts changed during advice; read current state before requesting advice for its new frontier",
            },
            true,
          );
        if (decision.choice === "replan") architect.pendingRecovery = true;
        const advice = {
          ...decision,
          pipeline: frontier.pipeline,
          ready: frontier.ready,
          cached: false,
          hostWorkflow: phase,
          allowedNextPhase: phase.phase,
          stageInstruction: stageInstruction(phase.phase),
          stage: frontier.stages.find((stage) => stage.id === phase.stage) ?? null,
          instruction:
            decision.choice === "replan"
              ? "Resolve architect_checkpoint phase=recovery before changing approach; this grants no permissions"
              : "Continue the allowed host phase in this native LEAD turn within the approved scope; this is not approval or completion",
        };
        if (decision.choice === "continue") adviceCache.set(key, advice);
        if (decision.choice === "continue") admittedBoundary = exactPhase;
        activity(ctx);
        return result(advice);
      } catch (error) {
        if (error instanceof AutoObservationError) {
          stage = error.stage;
          error = error.cause;
        }
        if (signal.aborted)
          error = new AutoPreflightError(
            timeout.signal.aborted
              ? "Auto stage boundary timed out"
              : "Auto stage boundary was cancelled or superseded",
          );
        const diagnostic = autoStepDiagnostic(stage, error);
        if (run === current && generation === boundaryGeneration) {
          current.stop(signal.aborted ? "cancelled" : "blocked", diagnostic);
          notify(ctx);
        }
        return result({ error: diagnostic }, true);
      } finally {
        clearTimeout(timer);
        if (generation === boundaryGeneration) inFlight = false;
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
      workflow = undefined;
      hostWorkflow = undefined;
      admittedBoundary = "";
      boundaryCarriers.clear();
      workflowError = null;
      approvedFacts = undefined;
      reviewingFacts = undefined;
      completionReminders = 0;
      verifiedWorkflowFingerprint = "";
      adviceCache.clear();
      diagnosticRead = undefined;
      delivery = undefined;
      continuations.clear();
      userTurnOwnsContext = false;
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
    userInput() {
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
    spawnGate(agent: string, _invocationKind: string) {
      if (ownsTurn && run?.status !== "running") return "OMP Auto stopped; no new leaf may start";
      if (ownsTurn && hostWorkflow && run?.status === "running") {
        const phase = hostWorkflow.statusView();
        if (admittedBoundary !== phase.fingerprint)
          return "Call auto_step for the current host phase and await its Jev direction before starting a leaf";
        if (agent === "omp-worker" && !["apply", "fix"].includes(phase.phase))
          return `Host phase ${phase.phase} does not allow implementation/fixer workers`;
        if (agent === "omp-reviewer" && phase.phase !== "verify")
          return `Host phase ${phase.phase} does not allow a verification leaf; use the independent Architect checkpoint for review`;
      }
      if (ownsTurn && bridge.state()?.gate("task", {})) return bridge.state()!.gate("task", {});
      return ownsTurn && !["omp-worker", "omp-explorer", "omp-reviewer"].includes(agent)
        ? "OMP Auto permits only native omp-worker, omp-explorer and omp-reviewer leaf roles"
        : undefined;
    },
    toolCall(id: string, tool: string, input: Record<string, unknown>, ctx: ExtensionContext) {
      if (!ownsTurn || !run) return;
      if (run.status !== "running") {
        if (["read", "grep", "glob", "find", "ls", "wait", "auto_status"].includes(tool)) return;
        return "Auto scheduling is held. Await native results or send a new user request; no late Auto execution or review is admitted";
      }
      if (!run.toolCall(id)) {
        notify(ctx);
        return `OMP Auto ${run.status}: ${run.reason}`;
      }
      const carrier = tool === "eval" && autoStepCarrier(input);
      const messaging =
        tool === "send" ||
        tool === "irc" ||
        (tool === "write" && nativeAgentMessagePath(input) !== undefined);
      if (hostWorkflow) {
        const phase = hostWorkflow.statusView();
        const reviewOnly =
          (tool === "write" &&
            reviewWrite(input, bridge.state()?.config.maxReviewBytes ?? 131072)) ||
          (tool === "eval" &&
            reviewCarrier(input, bridge.state()?.config.maxReviewBytes ?? 131072));
        if (!safeMainTools.has(tool) && !reviewOnly && !carrier && !messaging) {
          if (admittedBoundary !== phase.fingerprint)
            return "Call auto_step and await the current phase direction before execution";
          if (tool !== "task" && !["apply", "fix"].includes(phase.phase))
            return `Host phase ${phase.phase} permits read-only Main tools, native leaf tasks and review handoff only; implementation belongs to admitted apply/fix phases`;
        }
      }
      if (carrier) boundaryCarriers.add(id);

      if (hostWorkflow) nativeEvidence?.admit(id, tool, input, hostWorkflow.statusView());
    },
    pendingAsync(exceptCalls: ReadonlySet<string> = new Set()) {
      return nativeWork?.pending(exceptCalls) ?? false;
    },
    async complete(
      material: ReviewMaterial,
      ctx: ExtensionContext,
      toolSignal: AbortSignal | undefined,
      invocationId: string,
      completionCalls: ReadonlySet<string> = new Set(),
    ): Promise<Verdict> {
      const current = run;
      const architect = bridge.state();
      const reject = (message: string): Verdict =>
        architect?.rejectReview(
          "completion",
          invocationId,
          message,
          toolSignal?.aborted ? "caller_cancelled" : "input_rejected",
        ) ?? { decision: "blocked", summary: message, issues: [] };
      if (!ownsTurn || !current || !architect || !current.checkTime())
        return reject("No active Auto run can accept completion evidence");
      if (inFlight)
        return reject("Another Auto boundary is active; await it before submitting completion");
      inFlight = true;
      const boundaryGeneration = generation;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new DOMException("Auto completion timed out", "TimeoutError")),
        3 * config.cliTimeoutMs + architect.config.reviewTimeoutMs + 1000,
      );
      const signal = AbortSignal.any([
        lifetime.signal,
        timeout.signal,
        ...(toolSignal ? [toolSignal] : []),
      ]);
      const valid = () =>
        run === current && ownsTurn && generation === boundaryGeneration && !signal.aborted;
      approvedFacts = undefined;
      let stage: AutoCompletionStage = "change snapshot";
      try {
        const [snapshot, observedWorkflow] = await Promise.all([
          autoObservation("change snapshot", () =>
            readSnapshot(ctx.cwd, current.snapshot.change, cliOptions(), signal),
          ),
          autoObservation("workflow", () =>
            readWorkflow(ctx.cwd, current.snapshot.change, cliOptions(), signal),
          ),
        ]);
        if (!valid()) return reject("Auto completion was cancelled or superseded before review");
        current.observe(snapshot);
        stage = "workflow";
        workflow = observedWorkflow;
        workflowError = null;
        const phase = hostWorkflow?.observe(snapshot, observedWorkflow);
        const effectiveWorkflow = hostWorkflow?.effectiveWorkflow() ?? observedWorkflow;
        const scope = assessWorkflowScope(effectiveWorkflow);
        if (!current.checkTime()) {
          notify(ctx);
          return reject("Auto stopped before completion review");
        }
        if (!phase?.readyForReview || admittedBoundary !== phase.fingerprint)
          return reject(
            "The host workflow requires its allowed independent verification and auto_step boundary before completion review",
          );
        if (snapshot.state !== "all_done" || !scope.ready || !scope.reviewLoopReady)
          return reject(
            `Rasen implementation/verification is not ready for host review: ${scope.reason ?? "remaining tasks"}`,
          );
        if (nativeWork?.pending(completionCalls))
          return reject(
            "Native Main or child work is active or its termination is unverified; resolve it before completion review",
          );
        stage = "validation";
        await validate(ctx.cwd, snapshot.change, cliOptions(), signal);
        if (!valid()) return reject("Auto completion verification was cancelled or superseded");
        const facts = { snapshot: snapshot.fingerprint, workflow: observedWorkflow.fingerprint };
        reviewingFacts = facts;
        architect.observe(
          `rasen:${facts.snapshot}:${facts.workflow}`,
          "rasen_validate",
          { change: snapshot.change },
          `Strict CLI artifact validation passed; tasks ${JSON.stringify(snapshot.tasks)}; progress ${JSON.stringify(snapshot.progress)}; workflow ${JSON.stringify(scope)}; fingerprints ${JSON.stringify(facts)}`,
          false,
        );
        stage = "review";
        const verdict = await bridge.review(
          "completion",
          JSON.stringify({
            authoredEvidence: {
              source: "assistant-authored native artifact, not independent proof",
              ref: material.ref,
              sha256: material.sha256,
              content: material.content,
            },
            rasen: { source: "fresh host-read context", ...snapshot },
            nativeVerification: {
              source:
                "Host-observed independent OMP task receipts and complete native artifacts; task success is not a test pass",
              tasks: hostWorkflow?.verificationEvidence(),
            },
            workflow: {
              source: "fresh source observations and host-owned phase evidence",
              ...effectiveWorkflow,
              host: phase,
            },
            completionScope:
              "apply and verification complete; this Architect gate owns the sole review cycle; downstream delivery remains pending",
            validation: {
              source: "host-executed strict CLI artifact validation",
              passed: true,
              ...facts,
            },
          }),
          ctx,
          signal,
          invocationId,
        );
        if (!valid())
          return {
            decision: "blocked",
            summary: "Auto completion was cancelled or superseded",
            issues: [],
          };
        if (
          current.snapshot.fingerprint !== facts.snapshot ||
          workflow?.fingerprint !== facts.workflow ||
          current.observationError ||
          workflowError
        ) {
          architect.revokeApproval("completion");
          return {
            decision: "blocked",
            summary: "Rasen evidence changed during review; submit fresh completion evidence",
            issues: ["The reviewed facts are stale"],
          };
        }
        if (nativeWork?.pending(completionCalls)) {
          architect.revokeApproval("completion");
          return reject(
            "Native Main or child work became active or unverified during review; resolve it and submit fresh evidence",
          );
        }
        if (
          architect.lastReview?.invocationId === invocationId &&
          (architect.lastReview.charged || architect.lastReview.status === "cache_hit")
        )
          hostWorkflow?.recordReview(verdict, {
            approved: architect.completionApproved,
            exhausted: architect.phaseReviews.completion >= architect.config.reviews.max,
          });
        if (verdict.decision === "approve" && architect.completionApproved) approvedFacts = facts;
        activity(ctx);
        return verdict;
      } catch (error) {
        if (error instanceof AutoObservationError) {
          stage = error.stage;
          error = error.cause;
        }
        if (signal.aborted)
          error = new AutoPreflightError(
            timeout.signal.aborted
              ? "Auto completion boundary timed out"
              : "Auto completion was cancelled or superseded",
          );
        return reject(autoCompletionDiagnostic(stage, error));
      } finally {
        clearTimeout(timer);
        if (generation === boundaryGeneration) {
          inFlight = false;
          reviewingFacts = undefined;
        }
      }
    },
    async onStop(
      event: SessionStopEvent,
      ctx: ExtensionContext,
    ): Promise<{ handled: boolean; result?: { continue: boolean; additionalContext: string } }> {
      if (!ownsTurn || !run) return { handled: false };
      const current = run;
      if (event.signal.aborted) {
        current.stop("cancelled", "Run cancelled");
      }
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
      const boundaryGeneration = generation;
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new DOMException("Auto boundary timed out", "TimeoutError")),
        24000,
      );
      const signal = AbortSignal.any([event.signal, lifetime.signal, timeout.signal]);
      try {
        const [snapshot, observedWorkflow] = await Promise.all([
          readSnapshot(ctx.cwd, current.snapshot.change, cliOptions(), signal),
          readWorkflow(ctx.cwd, current.snapshot.change, cliOptions(), signal),
        ]);
        if (run !== current || !ownsTurn || signal.aborted) return { handled: true };
        current.observe(snapshot);
        workflow = observedWorkflow;
        workflowError = null;
        if (run !== current || !ownsTurn || signal.aborted) return { handled: true };
        if (!current.checkTime()) {
          notify(ctx);
          return { handled: true };
        }
        if (nativeWork?.pending()) {
          // Let OMP deliver pending results and resume its ordinary native turn.
          // Auto neither manufactures a retry turn nor cancels the children.
          return { handled: true };
        }
        const architect = bridge.state();
        if (!architect) {
          current.stop("blocked", "Architect is unavailable");
          notify(ctx);
          return { handled: true };
        }
        const last = event.last_assistant_message;
        const summary =
          last && "content" in last && Array.isArray(last.content)
            ? last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
            : "";
        if (!summary.trim()) {
          current.stop(
            "needs_user",
            "The Rasen LEAD stopped without a final evidence summary; completion is unverified",
          );
          notify(ctx);
          return { handled: true };
        }
        const hostPhase = hostWorkflow?.observe(snapshot, observedWorkflow);
        const scope = assessWorkflowScope(hostWorkflow?.effectiveWorkflow() ?? workflow);
        if (snapshot.state === "all_done" && scope.ready && scope.reviewLoopReady) {
          await validate(ctx.cwd, snapshot.change, cliOptions(), signal);
          if (run !== current || !ownsTurn || signal.aborted) return { handled: true };
          if (
            approvedFacts?.snapshot === snapshot.fingerprint &&
            approvedFacts.workflow === observedWorkflow.fingerprint &&
            current.snapshot.fingerprint === snapshot.fingerprint &&
            workflow?.fingerprint === observedWorkflow.fingerprint &&
            !current.observationError &&
            !workflowError &&
            architect.completionApproved &&
            hostPhase?.phase === "settled"
          ) {
            verifiedWorkflowFingerprint = observedWorkflow.fingerprint;
            current.stop(
              "completed",
              "Scoped Rasen implementation and verification are complete, strict validation passed, and the sole Architect review loop is approved; downstream pipeline delivery remains pending",
            );
          } else if (
            architect.phaseReviews.completion >= architect.config.reviews.max ||
            completionReminders >= architect.config.reviews.max
          ) {
            current.stop(
              "blocked",
              "Architect completion review remains unresolved within its bounded review/reminder limit",
            );
          } else {
            completionReminders++;
            return {
              handled: true,
              result: continuation(
                ctx,
                prompt(
                  snapshot,
                  "Completion is unverified. Write the full native evidence file and call architect_checkpoint phase=completion. Await its verdict and any required independent rounds in this same native turn; do not merely return another summary.",
                ),
              ),
            };
          }
          notify(ctx);
          return { handled: true };
        }
        current.stop(
          "needs_user",
          "The Rasen LEAD stopped before the scoped workflow completed; inspect fresh progress and explicitly resume when ready",
        );
        notify(ctx);
        return { handled: true };
      } catch {
        if (run === current && ownsTurn) {
          current.stop(
            event.signal.aborted ? "cancelled" : "blocked",
            "Auto snapshot, validation, or boundary failed; completion is unverified",
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
        if (boundaryGeneration === generation) inFlight = false;
      }
    },
  };
}

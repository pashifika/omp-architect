# Rasen Auto setup and limits

`/auto start <change>` runs the installed Rasen Auto workflow for a **prepared, existing local Rasen change**, scoped to remaining apply, verification, and review. The main OMP session is the LEAD and uses native one-shot leaf workers. Jev actively advises next-step selection at actual workflow stage boundaries; code supervises ownership, permissions, time limits, and the final completion gate. Existing Architect behavior remains the default when Auto is off.

The supported Rasen source is **dev/0.1.8 at `f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`**. Build and locally install that source, then initialize with Rasen's **builtin `full` profile**. Auto admits the entire generated `.omp/skills/rasen-auto/SKILL.md` body through the running OMP host's native skill autoload renderer. That renderer compacts Markdown table whitespace; admission verifies that the complete body survives without truncation, not byte-identical source formatting. It does not replace that workflow with a package-authored task loop. Generated skills remain in the project and are not copied into this package.

The `full` profile installs skills; it does **not** select Rasen's `full-feature` pipeline. The LEAD reads Rasen's public pipeline resume/execution state, preserves the recorded pipeline (or the skill's selection policy when absent), and resumes only the authorized stages. This start does not authorize new proposal/design work, scope expansion, ship, retain, archive, commit, publish, merge, or deploy. Prepared stages must be recorded honestly as pre-existing/skipped rather than claimed as newly executed. Planning-only and external-store modes are outside this contract.

## Internal delivery and confirmation

Auto startup uses OMP's native hidden custom-message route (`sendMessage`,
`triggerTurn: true`, `deliverAs: "nextTurn"`, agent attribution). The complete native
skill message, bounded change context, and run identity are internal context,
never a fabricated user transcript entry.
OMP maps text-only custom messages to its canonical developer role; each provider
then applies its native role mapping. The complete exact payload is also saved and
verified in originating-session `artifact://` storage, without project `.rasen`
files. Missing storage fails before a run starts. The generated Auto skill has a separate
256 KiB UTF-8 source limit; the aggregate task/apply context remains bounded to
64 KiB, and the complete native delivery payload is bounded to 512 KiB. Oversize
inputs are rejected, never silently truncated.

The extension admits idle and queued startup through the same ownership check;
stop, new input, session changes, or changed delivery content cannot revive a run.
Canceled internal payloads are removed from later user context. Completion review
and fixes normally stay in the same LEAD turn. Bounded reminders to submit a
missing completion checkpoint retain native hidden delivery and the same budgets;
individual tasks do not create stop-hook turns.

The confirmation displays guidance as literal, scrollable text, wrapping before
adding each border. Markdown is not rewritten. Blank separators between selected
brief blocks and between the rendered brief and inline guidance remain intentional;
source guidance is never reconstructed from display rows.

## Setup

1. Build/install the pinned Rasen development source with `bun run prepare:rasen` (see the script's reported executable path), then run `rasen init --tools omp --profile full` in your project using that executable. Use the builtin profile; no external YAML profile import is needed. The script installs into a temporary test prefix; use Rasen's upstream packaging workflow for a persistent installation. Prepare the change's proposal, design, specs, and tasks first
2. `.omp/auto.json` is **optional**. When absent, Auto uses its bounded defaults and the `rasen` executable on PATH. To customize them, copy [examples/auto.json](../examples/auto.json) and set `rasenExecutable` if needed, then restart OMP. An explicit `"enabled": false` disables starts; malformed or invalid files fail closed. A missing file or `enabled: true` never starts a run automatically
3. Merge [examples/auto-config.yml](../examples/auto-config.yml) to set native OMP `async.enabled: false`, `bash.autoBackground.enabled: false`, and `eval.autoBackground.enabled: false`, and finish existing background jobs. Auto requires foreground tools and leaf tasks. Native tasks otherwise run asynchronously by default even without an explicit `async` argument. Eval auto-backgrounding is already off by default; keep it off so a long native checkpoint cannot detach. The regular `modelRoles` and Architect `reviews.min/max` settings in the [Architect guide](architect.md) remain authoritative
4. Authenticate the `typesafe` provider through OMP's `/login`, or provide `TYPESAFE_API_KEY` in the OMP process environment through your normal secure setup. Auto resolves credentials through the current OMP session's `authStorage.keys.get("typesafe")` on each Jev invocation, using OMP's standard precedence; a key saved by `/login` takes precedence over the environment variable. You do not need to configure both. Credential lookup shares the decision's timeout and cancellation boundary. Never put keys in `auto.json`, this repository, task artifacts, or tool arguments. No external private connector key is imported. `jev-latest` is the fixed TypeSafe routing model; OMP generative models/efforts still use native roles
5. Run `/auto start my-change` in interactive OMP and confirm the scoped run and evidence sharing. `/auto status` and `auto_status` independently re-read bounded, fresh Rasen CLI state and show progress, supervision, and review budgets, including after a run stops. `/auto stop` cancels; a fresh user start is required to reset budgets

## Extra instructions and existing brief packs

Append instructions directly, including multiline text:

```text
/auto start my-change Keep the implementation small; report the result in Japanese
```

Or reuse a pack from the user's `brief` v0.1 format without installing another `/brief` command:

```text
/auto start my-change --brief rasen-apply-change ts normal -- Run the focused tests first
```

The named change supplies `{var}` and the pack's `variable:` placeholder. Packs are read from `<project>/.omp/brief/<pack>/`, then the current OMP agent directory's `brief/<pack>/`; the project pack shadows the whole global pack. Global resolution follows OMP's `getAgentDir()`, with `PI_CODING_AGENT_DIR` and then `HOME/.omp/agent` as fallbacks for hosts without that resolver. `_shared.md`, selected Markdown blocks, aliases, ordered deduplication, CRLF frontmatter, and unknown literal placeholders follow the shared brief format. No blocks means shared prose only. Existing templates and installations are left untouched.

`--brief` is special only as the first item after the change. With a brief, `--` separates block selectors from prose. Without a brief, optional `--` lets prose begin literally with `--brief`. Quotes are literal text, not shell syntax; indentation, internal spacing, and trailing newlines in the instruction payload are retained.

Tab completes Auto subcommands, actual local Rasen change directories, `--brief`, existing pack names and unused blocks/aliases. Explicit Tab selects; Enter submits only what was typed, including when a suggestions popup is stale. Completion does no CLI calls or network access. After prose begins, Auto contributes no further suggestions.

The rendered brief and extra instructions are shown at confirmation and frozen for that run. Later template edits cannot change a running request; use `/auto stop` and start again to pick them up. The complete guidance is retained in the LEAD turn, any bounded continuation, and Architect request evidence. Inputs exceeding the current Architect request-evidence budget are rejected before starting, rather than silently truncated. Shorten the guidance or deliberately increase `architect.json`'s `maxEvidenceChars` and restart. The reader additionally bounds source packs to 64 KiB/128 entries and rendered text to 12,000 characters, rejecting unsafe pack/file links, invalid UTF-8 and unknown blocks.

Guidance cannot override budgets, normal tool approvals, native leaf/foreground constraints, or grant permission to publish, merge, deploy, or expand scope. Existing brief blocks requesting delegation are adapted to native OMP leaf roles. Permission to run Auto is scoped to applying, verifying, and reviewing the named prepared change.

OMP's `pi.sendUserMessage()` bypasses slash-command dispatch. Therefore, a `/brief` template whose output merely starts with `/auto start` **does not start Auto**. Invoke `/auto start ... --brief ...` directly. The separately optional standalone `/brief` extension uses the same text renderer; see [installation](installation.md) for opt-in setup.

The extension observes the local change and validates its artifacts through these documented read-only Rasen capabilities, without a shell:

```bash
rasen status --change my-change --json
rasen instructions apply --change my-change --json
rasen validate my-change --type change --strict --json
RASEN_AGENT_RUNTIME=omp rasen pipeline resume my-change --json
RASEN_AGENT_RUNTIME=omp rasen pipeline show <pipeline-name> --for-execution --json
```

The LEAD also follows the generated workflow's public `rasen pipeline resume <change> --json` and `rasen pipeline show <name> --for-execution --json` interfaces with `RASEN_AGENT_RUNTIME=omp`, rather than inventing a pipeline DAG. Workflow execution and run-state updates use normal OMP tools and approvals.

## Native roles and stage decisions

The main session owns planning, routing, Rasen state, and permission checks. Its workers use OMP's native task tool and configured model roles:

- `omp-worker` / `@implementation`: implementation and fixes
- `omp-explorer` / `@research`: narrow read-only repository research
- `omp-reviewer` / `@architect`: independent scoped diff review and foreground verification, without implementation edits

Each worker is a one-shot leaf with `spawns: []`; it may not redelegate or call Architect checkpoints. The no-tool Architect checkpoint reviewer remains the independent completion gate. Native worker findings and test results are evidence for that gate, not a second semantic completion-review loop.

Foreign Claude/Codex processes, foreign dispatch bridges, recursive delegation, explicit async work, Bash service mode, and background jobs are not supported during Auto. Unsupported explicit foreign-runtime routing requires user attention. Record only actual native task handles and artifacts; do not invent Claude/Codex runtime identifiers or resumable worker handles. Ordinary non-Auto routing is unchanged.

At the initial executable frontier and after recording each meaningful workflow stage boundary, the LEAD calls the synchronous `auto_step` tool. It refreshes bounded Rasen state before requesting Jev's existing `continue`, `replan`, `needs_user`, or `uncertain` decision, with the bounded Architect fallback described below. A semantic boundary includes the selected pipeline, stage frontier/status, findings, and review rounds. Identical semantic boundaries reuse the cached decision; task-checkbox ticks, assistant summaries, and timestamps do not create new decisions. Jev remains active in next-step selection; it is neither a workflow driver nor a callback on every tool, skill read, or task-checkbox update. The LEAD continues the loaded workflow within the same native turn after receiving advice.

## Native completion handoff

When implementation and required verification are ready, write factual evidence to
`local://architect-review/NAME.md` with OMP's existing `write` tool, then call
`architect_checkpoint` with
`{ phase: "completion", evidenceRef: "local://architect-review/NAME.md" }`.
An originating-session `artifact://ID` is also accepted; inline `summary` is not. Auto uses this
existing native-file checkpoint synchronously and enriches the complete authored file with fresh
Rasen task/context and public workflow state, plus host-executed strict artifact validation. The
authored file remains labeled as an assistant claim, not independent proof.

The enriched native review artifact must fit Architect's `maxReviewBytes` (default 131072 UTF-8
bytes); oversize or invalid evidence is rejected before a review attempt, never truncated. The
no-tool reviewer receives the exact canonical plan and separately bounded host tool evidence too.
**Rasen validation checks artifacts, not whether implementation tests passed**; provide actual
verification results and independent leaf findings.

Await the checkpoint verdict in the same native LEAD turn. On revise, fix the findings and reverify;
on a minimum-round request, supply the required independent current-state or delta evidence.
Resubmit the native completion checkpoint within that turn until approved or the existing
`reviews.min/max` budget is exhausted. Do not run a second `rasen-review-cycle`; worker verification
does not consume a semantic review round or create another review/fix loop.

If the checkpoint is called inside Eval, Auto accepts only a dedicated **foreground JavaScript
(`language: "js"`, `reset: true`), single-call** carrier using `tool.write` to
`xd://architect_checkpoint` with literal completion parameters. Write the evidence file in a
separate earlier call. Do not batch unrelated effects, another tool call, or a general program with
completion. Rejected general/batched Eval completion attempts consume no review. Normal non-Auto
Eval completion retains its separate queued turn-boundary behavior.

The completion tool preserves the full configured Architect `reviewTimeoutMs`
(default **120000 ms**) plus bounded CLI overhead: its outer deadline is `3 × cliTimeoutMs + reviewTimeoutMs + 1000`.
Overall run supervision still applies. It does not squeeze the provider review into a session-stop
timeout.

After approval, return a factual final summary. Auto's `session_stop` hook performs only fresh
task/workflow reads, strict validation, and settlement against the approved task and workflow
fingerprints. No model provider runs inside that hook, which uses a **24-second** deadline below the
SDK's 30-second handler cap. A changed fingerprint cannot settle an old approval. Assistant claims
alone do not advance progress.

A missing final result or a final with incomplete apply/verification stops honestly as `needs_user`,
with completion unverified. If apply/verification is ready but the matching completion checkpoint is
missing, Auto can issue at most `reviews.max` reminders to submit it; reminders do not invoke a
reviewer or spend a review. Exhausted review/reminder limits stop blocked. This is a bounded
completion reminder, not a task-by-task implementation loop.

## Deterministic gates and semantic fallback

- Jev can return only `continue`, `replan`, `needs_user`, or `uncertain`. It cannot approve a plan, grant permission, mark a task done, or declare completion
- Low confidence, malformed output, timeout, or provider error permits at most one isolated no-tool architect-role triage fallback for that decision, within `maxFallbacks` for the run. `fallback: "stop"` disables it. Continued uncertainty stops explicitly. No provider retry loop exists
- `replan` requires the existing Architect recovery checkpoint. Plan, recovery and explicit blocked checkpoints use the [native-file handoff](architect.md#native-file-handoff): write `local://architect-review/NAME.md`, then submit `{ phase, evidenceRef, steps? }`; inline `summary` is unsupported. A denied OMP tool approval stops Auto as `needs_user`; no confidence can override it
- The existing Architect `reviews.min/max` settings (defaults **1/3**) are the sole semantic completion review/fix loop, using the native handoff above. Required independent verification still runs, but skill reads, CLI queries, task progress, and test commands are not review rounds. The Rasen review-cycle stage remains pending for the host gate; downstream stages remain outside this start's scope. Unresolved plan/recovery checkpoints, review findings, or exhausted review budgets cannot become success
- Task identity/order/description, schema, and local project root are frozen for a run. Scope changes require the user to review and explicitly restart. Deleted/replaced tasks and repeated checkbox toggling do not manufacture progress
- Default supervision is **4 hours overall** (`maxDurationMs: 14400000`, configurable up to 12 hours) and **10 minutes without native model/tool output** (`noOutputTimeoutMs: 600000`, configurable up to 30 minutes). The inactivity timer measures output activity, not checkbox progress. Both time limits remain finite
- `maxSteps`, `maxToolCalls`, and `maxStalls` default to `null`, so there is no default whole-change 8-turn, 80-tool-call, or checkbox-stall cap. Explicit legacy integer limits remain accepted and enforced: `maxSteps` 1–10000 for native execution turns, `maxToolCalls` 1–100000 for main-session tool attempts (including failed attempts), and `maxStalls` 1–10000 for observed turns without newly completed tasks before continuation. Use `null` to disable an optional count cap. Counts and elapsed time never reset on hidden continuations
- Semantic primary decisions occur at new stage boundaries; there is no default 8-decision ceiling. At most one fallback is permitted for a decision, with 2 fallback attempts for the run by default (`maxFallbacks`). Plan/recovery/completion reviews retain the separate `3 × reviews.max` total maximum. The `auto_step` stage-advice deadline is `2 × cliTimeoutMs + 2 × decisionTimeoutMs + 1000` (27 seconds by default), allowing bounded fresh observation, primary advice, and fallback. Completion review uses the configured Architect timeout; only stop-time fresh-fact settlement uses the 24-second deadline
- Terminal outcomes are distinct: `completed`, `needs_user`, `uncertain`, `stalled`, `budget_exhausted`, `cancelled`, and `blocked`. Only `completed` records fresh CLI validation and settlement against matching approved task/workflow fingerprints. Status refreshes do not resume execution, reset budgets, change a terminal outcome, or award approval. If fresh evidence differs or cannot be read, `completionVerified` is false and observation errors remain visible. A stopped unverified run remains unverified even if checkboxes later change. Restart/resume/branch does not resume Auto; a new real user request cancels its ownership

`auto_status` includes Architect's `lastReview`, with invocation ID, artifact reference/SHA-256, status, charged attempt and verdict. Use it to distinguish a finished provider response from rejected input, stale evidence or caller cancellation; `charged` is review-budget accounting, not a billing receipt. Terminal abort behavior remains in place, and the durable review outcome remains available for diagnosis. Normal non-Auto completion invoked inside Eval follows the separate queued, 24-second boundary contract in the [Architect guide](architect.md#completion-boundaries-and-status).

The confidence threshold is an uncalibrated routing heuristic, not a correctness probability. A future local backend such as Laya can implement the `DecisionProvider` interface, but no Laya model is installed, trained, benchmarked, or supported by this PR. Its confidence would require separate evaluation.

Auto sends bounded stage/task counts, stage-frontier and finding evidence, a progress summary, and recent tool evidence to the fixed TypeSafe endpoint. No generated skill, full source artifact, or separate brief field is automatically included in that request, but summaries/tool evidence can still contain source, instructions, or private data: confirm only for data you may send. The separate no-tool architect completion session receives the full admitted native artifact, exact canonical plan, and bounded host evidence through your configured architect provider; frozen instructions and the rendered brief remain in its request evidence. This full-file handoff does not expand semantic triage: Jev and its fallback retain their bounded progress evidence. HTTP redirects are refused, response/request sizes are bounded, and provider errors do not echo credentials or response bodies.

These are orchestration controls, not an OS sandbox: arbitrary shell code can create processes outside native job tracking, and streamed assistant claims cannot be retracted. Completion is refused with running native background jobs; wait for all background work to finish and collect fresh evidence before review. Auto still requires foreground execution. Use normal OMP approval settings and review the final evidence.

See [verification and known coverage limits](rasen-auto-verification.md) for recorded evidence and reproduction steps. Historical verification is not proof of live end-to-end coverage for this native workflow port. Return to the [README](../README.md).

# Rasen Auto setup and limits

`/auto start <change> [guidance]` works toward the requested outcome for an
existing local Rasen change. Jev selects the actual next existing Rasen skill
from its loaded name/description, current change facts, and actual native work
history. There is no mandatory pipeline, fixed apply/verify/review sequence, or
requirement that tasks already be prepared. `auto-run.json` is not a prerequisite.

OMP owns execution, permissions, jobs, session history, and artifacts. Auto
coordinates skill actions and supervises their boundaries. Each existing skill
owns its complete internal workflow and files. In particular, `rasen-review-cycle`
keeps its existing review/fix/delta loop, limits, escalation, and report writes;
Auto adds no second review-cycle or outer Architect completion gate.

## Setup and commands

The verified Rasen source contract is **dev/0.1.8 at
`f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`**. Current migration validation and
historical proof limits are recorded in [verification](rasen-auto-verification.md).

1. Install/build that Rasen version and initialize the project with
   `rasen init --tools omp`. `bun run prepare:rasen` builds an isolated temporary
   test installation and reports its executable path; use upstream packaging for
   a persistent installation
2. Create a change through Rasen, and make its existing skills available in OMP.
   Auto reads `AgentSession.skills`, including native global, project, and packaged
   skills and their registered names. No particular generated profile or installed
   `rasen-auto` skill is required; the Auto skill itself is excluded as a candidate
3. Keep normal OMP async settings and configure models with native `modelRoles`.
   See [examples/auto-config.yml](../examples/auto-config.yml). Auto does not switch
   the main model or disable async execution
4. Authenticate `typesafe` through OMP's `/login`, or set `TYPESAFE_API_KEY` in
   the OMP process environment. The running session's
   `authStorage.keys.get("typesafe")` preserves normal OMP precedence, including
   saved-login precedence over the environment. Never put credentials in guidance,
   configuration files, or tool arguments. Routing uses `jev-latest`
5. Start interactively and confirm the work and evidence disclosure:

```text
/auto start my-change
/auto start my-change Keep the implementation focused
/auto start my-change --brief example ts -- Run focused tests first
/auto status
/auto stop
```

A missing `auto.json` uses defaults; enabling Auto does not start anything. Start
requires an existing change, usable native skills, and the ordinary preflight
checks. A change with missing planning artifacts can select a planning/continue
skill instead of being rejected just because apply is not ready. Status reads
never start or resume execution.

## Skill selection and state ownership

At a boundary, Auto observes Rasen status/artifact facts, relevant source-owned
records, native tools/results, and its native session history. Jev receives exact
available skill names, descriptions, and selection criteria under opaque option
IDs. Its answer selects the next skill or a control outcome such as needing user
input, uncertainty, or proposing completion. It does not merely approve a stage
chosen by a host-owned pipeline.

The catalog is validated and bounded separately from observation text. Oversized
catalogs are rejected, never silently shortened to hide candidates. Global and
packaged skill identities come from the native loader rather than a second
filesystem discovery system. The selected skill is read completely and its
identity/content are checked before admission. Main follows that skill and uses
OMP's normal tools and configured worker, explorer, and reviewer roles. Skill
bodies are not automatically sent as separate Jev fields.

Planning, continue, apply, verification, review, ship, retain, and archive remain
candidates when loaded and applicable. The requested outcome and actual evidence
determine relevance. Selecting a skill grants no additional permission. Publishing,
merging, deploying, deleting, archiving, and other consequential effects still
require their usual authorization. A missing decision or denied approval holds
the work for the user; it is neither success nor a reason to bypass the skill.

There are two distinct kinds of history:

- **Skill-owned records:** Rasen artifacts and records belong to their skills.
  `rasen-review-cycle` may create or update `auto-run.json` for Rasen's UI even
  when Auto and pipelines are not in use. Auto preserves those writes and reads
  record content as evidence. File existence alone never establishes a pipeline,
  native execution, or completion. Absent, valid, and malformed records are
  distinct observations; an unfamiliar record is not a new host state machine
- **Auto orchestration history:** Auto appends small versioned events through
  OMP `appendEntry` and reads the active branch through `getBranch`. Events bind
  the run, change, action, chosen skill, input/output facts, decision, and native
  receipt/artifact references. Full evidence remains in native artifacts. There
  is no new project filesystem runtime or second writer for skill-owned records

Native history survives as session evidence; it is not executable state. Reading,
reloading, branching, or restarting a session never implicitly resumes work. A
fresh confirmed start re-observes facts and unfinished actions before selecting a
next action. It must not infer success from a missing final event or repeat an
ambiguous consequential effect. Invalid history, unavailable persistence, or
unverifiable native work holds scheduling rather than manufacturing progress.

Use `auto_step` at the selected skill's factual boundary. An action result is
about that invocation, not overall completion. Inner review/fix rounds remain
inside the skill. A checklist reaching `all_done`, a successful tool transport,
an old approval, or an existing `auto-run.json` is not sufficient completion
proof. A fresh evidence-based finish proposal still requires unchanged relevant
facts and native settlement. Ordinary Architect plan/recovery checkpoints and
non-Auto behavior remain available; recovery gates cannot be bypassed by advice.

## Extra instructions and brief packs

Guidance after the change is literal text. Only a leading `--brief` selector has
option syntax; `--` starts literal guidance. There is no `--pipeline` option.

```text
/auto start my-change Keep changes small; report the result in Japanese
/auto start my-change -- --brief is literal guidance here
/auto start my-change --brief rasen-apply-change ts normal -- Run focused tests first
```

Brief packs use the existing v0.1 format without requiring another `/brief`
command. Packs are read from `<project>/.omp/brief/<pack>/`, then the active OMP
agent directory's `brief/<pack>/`; a project pack shadows the complete global
pack. The global root uses `getAgentDir()`, then `PI_CODING_AGENT_DIR` and
`HOME/.omp/agent` fallbacks. `_shared.md`, selected blocks, aliases, ordered
deduplication, CRLF frontmatter, and unknown literal placeholders retain their
format. The change supplies `{var}` and the pack's configured variable. No blocks
means shared prose only. Existing packs and installations are not modified.

With a brief, separate block selectors from prose using `--`. Unknown blocks are
rejected. Quotes, indentation, internal spacing, trailing newlines, blank lines,
and Markdown remain literal. Guidance and the rendered brief are shown in a
scrollable confirmation and frozen for the run; display wrapping does not alter
them. Changes require a fresh start after native drain. Guidance must fit the
Architect request-evidence budget. Packs are capped at 64 KiB/128 entries and
rendered text at 12,000 characters; unsafe links and invalid text are rejected.

Tab completes subcommands, local changes, `--brief`, packs, and unused
blocks/aliases using bounded local reads. There are no suggestions after prose
begins. Tab selects; Enter submits only the typed text. OMP's
`pi.sendUserMessage()` bypasses command dispatch, so a `/brief` template beginning
with `/auto start` does not execute Auto. Use the direct command above; optional
standalone Brief installation is described in [installation](installation.md).

## Optional configuration and supervision

Configuration is merged by explicitly specified keys in this order:

1. Builtin defaults
2. `<active OMP agent directory>/auto.json`, normally `~/.omp/agent/auto.json`
3. `<project>/.omp/auto.json`

Both files are optional. Native profiles and agent-directory overrides are
honored. Reads never create configuration or change Architect/OMP settings.
Each present file is validated independently; malformed, unreadable, or invalid
configuration blocks starts even if a later layer would override it. Restart OMP
after correcting configuration. See [global](../examples/auto.json) and
[partial project](../examples/auto-project.json) examples.

- Default time limits are **4 hours overall** and **10 minutes without native
  model/tool output**. Configurable maxima are 12 hours and 30 minutes; time
  supervision always remains finite
- `maxSteps`, `maxToolCalls`, and `maxStalls` default to `null`, with no arbitrary
  default action/tool-count cutoff. Optional finite `maxSteps` counts skill-action
  admissions, not inner review/fix rounds or skill reads. `maxToolCalls` counts
  main-session tool attempts; `maxStalls` bounds settled action boundaries without progress. Startup/status observations do not spend that budget.
  Continuations do not reset elapsed time or counters
- Explicit `null` clears an inherited optional count cap. It is invalid for time
  limits. `enabled: false` blocks starts; `true` only permits an explicit confirmed
  start and never schedules work itself
- Low confidence, malformed output, or provider failure may use one isolated
  no-tool architect-role fallback for that decision, within `maxFallbacks`
  (default 2). `fallback: "stop"` disables it. Fallback receives the same sealed
  evidence and exact catalog. Unresolved uncertainty stops explicitly
- Each read-only Rasen CLI command defaults to a 10-second timeout; `cliTimeoutMs`
  supports 100–30,000 ms through the same global/project configuration. Observation
  boundaries scale with that finite limit; timeout never retries or grants completion
- Jev defaults to an 8-second decision timeout. Fallback uses Architect's
  `reviewTimeoutMs` (120 seconds by default). Safe diagnostics distinguish
  authentication, expiry, malformed replies, and genuine uncertainty without
  echoing arbitrary provider errors

The confidence threshold is a routing heuristic, not a calibrated probability
that the action is correct. No Laya model is installed or supported here.

## Evidence, delivery, and privacy

Confirmation discloses bounded change facts, native history, and tool evidence
sent to TypeSafe Jev, together with the separately bounded catalog of exact
available skill names, descriptions, and criteria. Observation text is bounded
by `maxEvidenceChars` (12,000 by default); that is **not the total request cap**
and does not include the catalog. Evidence and descriptions can contain private
project information. Confirm only for data you may send, and include no secrets.
The optional fallback uses the configured architect provider. HTTP redirects are
refused, requests/responses are bounded, and raw provider errors are withheld.

Auto's frozen instructions use native hidden, agent-attributed custom messages,
not fabricated user messages. The originating session's artifact is read back
before delivery. Missing storage or changed/revoked delivery blocks scheduling.
Full native evidence and artifact references stay available; bounded routing
summaries do not replace that evidence or a skill's reports. These controls are
not an OS sandbox. Shell processes launched outside native job tracking cannot
be settled by Auto's public native-work observations.

## Native async ownership and stopping

OMP retains task/Bash/Eval execution, jobs, messages, IRC, wake/revival, rereview,
result delivery, and cancellation. Auto observes public APIs; it does not patch
native execution or wake observers, replace async scopes, or filter late native
results. Normal async settings remain unchanged.

The lifecycle is `running → draining → paused/completed`:

- `/auto stop`, new user input, denial, and other stop conditions revoke new Auto
  scheduling. Already-admitted native work is drained rather than force-cancelled
- Drain waits for native submissions, IRC replies, jobs, result delivery, and idle
  settlement outside awaited Main callbacks. Late results remain normal native
  evidence; they cannot revive scheduling or silently settle a different action
- `paused` means verified drain without verified completion. A fresh explicit
  start is required. An unresolved user decision remains unfinished work
- `completed` requires an evidence-based finish proposal, fresh unchanged facts,
  and verified native quiescence. Persistence failure or an ambiguous unfinished
  action cannot be converted into success

The public boundary includes Main and its descendants and may wait for unrelated
same-Main jobs; those jobs are neither cancelled nor appropriated as Auto proof.
Inspect `auto_status.nativeWork` and native job status before restarting. Native
force cancellation is a separate explicit action. ESC/backtrack/focus retain
normal OMP behavior; a cancelled status alone does not prove a process settled.

An interrupted dispatch can lack a public handle proving settlement. Auto exposes
`nativeWork.settlementUnverified` and stays held rather than claiming termination
or restarting over ambiguous work. Inspect native work and use a new session if
settlement cannot be established; do not disable async as a workaround.

## Diagnosing a refused start

Preflight identifies the failed boundary, such as confirmation, change snapshot,
native skill catalog, artifact storage, or delivery. Diagnostics expose bounded
integration-owned reasons and allowlisted OS codes, withholding arbitrary host
errors, raw CLI output, and environment values. No provider call is needed during
start preflight; routing begins at the first action boundary.

Check that the change is readable and the intended skills are actually loaded in
OMP. Use the executable configured by `rasenExecutable` for read-only Rasen
status diagnostics. A missing generated `rasen-auto` skill or pipeline is not a
repair target. `ENOENT` at the CLI boundary means to inspect PATH or configure an
absolute executable; artifact-storage `ENOSPC` means to check the native session
store's free space. Cancelled or superseded starts remain cancelled.

See [verification and coverage limits](rasen-auto-verification.md), or return to
the [README](../README.md).

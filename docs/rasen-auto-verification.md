# Rasen Auto verification

## Current ownership contract

Auto orchestration belongs to the extension. It reads bounded local change/apply
context and public Rasen pipeline observations; it does not load the generated
`rasen-auto` skill or require the builtin `full` profile. With no recorded pipeline,
it uses session-local apply/verification/review phases without creating external
pipeline state. See [setup and limits](rasen-auto.md) for the current contract.

## Extension-owned flow verification (2026-10-05)

On locked OMP **18.6.0**, Bun **1.3.14**, actual Node **24.19.0**, and the pinned
Rasen `0.1.8 (dev.local f0ae20d)` build:

- Formatting and TypeScript passed
- **354 unit/installer tests**, **2,316 assertions** passed
- **179 smoke tests**, **1,668 assertions** passed
- Separate **111 installer tests**, **923 assertions** passed
- **44-entry** packed extension loading, workflow/ruleset checks and `git diff --check` passed

Focused compatibility checks also passed on isolated OMP **18.5.1** and **18.6.1**:
**57 tests / 697 assertions per host**, TypeScript, the 44-entry packed package,
and native/sparse bundled startup. Each host ran the owned-workflow/workspace/no-skill
units, all native-worker cases, and every real AgentSession/no-skill case. The
execution-file manifest SHA-256 for those source-matching snapshots is
`1ccebb2f66b2858c5d65b45d76b3f0bec5fefb9b6eb14134c226743e4fa60c4e`.
No manifest, lockfile, user configuration, or native async setting was changed.

The real CLI fixture uses an isolated custom profile containing only `apply`;
`rasen-auto` is never installed. It completes **15 nonempty task checkboxes**,
performs **85 additional reads** without a default 80-tool cutoff, and uses the
real native task/wait implementation for four detached leaves: implementer,
independent verifier, fixer, and independent delta verifier. A real missing-footer
finding causes a real file edit before re-verification. The six Jev boundaries
follow host-owned phases within one native LEAD turn; no project `auto-run.json`
is created. Both direct and dedicated Eval `auto_step` after approval preserve
fresh final settlement rather than charging another review.

Native verifier outputs over 6,000 lines put a late finding beyond the SDK's
rendered preview. Tests assert that the full retained native artifact, including
the late finding, reaches Architect's complete review material. Task completion
is never substituted for a test pass. Coverage also includes sequential-stage
receipt binding, scope/identity changes, stale code facts, minimum/final review
rounds, failed-fix retries, uncharged oversize recovery, phase mutation gates,
peer-wake refusal, denial/cancellation, owned async settlement and fresh terminal
progress. A separate read-only review identified and rechecked these boundaries.

Model responses and Jev routing responses are deterministic local fixtures; Rasen
CLI operations, task dispatch, native async ownership, file changes, validation,
and artifact handoff are real. No paid provider, private upload, production
settings write, publish, merge, or deploy was used. The container does not verify
native persistent journal locks or the unrelated named-service daemon: fixture
journals use the SDK's supported memory backend, and the real-session fixture
sets `launch.enabled: false` only in `Settings.isolated` to exclude named-service
probes that fail with OS FileLock `EPERM`. Native async tasks, waits and job ownership
remain enabled and real; production settings are unchanged. Platform-specific installer
results and remote CI must be checked on the published commit.

The dated sections below are historical. Their skill-autoload tests and older
host/test counts are not evidence for the current extension-owned implementation.

## Historical safe preflight diagnostics (2026-10-05)

Auto start now names the failed admission boundary and exposes only integration-
owned diagnostics: bounded relative paths, allowlisted OS codes, byte limits and
validated read-only Rasen command arguments. Arbitrary host errors, CLI output,
executable paths, environment and file contents are withheld. Workflow rejection
reasons are preserved. Synchronous native-delivery failure cancels ownership and
revokes queued payloads, without trying another send through the broken transport.

At that revision, pinned Rasen/OMP tests covered fresh full, existing core, and
deliberately partial full installations. Core already included Auto in that CLI;
its profile name alone was not evidence of a missing skill. Full reinitialization restores the
partial installation. Tests also cover complete >64 KiB native loading, oversize,
missing/changed/truncated skills, project-contained versus external links, missing
CLI executable, nonzero exit codes, secret-output suppression, each admission
boundary, cancellation and retry after immediate or queued delivery failures.

Verification uses locked OMP 18.6.0, Bun 1.3.14, actual Node 24.19.0 and the existing
pinned Rasen build. Passed: formatting/typecheck, 332 unit/installer tests (2,107
assertions), 172 smoke tests (1,491 assertions), separate 111 installer tests (923
assertions), 43-entry packed loading, workflow checks and `git diff --check`.
Independent review also checked failure cleanup and secret-output suppression.
Other host versions and remote CI require separate verification.

## Global Auto defaults (2026-10-05)

Auto now loads builtin defaults, the running host's agent-directory `auto.json`,
then explicitly specified project `.omp/auto.json` options. Both files are
optional. Tests cover absent/global-only/project-only files, partial overrides,
explicit `null` count caps and `false`, independent layer validation, exact failing
paths, and unchanged files. The real source loader exercises consent and configured
time supervision; the sparse bundled CLI exercises custom agent directories,
named-profile precedence, disabled inheritance, project overrides and invalid
global files without a model turn or network access.

On locked OMP **18.6.0**, Bun **1.3.14**, actual Node **24.19.0**, and the existing
pinned Rasen build, formatting/typecheck and **315 unit/installer tests (2,044
assertions)** passed. The full **149-test smoke suite (1,250 assertions)** passed,
including a final rerun with an isolated ambient global `enabled: false` file to
verify that Auto-starting SDK fixtures use their own host agent directories.
Packed loading (**41 entries**), workflow/ruleset checks, and `git diff --check`
also passed. These additional changes were verified on the locked host; the
multi-version record below belongs to the preceding workflow port. Remote CI and
cross-platform installer results must still be checked on the published commit.


## Historical native builtin-full workflow port (2026-10-05)

This section describes the former skill-consuming implementation. Its generated
Auto skill and full-profile requirements do not apply to the current extension.
The older records below document the earlier apply-loop and transport layers.

That port read the complete generated `rasen-auto` skill from Rasen's **builtin
full profile**, using the running OMP host's native autoload API. It preserved
Rasen's workflow as the driver, with a scoped OMP host adaptation and Jev advice
at recorded semantic stage boundaries. The UI supervisor is the reference for
finite wall-clock/activity supervision and independent progress observation;
its Claude process launcher is not copied. The full profile does not select the
`full-feature` pipeline.

Source reference remains Rasen `dev/0.1.8` at
`f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`, especially
`src/core/templates/workflows/auto.ts`, `_orchestration.ts`, and
`src/core/management-api/{sessions,supervisor,whitelist}.ts`.

### Final verification

All of the following passed on the frozen implementation:

- Locked OMP **18.6.0**: formatting, typecheck, **291 unit/installer tests
  (1,975 assertions)**, separate **111 installer tests (902 assertions)**,
  **145 smoke tests (1,226 assertions)**, 40-entry packed loading, workflow/ruleset
  checks, and `git diff --check`
- Supported minimum OMP **18.5.1** and current compatibility target **18.6.1**:
  each passed formatting/typecheck, **291 unit/installer tests (1,975 assertions)**,
  a separate **111 installer tests (902 assertions)**, **145 smoke tests
  (1,225 assertions)**, 40-entry packed loading, and workflow/ruleset checks
- Bun **1.3.14** and actual Node **24.19.0**, with the pinned installed Rasen
  `0.1.8 (dev.local f0ae20d)`. The compatibility runner initially selected Bun's
  Node shim from its sanitized PATH; both complete smoke suites were subsequently
  rerun successfully with the actual Node executable. The authoritative CLI
  results above are the real-Node reruns

The lockfile remains on 18.6.0, with the existing `latest` development declarations
and `>=18.5.1` peer minimum unchanged. Compatibility runs use isolated copies with
exact SDK installations, not a changed project lockfile. Remote CI must still
verify the published commit separately.

### What that integration proved

- A real `rasen init --tools omp --profile full` generates the Auto body, over
  110,000 UTF-8 bytes. Native autoload admits its complete non-whitespace content
  separately from the 64 KiB task-evidence cap; the native renderer compacts
  Markdown table whitespace. The exact admitted message is retained in native
  session artifacts
- The combined actual CLI/SDK fixture performs **85 distinct native reads**, native
  fixture writes, **two Jev stage choices**, and **two charged completion reviews
  in one LEAD turn**, then settles completed. It crosses the former global
  80-call limit without a forced task turn. Model transports are deterministic
  fixtures; this verifies orchestration, not a model's ability to implement a
  real product change
- The existing native-file `architect_checkpoint` handles Auto completion with
  fresh task/workflow/strict-validation evidence and the configured Architect
  timeout. No model review runs inside the 30-second SDK stop hook. A timed fixture
  covers review beyond the former 24-second boundary; stop-time settlement checks
  the exact approved fingerprints without charging another review
- Real native task tests cover success, headless approval refusal, explicit policy
  denial, child abort, recursive-task refusal, and user cancellation. Denied child
  tools stop Auto before another child model turn, including when the native task
  envelope itself reports no top-level error
- Fresh terminal status updates task progress without resuming execution or awarding
  approval. Tests cover changed observations during review, stale Jev advice,
  same-frontier advice caching, preserved plan/recovery gates, no-output supervision,
  and optional explicit legacy limits, as well as existing delivery/brief safety
- Public pipeline resume/execution reads distinguish absent, invalid and pipelineless
  state, enforce local bounded contracts, preserve real native worker facts, and
  reject unsupported foreign routes. Scoped completion leaves downstream delivery
  outside permission; the Rasen review-cycle record is not fabricated as a host
  approval

### Coverage limits and resolved checks

All new model/provider responses are local fixtures; no paid provider calls,
external private data uploads, actual project publishing, or live implementation
quality claims are involved. Native child journal tests use a narrowly scoped
SDK `MemorySessionStorage` injection because this container returns `EPERM` for
native journal OS locks before child inference. Task dispatch, tools, routing,
permissions and cancellation remain real; persistent child journals and OS locks
are not covered by those fixtures.

A sparse bundled-CLI test caught an unsupported `eval/settings` module import.
The final code reads that setting through the bundled native registry alias;
both sparse-host variants pass. One integration run during active edits produced
extra completion reminders without capturing enough diagnostics to establish a
cause. Targeted and full frozen reruns passed without relaxing the one-turn
assertions; the final supported-host runs had no failures. macOS/Windows behavior
remains the responsibility of the existing cross-platform CI.


## Tested contracts

- OMP 18.6.0 and Bun 1.3.14 (current locked host; the initial core was tested on OMP 18.5.1)
- Rasen user-requested `dev/0.1.8`, immutable source `f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`; build/install/init provenance is emitted by `scripts/prepare-rasen.ts`
- TypeSafe `POST /v1/systemone`: [official API](https://docs.typesafe.ai/api)
- Rasen upstream [CLI source](https://github.com/DumoeDss/rasen/tree/f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd/src), [development branch](https://github.com/DumoeDss/rasen/tree/dev/0.1.8)

## Layers of evidence

1. Deterministic unit tests cover hard Auto budgets, frozen scope, no-progress, cancellation, provider uncertainty/error/timeout, fallback caps, strict Jev parsing, bounded evidence and safe HTTP failures
2. Real OMP loader/SDK smoke tests exercise extension registration, lifecycle and hidden continuations using a local fake generative provider. A combined fixture calls the actual native write tool twice, updates a real temporary Rasen task file, re-observes/validates it through the pinned CLI, and reaches two independent architect rounds. The actual Jev HTTP adapter uses a synthetic response in this combined fixture. Model answers are deterministic fixtures; this does not establish real model implementation quality
3. Real built Rasen CLI smoke tests initialize an isolated project, inspect the generated OMP apply skill, create local change artifacts, observe `blocked → ready → all_done`, and run strict validation. Invalid specs, symlinks, malformed output, cancellation and output/time bounds are failure-path tests
4. Six live Jev connector calls used payloads produced by the exact production `buildJevRequest`. Resolved model: `jev-1.13.0`. Clear work, repeated failure, missing user input, unsupported completion, contradictory test evidence and an injected approval instruction produced the expected routing labels. Sanitized full requests/responses and provenance are in [the fixture](../test/fixtures/jev-routing-live.json); `test/jev-live-replay.test.ts` replays them offline and verifies the request builder has not drifted

The six cases are an integration smoke, **not** an accuracy benchmark or confidence calibration. Live authentication stayed inside the existing private Jev connector. The OMP HTTP client was tested with synthetic transport fixtures; it was **not** authenticated using the connector's secret. No live generative OMP provider end-to-end run, Laya execution, real project deployment, or automatic publication is claimed.

## Supplied-profile and fresh-build checks

The user-supplied profile was imported under an isolated home and used with `init --tools omp --profile supplied-auto`. The development CLI generated 41 skill files, including an apply skill marked `generatedBy: "0.1.8"` (7,371 bytes). Only counts and non-sensitive compatibility results are recorded; the supplied profile is not committed.

The preparation script was also executed without a pre-existing checkout: it fetched the pinned SHA, installed locked upstream dependencies, built via the upstream local-pack helper, installed the tarball, and reported `0.1.8 (dev.local f0ae20d)`. This separately verifies the fresh-source CI path.

Real-host testing exposed two lifecycle traps, now covered by regressions: OMP invokes `before_agent_start` for hidden continuations, and active-session notifications can steer even with `triggerTurn: false`. One-shot exact continuation identities preserve budgets, with real-input invalidation and a short pre-provider retry guard; terminal notices use non-triggering next-turn delivery plus an immediate UI notification, preventing an extra model request after stopping.

## Initial core result (2026-10-04)

Formatting and TypeScript passed; 51 unit tests (327 assertions) and 33 smoke tests (219 assertions) passed. The 24-entry packed extension loaded against locked OMP, workflow safety checks passed, and `git diff --check` was clean. CI must still verify the published commit separately.

## Config-free starts, brief integration, and completion (2026-10-04)

The final frozen-lockfile run on OMP **18.6.0** / Bun **1.3.14** passed formatting, TypeScript, **227 unit/installer tests (1,444 assertions)** and **70 smoke tests (604 assertions)**. The unit suite includes an isolated native-editor subprocess with **57 additional keyboard cases**. The pinned Rasen CLI was freshly rebuilt and installed for this run. The 36-entry packed artifact loads the default extension with no `/brief` command and the optional entry with exactly one; template packs are excluded. Package, workflow, and whitespace checks passed. Remote CI is a separate check of the published commit.

- Missing `auto.json` uses defaults without starting anything; explicit disabled config, malformed config, refused consent, foreground requirements, budgets, and cancellation remain fail-closed
- Real OMP command dispatch and hidden continuations retain frozen multiline inline/brief instructions in main-session prompts and Architect request evidence. Synthetic packs cover variables, aliases, project/global precedence, CRLF, whitespace, unknown placeholders, invalid files, links, and size bounds
- Repeated starts cannot reset budgets. Stale confirmations/preflight reads and already-queued bootstrap/continuation delivery after stop, session change, or new input are rejected. A real AgentSession cancellation test makes zero model calls; fresh unrelated input still works afterward
- Actual native CustomEditor/CombinedAutocompleteProvider tests cover Auto alone, Auto with standalone brief, and standalone brief: Space refresh, Tab selection, ordinary and Kitty Enter, stale popups, empty optional positions, LF, and unrelated input. Optional installation is checked against the real host under isolated homes/profiles, preserving existing brief files, packs, and plugin settings and refusing recognizable duplicate registrations

The main-model and reviewer answers and Jev HTTP responses are local fixtures. No new paid live-provider run, real project publishing/merging, or macOS/Windows execution is claimed by this local result; CI covers platform-specific installer jobs. The minimum 18.5.1 editor export/API was inspected in cached upstream source, but the new native runtime cases were executed on locked 18.6.0. Existing private packs were compared locally for compatibility without copying their contents into the repository.

## Bundled-host extension loading regression (2026-10-04)

A real installed-host failure exposed a gap in the earlier verification: the installer test used the bundled CLI for `plugin list`, but loaded extensions through the source SDK. The new TUI editor and directory-helper subpath imports could fall back to checkout source packages and fail with a missing `@oh-my-pi/pi-natives`, even when OMP itself had its native addon. Both entries now use the running host's injected `CustomEditor` and `getAgentDir` exports instead.

The regression runs the actual locked OMP **18.6.0** CLI bundle from a separate host installation, discovers the native installer-created plugin links from an unrelated project, and checks Auto, Architect, and optional Brief registration through RPC. It covers both incomplete source peers (without the native dependency) and entirely absent source peers, with and without `--with-brief`. The optional case installs the main plugin first, adds Brief later, and verifies a repeated opt-in changes nothing. The previous code fails with the reported missing-native errors even in the base-only case; the corrected code passes all four loading cases. No prompt is sent, credentials are synthetic, and `fetch` is blocked. The existing dry-run and native-cache preservation tests remain unchanged.

## CI packaging portability

The first remote integration run exposed npm 10's `pack --ignore-scripts` behavior: `prepare` still ran, rebuilt Rasen after stamping, and mixed lifecycle output into `--json`. This behavior was fixed in [npm CLI #7850](https://github.com/npm/cli/pull/7850) for npm 11. The preparation script now installs **npm 11.9.0** beside **pnpm 9.15.9** in its isolated tools directory, verifies the selected versions, and uses that toolchain for the unmodified upstream pack helper and local tarball install.

Before building Rasen, the script packs a tiny fixture in dry-run and real modes. Its `prepare` would print output, delete the stamp and fail if called. Both paths must return valid JSON without running it; the actual tarball must retain the stamp. This guards against silently accepting an unstamped or rebuilt artifact. Runtime versions are printed and saved with the local build provenance. The corrected fresh-clone build was reproduced starting with the CI image's Node 22.23.3 and npm 10.9.9; it selected npm 11.9.0, preserved the installed development stamp, and passed all 33 smoke tests under Node 22.23.3.

## Reproduce

```sh
bun install --frozen-lockfile
bun run check
bun run prepare:rasen
bun run test:smoke
bun run check:package
bun run check:workflows
```

No model credentials are needed for this suite. The Rasen preparation step downloads pinned public upstream source and locked dependencies, builds an installable tarball, and installs it locally. It does not publish packages or modify the user's global installation. Generated fixture projects and private profiles are kept outside the distributable.

## Native internal startup and multiline confirmation (2026-10-05)

Auto startup now uses hidden, agent-attributed native custom context rather than
`sendUserMessage`. Real OMP AgentSession fixtures verify canonical developer-role
payloads, no user transcript entry, actual implementation-provider execution,
completion review, and native continuation delivery. The originating session's
artifact is read back byte-for-byte before dispatch. Added cases cover idle
context admission, repeated preparation, changed content/session identity,
stop/new-input/session-switch during persistence, unavailable storage, canceled
historical payload removal, and stale continuations after a new user finishes.

The confirmation suite exercises Japanese Markdown, blank rows and wrapping at
24/40/80/120 columns, scrolling/resizing, ordinary and Kitty Enter, cancellation,
and abort timing. A real native TSP reconciler receives already-wrapped rows
instead of a multiline picker subtitle. The original legacy selector did not
reproduce the reported broken border locally; the exact user-terminal symptom
remains unverified. This change avoids the separate native subtitle path without
modifying brief/guidance text.

Verification used Bun **1.3.14**, freshly rebuilt pinned Rasen, the locked OMP
**18.6.0**, and isolated npm-verified **18.5.1** / current **18.6.1** hosts.
All three passed format/typecheck, **280 unit/installer tests**, **119 smoke
tests**, packed loading (**38 entries**), and workflow validation. The native
confirmation subprocess adds **16 cases / 547 assertions**. Sparse/bundled-host
loading passed with and without optional Brief. The first concurrently executed
18.6.1 smoke run failed the real-CLI expected-two-reviews assertion; an isolated
case retry and a subsequent complete 119-test smoke rerun passed. The cause of
that initial timing-sensitive result was not established. No live model provider
or user profile was used, and these local results do not establish remote CI.

## Native async ownership revision (2026-10-05)

Auto no longer requires `async.enabled`, `bash.autoBackground.enabled`, or
`eval.autoBackground.enabled` to be false. It leaves host settings unchanged and
uses the owning Main session's exported registry and native job APIs. Native
scheduling, result delivery and wait remain in control. Run-scoped receipts and
child lifecycle identities provide exact cancellation, late adoption, actual
promise-settlement barriers, and stale-delivery protection without cancelling
unrelated jobs owned by the same Main.

The final locked **OMP 18.6.0** / **Bun 1.3.14** run passed formatting, TypeScript,
**328 unit/installer tests (2,091 assertions)**, **162 smoke tests (1,426
assertions)**, packed loading (**42 entries**), workflow/ruleset validation, and
whitespace checks. Independent source review found and verified fixes for queued
batch admission, reused child identities, hidden descendant cleanup, newer-user
context ownership, mixed result batches, and job-ID reuse after eviction.

Separate isolated **18.5.1** and **18.6.1** hosts each passed TypeScript, the
**112-test focused async/controller/native-worker suite (854 assertions)**,
**4 native/sparse bundled-host installer cases (87 assertions)**, and packed
loading (**42 entries**). All four OMP SDK packages matched each selected version.
These focused host matrices did not rerun the other 107 installer cases or the
entire smoke suite; the full aggregate above ran on the lockfile host.

Coverage includes native detached task success through Main wait and scheduling
pause, result arrival in actual provider context, denied child tools, recursive
spawn rejection, live Main interruption, explicit `/auto stop`, new input,
same-Main unrelated-job preservation, and real child-owned async Bash cancellation.
A first full run exposed the new Bash fixture using the process-default agent
home; the fixture now refreshes the public directory resolver into its isolated
home and restores it on cleanup. The final full and version-matrix reruns passed.
Child journals still use the supported in-memory backend because this executor
does not permit native OS journal publish locks; persistent child journaling is
not established by these cases.

Native probes distinguish Main's live interruption from idle ESC/backtrack and
focused-child ESC/focus switching. `/auto stop` is the explicit reliable Auto
cancellation path. OMP's terminal stop scheduling still waits for all Main jobs;
the Auto checkpoint itself considers only run-owned work. Native waiting does
not create an extra Auto hidden-continuation loop.

The SDK does not expose the job ID for every interrupted foreground-backed
Bash/Eval call before background promotion. For Main calls, the extension reports
`nativeWork.settlementUnverified` and refuses completion or a same-session
restart instead of claiming termination or cancelling unrelated jobs. Inspect
native jobs and start a new session when an exact late receipt is unavailable.
A tool error immediately followed by interruption can remain ambiguous until the
next genuine assistant message. Leaf owner-scoped joins cover hidden descendant
jobs. Mixed stale batches preserve unrelated job IDs for native result recovery,
not their original combined body. See the [operating contract](rasen-auto.md#native-async-ownership-and-stopping).

Model responses and review/decision providers remain deterministic local fixtures.
No paid provider run, private upload, publishing, merge, deployment, or
macOS/Windows execution is claimed. Remote CI must verify the published commit.

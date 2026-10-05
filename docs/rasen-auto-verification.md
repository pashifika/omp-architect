# Rasen Auto verification

## Current pipeline-free revision — 2026-10-05

The current contract is described in [setup and limits](rasen-auto.md). An
existing change is sufficient input; no pipeline, prepared task list, or
`auto-run.json` is required. Jev selects the actual next existing skill from the
native OMP catalog and current change/native evidence. Skills own their whole
workflows and files. Auto records orchestration facts with native branch entries
and artifact references, without an outer review-cycle or project runtime ledger.

### Verified results

The locked host is **OMP 18.6.0**, using **Bun 1.3.14** and **TypeScript 5.9.3**.
Validation was partitioned after the last narrowly scoped runtime fixes:

- Final source: formatting, type checking, and **408 non-installer unit tests /
  2,414 assertions** passed
- Final full smoke command: **222 tests / 3,948 assertions** passed, including both
  built-Rasen flows below and all 24 actual native lifecycle cases
- The full `bun run check` had passed **513 unit/installer tests / 3,310
  assertions** before the final queued-batch binding and CLI-timeout adjustments.
  Its **111 installer tests** were unchanged; the final non-installer suite above
  covers the changed runtime and new regressions. This is not a claim that the
  earlier single aggregate invocation exercised the later changes
- Packed loading passed with **50 distributable entries**; workflow and tracked
  ruleset checks passed. These checks do not publish or change live GitHub policy
- **OMP 18.5.1** and **18.6.1**, each on fresh identical final-source copies:
  type checking, **393 focused tests / 2,729 assertions**, **24 native lifecycle
  tests / 566 assertions**, and **50-entry packed loading** passed
- Both additional hosts also passed **4 isolated native/bundled installer tests /
  87 assertions** before the final runtime-only fixes. No installer or bootstrap
  source changed afterward

The final host matrix's execution-source manifest SHA-256 is
`29f8f149003de2921941d9293786948c07ae6878c14dc9838a5f73af7086d401`.
The harness compared source copies before and after execution and found no changes.
This manifest covers runtime, tests, scripts, agents and executable configuration;
this verification document was updated afterward.

Independent review reproduced and verified fixes for stale finish history,
new native work during asynchronous selection, finish superseded by replan, and
late registration of detached batch peers. The last batch probes include absent
initial peer metadata, second-peer-first lookup, immutable first-ref binding,
replacement rejection, and contradictory later metadata. No confirmed review
blocker remained.

### Actual built-Rasen/native proof

`smoke/auto-skill-native.test.ts` uses the prepared upstream Rasen build and actual
OMP loader, task, Bash, read/write, event, job and artifact APIs. Model responses
and Jev choices are deterministic scripts, not live generative judgments.

The happy path starts a newly created change with no pipeline, tasks file, or
Auto record. The native-loaded catalog drives a non-first-catalog choice from
current facts. It performs the necessary continue actions, apply, verify despite
`all_done`, and one whole review-cycle action before an explicit finish proposal.
The fixture reads every nonblank line of each selected generated skill through
native reads; the native implementations are not replaced by fixture tools.

Within that one review-cycle invocation, native reviewer/fixer/delta workers
produce evidence and run actual local code/tests. There is no additional host
selection between its internal rounds. Skill work creates and updates
`auto-run.json` from rounds 1 to 2, with findings then an empty finding list.
The built Rasen parser and management-UI runs handler read those records without
a pipeline. This is handler-level UI integration, not a browser interaction test.

The separate ship case leaves the ship skill available, selects it, and reaches
an actual native Bash policy denial. Auto pauses with `needs_user`, retains the
held action and native receipt bundle, and writes no mock publication artifact.
No product publication, merge, deployment, or real change archive was authorized
or performed by these fixtures.

These tests establish native transport, supplied-instruction, evidence and state
contracts. They do not establish autonomous model adherence to every skill,
review quality, or support for every optional Rasen pipeline protocol.

### Other covered boundaries

- Exact global/project/plugin native skill identities and descriptions; no
  installed `rasen-auto` requirement or silent candidate removal
- Complete selected-skill reads; exact sealed criteria shared with fallback;
  evidence references and confidence without a fabricated Jev rationale
- Full user-goal preservation, bounded valid-JSON observations, and optional
  absent/valid/malformed skill records interpreted by content
- Legitimate planning/task changes, repeated skills and unfinished-action resume;
  no blanket apply/continue/verify/ship/archive phase exclusions
- Native branch isolation, conflicting/terminal journal history, verified native
  artifact references, and byte-for-byte retention of late child evidence
- Actual foreground/detached tasks, active/idle/parked IRC, fresh same-worker
  rerequests, active steering, and child-owned async Bash
- Stop/new input closes scheduling while admitted work drains; no native worker
  cancellation, semantic resurrection, or child-success-to-change-completion rule
- Fresh workspace/catalog/history and native-quiescence fences, superseded finish
  proposals, and existing plan/recovery gates without an outer completion review
- Optional action/stall/tool limits, default uncapped action counts, deadline and
  no-output supervision, exact accepted decision audit, and preserved stop/input
  diagnostics

### Timeout evidence and remaining limits

The inherited 5-second per-CLI ceiling produced real `rasen status` timeouts,
including during an otherwise isolated full smoke run. One final observation
stopped 5,021 ms after the last activity; it correctly remained unverified rather
than inventing completion. This is a timeout observation, not a measurement of
how long the command would have taken to finish.

The final configuration uses a finite **10-second default**, configurable from
**100 to 30,000 ms** through normal global/project configuration. Observation
boundaries honor that limit. No automatic retry was added. Forced short-timeout,
process-output-bound and cancellation tests remain in the smoke suite. The final
full smoke run passed with the new default and unchanged success assertions.

Native OMP owns session persistence and execution. Tests cover native branch and
artifact APIs, persisted-entry round trips, and interruption/resume evidence;
they do not claim an atomic transaction spanning external effects and session
writes, or process-crash/OS-journal-lock recovery. Ambiguous effects require fresh
evidence and, when necessary, a user decision.

No live paid-provider end-to-end run, remote CI result, or macOS/Windows execution
is claimed by these local Linux results. Remote CI and platform jobs are separate
gates. Superseded mandatory-pipeline prototype results are excluded from this
record; that prototype is retained only as a local reference.

## Reproduce

```sh
bun install --frozen-lockfile
bun run check
bun run prepare:rasen
bun run test:smoke
bun run check:package
bun run check:workflows
bun run test:dev-install
```

See [CONTRIBUTING](../CONTRIBUTING.md) for isolated installer homes and supported
host policy. Keep heavy installer/version runners separate from the built-Rasen
smoke when diagnosing machine-load timeouts.

## Upstream provenance

The observer and fixtures are grounded in Rasen **dev/0.1.8**, immutable commit
`f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`:
[upstream source](https://github.com/DumoeDss/rasen/tree/f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd/src).
`scripts/prepare-rasen.ts` builds and installs into an isolated test prefix and
records source/build provenance. The tested version string is
`0.1.8 (dev.local f0ae20d)`. The preparation toolchain is Node **24.19.0**, npm
**11.9.0**, and pnpm **9.15.9**; installed archive SHA-256:
`bccc907c605a20fc16c188ee687905aef24ad12b681e8a7b81b0a680e294a1db`.
Packing preserves the development stamp without rerunning `prepare`. Fixtures
and private profiles are outside the distributable; deterministic tests need no
model credentials.

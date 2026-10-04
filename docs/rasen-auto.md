# Rasen Auto setup and limits

`/auto start <change>` drives a **prepared, local Rasen change** through task-sized implementation turns, fresh CLI observation, and architect completion review. It is a single-driver apply loop: the main OMP model does implementation, Jev supplies a small semantic routing hint, and code owns state and limits. Existing Architect behavior remains the default when Auto is off.

The supported Rasen source is **dev/0.1.8 at `f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`**, built and locally installed before verification. Its generated `.omp/skills/rasen-apply-change/SKILL.md` and the actual CLI instruction/context artifacts are read on every boundary. Skills are not copied into this package. The supplied profile was tested privately; it is not redistributed. This first core does not implement Rasen's whole auto pipeline, planning-only or external-store modes, nor automatic propose/ship/archive.

## Setup

1. Build/install the pinned Rasen development source with `bun run prepare:rasen` (see the script's reported executable path). For a supplied YAML profile, run `rasen profile import /path/to/profile.yaml --as my-auto`, then `rasen init --tools omp --profile my-auto` in your project using that executable. The script installs into a temporary test prefix; use Rasen's upstream packaging workflow for a persistent installation. Prepare the change's proposal, design, specs, and tasks first
2. `.omp/auto.json` is **optional**. When absent, Auto uses its bounded defaults and the `rasen` executable on PATH. To customize them, copy [examples/auto.json](../examples/auto.json) and set `rasenExecutable` if needed, then restart OMP. An explicit `"enabled": false` disables starts; malformed or invalid files fail closed. A missing file or `enabled: true` never starts a run automatically
3. Merge [examples/auto-config.yml](../examples/auto-config.yml) to set native OMP `bash.autoBackground.enabled: false` and finish existing background jobs. Auto requires foreground execution. The regular `modelRoles` and Architect `reviews.min/max` settings in the [Architect guide](architect.md) remain authoritative
4. Authenticate the `typesafe` provider through OMP's `/login`, or provide `TYPESAFE_API_KEY` in the OMP process environment through your normal secure setup. Auto resolves credentials through the current OMP session's `authStorage.keys.get("typesafe")` on each Jev invocation, using OMP's standard precedence; a key saved by `/login` takes precedence over the environment variable. You do not need to configure both. Credential lookup shares the decision's timeout and cancellation boundary. Never put keys in `auto.json`, this repository, task artifacts, or tool arguments. No external private connector key is imported. `jev-latest` is the fixed TypeSafe routing model; OMP generative models/efforts still use native roles
5. Run `/auto start my-change` in interactive OMP and confirm the scoped run and evidence sharing. `/auto status` and `auto_status` show progress and budgets. `/auto stop` cancels; a fresh user start is required to reset budgets

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

The rendered brief and extra instructions are shown at confirmation and frozen for that run. Later template edits cannot change a running request; use `/auto stop` and start again to pick them up. The complete guidance is retained in each implementation continuation and in Architect request evidence. Inputs exceeding the current Architect request-evidence budget are rejected before starting, rather than silently truncated. Shorten the guidance or deliberately increase `architect.json`'s `maxEvidenceChars` and restart. The reader additionally bounds source packs to 64 KiB/128 entries and rendered text to 12,000 characters, rejecting unsafe pack/file links, invalid UTF-8 and unknown blocks.

Guidance cannot override budgets, normal tool approvals, single-driver/foreground constraints, or grant permission to publish, merge, deploy, or expand scope. Existing brief blocks requesting delegation are adapted to direct execution. Permission to run Auto is scoped to applying the named prepared change.

OMP's `pi.sendUserMessage()` bypasses slash-command dispatch. Therefore, a `/brief` template whose output merely starts with `/auto start` **does not start Auto**. Invoke `/auto start ... --brief ...` directly. The separately optional standalone `/brief` extension uses the same text renderer; see [installation](installation.md) for opt-in setup.

The extension invokes only these documented read-only Rasen capabilities, without a shell:

```bash
rasen status --change my-change --json
rasen instructions apply --change my-change --json
rasen validate my-change --type change --strict --json
```

The main agent reads the generated skill and bounded context files, executes a task through normal OMP tools/approvals, verifies it, and updates its Rasen task checkbox. The next stop hook re-reads the CLI; assistant claims alone do not advance task progress. Skill instructions that call for delegation are explicitly adapted to direct main-session execution. Subagent spawning (including speculative/eval spawns), explicit async tools, and Bash service mode are blocked during Auto; ordinary non-Auto routing is unchanged.

## Deterministic gates and semantic fallback

- Jev can return only `continue`, `replan`, `needs_user`, or `uncertain`. It cannot approve a plan, grant permission, mark a task done, or declare completion
- Low confidence, malformed output, timeout, or provider error permits at most one isolated no-tool architect-role triage fallback for that decision, within `maxFallbacks` for the run. `fallback: "stop"` disables it. Continued uncertainty stops explicitly. No provider retry loop exists
- `replan` requires the existing Architect recovery checkpoint. Plan, recovery and explicit blocked checkpoints use the [native-file handoff](architect.md#native-file-handoff): write `local://architect-review/NAME.md`, then submit `{ phase, evidenceRef, steps? }`; inline `summary` is unsupported. A denied OMP tool approval stops Auto as `needs_user`; no confidence can override it
- Completion belongs to Auto while a run is active. Explicit completion-tool calls defer without consuming rounds. Auto first observes all tasks done and successfully runs strict Rasen artifact validation, then snapshots the full fresh Rasen context, separately labeled assistant-authored progress claim, and actual validation result into a native session artifact for independent completion review. Its full body must fit Architect's `maxReviewBytes` (default 131072 UTF-8 bytes); oversize or invalid input is rejected before a review attempt, never truncated. The reviewer also receives the complete exact canonical plan and separately bounded host tool evidence. Unresolved plan/recovery checkpoints, review findings, or exhausted review budget cannot become success. **Rasen validation checks artifacts, not whether implementation tests passed**; the architect still needs actual test evidence
- Task identity/order/description, schema, and local project root are frozen for a run. Scope changes require the user to review and explicitly restart. Deleted/replaced tasks and repeated checkbox toggling do not manufacture progress
- `maxSteps` bounds main execution turns (1–8, aligned with the pinned host's continuation cap), `maxToolCalls` bounds main-session tool attempts, `maxStalls` bounds turns without new completed tasks, and `maxDurationMs` sets the run deadline. Failed attempts count. Limits never reset on hidden continuations
- Defaults allow up to 8 semantic primary attempts and 2 semantic fallback attempts; completion/plan/recovery reviews retain the separate `3 × reviews.max` total maximum. Actual counts are usually lower. Each boundary is bounded to 24 seconds; CLI and decision operations have shorter deadlines
- Terminal outcomes are distinct: `completed`, `needs_user`, `uncertain`, `stalled`, `budget_exhausted`, `cancelled`, and `blocked`. Only `completed` means the CLI and current architect completion gate both passed. Restart/resume/branch does not resume Auto; a new real user request cancels its ownership

`auto_status` includes Architect's `lastReview`, with invocation ID, artifact reference/SHA-256, status, charged attempt and verdict. Use it to distinguish a finished provider response from rejected input, stale evidence or caller cancellation; `charged` is review-budget accounting, not a billing receipt. Terminal abort behavior remains in place, and the durable review outcome remains available for diagnosis. Normal non-Auto completion invoked inside Eval follows the separate queued, 24-second boundary contract in the [Architect guide](architect.md#completion-boundaries-and-status).

The confidence threshold is an uncalibrated routing heuristic, not a correctness probability. A future local backend such as Laya can implement the `DecisionProvider` interface, but no Laya model is installed, trained, benchmarked, or supported by this PR. Its confidence would require separate evaluation.

Auto sends only bounded task counts, a progress summary, and recent tool evidence to the fixed TypeSafe endpoint. No generated skill, full source artifact, or separate brief field is automatically included in that request, but summaries/tool evidence can still contain source, instructions, or private data: confirm only for data you may send. The separate no-tool architect completion session receives the full admitted native artifact, exact canonical plan, and bounded host evidence through your configured architect provider; frozen instructions and the rendered brief remain in its request evidence. This full-file handoff does not expand semantic triage: Jev and its fallback retain their bounded progress evidence. HTTP redirects are refused, response/request sizes are bounded, and provider errors do not echo credentials or response bodies.

These are orchestration controls, not an OS sandbox: arbitrary shell code can create processes outside native job tracking, and streamed assistant claims cannot be retracted. Completion is refused with running native background jobs; wait for all background work to finish and collect fresh evidence before review. Auto still requires foreground execution. Use normal OMP approval settings and review the final evidence.

See [verification and known coverage limits](rasen-auto-verification.md) for recorded evidence and reproduction steps. Return to the [README](../README.md).

# Rasen Auto setup and limits

`/auto start <change>` drives a **prepared, local Rasen change** through task-sized implementation turns, fresh CLI observation, and architect completion review. It is a single-driver apply loop: the main OMP model does implementation, Jev supplies a small semantic routing hint, and code owns state and limits. Existing Architect behavior remains the default when Auto is off.

The supported Rasen source is **dev/0.1.8 at `f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`**, built and locally installed before verification. Its generated `.omp/skills/rasen-apply-change/SKILL.md` and the actual CLI instruction/context artifacts are read on every boundary. Skills are not copied into this package. The supplied profile was tested privately; it is not redistributed. This first core does not implement Rasen's whole auto pipeline, planning-only or external-store modes, nor automatic propose/ship/archive.

## Setup

1. Build/install the pinned Rasen development source with `bun run prepare:rasen` (see the script's reported executable path). For a supplied YAML profile, run `rasen profile import /path/to/profile.yaml --as my-auto`, then `rasen init --tools omp --profile my-auto` in your project using that executable. The script installs into a temporary test prefix; use Rasen's upstream packaging workflow for a persistent installation. Prepare the change's proposal, design, specs, and tasks first
2. Copy [examples/auto.json](../examples/auto.json) to the working project's `.omp/auto.json`; set `rasenExecutable` to that installed executable if it is not on PATH. Restart OMP
3. Merge [examples/auto-config.yml](../examples/auto-config.yml) to set native OMP `bash.autoBackground.enabled: false` and finish existing background jobs. Auto requires foreground execution. The regular `modelRoles` and Architect `reviews.min/max` settings in the [Architect guide](architect.md) remain authoritative
4. Provide your own `TYPESAFE_API_KEY` in the OMP process environment through your normal secure setup. Never put it in `auto.json`, this repository, task artifacts, or tool arguments. No external private connector key is imported. `jev-latest` is the fixed TypeSafe routing model; OMP generative models/efforts still use native roles
5. Run `/auto start my-change` in interactive OMP and confirm the scoped run and evidence sharing. `/auto status` and `auto_status` show progress and budgets. `/auto stop` cancels; a fresh user start is required to reset budgets

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
- `replan` requires the existing Architect recovery checkpoint. A denied OMP tool approval stops Auto as `needs_user`; no confidence can override it
- Completion belongs to Auto while a run is active. Explicit completion-tool calls defer without consuming rounds. Auto first observes all tasks done, runs strict Rasen artifact validation, then spends the existing independent completion review rounds. Unresolved plan/recovery checkpoints, review findings, or exhausted review budget cannot become success. **Rasen validation checks artifacts, not whether implementation tests passed**; the architect still needs actual test evidence
- Task identity/order/description, schema, and local project root are frozen for a run. Scope changes require the user to review and explicitly restart. Deleted/replaced tasks and repeated checkbox toggling do not manufacture progress
- `maxSteps` bounds main execution turns (1–8, aligned with the pinned host's continuation cap), `maxToolCalls` bounds main-session tool attempts, `maxStalls` bounds turns without new completed tasks, and `maxDurationMs` sets the run deadline. Failed attempts count. Limits never reset on hidden continuations
- Defaults allow up to 8 semantic primary attempts and 2 semantic fallback attempts; completion/plan/recovery reviews retain the separate `3 × reviews.max` total maximum. Actual counts are usually lower. Each boundary is bounded to 24 seconds; CLI and decision operations have shorter deadlines
- Terminal outcomes are distinct: `completed`, `needs_user`, `uncertain`, `stalled`, `budget_exhausted`, `cancelled`, and `blocked`. Only `completed` means the CLI and current architect completion gate both passed. Restart/resume/branch does not resume Auto; a new real user request cancels its ownership

The confidence threshold is an uncalibrated routing heuristic, not a correctness probability. A future local backend such as Laya can implement the `DecisionProvider` interface, but no Laya model is installed, trained, benchmarked, or supported by this PR. Its confidence would require separate evaluation.

Auto sends only bounded task counts, a progress summary, and recent tool evidence to the fixed TypeSafe endpoint. No generated skill or full source artifact is automatically included in that request, but tool evidence can still contain source or private data: confirm only for data you may send. The separate no-tool architect sessions receive their bounded review/triage evidence through your configured provider. HTTP redirects are refused, response/request sizes are bounded, and provider errors do not echo credentials or response bodies.

These are orchestration controls, not an OS sandbox: arbitrary shell code can create processes outside native job tracking, and streamed assistant claims cannot be retracted. Auto refuses completion with running native background jobs. Use normal OMP approval settings and review the final evidence.

See [verification and known coverage limits](rasen-auto-verification.md) for recorded evidence and reproduction steps. Return to the [README](../README.md).

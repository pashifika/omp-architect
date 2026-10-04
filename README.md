# omp-architect

Selective model orchestration for [Oh My Pi](https://omp.sh): an implementation model does the work, a lightweight model explores, and an independent architect reviews meaningful checkpoints. An optional Rasen Auto core adds bounded execution turns; no visualization layer.

## Compatibility

Tested against **OMP 18.5.1**, **Bun 1.3.14**, and TypeScript 5.9.3. The exact host peer dependency is intentional: extension event and SDK APIs change quickly. The compatibility smoke tests exercise the real OMP loader, agent discovery, and an isolated SDK reviewer with a local fake provider. **No live generative OMP model has been tested.** Jev routing has a six-case live connector smoke; direct OMP-to-Jev HTTP is fixture-tested. See [verification](docs/rasen-auto-verification.md).

## Install

Install Bun and OMP using their official installation instructions, then:

```sh
git clone https://github.com/pashifika/omp-architect.git
cd omp-architect
bun install --frozen-lockfile
bun run dev:install       # link this checkout and register its local catalog
```

`dev:install` uses the checkout's pinned OMP CLI to link the package (including
its agents) and register `.omp-plugin/marketplace.json` from this checkout. It
works offline after dependencies are installed, including before the catalog is
published. Restart OMP after installing or changing source. No build is needed:
OMP loads the TypeScript directly. **This package has no MCP server**, so there
is no MCP entry to create; existing `mcp.json` files are untouched.

The command preserves your model roles, credentials, instructions and unrelated
plugins/catalogs. Rerunning it keeps this checkout's enabled/disabled state,
feature selection and settings; it only refreshes its catalog cache if the
catalog changed. A different checkout, npm/git or marketplace installation,
unmanaged files, redirected storage paths, malformed registry, or conflicting
catalog name stops the command before installation. Resolve the reported
conflict with OMP's native commands, then retry; there is no destructive
`--force` option. Stop other plugin-management commands while running it: OMP's
link and catalog operations are separate, not one transaction. If an OMP command
fails after a previous step succeeded, fix the cause and rerun safely.

```sh
bun run dev:install --dry-run         # inspect without changing OMP installation files
bun run dev:install --no-marketplace  # link only
bun run dev:install --help
```

OMP's `OMP_PROFILE` / `PI_PROFILE`, `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR` and
existing XDG layout are honored through its own path helpers. In particular,
`PI_CODING_AGENT_DIR` changes the agent directory, not the plugins/catalog root;
use an OMP profile for an isolated installation. Invoke the command under the
same environment/profile as your normal OMP sessions. It can also be run by
absolute script path from another working directory.

The registered catalog is local to this checkout. `omp plugin discover
omp-architect` reads its cached metadata; `omp plugin marketplace update
omp-architect` refreshes it manually. The catalog's GitHub source follows the
repository's default branch (no branch name or unpublished release tag is
hard-coded). Registering a catalog does not install from it. Linked checkouts
use source changes directly and are not upgraded by `omp plugin upgrade`.

To remove this development installation, use OMP under the same profile:

```sh
omp plugin uninstall omp-architect
omp plugin marketplace remove omp-architect  # optional: unregister the local catalog
```

These remove the plugin registration/link and catalog cache, not the checkout.

Merge [examples/config.yml](examples/config.yml) into `~/.omp/agent/config.yml`, replacing the example provider/model selectors with models you can use. Find selectors with `omp models find <name>` and authenticate using `/login`. For one launch, pass the **package directory**, so OMP also discovers its `agents/`:

```sh
omp --model @implementation --extension /absolute/path/to/omp-architect
```

The linked installation already loads persistently; the explicit `--extension`
command above is an alternative one-launch setup. For a manual persistent setup,
you can instead add `/absolute/path/to/omp-architect` to your existing `extensions`
array. Keep other entries: arrays replace lower-priority arrays. Avoid configuring
both installation routes for the same checkout. An installed OMP plugin package
also discovers sibling `agents/`; no separate copy step is required. npm
publication is not required or performed by this project.

## One source of truth for models and reasoning

Use native OMP `modelRoles` for **all model selectors and effort levels**:

```yaml
modelRoles:
  default: "@implementation"
  implementation: openai/gpt-5.4:medium
  research: openai/gpt-5-mini:low
  architect: openai/gpt-5.4:high
```

These model IDs are examples, not availability or quality guarantees. Native `/model` → Roles can change them; a role can also alias another role. Use any authenticated provider supported by OMP. Thinking suffixes are resolved and clamped by OMP. `default: "@implementation"` sets the usual main model; an explicit launch `--model` still wins. The extension never silently switches the active main model.

`omp-worker` routes through the implementation role. `omp-explorer` routes through research and exposes only read/grep/find/ls (plus OMP's yield tool). Routing applies only to those two package agents; unrelated agents and explicitly tagged model agents remain under native OMP routing. Configurable role names below override these package agents' frontmatter at spawn time. Subagents cannot invoke architect checkpoints or recursively orchestrate reviews.

OMP's `@default` agent selector can inherit the active parent model, so the worker uses an explicit `@implementation` role instead. Use `/architect` to inspect the role names, current main model, remaining review usage, and blocked/completion status.

## Bounded review rounds

Optionally copy [examples/architect.json](examples/architect.json) to the **working project's** `.omp/architect.json`. This file stores role **names**, thresholds, and limits; it never stores model IDs or effort levels.

```json
{
  "roles": { "implementation": "implementation", "research": "research", "architect": "architect" },
  "reviews": { "min": 1, "max": 3 },
  "repeatedErrorThreshold": 2,
  "substantialPlanSteps": 3,
  "reviewTimeoutMs": 25000,
  "maxEvidenceChars": 24000
}
```

- `reviews.min/max` apply to each phase: plan, recovery, completion. Valid bounds are `1 <= min <= max <= 8`; defaults are 1/3
- A round means a fresh independent architect review. Review → findings → fix → delta re-review accumulates rounds; corrections and changed evidence never reset the allowance
- Only the latest approval for current evidence can pass a phase, and only after its minimum valid rounds. Earlier rounds may have requested fixes. With min > 1, an early clean result requests another independent current-state/delta review; cached responses never count as rounds
- Max limits attempts, including provider failures/timeouts, per phase per user request. There are only three phases, so the absolute request cap is `3 × max` provider calls. One phase cannot consume another phase's allowance. Completion continuations are also capped at max
- At the cap, missing evidence, errors, or unresolved findings remain **blocked**, never converted into success. The extension stops automatic continuation and shows an explicit unverified/blocked notice. A new actual user request starts fresh allowances; state is intentionally session-local and is reset on resume/branch/restart
- Unknown options, selectors where role names are expected, and invalid bounds fail closed. Config reload requires a session restart

The bounded review/fix/delta-review pattern is inspired by [Rasen's review-cycle](https://github.com/DumoeDss/rasen/blob/1f50807b76c227aa41fb9c7e73a9f6b97b285860/src/core/templates/workflows/_orchestration.ts). Its default maxRounds is 3. The min/max pair and hard per-phase cap here are this extension's semantics; it does not add hidden strategy-reset loops after max.

## Workflow

1. Before a substantial plan, the main agent calls `architect_checkpoint` with `phase: "plan"`, a factual summary, and the proposed `steps`. OMP todo init/append with at least `substantialPlanSteps` is a backstop: an unreviewed plan is held and subsequent execution tools are blocked until approved
2. Two same-tool/same-error results by default trigger recovery. Duplicate delivery is ignored; successful same-tool results or a different error break the consecutive streak. Native timing footers do not change an error's identity. Read-only inspection remains available while execution is held; call `phase: "recovery"` with a different proposed approach
3. Before claiming completion, call `phase: "completion"` with delivered requirements, actual test evidence, and remaining limitations. Any new tool result or plan change invalidates completion approval
4. Address findings and re-review within the same allowance, or report the blocker. `/architect` shows the current status

The reviewer is a **separate, in-memory SDK session** on the architect role. It receives the user request, checkpoint summary, staged plan and bounded recent tool evidence. It has zero tools, no MCP/LSP/IRC, no ambient extensions, no memory backend, no cache warming, and no autonomous retries. It cannot change code or grant permissions. The main agent performs authorized corrections through its existing tools and approval flow. This is a reasoning aid, not a security sandbox or a correctness proof.

## Opt-in Rasen Auto core

`/auto start <change>` drives a **prepared, local Rasen change** through task-sized implementation turns, fresh CLI observation, and architect completion review. It is a single-driver apply loop: the main OMP model does implementation, Jev supplies a small semantic routing hint, and code owns state and limits. Existing Architect behavior remains the default when Auto is off.

The supported Rasen source is **dev/0.1.8 at `f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd`**, built and locally installed before verification. Its generated `.omp/skills/rasen-apply-change/SKILL.md` and the actual CLI instruction/context artifacts are read on every boundary. Skills are not copied into this package. The supplied profile was tested privately; it is not redistributed. This first core does not implement Rasen's whole auto pipeline, planning-only or external-store modes, nor automatic propose/ship/archive.

### Setup

1. Build/install the pinned Rasen development source with `bun run prepare:rasen` (see the script's reported executable path). For a supplied YAML profile, run `rasen profile import /path/to/profile.yaml --as my-auto`, then `rasen init --tools omp --profile my-auto` in your project using that executable. The script installs into a temporary test prefix; use Rasen's upstream packaging workflow for a persistent installation. Prepare the change's proposal, design, specs, and tasks first
2. Copy [examples/auto.json](examples/auto.json) to the working project's `.omp/auto.json`; set `rasenExecutable` to that installed executable if it is not on PATH. Restart OMP
3. Merge [examples/auto-config.yml](examples/auto-config.yml) to set native OMP `bash.autoBackground.enabled: false` and finish existing background jobs. Auto requires foreground execution. The regular `modelRoles` and Architect `reviews.min/max` settings above remain authoritative
4. Provide your own `TYPESAFE_API_KEY` in the OMP process environment through your normal secure setup. Never put it in `auto.json`, this repository, task artifacts, or tool arguments. No external private connector key is imported. `jev-latest` is the fixed TypeSafe routing model; OMP generative models/efforts still use native roles
5. Run `/auto start my-change` in interactive OMP and confirm the scoped run and evidence sharing. `/auto status` and `auto_status` show progress and budgets. `/auto stop` cancels; a fresh user start is required to reset budgets

The extension invokes only these documented read-only Rasen capabilities, without a shell:

```sh
rasen status --change my-change --json
rasen instructions apply --change my-change --json
rasen validate my-change --type change --strict --json
```

The main agent reads the generated skill and bounded context files, executes a task through normal OMP tools/approvals, verifies it, and updates its Rasen task checkbox. The next stop hook re-reads the CLI; assistant claims alone do not advance task progress. Skill instructions that call for delegation are explicitly adapted to direct main-session execution. Subagent spawning (including speculative/eval spawns), explicit async tools, and Bash service mode are blocked during Auto; ordinary non-Auto routing is unchanged.

### Deterministic gates and semantic fallback

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

## Important limits

- `before_agent_start` is not a semantic plan detector. Prose-only plans depend on the main agent calling the explicit checkpoint; the todo backstop covers supported todo init/append shapes
- `session_stop` is a completion backstop, **not a way to retract already-streamed text**. The explicit completion tool is the normal pre-answer path
- Evidence is bounded and may be truncated. The reviewer cannot inspect files itself; it must block on missing evidence. Unobserved external file changes and changes after the final checkpoint cannot be detected
- Reviews consume the configured provider's resources and send the bounded evidence to that provider. OMP's inherited credential/redaction handling applies; do not submit secrets as task evidence
- The 25-second default timeout stays below OMP's 30-second hook timeout. A slow provider may require a later user-initiated attempt; the extension does not silently remove the cap
- Installing/running an extension is in-process code execution. This does not replace OMP's normal tool approvals or authorize permission workarounds

## Development and verification

```sh
bun install --frozen-lockfile
bun run check
bun run prepare:rasen
bun run test:smoke
bun run check:package
bun run check:workflows
bun run test:dev-install  # real pinned OMP, isolated homes, no network or model calls
```

Installer tests exercise fresh/repeated native installation, ownership conflicts,
registry validation, dry runs, catalog refresh and profile/path isolation. CI
also runs these tests on macOS and Windows; the stable required check remains
`ci`. The workflow runs for pull requests and pushes to `main`.
[Contributing](CONTRIBUTING.md#required-status-checks) describes the tracked branch
ruleset and its separate administrator apply step.

Unit tests cover config rejection, selective routing, plan gates, repeat failures, stale/cache invalidation, cancellation, timeouts and bounded rounds, plus Auto budgets, stalls, scope changes and strict Jev transport/response handling. Rasen smoke tests require the pinned development build; they fail rather than silently skip when it is absent. Smoke tests load the real OMP extension/agents and run its independent reviewer through a local fake model transport, including role effort and zero-tool restrictions. Package checks pack, inspect and load the actual tarball against locked host dependencies; they do not publish or claim a registry-install test.

CI follows [omp-relayd](https://github.com/pashifika/omp-relayd)'s relevant conventions: pinned actions, least-privilege permissions, nonpersistent checkout credentials, timeouts, concurrency cancellation, and an always-run `ci` gate that requires all prerequisite jobs to succeed. No release/publishing workflow or credentials are configured.

## License

Apache-2.0. See [LICENSE](LICENSE).

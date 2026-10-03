# omp-architect

Selective model orchestration for [Oh My Pi](https://omp.sh): an implementation model does the work, a lightweight model explores, and an independent architect reviews meaningful checkpoints. No visualization layer.

## Compatibility

Tested against **OMP 18.5.1**, **Bun 1.3.14**, and TypeScript 5.9.3. The exact host peer dependency is intentional: extension event and SDK APIs change quickly. The compatibility smoke tests exercise the real OMP loader, agent discovery, and an isolated SDK reviewer with a local fake provider. **No paid/live model provider has been tested.**

## Install

Install Bun and OMP using their official installation instructions, then:

```sh
git clone https://github.com/pashifika/omp-architect.git
cd omp-architect
bun install --frozen-lockfile
```

Merge [examples/config.yml](examples/config.yml) into `~/.omp/agent/config.yml`, replacing the example provider/model selectors with models you can use. Find selectors with `omp models find <name>` and authenticate using `/login`. For one launch, pass the **package directory**, so OMP also discovers its `agents/`:

```sh
omp --model @implementation --extension /absolute/path/to/omp-architect
```

For persistent loading, add `/absolute/path/to/omp-architect` to your existing `extensions` array in OMP config. Keep other entries: arrays replace lower-priority arrays. Restart OMP after installation. An installed OMP plugin package also discovers sibling `agents/`; no separate copy step is required. npm publication is not required or performed by this project.

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
bun run test:smoke
bun run check:package
bun run check:workflows
```

Unit tests cover config rejection, selective routing, plan gates, repeat failures, stale/cache invalidation, cancellation, timeouts and bounded rounds. Smoke tests load the real OMP extension/agents and run its independent reviewer through a local fake model transport, including role effort and zero-tool restrictions. Package checks pack, inspect and load the actual tarball against locked host dependencies; they do not publish or claim a registry-install test.

CI follows [omp-relayd](https://github.com/pashifika/omp-relayd)'s relevant conventions: pinned actions, least-privilege permissions, nonpersistent checkout credentials, timeouts, concurrency cancellation, and an always-run `ci` gate that requires all prerequisite jobs to succeed. No release/publishing workflow or credentials are configured.

## License

Apache-2.0. See [LICENSE](LICENSE).

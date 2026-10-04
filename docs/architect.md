# Model roles and architect reviews

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

The extension does not lower or override native effort levels, including `xhigh` where the selected model supports it. Review deadlines bound elapsed time, not reasoning effort.

`omp-worker` routes through the implementation role. `omp-explorer` routes through research and exposes only read/grep/find/ls (plus OMP's yield tool). Routing applies only to those two package agents; unrelated agents and explicitly tagged model agents remain under native OMP routing. Configurable role names below override these package agents' frontmatter at spawn time. Subagents cannot invoke architect checkpoints or recursively orchestrate reviews.

OMP's `@default` agent selector can inherit the active parent model, so the worker uses an explicit `@implementation` role instead. Use `/architect` to inspect the role names, current main model, remaining review usage, and blocked/completion status.

## Bounded review rounds

Optionally copy [examples/architect.json](../examples/architect.json) to the **working project's** `.omp/architect.json`. This file stores role **names**, thresholds, and limits; it never stores model IDs or effort levels.

```json
{
  "roles": { "implementation": "implementation", "research": "research", "architect": "architect" },
  "reviews": { "min": 1, "max": 3 },
  "repeatedErrorThreshold": 2,
  "substantialPlanSteps": 3,
  "reviewTimeoutMs": 120000,
  "maxEvidenceChars": 24000
}
```

- `reviews.min/max` apply to each phase: plan, recovery, completion. Valid bounds are `1 <= min <= max <= 8`; defaults are 1/3
- A round means a fresh independent architect review. Review → findings → fix → delta re-review accumulates rounds; corrections and changed evidence never reset the allowance
- Only the latest approval for current evidence can pass a phase, and only after its minimum valid rounds. Earlier rounds may have requested fixes. With min > 1, an early clean result requests another independent current-state/delta review; cached responses never count as rounds
- Max limits attempts, including provider failures/timeouts, per phase per user request. There are only three phases, so the absolute request cap is `3 × max` provider calls. One phase cannot consume another phase's allowance. Completion continuations are also capped at max
- At the cap, missing evidence, errors, or unresolved findings remain **blocked**, never converted into success. The extension stops automatic continuation and shows an explicit unverified/blocked notice. A new actual user request starts fresh allowances; state is intentionally session-local and is reset on resume/branch/restart
- Normal explicit reviews default to a 120-second timeout. `reviewTimeoutMs` accepts integer milliseconds from 100 through 120000; cancellation and the per-phase attempt caps still apply
- Unknown options, selectors where role names are expected, and invalid bounds fail closed. Restart the OMP session after changing `.omp/architect.json` or updating the extension; an already-running session retains its loaded configuration and handlers

The bounded review/fix/delta-review pattern is inspired by [Rasen's review-cycle](https://github.com/DumoeDss/rasen/blob/1f50807b76c227aa41fb9c7e73a9f6b97b285860/src/core/templates/workflows/_orchestration.ts). Its default maxRounds is 3. The min/max pair and hard per-phase cap here are this extension's semantics; it does not add hidden strategy-reset loops after max.

## Workflow

1. Before a substantial plan, the main agent calls `architect_checkpoint` with `phase: "plan"`, a factual summary, and the proposed `steps`. OMP todo init/append with at least `substantialPlanSteps` is a backstop: an unreviewed plan is held and subsequent execution tools are blocked until approved
2. Two same-tool/same-error results by default trigger recovery. Duplicate delivery is ignored; successful same-tool results or a different error break the consecutive streak. Native timing footers do not change an error's identity. Read-only inspection remains available while execution is held; call `phase: "recovery"` with a different proposed approach
3. Before claiming completion, call `phase: "completion"` with delivered requirements, actual test evidence, and remaining limitations. Fresh ordinary tool results or plan changes invalidate completion approval; the checkpoint's own result and read-only `auto_status` results do not
4. Address findings and re-review within the same allowance, or report the blocker. `/architect` shows the current status

The native `architect_checkpoint` tool and `write` to the exact canonical path `xd://architect_checkpoint` share the same checkpoint identity for guards and result handling. Likewise, native `auto_status` and `write` to `xd://auto_status` remain read-only status operations. Checkpoint results are not ordinary write evidence or repeated tool failures, so they neither invalidate their own approval nor trigger spurious recovery. This exception applies only to those exact device paths: ordinary writes and unknown devices remain subject to the plan/recovery guards and are blocked while the required approval is pending.

The reviewer is a **separate, in-memory SDK session** on the architect role. It receives the user request, checkpoint summary, staged plan and bounded recent tool evidence. It has zero tools, no MCP/LSP/IRC, no ambient extensions, no memory backend, no cache warming, and no autonomous retries. It cannot change code or grant permissions. The main agent performs authorized corrections through its existing tools and approval flow. This is a reasoning aid, not a security sandbox or a correctness proof.

## Important limits

- `before_agent_start` is not a semantic plan detector. Prose-only plans depend on the main agent calling the explicit checkpoint; the todo backstop covers supported todo init/append shapes
- Normal `session_stop` is a completion backstop, **not a way to retract already-streamed text**. It returns a bounded continuation requesting an explicit checkpoint rather than invoking or awaiting a model review inside OMP's 30-second hook deadline. The explicit completion tool is the normal pre-answer path and can use the full configured review timeout
- Evidence is a bounded window, not a complete tool history. Stored records and checkpoint snapshots remain valid JSON within `maxEvidenceChars`, including escaping and the nested encoding of evidence strings. Records are selected newest-first and presented chronologically; `omittedToolEvidence` counts older records left out of the window. Long tool outputs retain their beginning and end with an explicit omission marker, and oversized inputs become marked previews without displacing their result. Request, summary and staged-plan context are also bounded with explicit omission markers; short context and small structured inputs remain unchanged. If a review needs omitted older evidence, the main agent must re-read it through its tools before the next checkpoint. The reviewer cannot inspect files itself and must block on evidence that is still missing. Unobserved external file changes and changes after the final checkpoint cannot be detected
- Reviews consume the configured provider's resources and send the bounded evidence to that provider. OMP's inherited credential/redaction handling applies; do not submit secrets as task evidence
- Rasen Auto retains its separate 24-second turn-boundary cancellation signal, below OMP's 30-second hook deadline. The 120-second normal review timeout does not extend that Auto boundary; cancellation or exhausted review attempts never count as approval
- Installing/running an extension is in-process code execution. This does not replace OMP's normal tool approvals or authorize permission workarounds

For automatic execution, see [Rasen Auto](rasen-auto.md). Return to the [README](../README.md).

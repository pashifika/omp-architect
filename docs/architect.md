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
  "maxEvidenceChars": 24000,
  "maxReviewBytes": 131072
}
```

- `reviews.min/max` apply to each phase: plan, recovery, completion. Valid bounds are `1 <= min <= max <= 8`; defaults are 1/3
- A round means a fresh independent architect review. Review → findings → fix → delta re-review accumulates rounds; corrections and changed evidence never reset the allowance
- Only the latest approval for current evidence can pass a phase, and only after its minimum valid rounds. Earlier rounds may have requested fixes. With min > 1, an early clean result requests another independent current-state/delta review; cached responses never count as rounds
- Max limits attempts, including provider failures/timeouts, per phase per user request. There are only three phases, so the absolute request cap is `3 × max` provider calls. One phase cannot consume another phase's allowance. Completion continuations are also capped at max
- At the cap, missing evidence, errors, cancellation, or unresolved findings remain **blocked**, never converted into success. An approval on the final permitted review remains valid; a review still in flight is not terminal. Terminal unresolved plan/recovery phases stop at the boundary too, before any Auto validation or decision work. The extension stops automatic continuation and shows an explicit unverified/blocked notice. A new actual user request starts fresh allowances; state is intentionally session-local and is reset on resume/branch/restart
- Normal explicit reviews default to a 120-second timeout. `reviewTimeoutMs` accepts integer milliseconds from 100 through 120000; cancellation and the per-phase attempt caps still apply
- `maxReviewBytes` bounds each complete UTF-8 review body: default 131072 bytes, integer range 1024–1048576. Oversized or invalid input is rejected before a review attempt, never truncated. The complete canonical plan is separately included, with at most 30 steps of 1–1000 characters each and its JSON also within `maxReviewBytes`
- `maxEvidenceChars` separately bounds the lossy host-observed context and recent-tool-evidence window: default 24000 characters, integer range 1000–100000. Increasing it does not change the full-file limit
- Unknown options, selectors where role names are expected, and invalid bounds fail closed. Restart the OMP session after changing `.omp/architect.json` or updating the extension; an already-running session retains its loaded configuration and handlers

The bounded review/fix/delta-review pattern is inspired by [Rasen's review-cycle](https://github.com/DumoeDss/rasen/blob/1f50807b76c227aa41fb9c7e73a9f6b97b285860/src/core/templates/workflows/_orchestration.ts). Its default maxRounds is 3. The min/max pair and hard per-phase cap here are this extension's semantics; it does not add hidden strategy-reset loops after max.

## Workflow

1. Before a substantial plan, write a review file describing scope, design, risks and verification, then call `architect_checkpoint` with `phase: "plan"`, its `evidenceRef`, and the proposed `steps`. OMP todo init/append with at least `substantialPlanSteps` is a backstop: an unreviewed plan is held and subsequent execution tools are blocked until approved. A checkpoint without explicit or staged canonical steps, or with an empty/blank plan, is rejected without consuming a review
2. Two same-tool/same-error results by default trigger recovery. Duplicate delivery is ignored; successful same-tool results or a different error break the consecutive streak. Native timing footers do not change an error's identity. Read-only inspection and the narrow review-file handoff remain available while execution is held; submit `phase: "recovery"` with a file documenting the failure and a different proposed approach
3. Before claiming completion, submit `phase: "completion"` with a file containing delivered requirements, actual verification evidence and remaining limitations. Fresh ordinary tool results or plan changes invalidate completion approval; the checkpoint's own result and read-only `auto_status` results do not. An Eval queue receipt is not approval; see the boundary behavior below
4. Address findings and re-review within the same allowance. To stop with an honest blocker, submit `phase: "blocked"` with a file describing it. This is an explicit stop action, not a fourth review phase: it spends no review, revokes completion, shows the blocker, and stops ordinary/Auto continuations. A reviewer returning `decision: "blocked"` below the attempt cap remains retriable. `/architect` and read-only `auto_status` show status and canonical plan details

### Native-file handoff

The checkpoint API is `{ phase, evidenceRef, steps? }`; the old inline `summary` argument is rejected. Use either:

- `local://architect-review/NAME.md`, authored with OMP's existing `write` tool. `NAME` is 1–80 ASCII letters, digits, underscores or hyphens
- A complete `artifact://ID` numeric reference from the originating OMP session. Cross-session fallback, fragments, line ranges and arbitrary filesystem paths are not accepted

The checkpoint reads the whole regular UTF-8 file, rejects missing, empty, malformed, NUL-containing, unstable or oversized input, and snapshots the accepted bytes with OMP's `sessionManager.saveArtifact`. This uses native session storage, not a separate artifact store, and requires a persistent OMP session. Even an existing artifact is snapshotted. The reviewer receives the exact admitted body plus SHA-256, byte count, artifact reference and source metadata. Editing the original file cannot change that admitted copy. Input rejection spends no review attempt.

For a native tool call, first `write` this payload and await success:

```json
{"path":"local://architect-review/plan.md","content":"Scope: add input validation.\nDesign: reject invalid values at the parser boundary.\nRisk: preserve existing valid inputs.\nVerification: add boundary cases and run the focused tests."}
```

Then call `architect_checkpoint`:

```json
{"phase":"plan","evidenceRef":"local://architect-review/plan.md","steps":["Inspect the parser and its tests.","Add input validation and boundary tests.","Run the focused test suite."]}
```

With the `xd://` interface, write the JSON checkpoint payload as the `content` of a `write` to `xd://architect_checkpoint`. If using Eval, make **two separate foreground JavaScript Eval calls**. Set **`language: "js"` and `reset: true` on each outer Eval tool invocation**, and put the following snippet in its `code` field. The native reset starts a fresh Eval kernel and discards previous Eval variables; it is not an argument to `tool.write`. First author the file:

```js
console.log(await tool.write({"path":"local://architect-review/plan.md","content":"Scope: add input validation.\nDesign: reject invalid values at the parser boundary.\nRisk: preserve existing valid inputs.\nVerification: add boundary cases and run the focused tests."}))
```

After that write succeeds, submit the checkpoint in a second Eval call, again with **`language: "js"` and `reset: true`**:

```js
console.log(await tool.write({"path":"xd://architect_checkpoint","content":"{\"phase\":\"plan\",\"evidenceRef\":\"local://architect-review/plan.md\",\"steps\":[\"Inspect the parser and its tests.\",\"Add input validation and boundary tests.\",\"Run the focused test suite.\"]}"}))
```

While plan/recovery approval is pending, the Eval exception requires the native reset above and accepts only `await tool.write(JSON_LITERAL)` or `console.log(await tool.write(JSON_LITERAL))` (optional trailing semicolon). Missing or unsupported reset stays blocked; direct OMP `write` is unaffected. The strict JSON object must contain only `path` and `content`, targeting the reserved review file or exact checkpoint device. Variables, expressions, extra statements, wrapper functions, other tool calls and async/background mode are not admitted. General Eval and project writes remain gated; normal tool permissions still apply. For recovery, completion or blocked, use the same two-write sequence with the appropriate phase and file body; `steps` is needed only to supply a plan.

Put the required review material in the file itself. A long file's ordinary read result can be truncated, so repeatedly reading it is not a reliable handoff. Keep provenance explicit: assistant-authored text, even copied logs, is not independent proof that a command ran. The reviewer compares it with separately supplied host-observed evidence and must block when essential verification is missing.

### Completion boundaries and status

A direct completion checkpoint can use the configured timeout (120 seconds by default). Completion invoked inside Eval instead snapshots and queues the file, returning `status: "queued"`, `charged: false`, and the invocation/artifact identity, without approval. At `session_stop`, after all outer Eval results have been observed, that one queued review runs against the final host-evidence revision. This boundary is capped at 24 seconds, below OMP's 30-second hook deadline. A duplicate pending completion is rejected without a review attempt. Cancellation, new user input and session changes clear queued work. Running background jobs block completion: wait for all background work to finish, collect its results, and submit fresh review evidence rather than relying on an earlier queue receipt.

Return factual progress after a queue receipt; wait for the durable result before treating completion as approved. Check `/architect` or `auto_status` for `lastReview`: correlate `invocationId`, `artifactRef`, `sha256`, `status`, `charged`, and `verdict`. `charged` reports whether an attempt consumed review allowance, not provider billing. `provider_verdict` means a completed provider response; `caller_cancelled`, `timed_out`, `input_rejected`, and `stale` are distinct outcomes. Budget and minimum-round gates still determine whether a phase passes. A terminal stop can abort the caller after a provider verdict; its durable notice retains `lastReview` so a caller-level abort does not hide which review actually finished.

### Exact plan registration and recovery

Plan checkpoint results return `plan.pending` and `plan.approved`, each with a SHA-256 ID and canonical steps. The ID is SHA-256 of `JSON.stringify(steps)`; text, punctuation, whitespace, step count and order are significant. Once a plan is staged, changed non-empty todo init/append steps require review even if the replacement is below the initial substantial-plan threshold. IDs are diagnostics, not permission tokens. No semantic-equivalence guessing is used.

After approval, copy `plan.approved.steps` unchanged into todo init/append and **await successful registration before executing other tools**. Do not batch registration and execution: OMP admits calls individually, so a write admitted before a mismatching todo cannot be retroactively blocked. This is not an atomic transaction or a security sandbox.

If todo is denied, the reason identifies the first changed step or differing step count, with pending/approved IDs. The pending plan becomes the attempted todo, while the previously approved canonical steps remain visible through `auto_status` (also `write` to `xd://auto_status`) and `/architect`. Either retry todo with those exact approved steps to restore the approved identity without another review, or call `phase: "plan"` to review the changed pending steps within the remaining allowance. Then await todo success. An empty replacement cannot clear an existing plan gate. After a terminal stop, a new user request is required; status inspection remains available.

The native `architect_checkpoint` tool and `write` to the exact canonical path `xd://architect_checkpoint` share the same checkpoint identity for guards and result handling. Likewise, native `auto_status` and `write` to `xd://auto_status` remain read-only status operations. Checkpoint results are not ordinary write evidence or repeated tool failures, so they neither invalidate their own approval nor trigger spurious recovery. The reserved review-file write and literal Eval carriers above are additional narrow admission exceptions. Their ordinary tool results still enter host evidence; unknown devices and other writes remain subject to the plan/recovery guards.

Admission denials are recorded at `tool_call`, because OMP does not emit `tool_result` when that hook blocks a call. They use bounded evidence records marked `kind: "gate_denial"` and `executed: false`, and never advance or clear execution-error streaks. Duplicate result delivery for a denied call is ignored. A new denial invalidates completion and any in-flight review as changed evidence; retry within the same allowance.

The reviewer is a **separate, in-memory SDK session** on the architect role. It receives bounded host-observed context (including the request and recent tool evidence), a separately supplied complete exact canonical plan, and the full native-file body with provenance metadata. It has zero tools, no MCP/LSP/IRC, no ambient extensions, no memory backend, no cache warming, and no autonomous retries. It cannot inspect files, change code or grant permissions. The main agent performs authorized corrections through its existing tools and approval flow. This is a reasoning aid, not a security sandbox or a correctness proof.

## Important limits

- `before_agent_start` is not a semantic plan detector. Prose-only plans depend on the main agent calling the explicit checkpoint; the todo backstop covers supported todo init/append shapes
- Normal `session_stop` is a completion backstop, **not a way to retract already-streamed text**. It consumes a queued Eval completion as described above; otherwise it requests an explicit checkpoint through a bounded continuation. A queue receipt, timeout or cancellation never establishes approval
- Host evidence is a bounded window, not a complete tool history. Stored records and context snapshots remain valid JSON within `maxEvidenceChars`, including escaping and nested encoding. Records are selected newest-first and presented chronologically; `omittedToolEvidence` counts older records omitted. Long tool outputs retain their beginning and end with an omission marker, and oversized inputs/metadata become marked previews. Host truncation/artifact metadata is evidence about what was observed, not permission to fetch more. Request and plan previews in this window may be bounded; the separately supplied canonical plan and admitted file body are complete. The reviewer must block on essential evidence that remains missing. Unobserved external file changes and changes after the final checkpoint cannot be detected
- Reviews consume the configured provider's resources and send the full admitted body, exact canonical plan and bounded host evidence to that provider. OMP's inherited credential/redaction handling applies; do not submit secrets as task evidence
- Rasen Auto retains its separate 24-second turn-boundary cancellation signal, below OMP's 30-second hook deadline. The 120-second normal review timeout does not extend that Auto boundary; cancellation or exhausted review attempts never count as approval
- Installing/running an extension is in-process code execution. This does not replace OMP's normal tool approvals or authorize permission workarounds

For automatic execution, see [Rasen Auto](rasen-auto.md). Return to the [README](../README.md).

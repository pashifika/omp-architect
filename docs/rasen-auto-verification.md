# Rasen Auto verification

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

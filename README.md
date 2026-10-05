# omp-architect

Split implementation, repository exploration, and independent review across model
roles in [Oh My Pi (OMP)](https://omp.sh). Keep the main model focused on coding
while a separate reviewer checks plans, recovery approaches, and completion evidence.

## Features

- **Role-based agents:** Send coding tasks to `omp-worker` and read-only research to `omp-explorer`.
- **Independent reviews:** Hand a complete native OMP file to an architect model at meaningful checkpoints.
- **Bounded review rounds:** Set minimum and maximum rounds; unresolved findings stop the workflow.
- **Optional Rasen Auto:** Run the extension-owned apply, verification, and review flow for a prepared [Rasen](https://github.com/DumoeDss/rasen) change. No generated `rasen-auto` skill or full profile is required. The main LEAD uses native implementation/research/reviewer leaves, with Jev stage-boundary advice, time supervision, and the existing synchronous native-file Architect checkpoint as its sole bounded completion-review loop.

## Install

Install [Bun](https://bun.sh) 1.3.14+ and [OMP](https://omp.sh) 18.5.1 or newer, then:

```bash
git clone https://github.com/pashifika/omp-architect.git
cd omp-architect
bun install --frozen-lockfile
bun run dev:install
```

The installer links this checkout and registers its local plugin catalog. OMP loads
the TypeScript directly; no build is needed. Restart OMP after installation or source changes.

Use the same OMP profile as your normal sessions. The installer preserves existing
configuration and refuses conflicting installations. See [installation and removal](docs/installation.md)
for previews, alternative setups, and conflict handling.

## Quick start

1. Merge [the model-role configuration](examples/config.yml) into your existing OMP configuration.
   Choose models available through your provider; the listed model IDs are illustrative.
   [Model roles](docs/architect.md#one-source-of-truth-for-models-and-reasoning) explains how to select them.
2. Authenticate through OMP's `/login` if needed, then launch OMP in your working project:

   ```bash
   omp
   ```

3. Check the active model, role names, and remaining reviews in the OMP prompt:

   ```console
   /architect
   ```

4. To change model roles, open OMP's model menu and select **Roles**:

   ```console
   /model
   ```

The main agent writes review material with OMP's existing `write` tool to
`local://architect-review/NAME.md`, then calls `architect_checkpoint` with
`{ phase, evidenceRef, steps? }`. An originating-session `artifact://ID` is also
accepted; inline `summary` is not. The checkpoint snapshots the complete file into
native session artifacts. The default `maxReviewBytes` is 131072 UTF-8 bytes;
oversized or invalid input is rejected without spending a review, never truncated.
See the [native-file handoff examples](docs/architect.md#native-file-handoff) for
direct and `xd://` calls. Restricted Eval carriers require `language: "js"` and
`reset: true` on each outer Eval call, which discards previous Eval variables.

Use `/architect` or `auto_status` to inspect blocked work and review status.
Outside Auto, completion requested inside Eval is queued without approval and
reviewed once at the turn boundary after outer results arrive. Auto instead uses
the native completion checkpoint synchronously in the LEAD turn, with fresh Rasen
evidence and the full configured review timeout. Its Eval route requires a
dedicated JavaScript `reset: true` single-call checkpoint carrier;
general or batched carriers are rejected without spending a review. Auto preserves
native async settings and tracks its own Main-owned jobs. Its stop hook
only validates fresh facts against the approval; it does not run the reviewer.
Await Auto-owned native jobs and submit fresh evidence before review. Use `/auto stop`
to cancel Auto-owned work, including detached workers; idle ESC is not a universal
job-cancellation command. The
extension does not silently switch your active main model. Reviews send the full
admitted file and bounded host evidence to your configured provider; do not include secrets. These checks
do not replace tool approvals or prove that assistant-authored claims occurred.

## Configuration and guides

| Need | Where to look |
| --- | --- |
| Install, preview, update, or remove the local plugin | [Installation guide](docs/installation.md) |
| Choose models and reasoning effort | Native OMP `modelRoles`; [model-role guide](docs/architect.md#one-source-of-truth-for-models-and-reasoning) |
| Set review rounds, role names, and thresholds | Project `.omp/architect.json`; [review guide](docs/architect.md#bounded-review-rounds) and [sample settings](examples/architect.json) |
| Apply, verify, and review a prepared Rasen change, with extra instructions or existing brief packs | [Rasen Auto setup and limits](docs/rasen-auto.md); initialize pinned Rasen with `rasen init --tools omp` and prepare the local change and apply skill; the extension owns Auto orchestration. Global `~/.omp/agent/auto.json` defaults and project `.omp/auto.json` overrides are both optional (the active OMP profile determines the global path); TypeSafe authentication through OMP `/login` or `TYPESAFE_API_KEY` is required |
| Add the standalone `/brief` command with Tab completion | [Optional brief installation](docs/installation.md); use `bun run dev:install -- --with-brief` only when another `/brief` is not installed |
| Understand tested behavior and reproduce verification | [Verification record](docs/rasen-auto-verification.md) |
| Develop, run local checks, or submit a pull request | [Contributing](CONTRIBUTING.md) |

## Requirements

- **OMP 18.5.1 or newer** with an authenticated model provider.
- **Bun 1.3.14 or newer** to install dependencies and run the checkout installer.
- **Git** to clone this repository.

OMP 18.5.1 is the minimum supported host version; there is no upper version bound.
Development tracks the latest OMP SDK releases. To update all four SDK packages together:

```bash
bun update @oh-my-pi/pi-ai @oh-my-pi/pi-coding-agent @oh-my-pi/pi-utils @oh-my-pi/pi-tui
```

After updating, restore these four `devDependencies` to `"latest"` in `package.json`
and keep the OMP/TUI peer ranges at `">=18.5.1"`; Bun may save concrete version ranges.
Then run `bun install --lockfile-only` to synchronize the lockfile with those declarations.
Do not use `bun update --no-save` for a recorded update: it also skips saving the lockfile.

`bun.lock` records reproducible dependency resolutions, not a host-version restriction.
CI uses `bun install --frozen-lockfile` and does not automatically fetch newer SDK releases.
See [Contributing](CONTRIBUTING.md) for update checks. The [verification record](docs/rasen-auto-verification.md)
describes historical coverage and limitations; it is not a current compatibility matrix.
Scoped live checkpoint checks do not establish full live Rasen Auto end-to-end coverage.

## License

[Apache-2.0](LICENSE)

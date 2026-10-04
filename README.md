# omp-architect

Split implementation, repository exploration, and independent review across model
roles in [Oh My Pi (OMP)](https://omp.sh). Keep the main model focused on coding
while a separate reviewer checks plans, recovery approaches, and completion evidence.

## Features

- **Role-based agents:** Send coding tasks to `omp-worker` and read-only research to `omp-explorer`.
- **Independent reviews:** Ask an architect model to review meaningful checkpoints before proceeding.
- **Bounded review rounds:** Set minimum and maximum rounds; unresolved findings stop the workflow.
- **Optional Rasen Auto:** Run prepared [Rasen](https://github.com/DumoeDss/rasen) changes through limited implementation turns and completion review.

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

The main agent uses `architect_checkpoint` for plan, recovery, and completion reviews.
Use `/architect` to inspect blocked work and review status. The extension does not
silently switch your active main model. Reviews send bounded task evidence to your
configured provider; do not include secrets. These checks do not replace tool approvals.

## Configuration and guides

| Need | Where to look |
| --- | --- |
| Install, preview, update, or remove the local plugin | [Installation guide](docs/installation.md) |
| Choose models and reasoning effort | Native OMP `modelRoles`; [model-role guide](docs/architect.md#one-source-of-truth-for-models-and-reasoning) |
| Set review rounds, role names, and thresholds | Project `.omp/architect.json`; [review guide](docs/architect.md#bounded-review-rounds) and [sample settings](examples/architect.json) |
| Enable automatic execution for a prepared Rasen change | [Rasen Auto setup and limits](docs/rasen-auto.md); requires pinned Rasen and TypeSafe authentication through OMP `/login` or `TYPESAFE_API_KEY` |
| Understand tested behavior and reproduce verification | [Verification record](docs/rasen-auto-verification.md) |
| Develop, run local checks, or submit a pull request | [Contributing](CONTRIBUTING.md) |

## Requirements

- **OMP 18.5.1 or newer** with an authenticated model provider.
- **Bun 1.3.14 or newer** to install dependencies and run the checkout installer.
- **Git** to clone this repository.

OMP 18.5.1 is the minimum supported host version; there is no upper version bound.
Development tracks the latest OMP SDK releases. To update all three SDK packages together:

```bash
bun update @oh-my-pi/pi-ai @oh-my-pi/pi-coding-agent @oh-my-pi/pi-utils
```

After updating, restore these three `devDependencies` to `"latest"` in `package.json`
and keep the OMP peer range at `">=18.5.1"`; Bun may save concrete version ranges.
Then run `bun install --lockfile-only` to synchronize the lockfile with those declarations.
Do not use `bun update --no-save` for a recorded update: it also skips saving the lockfile.

`bun.lock` records reproducible dependency resolutions, not a host-version restriction.
CI uses `bun install --frozen-lockfile` and does not automatically fetch newer SDK releases.
See [Contributing](CONTRIBUTING.md) for update checks. The [verification record](docs/rasen-auto-verification.md)
describes historical coverage and limitations; it is not a current compatibility matrix.
Scoped live checkpoint checks do not establish full live Rasen Auto end-to-end coverage.

## License

[Apache-2.0](LICENSE)

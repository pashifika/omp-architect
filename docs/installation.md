# Installation and plugin management

Install Bun 1.3.14+ and OMP 18.5.1 or newer using their official installation instructions, then:

```bash
git clone https://github.com/pashifika/omp-architect.git
cd omp-architect
bun install --frozen-lockfile
bun run dev:install       # link this checkout and register its local catalog
```

`dev:install` uses the checkout's installed OMP CLI to link the package (including
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

```bash
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

## Updating OMP SDK dependencies

OMP 18.5.1 is the minimum supported host version, with no upper bound. The
development SDK dependencies track `latest`; update them together:

```bash
bun update @oh-my-pi/pi-ai @oh-my-pi/pi-coding-agent @oh-my-pi/pi-utils
```

Bun may save concrete version ranges during the update. Restore the three SDK
`devDependencies` to `"latest"` in `package.json` and keep the OMP peer range at
`">=18.5.1"`, then run `bun install --lockfile-only` to synchronize the lockfile.
Do not use `bun update --no-save` for a recorded update: it also skips saving the lockfile.

Run the [development and integration checks](../CONTRIBUTING.md#development-and-verification)
after updating, and restart OMP. This updates the checkout's SDK dependencies,
not a separately installed OMP CLI; update that installation through its own installer.
`bun.lock` records the tested dependency resolutions for reproducibility, not a
host-version restriction. CI uses `bun install --frozen-lockfile` to reproduce
those resolutions rather than fetching newer SDK releases automatically.

## Removal and alternative setups

To remove this development installation, use OMP under the same profile:

```bash
omp plugin uninstall omp-architect
omp plugin marketplace remove omp-architect  # optional: unregister the local catalog
```

These remove the plugin registration/link and catalog cache, not the checkout.

Merge [examples/config.yml](../examples/config.yml) into `~/.omp/agent/config.yml`, replacing the example provider/model selectors with models you can use. Find selectors with `omp models find <name>` and authenticate using `/login`. For one launch from the checkout directory, pass the **package directory**, so OMP also discovers its `agents/`:

```bash
omp --model @implementation --extension "$PWD"
```

The linked installation already loads persistently; the explicit `--extension`
command above is an alternative one-launch setup. For a manual persistent setup,
you can instead add `/absolute/path/to/omp-architect` to your existing `extensions`
array. Keep other entries: arrays replace lower-priority arrays. Avoid configuring
both installation routes for the same checkout. An installed OMP plugin package
also discovers sibling `agents/`; no separate copy step is required. npm
publication is not required or performed by this project.

Next: [configure model roles and reviews](architect.md). Return to the [README](../README.md).

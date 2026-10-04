# Installation and plugin management

Install Bun and OMP using their official installation instructions, then:

```bash
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

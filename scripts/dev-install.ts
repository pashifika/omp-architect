#!/usr/bin/env bun
/** Checkout installation only. Native OMP owns every registry write. */
import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const NAME = "omp-architect";
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const help = `Usage: bun run dev:install [--dry-run] [--no-marketplace]

Link this checkout and register its local marketplace catalog using pinned OMP.
--dry-run         Check ownership and show the plan without running OMP or changing its files
--no-marketplace  Only link the checkout
--help            Show this help

Uses OMP's active profile, PI_CONFIG_DIR and XDG paths. Does not edit config.yml,
model roles, credentials or mcp.json. This extension has no MCP server to wire.
Existing installs/catalogs from elsewhere are never replaced. Stop other plugin
management commands while installing; OMP does not share a transaction lock.`;

type Mapping = Record<string, unknown>;
function mapping(value: unknown, context: string): Mapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object; no files changed by this check`);
  }
  return value as Mapping;
}

async function json(file: string): Promise<Mapping | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Not a regular file");
    return mapping(JSON.parse(await readFile(file, "utf8")), file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // Do not include parse errors containing arbitrary configuration values.
    throw new Error(`Cannot safely read ${file}; repair this JSON file before installing`);
  }
}

async function stat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function objectField(doc: Mapping, key: string, context: string): Mapping {
  return doc[key] === undefined ? {} : mapping(doc[key], `${context}: ${key}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (!["--dry-run", "--no-marketplace", "--help"].includes(arg)) {
      throw new Error(`Unknown option ${arg}\n${help}`);
    }
  }
  if (args.includes("--help")) {
    console.log(help);
    return;
  }
  const dryRun = args.includes("--dry-run");
  const marketplace = !args.includes("--no-marketplace");
  const checkout = await realpath(root);
  // Match OMP's bootstrap: select the profile before loading its .env files.
  // All path getters used below are read-only (unlike getMarketplacesRegistryPath,
  // which can copy a legacy registry just by being called).
  process.chdir(checkout);
  // Child CLI processes must replay the same one-pass dotenv bootstrap. Passing
  // env's mutations would make them read a second, unchecked config/agent .env.
  const launchEnv = { ...process.env };
  const dirs = await import("@oh-my-pi/pi-utils/dirs");
  dirs.setProfile(dirs.resolveProfileEnv(process.env.OMP_PROFILE, process.env.PI_PROFILE));
  await import("@oh-my-pi/pi-utils/env");
  const plugins = dirs.getPluginsDir();
  const lockPath = dirs.getPluginsLockfile();
  const link = path.join(dirs.getPluginsNodeModules(), NAME);
  const registryPath = path.join(path.dirname(plugins), "marketplaces.json");
  const catalogCache = path.join(plugins, "cache", "marketplaces", NAME, "marketplace.json");
  // Do not let OMP's recursive destination replacement or cache writes traverse
  // an unexpected redirect inside its managed storage. A symlinked HOME/config
  // root itself is fine; OMP explicitly chose that root.
  for (const directory of [
    plugins,
    path.join(plugins, "node_modules"),
    ...(marketplace
      ? [
          path.join(plugins, "cache"),
          path.join(plugins, "cache", "marketplaces"),
          path.dirname(catalogCache),
        ]
      : []),
  ]) {
    const info = await stat(directory);
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error(
        `${directory}: expected an ordinary OMP storage directory; refusing to follow or replace it`,
      );
    }
  }
  const samePath = (a: string, b: string) =>
    dirs.normalizePathForComparison(a) === dirs.normalizePathForComparison(b);

  const manifest = await json(path.join(checkout, "package.json"));
  if (manifest?.name !== NAME || typeof manifest.version !== "string") {
    throw new Error("This is not an omp-architect checkout");
  }
  const extension = mapping(manifest.omp, "package.json: omp");
  if (JSON.stringify(extension.extensions) !== JSON.stringify(["./index.ts"])) {
    throw new Error("Unexpected extension entries; review dev:install for this manifest");
  }
  await readFile(path.join(checkout, "index.ts"));
  const hostEntry = import.meta.resolve("@oh-my-pi/pi-coding-agent");
  const expectedHost = mapping(manifest.peerDependencies, "package.json: peerDependencies")[
    "@oh-my-pi/pi-coding-agent"
  ];
  const host = await json(fileURLToPath(new URL("../package.json", hostEntry)));
  if (host?.version !== expectedHost || dirs.VERSION !== expectedHost) {
    throw new Error(
      "Installed OMP dependencies differ from this checkout's pin; run bun install --frozen-lockfile first",
    );
  }

  const lock = (await json(lockPath)) ?? {};
  // OMP normalizes this file down to plugins/settings. Reject unknown top-level
  // fields rather than letting that normalization silently discard user data.
  if (Object.keys(lock).some((key) => !["plugins", "settings"].includes(key))) {
    throw new Error(`${lockPath}: unsupported runtime registry fields; refusing to rewrite it`);
  }
  const states = objectField(lock, "plugins", lockPath);
  const settings = objectField(lock, "settings", lockPath);
  for (const [name, value] of Object.entries(states)) {
    const state = mapping(value, `${lockPath}: ${name}`);
    if (
      typeof state.version !== "string" ||
      typeof state.enabled !== "boolean" ||
      (state.enabledFeatures !== null &&
        (!Array.isArray(state.enabledFeatures) ||
          !state.enabledFeatures.every((feature) => typeof feature === "string")))
    ) {
      throw new Error(`${lockPath}: invalid plugin state for ${name}`);
    }
  }
  for (const [name, value] of Object.entries(settings)) mapping(value, `${lockPath}: ${name}`);
  const packagePath = dirs.getPluginsPackageJson();
  const dependencies = objectField((await json(packagePath)) ?? {}, "dependencies", packagePath);
  if (Object.values(dependencies).some((value) => typeof value !== "string")) {
    throw new Error(`${packagePath}: invalid dependencies`);
  }
  if (Object.hasOwn(dependencies, NAME)) {
    throw new Error(`${NAME} is installed as a package; uninstall it with OMP before linking`);
  }

  // List output omits broken installs and marketplace entries use a different
  // shape. Inspect the registries themselves, including the active project scope.
  const { resolveActiveProjectRegistryPath } = await import(
    "@oh-my-pi/pi-coding-agent/discovery/helpers"
  );
  const projectRegistry = await resolveActiveProjectRegistryPath(checkout);
  for (const file of new Set([
    path.join(plugins, "installed_plugins.json"),
    ...(projectRegistry ? [projectRegistry] : []),
  ])) {
    const registry = await json(file);
    if (!registry) continue;
    if (typeof registry.version !== "number" || registry.plugins === undefined) {
      throw new Error(`${file}: invalid installed plugin registry`);
    }
    const installed = mapping(registry.plugins, file);
    for (const [id, entries] of Object.entries(installed)) {
      if (!Array.isArray(entries)) throw new Error(`${file}: invalid entries for ${id}`);
      for (const entry of entries) {
        const record = mapping(entry, `${file}: ${id}`);
        if (typeof record.installPath !== "string") {
          throw new Error(`${file}: missing installPath for ${id}`);
        }
      }
      if (id.split("@")[0].toLowerCase() === NAME && entries.length) {
        throw new Error(`${NAME} is installed from marketplace ${id}; uninstall it with OMP first`);
      }
    }
  }

  const existing = await stat(link);
  const linkedHere = existing?.isSymbolicLink() && samePath(link, checkout);
  if (existing && !linkedHere) {
    throw new Error(
      `${link} already exists and is not a link to this checkout; refusing to replace it`,
    );
  }
  const registered = Object.hasOwn(states, NAME);
  if (registered && !linkedHere) {
    throw new Error(
      `${NAME} has a stale registration in ${lockPath}; repair or uninstall it with OMP first`,
    );
  }
  const linkNeeded = !linkedHere || !registered;

  let catalogNeeded = false;
  let catalogUpdate = false;
  let expectedCatalog: unknown;
  if (marketplace) {
    const catalog = await json(path.join(checkout, ".omp-plugin", "marketplace.json"));
    if (
      catalog?.name !== NAME ||
      !Array.isArray(catalog.plugins) ||
      catalog.plugins.length !== 1 ||
      mapping(catalog.plugins[0], "catalog plugin").name !== NAME ||
      mapping(catalog.plugins[0], "catalog plugin").version !== manifest.version
    ) {
      throw new Error("Marketplace catalog does not match package.json");
    }
    const owner = mapping(catalog.owner, "catalog owner");
    const source = mapping(mapping(catalog.plugins[0], "catalog plugin").source, "catalog source");
    if (
      typeof owner.name !== "string" ||
      !owner.name ||
      source.source !== "github" ||
      source.repo !== "pashifika/omp-architect"
    ) {
      throw new Error("Marketplace must describe this repository's GitHub plugin source");
    }
    // Native catalog parsing warns to disk and skips invalid entries. Validate
    // this package's one known entry without invoking it during a dry run.
    expectedCatalog = catalog;
    const legacy = path.join(dirs.getConfigRootDir(), "marketplaces.json");
    if (!samePath(legacy, registryPath) && !(await stat(registryPath)) && (await stat(legacy))) {
      throw new Error(
        "OMP has an unmigrated marketplace registry; run `omp plugin marketplace list` first, then retry",
      );
    }
    if (await stat(`${registryPath}.tmp`)) {
      throw new Error(
        `${registryPath}.tmp already exists; resolve the pending OMP write before installing`,
      );
    }
    const registry = await json(registryPath);
    if (registry && (registry.version !== 1 || !Array.isArray(registry.marketplaces))) {
      throw new Error(`${registryPath}: invalid marketplace registry`);
    }
    const entries = (registry?.marketplaces ?? []) as unknown[];
    let ownCatalog = false;
    for (const value of entries) {
      const entry = mapping(value, registryPath);
      if (
        typeof entry.name !== "string" ||
        typeof entry.sourceUri !== "string" ||
        typeof entry.catalogPath !== "string" ||
        !["local", "github", "git", "url"].includes(String(entry.sourceType))
      ) {
        throw new Error(`${registryPath}: invalid marketplace entry`);
      }
      if (entry.name.toLowerCase() !== NAME) continue;
      if (
        ownCatalog ||
        entry.name !== NAME ||
        entry.sourceType !== "local" ||
        !samePath(entry.sourceUri, checkout)
      ) {
        throw new Error(
          `Marketplace ${NAME} already belongs to another source; keep it or remove it with OMP first`,
        );
      }
      if (
        !samePath(entry.catalogPath, catalogCache) ||
        (await stat(entry.catalogPath))?.isSymbolicLink()
      ) {
        throw new Error(
          `Marketplace ${NAME} cache is outside its expected location; refusing to write it`,
        );
      }
      const cached = await json(entry.catalogPath);
      if (cached?.name !== NAME) {
        throw new Error(
          `Marketplace ${NAME} has a missing/invalid cache; run omp plugin marketplace update ${NAME}`,
        );
      }
      catalogUpdate = !isDeepStrictEqual(cached, expectedCatalog);
      ownCatalog = true;
    }
    catalogNeeded = !ownCatalog;
    if (catalogNeeded && (await stat(path.dirname(catalogCache)))) {
      throw new Error(
        `${path.dirname(catalogCache)} exists without an owned catalog registration; refusing to overwrite it`,
      );
    }
  }

  console.log(`Development install: ${NAME}\n  checkout: ${checkout}\n  plugins: ${plugins}`);
  console.log(`  catalog: ${marketplace ? registryPath : "skipped (--no-marketplace)"}`);
  console.log(
    "  build: not needed (OMP loads TypeScript)\n  MCP: not applicable (no server in this package)",
  );
  // Run the host pinned by this checkout, not whichever unrelated omp happens to
  // be on PATH. Argument vectors and fileURLToPath support spaces/Unicode/Windows.
  const cli = fileURLToPath(new URL("../dist/cli.js", hostEntry));
  const run = (args: string[]) => {
    console.log(
      `  ${dryRun ? "would run" : "running"}: omp --profile ${JSON.stringify(dirs.getActiveProfile() ?? "default")} plugin ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
    );
    if (dryRun) return;
    const result = spawnSync(
      process.execPath,
      ["--no-env-file", cli, "--profile", dirs.getActiveProfile() ?? "default", "plugin", ...args],
      {
        cwd: checkout,
        env: launchEnv,
        encoding: "utf8",
        shell: false,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    if (result.error || result.status !== 0) {
      throw new Error(
        `OMP ${args[0]} failed (${result.error?.message ?? result.status}); rerun after fixing the cause\n${result.stderr}`,
      );
    }
    if (result.stdout.trim()) console.log(result.stdout.trim());
  };
  if (linkNeeded) run(["link", checkout]);
  else
    console.log("  checkout already linked; keeping enabled state, feature selection and settings");
  if (catalogNeeded) run(["marketplace", "add", checkout]);
  else if (catalogUpdate) run(["marketplace", "update", NAME]);
  else if (marketplace) console.log("  checkout catalog already registered and current");
  if (!dryRun) {
    if (!(await stat(link))?.isSymbolicLink() || !samePath(link, checkout)) {
      throw new Error("OMP reported success but the checkout link could not be verified");
    }
    const written = objectField((await json(lockPath)) ?? {}, "plugins", lockPath);
    if (!Object.hasOwn(written, NAME))
      throw new Error("OMP reported success but registration is missing");
    if (marketplace) {
      const registry = await json(registryPath);
      if (
        !Array.isArray(registry?.marketplaces) ||
        !registry.marketplaces.some(
          (entry: Mapping) =>
            entry.name === NAME &&
            entry.sourceType === "local" &&
            typeof entry.sourceUri === "string" &&
            samePath(entry.sourceUri, checkout),
        )
      ) {
        throw new Error("OMP reported success but the catalog registration could not be verified");
      }
      if (!isDeepStrictEqual(await json(catalogCache), expectedCatalog)) {
        throw new Error("OMP reported success but the cached catalog does not match this checkout");
      }
    }
  }
  console.log(
    dryRun
      ? "Dry run complete; no installation changes made."
      : "Verified. Restart OMP; configure your model roles separately (see README).",
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`dev-install: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

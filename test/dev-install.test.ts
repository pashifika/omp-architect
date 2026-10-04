import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const name = "omp-architect";
const fixtures: string[] = [];
const directoryLink = process.platform === "win32" ? "junction" : "dir";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Json = Record<string, any>;

async function put(file: string, content: string | Json) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`,
  );
}

async function readJson(file: string): Promise<Json> {
  return JSON.parse(await readFile(file, "utf8"));
}

// Never inherit the developer's HOME, profile, dotenv, credentials, or XDG paths.
// Copy the checkout instead of executing in the real repository: OMP explicitly
// reads project .env and project registries even with Bun's --no-env-file flag.
async function fixture(
  options: {
    profile?: string;
    piProfile?: string;
    configDir?: string;
    xdg?: boolean;
    customAgent?: boolean;
  } = {},
) {
  const base = await mkdtemp(path.join(tmpdir(), "omp-dev-install-test-"));
  fixtures.push(base);
  const home = path.join(base, "home");
  const checkout = path.join(base, "checkout with spaces 日本語");
  const scratch = path.join(base, "tmp");
  const xdg = Object.fromEntries(
    ["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((kind) => [
      `XDG_${kind}_${kind === "RUNTIME" ? "DIR" : "HOME"}`,
      path.join(base, `xdg-${kind.toLowerCase()}`),
    ]),
  );
  await Promise.all([home, checkout, scratch, ...Object.values(xdg)].map((dir) => mkdir(dir)));
  for (const file of [
    "package.json",
    "index.ts",
    "scripts/dev-install.ts",
    ".omp-plugin/marketplace.json",
  ]) {
    const target = path.join(checkout, file);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(repository, file), target);
  }
  // The native host and source dependencies are real, installed repository deps.
  await symlink(
    path.join(repository, "node_modules"),
    path.join(checkout, "node_modules"),
    directoryLink,
  );
  await cp(path.join(repository, "src"), path.join(checkout, "src"), { recursive: true });
  await cp(path.join(repository, "agents"), path.join(checkout, "agents"), { recursive: true });
  await mkdir(path.join(checkout, ".git")); // Confine OMP's project-root search to the fixture.

  const profile = options.profile !== undefined ? options.profile || undefined : options.piProfile;
  const configRoot = path.join(
    home,
    options.configDir || ".omp",
    ...(profile ? ["profiles", profile] : []),
  );
  const customAgent = path.join(base, "custom agent");
  if (options.customAgent) await mkdir(customAgent);
  if (options.xdg) {
    for (const kind of ["DATA", "STATE", "CACHE"]) {
      await mkdir(
        path.join(xdg[`XDG_${kind}_HOME`]!, "omp", ...(profile ? ["profiles", profile] : [])),
        {
          recursive: true,
        },
      );
    }
  }
  const root =
    options.xdg && !options.customAgent && process.platform !== "win32"
      ? path.join(xdg.XDG_DATA_HOME!, "omp", ...(profile ? ["profiles", profile] : []))
      : configRoot;
  const env: NodeJS.ProcessEnv = {
    PATH: [
      path.dirname(process.execPath),
      ...(process.platform === "win32"
        ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32")]
        : ["/usr/bin", "/bin"]),
    ].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    ...xdg,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    PI_CONFIG_DIR: options.configDir ?? "",
    PI_CODING_AGENT_DIR: options.customAgent ? customAgent : "",
    OMP_PROFILE: options.profile ?? "",
    PI_PROFILE: options.piProfile ?? "",
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    BUN_INSTALL: path.join(base, "bun"),
    BUN_INSTALL_CACHE_DIR: path.join(base, "bun-cache"),
    NODE_ENV: "test",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (options.piProfile && options.profile === undefined) delete env.OMP_PROFILE;
  // Windows needs OS discovery variables, but never arbitrary caller env values.
  for (const key of ["SystemRoot", "WINDIR", "ComSpec"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const plugins = path.join(root, "plugins");
  return {
    base,
    home,
    checkout,
    root,
    configRoot,
    plugins,
    env,
    customAgent,
    agent: options.customAgent && !profile ? customAgent : path.join(configRoot, "agent"),
    link: path.join(plugins, "node_modules", name),
    lock: path.join(plugins, "omp-plugins.lock.json"),
    package: path.join(plugins, "package.json"),
    installed: path.join(plugins, "installed_plugins.json"),
    marketplaces: path.join(root, "marketplaces.json"),
    projectInstalled: path.join(
      checkout,
      options.configDir || ".omp",
      "plugins",
      "installed_plugins.json",
    ),
  };
}

function install(f: Fixture, ...args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--no-env-file", path.join(f.checkout, "scripts/dev-install.ts"), ...args],
    {
      cwd: f.base,
      env: f.env,
      encoding: "utf8",
      timeout: 25_000,
      maxBuffer: 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}

function succeeded(result: ReturnType<typeof install>) {
  expect(result.output).not.toContain("dev-install:");
  expect(result.status).toBe(0);
}

async function absent(file: string) {
  expect(
    await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    }),
  ).toBeUndefined();
}

// Includes file bytes, directory names, and link targets; never follows links.
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(dir: string) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = path.join(dir, entry.name);
      const key = path.relative(root, file);
      if (entry.isSymbolicLink()) result[key] = `link:${await readlink(file)}`;
      else if (entry.isDirectory()) {
        result[key] = "directory";
        await visit(file);
      } else result[key] = (await readFile(file)).toString("base64");
    }
  }
  await visit(root);
  return result;
}

async function rejectedWithoutWrites(f: Fixture, pattern: RegExp, ...args: string[]) {
  const before = await snapshot(f.base);
  const result = install(f, ...args);
  expect(result.status).toBe(1);
  expect(result.output).toMatch(pattern);
  expect(result.output).not.toContain("running: omp");
  expect(result.output).not.toContain("secret-not-for-errors");
  expect(await snapshot(f.base)).toEqual(before);
}

function pluginState(enabled = true) {
  return { version: "0.1.0", enabled, enabledFeatures: null };
}

function catalogEntry(f: Fixture, overrides: Json = {}) {
  return {
    name,
    sourceType: "local",
    sourceUri: f.checkout,
    catalogPath: path.join(f.plugins, "cache", "marketplaces", name, "marketplace.json"),
    addedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function sentinels(f: Fixture) {
  const files = [
    path.join(f.agent, "config.yml"),
    path.join(f.agent, "mcp.json"),
    path.join(f.agent, "AGENTS.md"),
    path.join(f.agent, "RULES.md"),
    path.join(f.checkout, "AGENTS.md"),
    path.join(f.checkout, "RULES.md"),
  ];
  for (const file of files) {
    const content = file.endsWith("config.yml")
      ? "# user configuration\nmodels:\n  default: keep-me\n"
      : file.endsWith("mcp.json")
        ? '{ "mcpServers": {} }\n'
        : `Preserve ${path.basename(file)} byte-for-byte.\r\n日本語\n`;
    await put(file, content);
  }
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")])),
  );
}

async function unchanged(files: Record<string, string>) {
  for (const [file, content] of Object.entries(files))
    expect(await readFile(file, "utf8")).toBe(content);
}

afterEach(async () => {
  for (const base of fixtures.splice(0)) await rm(base, { recursive: true, force: true });
});

describe("development installer against the installed native OMP host", () => {
  test("fresh install links the checkout, registers runtime state, and caches the local catalog", async () => {
    const f = await fixture();
    const protectedFiles = await sentinels(f);
    succeeded(install(f));
    expect((await lstat(f.link)).isSymbolicLink()).toBe(true);
    expect(await realpath(f.link)).toBe(await realpath(f.checkout));
    expect((await readJson(f.lock)).plugins[name]).toEqual(pluginState());
    const registry = await readJson(f.marketplaces);
    expect(registry.version).toBe(1);
    expect(registry.marketplaces).toHaveLength(1);
    const entry = registry.marketplaces[0];
    expect(entry.name).toBe(name);
    expect(entry.sourceType).toBe("local");
    expect(await realpath(entry.sourceUri)).toBe(await realpath(f.checkout));
    expect(await readJson(entry.catalogPath)).toEqual(
      await readJson(path.join(f.checkout, ".omp-plugin/marketplace.json")),
    );
    await unchanged(protectedFiles);
    await absent(path.join(f.agent, "plugins"));
  }, 30_000);

  test("fresh native writes preserve unrelated plugin settings, dependencies, catalog, and files", async () => {
    const f = await fixture();
    const protectedFiles = await sentinels(f);
    const state = { version: "2.3.4", enabled: false, enabledFeatures: ["retained-feature"] };
    const settings = { nested: { value: "keep" } };
    await put(f.lock, {
      plugins: { "unrelated-plugin": state },
      settings: { "unrelated-plugin": settings },
    });
    const pkg = {
      name: "user-plugin-project",
      private: true,
      dependencies: { "unrelated-plugin": "2.3.4" },
      custom: "keep",
    };
    await put(f.package, pkg);
    const packageBytes = await readFile(f.package, "utf8");
    const unrelatedFile = path.join(f.plugins, "node_modules", "unrelated-plugin", "owned.txt");
    await put(unrelatedFile, "Keep this plugin directory\n");
    const entry = catalogEntry(f, {
      name: "other-catalog",
      sourceUri: path.join(f.base, "other-source"),
      catalogPath: path.join(
        f.plugins,
        "cache",
        "marketplaces",
        "other-catalog",
        "marketplace.json",
      ),
    });
    const otherCatalog = { name: "other-catalog", owner: { name: "Other" }, plugins: [] };
    await put(entry.catalogPath, otherCatalog);
    await put(f.marketplaces, { version: 1, marketplaces: [entry] });
    succeeded(install(f));
    const lock = await readJson(f.lock);
    expect(lock.plugins["unrelated-plugin"]).toEqual(state);
    expect(lock.settings["unrelated-plugin"]).toEqual(settings);
    expect(lock.plugins[name]).toEqual(pluginState());
    expect(await readFile(f.package, "utf8")).toBe(packageBytes);
    expect(await readFile(unrelatedFile, "utf8")).toBe("Keep this plugin directory\n");
    const registry = await readJson(f.marketplaces);
    expect(registry.marketplaces).toHaveLength(2);
    expect(registry.marketplaces.find((item: Json) => item.name === "other-catalog")).toEqual(
      entry,
    );
    expect(await readJson(entry.catalogPath)).toEqual(otherCatalog);
    await unchanged(protectedFiles);
  }, 30_000);

  test("rerun preserves disabled state, features, settings, unrelated plugins/catalogs, and user files", async () => {
    const f = await fixture();
    const protectedFiles = await sentinels(f);
    succeeded(install(f));
    const lock = await readJson(f.lock);
    lock.plugins[name] = { ...pluginState(false), enabledFeatures: ["./index.ts"] };
    lock.plugins["other-plugin"] = {
      version: "9.8.7",
      enabled: false,
      enabledFeatures: ["other-feature"],
    };
    lock.settings = {
      [name]: { role: "unchanged", nested: { enabled: false } },
      "other-plugin": { answer: 42 },
    };
    await put(f.lock, lock);
    const pkg: Json = { name: "omp-user-plugins", private: true };
    pkg.dependencies = { "other-plugin": "9.8.7" };
    await put(f.package, pkg);
    const registry = await readJson(f.marketplaces);
    registry.marketplaces.push(
      catalogEntry(f, {
        name: "other-catalog",
        sourceUri: path.join(f.base, "other-source"),
        catalogPath: path.join(
          f.plugins,
          "cache",
          "marketplaces",
          "other-catalog",
          "marketplace.json",
        ),
      }),
    );
    await put(f.marketplaces, registry);
    const before = await snapshot(f.base);
    const result = install(f);
    succeeded(result);
    expect(result.output).toContain("already linked");
    expect(result.output).not.toContain("running: omp");
    expect(await snapshot(f.base)).toEqual(before);
    await unchanged(protectedFiles);
  }, 30_000);

  test.each([
    { label: "dry run", args: ["--dry-run"] },
    { label: "dry run without marketplace", args: ["--dry-run", "--no-marketplace"] },
    { label: "help", args: ["--help"] },
  ])("$label writes nothing", async ({ args }) => {
    const f = await fixture();
    const before = await snapshot(f.base);
    const result = install(f, ...args);
    succeeded(result);
    expect(await snapshot(f.base)).toEqual(before);
    await absent(f.link);
  });

  test.each([
    "--force",
    "--dryrun",
    "unexpected",
    "--profile=work",
  ])("rejects unknown argument %s before writing", async (arg) => {
    const f = await fixture();
    await rejectedWithoutWrites(f, /Unknown option/, arg);
  });

  test("help does not parse or repair existing malformed configuration", async () => {
    const f = await fixture();
    await put(f.lock, "malformed");
    const before = await snapshot(f.base);
    succeeded(install(f, "--help"));
    expect(await snapshot(f.base)).toEqual(before);
  });

  test.each([
    "dangling symlink",
    "other checkout symlink",
    "real directory",
  ])("rejects a conflicting %s", async (kind) => {
    const f = await fixture();
    await mkdir(path.dirname(f.link), { recursive: true });
    if (kind === "real directory")
      await put(path.join(f.link, "owned.txt"), "Do not delete this package");
    else {
      const target = path.join(f.base, "different checkout");
      if (kind === "other checkout symlink") await mkdir(target);
      await symlink(target, f.link, directoryLink);
    }
    await rejectedWithoutWrites(f, /already exists.*not a link to this checkout/);
  });

  test("rejects npm dependency ownership even without an installed directory", async () => {
    const f = await fixture();
    await put(f.package, { dependencies: { [name]: "^0.1.0" } });
    await rejectedWithoutWrites(f, /installed as a package/);
    await absent(f.link);
  });

  test("rejects a stale runtime registration before linking", async () => {
    const f = await fixture();
    await put(f.lock, { plugins: { [name]: pluginState() }, settings: {} });
    await rejectedWithoutWrites(f, /stale registration/);
    await absent(f.link);
  });

  test.each([
    "user",
    "project",
  ])("rejects stale %s marketplace ownership before linking", async (scope) => {
    const f = await fixture();
    await put(scope === "user" ? f.installed : f.projectInstalled, {
      version: 2,
      plugins: {
        [`${name}@old-catalog`]: [{ installPath: path.join(f.base, "missing-old-install"), scope }],
      },
    });
    await rejectedWithoutWrites(f, /installed from marketplace/);
    await absent(f.link);
  });

  const invalidCases: Array<[string, keyof Fixture, string | Json]> = [
    ["malformed runtime JSON", "lock", "{ secret-not-for-errors"],
    ["non-object runtime JSON", "lock", "[]"],
    ["unsupported runtime field", "lock", { plugins: {}, settings: {}, custom: "keep" }],
    ["non-object plugin states", "lock", { plugins: [], settings: {} }],
    ["non-object individual state", "lock", { plugins: { unrelated: [] } }],
    [
      "invalid enabled value",
      "lock",
      { plugins: { unrelated: { ...pluginState(), enabled: "false" } } },
    ],
    [
      "invalid feature selection",
      "lock",
      { plugins: { unrelated: { ...pluginState(), enabledFeatures: [42] } } },
    ],
    ["invalid settings map", "lock", { plugins: {}, settings: [] }],
    ["invalid nested settings", "lock", { plugins: {}, settings: { unrelated: null } }],
    ["malformed package JSON", "package", "{"],
    ["invalid dependencies", "package", { dependencies: [] }],
    ["invalid dependency value", "package", { dependencies: { unrelated: {} } }],
    ["malformed installed registry", "installed", "{"],
    ["invalid installed entries", "installed", { version: 2, plugins: { "other@catalog": {} } }],
    ["missing installed path", "installed", { version: 2, plugins: { "other@catalog": [{}] } }],
    ["malformed marketplace JSON", "marketplaces", "{"],
    ["invalid marketplace version", "marketplaces", { version: 2, marketplaces: [] }],
    ["invalid marketplace list", "marketplaces", { version: 1, marketplaces: {} }],
    [
      "invalid marketplace entry",
      "marketplaces",
      { version: 1, marketplaces: [{ name: "other" }] },
    ],
  ];
  test.each(
    invalidCases,
  )("rejects %s before linking or normalizing anything", async (_label, key, content) => {
    const f = await fixture();
    await put(String(f[key]), content);
    await rejectedWithoutWrites(
      f,
      /Cannot safely read|expected a JSON object|unsupported runtime|invalid |missing installPath/,
    );
    await absent(f.link);
  });

  test.each([
    "foreign source",
    "case collision",
    "missing cache",
    "duplicate owner",
  ])("rejects catalog %s before linking", async (kind) => {
    const f = await fixture();
    const entry = catalogEntry(
      f,
      kind === "foreign source"
        ? { sourceUri: path.join(f.base, "another-source") }
        : kind === "case collision"
          ? { name: "OMP-ARCHITECT" }
          : {},
    );
    if (kind === "duplicate owner")
      await put(
        entry.catalogPath,
        await readJson(path.join(f.checkout, ".omp-plugin/marketplace.json")),
      );
    await put(f.marketplaces, {
      version: 1,
      marketplaces: kind === "duplicate owner" ? [entry, entry] : [entry],
    });
    await rejectedWithoutWrites(
      f,
      /another source|missing\/invalid cache|invalid cache|already belongs/,
    );
    await absent(f.link);
  });

  test("--no-marketplace ignores malformed catalog, registry, and cache without modifying them", async () => {
    const f = await fixture();
    const catalog = path.join(f.checkout, ".omp-plugin/marketplace.json");
    await put(catalog, "not JSON");
    await put(f.marketplaces, "also not JSON");
    const cache = path.join(f.plugins, "cache", "marketplaces", name, "marketplace.json");
    await put(cache, "not a catalog");
    succeeded(install(f, "--no-marketplace"));
    expect(await realpath(f.link)).toBe(await realpath(f.checkout));
    expect((await readJson(f.lock)).plugins[name]).toEqual(pluginState());
    expect(await readFile(catalog, "utf8")).toBe("not JSON");
    expect(await readFile(f.marketplaces, "utf8")).toBe("also not JSON");
    expect(await readFile(cache, "utf8")).toBe("not a catalog");
  }, 30_000);

  test.each([
    ["OMP profile", { profile: "development" }],
    ["PI profile fallback", { piProfile: "fallback" }],
    ["OMP profile precedence", { profile: "selected", piProfile: "ignored" }],
    ["explicit empty OMP profile precedence", { profile: "", piProfile: "ignored" }],
    ["custom PI_CONFIG_DIR", { configDir: ".custom omp" }],
    ["migrated XDG roots", { xdg: true }],
    ["migrated XDG profile", { xdg: true, profile: "development" }],
    ["custom agent directory", { customAgent: true }],
  ] satisfies Array<[string, Parameters<typeof fixture>[0]]>)(
    "respects %s for native host and installer",
    async (_label, options) => {
      const f = await fixture(options);
      const protectedFiles = await sentinels(f);
      const result = install(f);
      succeeded(result);
      expect(await realpath(f.link)).toBe(await realpath(f.checkout));
      expect((await readJson(f.lock)).plugins[name]).toEqual(pluginState());
      expect((await readJson(f.marketplaces)).marketplaces[0].name).toBe(name);
      await unchanged(protectedFiles);
      await absent(path.join(f.agent, "plugins"));
      if (f.root !== path.join(f.home, ".omp")) await absent(path.join(f.home, ".omp", "plugins"));
    },
    30_000,
  );

  test("unmigrated XDG marketplace registry is refused without triggering native migration", async () => {
    const f = await fixture({ xdg: true });
    if (process.platform === "win32") return;
    await put(path.join(f.configRoot, "marketplaces.json"), { version: 1, marketplaces: [] });
    await rejectedWithoutWrites(f, /unmigrated marketplace registry/);
    await absent(f.marketplaces);
    await absent(f.link);
  });

  test("native OMP lists the installed plugin and discovers its extension and package agents", async () => {
    const f = await fixture();
    succeeded(install(f));
    const cli = fileURLToPath(
      new URL("../dist/cli.js", import.meta.resolve("@oh-my-pi/pi-coding-agent")),
    );
    const listed = spawnSync(
      process.execPath,
      ["--no-env-file", cli, "--profile", "default", "plugin", "list", "--json"],
      {
        cwd: f.checkout,
        env: f.env,
        encoding: "utf8",
        timeout: 25_000,
      },
    );
    expect(listed.error).toBeUndefined();
    expect(listed.stderr).toBe("");
    expect(listed.status).toBe(0);
    const plugins = JSON.parse(listed.stdout);
    expect(
      plugins.npm.some((plugin: Json) => plugin.name === name && plugin.enabled === true),
    ).toBe(true);
    const probe = path.join(f.checkout, "discovery-probe.ts");
    await put(
      probe,
      `
      const dirs = await import("@oh-my-pi/pi-utils/dirs");
      dirs.setProfile(undefined);
      await import("@oh-my-pi/pi-utils/env");
      const { getAllPluginExtensionPaths } = await import("@oh-my-pi/pi-coding-agent/extensibility/plugins/loader");
      const { discoverAgents } = await import("@oh-my-pi/pi-coding-agent/task/discovery");
      const extensions = await getAllPluginExtensionPaths(process.cwd());
      const { agents } = await discoverAgents(process.cwd());
      console.log(JSON.stringify({ extensions, agents: agents.filter(agent => agent.name.startsWith("omp-")) }));
    `,
    );
    const discovered = spawnSync(process.execPath, ["--no-env-file", probe], {
      cwd: f.checkout,
      env: f.env,
      encoding: "utf8",
      timeout: 25_000,
    });
    expect(discovered.error).toBeUndefined();
    expect(discovered.stderr).toBe("");
    expect(discovered.status).toBe(0);
    const result = JSON.parse(discovered.stdout);
    expect(await Promise.all(result.extensions.map((file: string) => realpath(file)))).toContain(
      await realpath(path.join(f.checkout, "index.ts")),
    );
    expect(result.agents.find((agent: Json) => agent.name === "omp-worker")?.model).toEqual([
      "@implementation",
    ]);
    expect(result.agents.find((agent: Json) => agent.name === "omp-explorer")?.model).toEqual([
      "@research",
    ]);
  }, 30_000);

  test.each([
    "home",
    "project",
    "agent",
  ])("dotenv in %s cannot change the already selected native profile", async (location) => {
    const f = await fixture();
    await put(
      path.join(
        location === "home" ? f.home : location === "project" ? f.checkout : f.agent,
        ".env",
      ),
      "OMP_PROFILE=other\nPI_PROFILE=other\n",
    );
    succeeded(install(f));
    expect(await realpath(f.link)).toBe(await realpath(f.checkout));
    expect((await readJson(f.lock)).plugins[name]).toEqual(pluginState());
    await absent(path.join(f.home, ".omp", "profiles", "other", "plugins"));
  }, 30_000);

  test("invalid dotenv profile does not override the validated launch profile", async () => {
    const f = await fixture();
    await put(path.join(f.home, ".env"), "OMP_PROFILE=../../escape\n");
    succeeded(install(f));
    expect(await realpath(f.link)).toBe(await realpath(f.checkout));
  }, 30_000);

  test("owned catalog changes update its native cache without resetting plugin state", async () => {
    const f = await fixture();
    succeeded(install(f));
    const lock = await readJson(f.lock);
    lock.plugins[name] = { ...pluginState(false), enabledFeatures: ["./index.ts"] };
    lock.settings = { [name]: { answer: 42 } };
    await put(f.lock, lock);
    const beforeLock = await readFile(f.lock, "utf8");
    const catalogFile = path.join(f.checkout, ".omp-plugin/marketplace.json");
    const catalog = await readJson(catalogFile);
    catalog.metadata.description = "Updated local checkout description";
    await put(catalogFile, catalog);
    const dryBefore = await snapshot(f.base);
    const dry = install(f, "--dry-run");
    succeeded(dry);
    expect(dry.output).toContain('"marketplace" "update"');
    expect(await snapshot(f.base)).toEqual(dryBefore);
    const result = install(f);
    succeeded(result);
    expect(result.output).toContain('"marketplace" "update"');
    expect(await readFile(f.lock, "utf8")).toBe(beforeLock);
    const entry = (await readJson(f.marketplaces)).marketplaces[0];
    expect(await readJson(entry.catalogPath)).toEqual(catalog);
  }, 30_000);

  test.each([
    "plugins",
    "node_modules",
    "cache",
    "marketplaces",
    "catalog",
  ])("refuses symlinked internal %s storage", async (level) => {
    const f = await fixture();
    const target = path.join(f.base, "redirected storage");
    await mkdir(target);
    await put(path.join(target, "owned.txt"), "untouched");
    const directory =
      level === "plugins"
        ? f.plugins
        : level === "node_modules"
          ? path.join(f.plugins, "node_modules")
          : level === "cache"
            ? path.join(f.plugins, "cache")
            : level === "marketplaces"
              ? path.join(f.plugins, "cache", "marketplaces")
              : path.join(f.plugins, "cache", "marketplaces", name);
    await mkdir(path.dirname(directory), { recursive: true });
    await symlink(target, directory, directoryLink);
    await rejectedWithoutWrites(f, /ordinary OMP storage directory/);
  });

  test.each([
    "lock",
    "package",
    "installed",
    "marketplaces",
  ] as const)("refuses a symlinked %s registry file", async (key) => {
    const f = await fixture();
    const target = path.join(f.base, "external-registry.json");
    await put(
      target,
      key === "marketplaces"
        ? { version: 1, marketplaces: [] }
        : key === "installed"
          ? { version: 2, plugins: {} }
          : {},
    );
    await mkdir(path.dirname(f[key]), { recursive: true });
    try {
      await symlink(target, f[key], "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        throw new Error(
          `The ${key} registry safety test requires Windows file symlink privilege or Developer Mode; the installer itself uses junctions`,
          { cause: error },
        );
      }
      throw error;
    }
    await rejectedWithoutWrites(f, /Cannot safely read/);
  });

  test("refuses a pending marketplace atomic-write temporary file", async () => {
    const f = await fixture();
    await put(`${f.marketplaces}.tmp`, "pending data");
    await rejectedWithoutWrites(f, /pending OMP write/);
    await absent(f.link);
  });

  test("refuses a dangling runtime registry symlink without recreating its target", async () => {
    const f = await fixture();
    const target = path.join(f.base, "missing-registry.json");
    await mkdir(path.dirname(f.lock), { recursive: true });
    try {
      await symlink(target, f.lock, "file");
    } catch (error) {
      if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
        throw new Error(
          "The dangling registry safety test requires Windows file symlink privilege or Developer Mode; the installer itself uses junctions",
          { cause: error },
        );
      }
      throw error;
    }
    await rejectedWithoutWrites(f, /Cannot safely read/);
    await absent(target);
    await absent(f.link);
  });

  test.each([
    "missing source",
    "invalid source",
    "wrong repository",
    "invalid owner",
    "wrong version",
  ])("rejects local catalog %s without native parser warnings or writes", async (kind) => {
    const f = await fixture();
    const file = path.join(f.checkout, ".omp-plugin/marketplace.json");
    const catalog = await readJson(file);
    if (kind === "missing source") delete catalog.plugins[0].source;
    if (kind === "invalid source") catalog.plugins[0].source = { source: "unsupported" };
    if (kind === "wrong repository") catalog.plugins[0].source.repo = "someone/else";
    if (kind === "invalid owner") catalog.owner = [];
    if (kind === "wrong version") catalog.plugins[0].version = "999.0.0";
    await put(file, catalog);
    await rejectedWithoutWrites(
      f,
      /catalog source|catalog owner|GitHub plugin source|does not match package/,
    );
    await absent(f.link);
  });

  test("accepts the minimum OMP peer range for dry run and native installation", async () => {
    const f = await fixture();
    const file = path.join(f.checkout, "package.json");
    const manifest = await readJson(file);
    manifest.peerDependencies["@oh-my-pi/pi-coding-agent"] = ">=18.5.1";
    await put(file, manifest);
    const protectedFiles = await sentinels(f);
    const before = await snapshot(f.base);
    succeeded(install(f, "--dry-run"));
    expect(await snapshot(f.base)).toEqual(before);
    await absent(f.link);
    succeeded(install(f));
    expect(await realpath(f.link)).toBe(await realpath(f.checkout));
    expect((await readJson(f.lock)).plugins[name]).toEqual(pluginState());
    const registry = await readJson(f.marketplaces);
    expect(registry.marketplaces).toHaveLength(1);
    expect(registry.marketplaces[0].name).toBe(name);
    await unchanged(protectedFiles);
  }, 30_000);

  test.each([
    { scenario: "incompatible minimum", range: ">=999.0.0" },
    { scenario: "malformed range", range: "not-a-version" },
    { scenario: "partially malformed range", range: ">=18.5.1 garbage" },
    { scenario: "empty range", range: "" },
    { scenario: "missing range", range: undefined },
    { scenario: "null range", range: null },
    { scenario: "non-string range", range: [">=18.5.1"] },
  ])("rejects $scenario for the OMP host before writes", async ({ range }) => {
    const f = await fixture();
    const file = path.join(f.checkout, "package.json");
    const manifest = await readJson(file);
    manifest.peerDependencies["@oh-my-pi/pi-coding-agent"] = range;
    await put(file, manifest);
    await rejectedWithoutWrites(f, /version|dependencies|range/i);
    await absent(f.link);
  });

  test("one-pass bootstrap does not reread a redirected config dotenv into unchecked XDG storage", async () => {
    const f = await fixture();
    const selectedRoot = path.join(f.home, ".other");
    const uncheckedData = path.join(f.base, "unchecked xdg data");
    await mkdir(path.join(uncheckedData, "omp"), { recursive: true });
    // An inherited XDG value would intentionally win over dotenv, masking the
    // second-pass bug. Empty is still isolated and lets this fixture expose it.
    f.env.XDG_DATA_HOME = "";
    await put(path.join(f.home, ".env"), "PI_CONFIG_DIR=.other\n");
    await put(path.join(selectedRoot, ".env"), `XDG_DATA_HOME=${JSON.stringify(uncheckedData)}\n`);
    const protectedFiles = {
      ...(await sentinels(f)),
      ...(await sentinels({ ...f, agent: path.join(selectedRoot, "agent") })),
    };
    const uncheckedBefore = await snapshot(uncheckedData);
    const before = await snapshot(f.base);
    succeeded(install(f, "--dry-run"));
    expect(await snapshot(f.base)).toEqual(before);
    succeeded(install(f));
    expect(await realpath(path.join(selectedRoot, "plugins", "node_modules", name))).toBe(
      await realpath(f.checkout),
    );
    expect(
      (await readJson(path.join(selectedRoot, "plugins", "omp-plugins.lock.json"))).plugins[name],
    ).toEqual(pluginState());
    expect(
      (await readJson(path.join(selectedRoot, "marketplaces.json"))).marketplaces[0].name,
    ).toBe(name);
    expect(await snapshot(uncheckedData)).toEqual(uncheckedBefore);
    await absent(path.join(uncheckedData, "omp", "plugins"));
    await absent(f.link);
    await unchanged(protectedFiles);
  }, 30_000);

  test("one-pass bootstrap does not reread a redirected agent dotenv into unchecked config storage", async () => {
    const f = await fixture();
    const otherAgent = path.join(f.base, "redirected agent");
    const uncheckedRoot = path.join(f.home, ".other");
    await mkdir(uncheckedRoot, { recursive: true });
    await put(path.join(f.home, ".env"), `PI_CODING_AGENT_DIR=${JSON.stringify(otherAgent)}\n`);
    await put(path.join(otherAgent, ".env"), "PI_CONFIG_DIR=.other\n");
    const protectedFiles = {
      ...(await sentinels(f)),
      ...(await sentinels({ ...f, agent: otherAgent })),
    };
    const uncheckedBefore = await snapshot(uncheckedRoot);
    const before = await snapshot(f.base);
    succeeded(install(f, "--dry-run"));
    expect(await snapshot(f.base)).toEqual(before);
    succeeded(install(f));
    expect(await realpath(f.link)).toBe(await realpath(f.checkout));
    expect((await readJson(f.lock)).plugins[name]).toEqual(pluginState());
    expect((await readJson(f.marketplaces)).marketplaces[0].name).toBe(name);
    expect(await snapshot(uncheckedRoot)).toEqual(uncheckedBefore);
    await absent(path.join(uncheckedRoot, "plugins"));
    await absent(path.join(otherAgent, "plugins"));
    await unchanged(protectedFiles);
  }, 30_000);

  test.each([
    "dry run",
    "configuration refusal",
  ])("%s leaves stale native-cache versions and sentinel bytes untouched", async (mode) => {
    const f = await fixture();
    const stale = path.join(f.home, ".omp", "natives", "1.0.0");
    const sentinel = path.join(stale, "owned-sentinel.bin");
    const content = Buffer.from([0, 1, 2, 127, 128, 254, 255]);
    await mkdir(stale, { recursive: true });
    await writeFile(sentinel, content);
    // Native loader garbage collection removes old version directories during
    // import. A fixed old mtime makes this regression independent of wall time.
    const oldTime = new Date("2000-01-01T00:00:00.000Z");
    await utimes(sentinel, oldTime, oldTime);
    await utimes(stale, oldTime, oldTime);
    const originalMtime = (await lstat(stale)).mtimeMs;
    if (mode === "configuration refusal") {
      await put(f.lock, "{ malformed config");
      await rejectedWithoutWrites(f, /Cannot safely read/);
    } else {
      const before = await snapshot(f.base);
      succeeded(install(f, "--dry-run"));
      expect(await snapshot(f.base)).toEqual(before);
    }
    expect(await readFile(sentinel)).toEqual(content);
    expect((await lstat(stale)).mtimeMs).toBe(originalMtime);
    await absent(f.link);
  });

  test.each([
    { label: "launch environment", launch: true, first: 0, selected: ".from-launch" },
    { label: "project OMP alias", launch: false, first: 0, selected: ".from-project" },
    { label: "agent dotenv", launch: false, first: 1, selected: ".from-agent" },
    { label: "config dotenv", launch: false, first: 2, selected: ".from-config" },
    { label: "home dotenv", launch: false, first: 3, selected: ".from-home" },
  ])("read-only dotenv bootstrap matches native precedence for $label", async ({
    launch,
    first,
    selected,
  }) => {
    const f = await fixture(launch ? { configDir: ".from-launch" } : {});
    const sources = [
      [
        path.join(f.checkout, ".env"),
        "PI_CONFIG_DIR=.wrong-project-alias\nOMP_CONFIG_DIR=.from-project\n",
      ],
      [path.join(f.agent, ".env"), "PI_CONFIG_DIR=.from-agent\n"],
      [path.join(f.configRoot, ".env"), "PI_CONFIG_DIR=.from-config\n"],
      [path.join(f.home, ".env"), "PI_CONFIG_DIR=.from-home\n"],
    ];
    for (const [file, content] of sources.slice(first)) await put(file!, content!);
    const protectedFiles = await sentinels(f);
    const before = await snapshot(f.base);
    const dry = install(f, "--dry-run");
    succeeded(dry);
    const selectedRoot = path.join(f.home, selected);
    expect(dry.output).toContain(path.join(selectedRoot, "plugins"));
    expect(await snapshot(f.base)).toEqual(before);
    succeeded(install(f));
    expect(await realpath(path.join(selectedRoot, "plugins", "node_modules", name))).toBe(
      await realpath(f.checkout),
    );
    expect(
      (await readJson(path.join(selectedRoot, "plugins", "omp-plugins.lock.json"))).plugins[name],
    ).toEqual(pluginState());
    expect(
      (await readJson(path.join(selectedRoot, "marketplaces.json"))).marketplaces[0].name,
    ).toBe(name);
    for (const ignored of [
      ".omp",
      ".from-launch",
      ".wrong-project-alias",
      ".from-project",
      ".from-agent",
      ".from-config",
      ".from-home",
    ]) {
      if (ignored !== selected) await absent(path.join(f.home, ignored, "plugins"));
    }
    await unchanged(protectedFiles);
    for (const [file, content] of sources.slice(first))
      expect(await readFile(file!, "utf8")).toBe(content!);
  }, 30_000);
});

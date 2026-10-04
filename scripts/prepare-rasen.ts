/** Build the user's requested development branch as a pinned, stamped local npm artifact. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SOURCE = "https://github.com/DumoeDss/rasen.git";
const SHA = "f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd";
const VERSION = "0.1.8";
const repo = path.resolve(import.meta.dir, "..");
const stampPath = path.join(repo, "node_modules", ".cache", "omp-architect", "rasen-build.json");
const args = process.argv.slice(2);
let suppliedSource: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--source" && args[i + 1]) suppliedSource = path.resolve(args[++i]);
  else throw new Error("Usage: bun scripts/prepare-rasen.ts [--source <clean-pinned-checkout>]");
}
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-rasen-build-"));
const home = path.join(workspace, "home");
const tooling = path.join(workspace, "tooling");
const source = suppliedSource ?? path.join(workspace, "source");
const artifacts = path.join(workspace, "artifacts");
await fs.mkdir(home, { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_STATE_HOME: path.join(home, "state"),
  npm_config_cache: path.join(workspace, "npm-cache"),
  RASEN_TELEMETRY: "0",
  DO_NOT_TRACK: "1",
  CI: "1",
  NO_COLOR: "1",
};
function run(executable: string, argv: string[], cwd = workspace, quiet = false): string {
  const result = spawnSync(executable, argv, {
    cwd,
    env,
    shell: false,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    // Build logs are public upstream source/build data, never a user's profile.
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(
      `Rasen preparation failed: ${path.basename(executable)} (exit ${result.status})`,
    );
  }
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result.stdout.trim();
}

if (!suppliedSource) {
  await fs.mkdir(source);
  run("git", ["init", "--quiet"], source);
  run("git", ["remote", "add", "origin", SOURCE], source);
  run("git", ["fetch", "--depth", "1", "origin", SHA], source);
  run("git", ["checkout", "--quiet", "--detach", "FETCH_HEAD"], source);
}
if (run("git", ["rev-parse", "HEAD"], source, true) !== SHA)
  throw new Error("Rasen checkout does not match the pinned development commit");
if (run("git", ["status", "--porcelain", "--untracked-files=all"], source, true))
  throw new Error("Rasen checkout has uncommitted files; refusing to pack an ambiguous build");
const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
if (
  manifest.name !== "@atelierai/rasen" ||
  manifest.version !== VERSION ||
  manifest.packageManager !== "pnpm@9.15.9"
)
  throw new Error("Unexpected pinned Rasen package manifest");
const manifestBefore = await fs.readFile(path.join(source, "package.json"));
run("npm", [
  "install",
  "--prefix",
  tooling,
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "pnpm@9.15.9",
]);
env.PATH = `${path.join(tooling, "node_modules", ".bin")}${path.delimiter}${process.env.PATH ?? ""}`;
const pnpm = path.join(tooling, "node_modules", ".bin", "pnpm");
if (run(pnpm, ["--version"], workspace, true) !== "9.15.9")
  throw new Error("Wrong pnpm build tool");
run(
  pnpm,
  [
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--store-dir",
    path.join(workspace, "pnpm-store"),
  ],
  source,
);
const helper = path.join(
  source,
  ".claude",
  "skills",
  "rasen-npm-pack",
  "scripts",
  "pack-dev-local.mjs",
);
run("node", [helper, "--dry-run", "--pack-destination", artifacts], source, true);
run("node", [helper, "--pack-destination", artifacts], source, true);
if (!manifestBefore.equals(await fs.readFile(path.join(source, "package.json"))))
  throw new Error("Rasen packaging unexpectedly changed the manifest");
try {
  await fs.access(path.join(source, "dist", "build-info.json"));
  throw new Error("Rasen packaging left a build stamp in the source checkout");
} catch (error) {
  if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT")
    throw error;
}
const archives = (await fs.readdir(artifacts)).filter((file) => file.endsWith(".tgz"));
if (archives.length !== 1) throw new Error("Expected exactly one new Rasen package artifact");
const archive = path.join(artifacts, archives[0]);
const prefix = path.join(workspace, "installed");
run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", archive]);
const executable = path.join(prefix, "node_modules", ".bin", "rasen");
const version = run(executable, ["--version"], workspace, true);
const buildInfo = JSON.parse(
  await fs.readFile(
    path.join(prefix, "node_modules", "@atelierai", "rasen", "dist", "build-info.json"),
    "utf8",
  ),
);
if (
  buildInfo.channel !== "dev.local" ||
  typeof buildInfo.commit !== "string" ||
  buildInfo.commit.length < 7 ||
  !SHA.startsWith(buildInfo.commit) ||
  version !== `${VERSION} (dev.local ${buildInfo.commit})`
)
  throw new Error("Installed Rasen build stamp does not match the pinned source");
const stamp = {
  source: SOURCE,
  branch: "dev/0.1.8",
  commit: SHA,
  version,
  executable,
  archiveSha256: createHash("sha256")
    .update(await fs.readFile(archive))
    .digest("hex"),
};
await fs.mkdir(path.dirname(stampPath), { recursive: true });
await fs.writeFile(stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`Prepared ${version} from ${SHA}\nRASEN_BIN=${executable}`);
console.log(
  "Saved local smoke-test metadata under node_modules/.cache/omp-architect/rasen-build.json",
);

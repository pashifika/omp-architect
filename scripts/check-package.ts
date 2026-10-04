import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-pack-"));
async function run(cmd: string[], cwd: string) {
  const process = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code) throw new Error(`${cmd.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  return stdout.trim();
}
try {
  const tarball = path.join(temp, "package.tgz");
  await run(
    [process.execPath, "pm", "pack", "--ignore-scripts", "--filename", tarball, "--quiet"],
    root,
  );
  const listing = await run(["tar", "-tzf", tarball], root);
  const files = listing.split("\n");
  for (const file of [
    "index.ts",
    ".omp-plugin/marketplace.json",
    "scripts/dev-install.ts",
    "src/extension.ts",
    "src/reviewer.ts",
    "src/auto/extension.ts",
    "src/auto/core.ts",
    "src/auto/rasen.ts",
    "src/auto/decision.ts",
    "src/auto/fallback.ts",
    "examples/auto.json",
    "examples/auto-config.yml",
    "docs/rasen-auto-verification.md",
    "src/prompts/architect.md",
    "src/prompts/orchestration.md",
    "agents/omp-worker.md",
    "agents/omp-explorer.md",
    "README.md",
    "LICENSE",
  ]) {
    if (!files.includes(`package/${file}`)) throw new Error(`Package is missing ${file}`);
  }
  if (files.some((file) => /\/node_modules\/|\/\.env|\/test\/|\/smoke\//.test(file)))
    throw new Error("Package includes private or development-only files");
  await run(["tar", "-xzf", tarball, "-C", temp], root);
  // Link exactly the locked host dependencies; then load the actual packed artifact.
  // This does not publish anything or claim npm registry installation was exercised.
  await fs.symlink(
    path.join(root, "node_modules"),
    path.join(temp, "package", "node_modules"),
    "dir",
  );
  const check = `import {loadExtensions} from '@oh-my-pi/pi-coding-agent/extensibility/extensions'; const r=await loadExtensions([${JSON.stringify(path.join(temp, "package", "index.ts"))}],${JSON.stringify(temp)}); if(r.errors.length||!r.extensions[0]?.tools.has('architect_checkpoint')||!r.extensions[0]?.tools.has('auto_status')||!r.extensions[0]?.commands.has('auto'))throw new Error(JSON.stringify(r.errors));`;
  await run([process.execPath, "-e", check], path.join(temp, "package"));
  console.log(
    `Package verified: ${files.length} entries, packed extension loads against locked OMP`,
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

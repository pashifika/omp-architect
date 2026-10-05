import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-architect-pack-"));
async function run(cmd: string[], cwd: string) {
  const child = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      USERPROFILE: path.join(temp, "home"),
      PI_CODING_AGENT_DIR: path.join(temp, "home", ".omp", "agent"),
      PI_CONFIG_DIR: ".omp",
      OMP_PROFILE: "",
      PI_PROFILE: "",
      XDG_CONFIG_HOME: path.join(temp, "config"),
      XDG_DATA_HOME: path.join(temp, "data"),
      XDG_STATE_HOME: path.join(temp, "state"),
      XDG_CACHE_HOME: path.join(temp, "cache"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code) throw new Error(`${cmd.join(" ")} failed (${code})\n${stdout}\n${stderr}`);
  return stdout.trim();
}
try {
  await fs.mkdir(path.join(temp, "home"));
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
    "src/auto/workflow.ts",
    "src/auto/decision.ts",
    "src/auto/fallback.ts",
    "src/auto/instructions.ts",
    "src/auto/confirmation.ts",
    "src/brief/package.json",
    "src/brief/extension.ts",
    "src/brief/runtime.ts",
    "src/brief/format.ts",
    "src/brief/editor.ts",
    "examples/auto.json",
    "examples/auto-project.json",
    "examples/auto-config.yml",
    "docs/rasen-auto-verification.md",
    "src/prompts/architect.md",
    "src/prompts/orchestration.md",
    "agents/omp-worker.md",
    "agents/omp-explorer.md",
    "agents/omp-reviewer.md",
    "README.md",
    "LICENSE",
  ]) {
    if (!files.includes(`package/${file}`)) throw new Error(`Package is missing ${file}`);
  }
  if (files.some((file) => /\/node_modules\/|\/\.env|\/test\/|\/smoke\//.test(file)))
    throw new Error("Package includes private or development-only files");
  if (files.some((file) => /\/brief\/.*\.md$/.test(file)))
    throw new Error("Package must not bundle brief template packs");
  await run(["tar", "-xzf", tarball, "-C", temp], root);
  // Link the checkout's installed host dependencies; then load the actual packed artifact.
  // This does not publish anything or claim npm registry installation was exercised.
  await fs.symlink(
    path.join(root, "node_modules"),
    path.join(temp, "package", "node_modules"),
    "dir",
  );
  const check = `
    import {loadExtensions} from '@oh-my-pi/pi-coding-agent/extensibility/extensions';
    const main = ${JSON.stringify(path.join(temp, "package", "index.ts"))};
    const optional = ${JSON.stringify(path.join(temp, "package", "src", "brief", "extension.ts"))};
    const r=await loadExtensions([main],${JSON.stringify(temp)});
    if(r.errors.length||!r.extensions[0]?.tools.has('architect_checkpoint')||!r.extensions[0]?.tools.has('auto_status')||!r.extensions[0]?.commands.has('auto')||r.extensions[0]?.commands.has('brief'))throw new Error(JSON.stringify(r.errors));
    const both=await loadExtensions([main,optional],${JSON.stringify(temp)});
    if(both.errors.length||both.extensions.filter(e=>e.commands.has('brief')).length!==1)throw new Error(JSON.stringify(both.errors));
  `;
  await run([process.execPath, "-e", check], path.join(temp, "package"));
  console.log(
    `Package verified: ${files.length} entries, packed extension loads against the checkout's installed OMP`,
  );
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

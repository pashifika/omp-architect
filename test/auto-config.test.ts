import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { autoDefaults, loadAutoConfig } from "../src/auto/config.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "auto-config-"));
  roots.push(root);
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "custom profile 日本語", "agent");
  const global = path.join(agentDir, "auto.json");
  const project = path.join(cwd, ".omp", "auto.json");
  return { root, cwd, agentDir, global, project, load: () => loadAutoConfig(cwd, agentDir) };
}

test("both optional configs missing use fresh builtin defaults without creating directories", async () => {
  const f = await fixture();
  const config = await f.load();
  expect(config).toEqual(autoDefaults);
  expect(config).not.toBe(autoDefaults);
  config.enabled = false;
  expect(await f.load()).toEqual(autoDefaults);
  expect(await fs.readdir(f.root)).toEqual([]);
});

test("global-only config supplies defaults from the host-resolved agent directory", async () => {
  const f = await fixture();
  await Bun.write(
    f.global,
    JSON.stringify({
      maxDurationMs: 7200000,
      noOutputTimeoutMs: 300000,
      rasenExecutable: "/my/rasen",
    }),
  );
  const before = await Bun.file(f.global).text();
  expect(await f.load()).toEqual({
    ...autoDefaults,
    maxDurationMs: 7200000,
    noOutputTimeoutMs: 300000,
    rasenExecutable: "/my/rasen",
  });
  expect(await Bun.file(f.global).text()).toBe(before);
  expect(await Bun.file(f.project).exists()).toBe(false);
});

test("project-only config overrides builtins without creating a global file", async () => {
  const f = await fixture();
  await Bun.write(f.project, '{"maxSteps":2,"enabled":false}');
  expect(await f.load()).toEqual({ ...autoDefaults, maxSteps: 2, enabled: false });
  expect(await Bun.file(f.global).exists()).toBe(false);
});

test("partial project overrides retain unspecified global options and preserve all files", async () => {
  const f = await fixture();
  const global = {
    maxDurationMs: 7200000,
    noOutputTimeoutMs: 300000,
    maxSteps: 12,
    maxFallbacks: 4,
    fallback: "stop" as const,
    rasenExecutable: "/profile/rasen",
  };
  await Bun.write(f.global, JSON.stringify(global));
  await Bun.write(f.project, '{"maxDurationMs":3600000,"maxFallbacks":0}');
  const architect = path.join(f.cwd, ".omp", "architect.json");
  await Bun.write(architect, '{"reviews":{"min":2,"max":5}}');
  const files = [f.global, f.project, architect];
  const before = await Promise.all(files.map((file) => Bun.file(file).text()));
  expect(await f.load()).toEqual({
    ...autoDefaults,
    ...global,
    maxDurationMs: 3600000,
    maxFallbacks: 0,
  });
  expect(await Promise.all(files.map((file) => Bun.file(file).text()))).toEqual(before);
  await Bun.write(f.project, "{}");
  expect(await f.load()).toEqual({ ...autoDefaults, ...global });
});

test("explicit project null disables each inherited legacy cap", async () => {
  const f = await fixture();
  await Bun.write(f.global, '{"maxSteps":8,"maxToolCalls":80,"maxStalls":3}');
  await Bun.write(f.project, '{"maxSteps":null,"maxToolCalls":null,"maxStalls":null}');
  expect(await f.load()).toEqual(autoDefaults);
});

test("enabled false inherits unless explicitly overridden, and project false remains disabled", async () => {
  const f = await fixture();
  await Bun.write(f.global, '{"enabled":false}');
  expect((await f.load()).enabled).toBe(false);
  await Bun.write(f.project, '{"maxSteps":2}');
  expect((await f.load()).enabled).toBe(false);
  await Bun.write(f.project, '{"enabled":true}');
  expect((await f.load()).enabled).toBe(true);
  await Bun.write(f.global, '{"enabled":true}');
  await Bun.write(f.project, '{"enabled":false}');
  expect((await f.load()).enabled).toBe(false);
});

for (const layer of ["global", "project"] as const) {
  test.each([
    "{",
    "[]",
    "null",
    '{"unknown":1}',
    '{"enabled":null}',
    '{"maxSteps":10001}',
    '{"maxDurationMs":null}',
    '{"noOutputTimeoutMs":0}',
  ])(`invalid ${layer} file fails closed and identifies its path: %s`, async (invalid) => {
    const f = await fixture();
    await Bun.write(f.global, "{}");
    // A valid project override must not mask an invalid global value.
    await Bun.write(f.project, JSON.stringify(autoDefaults));
    await Bun.write(f[layer], invalid);
    await expect(f.load()).rejects.toThrow(`Invalid Auto configuration at ${f[layer]}`);
    expect(await Bun.file(f[layer]).text()).toBe(invalid);
  });

  test(`unreadable ${layer} path is not treated as an absent config`, async () => {
    const f = await fixture();
    await fs.mkdir(f[layer], { recursive: true });
    await expect(f.load()).rejects.toThrow(f[layer]);
  });
}

test("invalid JSON errors identify the path without echoing file contents", async () => {
  const f = await fixture();
  await Bun.write(f.global, 'accidental-private-token {"enabled":true}');
  try {
    await f.load();
    throw new Error("Expected malformed config to fail");
  } catch (error) {
    expect(String(error)).toContain(f.global);
    expect(String(error)).not.toContain("accidental-private-token");
  }
});

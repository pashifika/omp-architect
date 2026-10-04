import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadAutoConfig } from "../src/auto/config.ts";
import { autoRequest, briefRoot, parseAutoStart, renderBrief } from "../src/auto/instructions.ts";
import { completeAuto } from "../src/auto/completion.ts";
import { Orchestrator } from "../src/core.ts";
import { parseConfig } from "../src/config.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "auto-instructions-"));
  roots.push(cwd);
  const global = path.join(cwd, "agent", "brief");
  const pack = path.join(cwd, ".omp", "brief", "example");
  await Bun.write(
    path.join(pack, "_shared.md"),
    "---\r\nvariable: change\r\n---\r\nReview {change}/{var}: {scopes}\n{blocks}\nUnknown {other}\n",
  );
  await Bun.write(
    path.join(pack, "rust.md"),
    "---\naliases: rs\n---\n\n  - RUST {scope}: {change}  \n",
  );
  await Bun.write(path.join(pack, "ts.md"), "---\naliases: typescript, t\n---\nTS {scope}: {var}");
  return { cwd, global, pack };
}

test("missing config and omitted enabled use defaults; explicit false and invalid config are preserved", async () => {
  const { cwd } = await fixture();
  expect((await loadAutoConfig(cwd)).enabled).toBe(true);
  await Bun.write(path.join(cwd, ".omp/auto.json"), '{"maxSteps":2}');
  expect(await loadAutoConfig(cwd)).toMatchObject({ enabled: true, maxSteps: 2 });
  await Bun.write(path.join(cwd, ".omp/auto.json"), '{"enabled":false}');
  expect((await loadAutoConfig(cwd)).enabled).toBe(false);
  await Bun.write(path.join(cwd, ".omp/auto.json"), '{"maxSteps":99}');
  await expect(loadAutoConfig(cwd)).rejects.toThrow();
  await Bun.write(path.join(cwd, ".omp/auto.json"), "{");
  await expect(loadAutoConfig(cwd)).rejects.toThrow();
});

test("instructions preserve quotes, multiple spaces, indentation, newlines, and trailing whitespace", () => {
  for (const text of [
    'Use "small changes"  only',
    "  - first\n    second  \n",
    "--brief is literal with an escape",
  ])
    expect(parseAutoStart(`start my-change -- ${text}`).instructions).toBe(text);
  expect(parseAutoStart("start my-change\n  - keep indentation\n").instructions).toBe(
    "  - keep indentation\n",
  );
  expect(parseAutoStart("start my-change --brief example --\n  code()  \n").instructions).toBe(
    "  code()  \n",
  );
  expect(parseAutoStart("start my-change")).toEqual({ change: "my-change", instructions: "" });
});

test("brief syntax selects blocks and passes the named change as variable", () => {
  expect(
    parseAutoStart("start my-change --brief example TS,rs -- Extra  prose\n  indented\n"),
  ).toEqual({
    change: "my-change",
    brief: { pack: "example", blocks: ["ts", "rs"] },
    instructions: "Extra  prose\n  indented\n",
  });
});

test.each([
  "start ../oops",
  "start X",
  "start my-change --brief",
  "start my-change --brief ../bad",
  "start my-change --brief ok ../block",
  "start my-change\0",
  `start my-change ${"x".repeat(12000)}`,
])("rejects malformed or unbounded invocation", (input) => {
  expect(() => parseAutoStart(input)).toThrow();
});

test("brief v0.1 rendering matches CRLF, variables, alias order, dedupe, indentation and unknown placeholders", async () => {
  const { cwd, global } = await fixture();
  expect(
    await renderBrief(
      cwd,
      global,
      { pack: "example", blocks: ["typescript", "rs", "rust"] },
      "my-change",
    ),
  ).toBe(
    "Review my-change/my-change: ts, rust\nTS ts: my-change\n\n  - RUST rust: my-change\nUnknown {other}\n",
  );
  expect(await renderBrief(cwd, global, { pack: "example", blocks: [] }, "my-change")).toBe(
    "Review my-change/my-change: \n\nUnknown {other}\n",
  );
  await expect(
    renderBrief(cwd, global, { pack: "example", blocks: ["missing"] }, "my-change"),
  ).rejects.toThrow();
});

test("project pack shadows global completely, including incomplete project packs", async () => {
  const { cwd, global, pack } = await fixture();
  await Bun.write(path.join(global, "example", "_shared.md"), "GLOBAL {var}");
  expect(await renderBrief(cwd, global, { pack: "example", blocks: [] }, "change")).not.toContain(
    "GLOBAL",
  );
  await fs.rm(path.join(pack, "_shared.md"));
  await expect(
    renderBrief(cwd, global, { pack: "example", blocks: [] }, "change"),
  ).rejects.toThrow();
  await fs.rm(pack, { recursive: true });
  expect(await renderBrief(cwd, global, { pack: "example", blocks: [] }, "change")).toBe(
    "GLOBAL change",
  );
});

test("global root follows host, override, HOME and explicit absence", () => {
  expect(briefRoot(() => "/profile", { HOME: "/home", PI_CODING_AGENT_DIR: "/override" })).toBe(
    "/profile/brief",
  );
  expect(briefRoot(undefined, { HOME: "/home", PI_CODING_AGENT_DIR: "/override" })).toBe(
    "/override/brief",
  );
  expect(briefRoot(undefined, { HOME: "/home" })).toBe("/home/.omp/agent/brief");
  expect(briefRoot(undefined, {})).toBeUndefined();
});

test.each([
  "pack-symlink",
  "file-symlink",
  "oversize",
  "binary",
  "bad-variable",
])("brief rejects %s before using content", async (kind) => {
  const { cwd, global, pack } = await fixture();
  if (kind === "pack-symlink") {
    await fs.rename(pack, `${pack}-real`);
    await fs.symlink(`${pack}-real`, pack, "dir");
  } else if (kind === "file-symlink") {
    await fs.rm(path.join(pack, "ts.md"));
    await fs.symlink(path.join(pack, "rust.md"), path.join(pack, "ts.md"));
  } else if (kind === "oversize") await Bun.write(path.join(pack, "ts.md"), "x".repeat(65537));
  else if (kind === "binary") await Bun.write(path.join(pack, "ts.md"), Buffer.from([255, 0]));
  else await Bun.write(path.join(pack, "_shared.md"), "---\nvariable: not a variable\n---\n{var}");
  await expect(
    renderBrief(cwd, global, { pack: "example", blocks: ["ts"] }, "change"),
  ).rejects.toThrow();
});

test("brief supports cancellation and caps entries and expansion", async () => {
  const { cwd, global, pack } = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    renderBrief(cwd, global, { pack: "example", blocks: [] }, "change", controller.signal),
  ).rejects.toThrow();
  await Bun.write(path.join(pack, "_shared.md"), "{var}".repeat(3000));
  await expect(
    renderBrief(cwd, global, { pack: "example", blocks: [] }, "long-change"),
  ).rejects.toThrow();
  await Bun.write(path.join(pack, "_shared.md"), "Short");
  for (let i = 0; i < 129; i++) await Bun.write(path.join(pack, `${i}.txt`), "");
  await expect(
    renderBrief(cwd, global, { pack: "example", blocks: [] }, "change"),
  ).rejects.toThrow();
});

test("whole escaped instructions fit architect evidence or are rejected, with immutable budget", () => {
  const core = new Orchestrator(parseConfig({}));
  const text = autoRequest("my-change", "  Begin\n" + '日本語\\"'.repeat(200) + "\n  End\n");
  expect(core.canRetainRequest(text)).toBe(true);
  core.begin(text);
  expect(JSON.parse(core.snapshot("plan", "summary")).request).toBe(text);
  expect(core.canRetainRequest(autoRequest("my-change", "x".repeat(12000)))).toBe(false);
});

test("native argument completions replace full prefix, discover actual changes and respect prose", async () => {
  const { cwd, global } = await fixture();
  for (const change of ["my-change", "other-change", "archive"])
    await fs.mkdir(path.join(cwd, "rasen/changes", change), { recursive: true });
  const complete = (text: string) => completeAuto(text, cwd, global);
  expect(complete("st")?.map((item) => item.label)).toEqual(["start", "status", "stop"]);
  expect(complete("start my")?.map((item) => item.value)).toEqual(["start my-change "]);
  expect(complete("start ")?.map((item) => item.label)).not.toContain("archive");
  expect(complete("start my-change ")?.map((item) => item.value)).toEqual([
    "start my-change --brief ",
  ]);
  expect(complete("start my-change --brief e")?.map((item) => item.value)).toEqual([
    "start my-change --brief example ",
  ]);
  expect(complete("start my-change --brief example typ")?.[0].value).toBe(
    "start my-change --brief example ts ",
  );
  expect(
    complete("start my-change --brief example typescript ")?.map((item) => item.label),
  ).toEqual(["rust", "--"]);
  expect(complete("start my-change --brief example rs rust ")?.map((item) => item.label)).toEqual([
    "ts",
    "--",
  ]);
  expect(complete("start my-change --brief example -- prose")).toBeNull();
  expect(complete("start my-change write prose ")).toBeNull();
  expect(complete("start my-change\n--brief example ")).toBeNull();
  expect(complete("status ")).toBeNull();
});

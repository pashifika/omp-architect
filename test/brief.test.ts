import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import brief from "../src/brief/runtime.ts";

type Pi = Parameters<typeof brief>[0];
type Command = Parameters<Pi["registerCommand"]>[1];
type SessionHandler = Parameters<Pi["on"]>[1];
type Factory = NonNullable<
  NonNullable<Parameters<SessionHandler>[1]["ui"]>["addAutocompleteProvider"]
>;
type Provider = Parameters<Parameters<Factory>[0]>[0];

let root: string;
let command: Command;
let provider: Provider;
let sent: string[];
let notices: string[];
const context = { ui: { notify: (message: string) => notices.push(message) } };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "brief-regression-"));
  const pack = join(root, ".omp/brief/review");
  mkdirSync(pack, { recursive: true });
  writeFileSync(
    join(pack, "_shared.md"),
    "---\nvariable: change\n---\nReview {change} / {var}\nScopes: {scopes}\n{blocks}",
  );
  writeFileSync(join(pack, "rust.md"), "---\naliases: rs\n---\nRUST {scope}: {change}");
  writeFileSync(
    join(pack, "rust-claude.md"),
    "---\naliases: claude cl\n---\nCLAUDE {scope}: {var}",
  );
  writeFileSync(join(pack, "ts.md"), "---\naliases: typescript\n---\nTS {scope}");
  sent = [];
  notices = [];
  const inner: Provider = {
    getSuggestions: () => null,
    getForceFileSuggestions: () => ({
      items: [{ value: "file.txt", label: "file.txt" }],
      prefix: "file",
    }),
    applyCompletion: () => null,
    getInlineHint: () => null,
    trySyncSlashCompletion: () => null,
    trySyncInlineReplace: () => null,
  };
  brief({
    cwd: root,
    pi: { getAgentDir: () => join(root, "global") },
    registerCommand: (_name, registered) => {
      command = registered;
    },
    on: (_event, handler) =>
      handler(undefined, {
        ui: {
          addAutocompleteProvider: (factory) => {
            provider = factory(inner);
          },
        },
      }),
    sendUserMessage: (content) => sent.push(content),
  });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("omitting scopes renders shared prose without any scope body", async () => {
  await command.handler("review my-change", context);
  expect(sent).toEqual(["Review my-change / my-change\nScopes: \n"]);
  expect(notices).toEqual([]);
});

test("a missing variable never submits a prompt", async () => {
  await command.handler("review", context);
  expect(sent).toEqual([]);
  expect(notices).toHaveLength(1);
});

test("aliases preserve requested order and deduplicate the same scope", async () => {
  await command.handler("review rust typescript rs rust", context);
  expect(sent).toEqual(["Review rust / rust\nScopes: ts, rust\nTS ts\n\nRUST rust: rust"]);
});

test("unknown scopes do not submit partial prompts", async () => {
  await command.handler("review change nonexistent", context);
  expect(sent).toEqual([]);
  expect(notices).toHaveLength(1);
});

const tabCases = [
  {
    scenario: "Tab lists scopes at the empty first scope position",
    input: "/brief review change ",
    expected: ["rust", "rust-claude", "ts"],
  },
  {
    scenario: "Tab lists remaining scopes without a typed prefix",
    input: "/brief review change rust ",
    expected: ["rust-claude", "ts"],
  },
  {
    scenario: "Tab excludes a scope already selected through an alias",
    input: "/brief review change rs ",
    expected: ["rust-claude", "ts"],
  },
  {
    scenario: "Tab matches an alias prefix and inserts the canonical name",
    input: "/brief review change c",
    expected: ["rust-claude"],
  },
  {
    scenario: "Tab matches an uppercase alias",
    input: "/brief review change CL",
    expected: ["rust-claude"],
  },
  {
    scenario: "Tab keeps an exact scope instead of selecting a longer sibling",
    input: "/brief review change rust",
    expected: ["rust"],
  },
];

test.each(tabCases)("$scenario", async ({ input, expected }) => {
  // Editor.handleInput(Tab) selects this hook rather than getSuggestions.
  const result = await provider.getForceFileSuggestions!([input], 0, input.length);
  expect(new Set(result?.items.map((item) => item.value))).toEqual(new Set(expected));
});

test("accepting an alias replaces only that scope token", async () => {
  const input = "/brief review my-change rust c";
  const result = await provider.getForceFileSuggestions!([input], 0, input.length);
  const applied = provider.applyCompletion(
    [input],
    0,
    input.length,
    result!.items[0]!,
    result!.prefix,
  );
  expect(applied?.lines).toEqual(["/brief review my-change rust rust-claude "]);
});

const silentCases = [
  { scenario: "the free-form variable position has no scope candidates", input: "/brief review " },
  { scenario: "a variable matching a scope remains free-form input", input: "/brief review ru" },
  { scenario: "an exact scope stays unchanged on Enter", input: "/brief review change rust" },
  { scenario: "an exact alias stays unchanged on Enter", input: "/brief review change rs" },
];

test.each(silentCases)("$scenario", async ({ input }) => {
  expect(await provider.getSuggestions([input], 0, input.length)).toBeNull();
  expect(provider.trySyncSlashCompletion(input)).toBeNull();
});

const automaticCases = [
  {
    scenario: "a space after the variable lists scopes without another argument",
    input: "/brief review a ",
    expected: ["rust", "rust-claude", "ts"],
  },
  {
    scenario: "a space after a chosen scope lists remaining scopes",
    input: "/brief review a rust ",
    expected: ["rust-claude", "ts"],
  },
];

test.each(automaticCases)("$scenario", async ({ input, expected }) => {
  const result = await provider.getSuggestions([input], 0, input.length);
  expect(result?.items.map((item) => item.value).sort()).toEqual([...expected].sort());
  expect(provider.trySyncSlashCompletion(input)).toBeNull();
});

test("typing an alias prefix offers its canonical scope", async () => {
  const input = "/brief review change c";
  const result = await provider.getSuggestions([input], 0, input.length);
  expect(result?.items.map((item) => item.value)).toEqual(["rust-claude"]);
});

test("file Tab completion remains available outside brief", async () => {
  const input = "file";
  const result = await provider.getForceFileSuggestions!([input], 0, input.length);
  expect(result?.items.map((item) => item.value)).toEqual(["file.txt"]);
});

test("CRLF frontmatter and unknown placeholders share Auto's formatter", async () => {
  const pack = join(root, ".omp/brief/review");
  writeFileSync(
    join(pack, "_shared.md"),
    "---\r\nvariable: change\r\n---\r\n{change}: {unknown}\r\n{blocks}",
  );
  writeFileSync(
    join(pack, "ts.md"),
    "---\r\naliases: typescript\r\n---\r\n\r\n  - {scope}: {var}\r\n",
  );
  await command.handler("review example typescript", context);
  expect(sent).toEqual(["example: {unknown}\r\n  - ts: example"]);
});

test("new scaffolds project and host-reported global packs without replacing them", async () => {
  await command.handler("new my-project", context);
  await command.handler("new global my-global", context);
  for (const file of [
    join(root, ".omp/brief/my-project/_shared.md"),
    join(root, "global/brief/my-global/_shared.md"),
  ])
    expect(readFileSync(file, "utf8")).toContain("{blocks}");
  const file = join(root, ".omp/brief/my-project/_shared.md");
  writeFileSync(file, "Customized template");
  await command.handler("new my-project", context);
  expect(readFileSync(file, "utf8")).toBe("Customized template");
  expect(notices.at(-1)).toContain("already exists");
});

test("new refuses a symlinked pack without overwriting its target", async () => {
  const target = join(root, "existing");
  mkdirSync(target);
  writeFileSync(join(target, "_shared.md"), "Keep shared");
  writeFileSync(join(target, "example.md"), "Keep block");
  symlinkSync(
    target,
    join(root, ".omp/brief/linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await command.handler("new linked", context);
  expect(readFileSync(join(target, "_shared.md"), "utf8")).toBe("Keep shared");
  expect(readFileSync(join(target, "example.md"), "utf8")).toBe("Keep block");
  expect(notices.at(-1)).toContain("existing files were not replaced");
});

test("project pack shadows global pack and global-only pack is discoverable", async () => {
  for (const name of ["review", "global-only"]) {
    const pack = join(root, "global/brief", name);
    mkdirSync(pack, { recursive: true });
    writeFileSync(join(pack, "_shared.md"), "GLOBAL {var}");
  }
  await command.handler("review local", context);
  await command.handler("global-only remote", context);
  expect(sent).toEqual(["Review local / local\nScopes: \n", "GLOBAL remote"]);
  const input = "/brief ";
  const result = await provider.getSuggestions([input], 0, input.length);
  expect(result?.items.filter((item) => item.value === "review")).toHaveLength(1);
  expect(result?.items.find((item) => item.value === "global-only")?.description).toContain(
    "global",
  );
});

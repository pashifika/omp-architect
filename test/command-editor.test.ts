import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AutocompleteProvider } from "@oh-my-pi/pi-tui/autocomplete";
import type { CustomEditor as NativeEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";

const childFlag = "OMP_ARCHITECT_NATIVE_EDITOR_TEST";

if (process.env[childFlag] !== "1") {
  test("native command-editor regressions in a credential-free isolated host", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omp-command-editor-"));
    try {
      const home = path.join(root, "home");
      const cwd = path.join(root, "project");
      const scratch = path.join(root, "tmp");
      const xdg = Object.fromEntries(
        ["CONFIG", "DATA", "STATE", "CACHE", "RUNTIME"].map((kind) => [
          `XDG_${kind}_${kind === "RUNTIME" ? "DIR" : "HOME"}`,
          path.join(root, `xdg-${kind.toLowerCase()}`),
        ]),
      );
      for (const dir of [home, cwd, scratch, ...Object.values(xdg)]) mkdirSync(dir);
      mkdirSync(path.join(cwd, ".git"));
      // Import the real host only in this subprocess. No developer credentials,
      // dotenv, config, profile, cache, or terminal session are inherited.
      const env: NodeJS.ProcessEnv = {
        [childFlag]: "1",
        PATH: path.dirname(process.execPath),
        HOME: home,
        USERPROFILE: home,
        ...xdg,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        PI_CONFIG_DIR: ".omp",
        PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent"),
        OMP_PROFILE: "",
        PI_PROFILE: "",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        BUN_INSTALL: path.join(root, "bun"),
        BUN_INSTALL_CACHE_DIR: path.join(root, "bun-cache"),
        NODE_ENV: "test",
        TERM: "dumb",
        NO_COLOR: "1",
      };
      for (const key of ["SystemRoot", "WINDIR", "ComSpec"]) {
        if (process.env[key]) env[key] = process.env[key];
      }
      const result = spawnSync(
        process.execPath,
        ["--no-env-file", "test", import.meta.path, "--timeout", "5000"],
        { cwd, env, encoding: "utf8", timeout: 25_000 },
      );
      expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("57 pass");
      expect(result.stderr).toContain("0 fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
} else {
  // Direct native TUI imports exercise OMP's current editor without starting the
  // CLI, loading a session, installing an extension, or making any model call.
  const { CombinedAutocompleteProvider } = await import("@oh-my-pi/pi-tui/autocomplete");
  const { CustomEditor } = await import("@oh-my-pi/pi-tui/prompt/custom-editor");
  const { KeybindingsManager } = await import("@oh-my-pi/pi-tui/app-keybindings");
  const { setKeybindings } = await import("@oh-my-pi/pi-tui/keybindings");
  const { getEditorTheme, initThemeSync } = await import("@oh-my-pi/pi-tui/theme/theme");
  const { commandEditor } = await import("../src/brief/editor.ts");
  const { completeAuto } = await import("../src/auto/completion.ts");
  const { default: brief } = await import("../src/brief/runtime.ts");

  initThemeSync("ascii");
  const theme = getEditorTheme();
  const keybindings = new KeybindingsManager();
  setKeybindings(keybindings);
  const cwd = process.cwd();
  const pack = path.join(cwd, ".omp", "brief", "toy");
  mkdirSync(pack, { recursive: true });
  mkdirSync(path.join(cwd, "rasen", "changes", "sample"), { recursive: true });
  // Generated public test data only; no user templates are read or copied.
  writeFileSync(
    path.join(pack, "_shared.md"),
    "---\nvariable: change\n---\nToy {change}\n{blocks}",
  );
  writeFileSync(path.join(pack, "alpha.md"), "---\naliases: a\n---\nAlpha {scope}");
  writeFileSync(path.join(pack, "alpine.md"), "Alpine {scope}");
  writeFileSync(path.join(pack, "ci.md"), "---\naliases: check\n---\nCI {scope}");

  type Pi = Parameters<typeof brief>[0];
  type Session = Parameters<Pi["on"]>[1];
  type UI = NonNullable<Parameters<Session>[1]["ui"]>;
  type WrappedProvider = Parameters<Parameters<NonNullable<UI["addAutocompleteProvider"]>>[0]>[0];
  type StandaloneFactory = Parameters<NonNullable<UI["setEditorComponent"]>>[0];
  type Mode = "auto" | "auto with brief" | "shared brief" | "standalone brief";

  function create(mode: Mode, original = false) {
    const inner = new CombinedAutocompleteProvider(
      [
        { name: "auto", getArgumentCompletions: (prefix) => completeAuto(prefix, cwd) },
        { name: "brief" },
        {
          name: "echo",
          getArgumentCompletions: () => [{ value: "accepted ", label: "accepted" }],
        },
      ],
      cwd,
    );
    let provider: AutocompleteProvider = inner;
    let standalone: StandaloneFactory | undefined;
    if (mode !== "auto") {
      brief({
        cwd,
        pi: { getAgentDir: () => path.join(cwd, "global"), CustomEditor },
        registerCommand: () => {},
        sendUserMessage: () => {
          throw new Error("Editor tests must never dispatch to a model");
        },
        on: (_event, handler) =>
          handler(undefined, {
            ui: {
              setEditorComponent: (factory) => {
                standalone = factory;
              },
              addAutocompleteProvider: (factory) => {
                // The runtime's compatibility surface is readonly and accepts
                // unknown hints, while OMP consumes the same runtime objects.
                const compatible = {
                  getSuggestions: inner.getSuggestions.bind(inner),
                  getForceFileSuggestions: inner.getForceFileSuggestions.bind(inner),
                  applyCompletion: inner.applyCompletion.bind(inner),
                  getInlineHint: inner.getInlineHint.bind(inner),
                  trySyncSlashCompletion: inner.trySyncSlashCompletion.bind(inner),
                  trySyncInlineReplace: () => null,
                } as unknown as WrappedProvider;
                provider = factory(compatible) as unknown as AutocompleteProvider;
              },
            },
          }),
      });
    }
    // No screen renderer is required for editor key handling. The real native
    // constructor accepts the host factory's (tui, theme, keybindings) shape.
    const tui = undefined as unknown as Parameters<typeof commandEditor>[0];
    const editor = original
      ? new CustomEditor(theme)
      : mode === "standalone brief"
        ? (standalone!(tui, theme, keybindings) as NativeEditor)
        : commandEditor(tui, theme, keybindings);
    expect(editor).toBeInstanceOf(CustomEditor);
    editor.setAutocompleteProvider(provider);
    const submissions: string[] = [];
    editor.onSubmit = (text) => {
      submissions.push(text);
    };
    return { editor, submissions };
  }

  async function popup(editor: NativeEditor) {
    const deadline = Date.now() + 1500;
    while (!editor.isShowingAutocomplete() && Date.now() < deadline) await delay(5);
    expect(editor.isShowingAutocomplete()).toBe(true);
    // Also check the factory passed a usable native theme to its superclass.
    expect(editor.render(100).length).toBeGreaterThan(0);
  }

  const enterKeys = [
    { name: "Enter", key: "\r" },
    { name: "Kitty Enter", key: "\x1b[13u" },
  ];
  for (const mode of ["auto", "auto with brief", "shared brief", "standalone brief"] as const) {
    const prefix = mode.startsWith("auto") ? "/auto start sample --brief toy" : "/brief toy sample";
    describe(mode, () => {
      test("Space opens block suggestions without inserting a block", async () => {
        const { editor, submissions } = create(mode);
        editor.setText(prefix);
        await delay(120);
        expect(editor.isShowingAutocomplete()).toBe(false);
        editor.handleInput(" ");
        await popup(editor);
        expect(editor.getText()).toBe(`${prefix} `);
        expect(submissions).toEqual([]);
        editor.handleInput("\x1b");
      });

      test("Tab explicitly accepts an alias candidate and Enter keeps that choice", async () => {
        const { editor, submissions } = create(mode);
        editor.setText(`${prefix} `);
        editor.handleInput("ch");
        await popup(editor);
        editor.handleInput("\t");
        expect(editor.getText()).toBe(`${prefix} ci `);
        expect(submissions).toEqual([]);
        editor.handleInput("\r");
        expect(submissions).toEqual([`${prefix} ci`]);
      });

      for (const { name, key } of enterKeys) {
        for (const chosen of ["", " alpha"]) {
          test(`${name} submits ${chosen ? "chosen" : "zero"} blocks without accepting the popup`, async () => {
            const { editor, submissions } = create(mode);
            editor.setText(`${prefix}${chosen}`);
            editor.handleInput(" ");
            await popup(editor);
            editor.handleInput(key);
            expect(submissions).toEqual([`${prefix}${chosen}`]);
            expect(editor.getText()).toBe("");
            expect(editor.isShowingAutocomplete()).toBe(false);
          });
        }
        test(`${name} ignores a stale popup before its debounced refresh`, async () => {
          const { editor, submissions } = create(mode);
          editor.setText(`${prefix} alpha `);
          editor.handleInput("c");
          await popup(editor);
          editor.handleInput("i");
          expect(editor.isShowingAutocomplete()).toBe(true);
          editor.handleInput(key);
          expect(submissions).toEqual([`${prefix} alpha ci`]);
          expect(editor.getText()).toBe("");
          // A pending debounce must not bring the dismissed popup back.
          await delay(120);
          expect(editor.isShowingAutocomplete()).toBe(false);
        });
        test(`${name} without a popup preserves exact block names and aliases`, () => {
          for (const block of ["alpha", "a"]) {
            const { editor, submissions } = create(mode);
            editor.setText(`${prefix} ${block}`);
            expect(editor.isShowingAutocomplete()).toBe(false);
            editor.handleInput(key);
            expect(submissions).toEqual([`${prefix} ${block}`]);
          }
        });
      }

      test("LF dismisses suggestions and retains the native newline behavior", async () => {
        const { editor, submissions } = create(mode);
        editor.setText(`${prefix} alpha`);
        editor.handleInput(" ");
        await popup(editor);
        editor.handleInput("\n");
        expect(submissions).toEqual([]);
        expect(editor.getText()).toBe(`${prefix} alpha \n`);
        expect(editor.isShowingAutocomplete()).toBe(false);
      });

      test("an unrelated command keeps native Enter-to-accept behavior", async () => {
        const guarded = create(mode);
        const native = create(mode, true);
        for (const { editor } of [guarded, native]) {
          editor.setText("/echo ");
          editor.handleInput("a");
          await popup(editor);
          editor.handleInput("\r");
        }
        expect(guarded.editor.getText()).toBe(native.editor.getText());
        expect(guarded.submissions).toEqual(native.submissions);
        expect(`${guarded.editor.getText()}${guarded.submissions.join()}`).toContain("accepted");
      });

      test("ordinary text, editing, Space, and LF stay identical to the native editor", () => {
        const guarded = create(mode);
        const native = create(mode, true);
        for (const key of ["plain", " ", "text", "\x7f", "\n", "next"]) {
          guarded.editor.handleInput(key);
          native.editor.handleInput(key);
          expect(guarded.editor.getText()).toBe(native.editor.getText());
          expect(guarded.submissions).toEqual(native.submissions);
        }
        guarded.editor.handleInput("\r");
        native.editor.handleInput("\r");
        expect(guarded.submissions).toEqual(native.submissions);
      });
    });
  }

  describe("auto option and pack positions with optional brief loaded", () => {
    test("Space lists the optional flag and only Tab inserts it", async () => {
      const { editor, submissions } = create("auto with brief");
      editor.setText("/auto start sample");
      editor.handleInput(" ");
      await popup(editor);
      expect(editor.getText()).toBe("/auto start sample ");
      editor.handleInput("\t");
      expect(editor.getText()).toBe("/auto start sample --brief ");
      expect(submissions).toEqual([]);
      editor.handleInput("\x1b");
    });

    for (const { name, key } of enterKeys) {
      for (const prefix of ["/auto start sample", "/auto start sample --brief"]) {
        test(`${name} does not insert an unchosen option or pack after ${prefix}`, async () => {
          const { editor, submissions } = create("auto with brief");
          editor.setText(prefix);
          editor.handleInput(" ");
          await popup(editor);
          expect(editor.getText()).toBe(`${prefix} `);
          editor.handleInput(key);
          expect(submissions).toEqual([prefix]);
          expect(editor.isShowingAutocomplete()).toBe(false);
        });
      }
    }
  });
}

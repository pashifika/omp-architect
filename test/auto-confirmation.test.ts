import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionUIContext } from "@oh-my-pi/pi-coding-agent";
import type { Text as NativeText } from "@oh-my-pi/pi-tui";
import type { Reconciler as NativeReconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import {
  autoConfirmationMessage,
  autoConfirmationTitle,
  confirmAutoStart,
  createAutoConfirmation,
} from "../src/auto/confirmation.ts";

const childFlag = "OMP_ARCHITECT_NATIVE_CONFIRMATION_TEST";
const sdkFlag = "OMP_ARCHITECT_CONFIRMATION_TUI";

if (process.env[childFlag] !== "1") {
  test("Auto confirmation in a credential-free native host", () => {
    const root = mkdtempSync(path.join(tmpdir(), "omp-auto-confirmation-"));
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
      const env: NodeJS.ProcessEnv = {
        [childFlag]: "1",
        [sdkFlag]:
          process.env[sdkFlag] ?? path.resolve(import.meta.dir, "../node_modules/@oh-my-pi/pi-tui"),
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
      const result = spawnSync(process.execPath, ["--no-env-file", "test", import.meta.path], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 25_000,
      });
      expect(result.error, `${result.stdout}\n${result.stderr}`).toBeUndefined();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("0 fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
} else {
  // Use real host text wrapping/key decoding, without starting OMP or a model.
  // An explicit alternate package directory also exercises the supported minimum.
  const sdk = process.env[sdkFlag]!;
  const { Text }: { Text: typeof NativeText } = await import(`${sdk}/src/components/text.ts`);
  const { KeybindingsManager } = await import(`${sdk}/src/app-keybindings.ts`);
  const themes = await import(`${sdk}/src/theme/theme.ts`);
  const { visibleWidth } = await import(`${sdk}/src/utils.ts`);
  const { Reconciler }: { Reconciler: typeof NativeReconciler } = await import(
    `${sdk}/src/native/reconcile.ts`
  );
  themes.initThemeSync("ascii");
  const theme = themes.theme;
  const keybindings = new KeybindingsManager();
  const guidance =
    "# 日本語の追加指示\n\n段落を保持しながら、既存の変更だけを慎重に実装してください。".repeat(3) +
    "\n\n- **検証**を実行\n  - インデントを保持\n\n\n```ts\nconst value = 'そのまま';\n```\n\n末尾の指示";

  async function create(message = autoConfirmationMessage("sample", guidance), rows = 1000) {
    const values: boolean[] = [];
    let renders = 0;
    const terminal = { rows };
    const factory = createAutoConfirmation({ Text }, message);
    const tui = {
      terminal,
      requestRender: () => {
        renders++;
      },
    } as unknown as Parameters<typeof factory>[0];
    const component = await factory(tui, theme, keybindings, (result) => values.push(result));
    return { component, values, terminal, renders: () => renders };
  }
  const plain = (lines: readonly string[]) => lines.map((line) => Bun.stripANSI(line));

  test("disclosure and frozen guidance retain their exact source bytes and separators", () => {
    expect(autoConfirmationMessage("sample", guidance)).toEndWith(
      `\n\nAdditional guidance (frozen for this run):\n${guidance}`,
    );
    expect(autoConfirmationMessage("sample", "")).not.toContain("Additional guidance");
    expect(guidance).toContain("\n\n\n```");
  });

  describe("native physical rows", () => {
    for (const width of [24, 40, 80, 120]) {
      test(`Japanese Markdown and blank rows at ${width} columns`, async () => {
        const message = autoConfirmationMessage("sample", guidance);
        const { component } = await create(message);
        const lines = plain(component.render(width));
        expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
        for (const line of lines.slice(1, -1)) {
          expect(line.startsWith(`${theme.boxRound.vertical} `)).toBe(true);
          expect(line.endsWith(` ${theme.boxRound.vertical}`)).toBe(true);
          expect(line).not.toContain("\n");
        }
        const headingRows = new Text(autoConfirmationTitle, 0, 0).render(width - 4).length;
        const bodyRows = plain(new Text(message, 0, 0).render(width - 4));
        const shown = lines
          .slice(1 + headingRows, 1 + headingRows + bodyRows.length)
          .map((line) => line.slice(2, -2));
        expect(shown).toEqual(bodyRows);
        expect(shown.filter((line) => !line.trim()).length).toBe(
          message.split("\n").filter((line) => !line).length,
        );
        // A render at another width reflows from source, never from previous rows.
        component.render(width + 17);
        component.invalidate?.();
        expect(plain(component.render(width))).toEqual(lines);
      });
    }

    test("long guidance is pageable with persistent choices and resize-safe borders", async () => {
      const long = Array.from({ length: 60 }, (_, i) => `行 ${i}: 日本語の指示`).join("\n");
      const { component, terminal, renders } = await create(long, 24);
      const first = plain(component.render(80));
      expect(first.length).toBeLessThanOrEqual(24);
      expect(first.join("\n")).toContain("行 0:");
      expect(first.join("\n")).not.toContain("行 59:");
      for (let i = 0; i < 10; i++) {
        component.handleInput!("\x1b[6~");
        component.render(80);
      }
      const last = plain(component.render(80));
      expect(last.join("\n")).toContain("行 59:");
      expect(last.join("\n")).toContain("> Yes");
      expect(last.every((line) => visibleWidth(line) === 80)).toBe(true);
      terminal.rows = 40;
      const resized = plain(component.render(40));
      expect(resized.length).toBeLessThanOrEqual(40);
      expect(resized.every((line) => visibleWidth(line) === 40)).toBe(true);
      for (let i = 0; i < 10; i++) component.handleInput!("\x1b[5~");
      expect(plain(component.render(80)).join("\n")).toContain("行 0:");
      expect(renders()).toBeGreaterThan(0);
    });

    test("native TSP carries the same physical rows without a picker subtitle", async () => {
      const { component } = await create();
      for (const cols of [40, 80]) {
        const reconciler = new Reconciler("confirmation-test");
        const ops = reconciler.reconcile(
          { main: [], dock: [component], layer: [] },
          {
            cols,
            reduceMotion: true,
            dark: true,
            supports: () => true,
            feature: () => false,
          },
        );
        const nodes = ops.flatMap((op) => (op[0] === "add" ? [op[4]] : []));
        const rows = nodes.find((node) => node.k === "rows");
        expect(rows?.p).toEqual({ cols, lines: component.render(cols) });
        expect(nodes.some((node) => node.k === "picker")).toBe(false);
        expect(reconciler.fallbackCount).toBe(1);
      }
    });
  });

  describe("selection and cancellation", () => {
    for (const key of ["\r", "\x1b[13u"]) {
      test(`normal/Kitty Enter ${JSON.stringify(key)} approves once`, async () => {
        const { component, values } = await create();
        component.handleInput!(key);
        component.handleInput!(key);
        component.handleInput!("\x1b");
        expect(values).toEqual([true]);
      });
    }
    for (const key of ["\x1b", "\x03"]) {
      test(`cancel ${JSON.stringify(key)} cannot later approve`, async () => {
        const { component, values } = await create();
        component.handleInput!(key);
        component.handleInput!("\r");
        expect(values).toEqual([false]);
      });
    }
    test("No cancels, Up restores Yes, and a new dialog resets state", async () => {
      const first = await create();
      first.component.handleInput!("\x1b[B");
      expect(plain(first.component.render(80)).join("\n")).toContain("> No");
      first.component.handleInput!("\r");
      expect(first.values).toEqual([false]);
      const next = await create();
      next.component.handleInput!("\x1b[B");
      next.component.handleInput!("\x1b[A");
      next.component.handleInput!("\r");
      expect(next.values).toEqual([true]);
    });
    test("disposal suppresses stale input", async () => {
      const { component, values } = await create();
      component.dispose?.();
      component.handleInput!("\r");
      expect(values).toEqual([]);
    });
  });

  const ui = (custom: (...args: unknown[]) => Promise<unknown>) =>
    ({ custom }) as unknown as Pick<ExtensionUIContext, "custom">;

  test("custom UI receives the abort signal and requires an explicit true result", async () => {
    const controller = new AbortController();
    for (const result of [true, false, undefined, "Yes"]) {
      let options: unknown;
      const shown = ui(async (_factory, passed) => {
        options = passed;
        return result;
      });
      expect(await confirmAutoStart({ Text }, shown, "sample", guidance, controller.signal)).toBe(
        result === true,
      );
      expect(options).toEqual({ signal: controller.signal });
    }
  });

  test("abort before, during, or immediately after presentation never starts Auto", async () => {
    const controller = new AbortController();
    controller.abort();
    const unused = ui(async () => {
      throw new Error("Aborted dialogs must not open");
    });
    expect(await confirmAutoStart({ Text }, unused, "sample", guidance, controller.signal)).toBe(
      false,
    );
    const during = new AbortController();
    expect(
      await confirmAutoStart(
        { Text },
        ui(async () => {
          during.abort();
          throw during.signal.reason;
        }),
        "sample",
        guidance,
        during.signal,
      ),
    ).toBe(false);
    const after = new AbortController();
    expect(
      await confirmAutoStart(
        { Text },
        ui(async () => {
          after.abort();
          return true;
        }),
        "sample",
        guidance,
        after.signal,
      ),
    ).toBe(false);
  });

  test("a real UI error remains a preflight error rather than approval", async () => {
    expect(
      confirmAutoStart(
        { Text },
        ui(async () => {
          throw new Error("UI unavailable");
        }),
        "sample",
        guidance,
        new AbortController().signal,
      ),
    ).rejects.toThrow("UI unavailable");
  });
}

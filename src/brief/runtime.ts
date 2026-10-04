// Adapted from pashifika's supplied brief v0.1.0 for optional inclusion in this repository.
// User template packs are intentionally not bundled.
// `/brief <pack> <var> [block...]` — assembles a prompt from a `brief/<pack>/`
// directory. `/brief help` lists the packs; `/brief new [global] <pack>`
// scaffolds one. Argument completion is registered for all three.
//
// A pack is a directory: `_shared.md` carries the prose and marks where blocks
// land, and every other `*.md` is one selectable block. The file name is the
// selector, so adding a block is adding a file and adding a pack is adding a
// directory — neither touches this code. There is no conditional syntax here on
// purpose: the file-command template renderer cannot compare values at all
// (`{{#if args.[1] == 'rust'}}` silently drops the comparison and takes the true
// branch for any non-empty value), so selection lives where a comparison is real.
//
// Packs are read from two roots: `<cwd>/.omp/brief` (the project) and the agent
// directory's own (global). A project pack shadows a global pack of the same
// name. The project root follows the session's working directory rather than
// this file's location, so a globally installed extension still sees the packs
// of the repository it is run in. The OMP adapter uses the active session cwd.
//
// Single-brace placeholders, substituted here:
//   `{var}`     the second argument; also available under the pack's own
//               `variable:` name, so prose can read `{frame}` instead
//   `{scope}`   the block being rendered (block files only)
//   `{scopes}`  the selected blocks, comma-joined (`_shared.md` only)
//   `{blocks}`  where the selected blocks land (`_shared.md` only)
// An unknown `{word}` is left exactly as written rather than emptied.
//
// Reads are synchronous because one completion path is: the editor's
// `trySyncSlashCompletion` returns a value rather than a promise. A directory
// listing of a handful of entries per keystroke is cheaper than a cache that can
// disagree with the filesystem a `new` just changed.
//
// Interactive-mode only, by runtime constraint rather than by choice:
// `pi.sendUserMessage` from a command handler injects nothing under `omp -p`,
// and `addAutocompleteProvider` is a no-op outside the TUI.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseBriefDocument as parse, renderBriefText } from "./format.ts";

const COMMAND = "brief";
const DIR_NAME = "brief";
const SHARED = "_shared.md";
const GLOBAL = "global";
const SUBCOMMANDS = ["help", "new"];
const RESERVED = [...SUBCOMMANDS, GLOBAL];
const PACK_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** The host's own variable naming the agent directory, honoured as a fallback. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
/** Appended to `HOME` only when nothing better named the agent directory. */
const AGENT_DIR_SEGMENTS = [".omp", "agent"] as const;
const NO_GLOBAL = `the host reported no agent directory and neither ${AGENT_DIR_ENV} nor HOME is set, so there is no global directory`;

interface CommandContext {
  ui: { notify(message: string, level: "info" | "warning" | "error"): void };
}

/** The editor's own completion provider, which this one wraps. */
interface Suggestion {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
}
interface SuggestionList {
  readonly items: readonly Suggestion[];
  /**
   * The text being completed. Required: the editor reads it unconditionally to
   * choose a renderer (`prefix.startsWith("/")`) and passes it back as the
   * `query` of `applyCompletion`, so omitting it crashes the editor rather than
   * degrading.
   */
  readonly prefix: string;
}
interface Edit {
  readonly lines: readonly string[];
  readonly cursorLine: number;
  readonly cursorCol: number;
}
interface Completer {
  getSuggestions(
    lines: readonly string[],
    lineIndex: number,
    column: number,
    extra?: unknown,
  ): Promise<SuggestionList | null> | SuggestionList | null;
  getForceFileSuggestions?(
    lines: readonly string[],
    lineIndex: number,
    column: number,
    extra?: unknown,
  ): Promise<SuggestionList | null> | SuggestionList | null;
  applyCompletion(
    lines: readonly string[],
    lineIndex: number,
    column: number,
    item: Suggestion,
    query: string,
  ): Edit | null;
  getInlineHint(lines: readonly string[], lineIndex: number, column: number): unknown;
  trySyncSlashCompletion(text: string): SuggestionList | null;
  trySyncInlineReplace(text: string): unknown;
}

export interface BriefEditor {
  handleInput(data: string): void;
  insertText(text: string): void;
  getText(): string;
  isShowingAutocomplete(): boolean;
}

interface EditorKeybindings {
  matches(data: string, action: "tui.input.submit"): boolean;
}

interface Pi {
  readonly cwd: string;
  readonly pi?: {
    getAgentDir?: () => string;
    CustomEditor?: new (...args: unknown[]) => BriefEditor;
  };
  registerCommand(
    name: string,
    command: {
      description: string;
      handler: (args: string, ctx: CommandContext) => Promise<void>;
    },
  ): void;
  on(
    event: "session_start",
    handler: (
      event: unknown,
      ctx: {
        ui?: {
          addAutocompleteProvider?: (factory: (inner: Completer) => Completer) => void;
          setEditorComponent?: (
            factory: (tui: unknown, theme: unknown, keybindings: EditorKeybindings) => BriefEditor,
          ) => void;
        };
      },
    ) => void,
  ): void;
  sendUserMessage(content: string): void;
}

interface Block {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly body: string;
}

interface Pack {
  readonly name: string;
  readonly dir: string;
  readonly global: boolean;
  readonly description: string;
  readonly variable: string;
  readonly shared: string;
  readonly blocks: readonly Block[];
}

const projectRoot = (pi: Pi): string => join(pi.cwd, ".omp", DIR_NAME);

/**
 * Where global packs live, or `null` when that cannot be established.
 *
 * The host's own resolver comes first, because it already follows the Windows
 * default, named profiles, XDG locations, and explicit overrides — the rule
 * `rasen/specs/client-configuration/spec.md` states as "without reimplementing
 * those rules", after this repo's own extension stepped on it. The environment
 * chain below is the same fallback `extension/src/config.ts` keeps for direct
 * callers, and it ends in a stated absence rather than a guess: on Windows
 * `HOME` is routinely unset, and `os.homedir()` would answer with a
 * `USERPROFILE` path that OMP itself may not use.
 */
const globalRoot = (pi: Pi): string | null => {
  const reported = pi.pi?.getAgentDir?.();
  if (reported !== undefined && reported.length > 0) return join(reported, DIR_NAME);
  const override = process.env[AGENT_DIR_ENV];
  if (override !== undefined && override.length > 0) return join(override, DIR_NAME);
  const home = process.env["HOME"];
  if (home === undefined || home.length === 0) return null;
  return join(home, ...AGENT_DIR_SEGMENTS, DIR_NAME);
};

const loadPack = (dir: string, name: string, global: boolean): Pack | null => {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .sort();
  } catch {
    return null;
  }
  if (!files.includes(SHARED)) return null;

  const shared = parse(readFileSync(join(dir, SHARED), "utf8"));
  const blocks = files
    .filter((file) => !file.startsWith("_"))
    .map((file): Block => {
      const doc = parse(readFileSync(join(dir, file), "utf8"));
      const name = file.slice(0, -".md".length);
      return {
        name,
        // An alias repeating the file name, or repeating itself, resolves to
        // what the name already resolves to; keeping it only pads every list
        // that prints the spellings.
        aliases: (doc.meta["aliases"] ?? "")
          .split(/[\s,]+/)
          .filter(
            (alias, index, all) => alias !== "" && alias !== name && all.indexOf(alias) === index,
          ),
        body: doc.body,
      };
    });
  return {
    name,
    dir,
    global,
    description: shared.meta["description"] ?? "",
    variable: shared.meta["variable"] ?? "var",
    shared: shared.body,
    blocks,
  };
};

/** Project first, so a project pack shadows a global one of the same name. */
const listPacks = (pi: Pi): { name: string; dir: string; global: boolean }[] => {
  const found: { name: string; dir: string; global: boolean }[] = [];
  const project = projectRoot(pi);
  const global = globalRoot(pi);
  const searched: { dir: string; global: boolean }[] = [
    { dir: project, global: global === project },
  ];
  if (global !== null && global !== project) searched.push({ dir: global, global: true });
  for (const root of searched) {
    let entries: { name: string; isDirectory(): boolean }[];
    try {
      entries = readdirSync(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      if (found.some((pack) => pack.name === entry.name)) continue;
      found.push({ name: entry.name, dir: join(root.dir, entry.name), global: root.global });
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
};

const answersTo = (block: Block, name: string): boolean =>
  block.name === name || block.aliases.includes(name);

const spellings = (blocks: readonly Block[]): string =>
  blocks
    .map((block) =>
      block.aliases.length > 0 ? `${block.name} (${block.aliases.join(", ")})` : block.name,
    )
    .join(", ");

/** Only the `description:` of a pack, without reading any of its blocks. */
const describe = (dir: string): string => {
  try {
    return parse(readFileSync(join(dir, SHARED), "utf8")).meta["description"] ?? "";
  } catch {
    return "";
  }
};

/**
 * This command's own surface, and nothing about individual packs: `/brief ` in
 * the editor already lists those with their descriptions.
 */
const help = (pi: Pi, ctx: CommandContext): void => {
  const global = globalRoot(pi);
  const lines = [
    `/${COMMAND} <pack> <var> [block...] — assemble a prompt; blocks compose in the order you name them, and naming none adds no blocks; Space after <var> shows blocks, Tab selects, Enter submits only what you typed`,
    `/${COMMAND} help — this list`,
    global === null
      ? `/${COMMAND} new <pack> — scaffold a pack in the project; \`${GLOBAL}\` is unavailable because ${NO_GLOBAL}`
      : `/${COMMAND} new [${GLOBAL}] <pack> — scaffold a pack, in the project or under ${global}`,
    "placeholders: {var} (or the pack's own `variable:` name) anywhere, {scope} in a block, {scopes} and {blocks} in _shared.md",
    global === null
      ? `packs: ${projectRoot(pi)}`
      : `packs: ${projectRoot(pi)}, then ${global}; a project pack shadows a global one of the same name`,
    `a pack is a directory: ${SHARED} carries the prose and marks where blocks land, every other *.md is one selectable block, and a block's own \`aliases:\` name it`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
};

const SHARED_TEMPLATE = `---
description: one line, shown by \`/${COMMAND} help\`
variable: var
---
# {var}

Shared prose goes here. The lone placeholder line below is where every selected
block lands; keep it on a line of its own.

{blocks}
`;

const BLOCK_TEMPLATE = `---
aliases:
---
## Block \`{scope}\`

Body for this block, naming the argument the invocation passed: \`{var}\`.
`;

const scaffold = (pi: Pi, words: readonly string[], ctx: CommandContext): void => {
  const global = words[0] === GLOBAL;
  const name = global ? words[1] : words[0];

  if (!name || !PACK_NAME.test(name)) {
    ctx.ui.notify(
      `/${COMMAND} new [${GLOBAL}] <pack> — a pack name is lowercase letters, digits and dashes`,
      "error",
    );
    return;
  }
  if (RESERVED.includes(name)) {
    ctx.ui.notify(
      `/${COMMAND} new: \`${name}\` is reserved by the command, not available as a pack`,
      "error",
    );
    return;
  }
  const existing = listPacks(pi).find((pack) => pack.name === name);
  if (existing) {
    ctx.ui.notify(`/${COMMAND} new: ${existing.dir} already exists`, "error");
    return;
  }

  const root = global ? globalRoot(pi) : projectRoot(pi);
  if (root === null) {
    ctx.ui.notify(`/${COMMAND} new ${GLOBAL}: ${NO_GLOBAL}`, "error");
    return;
  }

  const dir = join(root, name);
  try {
    mkdirSync(root, { recursive: true });
    // Exclusive directory/file creation protects existing or symlinked packs,
    // including an incomplete pack and a concurrent scaffold invocation.
    mkdirSync(dir);
    writeFileSync(join(dir, SHARED), SHARED_TEMPLATE, { flag: "wx" });
    writeFileSync(join(dir, "example.md"), BLOCK_TEMPLATE, { flag: "wx" });
  } catch {
    ctx.ui.notify(
      `/${COMMAND} new: could not create ${dir}; existing files were not replaced`,
      "error",
    );
    return;
  }
  ctx.ui.notify(
    `/${COMMAND} new: wrote ${join(dir, SHARED)} and ${join(dir, "example.md")} — rename example.md to name its block`,
    "info",
  );
};

/**
 * What the cursor is completing, or `null` when this line is not this command's
 * argument list. `partial` is the token being typed and `taken` the arguments
 * complete before it.
 */
const position = (
  line: string,
  column: number,
): { taken: string[]; partial: string; start: number } | null => {
  const before = line.slice(0, column);
  const opening = new RegExp(`^\\s*/${COMMAND}\\s`).exec(before);
  if (!opening) return null;
  const start = /\s$/.test(before) ? before.length : before.lastIndexOf(" ") + 1;
  return {
    taken: before.slice(opening[0].length, start).split(/\s+/).filter(Boolean),
    partial: before.slice(start),
    start,
  };
};

const candidates = (pi: Pi, taken: readonly string[]): Suggestion[] => {
  const refs = listPacks(pi);
  if (taken.length === 0) {
    return [
      ...refs.map((ref) => {
        const stated = describe(ref.dir);
        const scope = ref.global ? "(global)" : "";
        return {
          value: ref.name,
          label: ref.name,
          description: [scope, stated].filter(Boolean).join(" ") || "pack",
        };
      }),
      { value: "help", label: "help", description: `what /${COMMAND} itself does` },
      { value: "new", label: "new", description: "scaffold a pack" },
    ];
  }
  if (taken[0] === "new") {
    const global = taken.length === 1 ? globalRoot(pi) : null;
    return global === null
      ? []
      : [{ value: GLOBAL, label: GLOBAL, description: `scaffold under ${global}` }];
  }
  // A pack: its second argument is the free-form variable, the rest are blocks.
  if (taken.length === 1) return [];
  const ref = refs.find((entry) => entry.name === taken[0]);
  const pack = ref ? loadPack(ref.dir, ref.name, ref.global) : null;
  if (!pack) return [];
  const used = taken.slice(2).map((name) => name.toLowerCase());
  return pack.blocks
    .filter((block) => !used.some((name) => answersTo(block, name)))
    .map((block) => ({
      value: block.name,
      label: block.name,
      aliases: block.aliases,
      description: block.aliases.length > 0 ? `block, also ${block.aliases.join(", ")}` : "block",
    }));
};

/** Show empty scope lists too; Enter submission is kept separate by the editor. */
const suggest = (
  pi: Pi,
  line: string,
  column: number,
  explicitTab = false,
): SuggestionList | null => {
  const spot = position(line, column);
  if (!spot) return null;
  const prefix = spot.partial.toLowerCase();
  const items = candidates(pi, spot.taken).filter(
    (item) =>
      item.value.toLowerCase().startsWith(prefix) ||
      item.aliases?.some((alias) => alias.toLowerCase().startsWith(prefix)),
  );
  if (items.length === 0) return null;
  const exact = items.filter(
    (item) =>
      item.value.toLowerCase() === prefix ||
      item.aliases?.some((alias) => alias.toLowerCase() === prefix),
  );
  if (exact.length > 0 && !explicitTab) return null;
  return { items: exact.length > 0 ? exact : items, prefix: spot.partial };
};

/** Replaces the token under the cursor, so insertion never depends on the host's query. */
const insert = (
  lines: readonly string[],
  lineIndex: number,
  column: number,
  item: Suggestion,
): Edit | null => {
  const line = lines[lineIndex] ?? "";
  const spot = position(line, column);
  if (!spot) return null;
  const next = `${line.slice(0, spot.start)}${item.value} ${line.slice(column)}`;
  return {
    lines: lines.map((text, index) => (index === lineIndex ? next : text)),
    cursorLine: lineIndex,
    cursorCol: spot.start + item.value.length + 1,
  };
};

export default function brief(pi: Pi): void {
  pi.registerCommand(COMMAND, {
    description: `Assemble a prompt from a ${DIR_NAME} pack; \`help\` lists them`,
    handler: async (args, ctx) => {
      const words = args
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean);
      const [head, ...rest] = words;

      if (!head || head === "help") {
        help(pi, ctx);
        return;
      }
      if (head === "new") {
        scaffold(pi, rest, ctx);
        return;
      }

      const refs = listPacks(pi);
      const ref = refs.find((entry) => entry.name === head);
      if (!ref) {
        ctx.ui.notify(
          `/${COMMAND}: no pack \`${head}\` — found ${refs.map((entry) => entry.name).join(", ") || "none"}; \`/${COMMAND} help\` describes them`,
          "error",
        );
        return;
      }
      const pack = loadPack(ref.dir, ref.name, ref.global);
      if (!pack) {
        ctx.ui.notify(`/${COMMAND} ${head}: ${ref.dir} has no ${SHARED}`, "error");
        return;
      }

      const [value, ...requested] = rest;
      if (!value) {
        ctx.ui.notify(
          `/${COMMAND} ${head} needs <${pack.variable}>, then optional blocks: ${spellings(pack.blocks)}`,
          "error",
        );
        return;
      }

      const wanted = requested.map((name) => name.toLowerCase());
      const unknown = wanted.filter((name) => !pack.blocks.some((block) => answersTo(block, name)));
      if (unknown.length > 0) {
        ctx.ui.notify(
          `/${COMMAND} ${head}: no block for ${unknown.join(", ")} — accepts ${spellings(pack.blocks)}`,
          "error",
        );
        return;
      }

      pi.sendUserMessage(
        renderBriefText(pack.shared, pack.variable, pack.blocks, value, requested),
      );
    },
  });

  // Argument completion. The editor's own provider offers nothing for a slash
  // command's arguments, which is the gap this fills; everything else is
  // delegated, `trySyncSlashCompletion` emphatically included — the editor
  // calls that one from its *submit* handler and applies `items[0]` before
  // sending, so answering it with argument candidates turns every Enter into
  // an unasked-for insertion. Insertion of these items is done here rather
  // than through the host's notion of which token is being replaced.
  pi.on("session_start", (_event, ctx) => {
    const HostEditor = pi.pi?.CustomEditor;
    if (HostEditor) {
      ctx.ui?.setEditorComponent?.(
        (tui, theme, keybindings) =>
          new (class extends HostEditor {
            override handleInput(data: string): void {
              if (/^\s*\/brief\s/.test(this.getText())) {
                // Single-character Space does not trigger host autocomplete;
                // its public insertion API does, without adding another token.
                if (data === " ") {
                  this.insertText(data);
                  return;
                }
                // Never accept a popup (including a stale one) on submit.
                // Escape dismisses it; the original submit key then runs normally.
                if (
                  (data === "\n" || keybindings.matches(data, "tui.input.submit")) &&
                  this.isShowingAutocomplete()
                ) {
                  super.handleInput("\x1b");
                }
              }
              super.handleInput(data);
            }
          })(tui, theme, keybindings),
      );
    }
    ctx.ui?.addAutocompleteProvider?.(
      (inner: Completer): Completer => ({
        getSuggestions: (lines, lineIndex, column, extra) =>
          suggest(pi, lines[lineIndex] ?? "", column) ??
          inner.getSuggestions(lines, lineIndex, column, extra),
        // Explicit Tab must use the same argument candidates as automatic display.
        getForceFileSuggestions: (lines, lineIndex, column, extra) =>
          suggest(pi, lines[lineIndex] ?? "", column, true) ??
          (inner.getForceFileSuggestions
            ? inner.getForceFileSuggestions(lines, lineIndex, column, extra)
            : inner.getSuggestions(lines, lineIndex, column, extra)),
        applyCompletion: (lines, lineIndex, column, item, query) =>
          insert(lines, lineIndex, column, item) ??
          inner.applyCompletion(lines, lineIndex, column, item, query),
        getInlineHint: (lines, lineIndex, column) => inner.getInlineHint(lines, lineIndex, column),
        // Enter-time hook: never answered here. See above.
        trySyncSlashCompletion: (text) => inner.trySyncSlashCompletion(text),
        trySyncInlineReplace: (text) => inner.trySyncInlineReplace(text),
      }),
    );
  });
}

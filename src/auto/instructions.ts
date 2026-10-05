import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseBriefDocument, renderBriefText } from "../brief/format.ts";

const namePattern = /^[a-z0-9][a-z0-9-]{0,99}$/;
const maxText = 12000;
const maxPackBytes = 65536;
export const autoUsage =
  "Usage: /auto start <kebab-case-change> [instructions] | start <change> --brief <pack> [blocks...] [-- instructions] | status | stop";

export interface AutoStart {
  change: string;
  instructions: string;
  brief?: { pack: string; blocks: string[] };
}

/** Only the leading option has syntax; prose is never shell-parsed or whitespace-normalized. */
export function parseAutoStart(args: string): AutoStart {
  if (args.length > maxText || args.includes("\0"))
    throw new Error("Auto input exceeds text limits");
  const match = /^\s*start\s+([a-z][a-z0-9-]{0,99})(?=\s|$)/.exec(args);
  if (!match) throw new Error(autoUsage);
  const separator = (text: string) => text.replace(/^(?:\r\n|\s)/, "");
  const result: AutoStart = {
    change: match[1],
    instructions: separator(args.slice(match[0].length)),
  };
  const escaped = /^[ \t]*--(?=\s|$)/.exec(result.instructions);
  if (escaped) {
    result.instructions = separator(result.instructions.slice(escaped[0].length));
    return result;
  }
  const option = /^[ \t]*--brief(?=\s|$)/.exec(result.instructions);
  if (!option) return result;
  const options = result.instructions.slice(option[0].length);
  const delimiter = /(?:^|\s)--(?=\s|$)/.exec(options);
  const selectors = (delimiter ? options.slice(0, delimiter.index) : options)
    .split(/[\s,]+/)
    .filter(Boolean);
  const [pack, ...blocks] = selectors;
  if (!pack || !namePattern.test(pack) || blocks.length > 64) throw new Error(autoUsage);
  if (blocks.some((block) => !namePattern.test(block.toLowerCase())))
    throw new Error("Brief block selectors must be bounded names, not paths");
  result.brief = { pack, blocks: blocks.map((block) => block.toLowerCase()) };
  result.instructions = delimiter
    ? separator(options.slice(delimiter.index + delimiter[0].length))
    : "";
  return result;
}

export function briefRoot(
  getAgentDir?: () => string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const reported = getAgentDir?.();
  const agent =
    reported ||
    env.PI_CODING_AGENT_DIR ||
    (env.HOME ? path.join(env.HOME, ".omp", "agent") : undefined);
  return agent ? path.join(agent, "brief") : undefined;
}

/** Read-only brief v0.1 format adapter. No extension import, editor, command, or template execution. */
export async function renderBrief(
  cwd: string,
  globalRoot: string | undefined,
  selection: NonNullable<AutoStart["brief"]>,
  change: string,
  signal?: AbortSignal,
): Promise<string> {
  if (
    !namePattern.test(selection.pack) ||
    selection.blocks.length > 64 ||
    selection.blocks.some((block) => !namePattern.test(block))
  )
    throw new Error("Invalid brief selector");
  let directory: string | undefined;
  for (const root of [path.join(cwd, ".omp", "brief"), globalRoot].filter(
    (root): root is string => !!root,
  )) {
    signal?.throwIfAborted();
    const candidate = path.join(root, selection.pack);
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error("Brief pack must be a regular directory");
      const resolvedRoot = await fs.realpath(root);
      directory = await fs.realpath(candidate);
      if (path.dirname(directory) !== resolvedRoot) throw new Error("Brief pack escapes its root");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("Brief pack is unreadable or unsafe");
    }
  }
  if (!directory) throw new Error("Brief pack was not found in the project or agent directory");
  let remaining = maxPackBytes;
  const read = async (name: string) => {
    signal?.throwIfAborted();
    const file = path.join(directory!, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("Brief files must be regular UTF-8 text files");
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > remaining)
        throw new Error("Brief pack exceeds the 64 KiB limit");
      const buffer = Buffer.alloc(remaining + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const next = await handle.read(buffer, length, buffer.length - length, length);
        if (!next.bytesRead) break;
        length += next.bytesRead;
      }
      if (length > remaining) throw new Error("Brief pack exceeds the 64 KiB limit");
      remaining -= length;
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (text.includes("\0")) throw new Error("Brief files must contain text");
      return parseBriefDocument(text);
    } finally {
      await handle.close();
    }
  };
  // A bounded directory scan avoids reading an unlimited number of empty files.
  const names: string[] = [];
  const opened = await fs.opendir(directory);
  for await (const entry of opened) {
    signal?.throwIfAborted();
    if (names.length >= 128) throw new Error("Brief pack exceeds the 128 entry limit");
    names.push(entry.name);
  }
  if (!names.includes("_shared.md")) throw new Error("Brief pack requires _shared.md");
  const shared = await read("_shared.md");
  const variable = shared.meta.variable ?? "var";
  if (!/^\w{1,64}$/.test(variable))
    throw new Error("Brief variable must be a bounded placeholder name");
  const blocks = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md") || name.startsWith("_")) continue;
    const item = await read(name);
    blocks.push({
      name: name.slice(0, -3),
      aliases: (item.meta.aliases ?? "").split(/[\s,]+/).filter(Boolean),
      body: item.body,
    });
  }
  const rendered = renderBriefText(shared.body, variable, blocks, change, selection.blocks);
  if (rendered.length > maxText) throw new Error("Rendered brief exceeds Auto text limits");
  return rendered;
}

export function autoRequest(change: string, instructions: string): string {
  return `Complete the user's requested outcome for existing Rasen change ${change}, using additional guidance below to refine that outcome. At each action boundary, select the next applicable existing non-Auto Rasen skill from the exact names and descriptions loaded by OMP, using current change facts and actual native work history. No configured pipeline or auto-run.json is required, and neither a file's existence nor a fixed phase order selects the next skill. Follow each selected skill completely: skills own their internal steps, review/fix loops, and source-owned files. Auto coordinates skill actions through OMP native state, artifact references, tools, roles, and job tracking; it does not replace skills or add a separate completion-review workflow. Planning, continue, apply, verification, review, ship, retain, and archive skills remain candidates when applicable to the requested outcome. Use normal approvals: selecting a skill is not authorization for consequential actions, and required approval still applies before publishing, merging, deploying, deleting, or archiving. Additional guidance does not expand permissions or authorize detached processes outside native OMP job tracking.\n\n${instructions}`;
}

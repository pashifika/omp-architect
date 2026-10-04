import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
} from "node:fs";
import * as path from "node:path";
import { parseBriefDocument } from "../brief/format.ts";

const name = /^[a-z0-9][a-z0-9-]{0,99}$/;
interface Item {
  value: string;
  label: string;
  description?: string;
  aliases?: string[];
}

function entries(directory: string) {
  const handle = opendirSync(directory);
  const result = [];
  try {
    for (let i = 0; i < 512; i++) {
      const entry = handle.readSync();
      if (!entry) return result;
      result.push(entry);
    }
    throw new Error("Completion directory exceeds limit");
  } finally {
    handle.closeSync();
  }
}

/** Synchronous bounded local metadata only: the OMP completion callback cannot await. */
export function completeAuto(prefix: string, cwd: string, globalRoot?: string): Item[] | null {
  if (prefix.length > 12000 || /[\r\n\0]/.test(prefix)) return null;
  const partial = /[^\s,]*$/.exec(prefix)![0];
  const preceding = prefix.slice(0, prefix.length - partial.length);
  const taken = preceding
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean);
  const choose = (items: Item[]) => {
    const matches = items.filter((item) =>
      [item.label, ...(item.aliases ?? [])].some((word) => word.startsWith(partial.toLowerCase())),
    );
    const exact = matches.filter(
      (item) =>
        item.label === partial.toLowerCase() || item.aliases?.includes(partial.toLowerCase()),
    );
    const result = (exact.length ? exact : matches).map((item) => ({
      ...item,
      value: `${preceding}${item.label} `,
    }));
    return result.length ? result : null;
  };
  try {
    if (!taken.length)
      return choose(["start", "status", "stop"].map((label) => ({ label, value: label })));
    if (taken[0] !== "start") return null;
    if (taken.length === 1) {
      return choose(
        entries(path.join(cwd, "rasen", "changes"))
          .filter(
            (entry) =>
              entry.isDirectory() &&
              /^[a-z][a-z0-9-]{0,99}$/.test(entry.name) &&
              entry.name !== "archive",
          )
          .map((entry) => ({
            label: entry.name,
            value: entry.name,
            description: "Local Rasen change",
          })),
      );
    }
    if (taken.length === 2)
      return choose([
        { label: "--brief", value: "--brief", description: "Use an existing brief pack" },
      ]);
    if (taken[2] !== "--brief" || taken.includes("--")) return null;
    const packs = new Map<string, string>();
    for (const root of [path.join(cwd, ".omp", "brief"), globalRoot].filter(
      (root): root is string => !!root,
    )) {
      try {
        for (const entry of entries(root)) {
          if (entry.isDirectory() && name.test(entry.name) && !packs.has(entry.name))
            packs.set(entry.name, path.join(root, entry.name));
          // Invalid/symlinked project packs also shadow global packs; never offer a fallback.
          else if (name.test(entry.name) && !packs.has(entry.name)) packs.set(entry.name, "");
        }
      } catch {
        /* Missing roots have no suggestions. */
      }
    }
    if (taken.length === 3)
      return choose(
        [...packs]
          .filter(([, dir]) => dir)
          .map(([label]) => ({ label, value: label, description: "Brief pack" })),
      );
    const directory = packs.get(taken[3]);
    if (!directory) return null;
    const files = entries(directory);
    if (files.length > 128 || !files.some((entry) => entry.name === "_shared.md" && entry.isFile()))
      return null;
    let remaining = 65536;
    const blocks: Item[] = [];
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md") || entry.name.startsWith("_")) continue;
      const file = path.join(directory, entry.name);
      if (!entry.isFile() || !lstatSync(file).isFile()) return null;
      const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > remaining) return null;
        const buffer = Buffer.alloc(remaining + 1);
        let size = 0;
        while (size < buffer.length) {
          const count = readSync(fd, buffer, size, buffer.length - size, size);
          if (!count) break;
          size += count;
        }
        if (size > remaining) return null;
        remaining -= size;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
        if (text.includes("\0")) return null;
        const label = entry.name.slice(0, -3);
        if (!name.test(label)) continue;
        const aliases = (parseBriefDocument(text).meta.aliases ?? "")
          .split(/[\s,]+/)
          .filter(Boolean);
        blocks.push({
          label,
          value: label,
          aliases,
          description: aliases.length ? `Brief block (${aliases.join(", ")})` : "Brief block",
        });
      } finally {
        closeSync(fd);
      }
    }
    const used = taken.slice(4).map((word) => word.toLowerCase());
    return choose([
      ...blocks.filter(
        (block) => !used.some((word) => block.label === word || block.aliases?.includes(word)),
      ),
      { label: "--", value: "--", description: "Add free-form instructions" },
    ]);
  } catch {
    return null;
  }
}

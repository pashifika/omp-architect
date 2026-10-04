/** Shared, side-effect-free brief v0.1 text format. Unknown placeholders remain literal. */
export function parseBriefDocument(raw: string) {
  const matter = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(raw);
  const meta: Record<string, string> = Object.create(null);
  if (matter)
    for (const line of matter[1].split(/\r?\n/)) {
      const field = /^([\w-]+):\s*(.*)$/.exec(line);
      if (field) meta[field[1]] = field[2].trim();
    }
  return { meta, body: matter ? raw.slice(matter[0].length) : raw };
}

export const fillBrief = (body: string, values: Record<string, string>) =>
  body.replace(/\{(\w+)\}/g, (written, key: string) =>
    Object.hasOwn(values, key) ? values[key] : written,
  );

export interface BriefBlock {
  name: string;
  aliases: readonly string[];
  body: string;
}

export function renderBriefText(
  shared: string,
  variable: string,
  blocks: readonly BriefBlock[],
  value: string,
  requested: readonly string[],
): string {
  const selected: BriefBlock[] = [];
  for (const name of requested.map((name) => name.toLowerCase())) {
    const block = blocks.find((item) => item.name === name || item.aliases.includes(name));
    if (!block) throw new Error(`Brief has no block for ${name}`);
    if (!selected.includes(block)) selected.push(block);
  }
  return fillBrief(shared, {
    var: value,
    [variable]: value,
    scopes: selected.map((block) => block.name).join(", "),
    blocks: selected
      .map((block) =>
        fillBrief(block.body, { var: value, [variable]: value, scope: block.name })
          .replace(/^(?:[ \t]*\r?\n)+/, "")
          .replace(/\s+$/, ""),
      )
      .join("\n\n"),
  });
}

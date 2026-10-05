import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadRasenAutoSkill } from "../src/auto/rasen.ts";

test("Rasen Auto native autoload admits the complete >64KiB workflow separately from change evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-skill-"));
  const file = path.join(root, ".omp/skills/rasen-auto/SKILL.md");
  const body = `Native workflow\n${"A complete instruction line\n".repeat(5000)}END_OF_WORKFLOW`;
  const content = `---\nname: rasen-auto\n---\n${body}`;
  await Bun.write(file, content);
  let invocation = "";
  try {
    const skill = await loadRasenAutoSkill(root, "Existing scoped change", {
      async buildSkillPromptMessage(source, input, kind) {
        expect(source.filePath).toBe(file);
        expect(input.args).toBe("Existing scoped change");
        invocation = kind ?? "";
        return {
          message: `Loaded from ${source.filePath}\n${body}\n${input.args}`,
          details: { name: source.name, path: source.filePath, lineCount: 5002 },
        };
      },
    });
    expect(invocation).toBe("autoload");
    expect(skill.bytes).toBeGreaterThan(65536);
    expect(skill.message).toContain(body);
    expect(skill.message).toContain("END_OF_WORKFLOW");
    expect(skill.sha256).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

for (const failure of ["identity", "oversize", "truncated", "changed", "aborted"] as const) {
  test(`Rasen Auto native admission rejects ${failure} without silent body loss`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auto-skill-"));
    const file = path.join(root, ".omp/skills/rasen-auto/SKILL.md");
    await Bun.write(
      file,
      `---\nname: ${failure === "identity" ? "rasen-apply-change" : "rasen-auto"}\n---\n${failure === "oversize" ? "x".repeat(256 * 1024) : "Exact workflow body"}`,
    );
    const abort = new AbortController();
    if (failure === "aborted") abort.abort();
    try {
      await expect(
        loadRasenAutoSkill(
          root,
          "Scoped task",
          {
            async buildSkillPromptMessage(source) {
              if (failure === "changed")
                await Bun.write(file, "---\nname: rasen-auto\n---\nChanged");
              return {
                message: failure === "truncated" ? "Exact workflow" : "Exact workflow body",
                details: { name: source.name, path: source.filePath, lineCount: 1 },
              };
            },
          },
          abort.signal,
        ),
      ).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { nativeRasenSkills, readRasenSkill, type NativeLoadedSkill } from "../src/auto/skills.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture(
  name = "rasen-review-cycle",
  body = "---\nname: rasen-review-cycle\n---\nActual skill instructions.\n",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-rasen-skill-"));
  roots.push(root);
  const baseDir = path.join(root, "native-plugin", "skills", "review");
  await fs.mkdir(baseDir, { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  await fs.writeFile(filePath, body);
  const skill: NativeLoadedSkill = {
    name,
    description: "Review, then fix within the skill's own loop",
    filePath,
    baseDir,
    source: "plugin",
  };
  return { root, skill, body };
}

test("catalogue preserves exact loaded descriptions and global/plugin/hidden skill references without reading bodies", async () => {
  const f = await fixture();
  const hidden = {
    ...f.skill,
    name: "rasen-continue-change",
    hide: true,
    source: "user",
    filePath: "/global/rasen/continue/SKILL.md",
    baseDir: "/global/rasen/continue",
  };
  const alias = {
    ...f.skill,
    name: "my-plugin/rasen-review-cycle~2",
    description: "Exact native alias description\nIncluding a second line",
  };
  // A catalogue of loaded metadata is deliberately independent of file reads.
  await fs.rm(f.skill.filePath);
  const catalog = nativeRasenSkills([
    f.skill,
    hidden,
    alias,
    { ...f.skill, name: "unrelated" },
    { ...f.skill, name: "rasen-auto" },
    { ...f.skill, name: "plugin/rasen-auto~2" },
  ]);
  expect(catalog.map((skill) => skill.name)).toEqual([f.skill.name, hidden.name, alias.name]);
  expect(catalog[0]).toEqual({ ...f.skill, reference: "skill://rasen-review-cycle" });
  expect(catalog[1]).toEqual({ ...hidden, reference: "skill://rasen-continue-change" });
  expect(catalog[2]).toEqual({ ...alias, reference: "skill://my-plugin/rasen-review-cycle~2" });
  expect(JSON.stringify(catalog)).not.toContain("Actual skill instructions");
});

test("catalogue never filters native Rasen skills through a phase or stage whitelist", async () => {
  const { skill } = await fixture();
  const names = [
    "rasen-apply-change",
    "rasen-continue-change",
    "rasen-verify-change",
    "rasen-review-cycle",
    "rasen-office-hours",
    "rasen-ship",
    "rasen-retain",
    "rasen-archive-change",
    "rasen-newly-installed-workflow",
  ];
  expect(
    nativeRasenSkills(names.map((name) => ({ ...skill, name }))).map((skill) => skill.name),
  ).toEqual(names);
  expect(nativeRasenSkills([])).toEqual([]);
});

test("catalogue rejects duplicate names, traversal, unsafe references and unbounded metadata explicitly", async () => {
  const { skill } = await fixture();
  expect(() => nativeRasenSkills([skill, skill])).toThrow("duplicate registered name");
  for (const change of [
    { name: "../rasen-review" },
    { name: "a/b/rasen-review" },
    { name: "rasen-review#suffix" },
    { name: "rasen-review\n" },
    { description: "x".repeat(8193) },
    { description: "unsafe\u202e" },
    { filePath: "relative.md" },
    { baseDir: "../relative" },
    { source: "x".repeat(257) },
    { containRoot: "relative" },
  ])
    expect(() => nativeRasenSkills([{ ...skill, ...change }])).toThrow("invalid or unbounded");
  expect(() =>
    nativeRasenSkills(
      Array.from({ length: 1025 }, (_, i) => ({ ...skill, name: `rasen-skill-${i}` })),
    ),
  ).toThrow("invalid or unbounded");
  expect(() =>
    nativeRasenSkills(
      Array.from({ length: 100 }, (_, i) => ({
        ...skill,
        name: `rasen-skill-${i}`,
        description: "x".repeat(8000),
      })),
    ),
  ).toThrow("invalid or unbounded");
});

test("selected skill reads the complete native-authorized body and full hash, including >64 KiB review-cycle", async () => {
  const f = await fixture(
    "plugin/rasen-review-cycle~2",
    "---\nname: rasen-review-cycle\n---\n" + "レビュー instructions\n".repeat(6000),
  );
  const selected = nativeRasenSkills([f.skill])[0];
  const read = await readRasenSkill(selected);
  expect(read.text).toBe(f.body);
  expect(read.sha256).toBe(createHash("sha256").update(f.body).digest("hex"));
  expect(read.reference).toBe("skill://plugin/rasen-review-cycle~2");
  expect(read.name).toBe(f.skill.name);
  await fs.writeFile(f.skill.filePath, `${f.body}Updated after native discovery`);
  expect((await readRasenSkill(selected)).sha256).not.toBe(read.sha256);
});

test("global linked skills are available and plugin containment matches native package scope", async () => {
  const f = await fixture();
  const target = path.join(f.root, "native-plugin", "shared-review.md");
  await fs.rename(f.skill.filePath, target);
  await fs.symlink(target, f.skill.filePath);
  expect((await readRasenSkill(nativeRasenSkills([f.skill])[0])).text).toBe(f.body);
  const contained = { ...f.skill, containRoot: path.join(f.root, "native-plugin") };
  expect((await readRasenSkill(nativeRasenSkills([contained])[0])).text).toBe(f.body);
  const outside = await fixture();
  await fs.rm(f.skill.filePath);
  await fs.symlink(outside.skill.filePath, f.skill.filePath);
  await expect(readRasenSkill(nativeRasenSkills([contained])[0])).rejects.toThrow(
    "outside its plugin root",
  );
});

test("selected complete skill rejects missing files, bad UTF-8, NUL, oversize files and cancellation", async () => {
  const f = await fixture();
  const selected = nativeRasenSkills([f.skill])[0];
  for (const content of ["", "   ", "\0", Buffer.from([0xff]), "x".repeat(262145)]) {
    await fs.writeFile(f.skill.filePath, content);
    await expect(readRasenSkill(selected)).rejects.toThrow();
  }
  await fs.writeFile(f.skill.filePath, "x".repeat(262144));
  expect((await readRasenSkill(selected)).text).toHaveLength(262144);
  await fs.rm(f.skill.filePath);
  await expect(readRasenSkill(selected)).rejects.toThrow("ENOENT");
  await fs.mkdir(f.skill.filePath);
  await expect(readRasenSkill(selected)).rejects.toThrow("regular file");
  const controller = new AbortController();
  controller.abort();
  await expect(readRasenSkill(selected, controller.signal)).rejects.toThrow();
  await expect(readRasenSkill({ ...selected, reference: "skill://other" })).rejects.toThrow(
    "invalid",
  );
});

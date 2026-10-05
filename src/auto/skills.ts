import type { Skill } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AutoPreflightError, diagnosticPath, systemErrorCode } from "./diagnostics.ts";

/** Only public AgentSession.skills metadata; no discovery or SDK runtime import. */
export type NativeLoadedSkill = Pick<
  Skill,
  "name" | "description" | "filePath" | "baseDir" | "source" | "hide"
> & {
  /** Newer native hosts use this to contain packaged plugin resources. */
  containRoot?: string;
};

export interface RasenSkill extends NativeLoadedSkill {
  reference: string;
}

export interface RasenSkillContent extends RasenSkill {
  text: string;
  sha256: string;
}

const MAX_CATALOGUE_SKILLS = 1024;
const MAX_CATALOGUE_BYTES = 256 * 1024;
export const MAX_RASEN_SKILL_BYTES = 256 * 1024;
const controls = /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const descriptionControls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const safeText = (value: unknown, maximum: number, empty = false): value is string =>
  typeof value === "string" &&
  (empty || value.length > 0) &&
  value.length <= maximum &&
  !controls.test(value);
const invalid = () =>
  new AutoPreflightError("Native Rasen skill catalogue has invalid or unbounded metadata");

/**
 * Use exactly the skills admitted by OMP, including hidden, global and packaged
 * skills. Descriptions suffice for Jev; listing never reads their full bodies.
 * Native collision aliases remain exact; a duplicate registered name is unsafe.
 */
export function nativeRasenSkills(loaded: readonly NativeLoadedSkill[]): RasenSkill[] {
  if (!Array.isArray(loaded) || loaded.length > 4096) throw invalid();
  const result: RasenSkill[] = [];
  const names = new Set<string>();
  for (const skill of loaded as readonly NativeLoadedSkill[]) {
    if (!skill || typeof skill.name !== "string") throw invalid();
    const leaf = skill.name.split("/").at(-1) ?? "";
    if (!leaf.startsWith("rasen-") || /^rasen-auto(?:~[0-9]+)?$/.test(leaf)) continue;
    const segments = skill.name.split("/");
    if (
      !safeText(skill.name, 256) ||
      segments.length > 2 ||
      segments.some(
        (segment) => !/^[\p{L}\p{N}_.~-]+$/u.test(segment) || segment === "." || segment === "..",
      ) ||
      typeof skill.description !== "string" ||
      skill.description.length > 8192 ||
      descriptionControls.test(skill.description) ||
      !safeText(skill.filePath, 4096) ||
      !path.isAbsolute(skill.filePath) ||
      !safeText(skill.baseDir, 4096) ||
      !path.isAbsolute(skill.baseDir) ||
      !safeText(skill.source, 256, true) ||
      (skill.hide !== undefined && typeof skill.hide !== "boolean") ||
      (skill.containRoot !== undefined &&
        (!safeText(skill.containRoot, 4096) || !path.isAbsolute(skill.containRoot)))
    )
      throw invalid();
    if (names.has(skill.name))
      throw new AutoPreflightError(
        "Native Rasen skill catalogue contains a duplicate registered name",
      );
    names.add(skill.name);
    result.push({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      source: skill.source,
      ...(skill.hide === undefined ? {} : { hide: skill.hide }),
      ...(skill.containRoot === undefined ? {} : { containRoot: skill.containRoot }),
      reference: `skill://${skill.name}`,
    });
    if (result.length > MAX_CATALOGUE_SKILLS) throw invalid();
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_CATALOGUE_BYTES) throw invalid();
  return result;
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Read only the selected native-authorized file, completely, with its full hash. */
export async function readRasenSkill(
  skill: RasenSkill,
  signal?: AbortSignal,
): Promise<RasenSkillContent> {
  signal?.throwIfAborted();
  const selected = nativeRasenSkills([skill])[0];
  if (!selected || selected.reference !== skill.reference) throw invalid();
  try {
    // OMP permits linked/global skill roots. Respect its optional plugin package
    // containment, rather than inventing a project-only/per-skill restriction.
    const resolved = await fs.realpath(selected.filePath);
    if (selected.containRoot) {
      const root = await fs.realpath(selected.containRoot);
      if (!within(root, resolved))
        throw new AutoPreflightError("Native Rasen skill resolves outside its plugin root");
    }
    const handle = await fs.open(
      resolved,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new AutoPreflightError("Native Rasen skill must be a regular file");
      if (stat.size > MAX_RASEN_SKILL_BYTES)
        throw new AutoPreflightError("Native Rasen skill exceeds the 256 KiB limit");
      const buffer = Buffer.alloc(MAX_RASEN_SKILL_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const read = await handle.read(buffer, length, buffer.length - length, length);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > MAX_RASEN_SKILL_BYTES)
        throw new AutoPreflightError("Native Rasen skill exceeds the 256 KiB limit");
      const bytes = buffer.subarray(0, length);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      if (!text.trim() || text.includes("\0"))
        throw new AutoPreflightError("Native Rasen skill must contain UTF-8 instructions");
      signal?.throwIfAborted();
      // Metadata identity comes from the native loader. A native collision alias
      // need not match raw frontmatter, and we do not reimplement that loader.
      return { ...selected, text, sha256: createHash("sha256").update(bytes).digest("hex") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal?.aborted) signal.throwIfAborted();
    if (error instanceof AutoPreflightError) throw error;
    throw new AutoPreflightError(
      `Cannot read complete UTF-8 native skill ${diagnosticPath(selected.name)} (${systemErrorCode(error)})`,
    );
  }
}

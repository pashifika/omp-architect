import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { digest, type ReviewMaterial } from "./core.ts";

// A narrow native scratch namespace, never a project path or general read capability.
export const reviewFilePattern = /^local:\/\/architect-review\/[a-zA-Z0-9_-]{1,80}\.md$/;
const artifactPattern = /^artifact:\/\/(0|[1-9][0-9]{0,15})$/;

export function reviewWrite(input: Record<string, unknown>, limit: number): boolean {
  return (
    typeof input.path === "string" &&
    reviewFilePattern.test(input.path) &&
    typeof input.content === "string" &&
    Buffer.byteLength(input.content, "utf8") <= limit &&
    Object.keys(input).every((key) => key === "path" || key === "content")
  );
}

/** Only a single literal host call is admitted through a closed plan/recovery gate. */
export function reviewCarrier(input: Record<string, unknown>, limit: number): boolean {
  if (
    input.language !== "js" ||
    input.reset !== true ||
    typeof input.code !== "string" ||
    input.async === true
  )
    return false;
  const match =
    /^(?:await tool\.write\((\{[\s\S]*\})\)|console\.log\(await tool\.write\((\{[\s\S]*\})\)\));?$/.exec(
      input.code.trim(),
    );
  if (!match) return false;
  try {
    const args = JSON.parse(match[1] ?? match[2]);
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    if (reviewWrite(args, limit)) return true;
    return (
      args.path === "xd://architect_checkpoint" &&
      typeof args.content === "string" &&
      Object.keys(args).every((key) => key === "path" || key === "content")
    );
  } catch {
    return false;
  }
}

/** Auto completion may run synchronously only in an otherwise effect-free Eval carrier. */
export function completionCarrier(input: Record<string, unknown>, limit: number): boolean {
  if (!reviewCarrier(input, limit) || typeof input.code !== "string") return false;
  const match =
    /^(?:await tool\.write\((\{[\s\S]*\})\)|console\.log\(await tool\.write\((\{[\s\S]*\})\)\));?$/.exec(
      input.code.trim(),
    );
  if (!match) return false;
  try {
    const args = JSON.parse(match[1] ?? match[2]);
    if (args.path !== "xd://architect_checkpoint" || typeof args.content !== "string") return false;
    const checkpoint = JSON.parse(args.content);
    return (
      checkpoint?.phase === "completion" &&
      Object.keys(checkpoint).every((key) => ["phase", "evidenceRef", "steps"].includes(key))
    );
  } catch {
    return false;
  }
}

async function readComplete(file: string, limit: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("Review evidence must be a regular UTF-8 file");
    if (before.size > limit)
      throw new Error(
        `Review evidence exceeds maxReviewBytes (${limit} bytes); no review was charged`,
      );
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const read = await handle.read(buffer, size, buffer.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size > limit)
      throw new Error(
        `Review evidence exceeds maxReviewBytes (${limit} bytes); no review was charged`,
      );
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || size !== after.size)
      throw new Error("Review evidence changed while being read; retry with a stable file");
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, size),
    );
    if (!content.trim() || content.includes("\0"))
      throw new Error("Review evidence must be non-empty UTF-8 text without NUL bytes");
    return content;
  } finally {
    await handle.close();
  }
}

async function artifactPath(ctx: ExtensionContext, ref: string): Promise<string> {
  const match = artifactPattern.exec(ref);
  if (!match) throw new Error("Expected a complete artifact:// numeric ID from this session");
  const root = ctx.sessionManager.getArtifactsDir();
  const file = await ctx.sessionManager.getArtifactPath(match[1]);
  if (!root || !file)
    throw new Error(`Review artifact ${ref} is unavailable in the originating session`);
  // Do not use the generic artifact resolver: it may fall back to another session.
  const relative = path.relative(await fs.realpath(root), await fs.realpath(file));
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("Review artifact escapes the originating session");
  return file;
}

/** Save exact bounded text through native session storage, never through project files. */
export async function saveAutoPayload(
  ctx: ExtensionContext,
  content: string,
  signal?: AbortSignal,
): Promise<{ ref: string; sha256: string; bytes: number }> {
  signal?.throwIfAborted();
  // Rasen's aggregate 64 KiB evidence plus JSON escaping, guidance, and fixed policy.
  const limit = 512 * 1024;
  const bytes = Buffer.byteLength(content, "utf8");
  if (!content.trim() || content.includes("\0") || bytes > limit)
    throw new Error("Auto payload must be bounded UTF-8 text");
  if (!ctx.sessionManager.getArtifactsDir() || !ctx.sessionManager.getArtifactManager())
    throw new Error("Native session artifact storage is unavailable for Auto");
  const id = await ctx.sessionManager.saveArtifact(content, "auto-run");
  if (id === undefined) throw new Error("OMP could not save the Auto payload");
  const ref = `artifact://${id}`;
  if ((await readComplete(await artifactPath(ctx, ref), limit, signal)) !== content)
    throw new Error("Saved Auto payload does not match the admitted bytes");
  return Object.freeze({ ref, sha256: digest(content), bytes });
}

/** Save through OMP, verify the persisted bytes, and retain an immutable in-process copy. */
export async function saveReviewMaterial(
  ctx: ExtensionContext,
  content: string,
  limit: number,
  source: ReviewMaterial["source"] = "authored",
  signal?: AbortSignal,
): Promise<ReviewMaterial> {
  signal?.throwIfAborted();
  const bytes = Buffer.byteLength(content, "utf8");
  if (!content.trim() || content.includes("\0"))
    throw new Error("Review evidence must be non-empty UTF-8 text without NUL bytes");
  if (bytes > limit)
    throw new Error(
      `Review evidence exceeds maxReviewBytes (${limit} bytes); no review was charged`,
    );
  if (!ctx.sessionManager.getArtifactsDir() || !ctx.sessionManager.getArtifactManager())
    throw new Error("Native session artifact storage is unavailable; use a persistent OMP session");
  const id = await ctx.sessionManager.saveArtifact(content, "architect-review");
  if (id === undefined) throw new Error("OMP could not save the review artifact");
  const ref = `artifact://${id}`;
  const persisted = await readComplete(await artifactPath(ctx, ref), limit, signal);
  if (persisted !== content)
    throw new Error("Saved review artifact does not match the admitted bytes");
  return Object.freeze({ ref, sha256: digest(content), bytes, content, source });
}

export async function loadReviewMaterial(
  ctx: ExtensionContext,
  ref: string,
  limit: number,
  signal?: AbortSignal,
): Promise<ReviewMaterial> {
  let file: string | null;
  if (artifactPattern.test(ref)) {
    file = await artifactPath(ctx, ref);
  } else if (reviewFilePattern.test(ref)) {
    file = await new LocalProtocolHandler().locate(parseInternalUrl(ref), {
      localProtocolOptions: ctx.localProtocolOptions ?? {
        getArtifactsDir: () => ctx.sessionManager.getArtifactsDir(),
        getSessionId: () => ctx.sessionManager.getSessionId(),
      },
    });
  } else {
    throw new Error(
      "evidenceRef must be artifact://ID from this session or local://architect-review/NAME.md; inline summaries and arbitrary paths are unsupported",
    );
  }
  if (!file) throw new Error(`Review evidence ${ref} is missing in this session`);
  const content = await readComplete(file, limit, signal);
  // Snapshot even existing artifacts: external modification cannot change the reviewed copy.
  return saveReviewMaterial(ctx, content, limit, "authored", signal);
}

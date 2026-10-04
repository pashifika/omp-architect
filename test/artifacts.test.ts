import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { LocalProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import {
  loadReviewMaterial,
  saveReviewMaterial,
  reviewCarrier,
  reviewWrite,
} from "../src/artifacts.ts";
import { digest } from "../src/core.ts";

async function fixture() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-review-"));
  const sessionManager = SessionManager.create(cwd, path.join(cwd, "sessions"));
  const localProtocolOptions = {
    getArtifactsDir: () => sessionManager.getArtifactsDir(),
    getSessionId: () => sessionManager.getSessionId(),
  };
  const ctx = { sessionManager, localProtocolOptions } as unknown as ExtensionContext;
  return {
    cwd,
    ctx,
    sessionManager,
    async local(content: string | Uint8Array) {
      const ref = "local://architect-review/evidence.md";
      const file = await new LocalProtocolHandler().locate(
        parseInternalUrl(ref),
        { localProtocolOptions },
        { create: true },
      );
      await fs.mkdir(path.dirname(file!), { recursive: true });
      await fs.writeFile(file!, content);
      return { ref, file: file! };
    },
    close: () => fs.rm(cwd, { recursive: true, force: true }),
  };
}

test("native review snapshot preserves every UTF-8 byte and binds mutable source to its digest", async () => {
  const f = await fixture();
  try {
    const body = Array.from(
      { length: 18 },
      (_, n) => `WHEN_${n}\n${'日本語🧪"\\\n'.repeat(350)}\nTHEN_${n}\n`,
    ).join("");
    const source = await f.local(body);
    const material = await loadReviewMaterial(f.ctx, source.ref, 131072);
    expect(material.content).toBe(body);
    expect(material.bytes).toBe(Buffer.byteLength(body));
    expect(material.sha256).toBe(digest(body));
    expect(material.ref).toMatch(/^artifact:\/\/\d+$/);
    expect(
      await fs.readFile((await f.sessionManager.getArtifactPath(material.ref.slice(11)))!, "utf8"),
    ).toBe(body);
    await fs.writeFile(source.file, "New content");
    expect(material.content).toBe(body);
    const changed = await loadReviewMaterial(f.ctx, source.ref, 131072);
    expect(changed.sha256).not.toBe(material.sha256);
    expect(changed.ref).not.toBe(material.ref);
  } finally {
    await f.close();
  }
});

test("reject oversized, empty, invalid UTF-8, NUL, directories and unsupported references without truncating", async () => {
  const f = await fixture();
  try {
    for (const content of ["x".repeat(1025), " ", "x\0y", new Uint8Array([255])]) {
      const source = await f.local(content);
      await expect(loadReviewMaterial(f.ctx, source.ref, 1024)).rejects.toThrow();
    }
    for (const ref of [
      "https://example.com/review",
      "/tmp/review",
      "artifact://0/path",
      "artifact://0?line=1",
      "local://architect-review/../secret.md",
      "local://other.md",
    ]) {
      await expect(loadReviewMaterial(f.ctx, ref, 1024)).rejects.toThrow();
    }
    const source = await f.local("replace with directory");
    await fs.unlink(source.file);
    await fs.mkdir(source.file);
    await expect(loadReviewMaterial(f.ctx, source.ref, 1024)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("artifact lookup is pinned to originating session, and unavailable native storage fails closed", async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    const foreign = await saveReviewMaterial(b.ctx, "Foreign session private evidence", 1024);
    await expect(loadReviewMaterial(a.ctx, foreign.ref, 1024)).rejects.toThrow(
      "originating session",
    );
    const own = await saveReviewMaterial(a.ctx, "Own session evidence", 1024);
    expect(own.ref).toBe(foreign.ref);
    expect((await loadReviewMaterial(a.ctx, own.ref, 1024)).content).toBe("Own session evidence");
    const inMemory = {
      sessionManager: SessionManager.inMemory(a.cwd),
    } as unknown as ExtensionContext;
    await expect(saveReviewMaterial(inMemory, "test", 1024)).rejects.toThrow(
      "persistent OMP session",
    );
  } finally {
    await a.close();
    await b.close();
  }
});

test("native local confinement rejects symlink escape", async () => {
  const a = await fixture();
  const b = await fixture();
  try {
    const source = await a.local("owned");
    const foreign = await b.local("not owned");
    await fs.unlink(source.file);
    await fs.symlink(foreign.file, source.file);
    await expect(loadReviewMaterial(a.ctx, source.ref, 1024)).rejects.toThrow();
  } finally {
    await a.close();
    await b.close();
  }
});

test("closed gates admit only bounded native review writes and exact single-call Eval carriers", () => {
  const args = { path: "local://architect-review/plan.md", content: "Review this" };
  expect(reviewWrite(args, 1024)).toBe(true);
  expect(reviewWrite({ ...args, path: "result.ts" }, 1024)).toBe(false);
  expect(reviewWrite({ ...args, content: "x".repeat(1025) }, 1024)).toBe(false);
  const carrier = `console.log(await tool.write(${JSON.stringify(args)}));`;
  expect(reviewCarrier({ language: "js", reset: true, code: carrier }, 1024)).toBe(true);
  expect(
    reviewCarrier(
      { language: "js", reset: true, code: carrier + " await tool.bash({command:'rm -rf x'})" },
      1024,
    ),
  ).toBe(false);
  expect(
    reviewCarrier(
      {
        language: "js",
        reset: true,
        code: "await tool.write({path:'local://architect-review/plan.md',content:await sideEffect()})",
      },
      1024,
    ),
  ).toBe(false);
  expect(
    reviewCarrier(
      {
        language: "js",
        reset: true,
        code:
          "console.log(await tool.write(" +
          JSON.stringify({ path: "xd://architect_checkpoint", content: "{}" }) +
          "))",
      },
      1024,
    ),
  ).toBe(true);
  expect(reviewCarrier({ language: "py", reset: true, code: carrier }, 1024)).toBe(false);
  expect(reviewCarrier({ language: "js", code: carrier }, 1024)).toBe(false);
});

test("UTF-8 BOM is preserved as part of the exact admitted file bytes", async () => {
  const f = await fixture();
  try {
    const body = "\ufeffReview complete evidence";
    const source = await f.local(body);
    const material = await loadReviewMaterial(f.ctx, source.ref, 1024);
    expect(material.content).toBe(body);
    expect(material.bytes).toBe(Buffer.byteLength(body));
    expect(material.sha256).toBe(digest(body));
  } finally {
    await f.close();
  }
});

test.skipIf(process.platform === "win32")(
  "native review input rejects a FIFO without blocking file admission",
  async () => {
    const f = await fixture();
    try {
      const source = await f.local("replace with FIFO");
      await fs.unlink(source.file);
      execFileSync("mkfifo", [source.file]);
      await expect(loadReviewMaterial(f.ctx, source.ref, 1024)).rejects.toThrow(
        "regular UTF-8 file",
      );
    } finally {
      await f.close();
    }
  },
);

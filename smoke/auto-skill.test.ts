import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildSkillPromptMessage } from "@oh-my-pi/pi-coding-agent";
import { loadRasenAutoSkill } from "../src/auto/rasen.ts";

test("builtin full generates the complete rasen-auto workflow for actual native autoload", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-native-auto-skill-"));
  const cwd = path.join(temp, "project");
  await fs.mkdir(cwd);
  try {
    const executable =
      process.env.RASEN_BIN ??
      (
        await Bun.file(
          path.resolve(import.meta.dir, "../node_modules/.cache/omp-architect/rasen-build.json"),
        ).json()
      ).executable;
    const init = spawnSync(executable, ["init", "--tools", "omp", "--profile", "full"], {
      cwd,
      shell: false,
      encoding: "utf8",
      timeout: 15000,
      env: {
        ...process.env,
        HOME: path.join(temp, "home"),
        XDG_CONFIG_HOME: path.join(temp, "config"),
        RASEN_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        CI: "1",
        NO_COLOR: "1",
      },
    });
    expect(init.status, init.stderr).toBe(0);
    const source = await Bun.file(path.join(cwd, ".omp/skills/rasen-auto/SKILL.md")).text();
    const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
    expect(Buffer.byteLength(body)).toBeGreaterThan(110000);
    const args = "Resume existing prepared native-fixture change; keep scope unchanged";
    const loaded = await loadRasenAutoSkill(cwd, args, { buildSkillPromptMessage });
    expect(loaded.message.replace(/\s/g, "")).toContain(body.replace(/\s/g, ""));
    expect(loaded.message).toContain(args);
    expect(loaded.message).toContain("rasen pipeline resume");
    expect(loaded.message).toContain("review-cycle");
    expect(loaded.message).toContain(body.slice(-200));
    expect(loaded.message).not.toContain("The user invoked");
    expect(loaded.bytes).toBe(Buffer.byteLength(source));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}, 30000);

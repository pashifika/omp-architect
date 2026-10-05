import { expect, test } from "bun:test";
import * as rasen from "../src/auto/rasen.ts";
import { autoRequest } from "../src/auto/instructions.ts";

test("Rasen adapter does not expose an Auto skill loader", () => {
  expect(Object.keys(rasen)).not.toContain("loadRasenAutoSkill");
});

test("Auto request selects existing skills from native facts for the requested outcome", () => {
  const guidance = "  Keep scope small\n  Run the focused tests first\n";
  const request = autoRequest("my-change", guidance);
  expect(request).toContain("user's requested outcome for existing Rasen change my-change");
  expect(request).toContain("next applicable existing non-Auto Rasen skill");
  expect(request).toContain("exact names and descriptions loaded by OMP");
  expect(request).toContain("current change facts and actual native work history");
  expect(request).toContain("No configured pipeline or auto-run.json is required");
  expect(request).toContain(
    "skills own their internal steps, review/fix loops, and source-owned files",
  );
  expect(request).toContain(
    "OMP native state, artifact references, tools, roles, and job tracking",
  );
  expect(request).toContain("does not replace skills or add a separate completion-review workflow");
  expect(request).toContain(
    "Planning, continue, apply, verification, review, ship, retain, and archive skills remain candidates when applicable",
  );
  expect(request).not.toContain("installed rasen-auto");
  expect(request).not.toContain("small-feature");
  expect(request).toContain("normal approvals");
  expect(request).toContain("selecting a skill is not authorization for consequential actions");
  expect(request).toContain(
    "required approval still applies before publishing, merging, deploying, deleting, or archiving",
  );
  expect(request.endsWith(`\n\n${guidance}`)).toBe(true);
});

test("shared Architect guidance keeps ordinary completion outside active Auto", async () => {
  const prompt = await Bun.file(new URL("../src/prompts/orchestration.md", import.meta.url)).text();
  expect(prompt).toContain("Outside active Rasen Auto, before saying the work is complete");
  expect(prompt).toContain("submit phase=completion with fresh evidence");
  expect(prompt).toContain(
    "During active Rasen Auto, use auto_step at the selected skill’s boundaries",
  );
  expect(prompt).toContain("The selected Rasen skill owns its reviews");
  expect(prompt).toContain(
    "evidence-based finish selection and native settlement own Auto scheduler completion",
  );
  expect(prompt).toContain("Do not add phase=completion as an outer review gate");
  expect(prompt).toContain("Plan/recovery checkpoints and normal permissions still apply");
});

test("reviewer leaf returns evidence while the selected skill owns its loop and records", async () => {
  const prompt = await Bun.file(new URL("../agents/omp-reviewer.md", import.meta.url)).text();
  expect(prompt).toContain("Return evidence to Main");
  expect(prompt).toContain("follows the selected Rasen skill’s review-cycle when applicable");
  expect(prompt).toContain("the skill owns its internal loop and records");
  expect(prompt).toContain(
    "Do not edit implementation, publish, change scope, delegate or run architect checkpoints",
  );
  expect(prompt).not.toContain("owns Rasen run-state");
});

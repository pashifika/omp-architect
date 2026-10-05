import { expect, test } from "bun:test";
import * as rasen from "../src/auto/rasen.ts";
import { autoRequest } from "../src/auto/instructions.ts";

test("Rasen adapter does not expose an Auto skill loader", () => {
  expect(Object.keys(rasen)).not.toContain("loadRasenAutoSkill");
});

test("Auto request names the extension-owned flow and retains the user's scoped guidance", () => {
  const guidance = "  Keep scope small\n  Run the focused tests first\n";
  const request = autoRequest("prepared-change", guidance);
  expect(request).toContain("existing Rasen change prepared-change");
  expect(request).toContain("extension-owned Auto flow");
  expect(request).not.toContain("installed rasen-auto");
  expect(request).toContain("normal approvals");
  expect(request).toContain("never authorizes publishing, merging, new planning, expanded scope");
  expect(request.endsWith(`\n\n${guidance}`)).toBe(true);
});

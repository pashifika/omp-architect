import { expect, test } from "bun:test";
import {
  AutoPreflightError,
  type AutoPreflightStage,
  autoCompletionDiagnostic,
  autoPreflightDiagnostic,
  diagnosticPath,
  WorkspaceEvidenceError,
} from "../src/auto/diagnostics.ts";

test("preflight shows only integration-owned diagnostics and allowlisted OS codes", () => {
  const secret = "provider-token PRIVATE CONTENT\x1b[31m";
  for (const error of [
    new Error(secret),
    Object.assign(new Error(secret), { code: secret }),
    secret,
  ]) {
    const message = autoPreflightDiagnostic("artifact storage", error);
    expect(message).toContain("[artifact storage]");
    expect(message).not.toContain(secret);
    expect(message).toContain("raw error details withheld");
  }
  expect(autoPreflightDiagnostic("artifact storage", { code: "ENOSPC" })).toContain("ENOSPC");
  expect(
    autoPreflightDiagnostic("change snapshot", new AutoPreflightError("Expected local change")),
  ).toContain("Expected local change");
  expect(diagnosticPath("a\x1b[31m\n\u202eb")).toBe("a?[31m??b");
  expect(diagnosticPath("x".repeat(1000))).toHaveLength(240);
});

test("completion diagnostics retain actionable stage guidance and redact untrusted values", () => {
  const secret = "PRIVATE PROVIDER CONTENT\x1b[31m";
  for (const stage of ["change snapshot", "workflow", "validation", "review"] as const) {
    for (const error of [secret, { message: secret, code: secret }, null, undefined]) {
      const message = autoCompletionDiagnostic(stage, error);
      expect(message).toContain(`[${stage}]`);
      expect(message).toContain("raw error details withheld");
      expect(message).not.toContain(secret);
      expect(message).not.toContain("undefined");
    }
  }
  expect(autoCompletionDiagnostic("validation", new Error(secret))).toContain(
    "rasen validate <change> --type change --strict --json",
  );
  const workspace = autoCompletionDiagnostic(
    "change snapshot",
    new WorkspaceEvidenceError("Cannot read the Git-inventoried project file"),
  );
  expect(workspace).toContain("Check the named project path and its link target");
  expect(workspace).not.toContain("rasen status");
});

test("supported admission diagnostics do not require a generated Auto workflow skill", () => {
  const stages: AutoPreflightStage[] = [
    "confirmation",
    "change snapshot",
    "workflow",
    "artifact storage",
    "native delivery",
  ];
  for (const stage of stages) {
    const message = autoPreflightDiagnostic(stage, { code: "ENOENT" });
    expect(message).toContain(`[${stage}]`);
    expect(message).toContain("ENOENT");
    expect(message).not.toContain("rasen-auto/SKILL.md");
    expect(message).not.toContain("full profile");
    expect(message).not.toContain("undefined");
  }
});

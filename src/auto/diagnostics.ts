/** Only messages constructed by this integration may reach preflight notifications.
 * Never expose arbitrary host exceptions, CLI output, environment or file contents. */
export class AutoPreflightError extends Error {}

/** Code inventory failures need workspace guidance, not Rasen status guidance. */
export class WorkspaceEvidenceError extends AutoPreflightError {}

export type AutoPreflightStage =
  | "confirmation"
  | "change snapshot"
  | "workflow"
  | "artifact storage"
  | "native delivery";

export function systemErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" &&
    new Set([
      "ENOENT",
      "EACCES",
      "EPERM",
      "ENOSPC",
      "EROFS",
      "EIO",
      "EMFILE",
      "ENFILE",
      "ENOTDIR",
      "ELOOP",
    ]).has(code)
    ? code
    : "unknown error";
}

/** Paths are diagnostic metadata, never terminal controls or unbounded payloads. */
export function diagnosticPath(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "?").slice(0, 240);
}

export function autoPreflightDiagnostic(stage: AutoPreflightStage, error: unknown): string {
  const hints: Record<AutoPreflightStage, string> = {
    confirmation: "Retry the confirmation dialog in an interactive OMP session",
    "change snapshot":
      "Check the named local change and run rasen status --change <change> --json locally",
    workflow: "Run rasen pipeline resume <change> --json locally and inspect the recorded pipeline",
    "artifact storage":
      "Use a persistent OMP session and check its artifact storage permissions and free space",
    "native delivery": "Check the native OMP session before retrying delivery",
  };
  const detail =
    error instanceof AutoPreflightError
      ? error.message
      : `Operation failed (${systemErrorCode(error)}); raw error details withheld`;
  const hint =
    error instanceof WorkspaceEvidenceError
      ? "Check the named project path and its link target; Auto only verifies Git-inventoried project files"
      : hints[stage];
  return `Auto preflight failed [${stage}]: ${detail}. ${hint}`;
}

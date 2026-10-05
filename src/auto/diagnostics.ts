/** Only messages constructed by this integration may reach failure diagnostics.
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

export type AutoCompletionStage = "change snapshot" | "workflow" | "validation" | "review";
export type AutoStepStage = "change snapshot" | "workflow" | "native verification" | "advice";

/** Preserve the source of concurrent observations without treating raw errors as trusted. */
export class AutoObservationError extends Error {
  constructor(
    readonly stage: "change snapshot" | "workflow",
    cause: unknown,
  ) {
    super("Auto observation failed", { cause });
  }
}

export async function autoObservation<T>(
  stage: "change snapshot" | "workflow",
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw new AutoObservationError(stage, error);
  }
}

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

function diagnosticDetail(error: unknown): string {
  return error instanceof AutoPreflightError
    ? error.message
    : `Operation failed (${systemErrorCode(error)}); raw error details withheld`;
}

// Keep the public diagnostic boundary labels for callers and saved diagnostics.
// A workflow observation means native skills and current facts, not a required pipeline.
const workflowHint =
  "Check the existing Rasen skills loaded by this OMP session and current change/native history; inspect optional skill-owned records if present, without requiring a pipeline or auto-run.json";

export function autoStepDiagnostic(stage: AutoStepStage, error: unknown): string {
  const hints: Record<AutoStepStage, string> = {
    "change snapshot":
      "Check the named local change and run rasen status --change <change> --json locally",
    workflow: workflowHint,
    "native verification":
      "Check the complete native worker artifacts and their settled task receipts",
    advice:
      "Check the configured TypeSafe Jev and Architect fallback availability before restarting Auto",
  };
  const hint =
    error instanceof WorkspaceEvidenceError
      ? "Check the named project path and its link target; Auto only verifies Git-inventoried project files"
      : hints[stage];
  return `Auto stage failed [${stage}]: ${diagnosticDetail(error)}. ${hint}. Completion is unverified`;
}

export function autoCompletionDiagnostic(stage: AutoCompletionStage, error: unknown): string {
  const hints: Record<AutoCompletionStage, string> = {
    "change snapshot":
      "Check the named local change and run rasen status --change <change> --json locally",
    workflow: workflowHint,
    validation: "Run rasen validate <change> --type change --strict --json locally",
    review: "Check the native Architect review status before submitting fresh completion evidence",
  };
  const hint =
    error instanceof WorkspaceEvidenceError
      ? "Check the named project path and its link target; Auto only verifies Git-inventoried project files"
      : hints[stage];
  return `Auto completion failed [${stage}]: ${diagnosticDetail(error)}. ${hint}. No completion approval is available`;
}

export function autoPreflightDiagnostic(stage: AutoPreflightStage, error: unknown): string {
  const hints: Record<AutoPreflightStage, string> = {
    confirmation: "Retry the confirmation dialog in an interactive OMP session",
    "change snapshot":
      "Check the named local change and run rasen status --change <change> --json locally",
    workflow: workflowHint,
    "artifact storage":
      "Use a persistent OMP session and check its artifact storage permissions and free space",
    "native delivery": "Check the native OMP session before retrying delivery",
  };
  const hint =
    error instanceof WorkspaceEvidenceError
      ? "Check the named project path and its link target; Auto only verifies Git-inventoried project files"
      : hints[stage];
  return `Auto preflight failed [${stage}]: ${diagnosticDetail(error)}. ${hint}`;
}

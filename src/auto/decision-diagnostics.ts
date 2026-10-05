import { JevError } from "./decision.ts";

export type DecisionFailureCode =
  | "DECISION_TIMEOUT"
  | "DECISION_CANCELLED"
  | "FALLBACK_ROLE_UNAVAILABLE"
  | "FALLBACK_NO_RESPONSE"
  | "FALLBACK_INVALID_RESPONSE";

/** Only integration-owned codes, never arbitrary exception text, reach status. */
export class DecisionFailure extends Error {
  constructor(readonly code: DecisionFailureCode) {
    super(code);
  }
}

const safeCodes = new Set([
  "JEV_INVALID_CONFIG",
  "JEV_INVALID_EVIDENCE",
  "JEV_CATALOG_TOO_LARGE",
  "JEV_MISSING_API_KEY",
  "JEV_INVALID_API_KEY",
  "JEV_ABORTED",
  "JEV_TIMEOUT",
  "JEV_HTTP_ERROR",
  "JEV_NETWORK_ERROR",
  "JEV_RESPONSE_TOO_LARGE",
  "JEV_INVALID_RESPONSE",
  "JEV_REQUEST_TOO_LARGE",
  "DECISION_TIMEOUT",
  "DECISION_CANCELLED",
  "FALLBACK_ROLE_UNAVAILABLE",
  "FALLBACK_NO_RESPONSE",
  "FALLBACK_INVALID_RESPONSE",
]);

export function decisionFailureCode(error: unknown): string {
  return (error instanceof JevError || error instanceof DecisionFailure) &&
    safeCodes.has(error.code)
    ? error.code
    : "PROVIDER_ERROR";
}

export interface DecisionAttempt {
  provider: "jev" | "architect";
  outcome: "accepted" | "uncertain" | "low_confidence" | "invalid_response" | "error";
  choice?: string;
  confidence?: number;
  errorCode?: string;
  elapsedMs: number;
  timeoutMs: number;
}

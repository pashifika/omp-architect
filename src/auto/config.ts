import * as path from "node:path";

export interface AutoConfig {
  enabled: boolean;
  maxSteps: number;
  maxToolCalls: number;
  maxStalls: number;
  maxDurationMs: number;
  cliTimeoutMs: number;
  decisionTimeoutMs: number;
  maxEvidenceChars: number;
  minConfidence: number;
  maxFallbacks: number;
  fallback: "architect" | "stop";
  rasenExecutable: string;
}

export const autoDefaults: AutoConfig = {
  // Allows an explicit, confirmed /auto start; never starts or resumes a run itself.
  enabled: true,
  // OMP 18.5.1 itself caps hidden session-stop continuations at eight.
  maxSteps: 8,
  maxToolCalls: 80,
  maxStalls: 3,
  maxDurationMs: 600000,
  cliTimeoutMs: 5000,
  decisionTimeoutMs: 8000,
  maxEvidenceChars: 12000,
  minConfidence: 0.8,
  maxFallbacks: 2,
  fallback: "architect",
  rasenExecutable: "rasen",
};

export function parseAutoConfig(value: unknown): AutoConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("auto.json must contain an object");
  const input = value as Record<string, unknown>;
  const result = { ...autoDefaults };
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(autoDefaults, key)) throw new Error(`Unknown auto option: ${key}`);
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("enabled must be boolean");
    result.enabled = input.enabled;
  }
  const ranges = {
    maxSteps: [1, 8],
    maxToolCalls: [1, 500],
    maxStalls: [1, 8],
    maxDurationMs: [1000, 3600000],
    cliTimeoutMs: [100, 5000],
    decisionTimeoutMs: [100, 8000],
    maxEvidenceChars: [1000, 24000],
    maxFallbacks: [0, 8],
  } as const;
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (input[key] === undefined) continue;
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < min || Number(input[key]) > max)
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    result[key as keyof typeof ranges] = input[key] as number;
  }
  if (input.minConfidence !== undefined) {
    if (
      typeof input.minConfidence !== "number" ||
      !Number.isFinite(input.minConfidence) ||
      input.minConfidence < 0.5 ||
      input.minConfidence > 1
    )
      throw new Error("minConfidence must be between 0.5 and 1");
    result.minConfidence = input.minConfidence;
  }
  if (input.fallback !== undefined) {
    if (input.fallback !== "architect" && input.fallback !== "stop")
      throw new Error("fallback must be architect or stop");
    result.fallback = input.fallback;
  }
  if (input.rasenExecutable !== undefined) {
    if (
      typeof input.rasenExecutable !== "string" ||
      !input.rasenExecutable.trim() ||
      input.rasenExecutable.length > 4096 ||
      /[\r\n\0]/.test(input.rasenExecutable)
    )
      throw new Error("rasenExecutable must be one executable path, never a shell command");
    result.rasenExecutable = input.rasenExecutable;
  }
  return result;
}

export async function loadAutoConfig(cwd: string): Promise<AutoConfig> {
  try {
    return parseAutoConfig(await Bun.file(path.join(cwd, ".omp", "auto.json")).json());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseAutoConfig({});
    throw error;
  }
}

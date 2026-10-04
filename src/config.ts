import * as path from "node:path";

export interface Config {
  roles: { implementation: string; research: string; architect: string };
  repeatedErrorThreshold: number;
  substantialPlanSteps: number;
  reviews: { min: number; max: number };
  reviewTimeoutMs: number;
  maxEvidenceChars: number;
}

export const defaults: Config = {
  roles: { implementation: "implementation", research: "research", architect: "architect" },
  repeatedErrorThreshold: 2,
  substantialPlanSteps: 3,
  reviews: { min: 1, max: 3 },
  reviewTimeoutMs: 120000,
  maxEvidenceChars: 24000,
};

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("architect.json must contain an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown architect option: ${key}`);
  }
  const result: Config = {
    ...defaults,
    roles: { ...defaults.roles },
    reviews: { ...defaults.reviews },
  };
  if (input.roles !== undefined) {
    if (!input.roles || typeof input.roles !== "object" || Array.isArray(input.roles))
      throw new Error("roles must contain role names");
    for (const [key, role] of Object.entries(input.roles)) {
      if (!Object.hasOwn(defaults.roles, key)) throw new Error(`Unknown role purpose: ${key}`);
      if (typeof role !== "string" || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(role) || role === "default")
        throw new Error(`${key} must be a role name (not a model selector, @alias, or default)`);
      result.roles[key as keyof Config["roles"]] = role;
    }
  }
  if (input.reviews !== undefined) {
    if (!input.reviews || typeof input.reviews !== "object" || Array.isArray(input.reviews))
      throw new Error("reviews must contain min and max");
    const range = input.reviews as Record<string, unknown>;
    if (Object.keys(range).some((key) => key !== "min" && key !== "max"))
      throw new Error("Unknown reviews option");
    const min = range.min ?? defaults.reviews.min;
    const max = range.max ?? defaults.reviews.max;
    if (
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      (min as number) < 1 ||
      (min as number) > (max as number) ||
      (max as number) > 8
    )
      throw new Error("reviews must satisfy 1 <= min <= max <= 8");
    result.reviews = { min: min as number, max: max as number };
  }
  const limits: Record<Exclude<keyof Config, "roles" | "reviews">, [number, number]> = {
    repeatedErrorThreshold: [2, 10],
    substantialPlanSteps: [2, 20],

    reviewTimeoutMs: [100, 120000],
    maxEvidenceChars: [1000, 100000],
  };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (input[key] === undefined) continue;
    if (
      !Number.isSafeInteger(input[key]) ||
      (input[key] as number) < min ||
      (input[key] as number) > max
    )
      throw new Error(`${key} must be an integer from ${min} to ${max}`);
    result[key as Exclude<keyof Config, "roles" | "reviews">] = input[key] as number;
  }
  return result;
}

export async function loadConfig(cwd: string): Promise<Config> {
  try {
    return parseConfig(await Bun.file(path.join(cwd, ".omp", "architect.json")).json());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw error;
  }
}

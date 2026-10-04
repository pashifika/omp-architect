import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type Mapping = Record<string, unknown>;

function mapping(value: unknown, context: string): Mapping {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context}: expected a YAML mapping`);
  }
  return value as Mapping;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function checkTimeout(value: unknown, context: string): void {
  assert(
    typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 30,
    `${context}: set an explicit timeout-minutes between 1 and 30`,
  );
}

function checkAction(
  reference: unknown,
  source: string,
  context: string,
  seen: Map<string, number>,
): void {
  assert(typeof reference === "string", `${context}: uses must be a string`);
  assert(
    /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/.test(reference),
    `${context}: action references must use a full, immutable 40-character SHA`,
  );
  // Parse the YAML for structure, then inspect the original line for its comment.
  // Quoted references are allowed; multiline references are deliberately not.
  const references = source.split(/\r?\n/).filter((line) => {
    const match =
      /^\s*(?:-\s+)?uses:\s*["']?([^\s"'#]+)["']?\s+#\s+(v\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?:\s|$)/.exec(
        line,
      );
    return match?.[1] === reference;
  });
  const occurrences = (seen.get(reference) ?? 0) + 1;
  seen.set(reference, occurrences);
  assert(
    references.length >= occurrences,
    `${context}: add a trailing version comment, such as # v1.2.3`,
  );
}

const directory = new URL("../.github/workflows/", import.meta.url);
const files = (await readdir(directory)).filter((file) => /\.ya?ml$/.test(file)).sort();
assert(files.length > 0, "No workflows found; the check would verify nothing");

let actions = 0;
for (const file of files) {
  const source = await readFile(new URL(file, directory), "utf8");
  const seen = new Map<string, number>();
  const workflow = mapping(Bun.YAML.parse(source), file);
  const permissions = mapping(workflow.permissions, `${file} permissions`);
  assert(
    Object.keys(permissions).length === 1 && permissions.contents === "read",
    `${file}: workflow permissions must be contents: read only`,
  );
  const concurrency = mapping(workflow.concurrency, `${file} concurrency`);
  assert(
    typeof concurrency.group === "string" && concurrency["cancel-in-progress"] === true,
    `${file}: define a concurrency group with cancel-in-progress: true`,
  );
  const jobs = mapping(workflow.jobs, `${file} jobs`);
  assert(Object.keys(jobs).length > 0, `${file}: no jobs to check`);
  for (const [name, value] of Object.entries(jobs)) {
    const context = `${file} job ${name}`;
    const job = mapping(value, context);
    checkTimeout(job["timeout-minutes"], context);
    assert(
      job.permissions === undefined,
      `${context}: inherit least-privilege workflow permissions`,
    );
    assert(Array.isArray(job.steps) && job.steps.length > 0, `${context}: expected nonempty steps`);
    for (const [index, value] of job.steps.entries()) {
      const stepContext = `${context} step ${index + 1}`;
      const step = mapping(value, stepContext);
      checkTimeout(step["timeout-minutes"], stepContext);
      if (step.uses === undefined) continue;
      checkAction(step.uses, source, stepContext, seen);
      actions++;
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        const options = mapping(step.with, `${stepContext} with`);
        assert(
          options["persist-credentials"] === false,
          `${stepContext}: never persist checkout credentials`,
        );
      }
    }
  }

  if (file === "ci.yml") {
    const triggers = mapping(workflow.on, `${file} triggers`);
    const pushes = mapping(triggers.push, `${file} push trigger`);
    assert(
      JSON.stringify(pushes.branches) === JSON.stringify(["main"]) &&
        Object.hasOwn(triggers, "pull_request"),
      `${file}: run for pull requests and pushes to the main default branch`,
    );
    const gate = mapping(jobs.ci, `${file} ci gate`);
    assert(gate.name === "ci", `${file}: preserve the stable ci check name`);
    assert(
      gate.if === "always()" || gate.if === "${{ always() }}",
      `${file}: ci must run with if: always() even when a prerequisite fails`,
    );
    const expected = Object.keys(jobs)
      .filter((name) => name !== "ci")
      .sort();
    assert(
      Array.isArray(gate.needs) &&
        expected.length > 0 &&
        JSON.stringify([...gate.needs].sort()) === JSON.stringify(expected),
      `${file}: ci needs must include every other job exactly once`,
    );
  }
  console.log(`workflows: ${join(".github/workflows", file)} passed`);
}
assert(actions > 0, "No action references found; the pin check would verify nothing");
console.log(
  `workflows: ${files.length} workflow(s), ${actions} immutable action reference(s) checked`,
);

// Desired-state files are reviewed with code, but this check neither applies
// them nor queries GitHub's live settings. The aggregate name is shared policy.
const ruleset = mapping(
  JSON.parse(await readFile(new URL("../.github/rulesets/main.json", import.meta.url), "utf8")),
  "main ruleset",
);
assert(
  ruleset.name === "main" && ruleset.target === "branch" && ruleset.enforcement === "active",
  "main ruleset: expected an active branch ruleset named main",
);
assert(
  Array.isArray(ruleset.bypass_actors) && ruleset.bypass_actors.length === 0,
  "main ruleset: no bypass actors are allowed",
);
const refs = mapping(mapping(ruleset.conditions, "ruleset conditions").ref_name, "ruleset refs");
assert(
  JSON.stringify(refs.include) === JSON.stringify(["~DEFAULT_BRANCH"]) &&
    JSON.stringify(refs.exclude) === "[]",
  "main ruleset: target only the default branch with no exclusions",
);
assert(Array.isArray(ruleset.rules), "main ruleset: expected rules");
const rules = ruleset.rules.map((value) => mapping(value, "main ruleset rule"));
assert(
  JSON.stringify(rules.map((rule) => rule.type).sort()) ===
    JSON.stringify(["deletion", "non_fast_forward", "pull_request", "required_status_checks"]),
  "main ruleset: protect deletion, force pushes, pull requests and required checks exactly once",
);
const pullRequest = mapping(
  rules.find((rule) => rule.type === "pull_request")?.parameters,
  "main pull request parameters",
);
assert(
  pullRequest.required_review_thread_resolution === true &&
    JSON.stringify(pullRequest.allowed_merge_methods) === JSON.stringify(["merge"]),
  "main ruleset: require resolved review threads and merge commits",
);
const checks = mapping(
  rules.find((rule) => rule.type === "required_status_checks")?.parameters,
  "main required checks",
);
assert(
  checks.strict_required_status_checks_policy === true &&
    checks.do_not_enforce_on_create === false &&
    Array.isArray(checks.required_status_checks) &&
    checks.required_status_checks.length === 1 &&
    mapping(checks.required_status_checks[0], "main required check").context === "ci",
  "main ruleset: require exactly the stable ci gate with strict up-to-date checks",
);
console.log("rulesets: main desired state validated (live GitHub enforcement is not checked)");

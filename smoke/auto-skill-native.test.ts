import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { createAssistantMessageEventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  Settings,
  type ExtensionUIContext,
} from "@oh-my-pi/pi-coding-agent";
import { loadSkillsFromDir } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { extensionFactory } from "../src/extension.ts";
import { readRasenSnapshot } from "../src/auto/rasen.ts";
import { readAutoHistory } from "../src/auto/journal.ts";
import type { NativeActionAdmission } from "../src/auto/evidence.ts";
import { withAgentDir } from "./isolated-host.ts";

const commit = "f0ae20d19a30c265ad3f3ffaaa5bb3cd148d12dd";
const change = "native-skill-proof";
const taskText = "## 1. Implementation\n\n- [ ] 1.1 Implement isolated echo\n";
const artifactBodies: Record<string, Record<string, string>> = {
  proposal: {
    "proposal.md":
      "## Why\nExercise native skill selection without a pipeline.\n\n## What Changes\n- Add an isolated echo function.\n\n## Capabilities\n### New Capabilities\n- `echo`: Return input unchanged.\n### Modified Capabilities\nNone.\n\n## Impact\nOnly this temporary fixture.\n",
  },
  design: {
    "design.md":
      "## Context\nAn isolated non-UI echo fixture, without authentication or external effects.\n\n## Decisions\nReturn the input text unchanged, including whitespace.\n",
  },
  specs: {
    "specs/echo/spec.md":
      "## ADDED Requirements\n\n### Requirement: Echo\nThe system SHALL return the input text unchanged.\n\n#### Scenario: Whitespace\n- **WHEN** input is ` hello `\n- **THEN** output is ` hello `\n",
  },
  tasks: { "tasks.md": taskText },
};
type Boundary = {
  action?: { actionId: string; skill: { name: string }; admission: NativeActionAdmission };
  finishProposed?: boolean;
  status?: string;
  error?: string;
};
type Call = { name: string; arguments: Record<string, unknown> };
type Execution = {
  id: string;
  actionId: string;
  skill: string;
  role: "omp-worker" | "omp-reviewer";
  purpose: string;
  calls: Call[];
  report: Record<string, unknown>;
  decisionCount: number;
};

/**
 * Actual built Rasen CLI/generated skills/parser/UI read handler and native OMP
 * Main/task/read/write/Bash/yield transport. Jev and model responses are scripted;
 * business effects are an isolated echo fixture, never live model judgment,
 * publication or archive. Native MemorySessionStorage excludes OS publish-lock
 * and persistent journal behavior from this proof.
 */
async function skillFixture(deniedShip = false) {
  const stamp = JSON.parse(
    await fs.readFile(
      path.resolve(import.meta.dir, "../node_modules/.cache/omp-architect/rasen-build.json"),
      "utf8",
    ),
  );
  expect(stamp.commit).toBe(commit);
  const executable = process.env.RASEN_BIN ?? stamp.executable;
  const installedRoot = path.dirname(path.dirname(await fs.realpath(stamp.executable)));
  const parser = await import(
    pathToFileURL(path.join(installedRoot, "dist/core/pipeline-registry/run-state.js")).href
  );
  const uiRuns = await import(
    pathToFileURL(path.join(installedRoot, "dist/core/management-api/runs.js")).href
  );
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-skill-native-")));
  const agentDir = path.join(cwd, "isolated-agent");
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  const oldRasenHome = process.env.RASEN_HOME;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.RASEN_HOME = path.join(cwd, "isolated-rasen");
  await fs.mkdir(process.env.RASEN_HOME, { recursive: true });
  await fs.writeFile(
    path.join(process.env.RASEN_HOME, "config.json"),
    JSON.stringify({ profile: "full" }),
  );
  refreshDirsFromEnv();
  const cli = (args: string[]) => {
    const result = spawnSync(executable, args, {
      cwd,
      encoding: "utf8",
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: path.join(cwd, "home"),
        XDG_CONFIG_HOME: path.join(cwd, "config"),
        RASEN_AGENT_RUNTIME: "omp",
        RASEN_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        CI: "1",
        NO_COLOR: "1",
      },
    });
    if (result.error || result.status !== 0)
      throw new Error(`Built Rasen ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  expect(cli(["--version"]).trim()).toBe("0.1.8 (dev.local f0ae20d)");
  cli(["init", "--tools", "omp"]);
  await fs.rm(path.join(cwd, ".omp", "skills", "rasen-auto"), { recursive: true, force: true });
  cli(["new", "change", change, "--schema", "spec-driven", "--json"]);
  const changeDir = path.join(cwd, "rasen", "changes", change);
  const initial = await readRasenSnapshot(cwd, change, { executable });
  expect(initial.state).toBe("blocked");
  expect(initial.skillRecord?.kind).toBe("absent");
  expect(await Bun.file(path.join(changeDir, "auto-run.json")).exists()).toBe(false);
  expect(await Bun.file(path.join(changeDir, "tasks.md")).exists()).toBe(false);
  const loaded = await loadSkillsFromDir({
    dir: path.join(cwd, ".omp", "skills"),
    source: "fixture:project",
  });
  expect(loaded.warnings).toEqual([]);
  expect(loaded.skills.some((skill) => skill.name === "rasen-auto")).toBe(false);
  for (const name of [
    "rasen-continue-change",
    "rasen-apply-change",
    "rasen-verify-change",
    "rasen-review-cycle",
    "rasen-review",
    "rasen-ship",
  ])
    expect(loaded.skills.some((skill) => skill.name === name)).toBe(true);
  const bodies = new Map(
    await Promise.all(
      loaded.skills.map(
        async (skill) => [skill.name, await fs.readFile(skill.filePath, "utf8")] as const,
      ),
    ),
  );
  await Bun.write(
    path.join(cwd, ".omp", "auto.json"),
    JSON.stringify({ rasenExecutable: executable, maxEvidenceChars: 24000 }),
  );
  for (const name of ["omp-worker", "omp-reviewer"])
    await Bun.write(
      path.join(cwd, ".omp", "agents", `${name}.md`),
      await Bun.file(path.resolve(import.meta.dir, `../agents/${name}.md`)).text(),
    );
  await fs.appendFile(
    path.join(cwd, ".gitignore"),
    "\n.test-artifacts/\nisolated-agent/\nisolated-rasen/\nmodels.yml*\n",
  );
  for (const args of [
    ["init", "--quiet"],
    ["add", "."],
  ]) {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Isolated Git setup failed: ${result.stderr}`);
  }
  const provider = `skill-native-${crypto.randomUUID()}`;
  const api = `skill-api-${crypto.randomUUID()}`;
  const auth = await AuthStorage.create(":memory:");
  auth.keys.setRuntime(provider, "deterministic-fixture-not-a-secret");
  const settings = Settings.isolated({
    "memory.backend": "off",
    "async.enabled": false,
    "bash.autoBackground.enabled": false,
    "launch.enabled": false,
    "tools.outputMaxColumns": 0,
    "tools.approvalMode": "yolo",
    "tools.approval.bash": deniedShip ? "deny" : "allow",
    "task.speculativeLaunch": false,
    "task.maxRuntimeMs": 30000,
    "task.agentIdleTtlMs": 1,
    modelRoles: Object.fromEntries(
      [
        "default",
        "implementation",
        "architect",
        "research",
        "task",
        "smol",
        "tiny",
        "title",
        "compaction",
      ].map((role) => [role, `${provider}/${role === "default" ? "main" : "leaf"}`]),
    ),
  });
  const registry = new ModelRegistry(auth, path.join(cwd, "models.yml"), { settings });
  const stores = new Map<string, MemorySessionStorage>();
  const originalOpen = SessionManager.open.bind(SessionManager);
  const open = spyOn(SessionManager, "open").mockImplementation(
    (file, directory, backend, options) => {
      if (!path.basename(file).startsWith("skill_"))
        return originalOpen(file, directory, backend, options);
      if (!stores.has(file)) stores.set(file, new MemorySessionStorage());
      return originalOpen(file, directory, stores.get(file), options);
    },
  );
  const calls = (name: string, args: Record<string, unknown>): Call => ({ name, arguments: args });
  let queue: Call[] = [
    calls("auto_step", {
      summary: "Choose from the real loaded Rasen descriptions and the newly created change",
    }),
  ];
  let boundary: Boundary = {};
  let readyArtifact: string | undefined;
  let architectReviews = 0;
  let requests = 0;
  let nativeSteps = 0;
  const childTurns = new Map<string, number>();
  const executions: Execution[] = [];
  const decisions: Array<{
    skill: string;
    criterion: string;
    facts: Record<string, any>;
    admittedBefore: number;
  }> = [];
  const nativeEvents: Array<{
    id: string;
    event: { type: string; toolName?: string; isError?: boolean; result?: unknown };
  }> = [];
  const mainWrites: Array<{ actionId: string; skill: string; path: string }> = [];
  const completeReads: string[] = [];
  let skillRead: { name: string; file: string; lines: string[]; offset: number } | undefined;
  const mainContexts: string[] = [];
  const errors: unknown[] = [];
  const sends: Promise<unknown>[] = [];
  const observedUi: any[] = [];
  const runFile = path.join(initial.ephemeraDir!, "auto-run.json");
  const write = (file: string, content: string) => calls("write", { path: file, content });
  const read = (file: string) => calls("read", { path: file, limit: 2000 });
  const command = `${JSON.stringify(process.execPath)} -e 'const {echo}=await import("./echo.ts"); if(echo(" scoped echo ")!==" scoped echo ") throw new Error("echo contract failed"); console.log("native-echo-verification-ok")'`;
  function task(
    purpose: string,
    role: Execution["role"],
    steps: Call[],
    report: Execution["report"],
    skill = boundary.action!.skill.name,
  ) {
    const action = boundary.action!;
    const id = `skill_${executions.length}_${crypto.randomUUID().slice(0, 8)}`;
    executions.push({
      id,
      actionId: action.actionId,
      skill,
      role,
      purpose,
      calls: steps,
      report,
      decisionCount: decisions.length,
    });
    return calls("task", {
      name: id,
      agent: role,
      model: action.admission.roleRoutes?.[role]?.selector,
      task: `Auto action: ${action.actionId}\nFixture execution: ${id}\n${purpose}. Use native tools and retain factual output.`,
      solutionSpace: "Only this isolated local fixture; no publication, archive or external effect",
    });
  }
  function planSelectedSkill() {
    const action = boundary.action!;
    const skill = action.skill.name;
    const result = calls("auto_step", {
      summary: `The native ${skill} invocation reached its factual boundary`,
      result: {
        actionId: action.actionId,
        status: skill === "rasen-ship" ? "needs_user" : "success",
        note:
          skill === "rasen-ship"
            ? "Native approval policy denied mock publication; no external effects"
            : `Completed scoped ${skill} work through native tools`,
      },
    });
    if (skill === "rasen-continue-change") {
      const artifact = readyArtifact!;
      queue.push(
        task(
          `Create the next ready artifact: ${artifact}`,
          "omp-worker",
          Object.entries(artifactBodies[artifact]!).map(([file, text]) =>
            write(path.join(changeDir, file), text),
          ),
          { artifact, created: true },
        ),
      );
    } else if (skill === "rasen-apply-change") {
      queue.push(
        task(
          "Implement the documented isolated echo",
          "omp-worker",
          [
            read(path.join(changeDir, "tasks.md")),
            write(
              path.join(cwd, "echo.ts"),
              "export const echo = (text: string): string => text;\n",
            ),
            write(path.join(changeDir, "tasks.md"), taskText.replace("[ ]", "[x]")),
          ],
          { implemented: true, tests: "Independent verification still required" },
        ),
      );
    } else if (skill === "rasen-verify-change") {
      queue.push(
        task(
          "Verify the echo contract independently",
          "omp-reviewer",
          [
            read(path.join(cwd, "echo.ts")),
            calls("bash", { command, intent: "Run the isolated echo contract" }),
          ],
          { verified: true, command, expectedOutput: "native-echo-verification-ok" },
        ),
      );
    } else if (skill === "rasen-review-cycle") {
      // One selected invocation owns all review/fix/delta work and UI records.
      // Native flat roles replace foreign dispatch/park mechanisms in the body.
      const finding = {
        severity: "major",
        summary: "Persist a regression test for whitespace preservation",
        stage: "review-loop",
      };
      const before = {
        rounds: 1,
        openFindings: [finding],
        stages: { "review-loop": { status: "in_progress" } },
      };
      const after = {
        rounds: 2,
        openFindings: [],
        stages: { "review-loop": { status: "done" } },
        history: [
          { round: 1, findings: [finding], fixedBy: "omp-worker" },
          { round: 2, findings: [], confirmedBy: "omp-reviewer" },
        ],
      };
      queue.push(
        task(
          "Review the diff and retain the independent finding",
          "omp-reviewer",
          [calls("read", { path: "skill://rasen-review" }), read(path.join(cwd, "echo.ts"))],
          { round: 1, findings: [finding] },
          "rasen-review",
        ),
      );
      queue.push(write(runFile, JSON.stringify(before)));
      queue.push(
        task(
          "Fix the missing regression coverage",
          "omp-worker",
          [
            write(
              path.join(cwd, "echo.test.ts"),
              "import {expect,test} from 'bun:test';\nimport {echo} from './echo';\ntest('preserves whitespace',()=>expect(echo(' hello ')).toBe(' hello '));\n",
            ),
          ],
          { fixed: finding.summary },
        ),
      );
      queue.push(
        task(
          "Re-review only the delta against the prior independent finding",
          "omp-reviewer",
          [
            read(path.join(cwd, "echo.test.ts")),
            calls("bash", {
              command: `${JSON.stringify(process.execPath)} test ./echo.test.ts`,
              intent: "Independently verify the regression fix",
            }),
          ],
          { round: 2, findings: [], resolved: finding.summary },
          "rasen-review",
        ),
      );
      queue.push(write(runFile, JSON.stringify(after)));
      queue.push(
        write(
          path.join(initial.evidenceDir!, "review-cycle-report.md"),
          "# Native fixture review cycle\n\nRound 1: major missing whitespace regression test. Fixed by omp-worker.\nRound 2: independent omp-reviewer ran Bun test and confirmed the delta. No open findings.\n\nScripted business judgment; actual native read/write/task/Bash execution. No publication or archive.\n",
        ),
      );
    } else if (skill === "rasen-ship") {
      queue.push(
        task(
          "Attempt only a local mock ship subject to native approvals",
          "omp-worker",
          [
            calls("bash", {
              command: "printf local-only-mock > shipped.txt",
              intent: "Attempt an isolated mock publication, with normal approvals",
            }),
          ],
          { status: "needs_user", reason: "Native Bash policy denied; no publication" },
        ),
      );
    } else throw new Error(`Unscripted skill ${skill}`);
    queue.push(result);
  }
  const configuration: Parameters<ModelRegistry["registerProvider"]>[1] = {
    baseUrl: "https://unused.invalid",
    apiKey: "deterministic-fixture-not-a-secret",
    api,
    models: ["main", "leaf"].map((name) => ({
      id: name,
      name,
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 4096,
    })),
    streamSimple(model, context) {
      requests++;
      const child = model.id === "leaf" && context.tools?.some((tool) => tool.name === "yield");
      const main = model.id === "main";
      let next: Call | undefined;
      if (main) {
        mainContexts.push(JSON.stringify(context.messages));
        next = queue.shift();
      } else if (child) {
        const id = /Fixture execution: (skill_[a-zA-Z0-9_]+)/.exec(
          JSON.stringify(context.messages),
        )?.[1];
        const execution = executions.find((item) => item.id === id);
        if (!execution) throw new Error("Native fixture child lacks its actual execution identity");
        const turn = childTurns.get(execution.id) ?? 0;
        childTurns.set(execution.id, turn + 1);
        next = execution.calls[turn] ?? calls("yield", { data: JSON.stringify(execution.report) });
      }
      const toolCalls = next
        ? [{ type: "toolCall" as const, id: `native-${requests}`, ...next }]
        : [];
      const message: AssistantMessage = {
        role: "assistant",
        api,
        provider,
        model: model.id,
        content: toolCalls.length
          ? toolCalls
          : [
              {
                type: "text",
                text: main
                  ? "Local fixture returned its actual native evidence and stated limitations"
                  : "Local task label",
              },
            ],
        stopReason: toolCalls.length ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      for (const [contentIndex, toolCall] of toolCalls.entries()) {
        stream.push({ type: "toolcall_start", contentIndex, partial: message });
        stream.push({
          type: "toolcall_delta",
          contentIndex,
          delta: JSON.stringify(toolCall.arguments),
          partial: message,
        });
        stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
      }
      stream.push({ type: "done", reason: toolCalls.length ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  };
  registry.registerProvider(provider, configuration, provider);
  const manager = SessionManager.inMemory(cwd);
  manager.adoptArtifactManager(new ArtifactManager(path.join(cwd, ".test-artifacts")));
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    authStorage: auth,
    modelRegistry: registry,
    model: registry
      .getAvailable()
      .find((model) => model.provider === provider && model.id === "main"),
    settings,
    sessionManager: manager,
    extensions: [
      withAgentDir(
        extensionFactory(
          () => async () => {
            architectReviews++;
            throw new Error("No outer Architect completion review");
          },
          {
            decision: () => async (evidence) => {
              const facts = JSON.parse(evidence.summary);
              const artifacts = facts.changeFacts.artifacts as Array<{
                id: string;
                status: string;
              }>;
              const history = readAutoHistory(manager, {
                change,
                root: cwd,
                schema: "spec-driven",
              });
              expect(history.valid).toBe(true);
              const allSettled = history.records.filter(
                (record) => record.kind === "action-settled",
              );
              const settled = (
                facts.nativeHistory as Array<{ kind: string; skill?: string }>
              ).filter((record) => record.kind === "action-settled");
              expect(facts.nativeHistory).toBeDefined();
              // The choice follows observed file/checkbox/history facts, never index 0
              // or a private host phase frontier. Full native names/descriptions match.
              readyArtifact = artifacts.find((artifact) => artifact.status === "ready")?.id;
              const selected = readyArtifact
                ? "rasen-continue-change"
                : facts.changeFacts.progress.remaining > 0
                  ? "rasen-apply-change"
                  : deniedShip
                    ? "rasen-ship"
                    : !settled.some((record) => record.skill === "rasen-verify-change")
                      ? "rasen-verify-change"
                      : !settled.some((record) => record.skill === "rasen-review-cycle")
                        ? "rasen-review-cycle"
                        : "finish";
              const choice =
                selected === "finish"
                  ? ["finish", evidence.choices!.finish]
                  : Object.entries(evidence.choices!).find(
                      ([, criterion]) =>
                        criterion ===
                        `Execute existing native skill ${selected}: ${loaded.skills.find((skill) => skill.name === selected)!.description}`,
                    );
              expect(choice).toBeDefined();
              if (decisions.length === 0)
                expect(Object.values(evidence.choices!)[0]).not.toBe(choice![1]);
              const admitted = history.records.filter(
                (record) => record.kind === "action-admitted",
              );
              expect(admitted.length).toBe(allSettled.length);
              decisions.push({
                skill: selected,
                criterion: choice![1]!,
                facts,
                admittedBefore: admitted.length,
              });
              return { choice: choice![0]!, confidence: 0.99 };
            },
          },
        ),
        agentDir,
      ),
      (pi) => {
        pi.registerProvider(provider, configuration);
        pi.events.on("task:subagent:event", (data) => {
          const event = data as (typeof nativeEvents)[number];
          if (event.event.type === "tool_execution_end") nativeEvents.push(event);
        });
        pi.on("tool_call", (event, ctx) => {
          if (
            ctx.agent.kind === "main" &&
            event.toolName === "write" &&
            typeof event.input.path === "string"
          )
            mainWrites.push({
              actionId: boundary.action!.actionId,
              skill: boundary.action!.skill.name,
              path: event.input.path,
            });
        });
        pi.on("tool_result", async (event, ctx) => {
          if (ctx.agent.kind !== "main") return;
          const output = event.content
            .filter((part) => part.type === "text")
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n");
          if (event.isError) {
            errors.push({ tool: event.toolName, output });
            queue = [];
            return;
          }
          if (event.toolName === "auto_step") {
            nativeSteps++;
            boundary = JSON.parse(output);
            if (boundary.error) {
              errors.push(boundary);
              queue = [];
              return;
            }
            if (boundary.action) {
              const skill = loaded.skills.find(
                (skill) => skill.name === boundary.action!.skill.name,
              )!;
              skillRead = {
                name: skill.name,
                file: skill.filePath,
                lines: bodies.get(skill.name)!.split("\n"),
                offset: 0,
              };
              queue.push(calls("read", { path: `${skill.filePath}:1+40:raw` }));
            }
          } else if (event.toolName === "read" && skillRead) {
            const chunk = skillRead.lines.slice(skillRead.offset, skillRead.offset + 40);
            for (const line of chunk.filter((line) => line.trim())) expect(output).toContain(line);
            expect(output).not.toMatch(/Output truncated|middle lines .*elided/);
            skillRead.offset += chunk.length;
            if (skillRead.offset < skillRead.lines.length) {
              queue.push(
                calls("read", { path: `${skillRead.file}:${skillRead.offset + 1}+40:raw` }),
              );
            } else {
              completeReads.push(skillRead.name);
              skillRead = undefined;
              planSelectedSkill();
            }
          } else if (
            event.toolName === "write" &&
            (event.input as { path?: string }).path === runFile
          ) {
            const parsed = parser.readRunStateDetailed(path.dirname(runFile));
            const ui = await uiRuns.handleRuns(cwd);
            expect(parsed.kind).toBe("ok");
            expect(parsed.state.pipeline).toBeUndefined();
            const row = ui.runs.find((row: { name: string }) => row.name === change);
            expect(row).toMatchObject({
              kind: "ok",
              autoRun: {
                kind: "ok",
                state: { rounds: parsed.state.rounds, openFindings: parsed.state.openFindings },
              },
            });
            observedUi.push(row.autoRun.state);
          }
        });
      },
    ],
    disableExtensionDiscovery: true,
    skills: loaded.skills,
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    enableMCP: false,
    enableLsp: false,
    skipPythonPreflight: true,
    spawns: ["omp-worker", "omp-reviewer"].join(","),
    toolNames: ["read", "write", "task", "wait"],
    cacheWarming: false,
    bindProcessState: false,
    systemPrompt: "Execute the isolated deterministic native Rasen skill fixture only",
    hasUI: true,
  });
  const nativeExecutors = new Map(
    ["read", "write", "task", "wait"].map((name) => [name, session.getToolByName(name)?.execute]),
  );
  await initializeExtensions(session, {
    reportSendError: (_action, error) => {
      errors.push(error);
    },
    reportRuntimeError: (error) => {
      errors.push(error);
    },
    trackExtensionSend: (promise) => {
      sends.push(promise);
    },
    uiContext: {
      ...session.extensionRunner!.getUIContext(),
      select: async () => "Approve",
      custom: async <T>() => true as T,
    } as ExtensionUIContext,
  });
  return {
    cwd,
    changeDir,
    initial,
    runFile,
    session,
    nativeExecutors,
    executions,
    decisions,
    nativeEvents,
    mainWrites,
    completeReads,
    observedUi,
    mainContexts,
    errors,
    counts: () => ({ architectReviews, nativeSteps }),
    journal: () => readAutoHistory(manager, { change, root: cwd, schema: "spec-driven" }),
    snapshot: () => readRasenSnapshot(cwd, change, { executable }),
    async start() {
      await session.prompt(
        `/auto start ${change} -- ${deniedShip ? "Implement the isolated echo then attempt mock ship only subject to native approval." : "Implement and verify the isolated echo, then run the complete review cycle. Return the local result without publication or archive."}`,
      );
      await Promise.all(sends);
      await session.waitForIdle();
    },
    async status() {
      const deadline = Date.now() + 8000;
      for (;;) {
        const result = await session
          .extensionRunner!.getRegisteredTool("auto_status")!
          .definition.execute(
            "fixture-status",
            {},
            undefined,
            undefined,
            session.extensionRunner!.createContext(),
          );
        const part = result.content.find((part) => part.type === "text");
        const status = JSON.parse(part?.type === "text" ? part.text : "null");
        if (status.status !== "draining") return status;
        if (Date.now() >= deadline)
          throw new Error(`Native skill fixture did not drain: ${JSON.stringify(status)}`);
        await Bun.sleep(10);
      }
    },
    async bundle(ref: string) {
      return JSON.parse(
        await fs.readFile(
          (await manager.getArtifactPath(ref.replace(/^artifact:\/\//, "")))!,
          "utf8",
        ),
      );
    },
    async close() {
      await session.abort();
      await session.dispose();
      for (const execution of executions) {
        const child = AgentRegistry.global().get(execution.id);
        if (child?.session) await child.session.dispose();
        AgentRegistry.global().unregister(execution.id);
      }
      open.mockRestore();
      auth.close();
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      if (oldRasenHome === undefined) delete process.env.RASEN_HOME;
      else process.env.RASEN_HOME = oldRasenHome;
      refreshDirsFromEnv();
      await fs.rm(cwd, { recursive: true, force: true });
    },
  };
}

test("pipeline-free Auto uses built Rasen skills and one complete native review-cycle, retaining UI-visible skill records", async () => {
  const fixture = await skillFixture();
  try {
    await fixture.start();
    expect(fixture.errors).toEqual([]);
    const status = await fixture.status();
    expect(status).toMatchObject({
      status: "completed",
      completionVerified: true,
      lastDecision: { choice: "finish" },
      selectedAction: null,
      history: { valid: true },
    });
    const selected = fixture.decisions.map((decision) => decision.skill);
    expect(selected).toEqual([
      "rasen-continue-change",
      "rasen-continue-change",
      "rasen-continue-change",
      "rasen-continue-change",
      "rasen-apply-change",
      "rasen-verify-change",
      "rasen-review-cycle",
      "finish",
    ]);
    expect(fixture.decisions[0]!.admittedBefore).toBe(0);
    expect(fixture.decisions[0]!.facts.changeFacts.state).toBe("blocked");
    expect(
      fixture.decisions.find((decision) => decision.skill === "rasen-verify-change")!.facts
        .changeFacts,
    ).toMatchObject({ state: "all_done", progress: { remaining: 0 } });
    expect(fixture.completeReads).toEqual(selected.slice(0, -1));
    expect(fixture.session.skills.some((skill) => skill.name === "rasen-review-cycle")).toBe(true);
    expect(fixture.counts()).toEqual({ architectReviews: 0, nativeSteps: 8 });
    expect(fixture.observedUi).toMatchObject([
      { rounds: 1, openFindings: [{ severity: "major" }] },
      { rounds: 2, openFindings: [] },
    ]);
    expect(fixture.observedUi.every((state) => state.pipeline === undefined)).toBe(true);
    expect(fixture.mainWrites.filter((write) => write.path === fixture.runFile)).toMatchObject([
      { skill: "rasen-review-cycle" },
      { skill: "rasen-review-cycle" },
    ]);
    const journal = fixture.journal();
    expect(journal.valid).toBe(true);
    const cycle = journal.records.filter(
      (record) => record.kind === "action-settled" && record.skill === "rasen-review-cycle",
    );
    expect(cycle).toHaveLength(1);
    const cycleCalls = fixture.executions.filter(
      (execution) => execution.actionId === (cycle[0] as { actionId: string }).actionId,
    );
    expect(cycleCalls.map((execution) => execution.role)).toEqual([
      "omp-reviewer",
      "omp-worker",
      "omp-reviewer",
    ]);
    expect(new Set(cycleCalls.map((execution) => execution.decisionCount)).size).toBe(1);
    const bundle = await fixture.bundle(String(cycle[0]!.nativeReceipts![0]!.artifactRef));
    expect(
      bundle.receipts
        .filter((receipt: { agentId?: string }) => receipt.agentId)
        .map((receipt: { agentId: string }) => receipt.agentId),
    ).toEqual(cycleCalls.map((execution) => execution.id));
    expect(
      fixture.nativeEvents.some((event) => event.event.toolName === "bash" && !event.event.isError),
    ).toBe(true);
    expect(
      fixture.mainContexts.some((context) => context.includes("native-echo-verification-ok")),
    ).toBe(true);
    expect(await fs.readFile(path.join(fixture.cwd, "echo.test.ts"), "utf8")).toContain(
      "preserves whitespace",
    );
    const snapshot = await fixture.snapshot();
    expect(snapshot.skillRecord).toMatchObject({
      kind: "valid",
      content: { rounds: 2, openFindings: [] },
    });
    expect(await Bun.file(path.join(fixture.cwd, "shipped.txt")).exists()).toBe(false);
    expect(await Bun.file(path.join(fixture.changeDir, "tasks.md")).exists()).toBe(true);
    for (const [name, execute] of fixture.nativeExecutors)
      expect(fixture.session.getToolByName(name)?.execute).toBe(execute);
  } finally {
    await fixture.close();
  }
}, 90000);

test("an available Rasen ship skill still stops at native denial without publication or a pipeline", async () => {
  const fixture = await skillFixture(true);
  try {
    await fixture.start();
    expect(fixture.errors).toEqual([]);
    expect(await fixture.status()).toMatchObject({
      status: "paused",
      outcome: "needs_user",
      completionVerified: false,
    });
    expect(fixture.decisions.at(-1)?.skill).toBe("rasen-ship");
    const denied = fixture.nativeEvents.find(
      (event) => event.event.toolName === "bash" && event.event.isError,
    );
    expect(denied).toBeDefined();
    expect(JSON.stringify(denied)).toMatch(/blocked by user policy/);
    const records = fixture.journal().records;
    expect(
      records.filter((record) => record.kind === "action-settled" && record.skill === "rasen-ship"),
    ).toEqual([]);
    const held = records.find(
      (record) => record.kind === "action-held" && record.skill === "rasen-ship",
    )!;
    expect(held).toBeDefined();
    const bundle = await fixture.bundle(String(held.nativeReceipts![0]!.artifactRef));
    expect(bundle.skill).toBe("rasen-ship");
    expect(
      bundle.receipts.some(
        (receipt: { agentId?: string }) => receipt.agentId === fixture.executions.at(-1)!.id,
      ),
    ).toBe(true);
    expect(await Bun.file(path.join(fixture.cwd, "shipped.txt")).exists()).toBe(false);
    expect((await fixture.snapshot()).skillRecord?.kind).toBe("absent");
    expect(fixture.counts().architectReviews).toBe(0);
  } finally {
    await fixture.close();
  }
}, 90000);

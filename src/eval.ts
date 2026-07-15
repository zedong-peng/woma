import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { assertInside, pathExists, relativeDisplay, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import { switchProfile } from "./profile.js";
import { readProjectConfig } from "./project.js";
import { readState } from "./store.js";
import type { Platform } from "./types.js";

const nameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");

const verifySchema = z
  .object({
    binding: nameSchema.optional(),
    command: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.binding) === Boolean(value.command)) {
      context.addIssue({ code: "custom", message: "choose exactly one of binding or command" });
    }
  });

const evalSchema = z
  .object({
    apiVersion: z.literal("harness.conda/eval-v1"),
    kind: z.literal("HarnessEval"),
    metadata: z.object({ name: nameSchema }).strict(),
    spec: z
      .object({
        profile: nameSchema,
        agent: z.enum(["codex", "claude"]).optional(),
        prompt: z.string().min(20).max(20_000),
        verify: verifySchema,
        repetitions: z.number().int().min(1).max(10).default(1),
        timeoutSeconds: z.number().int().min(30).max(7200).default(900),
        agentArgs: z.array(z.string()).max(30).default([]),
      })
      .strict(),
  })
  .strict();

export type EvalDefinition = z.infer<typeof evalSchema>;
export type EvalArm = "baseline" | "profile";

export interface EvalPlan {
  definition: EvalDefinition;
  definitionPath: string;
  definitionHash: string;
  head: string;
  clean: boolean;
  dirtySummary?: string | undefined;
  agent: Platform;
  profile: string;
  verifier: string;
  repetitions: number;
  sessions: number;
  timeoutSeconds: number;
}

export interface EvalArmResult {
  repetition: number;
  order: number;
  arm: EvalArm;
  agentExitCode: number | null;
  verifierExitCode: number | null;
  timedOut: boolean;
  success: boolean;
  failure: "none" | "agent" | "verifier" | "timeout";
  durationMs: number;
  worktree?: string | undefined;
}

interface EvalArmSummary {
  passed: number;
  total: number;
  passRate: number;
  failures: { agent: number; verifier: number; timeout: number };
}

export interface EvalRunResult {
  schemaVersion: 1;
  id: string;
  eval: string;
  definitionHash: string;
  head: string;
  agent: Platform;
  profile: string;
  startedAt: string;
  finishedAt: string;
  verifierHash: string;
  results: EvalArmResult[];
  summary: Record<EvalArm, EvalArmSummary>;
  resultPath: string;
}

interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
}

const placeholderPrompt = "REPLACE_WITH_A_BOUNDED_TASK_AND_AN_OBSERVABLE_OUTPUT";
const forbiddenAgentArgs = new Set([
  "-C",
  "--add-dir",
  "--cd",
  "--config",
  "--dangerously-bypass-approvals-and-sandbox",
  "--dangerously-skip-permissions",
  "--full-auto",
  "--mcp-config",
  "--permission-mode",
  "--plugin-dir",
  "--sandbox",
  "--settings",
  "--yolo",
]);

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "eval"}: ${issue.message}`).join("\n");
}

export function parseEvalDefinition(input: string, source = "Harness eval"): EvalDefinition {
  let document: unknown;
  try {
    document = parseYaml(input);
  } catch (error) {
    throw new Error(`${source}: invalid YAML: ${(error as Error).message}`);
  }
  const parsed = evalSchema.safeParse(document);
  if (!parsed.success) throw new Error(`${source}: invalid eval definition\n${formatIssues(parsed.error)}`);
  return parsed.data;
}

function normalizedName(input: string): string {
  const name = input.replace(/\.ya?ml$/i, "");
  return nameSchema.parse(name);
}

export function evalDefinitionPath(projectRoot: string, input: string): string {
  if (input.includes("/") || input.includes("\\")) {
    const resolved = path.resolve(projectRoot, input);
    assertInside(projectRoot, resolved, "Eval definition");
    return resolved;
  }
  return path.join(projectRoot, ".harness", "evals", `${normalizedName(input)}.yaml`);
}

export async function createEvalDefinition(
  projectRoot: string,
  name: string,
  options: {
    profile: string;
    agent?: Platform | undefined;
    verify: { binding: string } | { command: string };
    repetitions?: number | undefined;
  },
): Promise<string> {
  const config = await readProjectConfig(projectRoot);
  const profile = normalizedName(options.profile);
  if (!config.spec.profiles[profile]) throw new Error(`Unknown eval profile: ${profile}`);
  if (options.agent && !config.spec.targets.includes(options.agent)) {
    throw new Error(`Eval agent ${options.agent} is not listed in project targets`);
  }
  if ("binding" in options.verify && !config.spec.bindings[options.verify.binding]) {
    throw new Error(`Eval verifier binding ${options.verify.binding} is not defined in .harness/project.yaml`);
  }
  const filePath = evalDefinitionPath(projectRoot, name);
  if (await pathExists(filePath)) throw new Error(`Refusing to overwrite ${filePath}`);
  const definition = evalSchema.parse({
    apiVersion: "harness.conda/eval-v1",
    kind: "HarnessEval",
    metadata: { name: normalizedName(name) },
    spec: {
      profile,
      ...(options.agent ? { agent: options.agent } : {}),
      prompt: `${placeholderPrompt}\n\nState the task, required artifact, and constraints. Do not describe the Harness under test.`,
      verify: options.verify,
      repetitions: options.repetitions ?? 1,
      timeoutSeconds: 900,
      agentArgs: [],
    },
  });
  await writeTextAtomic(filePath, stringifyYaml(definition, { lineWidth: 120 }));
  return filePath;
}

async function readEvalDefinition(projectRoot: string, input: string): Promise<{ definition: EvalDefinition; filePath: string }> {
  const filePath = evalDefinitionPath(projectRoot, input);
  const content = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`Eval definition not found: ${filePath}`);
    throw error;
  });
  return { definition: parseEvalDefinition(content, filePath), filePath };
}

function capture(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

function definitionHash(definition: EvalDefinition): string {
  return `sha256-${createHash("sha256").update(JSON.stringify(definition)).digest("hex")}`;
}

function valueHash(value: string): string {
  return `sha256-${createHash("sha256").update(value).digest("hex")}`;
}

function validateAgentArgs(agent: Platform, args: string[]): void {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if ([...forbiddenAgentArgs].some((option) => argument === option || argument.startsWith(`${option}=`))) {
      throw new Error(`Eval agentArgs cannot use isolation-changing option ${argument}`);
    }
    if (agent === "codex" && (argument === "-c" || argument.startsWith("-c="))) {
      throw new Error("Eval agentArgs cannot override Codex configuration");
    }
  }
}

export async function planEval(
  projectRoot: string,
  input: string,
  options: { agent?: Platform | undefined; repetitions?: number | undefined } = {},
): Promise<EvalPlan> {
  const project = path.resolve(projectRoot);
  const [{ definition, filePath }, config] = await Promise.all([
    readEvalDefinition(project, input),
    readProjectConfig(project),
  ]);
  const gitRoot = await capture("git", ["rev-parse", "--show-toplevel"], project);
  if ((await realpath(gitRoot)) !== (await realpath(project))) {
    throw new Error(`Eval currently requires the Harness project to be the Git root: ${gitRoot}`);
  }
  const profile = config.spec.profiles[definition.spec.profile];
  if (!profile) throw new Error(`Unknown eval profile: ${definition.spec.profile}`);
  const agent = options.agent ?? definition.spec.agent ?? config.spec.agent;
  if (!config.spec.targets.includes(agent)) throw new Error(`Eval agent ${agent} is not listed in project targets`);
  validateAgentArgs(agent, definition.spec.agentArgs);
  const repetitions = options.repetitions ?? definition.spec.repetitions;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("Eval repetitions must be an integer from 1 to 10");
  }
  const verifier = definition.spec.verify.binding
    ? config.spec.bindings[definition.spec.verify.binding]
    : definition.spec.verify.command;
  if (!verifier) {
    throw new Error(`Eval verifier binding ${definition.spec.verify.binding} is not defined in .harness/project.yaml`);
  }
  const [head, dirtySummary] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"], project),
    capture("git", ["status", "--porcelain"], project),
  ]);
  return {
    definition,
    definitionPath: relativeDisplay(project, filePath),
    definitionHash: definitionHash(definition),
    head,
    clean: dirtySummary === "",
    ...(dirtySummary ? { dirtySummary } : {}),
    agent,
    profile: definition.spec.profile,
    verifier,
    repetitions,
    sessions: repetitions * 2,
    timeoutSeconds: definition.spec.timeoutSeconds,
  };
}

function runProcess(command: string, args: string[], cwd: string, timeoutSeconds: number): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutSeconds * 1000);
    timer.unref();
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code, timedOut });
    });
  });
}

function agentInvocation(agent: Platform, worktree: string, prompt: string, extraArgs: string[]): [string, string[]] {
  if (agent === "codex") {
    return ["codex", ["exec", "--ephemeral", "--sandbox", "workspace-write", "-C", worktree, ...extraArgs, prompt]];
  }
  return [
    "claude",
    ["--print", "--no-session-persistence", "--permission-mode", "acceptEdits", ...extraArgs, prompt],
  ];
}

async function assertCleanBaseline(worktree: string): Promise<void> {
  const state = await readState(worktree);
  if (state.profile || Object.keys(state.activations).length > 0) {
    throw new Error("Eval HEAD contains active Harness state; run harness leave and remove committed .harness/state.json");
  }
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const content = await readFile(path.join(worktree, file), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (content.includes("harness-conda:active-profile")) {
      throw new Error(`Eval HEAD contains an active Harness routing block in ${file}`);
    }
  }
}

function summarize(results: EvalArmResult[], arm: EvalArm): EvalArmSummary {
  const selected = results.filter((result) => result.arm === arm);
  const passed = selected.filter((result) => result.success).length;
  return {
    passed,
    total: selected.length,
    passRate: selected.length === 0 ? 0 : passed / selected.length,
    failures: {
      agent: selected.filter((result) => result.failure === "agent").length,
      verifier: selected.filter((result) => result.failure === "verifier").length,
      timeout: selected.filter((result) => result.failure === "timeout").length,
    },
  };
}

function armOutcome(
  agentResult: ProcessResult,
  verifierResult: ProcessResult,
): { timedOut: boolean; success: boolean; failure: EvalArmResult["failure"] } {
  const timedOut = agentResult.timedOut || verifierResult.timedOut;
  const success = !timedOut && agentResult.exitCode === 0 && verifierResult.exitCode === 0;
  const failure = timedOut
    ? "timeout"
    : agentResult.exitCode !== 0
      ? "agent"
      : verifierResult.exitCode !== 0
        ? "verifier"
        : "none";
  return { timedOut, success, failure };
}

async function removeWorktree(project: string, worktree: string): Promise<void> {
  await capture("git", ["worktree", "remove", "--force", worktree], project).catch(async () => {
    await rm(worktree, { recursive: true, force: true });
    await capture("git", ["worktree", "prune"], project).catch(() => undefined);
  });
}

export async function runEval(
  projectRoot: string,
  input: string,
  options: {
    execute: true;
    agent?: Platform | undefined;
    repetitions?: number | undefined;
    keepFailures?: boolean | undefined;
    onArmStart?: ((arm: EvalArm, repetition: number, order: number) => void) | undefined;
  },
): Promise<EvalRunResult> {
  const project = path.resolve(projectRoot);
  const plan = await planEval(project, input, options);
  if (!plan.clean) throw new Error(`Eval requires a clean worktree at HEAD:\n${plan.dirtySummary}`);
  if (plan.definition.spec.prompt.includes(placeholderPrompt)) {
    throw new Error(`Replace the placeholder prompt in ${plan.definitionPath} before executing the eval`);
  }

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const results: EvalArmResult[] = [];
  const keptWorktrees: string[] = [];
  let completed = false;
  try {
    for (let repetition = 1; repetition <= plan.repetitions; repetition += 1) {
      const profileFirst = (Number.parseInt(id.replaceAll("-", "").slice(0, 2), 16) + repetition) % 2 === 0;
      const arms: EvalArm[] = profileFirst ? ["profile", "baseline"] : ["baseline", "profile"];
      for (let index = 0; index < arms.length; index += 1) {
        const arm = arms[index]!;
        const order = index + 1;
        const worktree = path.join(os.tmpdir(), `harness-eval-${id}-${repetition}-${arm}`);
        options.onArmStart?.(arm, repetition, order);
        await capture("git", ["worktree", "add", "--quiet", "--detach", worktree, plan.head], project);
        const started = Date.now();
        let agentResult: ProcessResult = { exitCode: null, timedOut: false };
        let verifierResult: ProcessResult = { exitCode: null, timedOut: false };
        let evaluated = false;
        try {
          await assertCleanBaseline(worktree);
          if (arm === "profile") await switchProfile(worktree, plan.profile);
          const [agentCommand, agentArgs] = agentInvocation(
            plan.agent,
            worktree,
            plan.definition.spec.prompt,
            plan.definition.spec.agentArgs,
          );
          agentResult = await runProcess(agentCommand, agentArgs, worktree, plan.timeoutSeconds);
          const shell = process.env.SHELL || "/bin/sh";
          verifierResult = await runProcess(shell, ["-lc", plan.verifier], worktree, plan.timeoutSeconds);
          evaluated = true;
        } finally {
          const keep = evaluated && options.keepFailures === true && !armOutcome(agentResult, verifierResult).success;
          if (keep) keptWorktrees.push(worktree);
          else await removeWorktree(project, worktree);
        }
        const outcome = armOutcome(agentResult, verifierResult);
        results.push({
          repetition,
          order,
          arm,
          agentExitCode: agentResult.exitCode,
          verifierExitCode: verifierResult.exitCode,
          ...outcome,
          durationMs: Date.now() - started,
          ...(keptWorktrees.includes(worktree) ? { worktree } : {}),
        });
      }
    }
    completed = true;
  } finally {
    if (!completed) {
      for (const worktree of keptWorktrees) await removeWorktree(project, worktree);
    }
    await capture("git", ["worktree", "prune"], project).catch(() => undefined);
  }

  const resultPath = path.join(project, ".harness", "local", "evals", `${id}.json`);
  const result: EvalRunResult = {
    schemaVersion: 1,
    id,
    eval: plan.definition.metadata.name,
    definitionHash: plan.definitionHash,
    head: plan.head,
    agent: plan.agent,
    profile: plan.profile,
    startedAt,
    finishedAt: new Date().toISOString(),
    verifierHash: valueHash(plan.verifier),
    results,
    summary: {
      baseline: summarize(results, "baseline"),
      profile: summarize(results, "profile"),
    },
    resultPath: relativeDisplay(project, resultPath),
  };
  await writeJsonAtomic(resultPath, result);
  return result;
}

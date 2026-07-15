import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { pathExists, writeTextAtomic } from "./fs.js";
import { readLock } from "./store.js";
import type { HarnessProject, Platform } from "./types.js";

const nameSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");
const platformSchema = z.enum(["codex", "claude"]);

const projectSchema = z
  .object({
    apiVersion: z.literal("harness.conda/project-v1"),
    kind: z.literal("HarnessProject"),
    metadata: z.object({ name: nameSchema }).strict(),
    spec: z
      .object({
        agent: platformSchema.default("codex"),
        targets: z.array(platformSchema).min(1).default(["codex", "claude"]),
        base: z.array(nameSchema).default([]),
        profiles: z
          .record(
            nameSchema,
            z
              .object({
                description: z.string().min(1).max(300),
                packages: z.array(nameSchema).default([]),
              })
              .strict(),
          )
          .default({}),
        bindings: z.record(nameSchema, z.string().min(1)).default({}),
        handoffDirectory: z.string().min(1).default(".harness/handoffs"),
      })
      .strict(),
  })
  .strict();

export function projectConfigPath(projectRoot: string): string {
  return path.join(projectRoot, ".harness", "project.yaml");
}

function slug(input: string, fallback?: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (!value) {
    if (fallback) return fallback;
    throw new Error("Names must contain at least one ASCII letter or digit");
  }
  return value;
}

export function parseProjectConfig(input: string, source = ".harness/project.yaml"): HarnessProject {
  let value: unknown;
  try {
    value = parseYaml(input);
  } catch (error) {
    throw new Error(`${source}: invalid YAML: ${(error as Error).message}`);
  }
  const result = projectSchema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "project"}: ${issue.message}`).join("\n");
    throw new Error(`${source}: invalid project config\n${issues}`);
  }
  return result.data;
}

export async function readProjectConfig(projectRoot: string): Promise<HarnessProject> {
  const filePath = projectConfigPath(projectRoot);
  const input = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`No Harness project found. Run harness project init in ${projectRoot}`);
    throw error;
  });
  return parseProjectConfig(input, filePath);
}

export async function writeProjectConfig(projectRoot: string, config: HarnessProject): Promise<void> {
  const validated = projectSchema.parse(config);
  await writeTextAtomic(projectConfigPath(projectRoot), stringifyYaml(validated, { lineWidth: 120 }));
}

export async function initProject(
  projectRoot: string,
  options: { name?: string; agent?: Platform; targets?: Platform[] } = {},
): Promise<HarnessProject> {
  const filePath = projectConfigPath(projectRoot);
  if (await pathExists(filePath)) throw new Error(`Refusing to overwrite ${filePath}`);
  const name = slug(options.name ?? path.basename(path.resolve(projectRoot)), "harness-project");
  const config: HarnessProject = {
    apiVersion: "harness.conda/project-v1",
    kind: "HarnessProject",
    metadata: { name },
    spec: {
      agent: options.agent ?? "codex",
      targets: options.targets ?? ["codex", "claude"],
      base: [],
      profiles: {
        research: {
          description: "Find prior work, collect evidence, and produce testable hypotheses.",
          packages: [],
        },
        experiment: {
          description: "Turn hypotheses into reproducible experiments, evaluate results, and record failures.",
          packages: [],
        },
      },
      bindings: {},
      handoffDirectory: ".harness/handoffs",
    },
  };
  await writeProjectConfig(projectRoot, config);
  return config;
}

async function ensureInstalled(projectRoot: string, packageName: string): Promise<void> {
  const lock = await readLock(projectRoot);
  if (!lock.packages[packageName]) throw new Error(`${packageName} is not installed in this project`);
}

export async function addPackageToProject(
  projectRoot: string,
  packageName: string,
  destination: { base: true } | { profile: string },
): Promise<HarnessProject> {
  await ensureInstalled(projectRoot, packageName);
  const config = await readProjectConfig(projectRoot);
  if ("base" in destination) {
    if (!config.spec.base.includes(packageName)) config.spec.base.push(packageName);
  } else {
    const profileName = slug(destination.profile);
    const profile = config.spec.profiles[profileName] ?? {
      description: `${profileName} workflow.`,
      packages: [],
    };
    if (!profile.packages.includes(packageName)) profile.packages.push(packageName);
    config.spec.profiles[profileName] = profile;
  }
  await writeProjectConfig(projectRoot, config);
  return config;
}

export async function setBinding(projectRoot: string, name: string, command: string): Promise<HarnessProject> {
  if (!command.trim()) throw new Error("Binding command cannot be empty");
  const config = await readProjectConfig(projectRoot);
  config.spec.bindings[slug(name)] = command.trim();
  await writeProjectConfig(projectRoot, config);
  return config;
}

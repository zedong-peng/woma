import { readFile } from "node:fs/promises";
import path from "node:path";
import { valid, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { pathExists } from "./fs.js";
import { AGENTS, type Agent, type EnvironmentLock, type EnvironmentRecipe, type EnvironmentState, type McpServer, type RootRequirement } from "./types.js";

export const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/).refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const version = z.string().refine((v) => valid(v) !== null, "Expected an exact semantic version");
const range = z.string().refine((v) => validRange(v) !== null, "Invalid semantic version range");
const agent = z.enum(AGENTS);
export const relativePath = z.string().refine((v) => v !== "" && !path.isAbsolute(v) && !v.includes("\\") && !v.split("/").some((p) => p === ".." || p === "") && !/[\x00-\x1f]/.test(v), "Unsafe relative path");
const integrity = z.string().regex(/^sha256-[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40,64}$/);
const dependency = z.object({ name: nameSchema, version: range.default("*"), source: z.string().min(1) }).strict();
// Which agents a package supports. Version ranges are accepted for compatibility but not checked: Woma uses the installed agents.
const harnesses = z.object({ codex: range.optional(), claude: range.optional() }).strict();
export const manifestSchema = z.object({
  name: nameSchema.optional(), version: version.optional(), dependencies: z.array(dependency).default([]), harnesses: harnesses.optional(),
}).strict();

export async function loadManifest(root: string) {
  const file = path.join(root, "woma.yaml");
  if (!(await pathExists(file))) return manifestSchema.parse({});
  try { return manifestSchema.parse(parseYaml(await readFile(file, "utf8"))); }
  catch (error) {
    throw new Error(`Invalid ${file}: ${String(error)}. A package woma.yaml accepts only name, version, dependencies and harnesses; native MCP/Hooks belong in a plugin.`);
  }
}

export function skillMetadata(input: string, label: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input);
  if (!match?.[1]) throw new Error(`${label}: missing YAML frontmatter`);
  const parsed = z.object({ name: z.string(), description: z.string().min(1) }).safeParse(parseYaml(match[1]));
  if (!parsed.success) throw new Error(`${label}: frontmatter requires a name and a nonempty description`);
  const name = nameSchema.safeParse(parsed.data.name);
  if (!name.success) throw new Error(`${label}: invalid Skill name ${JSON.stringify(parsed.data.name)}; use lowercase letters, digits, dots, underscores and hyphens`);
  return { name: name.data, description: parsed.data.description };
}

export const envVarName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Expected an environment variable name");
export const mcpNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "MCP server names use letters, digits, underscores and hyphens");
export const mcpServerSchema = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(envVarName, z.string()).optional(),
  env_vars: z.array(envVarName).optional(),
  url: z.url({ protocol: /^https?$/ }).optional(),
  bearer_token_env_var: envVarName.optional(),
  agents: z.array(agent).min(1).optional(),
}).strict().superRefine((server, context) => {
  if (Boolean(server.command) === Boolean(server.url)) context.addIssue({ code: "custom", message: "An MCP server needs exactly one of command (stdio) or url (HTTP)" });
  if (server.url && (server.args || server.env || server.env_vars)) context.addIssue({ code: "custom", message: "args, env and env_vars apply only to command (stdio) servers" });
  if (server.command && server.bearer_token_env_var) context.addIssue({ code: "custom", message: "bearer_token_env_var applies only to url (HTTP) servers" });
  const literal = Object.keys(server.env ?? {});
  if ((server.env_vars ?? []).some((name) => literal.includes(name))) context.addIssue({ code: "custom", message: "A variable cannot be both a literal env value and a passed-through env_vars entry" });
});

const agentsSchema = z.array(agent).min(1, "An environment needs at least one agent (claude or codex)")
  .refine((agents) => new Set(agents).size === agents.length, "Each agent is listed once");
const recipeSchema = z.object({
  format: z.literal("woma.environment/v3"), name: nameSchema, agents: agentsSchema,
  packages: z.array(z.object({ name: nameSchema, source: z.string().min(1) }).strict()),
  mcp_servers: z.record(mcpNameSchema, mcpServerSchema),
}).strict();
const recordSchema = z.object({
  name: nameSchema, version, kind: z.enum(["skill", "plugin", "collection"]), integrity,
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("local"), path: z.string().refine(path.isAbsolute) }).strict(),
    z.object({ type: z.literal("git"), url: z.string().min(1), commit, subdirectory: relativePath.optional() }).strict(),
  ]),
  dependencies: z.array(dependency), harnesses,
  skills: z.array(z.object({ name: nameSchema, path: relativePath }).strict()),
  plugin: z.object({ harness: agent, name: nameSchema, version: z.union([z.literal("local"), version]) }).strict().optional(),
  origin: z.object({ url: z.string().min(1), commit, subdirectory: relativePath.optional() }).strict().optional(),
}).strict();
const lockSchema = z.object({ format: z.literal("woma.lock/v3"), recipe: recipeSchema, packages: z.record(nameSchema, recordSchema) }).strict();
const stateSchema = z.object({ format: z.literal("woma.state/v3"), lock: lockSchema, paths: z.array(z.object({ path: relativePath, integrity, package: nameSchema }).strict()) }).strict();

// Woma 0.7 (v2) wrote single-harness recipes and locks that pinned the agent release. They remain readable so existing
// exports can recreate environments; the agent release is dropped because Woma now uses the installed agents.
const legacyRecipeSchema = z.object({
  format: z.literal("woma.environment/v2"), name: nameSchema, harness: agent, runtime: z.string().min(1),
  packages: z.array(z.object({ name: nameSchema, source: z.string().min(1) }).strict()),
}).strict();
const legacyLockSchema = z.object({ format: z.literal("woma.lock/v2"), platform: z.string().min(1), recipe: legacyRecipeSchema, packages: z.record(nameSchema, z.unknown()) }).strict();
export const legacyStateSchema = z.object({ format: z.literal("woma.state/v2"), lock: legacyLockSchema, paths: z.array(z.unknown()) }).strict();

function upgradeRecipe(recipe: z.infer<typeof legacyRecipeSchema>): EnvironmentRecipe {
  return { format: "woma.environment/v3", name: recipe.name, agents: [recipe.harness], packages: recipe.packages, mcp_servers: {} };
}
export function upgradeLegacyLock(value: unknown): EnvironmentLock {
  const lock = legacyLockSchema.parse(value);
  const packages = Object.entries(lock.packages).filter(([, record]) => (record as { kind?: unknown })?.kind !== "runtime");
  return { format: "woma.lock/v3", recipe: upgradeRecipe(lock.recipe), packages: Object.fromEntries(packages.map(([name, record]) => [name, recordSchema.parse(record)])) as EnvironmentLock["packages"] };
}

/** A hand-written or exported environment file. Package entries may be bare sources whose names are resolved on creation. */
export interface RecipeInput extends Omit<EnvironmentRecipe, "packages" | "name"> { name?: string | undefined; packages: (RootRequirement | { source: string })[] }
const recipeInputSchema = z.object({
  format: z.literal("woma.environment/v3").default("woma.environment/v3"), name: nameSchema.optional(), agents: agentsSchema,
  packages: z.array(z.union([z.string().min(1).transform((source) => ({ source })), z.object({ name: nameSchema.optional(), source: z.string().min(1) }).strict()])).default([]),
  mcp_servers: z.record(mcpNameSchema, mcpServerSchema).default({}),
}).strict();
export function parseRecipeInput(value: unknown): RecipeInput {
  if ((value as { format?: unknown })?.format === "woma.environment/v2") return upgradeRecipe(legacyRecipeSchema.parse(value));
  const recipe = recipeInputSchema.parse(value);
  return { ...recipe, packages: recipe.packages.map((p) => "name" in p && p.name ? { name: p.name, source: p.source } : { source: p.source }) } as RecipeInput;
}

export function parseRecipe(value: unknown): EnvironmentRecipe { return recipeSchema.parse(value) as EnvironmentRecipe; }
export function parseLock(value: unknown): EnvironmentLock {
  if ((value as { format?: unknown })?.format === "woma.lock/v2") return upgradeLegacyLock(value);
  return lockSchema.parse(value) as EnvironmentLock;
}
export function parseState(value: unknown): EnvironmentState { return stateSchema.parse(value) as EnvironmentState; }
export function parsePackageRecord(value: unknown) { return recordSchema.parse(value); }
export function parseMcpServer(value: unknown): McpServer { return mcpServerSchema.parse(value); }

export function formatIssues(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`).join("; ");
  return (error as Error).message;
}

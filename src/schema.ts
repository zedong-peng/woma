import { readFile } from "node:fs/promises";
import path from "node:path";
import { valid, validRange } from "semver";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { pathExists } from "./fs.js";
import type { EnvironmentLock, EnvironmentRecipe, EnvironmentState } from "./types.js";

export const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/).refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const version = z.string().refine((v) => valid(v) !== null, "Expected an exact semantic version");
const range = z.string().refine((v) => validRange(v) !== null, "Invalid semantic version range");
const harness = z.enum(["codex", "claude"]);
export const relativePath = z.string().refine((v) => v !== "" && !path.isAbsolute(v) && !v.includes("\\") && !v.split("/").some((p) => p === ".." || p === "") && !/[\x00-\x1f]/.test(v), "Unsafe relative path");
const integrity = z.string().regex(/^sha256-[a-f0-9]{64}$/);
const dependency = z.object({ name: nameSchema, version: range.default("*"), source: z.string().min(1) }).strict();
export const manifestSchema = z.object({
  name: nameSchema.optional(), version: version.optional(), dependencies: z.array(dependency).default([]),
  harnesses: z.object({ codex: range.optional(), claude: range.optional() }).strict().optional(),
}).strict();

export async function loadManifest(root: string) {
  const file = path.join(root, "woma.yaml");
  if (!(await pathExists(file))) return manifestSchema.parse({});
  try { return manifestSchema.parse(parseYaml(await readFile(file, "utf8"))); }
  catch (error) {
    throw new Error(`Invalid ${file}: ${String(error)}. v2 woma.yaml accepts only name, version, dependencies and harnesses; native MCP/Hooks belong in a plugin.`);
  }
}

export function skillMetadata(input: string, label: string): { name: string; description: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input);
  if (!match?.[1]) throw new Error(`${label}: missing YAML frontmatter`);
  return z.object({ name: nameSchema, description: z.string().min(1) }).parse(parseYaml(match[1]));
}

const recipeSchema = z.object({
  format: z.literal("woma.environment/v2"), name: nameSchema, harness,
  runtime: z.string().refine((v) => v === "latest" || valid(v) !== null, "Runtime must be latest or an exact version"),
  packages: z.array(z.object({ name: nameSchema, source: z.string().min(1) }).strict()),
}).strict();
const recordSchema = z.object({
  name: nameSchema, version, kind: z.enum(["runtime", "skill", "plugin", "collection"]), integrity,
  source: z.discriminatedUnion("type", [
    z.object({ type: z.literal("local"), path: z.string().refine(path.isAbsolute) }).strict(),
    z.object({ type: z.literal("git"), url: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40,64}$/), subdirectory: relativePath.optional() }).strict(),
    z.object({ type: z.literal("runtime"), provider: z.literal("npm"), platform: z.string().min(1), executable: relativePath,
      artifacts: z.array(z.object({ name: z.string().min(1), version, url: z.url(), integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/), directory: relativePath }).strict()).min(1),
    }).strict(),
  ]),
  dependencies: z.array(dependency), harnesses: z.object({ codex: range.optional(), claude: range.optional() }).strict(),
  skills: z.array(z.object({ name: nameSchema, path: relativePath }).strict()),
  plugin: z.object({ harness, name: nameSchema, version: z.union([z.literal("local"), version]) }).strict().optional(),
}).strict();
const lockSchema = z.object({ format: z.literal("woma.lock/v2"), platform: z.string().min(1), recipe: recipeSchema, packages: z.record(nameSchema, recordSchema) }).strict();
const stateSchema = z.object({ format: z.literal("woma.state/v2"), lock: lockSchema, paths: z.array(z.object({ path: relativePath, integrity, package: nameSchema }).strict()) }).strict();

export function parseRecipe(value: unknown): EnvironmentRecipe { return recipeSchema.parse(value); }
export function parseLock(value: unknown): EnvironmentLock { return lockSchema.parse(value); }
export function parseState(value: unknown): EnvironmentState { return stateSchema.parse(value); }
export function parsePackageRecord(value: unknown) { return recordSchema.parse(value); }

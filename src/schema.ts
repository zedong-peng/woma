import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { valid, validRange } from "semver";
import type { HarnessManifest } from "./types.js";

const packageName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");
const envName = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name");
const platform = z.enum(["codex", "claude", "pi"]);
const platformList = z.array(platform).min(1).refine((items) => new Set(items).size === items.length, "must not contain duplicates");
const versionRange = z.string().min(1).refine((value) => validRange(value) !== null, "must be a valid semver range");

const stdioMcp = z
  .object({
    name: packageName,
    transport: z.literal("stdio").default("stdio"),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.array(envName).default([]),
    platforms: platformList.optional(),
  })
  .strict();

const remoteMcp = z
  .object({
    name: packageName,
    transport: z.enum(["http", "sse", "ws"]),
    url: z.string().url(),
    headers: z.record(z.string().min(1), envName).default({}),
    platforms: platformList.optional(),
  })
  .strict();

const manifestSchema = z
  .object({
    apiVersion: z.literal("harness.conda/v1"),
    kind: z.literal("Harness"),
    metadata: z
      .object({
        name: packageName,
        version: z.string().refine((value) => valid(value) !== null, "must be valid SemVer"),
        description: z.string().min(1).max(300),
        tags: z.array(packageName).default([]),
      })
      .strict(),
    spec: z
      .object({
        platforms: platformList.default(["codex", "claude"]),
        dependencies: z
          .array(
            z
              .object({
                name: packageName,
                version: versionRange,
                source: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        entrypoints: z
          .array(
            z
              .object({
                name: packageName,
                skill: packageName,
                description: z.string().min(1).max(300),
              })
              .strict(),
          )
          .default([]),
        requirements: z
          .object({
            env: z
              .array(
                z
                  .object({
                    name: envName,
                    description: z.string().min(1).optional(),
                    optional: z.boolean().default(false),
                  })
                  .strict(),
              )
              .default([]),
            commands: z.array(z.string().min(1)).default([]),
          })
          .strict()
          .default({ env: [], commands: [] }),
        skills: z
          .array(
            z
              .object({
                name: packageName,
                path: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        mcpServers: z.array(z.discriminatedUnion("transport", [stdioMcp, remoteMcp])).default([]),
        hooks: z
          .array(
            z
              .object({
                event: z.string().min(1),
                matcher: z.string().min(1).optional(),
                command: z.string().min(1),
                timeout: z.number().int().positive().optional(),
                platforms: platformList.optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
  })
  .strict();

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("\n");
}

export function parseManifest(input: string, source = "harness.yaml"): HarnessManifest {
  let document: unknown;
  try {
    document = parseYaml(input);
  } catch (error) {
    throw new Error(`${source}: invalid YAML: ${(error as Error).message}`);
  }

  const result = manifestSchema.safeParse(document);
  if (!result.success) {
    throw new Error(`${source}: invalid manifest\n${formatIssues(result.error)}`);
  }
  return result.data;
}

export async function loadManifest(root: string): Promise<HarnessManifest> {
  const manifestPath = path.join(root, "harness.yaml");
  const input = await readFile(manifestPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new Error(`No harness.yaml found in ${root}`);
    }
    throw error;
  });
  return parseManifest(input, manifestPath);
}

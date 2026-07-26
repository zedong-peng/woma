import { link, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { pathExists, writeTextAtomic } from "./fs.js";

function normalizeName(input: string): string {
  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) throw new Error("Cannot derive a Package name");
  return name;
}

export interface WorkflowSkeletonOptions {
  outputDirectory?: string;
  version?: string;
}

export interface WorkflowSkeletonResult {
  name: string;
  root: string;
  version: string;
}

export async function createWorkflowSkeleton(
  requestedName: string,
  options: WorkflowSkeletonOptions = {},
): Promise<WorkflowSkeletonResult> {
  const name = normalizeName(requestedName);
  const version = options.version ?? "0.1.0";
  if (semver.valid(version) !== version) throw new Error(`Invalid Package version: ${version}`);
  const outputDirectory = path.resolve(options.outputDirectory ?? ".");
  const root = path.join(outputDirectory, name);
  const manifestPath = path.join(root, "harness.yaml");
  const skillPath = path.join(root, "skills", `${name}-workflow`, "SKILL.md");
  const rootExists = await pathExists(root);
  if (rootExists) {
    const entries = await readdir(root);
    if (entries.length > 0) throw new Error(`Refusing to overwrite non-empty destination ${root}`);
  }
  await mkdir(outputDirectory, { recursive: true });
  const temporary = await mkdtemp(path.join(outputDirectory, `.${name}.skeleton-`));
  try {
    const temporaryManifest = path.join(temporary, "harness.yaml");
    const temporarySkill = path.join(temporary, "skills", `${name}-workflow`, "SKILL.md");
    await mkdir(path.dirname(temporarySkill), { recursive: true });
    await writeTextAtomic(
      temporaryManifest,
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: ${name}
  version: ${version}
  description: Describe the repeatable outcome this Harness Package delivers.
  tags: []
spec:
  platforms: [codex, claude, pi]
  dependencies: []
  entrypoints:
    - name: ${name}
      skill: ${name}-workflow
      description: Run the ${name} method.
  requirements:
    env: []
    commands: [git]
  skills:
    - name: ${name}-workflow
      path: ./skills/${name}-workflow
  mcpServers: []
  hooks: []
`,
    );
    await writeTextAtomic(
      temporarySkill,
      `---
name: ${name}-workflow
description: Runs the ${name} workflow. Use when the user asks for this domain-specific outcome.
---

# ${name} workflow

1. Inspect the current repository and state assumptions.
2. Execute the smallest complete workflow for the requested outcome.
3. Verify the result with objective evidence.
4. Report the outcome, remaining risks, and reproducible commands.
`,
    );
    if (rootExists) {
      try {
        await link(temporaryManifest, manifestPath);
        await rm(temporaryManifest);
        await rename(path.join(temporary, "skills"), path.join(root, "skills"));
      } catch (error) {
        await rm(manifestPath, { force: true });
        await rm(path.join(root, "skills"), { recursive: true, force: true });
        throw error;
      }
      await rm(temporary, { recursive: true, force: true });
    } else {
      await rename(temporary, root);
    }
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { root, name, version };
}

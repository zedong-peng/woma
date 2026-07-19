import { link, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pathExists, writeTextAtomic } from "./fs.js";

function normalizeName(input: string): string {
  const name = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!name) throw new Error("Cannot derive a package name; pass --name <name>");
  return name;
}

export async function scaffoldHarness(directory: string, requestedName?: string): Promise<{ root: string; name: string }> {
  const root = path.resolve(directory);
  const name = normalizeName(requestedName ?? path.basename(root));
  const manifestPath = path.join(root, "harness.yaml");
  const skillPath = path.join(root, "skills", `${name}-workflow`, "SKILL.md");
  const rootExists = await pathExists(root);
  if (rootExists) {
    const entries = await readdir(root);
    if (entries.length > 0) throw new Error(`Refusing to overwrite non-empty destination ${root}`);
  }
  await mkdir(path.dirname(root), { recursive: true });
  const temporary = await mkdtemp(path.join(path.dirname(root), `.${path.basename(root)}.init-`));
  try {
    const temporaryManifest = path.join(temporary, path.relative(root, manifestPath));
    const temporarySkill = path.join(temporary, path.relative(root, skillPath));
    await mkdir(path.dirname(temporarySkill), { recursive: true });
    await writeTextAtomic(
      temporaryManifest,
      `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: ${name}
  version: 0.1.0
  description: Describe the repeatable outcome this harness delivers.
  tags: []
spec:
  platforms: [codex, claude]
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
  return { root, name };
}

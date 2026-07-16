import { mkdir } from "node:fs/promises";
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
  if (await pathExists(manifestPath)) throw new Error(`Refusing to overwrite ${manifestPath}`);
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeTextAtomic(
    manifestPath,
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
    skillPath,
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
  return { root, name };
}

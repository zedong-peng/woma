import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { assertInside, pathExists, relativeDisplay, writeTextAtomic } from "./fs.js";
import { readProjectConfig } from "./project.js";
import { readState } from "./store.js";

interface HandoffMetadata {
  from: string;
  to: string;
  createdAt: string;
}

function parseFrontmatter(input: string): HandoffMetadata | undefined {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(input);
  if (!match?.[1]) return undefined;
  try {
    const value = parseYaml(match[1]) as Record<string, unknown>;
    if (typeof value.from !== "string" || typeof value.to !== "string" || typeof value.createdAt !== "string") return undefined;
    return { from: value.from, to: value.to, createdAt: value.createdAt };
  } catch {
    return undefined;
  }
}

function handoffRoot(projectRoot: string, configured: string): string {
  const root = path.resolve(projectRoot, configured);
  assertInside(projectRoot, root, "Handoff directory");
  return root;
}

export async function latestHandoff(projectRoot: string, toProfile: string): Promise<string | undefined> {
  const config = await readProjectConfig(projectRoot);
  const root = handoffRoot(projectRoot, config.spec.handoffDirectory);
  if (!(await pathExists(root))) return undefined;
  const candidates: { path: string; modified: number }[] = [];
  for (const entry of await readdir(root)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(root, entry);
    const metadata = parseFrontmatter(await readFile(filePath, "utf8"));
    if (metadata?.to !== toProfile) continue;
    candidates.push({ path: filePath, modified: (await stat(filePath)).mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  const latest = candidates[0]?.path;
  return latest ? relativeDisplay(projectRoot, latest) : undefined;
}

export async function createHandoff(projectRoot: string, toProfile: string): Promise<string> {
  const [config, state] = await Promise.all([readProjectConfig(projectRoot), readState(projectRoot)]);
  const active = state.profile;
  if (!active) throw new Error("No active profile. Switch to a profile before creating a handoff");
  if (!config.spec.profiles[toProfile]) throw new Error(`Unknown target profile: ${toProfile}`);
  if (active.name === toProfile) throw new Error(`Handoff target is already active: ${toProfile}`);

  const root = handoffRoot(projectRoot, config.spec.handoffDirectory);
  await mkdir(root, { recursive: true });
  const createdAt = new Date().toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const filePath = path.join(root, `${timestamp}-${active.name}-to-${toProfile}.md`);
  const bindings = Object.entries(config.spec.bindings);
  const bindingText = bindings.length > 0 ? bindings.map(([name, command]) => `- ${name}: \`${command}\``).join("\n") : "- None declared";
  await writeTextAtomic(
    filePath,
    `---
from: ${active.name}
to: ${toProfile}
createdAt: ${createdAt}
---

# ${active.name} -> ${toProfile} handoff

## Decision

State what the next profile should do and why.

## Evidence

List source paths, citations, measurements, and commands that support the decision.

## Hypotheses

List falsifiable hypotheses in priority order. Include the expected observation for each.

## Project bindings

${bindingText}

## Required inputs

List datasets, checkpoints, branches, environment variables, and external dependencies.

## Failure cases and uncertainty

Record rejected approaches, known failure modes, and unresolved uncertainty.

## Acceptance criteria

Define the objective checks that make the next phase complete.
`,
  );
  return relativeDisplay(projectRoot, filePath);
}

import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { parseSkillMetadata } from "./package.js";
import { environmentAgentHomePath, environmentViewPath } from "./view.js";
import type { HarnessEnvironment } from "./types.js";

export interface EnvironmentLocalSkill {
  name: string;
  description: string;
  entry: string;
  path: string;
  origin: "external";
  platform: "codex";
}

export interface EnvironmentLocalSkillIssue {
  entry: string;
  path: string;
  kind: "invalid" | "conflict";
  detail: string;
}

export interface EnvironmentLocalSkillInventory {
  skills: EnvironmentLocalSkill[];
  issues: EnvironmentLocalSkillIssue[];
}

function emptyInventory(): EnvironmentLocalSkillInventory {
  return { skills: [], issues: [] };
}

async function viewManagedSkillNames(environmentName: string): Promise<Set<string>> {
  const metadataPath = path.join(environmentViewPath(environmentName), "view.json");
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
    const skills = metadata.skills;
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) return new Set();
    const codex = (skills as Record<string, unknown>).codex;
    if (!codex || typeof codex !== "object" || Array.isArray(codex)) return new Set();
    return new Set(Object.keys(codex as Record<string, unknown>));
  } catch {
    return new Set();
  }
}

export async function inspectEnvironmentLocalSkills(
  environment: HarnessEnvironment,
  packageManagedNames: ReadonlySet<string> = new Set(),
): Promise<EnvironmentLocalSkillInventory> {
  if (!environment.spec.targets.includes("codex")) return emptyInventory();
  const environmentName = environment.metadata.name;
  const skillsRoot = path.join(environmentAgentHomePath(environmentName, "codex"), "skills");
  const rootInfo = await lstat(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!rootInfo || (!rootInfo.isDirectory() && !rootInfo.isSymbolicLink())) return emptyInventory();

  const managedNames = new Set([...packageManagedNames, ...await viewManagedSkillNames(environmentName)]);
  const skills: EnvironmentLocalSkill[] = [];
  const issues: EnvironmentLocalSkillIssue[] = [];
  const names = new Map<string, string>();

  const entries = await readdir(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const candidate = path.join(skillsRoot, entry);
    if (managedNames.has(entry)) continue;
    const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink()) {
      const target = await readlink(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (target && path.resolve(path.dirname(candidate), target) === path.join(environmentViewPath(environmentName), "codex", "skills", entry)) {
        continue;
      }
    }
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;

    let root: string;
    try {
      root = await realpath(candidate);
      if (!(await lstat(root)).isDirectory()) {
        issues.push({ entry, path: candidate, kind: "invalid", detail: "Environment-local Skill root is not a directory" });
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !(await lstat(candidate).catch(() => undefined))) continue;
      issues.push({ entry, path: candidate, kind: "invalid", detail: `Cannot resolve Environment-local Skill: ${(error as Error).message}` });
      continue;
    }
    const document = path.join(root, "SKILL.md");
    let documentInfo;
    try {
      documentInfo = await lstat(document);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      issues.push({ entry, path: candidate, kind: "invalid", detail: `Cannot inspect Environment-local Skill: ${(error as Error).message}` });
      continue;
    }
    if (!documentInfo) continue;
    if (!documentInfo.isFile() || documentInfo.isSymbolicLink()) {
      issues.push({ entry, path: candidate, kind: "invalid", detail: `Environment-local Skill has an invalid SKILL.md: ${document}` });
      continue;
    }

    try {
      const metadata = parseSkillMetadata(await readFile(document, "utf8"), document);
      const previousEntry = names.get(metadata.name);
      if (managedNames.has(metadata.name)) {
        issues.push({
          entry,
          path: candidate,
          kind: "conflict",
          detail: `Environment-local Skill ${metadata.name} conflicts with a Harness-managed Skill`,
        });
        continue;
      } else if (previousEntry) {
        issues.push({
          entry,
          path: candidate,
          kind: "conflict",
          detail: `Environment-local Skill ${metadata.name} is also provided by entry ${previousEntry}`,
        });
        continue;
      }
      names.set(metadata.name, entry);
      skills.push({
        name: metadata.name,
        description: metadata.description,
        entry,
        path: candidate,
        origin: "external",
        platform: "codex",
      });
    } catch (error) {
      issues.push({ entry, path: candidate, kind: "invalid", detail: (error as Error).message });
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name) || left.entry.localeCompare(right.entry));
  return { skills, issues };
}

import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { parseSkillMetadata } from "./package.js";
import { environmentAgentHomePath, environmentSkillsPath, environmentViewPath } from "./view.js";
import type { HarnessEnvironment, Platform } from "./types.js";

export interface EnvironmentLocalSkill {
  name: string;
  description: string;
  entry: string;
  path: string;
  origin: "external";
  platform: "environment";
  platforms: Platform[];
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
    const names = new Set<string>();
    for (const target of Object.values(skills as Record<string, unknown>)) {
      if (!target || typeof target !== "object" || Array.isArray(target)) continue;
      for (const name of Object.keys(target as Record<string, unknown>)) names.add(name);
    }
    return names;
  } catch {
    return new Set();
  }
}

export async function inspectEnvironmentLocalSkills(
  environment: HarnessEnvironment,
  packageManagedNames: ReadonlySet<string> = new Set(),
): Promise<EnvironmentLocalSkillInventory> {
  const environmentName = environment.metadata.name;
  const sharedRoot = environmentSkillsPath(environmentName);
  const sharedInfo = await lstat(sharedRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const roots: { path: string; platforms: Platform[] }[] = [];
  if (sharedInfo?.isDirectory() && !sharedInfo.isSymbolicLink()) {
    roots.push({ path: sharedRoot, platforms: environment.spec.targets });
  } else {
    for (const platform of environment.spec.targets) {
      const candidate = path.join(environmentAgentHomePath(environmentName, platform), "skills");
      const info = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (info && (info.isDirectory() || info.isSymbolicLink())) roots.push({ path: candidate, platforms: [platform] });
    }
  }
  if (roots.length === 0) return emptyInventory();

  const managedNames = new Set([...packageManagedNames, ...await viewManagedSkillNames(environmentName)]);
  const skills: EnvironmentLocalSkill[] = [];
  const issues: EnvironmentLocalSkillIssue[] = [];
  const names = new Map<string, EnvironmentLocalSkill>();

  for (const source of roots) {
    const entries = await readdir(source.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries.sort()) {
      if (entry.startsWith(".")) continue;
      const candidate = path.join(source.path, entry);
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
        if (
          target && environment.spec.targets.some(
            (platform) => path.resolve(path.dirname(candidate), target) === path.join(environmentViewPath(environmentName), platform, "skills", entry),
          )
        ) continue;
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
      if (!documentInfo.isFile() || documentInfo.isSymbolicLink()) {
        issues.push({ entry, path: candidate, kind: "invalid", detail: `Environment-local Skill has an invalid SKILL.md: ${document}` });
        continue;
      }

      try {
        const metadata = parseSkillMetadata(await readFile(document, "utf8"), document);
        const previous = names.get(metadata.name);
        if (managedNames.has(metadata.name)) {
          issues.push({
            entry,
            path: candidate,
            kind: "conflict",
            detail: `Environment-local Skill ${metadata.name} conflicts with a Harness-managed Skill`,
          });
          continue;
        } else if (previous) {
          if (await realpath(previous.path).catch(() => undefined) === root) {
            previous.platforms = [...new Set([...previous.platforms, ...source.platforms])];
            continue;
          }
          issues.push({
            entry,
            path: candidate,
            kind: "conflict",
            detail: `Environment-local Skill ${metadata.name} is also provided by entry ${previous.entry}`,
          });
          continue;
        }
        const skill: EnvironmentLocalSkill = {
          name: metadata.name,
          description: metadata.description,
          entry,
          path: candidate,
          origin: "external",
          platform: "environment",
          platforms: [...source.platforms],
        };
        names.set(metadata.name, skill);
        skills.push(skill);
      } catch (error) {
        issues.push({ entry, path: candidate, kind: "invalid", detail: (error as Error).message });
      }
    }
  }

  skills.sort((left, right) => left.name.localeCompare(right.name) || left.entry.localeCompare(right.entry));
  return { skills, issues };
}

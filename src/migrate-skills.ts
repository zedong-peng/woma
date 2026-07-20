import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_ENVIRONMENT, environmentPath, environmentSnapshot, installIntoEnvironment } from "./environment.js";
import { harnessHome, hashDirectory, pathExists, writeTextAtomic } from "./fs.js";
import { loadCachedPackage, validatePackage } from "./package.js";
import { loadManifest } from "./schema.js";
import { sourceAgentHome } from "./view.js";
import type { HarnessManifest, Platform, SkillSpec } from "./types.js";

const MIGRATED_PACKAGE = "migrated-agent-skills";
const EXCLUDED_NAMES = new Set([".git", ".harness", "node_modules", ".DS_Store"]);
const FOUNDATIONAL_SKILLS = new Set(["harness-project-memory", "harness-package-builder"]);

export type SkillMigrationSource = Platform | "both";

interface ExistingSkill {
  name: string;
  root: string;
  integrity: string;
  sources: Platform[];
  normalizeFrontmatter: boolean;
}

export interface SkillMigrationResult {
  environment: string;
  packageName: string;
  version: string;
  source: string;
  skills: { name: string; sources: Platform[] }[];
  normalized: string[];
  dryRun: boolean;
  unchanged: boolean;
}

function copyFilter(source: string): boolean {
  return !EXCLUDED_NAMES.has(path.basename(source));
}

function skillName(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (!value) throw new Error(`Cannot convert existing Skill ${JSON.stringify(input)} into a Skill name`);
  return value;
}

function legacyFrontmatter(input: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input);
  if (!match?.[1]) return false;
  try {
    parseYaml(match[1]);
    return false;
  } catch {
    return true;
  }
}

async function normalizeLegacyFrontmatter(filePath: string): Promise<void> {
  const input = await readFile(filePath, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(input);
  if (!match?.[1]) return;
  try {
    parseYaml(match[1]);
    return;
  } catch {}
  const normalized = match[1].replace(/^description:[ \t]+(.+)$/m, (_line, description: string) => {
    return `description: ${JSON.stringify(description.trim())}`;
  });
  parseYaml(normalized);
  await writeTextAtomic(filePath, input.replace(match[1], normalized));
}

async function discoverSkills(platform: Platform): Promise<ExistingSkill[]> {
  const skillsRoot = path.join(sourceAgentHome(platform), "skills");
  if (!(await pathExists(skillsRoot))) return [];
  const skills: ExistingSkill[] = [];
  for (const entry of (await readdir(skillsRoot)).sort()) {
    if (entry.startsWith(".")) continue;
    const candidate = path.join(skillsRoot, entry);
    const info = await lstat(candidate);
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    const root = await realpath(candidate);
    if (!(await lstat(root)).isDirectory() || !(await pathExists(path.join(root, "SKILL.md")))) continue;
    const name = skillName(entry);
    if (FOUNDATIONAL_SKILLS.has(name)) {
      throw new Error(`Existing Agent Skill ${name} conflicts with a foundational Harness Skill`);
    }
    const skillDocument = await readFile(path.join(root, "SKILL.md"), "utf8");
    skills.push({
      name,
      root,
      integrity: await hashDirectory(root),
      sources: [platform],
      normalizeFrontmatter: legacyFrontmatter(skillDocument),
    });
  }
  return skills;
}

async function existingSkills(source: SkillMigrationSource): Promise<ExistingSkill[]> {
  const platforms: Platform[] = source === "both" ? ["codex", "claude"] : [source];
  const byName = new Map<string, ExistingSkill>();
  for (const platform of platforms) {
    for (const skill of await discoverSkills(platform)) {
      const existing = byName.get(skill.name);
      if (!existing) {
        byName.set(skill.name, skill);
        continue;
      }
      if (existing.sources.includes(platform)) {
        throw new Error(`Existing ${platform} Skill names normalize to the same name ${skill.name}`);
      }
      if (existing.integrity !== skill.integrity) {
        throw new Error(
          `Existing Agent Skill ${skill.name} differs between Codex and Claude; choose --from codex or --from claude`,
        );
      }
      existing.sources.push(platform);
      existing.normalizeFrontmatter ||= skill.normalizeFrontmatter;
    }
  }
  const result = [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
  if (result.length === 0) throw new Error(`No existing Agent Skills found for --from ${source}`);
  return result;
}

function snapshotId(skills: ExistingSkill[]): string {
  const hash = createHash("sha256");
  for (const skill of skills) {
    hash.update(`${skill.name}\0${skill.integrity}\0${skill.sources.join(",")}\0`);
  }
  return hash.digest("hex");
}

function manifest(skills: ExistingSkill[], version: string): HarnessManifest {
  const specs: SkillSpec[] = skills.map((skill) => ({ name: skill.name, path: `./skills/${skill.name}` }));
  return {
    apiVersion: "harness.conda/v1",
    kind: "Harness",
    metadata: {
      name: MIGRATED_PACKAGE,
      version,
      description: "Skills explicitly migrated from existing Agent homes.",
      tags: ["captured", "migrated"],
    },
    spec: {
      platforms: ["codex", "claude"],
      dependencies: [],
      entrypoints: [],
      requirements: { env: [], commands: [] },
      skills: specs,
      mcpServers: [],
      hooks: [],
    },
  };
}

async function setTreeWritable(root: string, writable: boolean): Promise<void> {
  const info = await lstat(root).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    if (writable) await chmod(root, (info.mode & 0o777) | 0o700);
    for (const entry of await readdir(root)) await setTreeWritable(path.join(root, entry), writable);
    if (!writable) await chmod(root, (info.mode & 0o555) & ~0o222);
    return;
  }
  if (info.isFile()) await chmod(root, writable ? (info.mode & 0o777) | 0o600 : (info.mode & 0o555) & ~0o222);
}

async function removeTemporary(root: string): Promise<void> {
  await setTreeWritable(root, true);
  await rm(root, { recursive: true, force: true });
}

async function assertTreeReadonly(root: string): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) throw new Error(`Migrated Skill snapshot contains an unsupported symlink at ${root}`);
  if ((info.mode & 0o222) !== 0) throw new Error(`Migrated Skill snapshot is writable at ${root}`);
  if (info.isDirectory()) {
    for (const entry of await readdir(root)) await assertTreeReadonly(path.join(root, entry));
  }
}

async function validateSnapshot(root: string, version: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid migrated Skill snapshot at ${root}`);
  await assertTreeReadonly(root);
  const packageManifest = await loadManifest(root);
  if (packageManifest.metadata.name !== MIGRATED_PACKAGE || packageManifest.metadata.version !== version) {
    throw new Error(`Invalid migrated Skill snapshot identity at ${root}`);
  }
  await validatePackage(root, packageManifest);
}

async function buildSnapshot(root: string, skills: ExistingSkill[], version: string): Promise<void> {
  await mkdir(path.join(root, "skills"), { recursive: true, mode: 0o700 });
  for (const skill of skills) {
    const destinationSkill = path.join(root, "skills", skill.name);
    await cp(skill.root, destinationSkill, { recursive: true, errorOnExist: true, filter: copyFilter });
    if ((await hashDirectory(destinationSkill)) !== skill.integrity) {
      throw new Error(`Existing Agent Skill ${skill.name} changed while it was being migrated; retry the command`);
    }
    await chmod(destinationSkill, 0o700);
    await normalizeLegacyFrontmatter(path.join(destinationSkill, "SKILL.md"));
  }
  const packageManifest = manifest(skills, version);
  await writeTextAtomic(path.join(root, "harness.yaml"), stringifyYaml(packageManifest, { lineWidth: 120 }));
  await validatePackage(root, packageManifest);
}

async function assertNoEnvironmentConflicts(
  projectRoot: string,
  environmentName: string,
  skills: ExistingSkill[],
  version: string,
  source: string,
): Promise<boolean> {
  if (!(await pathExists(environmentPath(projectRoot, environmentName)))) {
    if (environmentName === DEFAULT_ENVIRONMENT) return false;
    await environmentSnapshot(projectRoot, environmentName);
  }
  const { lock } = await environmentSnapshot(projectRoot, environmentName);
  const migrated = lock.packages[MIGRATED_PACKAGE];
  const migrationSourceRoot = `file:${path.join(harnessHome(), "migrations", "skills")}${path.sep}`;
  if (migrated && !migrated.source.startsWith(migrationSourceRoot)) {
    throw new Error(
      `Package name ${MIGRATED_PACKAGE} is reserved for explicit Skill migration in Environment ${environmentName}`,
    );
  }
  const owners = new Map<string, string>();
  for (const locked of Object.values(lock.packages)) {
    if (locked.name === MIGRATED_PACKAGE) continue;
    const pkg = await loadCachedPackage(locked);
    for (const skill of pkg.manifest.spec.skills) owners.set(skill.name, locked.name);
  }
  for (const skill of skills) {
    const owner = owners.get(skill.name);
    if (owner) throw new Error(`Skill ${skill.name} is already provided by Package ${owner} in Environment ${environmentName}`);
  }
  return migrated?.version === version && migrated.source === source;
}

export async function migrateExistingSkills(options: {
  projectRoot: string;
  environment: string;
  from: SkillMigrationSource;
  dryRun?: boolean;
}): Promise<SkillMigrationResult> {
  const skills = await existingSkills(options.from);
  const id = snapshotId(skills);
  const version = `0.0.0-migrate.${id.slice(0, 12)}`;
  const destination = path.join(harnessHome(), "migrations", "skills", id);
  const source = `file:${destination}`;
  const unchanged = await assertNoEnvironmentConflicts(
    options.projectRoot,
    options.environment,
    skills,
    version,
    source,
  );
  const result: SkillMigrationResult = {
    environment: options.environment,
    packageName: MIGRATED_PACKAGE,
    version,
    source,
    skills: skills.map((skill) => ({ name: skill.name, sources: [...skill.sources] })),
    normalized: skills.filter((skill) => skill.normalizeFrontmatter).map((skill) => skill.name),
    dryRun: options.dryRun ?? false,
    unchanged,
  };
  if (options.dryRun) {
    if (await pathExists(destination)) await validateSnapshot(destination, version);
    else {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-skills-migration-plan-"));
      try {
        await buildSnapshot(temporary, skills, version);
      } finally {
        await removeTemporary(temporary);
      }
    }
    return result;
  }
  if (unchanged) {
    await validateSnapshot(destination, version);
    return result;
  }

  if (!(await pathExists(destination))) {
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const temporary = await mkdtemp(path.join(path.dirname(destination), ".skills-migration-"));
    try {
      await buildSnapshot(temporary, skills, version);
      await setTreeWritable(temporary, false);
      try {
        await rename(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
        await removeTemporary(temporary);
      }
    } catch (error) {
      await removeTemporary(temporary);
      throw error;
    }
  }
  await validateSnapshot(destination, version);
  await installIntoEnvironment(options.projectRoot, options.environment, source);
  return result;
}

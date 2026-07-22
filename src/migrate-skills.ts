import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_ENVIRONMENT, environmentPath, environmentSnapshot, installPackagesIntoEnvironment } from "./environment.js";
import { harnessHome, hashDirectory, pathExists, writeTextAtomic } from "./fs.js";
import { loadCachedPackage, validatePackage } from "./package.js";
import { loadManifest } from "./schema.js";
import { sourceAgentHome } from "./view.js";
import type { CodexClaudePlatform, HarnessManifest, SkillSpec } from "./types.js";

const EXCLUDED_NAMES = new Set([".git", ".harness", "node_modules", ".DS_Store"]);
const FOUNDATIONAL_SKILLS = new Set(["harness-project-memory", "harness-package-builder"]);

export type SkillMigrationSource = CodexClaudePlatform | "both";

interface ExistingSkill {
  name: string;
  root: string;
  integrity: string;
  sources: CodexClaudePlatform[];
  normalizeFrontmatter: boolean;
}

export interface SkillMigrationResult {
  environment: string;
  packages: {
    name: string;
    version: string;
    source: string;
    sources: CodexClaudePlatform[];
    unchanged: boolean;
  }[];
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

async function discoverSkills(platform: CodexClaudePlatform): Promise<ExistingSkill[]> {
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
  const platforms: CodexClaudePlatform[] = source === "both" ? ["codex", "claude"] : [source];
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

function snapshotId(skill: ExistingSkill): string {
  const hash = createHash("sha256");
  hash.update(`${skill.name}\0${skill.integrity}\0${skill.sources.join(",")}\0`);
  return hash.digest("hex");
}

function manifest(skill: ExistingSkill, version: string): HarnessManifest {
  const specs: SkillSpec[] = [{ name: skill.name, path: `./skills/${skill.name}` }];
  return {
    apiVersion: "harness.conda/v1",
    kind: "Harness",
    metadata: {
      name: skill.name,
      version,
      description: `${skill.name} explicitly migrated from an existing Agent home.`,
      tags: ["captured", "migrated"],
    },
    spec: {
      platforms: ["codex", "claude", "pi"],
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

async function validateSnapshot(root: string, name: string, version: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Invalid migrated Skill snapshot at ${root}`);
  await assertTreeReadonly(root);
  const packageManifest = await loadManifest(root);
  if (packageManifest.metadata.name !== name || packageManifest.metadata.version !== version) {
    throw new Error(`Invalid migrated Skill snapshot identity at ${root}`);
  }
  await validatePackage(root, packageManifest);
}

async function buildSnapshot(root: string, skill: ExistingSkill, version: string): Promise<void> {
  await mkdir(path.join(root, "skills"), { recursive: true, mode: 0o700 });
  const destinationSkill = path.join(root, "skills", skill.name);
  await cp(skill.root, destinationSkill, { recursive: true, errorOnExist: true, filter: copyFilter });
  if ((await hashDirectory(destinationSkill)) !== skill.integrity) {
    throw new Error(`Existing Agent Skill ${skill.name} changed while it was being migrated; retry the command`);
  }
  await chmod(destinationSkill, 0o700);
  await normalizeLegacyFrontmatter(path.join(destinationSkill, "SKILL.md"));
  const packageManifest = manifest(skill, version);
  await writeTextAtomic(path.join(root, "harness.yaml"), stringifyYaml(packageManifest, { lineWidth: 120 }));
  await validatePackage(root, packageManifest);
}

async function assertNoEnvironmentConflicts(
  projectRoot: string,
  environmentName: string,
  skills: ExistingSkill[],
  packages: { name: string; version: string; source: string }[],
): Promise<boolean[]> {
  if (!(await pathExists(environmentPath(projectRoot, environmentName)))) {
    if (environmentName === DEFAULT_ENVIRONMENT) return packages.map(() => false);
    await environmentSnapshot(projectRoot, environmentName);
  }
  const { lock } = await environmentSnapshot(projectRoot, environmentName);
  const owners = new Map<string, string>();
  for (const locked of Object.values(lock.packages)) {
    const pkg = await loadCachedPackage(locked);
    for (const skill of pkg.manifest.spec.skills) owners.set(skill.name, locked.name);
  }
  return skills.map((skill, index) => {
    const planned = packages[index]!;
    const installed = lock.packages[planned.name];
    const migrationSourceRoot = `file:${path.join(harnessHome(), "migrations", "skills", skill.name)}${path.sep}`;
    if (installed && !installed.source.startsWith(migrationSourceRoot)) {
      throw new Error(`Package name ${skill.name} is already installed from ${installed.source} in Environment ${environmentName}`);
    }
    const owner = owners.get(skill.name);
    if (owner && owner !== skill.name) {
      throw new Error(`Skill ${skill.name} is already provided by Package ${owner} in Environment ${environmentName}`);
    }
    return installed?.version === planned.version && installed.source === planned.source;
  });
}

export async function migrateExistingSkills(options: {
  projectRoot: string;
  environment: string;
  from: SkillMigrationSource;
  dryRun?: boolean;
}): Promise<SkillMigrationResult> {
  const skills = await existingSkills(options.from);
  const packages = skills.map((skill) => {
    const id = snapshotId(skill);
    const version = `0.0.0-migrate.${id.slice(0, 12)}`;
    const destination = path.join(harnessHome(), "migrations", "skills", skill.name, id);
    return { name: skill.name, version, destination, source: `file:${destination}`, sources: [...skill.sources] };
  });
  const unchangedPackages = await assertNoEnvironmentConflicts(options.projectRoot, options.environment, skills, packages);
  const unchanged = unchangedPackages.every(Boolean);
  const result: SkillMigrationResult = {
    environment: options.environment,
    packages: packages.map((pkg, index) => ({
      name: pkg.name,
      version: pkg.version,
      source: pkg.source,
      sources: pkg.sources,
      unchanged: unchangedPackages[index]!,
    })),
    normalized: skills.filter((skill) => skill.normalizeFrontmatter).map((skill) => skill.name),
    dryRun: options.dryRun ?? false,
    unchanged,
  };
  if (options.dryRun) {
    for (const [index, pkg] of packages.entries()) {
      if (await pathExists(pkg.destination)) await validateSnapshot(pkg.destination, pkg.name, pkg.version);
      else {
        const temporary = await mkdtemp(path.join(os.tmpdir(), "harness-skills-migration-plan-"));
        try {
          await buildSnapshot(temporary, skills[index]!, pkg.version);
        } finally {
          await removeTemporary(temporary);
        }
      }
    }
    return result;
  }
  if (unchanged) {
    for (const pkg of packages) await validateSnapshot(pkg.destination, pkg.name, pkg.version);
    return result;
  }

  for (const [index, pkg] of packages.entries()) {
    if (!(await pathExists(pkg.destination))) {
      await mkdir(path.dirname(pkg.destination), { recursive: true, mode: 0o700 });
      const temporary = await mkdtemp(path.join(path.dirname(pkg.destination), ".skills-migration-"));
      try {
        await buildSnapshot(temporary, skills[index]!, pkg.version);
        await setTreeWritable(temporary, false);
        try {
          await rename(temporary, pkg.destination);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw error;
          await removeTemporary(temporary);
        }
      } catch (error) {
        await removeTemporary(temporary);
        throw error;
      }
    }
    await validateSnapshot(pkg.destination, pkg.name, pkg.version);
  }
  const changedSources = packages.filter((_pkg, index) => !unchangedPackages[index]).map((pkg) => pkg.source);
  await installPackagesIntoEnvironment(options.projectRoot, options.environment, changedSources);
  return result;
}

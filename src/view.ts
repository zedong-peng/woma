import { chmod, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, rmdir, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalCapabilities } from "./agents/canonical.js";
import { renderCodexConfig } from "./agents/codex.js";
import { agentAdapter, resourceMetadataPlatforms } from "./agents/registry.js";
import type {
  AgentAdapter,
  AgentProjectionInput,
  ArtifactSnapshot,
  Diagnostic,
  DiscoveryResult,
  NativeArtifactContract,
  ProjectionPlan,
} from "./agents/adapter.js";
import { assertArtifactContracts } from "./agents/adapter.js";
import { womaHome, writeBufferPreservingFile, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import type { WomaEnvironment, InstalledPackage, Platform } from "./types.js";

interface ViewInstallHooks {
  beforeSwap?: () => Promise<(() => Promise<void>) | void>;
  beforePublish?: () => Promise<void> | void;
  previousPackages?: InstalledPackage[];
  seedFromOriginal?: boolean;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stable(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function equal(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function readOptional(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

async function regularFileExists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    (info) => info.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
}

function parseJsonObject(content: string | null, filePath: string): Record<string, unknown> {
  if (content === null || content.trim() === "") return {};
  try {
    const value: unknown = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("root must be an object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot merge ${filePath}: ${(error as Error).message}`);
  }
}

function nativeDefaultAgentHome(platform: Platform): string {
  const descriptor = agentAdapter(platform).descriptor.sourceHome;
  if (descriptor.defaultRootEnvironmentVariable) {
    const root = process.env[descriptor.defaultRootEnvironmentVariable]
      || path.join(os.homedir(), ...(descriptor.defaultRootPath ?? []));
    return path.resolve(root, ...descriptor.defaultPath);
  }
  return path.resolve(os.homedir(), ...descriptor.defaultPath);
}

function defaultAgentHome(platform: Platform): string {
  const descriptor = agentAdapter(platform).descriptor.sourceHome;
  return path.resolve(
    process.env[descriptor.originalEnvironmentVariable]
      || process.env[descriptor.environmentVariable]
      || nativeDefaultAgentHome(platform),
  );
}

export function sourceAgentHome(platform: Platform): string {
  const candidate = defaultAgentHome(platform);
  const environmentRoot = path.join(womaHome(), "environments");
  const relative = path.relative(environmentRoot, candidate);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return nativeDefaultAgentHome(platform);
  }
  return candidate;
}

export async function validateCodexSourceConfiguration(): Promise<void> {
  const sourceHome = sourceAgentHome("codex");
  const configPath = path.join(sourceHome, "config.toml");
  if (await regularFileExists(configPath)) {
    const capabilities = canonicalCapabilities([], "codex");
    renderCodexConfig(await readOptional(configPath), configPath, {
      capabilities,
      previousCapabilities: capabilities,
      artifacts: {},
      previousManagedMcpServers: [],
    });
  }
  const hooksPath = path.join(sourceHome, "hooks.json");
  if (await regularFileExists(hooksPath)) {
    parseJsonObject(await readOptional(hooksPath), hooksPath);
  }
}

export function environmentAgentHomePath(environmentName: string, platform: Platform): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(environmentName)) throw new Error(`Invalid Environment name: ${environmentName}`);
  return path.join(womaHome(), "environments", environmentName, "home", platform);
}

export function environmentSkillsPath(environmentName: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(environmentName)) throw new Error(`Invalid Environment name: ${environmentName}`);
  return path.join(womaHome(), "environments", environmentName, "home", "skills");
}

async function createSymlink(source: string, destination: string, directory: boolean): Promise<void> {
  try {
    await symlink(source, destination, process.platform === "win32" ? (directory ? "junction" : "file") : undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readlink(destination).catch(() => undefined);
    if (existing !== source) throw new Error(`Refusing to replace managed link ${destination}`);
  }
}

async function replaceSymlink(source: string, destination: string, directory: boolean): Promise<void> {
  const temporary = `${destination}.link-${process.pid}-${randomUUID()}`;
  try {
    await symlink(source, temporary, process.platform === "win32" ? (directory ? "junction" : "file") : undefined);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function linkSkills(
  destinationRoot: string,
  packages: InstalledPackage[],
): Promise<Record<string, string>> {
  const skillsRoot = path.join(destinationRoot, "skills");
  await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
  const owners = new Map<string, string>();
  const links: Record<string, string> = {};
  for (const pkg of packages) {
    for (const skill of pkg.manifest.spec.skills) {
      const existing = owners.get(skill.name);
      if (existing) throw new Error(`Skill ${skill.name} is provided by both ${existing} and ${pkg.lock.name}`);
      owners.set(skill.name, pkg.lock.name);
      const source = path.resolve(pkg.root, skill.path);
      await symlink(source, path.join(skillsRoot, skill.name), process.platform === "win32" ? "junction" : "dir");
      links[skill.name] = source;
    }
  }
  return links;
}

interface BuiltAgentProjection {
  adapter: AgentAdapter;
  artifacts: NativeArtifactContract[];
  input: AgentProjectionInput;
  plan: ProjectionPlan;
  skillLinks: Record<string, string>;
}

async function readArtifactSnapshot(contract: NativeArtifactContract): Promise<ArtifactSnapshot> {
  for (const source of contract.sources) {
    const content = await readFile(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (content === undefined) continue;
    const info = await stat(source);
    return {
      contract,
      sourcePath: source,
      text: contract.content === "text" ? content.toString("utf8") : null,
      bytes: contract.content === "opaque" ? content : null,
      mode: info.mode,
    };
  }
  return { contract, sourcePath: null, text: null, bytes: null, mode: undefined };
}

async function writeBufferAtomic(filePath: string, content: Uint8Array, mode: number): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function resourceMetadataKey(platform: Platform): string {
  return `${platform}McpServers`;
}

async function buildAgentProjection(
  environmentName: string,
  platform: Platform,
  root: string,
  packages: InstalledPackage[],
  previousPackages: InstalledPackage[],
  seedFromOriginal: boolean,
  previousMetadata: ViewMetadata,
): Promise<BuiltAgentProjection> {
  const adapter = agentAdapter(platform);
  if (adapter.descriptor.capabilities.skills !== "symlink") {
    throw new Error(
      `${adapter.descriptor.displayName} Adapter uses unsupported Skill strategy ${adapter.descriptor.capabilities.skills}`,
    );
  }
  const context = {
    environmentName,
    sourceHome: sourceAgentHome(platform),
    defaultSourceHome: nativeDefaultAgentHome(platform),
    environmentHome: environmentAgentHomePath(environmentName, platform),
    currentView: path.join(environmentViewPath(environmentName), platform),
    seedFromOriginal,
    originalRuntimeVariables: Object.fromEntries(
      adapter.descriptor.runtimeVariables.map((variable) => [
        variable.name,
        process.env[variable.originalName] ?? process.env[variable.name],
      ]),
    ),
  };
  const artifacts = adapter.artifacts(context);
  assertArtifactContracts(adapter, artifacts);
  const snapshots = await Promise.all(artifacts.map(readArtifactSnapshot));
  const input: AgentProjectionInput = {
    capabilities: canonicalCapabilities(packages, platform),
    previousCapabilities: canonicalCapabilities(previousPackages, platform),
    artifacts: Object.fromEntries(snapshots.map((snapshot) => [snapshot.contract.id, snapshot])),
    previousManagedMcpServers: stringArray(previousMetadata.resources?.[resourceMetadataKey(platform)]),
  };
  const errors = adapter.validate(input).filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new Error(`${adapter.descriptor.displayName} Adapter cannot project the Environment:\n${errors.map((issue) => `- ${issue.message}`).join("\n")}`);
  }
  const plan = adapter.plan(input);
  const contracts = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const planned = new Set<string>();
  for (const file of plan.files) {
    if (planned.has(file.artifactId)) throw new Error(`${adapter.descriptor.displayName} Adapter planned artifact ${file.artifactId} twice`);
    planned.add(file.artifactId);
    const contract = contracts.get(file.artifactId);
    if (!contract) throw new Error(`${adapter.descriptor.displayName} Adapter planned undeclared artifact ${file.artifactId}`);
    if (contract.target === "input") {
      throw new Error(`${adapter.descriptor.displayName} Adapter cannot write input artifact ${file.artifactId}`);
    }
    if (contract.content !== "text") throw new Error(`${adapter.descriptor.displayName} Adapter cannot render opaque artifact ${file.artifactId}`);
  }
  for (const contract of artifacts) {
    if (contract.target !== "input" && contract.content === "text" && !planned.has(contract.id)) {
      throw new Error(`${adapter.descriptor.displayName} Adapter did not plan text artifact ${contract.id}`);
    }
  }
  const plannedMcpServers = [...plan.resources.mcpServers].sort();
  const expectedMcpServers = input.capabilities.mcpServers.map(({ server }) => server.name).sort();
  if (new Set(plannedMcpServers).size !== plannedMcpServers.length || !equal(plannedMcpServers, expectedMcpServers)) {
    throw new Error(`${adapter.descriptor.displayName} Adapter plan does not account for the complete MCP closure`);
  }

  await mkdir(root, { recursive: true, mode: 0o700 });
  const skillLinks = await linkSkills(root, packages);
  for (const snapshot of snapshots) {
    if (snapshot.contract.target !== "view" || snapshot.contract.content !== "opaque" || snapshot.bytes === null) continue;
    await writeBufferPreservingFile(
      path.join(root, snapshot.contract.relativePath),
      Buffer.from(snapshot.bytes),
      snapshot.mode ?? snapshot.contract.mode,
    );
  }
  for (const file of plan.files) {
    const contract = contracts.get(file.artifactId)!;
    if (contract.target !== "view") continue;
    const destination = path.join(root, contract.relativePath);
    await writeTextAtomic(destination, file.content);
    await chmod(destination, contract.mode);
  }
  return { adapter, artifacts, input, plan, skillLinks };
}

export function environmentViewPath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid Environment name: ${name}`);
  return path.join(womaHome(), "environments", name, "view");
}

interface ViewMetadata {
  targets?: unknown;
  skills?: unknown;
  resources?: Record<string, unknown> | undefined;
}

async function previousViewMetadata(root: string): Promise<ViewMetadata> {
  return parseJsonObject(await readOptional(path.join(root, "view.json")), path.join(root, "view.json")) as ViewMetadata;
}

function validateViewMetadataShape(metadata: ViewMetadata, metadataPath: string): void {
  const allowed = new Set(["environment", "targets", "packages", "skills", "resources"]);
  const unexpected = Object.keys(metadata).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Environment view metadata contains unexpected fields at ${metadataPath}: ${unexpected.join(", ")}`);
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

interface StableHomeTransition {
  apply: () => Promise<() => Promise<void>>;
  finalize: () => Promise<void>;
}

function metadataSkillNames(metadata: ViewMetadata, platform: Platform): string[] {
  if (!metadata.skills || typeof metadata.skills !== "object" || Array.isArray(metadata.skills)) return [];
  const target = (metadata.skills as Record<string, unknown>)[platform];
  if (!target || typeof target !== "object" || Array.isArray(target)) return [];
  return Object.keys(target as Record<string, unknown>);
}

function packageSkillNames(packages: InstalledPackage[]): string[] {
  return packages.flatMap((pkg) => pkg.manifest.spec.skills.map((skill) => skill.name));
}

async function managedLinkMatches(link: string, source: string): Promise<boolean> {
  const info = await lstat(link).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info?.isSymbolicLink()) return false;
  return path.resolve(path.dirname(link), await readlink(link)) === source;
}

interface AgentSkillsRootPlan {
  root: string;
  exists: boolean;
}

async function prepareSharedSkillsTransition(
  environment: WomaEnvironment,
  packages: InstalledPackage[],
  previousMetadata: ViewMetadata,
  previousPackages: InstalledPackage[],
): Promise<StableHomeTransition> {
  const environmentName = environment.metadata.name;
  const skillsRoot = environmentSkillsPath(environmentName);
  const viewSkillsRoot = path.join(environmentViewPath(environmentName), "skills");
  const desiredNames = new Set(packageSkillNames(packages));
  const previousNames = new Set([
    ...environment.spec.targets.flatMap((platform) => metadataSkillNames(previousMetadata, platform)),
    ...packageSkillNames(previousPackages),
  ]);
  const skillsInfo = await lstat(skillsRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (skillsInfo && (!skillsInfo.isDirectory() || skillsInfo.isSymbolicLink())) {
    throw new Error(`Environment Skills root must be a real directory: ${skillsRoot}`);
  }

  const createNames: string[] = [];
  const removeNames: string[] = [];
  for (const name of desiredNames) {
    const link = path.join(skillsRoot, name);
    const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing) createNames.push(name);
    else if (!(await managedLinkMatches(link, path.join(viewSkillsRoot, name)))) {
      throw new Error(`Refusing to replace an Environment-owned Skill with a Woma Skill: ${link}`);
    }
  }
  for (const name of previousNames) {
    if (desiredNames.has(name)) continue;
    const link = path.join(skillsRoot, name);
    const existing = await lstat(link).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!existing) continue;
    if (!(await managedLinkMatches(link, path.join(viewSkillsRoot, name)))) {
      throw new Error(`Refusing to remove a modified Woma-managed Skill path: ${link}`);
    }
    removeNames.push(name);
  }

  const roots: AgentSkillsRootPlan[] = [];
  for (const platform of environment.spec.targets) {
    const root = path.join(environmentAgentHomePath(environmentName, platform), "skills");
    const info = await lstat(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!info) {
      roots.push({ root, exists: false });
      continue;
    }
    if (!info.isSymbolicLink() || !(await managedLinkMatches(root, skillsRoot))) {
      throw new Error(`Agent Skills root must be the shared Environment link: ${root}`);
    }
    roots.push({ root, exists: true });
  }

  return {
    apply: async () => {
      const rootCreated = !skillsInfo;
      const created: string[] = [];
      const removed: { name: string; target: string }[] = [];
      const createdRoots: string[] = [];
      const rollback = async (): Promise<void> => {
        const errors: unknown[] = [];
        for (const root of [...createdRoots].reverse()) {
          try {
            if (await managedLinkMatches(root, skillsRoot)) await rm(root, { force: true });
            else if (await lstat(root).catch(() => undefined)) throw new Error(`Refusing to remove a modified Agent Skills path: ${root}`);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const name of [...created].reverse()) {
          const link = path.join(skillsRoot, name);
          try {
            if (await managedLinkMatches(link, path.join(viewSkillsRoot, name))) await rm(link, { force: true });
            else if (await lstat(link).catch(() => undefined)) throw new Error(`Refusing to remove a modified shared Skill path: ${link}`);
          } catch (error) {
            errors.push(error);
          }
        }
        for (const item of [...removed].reverse()) {
          const link = path.join(skillsRoot, item.name);
          try {
            if (!(await lstat(link).catch(() => undefined))) {
              await symlink(item.target, link, process.platform === "win32" ? "junction" : "dir");
            } else if (!(await managedLinkMatches(link, path.resolve(path.dirname(link), item.target)))) {
              throw new Error(`Refusing to overwrite an Environment-owned Skill path during rollback: ${link}`);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (rootCreated) {
          await rmdir(skillsRoot).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY" && error.code !== "EEXIST") errors.push(error);
          });
        }
        if (errors.length > 0) throw new AggregateError(errors, "Could not roll back shared Environment Skills");
      };
      try {
        await mkdir(skillsRoot, { recursive: true, mode: 0o700 });
        for (const name of removeNames) {
          const link = path.join(skillsRoot, name);
          removed.push({ name, target: await readlink(link) });
          await rm(link, { force: true });
        }
        for (const name of createNames) {
          await symlink(path.join(viewSkillsRoot, name), path.join(skillsRoot, name), process.platform === "win32" ? "junction" : "dir");
          created.push(name);
        }
        for (const plan of roots) {
          if (plan.exists) continue;
          await mkdir(path.dirname(plan.root), { recursive: true, mode: 0o700 });
          await symlink(skillsRoot, plan.root, process.platform === "win32" ? "junction" : undefined);
          createdRoots.push(plan.root);
        }
        return rollback;
      } catch (error) {
        try {
          await rollback();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Could not update shared Environment Skills");
        }
        throw error;
      }
    },
    finalize: async () => undefined,
  };
}
async function prepareStableHomeTransition(
  environment: WomaEnvironment,
  packages: InstalledPackage[],
  previousMetadata: ViewMetadata,
  previousPackages: InstalledPackage[],
  builds: ReadonlyMap<Platform, BuiltAgentProjection>,
): Promise<StableHomeTransition> {
  const sharedSkills = await prepareSharedSkillsTransition(environment, packages, previousMetadata, previousPackages);
  const links: {
    destination: string;
    source: string;
    directory: boolean;
    action: "create" | "keep" | "replace";
    previous?: { target?: string; content?: Buffer; mode?: number };
  }[] = [];
  for (const platform of environment.spec.targets) {
    const home = environmentAgentHomePath(environment.metadata.name, platform);
    const build = builds.get(platform);
    if (!build) throw new Error(`Missing ${platform} Adapter projection`);
    for (const artifact of build.artifacts.filter((item) => item.target === "view")) {
      const name = artifact.relativePath;
      const destination = path.join(home, name);
      const source = path.join(environmentViewPath(environment.metadata.name), platform, name);
      const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) {
        links.push({ destination, source, directory: name === "skills", action: "create" });
        continue;
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(destination);
        const actual = path.resolve(path.dirname(destination), target);
        if (actual === source) {
          links.push({ destination, source, directory: name === "skills", action: "keep" });
          continue;
        }
        if (artifact.credential && actual === path.join(sourceAgentHome(platform), name)) {
          links.push({ destination, source, directory: false, action: "replace", previous: { target } });
          continue;
        }
        throw new Error(`Managed Agent home link has an unexpected target: ${destination}`);
      }
      if (artifact.credential && info.isFile()) {
        links.push({
          destination,
          source,
          directory: false,
          action: "replace",
          previous: { content: await readFile(destination), mode: info.mode },
        });
        continue;
      }
      throw new Error(`Managed Agent home path must be a symbolic link: ${destination}`);
    }
  }

  const homeWrites: {
    path: string;
    input: string | Buffer | null;
    mode: number | undefined;
    output: string | Buffer;
    outputMode: number;
    forceRegular: boolean;
    previousLink: string | undefined;
  }[] = [];
  for (const [platform, build] of builds) {
    const contracts = new Map(build.artifacts.map((artifact) => [artifact.id, artifact]));
    const planned = new Map(build.plan.files.map((file) => [file.artifactId, file.content]));
    for (const contract of build.artifacts.filter((artifact) => artifact.target === "home")) {
      const destination = path.join(environmentAgentHomePath(environment.metadata.name, platform), contract.relativePath);
      const info = await lstat(destination).catch(() => undefined);
      const previousLink = info?.isSymbolicLink() ? await readlink(destination) : undefined;
      const input = contract.content === "opaque"
        ? await readFile(destination).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return null;
          throw error;
        })
        : await readOptional(destination);
      const output = contract.content === "opaque"
        ? build.input.artifacts[contract.id]?.bytes
        : planned.get(contract.id);
      if (output === undefined || output === null) continue;
      if (contract.content === "text" && typeof output !== "string") {
        throw new Error(`${build.adapter.descriptor.displayName} planned non-text output for ${contract.id}`);
      }
      if (contract.content === "opaque" && !(output instanceof Uint8Array)) {
        throw new Error(`${build.adapter.descriptor.displayName} planned non-binary output for ${contract.id}`);
      }
      homeWrites.push({
        path: destination,
        input,
        mode: info?.mode,
        output: contract.content === "opaque" ? Buffer.from(output) : output as string,
        outputMode: contract.mode,
        forceRegular: previousLink !== undefined,
        previousLink,
      });
    }
  }

  return {
    apply: async () => {
      const rollbacks: (() => Promise<void>)[] = [];
      try {
        rollbacks.push(await sharedSkills.apply());
        for (const link of links.filter((item) => item.action === "create")) {
          await mkdir(path.dirname(link.destination), { recursive: true, mode: 0o700 });
          await createSymlink(link.source, link.destination, link.directory);
          rollbacks.push(() => rm(link.destination, { force: true }));
        }
        for (const link of links.filter((item) => item.action === "replace")) {
          await replaceSymlink(link.source, link.destination, link.directory);
          rollbacks.push(async () => {
            if (link.previous?.target !== undefined) {
              await replaceSymlink(link.previous.target, link.destination, link.directory);
            } else if (link.previous?.content !== undefined) {
              await rm(link.destination, { force: true });
              await writeBufferPreservingFile(link.destination, link.previous.content, link.previous.mode);
            }
          });
        }
        for (const write of homeWrites.filter((item) => item.forceRegular || !equal(item.input, item.output))) {
          const currentInfo = await lstat(write.path).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          });
          const currentLink = currentInfo?.isSymbolicLink() ? await readlink(write.path) : undefined;
          const currentInput = write.output instanceof Buffer
            ? await readFile(write.path).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            })
            : await readOptional(write.path);
          if (currentLink !== write.previousLink || !equal(currentInput, write.input)) {
            throw new Error(`Stable Agent home changed while preparing ${write.path}; retry after the Agent stops writing`);
          }
          await mkdir(path.dirname(write.path), { recursive: true, mode: 0o700 });
          if (typeof write.output === "string") {
            await writeTextAtomic(write.path, write.output);
            await chmod(write.path, write.outputMode);
          } else {
            await writeBufferAtomic(write.path, write.output, write.outputMode);
          }
          rollbacks.push(async () => {
            if (write.previousLink !== undefined) {
              await rm(write.path, { force: true });
              await replaceSymlink(write.previousLink, write.path, false);
            } else if (write.input === null) await rm(write.path, { force: true });
            else if (Buffer.isBuffer(write.input)) await writeBufferAtomic(write.path, write.input, write.mode ?? write.outputMode);
            else {
              await writeTextAtomic(write.path, write.input);
              if (write.mode !== undefined) await chmod(write.path, write.mode);
            }
          });
        }
        return async () => {
          const errors: unknown[] = [];
          for (const rollback of [...rollbacks].reverse()) {
            try {
              await rollback();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) throw new AggregateError(errors, "Could not roll back stable Agent home changes");
        };
      } catch (error) {
        for (const rollback of [...rollbacks].reverse()) await rollback().catch(() => undefined);
        throw error;
      }
    },
    finalize: () => sharedSkills.finalize(),
  };
}

async function publishViewGeneration(generation: string, destination: string, hooks: ViewInstallHooks): Promise<void> {
  const parent = path.dirname(destination);
  const current = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (current && !current.isSymbolicLink()) {
    throw new Error(`Environment view must be a symbolic link: ${destination}`);
  }
  const previousTarget = current ? await readlink(destination) : undefined;
  const nextLink = path.join(parent, `.view.link-${process.pid}-${randomUUID()}`);
  let rollbackLink: string | undefined;
  let rollbackMetadata: (() => Promise<void>) | void = undefined;
  try {
    rollbackMetadata = await hooks.beforeSwap?.();
    await symlink(path.basename(generation), nextLink, process.platform === "win32" ? "junction" : undefined);
    await rename(nextLink, destination);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      if (previousTarget) {
        rollbackLink = path.join(parent, `.view.rollback-${process.pid}-${randomUUID()}`);
        await symlink(previousTarget, rollbackLink, process.platform === "win32" ? "junction" : undefined);
        await rename(rollbackLink, destination);
      } else {
        await rm(destination, { force: true });
      }
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      await rollbackMetadata?.();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Environment view publication failed and rollback was incomplete");
    }
    throw error;
  } finally {
    await rm(nextLink, { force: true }).catch(() => undefined);
    if (rollbackLink) await rm(rollbackLink, { force: true }).catch(() => undefined);
  }
  // Retired generations remain available to Agents that still have managed files open.
}

export async function materializeEnvironmentView(
  environment: WomaEnvironment,
  packages: InstalledPackage[],
  hooks: ViewInstallHooks = {},
): Promise<void> {
  const name = environment.metadata.name;
  const seedFromOriginal = hooks.seedFromOriginal ?? false;
  const destination = environmentViewPath(name);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.view.gen-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  let finalizeHome: (() => Promise<void>) | undefined;
  try {
    const previousMetadata = await previousViewMetadata(destination);
    validateViewMetadataShape(previousMetadata, path.join(destination, "view.json"));
    await linkSkills(temporary, packages);
    const skillLinks: Partial<Record<Platform, Record<string, string>>> = {};
    const builds = new Map<Platform, BuiltAgentProjection>();
    for (const platform of environment.spec.targets) {
      const build = await buildAgentProjection(
        name,
        platform,
        path.join(temporary, platform),
        packages,
        hooks.previousPackages ?? [],
        seedFromOriginal,
        previousMetadata,
      );
      builds.set(platform, build);
      skillLinks[platform] = build.skillLinks;
    }
    const resources: Record<string, string[]> = {};
    for (const platform of resourceMetadataPlatforms(environment.spec.targets)) {
      resources[resourceMetadataKey(platform)] = builds.get(platform)?.plan.resources.mcpServers ?? [];
    }
    await writeJsonAtomic(path.join(temporary, "view.json"), {
      environment: name,
      targets: environment.spec.targets,
      packages: packages.map((pkg) => ({ name: pkg.lock.name, version: pkg.lock.version, integrity: pkg.lock.integrity })),
      skills: skillLinks,
      resources,
    });
    await hooks.beforePublish?.();
    const homeTransition = await prepareStableHomeTransition(
      environment,
      packages,
      previousMetadata,
      hooks.previousPackages ?? [],
      builds,
    );
    await publishViewGeneration(temporary, destination, {
      ...hooks,
      beforeSwap: async () => {
        const rollbackHome = await homeTransition.apply();
        try {
          const rollbackMetadata = await hooks.beforeSwap?.();
          return async () => {
            const errors: unknown[] = [];
            try {
              await rollbackMetadata?.();
            } catch (error) {
              errors.push(error);
            }
            try {
              await rollbackHome();
            } catch (error) {
              errors.push(error);
            }
            if (errors.length > 0) throw new AggregateError(errors, "Could not roll back Environment publication");
          };
        } catch (error) {
          await rollbackHome();
          throw error;
        }
      },
    });
    finalizeHome = homeTransition.finalize;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  // The view is already committed; failed disposal may retain only a hidden equivalent backup.
  await finalizeHome?.().catch(() => undefined);
}

export async function validateEnvironmentView(environment: WomaEnvironment, packages: InstalledPackage[]): Promise<void> {
  const root = environmentViewPath(environment.metadata.name);
  const metadataPath = path.join(root, "view.json");
  const metadata = parseJsonObject(await readOptional(metadataPath), metadataPath);
  validateViewMetadataShape(metadata, metadataPath);
  const expected = packages.map((pkg) => ({ name: pkg.lock.name, version: pkg.lock.version, integrity: pkg.lock.integrity }));
  const expectedResources: Record<string, string[]> = {};
  for (const platform of resourceMetadataPlatforms(environment.spec.targets)) {
    expectedResources[resourceMetadataKey(platform)] = environment.spec.targets.includes(platform)
      ? canonicalCapabilities(packages, platform).mcpServers.map(({ server }) => server.name)
      : [];
  }
  if (
    metadata.environment !== environment.metadata.name ||
    !equal(metadata.targets, environment.spec.targets) ||
    !equal(metadata.packages, expected) ||
    !equal(metadata.resources, expectedResources)
  ) {
    throw new Error(`Environment view is missing or stale at ${root}; reinstall one of the Environment's root Packages`);
  }
  const expectedSkills: Record<string, string> = {};
  for (const pkg of packages) {
    for (const skill of pkg.manifest.spec.skills) expectedSkills[skill.name] = path.resolve(pkg.root, skill.path);
  }
  const validateSkillView = async (skillsRoot: string, exact: boolean): Promise<void> => {
    for (const [name, source] of Object.entries(expectedSkills)) {
      const link = path.join(skillsRoot, name);
      const info = await lstat(link).catch(() => undefined);
      if (!info?.isSymbolicLink()) throw new Error(`Environment Skill link is missing: ${link}`);
      const expectedSource = await realpath(source);
      const actual = await realpath(link).catch(() => undefined);
      if (actual !== expectedSource) throw new Error(`Environment Skill link has an unexpected target: ${link}`);
    }
    if (exact) {
      const actualSkillNames = (await readdir(skillsRoot).catch(() => [])).sort();
      const expectedSkillNames = Object.keys(expectedSkills).sort();
      if (!equal(actualSkillNames, expectedSkillNames)) {
        throw new Error(`Environment Skill visibility differs from the lock at ${skillsRoot}`);
      }
    }
  };
  const sharedSkillsRoot = environmentSkillsPath(environment.metadata.name);
  const sharedViewSkillsRoot = path.join(root, "skills");
  const sharedInfo = await lstat(sharedSkillsRoot).catch(() => undefined);
  if (!sharedInfo?.isDirectory() || sharedInfo.isSymbolicLink()) {
    throw new Error(`Shared Environment Skills root is missing or invalid: ${sharedSkillsRoot}`);
  }
  await validateSkillView(sharedViewSkillsRoot, true);
  for (const name of Object.keys(expectedSkills)) {
    const link = path.join(sharedSkillsRoot, name);
    if (!(await managedLinkMatches(link, path.join(sharedViewSkillsRoot, name)))) {
      throw new Error(`Woma-managed shared Skill link is missing or invalid: ${link}`);
    }
  }
  for (const target of environment.spec.targets) {
    const home = environmentAgentHomePath(environment.metadata.name, target);
    const adapter = agentAdapter(target);
    const artifactContext = {
      environmentName: environment.metadata.name,
      sourceHome: sourceAgentHome(target),
      defaultSourceHome: nativeDefaultAgentHome(target),
      environmentHome: home,
      currentView: path.join(root, target),
      seedFromOriginal: false,
      originalRuntimeVariables: Object.fromEntries(
        adapter.descriptor.runtimeVariables.map((variable) => [
          variable.name,
          process.env[variable.originalName] ?? process.env[variable.name],
        ]),
      ),
    };
    const artifacts = adapter.artifacts(artifactContext);
    assertArtifactContracts(adapter, artifacts);
    const homeInfo = await lstat(home).catch(() => undefined);
    if (!homeInfo?.isDirectory() || homeInfo.isSymbolicLink()) {
      throw new Error(`Stable Agent home is missing or invalid: ${home}`);
    }
    for (const artifact of artifacts.filter((item) => item.target === "home" && item.content === "text")) {
      const info = await lstat(path.join(home, artifact.relativePath)).catch(() => undefined);
      if (!info?.isFile()) {
        throw new Error(`Stable Agent home text config must be a regular file: ${path.join(home, artifact.relativePath)}`);
      }
    }
    for (const artifact of artifacts.filter((item) => item.target === "view")) {
      const name = artifact.relativePath;
      const link = path.join(home, name);
      const info = await lstat(link).catch(() => undefined);
      if (!info?.isSymbolicLink()) throw new Error(`Managed Agent home link is missing: ${link}`);
      const expected = path.join(root, target, name);
      const actual = path.resolve(path.dirname(link), await readlink(link));
      if (actual !== expected) throw new Error(`Managed Agent home link has an unexpected target: ${link}`);
    }
    for (const artifact of artifacts.filter((item) => item.target === "home" && item.content === "opaque")) {
      const pathInHome = path.join(home, artifact.relativePath);
      const info = await lstat(pathInHome).catch(() => undefined);
      if (info && (!info.isFile() || info.isSymbolicLink())) {
        throw new Error(`Opaque Agent state must be a regular file: ${pathInHome}`);
      }
    }
    const homeSkills = path.join(home, "skills");
    const homeSkillsInfo = await lstat(homeSkills).catch(() => undefined);
    if (!homeSkillsInfo?.isSymbolicLink() || !(await managedLinkMatches(homeSkills, sharedSkillsRoot))) {
      throw new Error(`Agent Skills link does not use the shared Environment root: ${homeSkills}`);
    }
    const managedViewEntries = new Set(["skills", ...artifacts.filter((item) => item.target === "view").map((item) => item.relativePath)]);
    const unexpectedViewEntries = (await readdir(path.join(root, target))).filter((name) => !managedViewEntries.has(name));
    if (unexpectedViewEntries.length > 0) {
      throw new Error(`Environment view contains unmanaged Agent state: ${unexpectedViewEntries.join(", ")}`);
    }
    const skillsRoot = path.join(root, target, "skills");
    await validateSkillView(skillsRoot, true);
    const metadataSkills = metadata.skills;
    if (!metadataSkills || typeof metadataSkills !== "object" || Array.isArray(metadataSkills)) {
      throw new Error(`Environment Skill ownership metadata is missing from ${metadataPath}`);
    }
    if (!equal((metadataSkills as Record<string, unknown>)[target], expectedSkills)) {
      throw new Error(`Environment Skill ownership metadata is stale for ${target} in ${metadataPath}`);
    }
    const snapshots = await Promise.all(artifacts.map(readArtifactSnapshot));
    const capabilities = canonicalCapabilities(packages, target);
    const projectionInput: AgentProjectionInput = {
      capabilities,
      previousCapabilities: capabilities,
      artifacts: Object.fromEntries(snapshots.map((snapshot) => [snapshot.contract.id, snapshot])),
      previousManagedMcpServers: stringArray(
        (metadata.resources as Record<string, unknown> | undefined)?.[resourceMetadataKey(target)],
      ),
    };
    const issues = adapter.diagnose(projectionInput).filter((issue) => issue.severity === "error");
    if (issues.length > 0) throw new Error(`${adapter.descriptor.displayName} Adapter diagnostics failed: ${issues.map((issue) => issue.message).join("; ")}`);
    const plan = adapter.plan(projectionInput);
    const contracts = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
    for (const file of plan.files) {
      const contract = contracts.get(file.artifactId);
      if (!contract) throw new Error(`${adapter.descriptor.displayName} Adapter planned undeclared artifact ${file.artifactId}`);
      const actualPath = contract.target === "view"
        ? path.join(root, target, contract.relativePath)
        : path.join(home, contract.relativePath);
      if (await readOptional(actualPath) !== file.content) {
        throw new Error(`${adapter.descriptor.displayName} projection differs from the Environment closure in ${actualPath}`);
      }
    }
  }
}

export interface AgentCapabilityDiscovery {
  platform: Platform;
  result: DiscoveryResult;
  diagnostics: Diagnostic[];
}

export async function discoverEnvironmentAgentCapabilities(
  environment: WomaEnvironment,
  packages: InstalledPackage[],
): Promise<AgentCapabilityDiscovery[]> {
  const root = environmentViewPath(environment.metadata.name);
  const metadataPath = path.join(root, "view.json");
  const metadata = parseJsonObject(await readOptional(metadataPath), metadataPath) as ViewMetadata;
  const discoveries: AgentCapabilityDiscovery[] = [];
  for (const platform of environment.spec.targets) {
    const adapter = agentAdapter(platform);
    const environmentHome = environmentAgentHomePath(environment.metadata.name, platform);
    const context = {
      environmentName: environment.metadata.name,
      sourceHome: sourceAgentHome(platform),
      defaultSourceHome: nativeDefaultAgentHome(platform),
      environmentHome,
      currentView: path.join(root, platform),
      seedFromOriginal: false,
      originalRuntimeVariables: Object.fromEntries(
        adapter.descriptor.runtimeVariables.map((variable) => [
          variable.name,
          process.env[variable.originalName] ?? process.env[variable.name],
        ]),
      ),
    };
    const artifacts = adapter.artifacts(context);
    assertArtifactContracts(adapter, artifacts);
    const snapshots = await Promise.all(artifacts.map(readArtifactSnapshot));
    const capabilities = canonicalCapabilities(packages, platform);
    const input: AgentProjectionInput = {
      capabilities,
      previousCapabilities: capabilities,
      artifacts: Object.fromEntries(snapshots.map((snapshot) => [snapshot.contract.id, snapshot])),
      previousManagedMcpServers: stringArray(metadata.resources?.[resourceMetadataKey(platform)]),
    };
    discoveries.push({ platform, result: adapter.discover(input), diagnostics: adapter.diagnose(input) });
  }
  return discoveries;
}

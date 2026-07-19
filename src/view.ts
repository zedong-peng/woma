import { chmod, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { harnessHome, pathExists, writeJsonAtomic, writeTextAtomic, writeTextPreservingFile } from "./fs.js";
import { withRuntimeLock } from "./environment-lock.js";
import type { HarnessEnvironment, HookSpec, InstalledPackage, McpServer, Platform } from "./types.js";

const MANAGED_CODEX_ENTRIES = new Set(["config.toml", "hooks.json", "skills"]);
const MANAGED_CLAUDE_ENTRIES = new Set([".claude.json", "settings.json", "skills"]);
const RUNTIME_DIRECTORIES: Record<Platform, string[]> = {
  codex: [".tmp", "archived_sessions", "log", "memories", "sessions", "shell_snapshots", "tmp"],
  claude: ["backups", "debug", "downloads", "file-history", "ide", "plans", "plugins", "projects", "session-env", "shell-snapshots", "statsig", "tasks", "telemetry", "todos"],
};
const RUNTIME_FILES: Record<Platform, string[]> = {
  codex: [".personality_migration", "auth.json", "history.jsonl", "installation_id", "session_index.jsonl", "version.json"],
  claude: [".credentials.json", "history.jsonl"],
};

interface ViewInstallHooks {
  afterSwap?: () => Promise<void> | void;
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

function objectAt(root: Record<string, unknown>, key: string, filePath: string): Record<string, unknown> {
  const value = root[key];
  if (value === undefined) {
    const created: Record<string, unknown> = {};
    root[key] = created;
    return created;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Cannot merge ${filePath}: ${key} must be an object`);
  }
  return value as Record<string, unknown>;
}

function arrayAt(root: Record<string, unknown>, key: string, filePath: string): unknown[] {
  const value = root[key];
  if (value === undefined) {
    const created: unknown[] = [];
    root[key] = created;
    return created;
  }
  if (!Array.isArray(value)) throw new Error(`Cannot merge ${filePath}: ${key} must be an array`);
  return value;
}

function appliesTo(platform: Platform, platforms?: Platform[]): boolean {
  return !platforms || platforms.includes(platform);
}

function codexValue(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      command: server.command,
      args: server.args,
      ...(server.env.length > 0 ? { env_vars: server.env } : {}),
    };
  }
  if (server.transport !== "http") throw new Error(`${server.transport} MCP transport is not supported by Codex`);
  return {
    url: server.url,
    ...(Object.keys(server.headers).length > 0 ? { env_http_headers: server.headers } : {}),
  };
}

function claudeValue(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      ...(server.env.length > 0 ? { env: Object.fromEntries(server.env.map((name) => [name, `\${${name}}`])) } : {}),
    };
  }
  return {
    type: server.transport,
    url: server.url,
    ...(Object.keys(server.headers).length > 0
      ? { headers: Object.fromEntries(Object.entries(server.headers).map(([header, env]) => [header, `\${${env}}`])) }
      : {}),
  };
}

function hookValue(hook: HookSpec): Record<string, unknown> {
  const handler: Record<string, unknown> = { type: "command", command: hook.command };
  if (hook.timeout !== undefined) handler.timeout = hook.timeout;
  return { ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [handler] };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(", ")} }`;
}

function codexBlock(packageName: string, server: McpServer): string {
  const marker = `${packageName}:mcp:${server.name}`;
  const lines = [`# >>> harness-conda:${marker}`, `[mcp_servers.${tomlString(server.name)}]`];
  if (server.transport === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args.length > 0) lines.push(`args = ${tomlArray(server.args)}`);
    if (server.env.length > 0) lines.push(`env_vars = ${tomlArray(server.env)}`);
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
    if (Object.keys(server.headers).length > 0) lines.push(`env_http_headers = ${tomlInlineTable(server.headers)}`);
  }
  lines.push(`# <<< harness-conda:${marker}`);
  return lines.join("\n");
}

function defaultAgentHome(platform: Platform): string {
  if (platform === "codex") {
    return path.resolve(process.env.HARNESS_ORIGINAL_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  }
  return path.resolve(
    process.env.HARNESS_ORIGINAL_CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
  );
}

function sourceAgentHome(platform: Platform): string {
  const candidate = defaultAgentHome(platform);
  const environmentRoot = path.join(harnessHome(), "environments");
  const relative = path.relative(environmentRoot, candidate);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join(os.homedir(), platform === "codex" ? ".codex" : ".claude");
  }
  return candidate;
}

async function sharedRuntimeRoot(platform: Platform, originalRoot: string, excluded: Set<string>): Promise<string> {
  const sharedRoot = path.join(harnessHome(), "runtime", platform);
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  if (await pathExists(originalRoot)) {
    for (const entry of await readdir(originalRoot, { withFileTypes: true })) {
      if (excluded.has(entry.name)) continue;
      const shared = path.join(sharedRoot, entry.name);
      if (await lstat(shared).then(() => true, () => false)) continue;
      await createSymlink(path.join(originalRoot, entry.name), shared, entry.isDirectory());
    }
  }
  for (const directory of RUNTIME_DIRECTORIES[platform]) {
    const shared = path.join(sharedRoot, directory);
    if (!excluded.has(directory) && !(await lstat(shared).then(() => true, () => false))) {
      await mkdir(shared, { recursive: true, mode: 0o700 });
    }
  }
  return sharedRoot;
}

async function linkRuntimeState(platform: Platform, originalRoot: string, destinationRoot: string, excluded: Set<string>): Promise<void> {
  const sourceRoot = await sharedRuntimeRoot(platform, originalRoot, excluded);
  const entries = new Map<string, Dirent | undefined>(
    (await readdir(sourceRoot, { withFileTypes: true })).map((entry) => [entry.name, entry]),
  );
  for (const file of RUNTIME_FILES[platform]) {
    if (!entries.has(file)) entries.set(file, undefined);
  }
  for (const directory of RUNTIME_DIRECTORIES[platform]) {
    if (!entries.has(directory)) entries.set(directory, undefined);
  }
  for (const [name, entry] of entries) {
    if (excluded.has(name)) continue;
    const destination = path.join(destinationRoot, name);
    if (await lstat(destination).then(() => true, () => false)) continue;
    const directory = entry?.isDirectory() || RUNTIME_DIRECTORIES[platform].includes(name);
    await createSymlink(path.join(sourceRoot, name), destination, directory);
  }
}

function originalClaudeStatePath(sourceHome: string): string {
  const sibling = path.join(path.dirname(sourceHome), ".claude.json");
  return path.basename(sourceHome) === ".claude" ? sibling : path.join(sourceHome, ".claude.json");
}

async function createSymlink(source: string, destination: string, directory: boolean): Promise<void> {
  try {
    await symlink(source, destination, process.platform === "win32" ? (directory ? "junction" : "file") : undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readlink(destination).catch(() => undefined);
    if (existing !== source) throw new Error(`Refusing to replace runtime path ${destination}`);
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

function collectServers(packages: InstalledPackage[], platform: Platform): { packageName: string; server: McpServer }[] {
  const result: { packageName: string; server: McpServer }[] = [];
  const owners = new Map<string, { packageName: string; value: unknown }>();
  for (const pkg of packages) {
    for (const server of pkg.manifest.spec.mcpServers.filter((item) => appliesTo(platform, item.platforms))) {
      const value = platform === "codex" ? codexValue(server) : claudeValue(server);
      const existing = owners.get(server.name);
      if (existing && !equal(existing.value, value)) {
        throw new Error(`MCP server ${server.name} conflicts between ${existing.packageName} and ${pkg.lock.name}`);
      }
      if (!existing) {
        owners.set(server.name, { packageName: pkg.lock.name, value });
        result.push({ packageName: pkg.lock.name, server });
      }
    }
  }
  return result;
}

function collectHooks(packages: InstalledPackage[], platform: Platform): HookSpec[] {
  const result: HookSpec[] = [];
  for (const pkg of packages) {
    for (const hook of pkg.manifest.spec.hooks.filter((item) => appliesTo(platform, item.platforms))) {
      if (!result.some((existing) => equal(hookValue(existing), hookValue(hook)) && existing.event === hook.event)) result.push(hook);
    }
  }
  return result;
}

async function mergeHooks(filePath: string, root: Record<string, unknown>, additions: HookSpec[]): Promise<void> {
  if (additions.length === 0) return;
  const hooks = objectAt(root, "hooks", filePath);
  for (const hook of additions) {
    const eventHooks = arrayAt(hooks, hook.event, filePath);
    const value = hookValue(hook);
    if (!eventHooks.some((existing) => equal(existing, value))) eventHooks.push(value);
  }
}

async function buildCodexView(root: string, packages: InstalledPackage[]): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("codex");
  const links = await linkSkills(root, packages);

  const sourceConfig = path.join(sourceHome, "config.toml");
  const original = await readOptional(sourceConfig);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (original ? parseToml(original) : {}) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot merge ${sourceConfig}: ${(error as Error).message}`);
  }
  const existingServers = parsed.mcp_servers ?? {};
  if (!existingServers || typeof existingServers !== "object" || Array.isArray(existingServers)) {
    throw new Error(`Cannot merge ${sourceConfig}: mcp_servers must be a table`);
  }
  const blocks: string[] = [];
  for (const { packageName, server } of collectServers(packages, "codex")) {
    const existing = (existingServers as Record<string, unknown>)[server.name];
    const desired = codexValue(server);
    if (existing !== undefined && !equal(existing, desired)) {
      throw new Error(`Refusing to overwrite Codex MCP server ${server.name} from ${sourceConfig}`);
    }
    if (existing === undefined) blocks.push(codexBlock(packageName, server));
  }
  if (original !== null || blocks.length > 0) {
    const prefix = original?.trimEnd() ? `${original.trimEnd()}\n\n` : "";
    const suffix = blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
    const destination = path.join(root, "config.toml");
    await writeTextAtomic(destination, `${prefix}${suffix}`);
    await chmod(destination, 0o600);
  }

  const sourceHooks = path.join(sourceHome, "hooks.json");
  const hooksRoot = parseJsonObject(await readOptional(sourceHooks), sourceHooks);
  await mergeHooks(sourceHooks, hooksRoot, collectHooks(packages, "codex"));
  if (Object.keys(hooksRoot).length > 0) {
    const destination = path.join(root, "hooks.json");
    await writeJsonAtomic(destination, hooksRoot);
    await chmod(destination, 0o600);
  }
  return links;
}

async function buildClaudeView(
  root: string,
  packages: InstalledPackage[],
  currentStatePath: string,
  previousManagedServers: string[],
): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("claude");
  const links = await linkSkills(root, packages);

  const sourceState = originalClaudeStatePath(sourceHome);
  const currentState = await readOptional(currentStatePath);
  const state = parseJsonObject(currentState ?? await readOptional(sourceState), currentState === null ? sourceState : currentStatePath);
  const mcpServers = objectAt(state, "mcpServers", sourceState);
  for (const serverName of previousManagedServers) delete mcpServers[serverName];
  for (const { server } of collectServers(packages, "claude")) {
    const desired = claudeValue(server);
    const existing = mcpServers[server.name];
    if (existing !== undefined && !equal(existing, desired)) {
      throw new Error(`Refusing to overwrite Claude MCP server ${server.name} from ${sourceState}`);
    }
    mcpServers[server.name] = desired;
  }
  const stateDestination = path.join(root, ".claude.json");
  await writeJsonAtomic(stateDestination, state);
  await chmod(stateDestination, 0o600);

  const sourceSettings = path.join(sourceHome, "settings.json");
  const settings = parseJsonObject(await readOptional(sourceSettings), sourceSettings);
  await mergeHooks(sourceSettings, settings, collectHooks(packages, "claude"));
  if (Object.keys(settings).length > 0) {
    const destination = path.join(root, "settings.json");
    await writeJsonAtomic(destination, settings);
    await chmod(destination, 0o600);
  }
  return links;
}

export function environmentViewPath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid Environment name: ${name}`);
  return path.join(harnessHome(), "environments", name, "view");
}

async function transferClaudeRuntimeState(sourceEnvironment: string, targetEnvironment: string): Promise<void> {
  if (sourceEnvironment === targetEnvironment) return;
  const sourcePath = path.join(environmentViewPath(sourceEnvironment), "claude", ".claude.json");
  const targetRoot = path.join(environmentViewPath(targetEnvironment), "claude");
  const targetPath = path.join(targetRoot, ".claude.json");
  if (!(await pathExists(path.join(targetRoot, "skills")))) return;
  const source = parseJsonObject(await readOptional(sourcePath), sourcePath);
  const target = parseJsonObject(await readOptional(targetPath), targetPath);
  const targetMcpServers = target.mcpServers;
  const runtime = { ...source };
  delete runtime.mcpServers;
  const merged = { ...target, ...runtime };
  if (targetMcpServers === undefined) delete merged.mcpServers;
  else merged.mcpServers = targetMcpServers;
  await writeTextPreservingFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`);
  await chmod(targetPath, 0o600);
}

export async function reconcileRuntimeState(environmentName: string, targetEnvironmentName = environmentName): Promise<void> {
  environmentViewPath(environmentName);
  environmentViewPath(targetEnvironmentName);
  for (const platform of ["codex", "claude"] as const) {
    const viewRoot = path.join(environmentViewPath(environmentName), platform);
    if (!(await pathExists(path.join(viewRoot, "skills")))) continue;
    await withRuntimeLock(platform, async () => {
      const sharedRoot = path.join(harnessHome(), "runtime", platform);
      await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
      for (const name of RUNTIME_FILES[platform]) {
        const viewPath = path.join(viewRoot, name);
        const sharedPath = path.join(sharedRoot, name);
        const viewInfo = await lstat(viewPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!viewInfo) {
          await createSymlink(sharedPath, viewPath, false);
          continue;
        }
        if (viewInfo.isSymbolicLink()) continue;
        if (!viewInfo.isFile()) throw new Error(`Unsupported runtime path at ${viewPath}`);
        await writeTextPreservingFile(sharedPath, await readFile(viewPath, "utf8"));
        await rm(viewPath, { force: true });
        await createSymlink(sharedPath, viewPath, false);
      }
      if (platform === "claude") await transferClaudeRuntimeState(environmentName, targetEnvironmentName);
    });
  }
}

interface ViewMetadata {
  viewVersion?: unknown;
  targets?: unknown;
  resources?: { codexMcpServers?: unknown; claudeMcpServers?: unknown } | undefined;
}

async function previousViewMetadata(root: string): Promise<ViewMetadata> {
  return parseJsonObject(await readOptional(path.join(root, "view.json")), path.join(root, "view.json")) as ViewMetadata;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
}

async function replaceManagedPaths(
  temporary: string,
  destination: string,
  targets: Platform[],
  hooks: ViewInstallHooks,
): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  for (const target of targets) {
    const targetRoot = path.join(destination, target);
    await mkdir(targetRoot, { recursive: true, mode: 0o700 });
    await withRuntimeLock(target, () =>
      linkRuntimeState(
        target,
        sourceAgentHome(target),
        targetRoot,
        target === "codex" ? MANAGED_CODEX_ENTRIES : MANAGED_CLAUDE_ENTRIES,
      ),
    );
  }

  const managed = [
    "view.json",
    "codex/skills",
    "codex/config.toml",
    "codex/hooks.json",
    "claude/skills",
    "claude/.claude.json",
    "claude/settings.json",
  ];
  const backup = path.join(path.dirname(destination), `.view.backup-${process.pid}-${randomUUID()}`);
  await mkdir(backup, { recursive: true, mode: 0o700 });
  const movedOld: { relative: string; backup: string }[] = [];
  const movedNew: string[] = [];
  try {
    for (const [index, relative] of managed.entries()) {
      const current = path.join(destination, relative);
      const currentExists = await lstat(current).then(() => true, () => false);
      if (currentExists) {
        const saved = path.join(backup, String(index));
        await mkdir(path.dirname(saved), { recursive: true });
        await rename(current, saved);
        movedOld.push({ relative, backup: saved });
      }
      const next = path.join(temporary, relative);
      const nextExists = await lstat(next).then(() => true, () => false);
      if (nextExists) {
        await mkdir(path.dirname(current), { recursive: true, mode: 0o700 });
        await rename(next, current);
        movedNew.push(relative);
      }
    }
    await hooks.afterSwap?.();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const relative of [...movedNew].reverse()) {
      await rm(path.join(destination, relative), { recursive: true, force: true }).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    for (const item of [...movedOld].reverse()) {
      await mkdir(path.dirname(path.join(destination, item.relative)), { recursive: true });
      await rename(item.backup, path.join(destination, item.relative)).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Environment view update failed and rollback could not restore every managed path");
    }
    throw error;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}

export async function materializeEnvironmentView(
  environment: HarnessEnvironment,
  packages: InstalledPackage[],
  hooks: ViewInstallHooks = {},
): Promise<void> {
  const name = environment.metadata.name;
  const destination = environmentViewPath(name);
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.view.tmp-${process.pid}-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const previousMetadata = await previousViewMetadata(destination);
    const previousClaudeMcpServers = stringArray(previousMetadata.resources?.claudeMcpServers);
    const skillLinks: Partial<Record<Platform, Record<string, string>>> = {};
    if (environment.spec.targets.includes("codex")) skillLinks.codex = await buildCodexView(path.join(temporary, "codex"), packages);
    if (environment.spec.targets.includes("claude")) {
      skillLinks.claude = await withRuntimeLock("claude", () =>
        buildClaudeView(
          path.join(temporary, "claude"),
          packages,
          path.join(destination, "claude", ".claude.json"),
          previousClaudeMcpServers,
        ),
      );
    }
    const codexMcpServers = environment.spec.targets.includes("codex")
      ? collectServers(packages, "codex").map(({ server }) => server.name)
      : [];
    const claudeMcpServers = environment.spec.targets.includes("claude")
      ? collectServers(packages, "claude").map(({ server }) => server.name)
      : [];
    await writeJsonAtomic(path.join(temporary, "view.json"), {
      viewVersion: 1,
      environment: name,
      targets: environment.spec.targets,
      packages: packages.map((pkg) => ({ name: pkg.lock.name, version: pkg.lock.version, integrity: pkg.lock.integrity })),
      skills: skillLinks,
      resources: { codexMcpServers, claudeMcpServers },
    });
    await replaceManagedPaths(temporary, destination, environment.spec.targets, hooks);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function validateEnvironmentView(environment: HarnessEnvironment, packages: InstalledPackage[]): Promise<void> {
  const root = environmentViewPath(environment.metadata.name);
  const metadataPath = path.join(root, "view.json");
  const metadata = parseJsonObject(await readOptional(metadataPath), metadataPath);
  const expected = packages.map((pkg) => ({ name: pkg.lock.name, version: pkg.lock.version, integrity: pkg.lock.integrity }));
  if (
    metadata.viewVersion !== 1 ||
    metadata.environment !== environment.metadata.name ||
    !equal(metadata.targets, environment.spec.targets) ||
    !equal(metadata.packages, expected)
  ) {
    throw new Error(`Environment view is missing or stale at ${root}; run harness sync --name ${environment.metadata.name}`);
  }
  for (const target of environment.spec.targets) {
    for (const pkg of packages) {
      for (const skill of pkg.manifest.spec.skills) {
        const link = path.join(root, target, "skills", skill.name);
        const info = await lstat(link).catch(() => undefined);
        if (!info?.isSymbolicLink()) throw new Error(`Environment Skill link is missing: ${link}`);
        const expected = await realpath(path.resolve(pkg.root, skill.path));
        const actual = await realpath(link).catch(() => undefined);
        if (actual !== expected) throw new Error(`Environment Skill link has an unexpected target: ${link}`);
      }
    }
    if (target === "codex") {
      const configPath = path.join(root, "codex", "config.toml");
      const configInput = await readOptional(configPath);
      let config: Record<string, unknown> = {};
      try {
        config = (configInput ? parseToml(configInput) : {}) as Record<string, unknown>;
      } catch (error) {
        throw new Error(`Cannot validate ${configPath}: ${(error as Error).message}`);
      }
      const servers = config.mcp_servers;
      if (servers !== undefined && (!servers || typeof servers !== "object" || Array.isArray(servers))) {
        throw new Error(`Cannot validate ${configPath}: mcp_servers must be a table`);
      }
      for (const { server } of collectServers(packages, "codex")) {
        if (!equal((servers as Record<string, unknown> | undefined)?.[server.name], codexValue(server))) {
          throw new Error(`Codex MCP server ${server.name} is missing or modified in ${configPath}`);
        }
      }
      const hooksPath = path.join(root, "codex", "hooks.json");
      const hooksRoot = parseJsonObject(await readOptional(hooksPath), hooksPath);
      const hooks = hooksRoot.hooks as Record<string, unknown> | undefined;
      for (const hook of collectHooks(packages, "codex")) {
        const values = hooks?.[hook.event];
        if (!Array.isArray(values) || !values.some((value) => equal(value, hookValue(hook)))) {
          throw new Error(`Codex Hook ${hook.event} is missing or modified in ${hooksPath}`);
        }
      }
    } else {
      const statePath = path.join(root, "claude", ".claude.json");
      const state = parseJsonObject(await readOptional(statePath), statePath);
      const servers = state.mcpServers as Record<string, unknown> | undefined;
      for (const { server } of collectServers(packages, "claude")) {
        if (!equal(servers?.[server.name], claudeValue(server))) {
          throw new Error(`Claude MCP server ${server.name} is missing or modified in ${statePath}`);
        }
      }
      const settingsPath = path.join(root, "claude", "settings.json");
      const settings = parseJsonObject(await readOptional(settingsPath), settingsPath);
      const hooks = settings.hooks as Record<string, unknown> | undefined;
      for (const hook of collectHooks(packages, "claude")) {
        const values = hooks?.[hook.event];
        if (!Array.isArray(values) || !values.some((value) => equal(value, hookValue(hook)))) {
          throw new Error(`Claude Hook ${hook.event} is missing or modified in ${settingsPath}`);
        }
      }
    }
  }
}

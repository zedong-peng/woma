import { chmod, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { harnessHome, pathExists, writeBufferPreservingFile, writeJsonAtomic, writeTextAtomic, writeTextPreservingFile } from "./fs.js";
import { withRuntimeLock } from "./environment-lock.js";
import type { HarnessEnvironment, HookSpec, InstalledPackage, McpServer, Platform } from "./types.js";

const MANAGED_CODEX_ENTRIES = new Set(["config.toml", "hooks.json", "skills"]);
const MANAGED_CLAUDE_ENTRIES = new Set([".claude.json", ".harness-runtime-state.json", "settings.json", "skills"]);
const RUNTIME_DIRECTORIES: Record<Platform, string[]> = {
  codex: [".tmp", "archived_sessions", "log", "memories", "sessions", "shell_snapshots", "tmp"],
  claude: ["backups", "debug", "downloads", "file-history", "ide", "plans", "plugins", "projects", "session-env", "shell-snapshots", "statsig", "tasks", "telemetry", "todos"],
};
const RUNTIME_FILES: Record<Platform, string[]> = {
  codex: [".personality_migration", "auth.json", "history.jsonl", "installation_id", "session_index.jsonl", "version.json"],
  claude: [".credentials.json", "history.jsonl"],
};

interface ViewInstallHooks {
  beforeSwap?: () => Promise<(() => Promise<void>) | void>;
  beforePublish?: () => Promise<void> | void;
  previousPackages?: InstalledPackage[];
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

export function sourceAgentHome(platform: Platform): string {
  const candidate = defaultAgentHome(platform);
  const environmentRoot = path.join(harnessHome(), "environments");
  const relative = path.relative(environmentRoot, candidate);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return path.join(os.homedir(), platform === "codex" ? ".codex" : ".claude");
  }
  return candidate;
}

function codexSystemSkillsRoot(): string {
  return path.join(harnessHome(), "runtime", "codex", "skills", ".system");
}

async function linkCodexSystemSkills(destinationRoot: string): Promise<void> {
  const shared = codexSystemSkillsRoot();
  if (!(await pathExists(shared))) {
    await mkdir(path.dirname(shared), { recursive: true, mode: 0o700 });
    const original = path.join(sourceAgentHome("codex"), "skills", ".system");
    if (await pathExists(original)) await createSymlink(original, shared, true);
    else await mkdir(shared, { recursive: true, mode: 0o700 });
  }
  await createSymlink(shared, path.join(destinationRoot, "skills", ".system"), true);
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

async function adoptRuntimeState(platform: Platform, viewRoot: string): Promise<void> {
  if (!(await pathExists(viewRoot))) return;
  const excluded = platform === "codex" ? MANAGED_CODEX_ENTRIES : MANAGED_CLAUDE_ENTRIES;
  const sharedRoot = path.join(harnessHome(), "runtime", platform);
  await mkdir(sharedRoot, { recursive: true, mode: 0o700 });
  const names = new Set((await readdir(viewRoot).catch(() => [])).filter((name) => !excluded.has(name)));
  for (const name of RUNTIME_FILES[platform]) names.add(name);
  for (const name of names) {
    const viewPath = path.join(viewRoot, name);
    const sharedPath = path.join(sharedRoot, name);
    const viewInfo = await lstat(viewPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!viewInfo) {
      if (RUNTIME_FILES[platform].includes(name)) await createSymlink(sharedPath, viewPath, false);
      continue;
    }
    if (viewInfo.isSymbolicLink()) {
      const expected = path.join(sharedRoot, name);
      const actual = path.resolve(path.dirname(viewPath), await readlink(viewPath));
      if (actual !== expected) throw new Error(`Runtime link has an unexpected target: ${viewPath}`);
      continue;
    }
    if (viewInfo.isFile()) {
      await writeBufferPreservingFile(sharedPath, await readFile(viewPath), viewInfo.mode);
      await rm(viewPath, { force: true });
      await createSymlink(sharedPath, viewPath, false);
      continue;
    }
    if (viewInfo.isDirectory() && !(await pathExists(sharedPath))) {
      await rename(viewPath, sharedPath);
      await createSymlink(sharedPath, viewPath, true);
      continue;
    }
    throw new Error(`Unsupported runtime path at ${viewPath}`);
  }
}

async function adoptRetiredRuntimeState(environmentName: string, platforms: Platform[]): Promise<void> {
  const root = path.dirname(environmentViewPath(environmentName));
  const entries = await readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const generations = entries
    .filter((entry) => entry.isDirectory() && /^\.view\.gen-[a-z0-9-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const platform of platforms) {
    await withRuntimeLock(platform, async () => {
      for (const generation of generations) await adoptRuntimeState(platform, path.join(root, generation, platform));
    });
  }
}

async function preflightRuntimeState(platform: Platform, viewRoot: string): Promise<void> {
  if (!(await pathExists(viewRoot))) return;
  const excluded = platform === "codex" ? MANAGED_CODEX_ENTRIES : MANAGED_CLAUDE_ENTRIES;
  const sharedRoot = path.join(harnessHome(), "runtime", platform);
  for (const name of (await readdir(viewRoot)).filter((entry) => !excluded.has(entry))) {
    const viewPath = path.join(viewRoot, name);
    const info = await lstat(viewPath);
    if (info.isSymbolicLink()) {
      const expected = path.join(sharedRoot, name);
      const actual = path.resolve(path.dirname(viewPath), await readlink(viewPath));
      if (actual !== expected) throw new Error(`Runtime link has an unexpected target: ${viewPath}`);
      continue;
    }
    if (info.isFile()) {
      await readFile(viewPath);
      continue;
    }
    if (info.isDirectory() && !(await pathExists(path.join(sharedRoot, name)))) continue;
    throw new Error(`Unsupported runtime path at ${viewPath}`);
  }
}

async function preflightClaudeRuntimeTransfer(sourceEnvironment: string, targetEnvironment: string): Promise<void> {
  const sourcePath = path.join(environmentViewPath(sourceEnvironment), "claude", ".claude.json");
  const targetPath = path.join(environmentViewPath(targetEnvironment), "claude", ".claude.json");
  if (await pathExists(path.join(environmentViewPath(sourceEnvironment), "claude", "skills"))) {
    parseJsonObject(await readOptional(sourcePath), sourcePath);
  }
  if (await pathExists(path.join(environmentViewPath(targetEnvironment), "claude", "skills"))) {
    parseJsonObject(await readOptional(targetPath), targetPath);
  }
  const sharedPath = path.join(harnessHome(), "runtime", "claude", ".harness-runtime-state.json");
  const shared = await readOptional(sharedPath);
  if (shared !== null) parseJsonObject(shared, sharedPath);
}

function originalClaudeStatePath(sourceHome: string): string {
  const sibling = path.join(path.dirname(sourceHome), ".claude.json");
  return path.basename(sourceHome) === ".claude" ? sibling : path.join(sourceHome, ".claude.json");
}

function withoutMcpServers(state: Record<string, unknown>): Record<string, unknown> {
  const runtime = { ...state };
  delete runtime.mcpServers;
  return runtime;
}

async function readSharedClaudeRuntime(sourceHome: string): Promise<Record<string, unknown>> {
  const runtimePath = path.join(harnessHome(), "runtime", "claude", ".harness-runtime-state.json");
  const existing = await readOptional(runtimePath);
  if (existing !== null) return parseJsonObject(existing, runtimePath);
  const sourcePath = originalClaudeStatePath(sourceHome);
  const runtime = withoutMcpServers(parseJsonObject(await readOptional(sourcePath), sourcePath));
  await writeJsonAtomic(runtimePath, runtime);
  await chmod(runtimePath, 0o600);
  return runtime;
}

async function writeSharedClaudeRuntime(runtime: Record<string, unknown>): Promise<void> {
  const runtimePath = path.join(harnessHome(), "runtime", "claude", ".harness-runtime-state.json");
  await writeJsonAtomic(runtimePath, runtime);
  await chmod(runtimePath, 0o600);
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
  await linkCodexSystemSkills(root);

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
  previousManagedServers: string[],
): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("claude");
  const links = await linkSkills(root, packages);

  const sourceState = originalClaudeStatePath(sourceHome);
  const baseline = parseJsonObject(await readOptional(sourceState), sourceState);
  const baselineMcpServers = objectAt(baseline, "mcpServers", sourceState);
  const mcpServers = { ...baselineMcpServers };
  for (const serverName of previousManagedServers) delete mcpServers[serverName];
  for (const { server } of collectServers(packages, "claude")) {
    const desired = claudeValue(server);
    const baselineExisting = baselineMcpServers[server.name];
    if (baselineExisting !== undefined && !equal(baselineExisting, desired)) {
      throw new Error(`Refusing to overwrite Claude MCP server ${server.name} from ${sourceState}`);
    }
    mcpServers[server.name] = desired;
  }
  const state = await readSharedClaudeRuntime(sourceHome);
  if (Object.keys(mcpServers).length > 0) state.mcpServers = mcpServers;
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
  const sourcePath = path.join(environmentViewPath(sourceEnvironment), "claude", ".claude.json");
  const targetRoot = path.join(environmentViewPath(targetEnvironment), "claude");
  const targetPath = path.join(targetRoot, ".claude.json");
  let runtime = await readSharedClaudeRuntime(sourceAgentHome("claude"));
  if (await pathExists(path.join(environmentViewPath(sourceEnvironment), "claude", "skills"))) {
    const source = parseJsonObject(await readOptional(sourcePath), sourcePath);
    runtime = withoutMcpServers(source);
    await writeSharedClaudeRuntime(runtime);
  }
  if (!(await pathExists(path.join(targetRoot, "skills")))) return;
  const target = parseJsonObject(await readOptional(targetPath), targetPath);
  const targetMcpServers = target.mcpServers;
  const merged = { ...runtime };
  if (targetMcpServers !== undefined) merged.mcpServers = targetMcpServers;
  await writeTextPreservingFile(targetPath, `${JSON.stringify(merged, null, 2)}\n`);
  await chmod(targetPath, 0o600);
}

export async function reconcileRuntimeState(environmentName: string, targetEnvironmentName = environmentName): Promise<void> {
  environmentViewPath(environmentName);
  environmentViewPath(targetEnvironmentName);
  for (const platform of ["codex", "claude"] as const) {
    await preflightRuntimeState(platform, path.join(environmentViewPath(environmentName), platform));
  }
  await preflightClaudeRuntimeTransfer(environmentName, targetEnvironmentName);
  await adoptRetiredRuntimeState(environmentName, ["codex", "claude"]);
  for (const platform of ["codex", "claude"] as const) {
    const viewRoot = path.join(environmentViewPath(environmentName), platform);
    if (!(await pathExists(path.join(viewRoot, "skills")))) continue;
    await withRuntimeLock(platform, async () => {
      await adoptRuntimeState(platform, viewRoot);
    });
  }
  await withRuntimeLock("claude", () => transferClaudeRuntimeState(environmentName, targetEnvironmentName));
}

interface ViewMetadata {
  viewVersion?: unknown;
  targets?: unknown;
  skills?: unknown;
  resources?: { codexMcpServers?: unknown; claudeMcpServers?: unknown } | undefined;
}

async function previousViewMetadata(root: string): Promise<ViewMetadata> {
  return parseJsonObject(await readOptional(path.join(root, "view.json")), path.join(root, "view.json")) as ViewMetadata;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : [];
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
  // Retired generations remain available to running Agents and are reconciled on the next active operation.
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
  const temporary = path.join(parent, `.view.gen-${randomUUID()}`);
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const previousMetadata = await previousViewMetadata(destination);
    if ((process.env.HARNESS_ENV || "base") === environment.metadata.name) {
      await adoptRetiredRuntimeState(environment.metadata.name, environment.spec.targets);
    }
    for (const target of environment.spec.targets) {
      await withRuntimeLock(target, async () => {
        if ((process.env.HARNESS_ENV || "base") === environment.metadata.name) {
          await adoptRuntimeState(target, path.join(destination, target));
        }
        if (
          target === "claude" &&
          process.env.HARNESS_ENV === environment.metadata.name &&
          (await pathExists(path.join(destination, "claude", "skills")))
        ) {
          const currentStatePath = path.join(destination, "claude", ".claude.json");
          const currentState = parseJsonObject(await readOptional(currentStatePath), currentStatePath);
          await writeSharedClaudeRuntime(withoutMcpServers(currentState));
        }
      });
    }
    const previousClaudeMcpServers = new Set(stringArray(previousMetadata.resources?.claudeMcpServers));
    for (const { server } of collectServers(hooks.previousPackages ?? [], "claude")) previousClaudeMcpServers.add(server.name);
    const skillLinks: Partial<Record<Platform, Record<string, string>>> = {};
    if (environment.spec.targets.includes("codex")) skillLinks.codex = await buildCodexView(path.join(temporary, "codex"), packages);
    if (environment.spec.targets.includes("claude")) {
      skillLinks.claude = await withRuntimeLock("claude", () =>
        buildClaudeView(
          path.join(temporary, "claude"),
          packages,
          [...previousClaudeMcpServers],
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
    for (const target of environment.spec.targets) {
      await withRuntimeLock(target, async () => {
        await linkRuntimeState(
          target,
          sourceAgentHome(target),
          path.join(temporary, target),
          target === "codex" ? MANAGED_CODEX_ENTRIES : MANAGED_CLAUDE_ENTRIES,
        );
      });
    }
    await hooks.beforePublish?.();
    if ((process.env.HARNESS_ENV || "base") === environment.metadata.name) {
      for (const target of environment.spec.targets) {
        await withRuntimeLock(target, async () => {
          await adoptRuntimeState(target, path.join(destination, target));
          await linkRuntimeState(
            target,
            sourceAgentHome(target),
            path.join(temporary, target),
            target === "codex" ? MANAGED_CODEX_ENTRIES : MANAGED_CLAUDE_ENTRIES,
          );
        });
      }
    }
    await publishViewGeneration(temporary, destination, hooks);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function validateEnvironmentView(environment: HarnessEnvironment, packages: InstalledPackage[]): Promise<void> {
  const root = environmentViewPath(environment.metadata.name);
  const metadataPath = path.join(root, "view.json");
  const metadata = parseJsonObject(await readOptional(metadataPath), metadataPath);
  const expected = packages.map((pkg) => ({ name: pkg.lock.name, version: pkg.lock.version, integrity: pkg.lock.integrity }));
  const expectedResources = {
    codexMcpServers: environment.spec.targets.includes("codex")
      ? collectServers(packages, "codex").map(({ server }) => server.name)
      : [],
    claudeMcpServers: environment.spec.targets.includes("claude")
      ? collectServers(packages, "claude").map(({ server }) => server.name)
      : [],
  };
  if (
    metadata.viewVersion !== 1 ||
    metadata.environment !== environment.metadata.name ||
    !equal(metadata.targets, environment.spec.targets) ||
    !equal(metadata.packages, expected) ||
    !equal(metadata.resources, expectedResources)
  ) {
    throw new Error(`Environment view is missing or stale at ${root}; run harness sync --name ${environment.metadata.name}`);
  }
  for (const target of environment.spec.targets) {
    const expectedSkills: Record<string, string> = {};
    for (const pkg of packages) {
      for (const skill of pkg.manifest.spec.skills) {
        const link = path.join(root, target, "skills", skill.name);
        const info = await lstat(link).catch(() => undefined);
        if (!info?.isSymbolicLink()) throw new Error(`Environment Skill link is missing: ${link}`);
        const expected = await realpath(path.resolve(pkg.root, skill.path));
        const actual = await realpath(link).catch(() => undefined);
        if (actual !== expected) throw new Error(`Environment Skill link has an unexpected target: ${link}`);
        expectedSkills[skill.name] = path.resolve(pkg.root, skill.path);
      }
    }
    const skillsRoot = path.join(root, target, "skills");
    const actualSkillNames = (await readdir(skillsRoot).catch(() => [])).sort();
    const expectedSkillNames = Object.keys(expectedSkills).concat(target === "codex" ? [".system"] : []).sort();
    if (!equal(actualSkillNames, expectedSkillNames)) {
      throw new Error(`Environment Skill visibility differs from the lock at ${skillsRoot}`);
    }
    if (target === "codex") {
      const system = path.join(skillsRoot, ".system");
      const info = await lstat(system).catch(() => undefined);
      if (!info?.isSymbolicLink()) throw new Error(`Codex system Skills runtime link is missing: ${system}`);
      const actual = path.resolve(path.dirname(system), await readlink(system));
      if (actual !== codexSystemSkillsRoot()) throw new Error(`Codex system Skills runtime link has an unexpected target: ${system}`);
    }
    const metadataSkills = metadata.skills;
    if (!metadataSkills || typeof metadataSkills !== "object" || Array.isArray(metadataSkills)) {
      throw new Error(`Environment Skill ownership metadata is missing from ${metadataPath}`);
    }
    if (!equal((metadataSkills as Record<string, unknown>)[target], expectedSkills)) {
      throw new Error(`Environment Skill ownership metadata is stale for ${target} in ${metadataPath}`);
    }
    const managed = target === "codex" ? MANAGED_CODEX_ENTRIES : MANAGED_CLAUDE_ENTRIES;
    const sharedRoot = path.join(harnessHome(), "runtime", target);
    for (const name of (await readdir(path.join(root, target))).filter((entry) => !managed.has(entry))) {
      const runtimePath = path.join(root, target, name);
      const info = await lstat(runtimePath);
      if (!info.isSymbolicLink()) throw new Error(`Runtime path is not linked to shared state: ${runtimePath}`);
      const actual = path.resolve(path.dirname(runtimePath), await readlink(runtimePath));
      if (actual !== path.join(sharedRoot, name)) throw new Error(`Runtime link has an unexpected target: ${runtimePath}`);
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
      const sourceConfigPath = path.join(sourceAgentHome("codex"), "config.toml");
      const sourceConfigInput = await readOptional(sourceConfigPath);
      const expectedConfig = (sourceConfigInput ? parseToml(sourceConfigInput) : {}) as Record<string, unknown>;
      const baselineServers = expectedConfig.mcp_servers;
      if (baselineServers !== undefined && (!baselineServers || typeof baselineServers !== "object" || Array.isArray(baselineServers))) {
        throw new Error(`Cannot validate ${sourceConfigPath}: mcp_servers must be a table`);
      }
      const expectedServers = { ...((baselineServers as Record<string, unknown> | undefined) ?? {}) };
      for (const { server } of collectServers(packages, "codex")) {
        expectedServers[server.name] = codexValue(server);
      }
      const actualServers = config.mcp_servers;
      if (actualServers !== undefined && (!actualServers || typeof actualServers !== "object" || Array.isArray(actualServers))) {
        throw new Error(`Cannot validate ${configPath}: mcp_servers must be a table`);
      }
      if (!equal((actualServers as Record<string, unknown> | undefined) ?? {}, expectedServers)) {
        throw new Error(`Codex MCP configuration differs from the Environment closure in ${configPath}`);
      }
      const hooksPath = path.join(root, "codex", "hooks.json");
      const hooksRoot = parseJsonObject(await readOptional(hooksPath), hooksPath);
      const sourceHooksPath = path.join(sourceAgentHome("codex"), "hooks.json");
      const expectedHooks = parseJsonObject(await readOptional(sourceHooksPath), sourceHooksPath);
      await mergeHooks(sourceHooksPath, expectedHooks, collectHooks(packages, "codex"));
      if (!equal(hooksRoot, expectedHooks)) throw new Error(`Codex Hooks differ from the Environment closure in ${hooksPath}`);
    } else {
      const statePath = path.join(root, "claude", ".claude.json");
      const state = parseJsonObject(await readOptional(statePath), statePath);
      const sourceStatePath = originalClaudeStatePath(sourceAgentHome("claude"));
      const baselineState = parseJsonObject(await readOptional(sourceStatePath), sourceStatePath);
      const expectedServers = { ...objectAt(baselineState, "mcpServers", sourceStatePath) };
      for (const { server } of collectServers(packages, "claude")) {
        expectedServers[server.name] = claudeValue(server);
      }
      if (!equal(state.mcpServers ?? {}, expectedServers)) throw new Error(`Claude MCP configuration differs from the Environment closure in ${statePath}`);
      const settingsPath = path.join(root, "claude", "settings.json");
      const settings = parseJsonObject(await readOptional(settingsPath), settingsPath);
      const sourceSettingsPath = path.join(sourceAgentHome("claude"), "settings.json");
      const expectedSettings = parseJsonObject(await readOptional(sourceSettingsPath), sourceSettingsPath);
      await mergeHooks(sourceSettingsPath, expectedSettings, collectHooks(packages, "claude"));
      if (!equal(settings, expectedSettings)) throw new Error(`Claude Hooks differ from the Environment closure in ${settingsPath}`);
    }
  }
}

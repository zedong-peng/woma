import { chmod, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, rmdir, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { womaHome, pathExists, writeBufferPreservingFile, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import type { ConfigurablePlatform, WomaEnvironment, HookSpec, InstalledPackage, McpServer, Platform } from "./types.js";

const MANAGED_HOME_LINKS: Record<Platform, string[]> = {
  codex: ["config.toml", "hooks.json"],
  claude: [".credentials.json", "settings.json"],
  pi: [],
  qoder: ["settings.json"],
};

const MANAGED_VIEW_ENTRIES: Record<Platform, string[]> = {
  codex: ["config.toml", "hooks.json", "skills"],
  claude: [".credentials.json", "settings.json", "skills"],
  pi: ["skills"],
  qoder: ["settings.json", "skills"],
};

const CREDENTIAL_FILES: Record<Platform, string[]> = {
  codex: [],
  claude: [".credentials.json"],
  pi: [],
  qoder: [],
};

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
  const lines = [`# >>> woma:${marker}`, `[mcp_servers.${tomlString(server.name)}]`];
  if (server.transport === "stdio") {
    lines.push(`command = ${tomlString(server.command)}`);
    if (server.args.length > 0) lines.push(`args = ${tomlArray(server.args)}`);
    if (server.env.length > 0) lines.push(`env_vars = ${tomlArray(server.env)}`);
  } else {
    lines.push(`url = ${tomlString(server.url)}`);
    if (Object.keys(server.headers).length > 0) lines.push(`env_http_headers = ${tomlInlineTable(server.headers)}`);
  }
  lines.push(`# <<< woma:${marker}`);
  return lines.join("\n");
}

function withoutWomaCodexBlocks(content: string, filePath: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^# >>> woma:(.+:mcp:.+)$/.exec(lines[index]!);
    if (!match) {
      kept.push(lines[index]!);
      continue;
    }
    const end = `# <<< woma:${match[1]}`;
    while (index < lines.length && lines[index] !== end) index += 1;
    if (index === lines.length) throw new Error(`Cannot merge ${filePath}: unterminated Woma-managed Codex block`);
  }
  return kept.join("\n").trimEnd();
}

function renderCodexConfig(input: string | null, filePath: string, packages: InstalledPackage[]): string {
  const baseline = withoutWomaCodexBlocks(input ?? "", filePath);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (baseline ? parseToml(baseline) : {}) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot merge ${filePath}: ${(error as Error).message}`);
  }
  const existingServers = parsed.mcp_servers ?? {};
  if (!existingServers || typeof existingServers !== "object" || Array.isArray(existingServers)) {
    throw new Error(`Cannot merge ${filePath}: mcp_servers must be a table`);
  }
  const blocks: string[] = [];
  for (const { packageName, server } of collectServers(packages, "codex")) {
    const existing = (existingServers as Record<string, unknown>)[server.name];
    const desired = codexValue(server);
    if (existing !== undefined && !equal(existing, desired)) {
      throw new Error(`Refusing to overwrite Codex MCP server ${server.name} from ${filePath}`);
    }
    if (existing === undefined) blocks.push(codexBlock(packageName, server));
  }
  const prefix = baseline ? `${baseline}\n\n` : "";
  const suffix = blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
  return `${prefix}${suffix}`;
}

function defaultAgentHome(platform: Platform): string {
  if (platform === "codex") {
    return path.resolve(process.env.WOMA_ORIGINAL_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
  }
  if (platform === "claude") {
    return path.resolve(
      process.env.WOMA_ORIGINAL_CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    );
  }
  if (platform === "qoder") {
    return path.resolve(
      process.env.WOMA_ORIGINAL_QODER_CONFIG_DIR ?? process.env.QODER_CONFIG_DIR ?? path.join(os.homedir(), ".qoder"),
    );
  }
  return path.resolve(
    process.env.WOMA_ORIGINAL_PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"),
  );
}

export function sourceAgentHome(platform: Platform): string {
  const candidate = defaultAgentHome(platform);
  const environmentRoot = path.join(womaHome(), "environments");
  const relative = path.relative(environmentRoot, candidate);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    if (platform === "codex") return path.join(os.homedir(), ".codex");
    if (platform === "claude") return path.join(os.homedir(), ".claude");
    if (platform === "qoder") return path.join(os.homedir(), ".qoder");
    return path.join(os.homedir(), ".pi", "agent");
  }
  return candidate;
}

export async function validateCodexSourceConfiguration(): Promise<void> {
  const sourceHome = sourceAgentHome("codex");
  const configPath = path.join(sourceHome, "config.toml");
  if (await regularFileExists(configPath)) {
    renderCodexConfig(await readOptional(configPath), configPath, []);
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

async function copyClaudeCredential(environmentName: string, root: string, seedFromOriginal: boolean): Promise<void> {
  const name = ".credentials.json";
  const homeCredential = path.join(environmentAgentHomePath(environmentName, "claude"), name);
  const currentCredential = path.join(environmentViewPath(environmentName), "claude", name);
  const originalCredential = path.join(sourceAgentHome("claude"), name);
  const source = (await pathExists(homeCredential))
    ? homeCredential
    : (await pathExists(currentCredential))
      ? currentCredential
      : seedFromOriginal
        ? originalCredential
        : undefined;
  if (!source) return;
  const content = await readFile(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!content) return;
  const mode = await stat(source).then((info) => info.mode);
  await writeBufferPreservingFile(path.join(root, name), content, mode);
}

function collectServers(packages: InstalledPackage[], platform: ConfigurablePlatform): { packageName: string; server: McpServer }[] {
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

function collectHooks(packages: InstalledPackage[], platform: ConfigurablePlatform): HookSpec[] {
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

function removeHooks(filePath: string, root: Record<string, unknown>, removals: HookSpec[]): void {
  if (removals.length === 0 || root.hooks === undefined) return;
  const hooks = objectAt(root, "hooks", filePath);
  for (const hook of removals) {
    const existing = hooks[hook.event];
    if (existing === undefined) continue;
    if (!Array.isArray(existing)) throw new Error(`Cannot merge ${filePath}: hooks.${hook.event} must be an array`);
    const retained = existing.filter((value) => !equal(value, hookValue(hook)));
    if (retained.length > 0) hooks[hook.event] = retained;
    else delete hooks[hook.event];
  }
  if (Object.keys(hooks).length === 0) delete root.hooks;
}

async function buildCodexView(
  environmentName: string,
  root: string,
  packages: InstalledPackage[],
  previousPackages: InstalledPackage[],
  seedFromOriginal: boolean,
): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("codex");
  const links = await linkSkills(root, packages);

  const currentConfig = path.join(environmentViewPath(environmentName), "codex", "config.toml");
  const originalConfig = path.join(sourceHome, "config.toml");
  const sourceConfig = (await pathExists(currentConfig))
    ? currentConfig
    : seedFromOriginal && (await regularFileExists(originalConfig))
      ? originalConfig
      : undefined;
  const configDestination = path.join(root, "config.toml");
  await writeTextAtomic(
    configDestination,
    renderCodexConfig(sourceConfig ? await readOptional(sourceConfig) : null, sourceConfig ?? configDestination, packages),
  );
  await chmod(configDestination, 0o600);

  const currentHooks = path.join(environmentViewPath(environmentName), "codex", "hooks.json");
  const originalHooks = path.join(sourceHome, "hooks.json");
  const sourceHooks = (await pathExists(currentHooks))
    ? currentHooks
    : seedFromOriginal && (await regularFileExists(originalHooks))
      ? originalHooks
      : undefined;
  const hooksPath = sourceHooks ?? path.join(root, "hooks.json");
  const hooksRoot = parseJsonObject(sourceHooks ? await readOptional(sourceHooks) : null, hooksPath);
  removeHooks(hooksPath, hooksRoot, collectHooks(previousPackages, "codex"));
  await mergeHooks(hooksPath, hooksRoot, collectHooks(packages, "codex"));
  const hooksDestination = path.join(root, "hooks.json");
  await writeJsonAtomic(hooksDestination, hooksRoot);
  await chmod(hooksDestination, 0o600);
  return links;
}

async function buildPiView(root: string, packages: InstalledPackage[]): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return linkSkills(root, packages);
}

async function buildClaudeView(
  environmentName: string,
  root: string,
  packages: InstalledPackage[],
  previousPackages: InstalledPackage[],
  seedFromOriginal: boolean,
): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("claude");
  const links = await linkSkills(root, packages);
  await copyClaudeCredential(environmentName, root, seedFromOriginal);

  const currentSettings = path.join(environmentViewPath(environmentName), "claude", "settings.json");
  const sourceSettings = (await pathExists(currentSettings))
    ? currentSettings
    : seedFromOriginal
      ? path.join(sourceHome, "settings.json")
      : undefined;
  const settingsPath = sourceSettings ?? path.join(root, "settings.json");
  const settings = parseJsonObject(sourceSettings ? await readOptional(sourceSettings) : null, settingsPath);
  removeHooks(settingsPath, settings, collectHooks(previousPackages, "claude"));
  await mergeHooks(settingsPath, settings, collectHooks(packages, "claude"));
  const settingsDestination = path.join(root, "settings.json");
  await writeJsonAtomic(settingsDestination, settings);
  await chmod(settingsDestination, 0o600);
  return links;
}

function removeServers(root: Record<string, unknown>, filePath: string, removals: { server: McpServer }[]): void {
  if (removals.length === 0 || root.mcpServers === undefined) return;
  const servers = objectAt(root, "mcpServers", filePath);
  for (const { server } of removals) delete servers[server.name];
  if (Object.keys(servers).length === 0) delete root.mcpServers;
}

function mergeServers(root: Record<string, unknown>, filePath: string, additions: { server: McpServer }[]): void {
  if (additions.length === 0) return;
  const servers = objectAt(root, "mcpServers", filePath);
  for (const { server } of additions) {
    const desired = claudeValue(server);
    const existing = servers[server.name];
    if (existing !== undefined && !equal(existing, desired)) {
      throw new Error(`Refusing to overwrite Qoder MCP server ${server.name} in ${filePath}`);
    }
    servers[server.name] = desired;
  }
}

async function buildQoderView(
  environmentName: string,
  root: string,
  packages: InstalledPackage[],
  previousPackages: InstalledPackage[],
  seedFromOriginal: boolean,
): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("qoder");
  const links = await linkSkills(root, packages);

  const currentSettings = path.join(environmentViewPath(environmentName), "qoder", "settings.json");
  const sourceSettings = (await pathExists(currentSettings))
    ? currentSettings
    : seedFromOriginal
      ? path.join(sourceHome, "settings.json")
      : undefined;
  const settingsPath = sourceSettings ?? path.join(root, "settings.json");
  const settings = parseJsonObject(sourceSettings ? await readOptional(sourceSettings) : null, settingsPath);
  removeHooks(settingsPath, settings, collectHooks(previousPackages, "qoder"));
  await mergeHooks(settingsPath, settings, collectHooks(packages, "qoder"));
  removeServers(settings, settingsPath, collectServers(previousPackages, "qoder"));
  mergeServers(settings, settingsPath, collectServers(packages, "qoder"));
  const settingsDestination = path.join(root, "settings.json");
  await writeJsonAtomic(settingsDestination, settings);
  await chmod(settingsDestination, 0o600);
  return links;
}

export function environmentViewPath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid Environment name: ${name}`);
  return path.join(womaHome(), "environments", name, "view");
}

interface ViewMetadata {
  targets?: unknown;
  skills?: unknown;
  resources?: { codexMcpServers?: unknown; claudeMcpServers?: unknown; qoderMcpServers?: unknown } | undefined;
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
  seedFromOriginal: boolean,
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
    for (const name of MANAGED_HOME_LINKS[platform]) {
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
        if (CREDENTIAL_FILES[platform].includes(name) && actual === path.join(sourceAgentHome(platform), name)) {
          links.push({ destination, source, directory: false, action: "replace", previous: { target } });
          continue;
        }
        throw new Error(`Managed Agent home link has an unexpected target: ${destination}`);
      }
      if (CREDENTIAL_FILES[platform].includes(name) && info.isFile()) {
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

  let claudeState:
    | { path: string; input: string | null; mode: number | undefined; output: string; changed: boolean }
    | undefined;
  if (environment.spec.targets.includes("claude")) {
    const statePath = path.join(environmentAgentHomePath(environment.metadata.name, "claude"), ".claude.json");
    const input = await readOptional(statePath);
    const sourcePath = originalClaudeStatePath(sourceAgentHome("claude"));
    const state = input === null
      ? parseJsonObject(seedFromOriginal ? await readOptional(sourcePath) : null, sourcePath)
      : parseJsonObject(input, statePath);
    const currentServers = state.mcpServers;
    if (currentServers !== undefined && (!currentServers || typeof currentServers !== "object" || Array.isArray(currentServers))) {
      throw new Error(`Cannot merge ${statePath}: mcpServers must be an object`);
    }
    const servers = { ...((currentServers as Record<string, unknown> | undefined) ?? {}) };
    const previousManagedServers = new Set(stringArray(previousMetadata.resources?.claudeMcpServers));
    for (const { server } of collectServers(previousPackages, "claude")) previousManagedServers.add(server.name);
    for (const name of previousManagedServers) delete servers[name];
    for (const { server } of collectServers(packages, "claude")) {
      const desired = claudeValue(server);
      const existing = servers[server.name];
      if (existing !== undefined && !equal(existing, desired)) {
        throw new Error(`Refusing to overwrite Claude MCP server ${server.name} in ${statePath}`);
      }
      servers[server.name] = desired;
    }
    if (Object.keys(servers).length > 0) state.mcpServers = servers;
    else delete state.mcpServers;
    const output = `${JSON.stringify(state, null, 2)}\n`;
    const info = await lstat(statePath).catch(() => undefined);
    claudeState = { path: statePath, input, mode: info?.mode, output, changed: input !== output };
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
        if (claudeState?.changed) {
          await writeTextAtomic(claudeState.path, claudeState.output);
          await chmod(claudeState.path, 0o600);
          rollbacks.push(async () => {
            if (claudeState!.input === null) await rm(claudeState!.path, { force: true });
            else {
              await writeTextAtomic(claudeState!.path, claudeState!.input);
              if (claudeState!.mode !== undefined) await chmod(claudeState!.path, claudeState!.mode);
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
    if (environment.spec.targets.includes("codex")) {
      skillLinks.codex = await buildCodexView(
        name,
        path.join(temporary, "codex"),
        packages,
        hooks.previousPackages ?? [],
        seedFromOriginal,
      );
    }
    if (environment.spec.targets.includes("claude")) {
      skillLinks.claude = await buildClaudeView(
        name,
        path.join(temporary, "claude"),
        packages,
        hooks.previousPackages ?? [],
        seedFromOriginal,
      );
    }
    if (environment.spec.targets.includes("pi")) {
      skillLinks.pi = await buildPiView(path.join(temporary, "pi"), packages);
    }
    if (environment.spec.targets.includes("qoder")) {
      skillLinks.qoder = await buildQoderView(
        name,
        path.join(temporary, "qoder"),
        packages,
        hooks.previousPackages ?? [],
        seedFromOriginal,
      );
    }
    const codexMcpServers = environment.spec.targets.includes("codex")
      ? collectServers(packages, "codex").map(({ server }) => server.name)
      : [];
    const claudeMcpServers = environment.spec.targets.includes("claude")
      ? collectServers(packages, "claude").map(({ server }) => server.name)
      : [];
    const qoderMcpServers = environment.spec.targets.includes("qoder")
      ? collectServers(packages, "qoder").map(({ server }) => server.name)
      : undefined;
    await writeJsonAtomic(path.join(temporary, "view.json"), {
      environment: name,
      targets: environment.spec.targets,
      packages: packages.map((pkg) => ({ name: pkg.lock.name, version: pkg.lock.version, integrity: pkg.lock.integrity })),
      skills: skillLinks,
      resources: { codexMcpServers, claudeMcpServers, ...(qoderMcpServers ? { qoderMcpServers } : {}) },
    });
    await hooks.beforePublish?.();
    const homeTransition = await prepareStableHomeTransition(
      environment,
      packages,
      previousMetadata,
      hooks.previousPackages ?? [],
      seedFromOriginal,
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
  const expectedResources = {
    codexMcpServers: environment.spec.targets.includes("codex")
      ? collectServers(packages, "codex").map(({ server }) => server.name)
      : [],
    claudeMcpServers: environment.spec.targets.includes("claude")
      ? collectServers(packages, "claude").map(({ server }) => server.name)
      : [],
    ...(environment.spec.targets.includes("qoder")
      ? { qoderMcpServers: collectServers(packages, "qoder").map(({ server }) => server.name) }
      : {}),
  };
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
    const homeInfo = await lstat(home).catch(() => undefined);
    if (!homeInfo?.isDirectory() || homeInfo.isSymbolicLink()) {
      throw new Error(`Stable Agent home is missing or invalid: ${home}`);
    }
    for (const name of MANAGED_HOME_LINKS[target]) {
      const link = path.join(home, name);
      const info = await lstat(link).catch(() => undefined);
      if (!info?.isSymbolicLink()) throw new Error(`Managed Agent home link is missing: ${link}`);
      const expected = path.join(root, target, name);
      const actual = path.resolve(path.dirname(link), await readlink(link));
      if (actual !== expected) throw new Error(`Managed Agent home link has an unexpected target: ${link}`);
    }
    const homeSkills = path.join(home, "skills");
    const homeSkillsInfo = await lstat(homeSkills).catch(() => undefined);
    if (!homeSkillsInfo?.isSymbolicLink() || !(await managedLinkMatches(homeSkills, sharedSkillsRoot))) {
      throw new Error(`Agent Skills link does not use the shared Environment root: ${homeSkills}`);
    }
    const unexpectedViewEntries = (await readdir(path.join(root, target))).filter(
      (name) => !MANAGED_VIEW_ENTRIES[target].includes(name),
    );
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
    if (target === "codex") {
      const configPath = path.join(root, "codex", "config.toml");
      const configInput = await readOptional(configPath);
      if (configInput !== renderCodexConfig(configInput, configPath, packages)) {
        throw new Error(`Codex MCP configuration differs from the Environment closure in ${configPath}`);
      }
      const hooksPath = path.join(root, "codex", "hooks.json");
      const hooksRoot = parseJsonObject(await readOptional(hooksPath), hooksPath);
      const expectedHooks = parseJsonObject(await readOptional(hooksPath), hooksPath);
      removeHooks(hooksPath, expectedHooks, collectHooks(packages, "codex"));
      await mergeHooks(hooksPath, expectedHooks, collectHooks(packages, "codex"));
      if (!equal(hooksRoot, expectedHooks)) throw new Error(`Codex Hooks differ from the Environment closure in ${hooksPath}`);
    } else if (target === "claude") {
      const statePath = path.join(home, ".claude.json");
      const state = parseJsonObject(await readOptional(statePath), statePath);
      for (const { server } of collectServers(packages, "claude")) {
        const actual = (state.mcpServers as Record<string, unknown> | undefined)?.[server.name];
        if (!equal(actual, claudeValue(server))) {
          throw new Error(`Claude MCP configuration differs from the Environment closure in ${statePath}`);
        }
      }
      const settingsPath = path.join(root, "claude", "settings.json");
      const settings = parseJsonObject(await readOptional(settingsPath), settingsPath);
      const expectedSettings = parseJsonObject(await readOptional(settingsPath), settingsPath);
      removeHooks(settingsPath, expectedSettings, collectHooks(packages, "claude"));
      await mergeHooks(settingsPath, expectedSettings, collectHooks(packages, "claude"));
      if (!equal(settings, expectedSettings)) throw new Error(`Claude Hooks differ from the Environment closure in ${settingsPath}`);
    } else if (target === "qoder") {
      const settingsPath = path.join(root, "qoder", "settings.json");
      const settings = parseJsonObject(await readOptional(settingsPath), settingsPath);
      const expectedSettings = parseJsonObject(await readOptional(settingsPath), settingsPath);
      removeHooks(settingsPath, expectedSettings, collectHooks(packages, "qoder"));
      await mergeHooks(settingsPath, expectedSettings, collectHooks(packages, "qoder"));
      removeServers(expectedSettings, settingsPath, collectServers(packages, "qoder"));
      mergeServers(expectedSettings, settingsPath, collectServers(packages, "qoder"));
      if (!equal(settings, expectedSettings)) {
        throw new Error(`Qoder configuration differs from the Environment closure in ${settingsPath}`);
      }
    }
  }
}

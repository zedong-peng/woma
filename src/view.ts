import { chmod, lstat, mkdir, readFile, readlink, readdir, realpath, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { harnessHome, pathExists, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import type { HarnessEnvironment, HookSpec, InstalledPackage, McpServer, Platform } from "./types.js";

const MANAGED_HOME_LINKS: Record<Platform, string[]> = {
  codex: ["config.toml", "hooks.json", "skills"],
  claude: ["settings.json", "skills"],
};

const SHARED_CREDENTIAL_FILES: Record<Platform, string[]> = {
  codex: ["auth.json"],
  claude: [".credentials.json"],
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

export function environmentAgentHomePath(environmentName: string, platform: Platform): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(environmentName)) throw new Error(`Invalid Environment name: ${environmentName}`);
  return path.join(harnessHome(), "environments", environmentName, "home", platform);
}

function codexSystemSkillsRoot(environmentName: string): string {
  return path.join(harnessHome(), "environments", environmentName, "home", "codex-system-skills");
}

async function linkCodexSystemSkills(environmentName: string, destinationRoot: string): Promise<void> {
  const stable = codexSystemSkillsRoot(environmentName);
  await mkdir(stable, { recursive: true, mode: 0o700 });
  await createSymlink(stable, path.join(destinationRoot, "skills", ".system"), true);
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

async function buildCodexView(environmentName: string, root: string, packages: InstalledPackage[]): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("codex");
  const links = await linkSkills(root, packages);
  await linkCodexSystemSkills(environmentName, root);

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
  const prefix = original?.trimEnd() ? `${original.trimEnd()}\n\n` : "";
  const suffix = blocks.length > 0 ? `${blocks.join("\n\n")}\n` : "";
  const configDestination = path.join(root, "config.toml");
  await writeTextAtomic(configDestination, `${prefix}${suffix}`);
  await chmod(configDestination, 0o600);

  const sourceHooks = path.join(sourceHome, "hooks.json");
  const hooksRoot = parseJsonObject(await readOptional(sourceHooks), sourceHooks);
  await mergeHooks(sourceHooks, hooksRoot, collectHooks(packages, "codex"));
  const hooksDestination = path.join(root, "hooks.json");
  await writeJsonAtomic(hooksDestination, hooksRoot);
  await chmod(hooksDestination, 0o600);
  return links;
}

async function buildClaudeView(
  root: string,
  packages: InstalledPackage[],
): Promise<Record<string, string>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceHome = sourceAgentHome("claude");
  const links = await linkSkills(root, packages);

  const sourceSettings = path.join(sourceHome, "settings.json");
  const settings = parseJsonObject(await readOptional(sourceSettings), sourceSettings);
  await mergeHooks(sourceSettings, settings, collectHooks(packages, "claude"));
  const settingsDestination = path.join(root, "settings.json");
  await writeJsonAtomic(settingsDestination, settings);
  await chmod(settingsDestination, 0o600);
  return links;
}

export function environmentViewPath(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) throw new Error(`Invalid Environment name: ${name}`);
  return path.join(harnessHome(), "environments", name, "view");
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

interface StableHomeTransition {
  apply: () => Promise<() => Promise<void>>;
}

async function prepareStableHomeTransition(
  environment: HarnessEnvironment,
  packages: InstalledPackage[],
  previousMetadata: ViewMetadata,
  previousPackages: InstalledPackage[],
): Promise<StableHomeTransition> {
  const links: { destination: string; source: string; directory: boolean; create: boolean }[] = [];
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
        links.push({ destination, source, directory: name === "skills", create: true });
        continue;
      }
      if (!info.isSymbolicLink()) throw new Error(`Managed Agent home path must be a symbolic link: ${destination}`);
      const actual = path.resolve(path.dirname(destination), await readlink(destination));
      if (actual !== source) throw new Error(`Managed Agent home link has an unexpected target: ${destination}`);
      links.push({ destination, source, directory: name === "skills", create: false });
    }
    for (const name of SHARED_CREDENTIAL_FILES[platform]) {
      const destination = path.join(home, name);
      const source = path.join(sourceAgentHome(platform), name);
      const info = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (!info) links.push({ destination, source, directory: false, create: true });
      else if (info.isSymbolicLink()) {
        const actual = path.resolve(path.dirname(destination), await readlink(destination));
        if (actual !== source) throw new Error(`Shared Agent credential link has an unexpected target: ${destination}`);
      }
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
      ? parseJsonObject(await readOptional(sourcePath), sourcePath)
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
        for (const link of links.filter((item) => item.create)) {
          await mkdir(path.dirname(link.destination), { recursive: true, mode: 0o700 });
          await createSymlink(link.source, link.destination, link.directory);
          rollbacks.push(() => rm(link.destination, { force: true }));
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
    const skillLinks: Partial<Record<Platform, Record<string, string>>> = {};
    if (environment.spec.targets.includes("codex")) {
      skillLinks.codex = await buildCodexView(name, path.join(temporary, "codex"), packages);
    }
    if (environment.spec.targets.includes("claude")) {
      skillLinks.claude = await buildClaudeView(path.join(temporary, "claude"), packages);
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
    await hooks.beforePublish?.();
    const homeTransition = await prepareStableHomeTransition(environment, packages, previousMetadata, hooks.previousPackages ?? []);
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
    for (const name of SHARED_CREDENTIAL_FILES[target]) {
      const credential = path.join(home, name);
      const info = await lstat(credential).catch(() => undefined);
      if (!info?.isSymbolicLink()) continue;
      const expected = path.join(sourceAgentHome(target), name);
      const actual = path.resolve(path.dirname(credential), await readlink(credential));
      if (actual !== expected) throw new Error(`Shared Agent credential link has an unexpected target: ${credential}`);
    }
    const unexpectedViewEntries = (await readdir(path.join(root, target))).filter(
      (name) => !MANAGED_HOME_LINKS[target].includes(name),
    );
    if (unexpectedViewEntries.length > 0) {
      throw new Error(`Environment view contains unmanaged Agent state: ${unexpectedViewEntries.join(", ")}`);
    }
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
      if (!info?.isSymbolicLink()) throw new Error(`Codex system Skills stable link is missing: ${system}`);
      const actual = path.resolve(path.dirname(system), await readlink(system));
      if (actual !== codexSystemSkillsRoot(environment.metadata.name)) {
        throw new Error(`Codex system Skills stable link has an unexpected target: ${system}`);
      }
    }
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
      const sourceSettingsPath = path.join(sourceAgentHome("claude"), "settings.json");
      const expectedSettings = parseJsonObject(await readOptional(sourceSettingsPath), sourceSettingsPath);
      await mergeHooks(sourceSettingsPath, expectedSettings, collectHooks(packages, "claude"));
      if (!equal(settings, expectedSettings)) throw new Error(`Claude Hooks differ from the Environment closure in ${settingsPath}`);
    }
  }
}

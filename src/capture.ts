import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { stringify as stringifyYaml } from "yaml";
import { pathExists, writeTextAtomic } from "./fs.js";
import { validatePackage } from "./package.js";
import type { HarnessManifest, HookSpec, McpServer, Platform, SkillSpec } from "./types.js";

export interface CaptureResult {
  root: string;
  manifest: HarnessManifest;
  warnings: string[];
}

function slug(input: string): string {
  const value = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  if (!value) throw new Error(`Cannot convert ${JSON.stringify(input)} into a package name`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function strings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  return value as string[];
}

function envReference(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be an environment reference`);
  const match = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(value);
  if (!match?.[1]) {
    throw new Error(`${label} contains a literal value; replace it with \${ENV_NAME} before capture to avoid leaking secrets`);
  }
  return match[1];
}

async function captureSkills(sourceRoot: string, outputRoot: string, platform: Platform): Promise<SkillSpec[]> {
  const skillRoot = path.join(sourceRoot, platform === "codex" ? ".agents/skills" : ".claude/skills");
  if (!(await pathExists(skillRoot))) return [];
  const skills: SkillSpec[] = [];
  for (const entry of (await readdir(skillRoot)).sort()) {
    const source = path.join(skillRoot, entry);
    if (!(await stat(source)).isDirectory() || !(await pathExists(path.join(source, "SKILL.md")))) continue;
    const name = slug(entry);
    const destination = path.join(outputRoot, "skills", name);
    if (await pathExists(destination)) throw new Error(`Duplicate captured skill: ${name}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(source, destination, { recursive: true, errorOnExist: true });
    skills.push({ name, path: `./skills/${name}` });
  }
  return skills;
}

async function captureCodexMcp(sourceRoot: string): Promise<McpServer[]> {
  const configPath = path.join(sourceRoot, ".codex", "config.toml");
  if (!(await pathExists(configPath))) return [];
  const parsed = parseToml(await readFile(configPath, "utf8")) as Record<string, unknown>;
  const servers = parsed.mcp_servers === undefined ? {} : object(parsed.mcp_servers, "mcp_servers");
  const result: McpServer[] = [];
  for (const [name, raw] of Object.entries(servers)) {
    const server = object(raw, `mcp_servers.${name}`);
    if (typeof server.command === "string") {
      const env = strings(server.env_vars, `mcp_servers.${name}.env_vars`);
      result.push({
        name: slug(name),
        transport: "stdio",
        command: server.command,
        args: strings(server.args, `mcp_servers.${name}.args`),
        env,
        platforms: ["codex"],
      });
    } else if (typeof server.url === "string") {
      const rawHeaders = server.env_http_headers === undefined ? {} : object(server.env_http_headers, `mcp_servers.${name}.env_http_headers`);
      const headers: Record<string, string> = {};
      for (const [header, env] of Object.entries(rawHeaders)) {
        if (typeof env !== "string") throw new Error(`mcp_servers.${name}.env_http_headers.${header} must be an env name`);
        headers[header] = env;
      }
      result.push({ name: slug(name), transport: "http", url: server.url, headers, platforms: ["codex"] });
    }
  }
  return result;
}

function parseClaudeServer(name: string, raw: unknown): McpServer {
  const server = object(raw, `mcpServers.${name}`);
  if (typeof server.command === "string") {
    const rawEnv = server.env === undefined ? {} : object(server.env, `mcpServers.${name}.env`);
    const env = Object.entries(rawEnv).map(([key, value]) => {
      const referenced = envReference(value, `mcpServers.${name}.env.${key}`);
      if (referenced !== key) throw new Error(`mcpServers.${name}.env.${key} must reference \${${key}}`);
      return key;
    });
    return {
      name: slug(name),
      transport: "stdio",
      command: server.command,
      args: strings(server.args, `mcpServers.${name}.args`),
      env,
      platforms: ["claude"],
    };
  }
  if (typeof server.url !== "string") throw new Error(`mcpServers.${name} needs command or url`);
  const transport = server.type;
  if (transport !== "http" && transport !== "sse" && transport !== "ws" && transport !== "streamable-http") {
    throw new Error(`mcpServers.${name}.type must be http, streamable-http, sse, or ws`);
  }
  const rawHeaders = server.headers === undefined ? {} : object(server.headers, `mcpServers.${name}.headers`);
  const headers: Record<string, string> = {};
  for (const [header, value] of Object.entries(rawHeaders)) headers[header] = envReference(value, `mcpServers.${name}.headers.${header}`);
  return {
    name: slug(name),
    transport: transport === "streamable-http" ? "http" : transport,
    url: server.url,
    headers,
    platforms: ["claude"],
  };
}

async function captureCommandHooks(settingsPath: string, warnings: string[], platform: Platform): Promise<HookSpec[]> {
  const capturedHooks: HookSpec[] = [];
  if (!(await pathExists(settingsPath))) return capturedHooks;
  const settings = object(JSON.parse(await readFile(settingsPath, "utf8")) as unknown, path.basename(settingsPath));
  const hooks = settings.hooks === undefined ? {} : object(settings.hooks, "hooks");
  for (const [event, rawGroups] of Object.entries(hooks)) {
    if (!Array.isArray(rawGroups)) throw new Error(`hooks.${event} must be an array`);
    for (const rawGroup of rawGroups) {
      const group = object(rawGroup, `hooks.${event}[]`);
      const handlers = group.hooks;
      if (!Array.isArray(handlers)) continue;
      for (const rawHandler of handlers) {
        const handler = object(rawHandler, `hooks.${event}[].hooks[]`);
        if (handler.type !== "command" || typeof handler.command !== "string") {
          warnings.push(`Skipped non-command hook in ${event}`);
          continue;
        }
        const hook: HookSpec = { event, command: handler.command, platforms: [platform] };
        if (typeof group.matcher === "string") hook.matcher = group.matcher;
        if (typeof handler.timeout === "number") hook.timeout = handler.timeout;
        capturedHooks.push(hook);
      }
    }
  }
  return capturedHooks;
}

async function captureClaudeConfig(sourceRoot: string, warnings: string[]): Promise<{ servers: McpServer[]; hooks: HookSpec[] }> {
  const mcpPath = path.join(sourceRoot, ".mcp.json");
  const servers: McpServer[] = [];
  if (await pathExists(mcpPath)) {
    const root = object(JSON.parse(await readFile(mcpPath, "utf8")) as unknown, ".mcp.json");
    const entries = root.mcpServers === undefined ? {} : object(root.mcpServers, "mcpServers");
    for (const [name, raw] of Object.entries(entries)) servers.push(parseClaudeServer(name, raw));
  }

  return { servers, hooks: await captureCommandHooks(path.join(sourceRoot, ".claude", "settings.json"), warnings, "claude") };
}

export async function captureHarness(options: {
  sourceRoot: string;
  outputRoot: string;
  platform: Platform;
  name?: string;
}): Promise<CaptureResult> {
  const sourceRoot = path.resolve(options.sourceRoot);
  const outputRoot = path.resolve(options.outputRoot);
  if (await pathExists(path.join(outputRoot, "harness.yaml"))) throw new Error(`Refusing to overwrite ${path.join(outputRoot, "harness.yaml")}`);
  const warnings: string[] = [];
  let mcpServers: McpServer[] = [];
  let hooks: HookSpec[] = [];
  if (options.platform === "codex") {
    mcpServers = await captureCodexMcp(sourceRoot);
    hooks = await captureCommandHooks(path.join(sourceRoot, ".codex", "hooks.json"), warnings, "codex");
  } else ({ servers: mcpServers, hooks } = await captureClaudeConfig(sourceRoot, warnings));
  await mkdir(outputRoot, { recursive: true });
  const skills = await captureSkills(sourceRoot, outputRoot, options.platform);

  const envNames = new Set<string>();
  for (const server of mcpServers) {
    if (server.transport === "stdio") server.env.forEach((name) => envNames.add(name));
    else Object.values(server.headers).forEach((name) => envNames.add(name));
  }
  const name = slug(options.name ?? path.basename(outputRoot));
  const manifest: HarnessManifest = {
    apiVersion: "harness.conda/v1",
    kind: "Harness",
    metadata: {
      name,
      version: "0.1.0",
      description: `Captured ${options.platform} harness from ${path.basename(sourceRoot)}.`,
      tags: ["captured"],
    },
    spec: {
      platforms: [options.platform],
      requirements: {
        env: [...envNames].sort().map((env) => ({ name: env, description: "Required by a captured MCP server.", optional: false })),
        commands: [],
      },
      skills,
      mcpServers,
      hooks,
    },
  };
  await writeTextAtomic(path.join(outputRoot, "harness.yaml"), stringifyYaml(manifest, { lineWidth: 120 }));
  await validatePackage(outputRoot, manifest);
  return { root: outputRoot, manifest, warnings };
}

import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { hashDirectory, pathExists, relativeDisplay, removeEmptyParents, writeJsonAtomic, writeTextAtomic } from "./fs.js";
import { deleteActivation, putActivation, readState } from "./store.js";
import type {
  Action,
  ActivationRecord,
  HookSpec,
  InstalledPackage,
  ManagedArtifact,
  McpServer,
  Platform,
  StateFile,
} from "./types.js";

interface PreparedFile {
  path: string;
  original: string | null;
  content: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function equal(left: unknown, right: unknown): boolean {
  return stable(left) === stable(right);
}

function tomlPayload(block: string): string {
  return block
    .split("\n")
    .filter((line) => !line.startsWith("# >>> harness-conda:") && !line.startsWith("# <<< harness-conda:"))
    .join("\n");
}

function sameArtifactResource(left: ManagedArtifact, right: ManagedArtifact): boolean {
  if (left.kind !== right.kind || left.path !== right.path) return false;
  if (left.kind === "directory" && right.kind === "directory") return left.integrity === right.integrity;
  if (left.kind === "toml-block" && right.kind === "toml-block") return tomlPayload(left.block) === tomlPayload(right.block);
  if (left.kind === "json-entry" && right.kind === "json-entry") {
    return equal(left.jsonPath, right.jsonPath) && equal(left.value, right.value);
  }
  if (left.kind === "json-array-entry" && right.kind === "json-array-entry") {
    return equal(left.jsonPath, right.jsonPath) && equal(left.value, right.value);
  }
  return false;
}

function samePhysicalArtifact(left: ManagedArtifact, right: ManagedArtifact): boolean {
  const { managed: _leftManaged, ...leftValue } = left;
  const { managed: _rightManaged, ...rightValue } = right;
  return equal(leftValue, rightValue);
}

function adoptedArtifact(state: StateFile, candidate: ManagedArtifact): ManagedArtifact {
  for (const activation of Object.values(state.activations)) {
    const existing = activation.artifacts.find((artifact) => artifact.managed && sameArtifactResource(artifact, candidate));
    if (existing) return { ...existing, managed: true };
  }
  return candidate;
}

async function readOptional(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function parseJsonObject(content: string | null, filePath: string): Record<string, unknown> {
  if (content === null || content.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot merge ${filePath}: ${(error as Error).message}`);
  }
}

function getObject(root: Record<string, unknown>, key: string, filePath: string): Record<string, unknown> {
  const current = root[key];
  if (current === undefined) {
    const created: Record<string, unknown> = {};
    root[key] = created;
    return created;
  }
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    throw new Error(`Cannot merge ${filePath}: ${key} must be an object`);
  }
  return current as Record<string, unknown>;
}

function getArray(root: Record<string, unknown>, key: string, filePath: string): unknown[] {
  const current = root[key];
  if (current === undefined) {
    const created: unknown[] = [];
    root[key] = created;
    return created;
  }
  if (!Array.isArray(current)) throw new Error(`Cannot merge ${filePath}: ${key} must be an array`);
  return current;
}

function appliesTo(server: McpServer, platform: Platform): boolean {
  return !server.platforms || server.platforms.includes(platform);
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

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function tomlInlineTable(values: Record<string, string>): string {
  return `{ ${Object.entries(values)
    .map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`)
    .join(", ")} }`;
}

function codexBlock(packageName: string, server: McpServer): { marker: string; block: string } {
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
  return { marker, block: lines.join("\n") };
}

function claudeValue(server: McpServer): Record<string, unknown> {
  if (server.transport === "stdio") {
    return {
      type: "stdio",
      command: server.command,
      args: server.args,
      ...(server.env.length > 0
        ? { env: Object.fromEntries(server.env.map((name) => [name, `\${${name}}`])) }
        : {}),
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

function claudeHook(hook: HookSpec): Record<string, unknown> {
  const handler: Record<string, unknown> = { type: "command", command: hook.command };
  if (hook.timeout !== undefined) handler.timeout = hook.timeout;
  return {
    ...(hook.matcher ? { matcher: hook.matcher } : {}),
    hooks: [handler],
  };
}

function getAtPath(root: Record<string, unknown>, jsonPath: string[]): unknown {
  let current: unknown = root;
  for (const key of jsonPath) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function deleteAtPath(root: Record<string, unknown>, jsonPath: string[]): void {
  if (jsonPath.length === 0) return;
  const parents: Record<string, unknown>[] = [root];
  let current = root;
  for (const key of jsonPath.slice(0, -1)) {
    const next = current[key];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    current = next as Record<string, unknown>;
    parents.push(current);
  }
  delete current[jsonPath.at(-1)!];
  for (let index = parents.length - 1; index > 0; index -= 1) {
    const child = parents[index]!;
    if (Object.keys(child).length > 0) break;
    const parent = parents[index - 1]!;
    delete parent[jsonPath[index - 1]!];
  }
}

async function prepareActivation(
  pkg: InstalledPackage,
  projectRoot: string,
  targets: Platform[],
  state: StateFile,
): Promise<{ actions: Action[]; artifacts: ManagedArtifact[]; files: PreparedFile[]; directories: { source: string; destination: string }[] }> {
  const actions: Action[] = [];
  const artifacts: ManagedArtifact[] = [];
  const files: PreparedFile[] = [];
  const directories: { source: string; destination: string }[] = [];

  for (const target of targets) {
    const skillBase = path.join(projectRoot, target === "codex" ? ".agents/skills" : ".claude/skills");
    for (const skill of pkg.manifest.spec.skills) {
      const source = path.resolve(pkg.root, skill.path);
      const destination = path.join(skillBase, skill.name);
      const sourceIntegrity = await hashDirectory(source);
      const display = relativeDisplay(projectRoot, destination);
      if (await pathExists(destination)) {
        const destinationIntegrity = await hashDirectory(destination);
        if (destinationIntegrity !== sourceIntegrity) {
          throw new Error(`Refusing to overwrite existing skill at ${display}`);
        }
        actions.push({ verb: "adopt", path: display, detail: `${target} skill already matches` });
        artifacts.push(adoptedArtifact(state, { kind: "directory", path: display, integrity: sourceIntegrity, managed: false }));
      } else {
        actions.push({ verb: "create", path: display, detail: `${target} skill ${skill.name}` });
        artifacts.push({ kind: "directory", path: display, integrity: sourceIntegrity, managed: true });
        directories.push({ source, destination });
      }
    }
  }

  if (targets.includes("codex")) {
    const configPath = path.join(projectRoot, ".codex", "config.toml");
    const original = await readOptional(configPath);
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (original ? parseToml(original) : {}) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Cannot merge ${relativeDisplay(projectRoot, configPath)}: ${(error as Error).message}`);
    }
    const mcpServers = (parsed.mcp_servers ?? {}) as Record<string, unknown>;
    if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) {
      throw new Error(`Cannot merge ${relativeDisplay(projectRoot, configPath)}: mcp_servers must be a table`);
    }
    const blocks: string[] = [];
    for (const server of pkg.manifest.spec.mcpServers.filter((item) => appliesTo(item, "codex"))) {
      const value = codexValue(server);
      const { marker, block } = codexBlock(pkg.manifest.metadata.name, server);
      const display = relativeDisplay(projectRoot, configPath);
      if (mcpServers[server.name] !== undefined) {
        if (!equal(mcpServers[server.name], value)) {
          throw new Error(`Refusing to overwrite MCP server ${server.name} in ${display}`);
        }
        actions.push({ verb: "adopt", path: display, detail: `Codex MCP ${server.name} already matches` });
        artifacts.push(adoptedArtifact(state, { kind: "toml-block", path: display, marker, block, managed: false }));
      } else {
        blocks.push(block);
        actions.push({ verb: "merge", path: display, detail: `Codex MCP ${server.name}` });
        artifacts.push({ kind: "toml-block", path: display, marker, block, managed: true });
      }
    }
    if (blocks.length > 0) {
      const prefix = original && original.trimEnd() ? `${original.trimEnd()}\n\n` : "";
      files.push({ path: configPath, original, content: `${prefix}${blocks.join("\n\n")}\n` });
    }
  }

  if (targets.includes("claude")) {
    const mcpPath = path.join(projectRoot, ".mcp.json");
    const originalMcp = await readOptional(mcpPath);
    const mcpRoot = parseJsonObject(originalMcp, relativeDisplay(projectRoot, mcpPath));
    const mcpServers = getObject(mcpRoot, "mcpServers", relativeDisplay(projectRoot, mcpPath));
    let mcpChanged = false;
    for (const server of pkg.manifest.spec.mcpServers.filter((item) => appliesTo(item, "claude"))) {
      const value = claudeValue(server);
      const jsonPath = ["mcpServers", server.name];
      const display = relativeDisplay(projectRoot, mcpPath);
      if (mcpServers[server.name] !== undefined) {
        if (!equal(mcpServers[server.name], value)) {
          throw new Error(`Refusing to overwrite MCP server ${server.name} in ${display}`);
        }
        actions.push({ verb: "adopt", path: display, detail: `Claude MCP ${server.name} already matches` });
        artifacts.push(adoptedArtifact(state, { kind: "json-entry", path: display, jsonPath, value, managed: false }));
      } else {
        mcpServers[server.name] = value;
        mcpChanged = true;
        actions.push({ verb: "merge", path: display, detail: `Claude MCP ${server.name}` });
        artifacts.push({ kind: "json-entry", path: display, jsonPath, value, managed: true });
      }
    }
    if (mcpChanged) files.push({ path: mcpPath, original: originalMcp, content: `${JSON.stringify(mcpRoot, null, 2)}\n` });

    if (pkg.manifest.spec.hooks.length > 0) {
      const settingsPath = path.join(projectRoot, ".claude", "settings.json");
      const originalSettings = await readOptional(settingsPath);
      const settings = parseJsonObject(originalSettings, relativeDisplay(projectRoot, settingsPath));
      const hooks = getObject(settings, "hooks", relativeDisplay(projectRoot, settingsPath));
      let settingsChanged = false;
      for (const hook of pkg.manifest.spec.hooks) {
        const value = claudeHook(hook);
        const eventHooks = getArray(hooks, hook.event, relativeDisplay(projectRoot, settingsPath));
        const display = relativeDisplay(projectRoot, settingsPath);
        const jsonPath = ["hooks", hook.event];
        if (eventHooks.some((item) => equal(item, value))) {
          actions.push({ verb: "adopt", path: display, detail: `Claude hook ${hook.event} already matches` });
          artifacts.push(adoptedArtifact(state, { kind: "json-array-entry", path: display, jsonPath, value, managed: false }));
        } else {
          eventHooks.push(value);
          settingsChanged = true;
          actions.push({ verb: "merge", path: display, detail: `Claude hook ${hook.event}` });
          artifacts.push({ kind: "json-array-entry", path: display, jsonPath, value, managed: true });
        }
      }
      if (settingsChanged) {
        files.push({ path: settingsPath, original: originalSettings, content: `${JSON.stringify(settings, null, 2)}\n` });
      }
    }
  }

  return { actions, artifacts, files, directories };
}

export async function activatePackage(
  pkg: InstalledPackage,
  projectRoot: string,
  requestedTargets: Platform[],
  dryRun = false,
): Promise<Action[]> {
  const project = path.resolve(projectRoot);
  const state = await readState(project);
  const name = pkg.manifest.metadata.name;
  if (state.activations[name]) throw new Error(`${name} is already active; deactivate it before installing a new version`);

  const targets = [...new Set(requestedTargets)];
  if (targets.length === 0) throw new Error("Select at least one target");
  for (const target of targets) {
    if (!pkg.manifest.spec.platforms.includes(target)) throw new Error(`${name} does not support ${target}`);
  }

  const prepared = await prepareActivation(pkg, project, targets, state);
  if (dryRun) return prepared.actions;

  const createdDirectories: string[] = [];
  const writtenFiles: PreparedFile[] = [];
  try {
    for (const directory of prepared.directories) {
      await mkdir(path.dirname(directory.destination), { recursive: true });
      const temp = `${directory.destination}.harness-tmp-${process.pid}`;
      await rm(temp, { recursive: true, force: true });
      await cp(directory.source, temp, { recursive: true, errorOnExist: true });
      await rename(temp, directory.destination);
      createdDirectories.push(directory.destination);
    }
    for (const file of prepared.files) {
      if ((await readOptional(file.path)) !== file.original) {
        throw new Error(`${relativeDisplay(project, file.path)} changed while activation was in progress; retry`);
      }
      await writeTextAtomic(file.path, file.content);
      writtenFiles.push(file);
    }

    const record: ActivationRecord = {
      packageName: name,
      packageVersion: pkg.manifest.metadata.version,
      activatedAt: new Date().toISOString(),
      targets,
      artifacts: prepared.artifacts,
    };
    await putActivation(project, record);
    return prepared.actions;
  } catch (error) {
    for (const directory of createdDirectories.reverse()) await rm(directory, { recursive: true, force: true });
    for (const file of writtenFiles.reverse()) {
      if (file.original === null) await rm(file.path, { force: true });
      else await writeTextAtomic(file.path, file.original);
    }
    throw error;
  }
}

function markerPattern(marker: string): RegExp {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)# >>> harness-conda:${escaped}\\n[\\s\\S]*?\\n# <<< harness-conda:${escaped}(?=\\n|$)`, "m");
}

export async function deactivatePackage(packageName: string, projectRoot: string, dryRun = false): Promise<Action[]> {
  const project = path.resolve(projectRoot);
  const state = await readState(project);
  const activation = state.activations[packageName];
  if (!activation) throw new Error(`${packageName} is not active`);
  const actions: Action[] = [];
  const jsonFiles = new Map<string, { absolute: string; root: Record<string, unknown>; changed: boolean }>();
  const textFiles = new Map<string, { absolute: string; content: string; changed: boolean }>();
  const directories: string[] = [];

  for (const artifact of [...activation.artifacts].reverse()) {
    if (!artifact.managed) continue;
    const otherOwner = Object.entries(state.activations).find(
      ([name, record]) =>
        name !== packageName && record.artifacts.some((candidate) => candidate.managed && samePhysicalArtifact(candidate, artifact)),
    );
    if (otherOwner) {
      actions.push({ verb: "keep", path: artifact.path, detail: `still required by ${otherOwner[0]}` });
      continue;
    }
    const absolute = path.join(project, artifact.path);
    if (artifact.kind === "directory") {
      if (!(await pathExists(absolute))) {
        actions.push({ verb: "keep", path: artifact.path, detail: "already absent" });
      } else if ((await hashDirectory(absolute)) !== artifact.integrity) {
        actions.push({ verb: "keep", path: artifact.path, detail: "modified since activation" });
      } else {
        actions.push({ verb: "remove", path: artifact.path, detail: "managed skill" });
        directories.push(absolute);
      }
      continue;
    }
    if (artifact.kind === "toml-block") {
      const existing = textFiles.get(artifact.path);
      const content = existing?.content ?? (await readOptional(absolute)) ?? "";
      const pattern = markerPattern(artifact.marker);
      const match = content.match(pattern);
      const currentBlock = match?.[0].replace(/^\n/, "");
      if (!match || currentBlock !== artifact.block) {
        actions.push({ verb: "keep", path: artifact.path, detail: `managed block ${artifact.marker} changed or absent` });
        if (!existing) textFiles.set(artifact.path, { absolute, content, changed: false });
      } else {
        const updated = content.replace(pattern, "").replace(/^\n+|\n+$/g, "");
        textFiles.set(artifact.path, { absolute, content: updated ? `${updated}\n` : "", changed: true });
        actions.push({ verb: "remove", path: artifact.path, detail: `Codex MCP ${artifact.marker.split(":").at(-1)}` });
      }
      continue;
    }

    let jsonFile = jsonFiles.get(artifact.path);
    if (!jsonFile) {
      const original = await readOptional(absolute);
      jsonFile = { absolute, root: parseJsonObject(original, artifact.path), changed: false };
      jsonFiles.set(artifact.path, jsonFile);
    }
    if (artifact.kind === "json-entry") {
      const current = getAtPath(jsonFile.root, artifact.jsonPath);
      if (!equal(current, artifact.value)) {
        actions.push({ verb: "keep", path: artifact.path, detail: `${artifact.jsonPath.join(".")} changed since activation` });
      } else {
        deleteAtPath(jsonFile.root, artifact.jsonPath);
        jsonFile.changed = true;
        actions.push({ verb: "remove", path: artifact.path, detail: artifact.jsonPath.join(".") });
      }
    } else {
      const current = getAtPath(jsonFile.root, artifact.jsonPath);
      if (!Array.isArray(current)) {
        actions.push({ verb: "keep", path: artifact.path, detail: `${artifact.jsonPath.join(".")} changed since activation` });
      } else {
        const index = current.findIndex((item) => equal(item, artifact.value));
        if (index === -1) {
          actions.push({ verb: "keep", path: artifact.path, detail: `${artifact.jsonPath.join(".")} entry changed or absent` });
        } else {
          current.splice(index, 1);
          if (current.length === 0) deleteAtPath(jsonFile.root, artifact.jsonPath);
          jsonFile.changed = true;
          actions.push({ verb: "remove", path: artifact.path, detail: artifact.jsonPath.join(".") });
        }
      }
    }
  }

  if (dryRun) return actions;
  for (const directory of directories) {
    await rm(directory, { recursive: true, force: true });
    await removeEmptyParents(path.dirname(directory), project);
  }
  for (const file of textFiles.values()) {
    if (file.changed) await writeTextAtomic(file.absolute, file.content);
  }
  for (const file of jsonFiles.values()) {
    if (file.changed) await writeJsonAtomic(file.absolute, file.root);
  }
  await deleteActivation(project, packageName);
  return actions;
}

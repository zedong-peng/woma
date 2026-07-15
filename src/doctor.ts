import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { hashDirectory, pathExists } from "./fs.js";
import { projectConfigPath, readProjectConfig } from "./project.js";
import { readLock, readState } from "./store.js";
import type { InstalledPackage } from "./types.js";

export interface Check {
  status: "ok" | "warn" | "fail";
  label: string;
  detail: string;
}

async function findCommand(command: string): Promise<string | undefined> {
  if (command.includes(path.sep)) {
    return access(command, constants.X_OK).then(
      () => command,
      () => undefined,
    );
  }
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = path.join(directory, command);
    if (
      await access(candidate, constants.X_OK).then(
        () => true,
        () => false,
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

export async function doctorPackage(
  pkg: InstalledPackage,
  projectRoot: string,
  options: { activationExpected?: boolean } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  checks.push({ status: "ok", label: "manifest", detail: `${pkg.manifest.metadata.name}@${pkg.manifest.metadata.version}` });
  checks.push({ status: "ok", label: "integrity", detail: pkg.lock.integrity });

  const commands = new Set(pkg.manifest.spec.requirements.commands);
  for (const server of pkg.manifest.spec.mcpServers) {
    if (server.transport === "stdio") commands.add(server.command);
  }
  for (const command of commands) {
    const found = await findCommand(command);
    checks.push({
      status: found ? "ok" : "fail",
      label: `command:${command}`,
      detail: found ?? "not found on PATH",
    });
  }

  for (const requirement of pkg.manifest.spec.requirements.env) {
    const present = Boolean(process.env[requirement.name]);
    checks.push({
      status: present ? "ok" : requirement.optional ? "warn" : "fail",
      label: `env:${requirement.name}`,
      detail: present ? "set" : requirement.optional ? "optional and not set" : requirement.description ?? "required and not set",
    });
  }

  const [state, projectConfig] = await Promise.all([
    readState(projectRoot),
    pathExists(projectConfigPath(projectRoot)).then((exists) => (exists ? readProjectConfig(projectRoot) : undefined)),
  ]);
  const activation = state.activations[pkg.manifest.metadata.name];
  for (const requirement of pkg.manifest.spec.requirements.bindings) {
    const command = projectConfig?.spec.bindings[requirement.name];
    const requiredNow = Boolean(activation) || options.activationExpected === true;
    checks.push({
      status: command ? "ok" : requirement.optional || !requiredNow ? "warn" : "fail",
      label: `binding:${requirement.name}`,
      detail: command ?? requirement.description ?? "required project binding is not configured",
    });
  }
  if (!activation) {
    checks.push({
      status: options.activationExpected === false ? "ok" : "warn",
      label: "activation",
      detail: options.activationExpected === false ? "installed for an inactive profile" : "installed but not active in this project",
    });
    return checks;
  }

  const identityMatches =
    activation.packageVersion === pkg.lock.version &&
    activation.packageIntegrity === pkg.lock.integrity &&
    activation.packageCacheKey === pkg.lock.cacheKey;
  checks.push({
    status: identityMatches ? "ok" : "fail",
    label: "activation-identity",
    detail: identityMatches
      ? `${pkg.lock.version} ${pkg.lock.cacheKey}`
      : `active ${activation.packageVersion}/${activation.packageCacheKey ?? "legacy"} does not match lock ${pkg.lock.version}/${pkg.lock.cacheKey}`,
  });

  checks.push({ status: "ok", label: "activation", detail: activation.targets.join(", ") });
  for (const artifact of activation.artifacts) {
    if (!artifact.managed || artifact.kind !== "directory") continue;
    const absolute = path.join(projectRoot, artifact.path);
    if (!(await pathExists(absolute))) {
      checks.push({ status: "fail", label: artifact.path, detail: "managed skill is missing" });
    } else if ((await hashDirectory(absolute)) !== artifact.integrity) {
      checks.push({ status: "warn", label: artifact.path, detail: "managed skill was modified after activation" });
    } else {
      checks.push({ status: "ok", label: artifact.path, detail: "managed skill matches lock" });
    }
  }
  return checks;
}

export async function doctorProject(projectRoot: string): Promise<Check[]> {
  const checks: Check[] = [];
  if (!(await pathExists(projectConfigPath(projectRoot)))) {
    return [{ status: "warn", label: "project", detail: "no .harness/project.yaml; package mode only" }];
  }
  const [config, lock, state] = await Promise.all([readProjectConfig(projectRoot), readLock(projectRoot), readState(projectRoot)]);
  checks.push({ status: "ok", label: "project", detail: config.metadata.name });

  const referenced = new Set(config.spec.base);
  for (const [name, profile] of Object.entries(config.spec.profiles)) {
    profile.packages.forEach((packageName) => referenced.add(packageName));
    checks.push({
      status: profile.packages.length > 0 || config.spec.base.length > 0 ? "ok" : "warn",
      label: `profile:${name}`,
      detail: [...config.spec.base, ...profile.packages].join(", ") || "no packages configured",
    });
  }
  for (const packageName of referenced) {
    checks.push({
      status: lock.packages[packageName] ? "ok" : "fail",
      label: `locked:${packageName}`,
      detail: lock.packages[packageName] ? lock.packages[packageName]!.version : "referenced by a profile but missing from lock",
    });
  }
  for (const [name, command] of Object.entries(config.spec.bindings)) {
    checks.push({ status: "ok", label: `binding:${name}`, detail: command });
  }

  const active = state.profile;
  if (!active) {
    checks.push({ status: "warn", label: "active-profile", detail: "none" });
    if (Object.keys(state.activations).length > 0) {
      checks.push({ status: "warn", label: "package-mode", detail: `${Object.keys(state.activations).join(", ")} active outside profiles` });
    }
    return checks;
  }
  const configured = config.spec.profiles[active.name];
  if (!configured) {
    checks.push({ status: "fail", label: "active-profile", detail: `${active.name} no longer exists in project config` });
  } else {
    const expected = [...new Set([...config.spec.base, ...configured.packages])];
    checks.push({
      status: JSON.stringify(expected) === JSON.stringify(active.packages) ? "ok" : "fail",
      label: "active-profile",
      detail: `${active.name}: ${active.packages.join(", ") || "no packages"}`,
    });
  }
  for (const packageName of active.packages) {
    const activation = state.activations[packageName];
    const locked = lock.packages[packageName];
    const identityMatches =
      activation !== undefined &&
      locked !== undefined &&
      activation.packageVersion === locked.version &&
      activation.packageIntegrity === locked.integrity &&
      activation.packageCacheKey === locked.cacheKey;
    checks.push({
      status: identityMatches ? "ok" : "fail",
      label: `active:${packageName}`,
      detail: !activation
        ? "activation record missing"
        : !locked
          ? "lock entry missing"
          : identityMatches
            ? activation.targets.join(", ")
            : `activation ${activation.packageVersion}/${activation.packageCacheKey ?? "legacy"} does not match lock ${locked.version}/${locked.cacheKey}`,
    });
  }
  for (const packageName of Object.keys(state.activations)) {
    if (!active.packages.includes(packageName)) {
      checks.push({ status: "fail", label: `foreign:${packageName}`, detail: "active outside the selected profile" });
    }
  }
  for (const instruction of active.instructions) {
    const absolute = path.join(projectRoot, instruction.path);
    const content = await readFile(absolute, "utf8").catch(() => "");
    checks.push({
      status: content.includes(instruction.block) ? "ok" : "fail",
      label: instruction.path,
      detail: content.includes(instruction.block) ? `routes to ${active.name}` : "active-profile routing block missing or modified",
    });
  }
  if (active.handoff) {
    checks.push({
      status: (await pathExists(path.join(projectRoot, active.handoff))) ? "ok" : "fail",
      label: "handoff",
      detail: active.handoff,
    });
  }
  return checks;
}

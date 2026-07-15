import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { hashDirectory, pathExists } from "./fs.js";
import { readState } from "./store.js";
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

export async function doctorPackage(pkg: InstalledPackage, projectRoot: string): Promise<Check[]> {
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

  const state = await readState(projectRoot);
  const activation = state.activations[pkg.manifest.metadata.name];
  if (!activation) {
    checks.push({ status: "warn", label: "activation", detail: "installed but not active in this project" });
    return checks;
  }

  const activationMatches =
    activation.packageName === pkg.lock.name &&
    activation.packageVersion === pkg.lock.version &&
    pkg.manifest.metadata.name === pkg.lock.name &&
    pkg.manifest.metadata.version === pkg.lock.version;
  checks.push({
    status: activationMatches ? "ok" : "fail",
    label: "activation",
    detail: activationMatches
      ? `${activation.packageVersion} on ${activation.targets.join(", ")}`
      : `active ${activation.packageName}@${activation.packageVersion}, locked ${pkg.lock.name}@${pkg.lock.version}`,
  });
  for (const artifact of activation.artifacts) {
    if (!artifact.managed || artifact.kind !== "directory") continue;
    const absolute = path.join(projectRoot, artifact.path);
    if (!(await pathExists(absolute))) {
      checks.push({ status: "fail", label: artifact.path, detail: "managed skill is missing" });
    } else if ((await hashDirectory(absolute)) !== artifact.integrity) {
      checks.push({ status: "warn", label: artifact.path, detail: "managed skill was modified after activation" });
    } else {
      checks.push({ status: "ok", label: artifact.path, detail: "managed skill matches activation state" });
    }
  }
  return checks;
}

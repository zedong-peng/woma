import { rm } from "node:fs/promises";
import path from "node:path";
import { detectProject, type ProjectDetection } from "./detect.js";
import { pathExists } from "./fs.js";
import { installPackageSource } from "./package.js";
import { switchProfile, type ProfileSwitchResult } from "./profile.js";
import { addPackageToProject, initProject, projectConfigPath, setBinding } from "./project.js";
import { lockPath, putLock, statePath } from "./store.js";
import type { Platform } from "./types.js";

export interface OnboardResult {
  detection: ProjectDetection;
  packages: string[];
  active?: ProfileSwitchResult;
}

export async function onboardProject(
  projectRoot: string,
  options: {
    name?: string;
    agent?: Platform;
    targets?: Platform[];
    switchToResearch?: boolean;
  } = {},
): Promise<OnboardResult> {
  const project = path.resolve(projectRoot);
  const ownedFiles = [projectConfigPath(project), lockPath(project), statePath(project)];
  for (const filePath of ownedFiles) {
    if (await pathExists(filePath)) throw new Error(`Onboarding requires a fresh Harness project; found ${filePath}`);
  }

  const detection = await detectProject(project, options.targets);
  const targets = options.targets ?? detection.targets;
  const agent = options.agent ?? detection.agent;
  if (!targets.includes(agent)) throw new Error(`Default agent ${agent} must be included in project targets`);

  const packageSources = [
    "builtin:reproducibility-core",
    "builtin:research-workflow",
    "builtin:experiment-workflow",
    "builtin:performance-engineering",
  ];
  const packages = [];
  for (const source of packageSources) packages.push(await installPackageSource(source));

  try {
    await initProject(project, {
      ...(options.name ? { name: options.name } : {}),
      agent,
      targets,
    });
    for (const pkg of packages) await putLock(project, pkg.lock);
    await addPackageToProject(project, "reproducibility-core", { base: true });
    await addPackageToProject(project, "research-workflow", { profile: "research" });
    await addPackageToProject(project, "experiment-workflow", { profile: "experiment" });
    await addPackageToProject(project, "performance-engineering", { profile: "performance" });
    for (const [name, command] of Object.entries(detection.bindings)) await setBinding(project, name, command);
    const active = options.switchToResearch === false ? undefined : await switchProfile(project, "research");
    return {
      detection: { ...detection, targets, agent },
      packages: packages.map((pkg) => pkg.manifest.metadata.name),
      ...(active ? { active } : {}),
    };
  } catch (error) {
    for (const filePath of ownedFiles.reverse()) await rm(filePath, { force: true });
    throw error;
  }
}

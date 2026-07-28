import { mkdir, readFile, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pathExists, writeTextAtomic } from "./fs.js";

const packageName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");

export const PROJECT_MEMORY_PACKAGE = "woma-project-memory";

const projectMemoryTemplate = `# Project Memory

Record stable, project-wide knowledge that helps Agents work in this repository, such as build and test conventions, repository constraints, and verification expectations.

Keep this file human-readable and reviewable. Verify instructions against the repository before acting. When the user states a durable project-wide fact, update this file even if they do not explicitly ask you to remember it. Do not store credentials, transient task progress, handoffs, outcomes, temporary statements, or unverified guesses here.
`;

export function projectMemoryRoot(projectRoot: string): string {
  return path.join(projectRoot, ".woma", "memory");
}

export function projectMemoryPath(projectRoot: string): string {
  return path.join(projectMemoryRoot(projectRoot), "project.md");
}

export function packageMemoryRoot(projectRoot: string): string {
  return path.join(projectMemoryRoot(projectRoot), "packages");
}

export function packageMemoryPath(projectRoot: string, name: string): string {
  packageName.parse(name);
  return path.join(packageMemoryRoot(projectRoot), `${name}.md`);
}

export function localMemoryPath(projectRoot: string): string {
  return path.join(projectRoot, ".woma", "local", "memory.md");
}

export async function initializeProjectMemory(projectRoot: string): Promise<void> {
  await (await prepareProjectMemoryInitialization(projectRoot)).apply();
}

export interface PreparedProjectMemoryInitialization {
  apply: () => Promise<() => Promise<void>>;
}

export async function prepareProjectMemoryInitialization(projectRoot: string): Promise<PreparedProjectMemoryInitialization> {
  const womaRoot = path.join(projectRoot, ".woma");
  const memoryRoot = projectMemoryRoot(projectRoot);
  const packagesRoot = packageMemoryRoot(projectRoot);
  const shared = projectMemoryPath(projectRoot);
  const existed = {
    woma: await pathExists(womaRoot),
    memory: await pathExists(memoryRoot),
    packages: await pathExists(packagesRoot),
    shared: await pathExists(shared),
  };
  return {
    apply: async () => {
      let createdShared = false;
      const restore = async (): Promise<void> => {
        if (createdShared) await rm(shared, { force: true });
        for (const [directory, wasPresent] of [
          [packagesRoot, existed.packages],
          [memoryRoot, existed.memory],
          [womaRoot, existed.woma],
        ] as const) {
          if (!wasPresent) {
            await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error;
            });
          }
        }
      };
      try {
        await mkdir(packagesRoot, { recursive: true });
        if (!existed.shared && !(await pathExists(shared))) {
          await writeTextAtomic(shared, projectMemoryTemplate);
          createdShared = true;
        }
        return restore;
      } catch (error) {
        await restore();
        throw error;
      }
    },
  };
}

export async function readProjectMemory(projectRoot: string): Promise<string> {
  return readFile(projectMemoryPath(projectRoot), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

export async function readPackageMemory(projectRoot: string, name: string): Promise<string> {
  return readFile(packageMemoryPath(projectRoot, name), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
}

import path from "node:path";
import { z } from "zod";

const packageName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "must use lowercase letters, digits, '.', '_' or '-'");

export function projectMemoryRoot(projectRoot: string): string {
  return path.join(projectRoot, ".harness", "memory");
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
  return path.join(projectRoot, ".harness", "local", "memory.md");
}

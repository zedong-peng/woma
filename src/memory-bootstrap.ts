import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "./fs.js";
import type { Action, Platform } from "./types.js";

const markerStart = "<!-- >>> harness-conda:project-memory -->";
const markerEnd = "<!-- <<< harness-conda:project-memory -->";

export interface MemoryBootstrapEnvironment {
  targets: Platform[];
  hasMemoryPackage: boolean;
}

interface PreparedFile {
  path: string;
  display: string;
  original: string | null;
  desired: string | null;
  detail: string;
}

export interface PreparedMemoryBootstrapTransition {
  actions: Action[];
  apply: () => Promise<() => Promise<void>>;
}

function discoveryBlock(_platform: Platform): string {
  return `${markerStart}
## Harness Project Memory

At the beginning of the session, use the installed \`harness-project-memory\` Skill. Use that Skill before other Harness-installed Skills and whenever the user provides durable project-specific knowledge.
${markerEnd}`;
}

function instructionPath(projectRoot: string, platform: Platform): string {
  return path.join(projectRoot, platform === "codex" ? "AGENTS.md" : "CLAUDE.md");
}

async function readOptional(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

function occurrenceCount(content: string, value: string): number {
  return content.split(value).length - 1;
}

function reconcileBlock(
  original: string | null,
  platform: Platform,
  include: boolean,
  required: boolean,
  display: string,
): string | null {
  const content = original ?? "";
  const block = discoveryBlock(platform);
  const starts = occurrenceCount(content, markerStart);
  const ends = occurrenceCount(content, markerEnd);
  if (starts > 1 || ends > 1 || starts !== ends) {
    throw new Error(`${display} contains an invalid Harness Project Memory discovery block`);
  }
  const blockAt = content.indexOf(block);
  if (starts === 1 && blockAt === -1) {
    throw new Error(`${display} Harness Project Memory discovery block was modified; restore it before changing environments`);
  }
  if (starts === 0) {
    if (required) throw new Error(`${display} Harness Project Memory discovery block is missing; restore it before changing environments`);
    if (!include) return original;
    if (!content) return `${block}\n`;
    const prefix = content.endsWith("\n") ? content : `${content}\n`;
    return `${prefix}\n${block}\n`;
  }
  if (include) return original;

  let before = content.slice(0, blockAt);
  let after = content.slice(blockAt + block.length);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  if (after.startsWith("\n")) after = after.slice(1);
  const result = `${before}${after}`;
  return result || null;
}

function actionFor(file: PreparedFile): Action | undefined {
  if (file.original === file.desired) return undefined;
  if (file.desired === null) return { verb: "remove", path: file.display, detail: file.detail };
  return { verb: file.original === null ? "create" : "merge", path: file.display, detail: file.detail };
}

export async function prepareMemoryBootstrapTransition(
  projectRoot: string,
  previous: MemoryBootstrapEnvironment | undefined,
  desired: MemoryBootstrapEnvironment | undefined,
  options: { requirePrevious?: boolean } = {},
): Promise<PreparedMemoryBootstrapTransition> {
  const project = path.resolve(projectRoot);
  const files: PreparedFile[] = [];
  for (const platform of ["codex", "claude"] as const) {
    const filePath = instructionPath(project, platform);
    const original = await readOptional(filePath);
    const previousIncluded = previous?.hasMemoryPackage === true && previous.targets.includes(platform);
    const desiredIncluded = desired?.hasMemoryPackage === true && desired.targets.includes(platform);
    files.push({
      path: filePath,
      display: path.basename(filePath),
      original,
      desired: reconcileBlock(
        original,
        platform,
        desiredIncluded,
        options.requirePrevious === true && previousIncluded,
        path.basename(filePath),
      ),
      detail: `${platform} Project Memory discovery`,
    });
  }

  const changed = files.filter((file) => file.original !== file.desired);
  return {
    actions: files.map(actionFor).filter((action): action is Action => action !== undefined),
    apply: async () => {
      const written: PreparedFile[] = [];
      const restore = async (): Promise<void> => {
        const errors: unknown[] = [];
        for (const file of [...written].reverse()) {
          try {
            if (file.original === null) await rm(file.path, { force: true });
            else await writeTextAtomic(file.path, file.original);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Could not restore Project Memory discovery files");
      };

      try {
        for (const file of changed) {
          if ((await readOptional(file.path)) !== file.original) {
            throw new Error(`${file.display} changed while the Environment transition was in progress; retry`);
          }
          if (file.desired === null) await rm(file.path, { force: true });
          else await writeTextAtomic(file.path, file.desired);
          written.push(file);
        }
      } catch (error) {
        try {
          await restore();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Project Memory discovery failed and rollback could not restore the project");
        }
        throw error;
      }
      return restore;
    },
  };
}

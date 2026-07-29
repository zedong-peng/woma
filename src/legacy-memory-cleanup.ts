import { lstat, readFile, readlink, rm, stat } from "node:fs/promises";
import path from "node:path";
import { writeBufferPreservingFile, writeTextPreservingFile } from "./fs.js";
import type { Action } from "./types.js";

interface ManagedBlock {
  markerStart: string;
  markerEnd: string;
  content: string;
  name: string;
}

const managedBlocks: ManagedBlock[] = [
  {
    markerStart: "<!-- >>> woma:project-memory -->",
    markerEnd: "<!-- <<< woma:project-memory -->",
    name: "Woma Project Memory",
    content: `<!-- >>> woma:project-memory -->
## Woma Project Memory

At the beginning of the session, use the installed \`woma-project-memory\` Skill. Use that Skill before other Woma-installed Skills and whenever the user provides durable project-specific knowledge.
<!-- <<< woma:project-memory -->`,
  },
];

interface PreparedFile {
  path: string;
  display: string;
  original: FileSnapshot;
  desired: string | null;
}

interface FileSnapshot {
  content: string | null;
  kind: "missing" | "file" | "symlink";
  mode?: number;
  linkTarget?: string;
}

export interface PreparedLegacyMemoryCleanup {
  actions: Action[];
  apply: () => Promise<() => Promise<void>>;
}

async function snapshotFile(filePath: string): Promise<FileSnapshot> {
  const info = await lstat(filePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!info) return { content: null, kind: "missing" };
  if (!info.isSymbolicLink()) return { content: await readFile(filePath, "utf8"), kind: "file", mode: info.mode };

  const linkTarget = await readlink(filePath);
  const content = await readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new Error(`${path.basename(filePath)} is a dangling symbolic link`);
    throw error;
  });
  return { content, kind: "symlink", mode: (await stat(filePath)).mode, linkTarget };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.content === right.content &&
    left.kind === right.kind &&
    left.mode === right.mode &&
    left.linkTarget === right.linkTarget;
}

function occurrenceCount(content: string, value: string): number {
  return content.split(value).length - 1;
}

function removeManagedBlock(original: string | null, block: ManagedBlock, display: string): string | null {
  const content = original ?? "";
  const starts = occurrenceCount(content, block.markerStart);
  const ends = occurrenceCount(content, block.markerEnd);
  if (starts > 1 || ends > 1 || starts !== ends) {
    throw new Error(`${display} contains an invalid legacy ${block.name} discovery block`);
  }
  const blockAt = content.indexOf(block.content);
  if (starts === 1 && blockAt === -1) {
    throw new Error(`${display} legacy ${block.name} discovery block was modified; restore or remove it before continuing`);
  }
  if (starts === 0) return original;

  let before = content.slice(0, blockAt);
  let after = content.slice(blockAt + block.content.length);
  if (before.endsWith("\n\n")) before = before.slice(0, -1);
  if (after.startsWith("\n")) after = after.slice(1);
  const desired = `${before}${after}`;
  return desired.trim() ? desired : null;
}

function removeManagedBlocks(original: string | null, display: string): string | null {
  return managedBlocks.reduce<string | null>(
    (content, block) => removeManagedBlock(content, block, display),
    original,
  );
}

function actionFor(file: PreparedFile): Action | undefined {
  if (file.original.content === file.desired) return undefined;
  if (file.desired === null) return { verb: "remove", path: file.display, detail: "legacy Project Memory discovery" };
  return { verb: "merge", path: file.display, detail: "legacy Project Memory discovery" };
}

export async function prepareLegacyMemoryCleanup(projectRoot: string): Promise<PreparedLegacyMemoryCleanup> {
  const project = path.resolve(projectRoot);
  const files: PreparedFile[] = [];
  for (const display of ["AGENTS.md", "CLAUDE.md"]) {
    const filePath = path.join(project, display);
    const original = await snapshotFile(filePath);
    const cleaned = removeManagedBlocks(original.content, display);
    files.push({
      path: filePath,
      display,
      original,
      desired: cleaned === null && original.kind === "symlink" ? "" : cleaned,
    });
  }

  const changed = files.filter((file) => file.original.content !== file.desired);
  return {
    actions: files.map(actionFor).filter((action): action is Action => action !== undefined),
    apply: async () => {
      const written: PreparedFile[] = [];
      const restore = async (): Promise<void> => {
        const errors: unknown[] = [];
        for (const file of [...written].reverse()) {
          try {
            if (file.original.content === null) await rm(file.path, { force: true });
            else if (file.desired === null) {
              await writeBufferPreservingFile(file.path, Buffer.from(file.original.content, "utf8"), file.original.mode);
            } else {
              await writeTextPreservingFile(file.path, file.original.content);
            }
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Could not restore legacy Project Memory discovery files");
      };

      try {
        for (const file of changed) {
          if (!sameSnapshot(await snapshotFile(file.path), file.original)) {
            throw new Error(`${file.display} changed while legacy Project Memory cleanup was in progress; retry`);
          }
          if (file.desired === null) await rm(file.path, { force: true });
          else await writeTextPreservingFile(file.path, file.desired);
          written.push(file);
        }
      } catch (error) {
        try {
          await restore();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Legacy Project Memory cleanup failed and rollback was incomplete");
        }
        throw error;
      }
      return restore;
    },
  };
}

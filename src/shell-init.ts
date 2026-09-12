import { lstat, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { womaHome, writeTextPreservingFile } from "./fs.js";
import { renderShellHook, shellQuote, type SupportedShell } from "./shell.js";
import type { Action } from "./types.js";

const markerStart = "# >>> woma initialize >>>";
const markerEnd = "# <<< woma initialize <<<";

export interface ShellInitializationOptions {
  dryRun?: boolean;
  environment?: NodeJS.ProcessEnv;
  womaHome?: string;
  platform?: NodeJS.Platform;
  profilePath?: string;
  reverse?: boolean;
  userHome?: string;
}

export interface ShellInitializationResult {
  actions: Action[];
  hookPath: string;
  profilePath: string;
  shell: SupportedShell;
}

async function readOptional(filePath: string): Promise<string | null> {
  return readFile(filePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return lstat(filePath).then(
      (info) => {
        if (info.isSymbolicLink()) throw new Error(`${filePath} is a dangling symbolic link`);
        return null;
      },
      (statError: NodeJS.ErrnoException) => {
        if (statError.code === "ENOENT") return null;
        throw statError;
      },
    );
  });
}

function initializationBlock(hookPath: string): string {
  const quotedHook = shellQuote(hookPath);
  return `${markerStart}
# !! Contents within this block are managed by 'woma init' !!
if [ -f ${quotedHook} ]; then
  . ${quotedHook}
else
  printf 'woma: shell integration is unavailable; run woma init\\n' >&2
fi
${markerEnd}`;
}

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

function managedRange(content: string): { start: number; end: number } | undefined {
  const starts = markerCount(content, markerStart);
  const ends = markerCount(content, markerEnd);
  if (starts === 0 && ends === 0) return undefined;
  if (starts !== 1 || ends !== 1) throw new Error("Shell profile contains an invalid Woma initialization block");
  const start = content.indexOf(markerStart);
  const markerEndIndex = content.indexOf(markerEnd);
  if (markerEndIndex < start) throw new Error("Shell profile contains an invalid Woma initialization block");
  const lineEnd = content.indexOf("\n", markerEndIndex + markerEnd.length);
  return { start, end: lineEnd === -1 ? content.length : lineEnd + 1 };
}

function withoutManagedBlock(content: string, range: { start: number; end: number }): string {
  let start = range.start;
  if (start > 0 && content[start - 1] === "\n") start -= 1;
  return `${content.slice(0, start)}${content.slice(range.end)}`;
}

function reconcileProfile(original: string | null, hookPath: string, reverse: boolean): string | null {
  const rawContent = original ?? "";
  const range = managedRange(rawContent);
  if (reverse) {
    if (!range) return original;
    return withoutManagedBlock(rawContent, range);
  }
  const block = initializationBlock(hookPath);
  if (!range) {
    const content = rawContent;
    if (!content) return `${block}\n`;
    return `${content}${content.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
  }
  return `${rawContent.slice(0, range.start)}${block}\n${rawContent.slice(range.end)}`;
}

export function shellProfilePath(
  shell: SupportedShell,
  options: Pick<ShellInitializationOptions, "environment" | "platform" | "userHome"> = {},
): string {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const userHome = path.resolve(options.userHome ?? environment.HOME ?? os.homedir());
  if (shell === "zsh") return path.join(path.resolve(environment.ZDOTDIR ?? userHome), ".zshrc");
  return path.join(userHome, platform === "darwin" ? ".bash_profile" : ".bashrc");
}

function action(original: string | null, desired: string | null, filePath: string, detail: string): Action | undefined {
  if (original === desired) return undefined;
  if (desired === null) return { verb: "remove", path: filePath, detail };
  return { verb: original === null ? "create" : "merge", path: filePath, detail };
}

async function writeOptional(filePath: string, content: string | null): Promise<void> {
  if (content === null) await rm(filePath, { force: true });
  else await writeTextPreservingFile(filePath, content);
}

export async function initializeShell(
  shell: SupportedShell,
  options: ShellInitializationOptions = {},
): Promise<ShellInitializationResult> {
  const stateHome = path.resolve(options.womaHome ?? womaHome());
  const hookPath = path.join(stateHome, "shell", `woma.${shell}`);
  const profilePath = path.resolve(options.profilePath ?? shellProfilePath(shell, options));
  const [originalHook, originalProfile] = await Promise.all([readOptional(hookPath), readOptional(profilePath)]);
  const reverse = options.reverse === true;
  const desiredHook = reverse ? null : renderShellHook(shell);
  const desiredProfile = reconcileProfile(originalProfile, hookPath, reverse);
  const actions = [
    action(originalHook, desiredHook, hookPath, `${shell} static shell hook`),
    action(originalProfile, desiredProfile, profilePath, `${shell} shell initialization`),
  ].filter((entry): entry is Action => entry !== undefined);

  if (options.dryRun === true || actions.length === 0) return { actions, hookPath, profilePath, shell };

  let hookWritten = false;
  let profileWritten = false;
  try {
    if (originalHook !== desiredHook) {
      await writeOptional(hookPath, desiredHook);
      hookWritten = true;
    }
    if (originalProfile !== desiredProfile) {
      await writeOptional(profilePath, desiredProfile);
      profileWritten = true;
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (profileWritten) await writeOptional(profilePath, originalProfile).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (hookWritten) await writeOptional(hookPath, originalHook).catch((rollbackError) => rollbackErrors.push(rollbackError));
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Shell initialization failed and rollback was incomplete");
    }
    throw error;
  }

  return { actions, hookPath, profilePath, shell };
}

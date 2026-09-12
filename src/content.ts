import { randomUUID } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { withPackageLock } from "./environment-lock.js";
import { EXCLUDED_PACKAGE_PATH_NAMES, hashDirectory, pathExists, womaHome } from "./fs.js";

export function cachePath(integrity: string): string {
  if (!/^sha256-[a-f0-9]{64}$/.test(integrity)) throw new Error(`Invalid content integrity: ${integrity}`);
  return path.join(womaHome(), "store", "v2", integrity.slice(7));
}

export async function validateTree(root: string, readonly = false): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Unsupported package file (links and special files are not supported): ${root}`);
  if (readonly && (info.mode & 0o222) !== 0) throw new Error(`Cached package is writable: ${root}`);
  if (info.isDirectory()) {
    for (const name of await readdir(root)) {
      if (!EXCLUDED_PACKAGE_PATH_NAMES.has(name)) await validateTree(path.join(root, name), readonly);
    }
  }
}

export async function setTreeWritable(root: string, writable: boolean): Promise<void> {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    if (writable) await chmod(root, (info.mode & 0o777) | 0o700);
    for (const name of await readdir(root)) await setTreeWritable(path.join(root, name), writable);
    if (!writable) await chmod(root, info.mode & 0o555);
  } else if (info.isFile()) {
    await chmod(root, writable ? (info.mode & 0o777) | 0o600 : info.mode & 0o555);
  }
}

export async function removeTree(root: string): Promise<void> {
  if (!(await pathExists(root))) return;
  await setTreeWritable(root, true);
  await rm(root, { recursive: true, force: true });
}

export async function copyContent(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true,
    filter: (candidate) => candidate === source || !EXCLUDED_PACKAGE_PATH_NAMES.has(path.basename(candidate)),
  });
}

export async function verifyContent(root: string, integrity: string, readonly = false): Promise<void> {
  await validateTree(root, readonly);
  const actual = await hashDirectory(root);
  if (actual !== integrity) throw new Error(`Integrity mismatch at ${root}: expected ${integrity}, got ${actual}`);
}

export async function publishContent(source: string, expected?: string): Promise<{ root: string; integrity: string }> {
  await validateTree(source);
  const integrity = await hashDirectory(source);
  if (expected && integrity !== expected) throw new Error(`Source integrity mismatch: expected ${expected}, got ${integrity}`);
  const root = cachePath(integrity);
  await withPackageLock("content", integrity.slice(7, 27), async () => {
    if (await pathExists(root)) { await verifyContent(root, integrity, true); return; }
    await mkdir(path.dirname(root), { recursive: true });
    const stage = `${root}.tmp-${randomUUID()}`;
    try {
      await copyContent(source, stage);
      await setTreeWritable(stage, false);
      await verifyContent(stage, integrity, true);
      await rename(stage, root);
    } finally { await removeTree(stage); }
  });
  return { root, integrity };
}

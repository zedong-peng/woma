import { chmod, lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

async function makeWritable(root: string): Promise<void> {
  const info = await lstat(root).catch(() => undefined);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(root, 0o700);
    for (const entry of await readdir(root)) await makeWritable(path.join(root, entry));
    return;
  }
  if (info.isFile()) await chmod(root, 0o600);
}

export async function removeTestTree(root: string): Promise<void> {
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

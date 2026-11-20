/**
 * Atomic run-directory writes.
 *
 * Directories are 0700 and files 0600. A temp file plus rename prevents a
 * child from reading a partially written task or system prompt.
 */
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

import type { RunPaths } from "./paths.ts";

export async function writeFileAtomic(file: string, content: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(temp, "w", mode);
  try {
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temp, mode);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function ensureRunDirectory(paths: RunPaths): Promise<void> {
  await mkdir(paths.sessionDir, { recursive: true, mode: 0o700 });
  await chmod(paths.runDir, 0o700).catch(() => {});
  await chmod(paths.sessionDir, 0o700).catch(() => {});
}

export interface ChildFileContents {
  task: string;
  system: string;
}

export async function writeChildFiles(paths: RunPaths, contents: ChildFileContents): Promise<void> {
  await ensureRunDirectory(paths);
  await writeFileAtomic(paths.taskFile, contents.task);
  await writeFileAtomic(paths.systemFile, contents.system);
}

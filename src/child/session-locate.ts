/**
 * Locate the child's pi session file by exact child ID suffix.
 *
 * No mtime scanning, no other session directories. pi creates the file when the
 * first user message is recorded, so callers poll briefly after spawn.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

import { HcSubagentError } from "../core/error.ts";

export const SESSION_LOCATE_TIMEOUT_MS = 10_000;
export const SESSION_LOCATE_POLL_MS = 200;

export function matchesChildSession(fileName: string, childId: string): boolean {
  return fileName.endsWith(`_${childId}.jsonl`);
}

export async function findSessionInDir(sessionDir: string, childId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(sessionDir);
  } catch {
    return null;
  }
  const match = names.find((name) => matchesChildSession(name, childId));
  return match ? path.join(sessionDir, match) : null;
}

export interface LocateSessionOptions {
  sessionDir: string;
  childId: string;
  timeoutMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
}

export async function locateSessionFile(options: LocateSessionOptions): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? SESSION_LOCATE_TIMEOUT_MS;
  const pollMs = options.pollMs ?? SESSION_LOCATE_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (options.signal?.aborted) throw new HcSubagentError("aborted", "session location aborted");
    const found = await findSessionInDir(options.sessionDir, options.childId);
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())), options.signal);
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new HcSubagentError("aborted", "session location aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

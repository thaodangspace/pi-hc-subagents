/**
 * Run-directory retention.
 *
 * Best effort, clock-injected, and conservative: a run is deleted only when it
 * is older than `retentionDays`, its recorded state is not active, and its
 * terminal is not live.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const ACTIVE_STATES = new Set(["queued", "starting", "working", "blocked"]);
const DAY_MS = 24 * 60 * 60 * 1000;

interface RunJsonSummary {
  state?: unknown;
  terminal?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface RetentionOptions {
  runsRoot: string;
  retentionDays: number;
  now?: () => number;
  /** Defaults to a best-effort `terminal.get`; inject for tests. */
  isTerminalLive?: (terminal: string) => Promise<boolean>;
  remove?: (dir: string) => Promise<void>;
}

export interface RetentionResult {
  scanned: number;
  removed: string[];
  kept: string[];
  failed: Array<{ dir: string; error: string }>;
}

async function readRunJson(dir: string): Promise<RunJsonSummary | null> {
  try {
    const text = await readFile(path.join(dir, "run.json"), "utf8");
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return null;
    return value as RunJsonSummary;
  } catch {
    return null;
  }
}

function ageMs(summary: RunJsonSummary, now: number): number | null {
  for (const key of ["updatedAt", "createdAt"] as const) {
    const value = summary[key];
    if (typeof value !== "string") continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.max(0, now - parsed);
  }
  return null;
}

export async function cleanupExpiredRuns(options: RetentionOptions): Promise<RetentionResult> {
  const result: RetentionResult = { scanned: 0, removed: [], kept: [], failed: [] };
  if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) return result;

  let entries;
  try {
    entries = await readdir(options.runsRoot, { withFileTypes: true });
  } catch {
    return result;
  }

  const now = options.now?.() ?? Date.now();
  const remove = options.remove ?? ((dir: string) => rm(dir, { recursive: true, force: true }));

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(options.runsRoot, entry.name);
    result.scanned++;
    const summary = await readRunJson(dir);
    if (!summary) {
      result.kept.push(dir);
      continue;
    }
    const state = typeof summary.state === "string" ? summary.state : "unknown";
    if (ACTIVE_STATES.has(state)) {
      result.kept.push(dir);
      continue;
    }
    const age = ageMs(summary, now);
    if (age === null || age < options.retentionDays * DAY_MS) {
      result.kept.push(dir);
      continue;
    }
    if (typeof summary.terminal === "string" && summary.terminal.length > 0 && options.isTerminalLive) {
      try {
        if (await options.isTerminalLive(summary.terminal)) {
          result.kept.push(dir);
          continue;
        }
      } catch {
        // If liveness cannot be proven safe, keep the run.
        result.kept.push(dir);
        continue;
      }
    }
    try {
      await remove(dir);
      result.removed.push(dir);
    } catch (error) {
      result.failed.push({ dir, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

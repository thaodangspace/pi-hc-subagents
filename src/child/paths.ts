/**
 * One source of truth for run, child, terminal, and file identifiers.
 */
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";

import { resolveAgentDir } from "../config/config.ts";

export interface RunPaths {
  runId: string;
  childId: string;
  agentSlug: string;
  slug: string;
  terminalName: string;
  sessionName: string;
  runDir: string;
  sessionDir: string;
  taskFile: string;
  systemFile: string;
  resultFile: string;
  runFile: string;
}

export interface CreateRunPathsOptions {
  agentName: string;
  /** pi agent dir; run directories live under <agentDir>/hc-subagents/runs. */
  agentDir?: string;
  /** Explicit run root; wins over agentDir. Used by tests. */
  runsRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  runId?: string;
  childId?: string;
  randomSuffix?: (bytes: number) => string;
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function slugifyAgentName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug.length > 0 ? slug : "agent";
}

/** `YYYYMMDDTHHMMSSZ-<6 hex>` — sortable and filename-safe. */
export function compactTimestamp(now: Date, suffix: string): string {
  const iso = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${iso}-${suffix}`;
}

export function runsRootFor(options: { agentDir?: string; runsRoot?: string; env?: NodeJS.ProcessEnv }): string {
  if (options.runsRoot) return path.resolve(options.runsRoot);
  const env = options.env ?? process.env;
  if (env.PI_HC_SUBAGENTS_RUNS_ROOT) return path.resolve(env.PI_HC_SUBAGENTS_RUNS_ROOT);
  return path.join(options.agentDir ?? resolveAgentDir(env), "hc-subagents", "runs");
}

export function createRunPaths(options: CreateRunPathsOptions): RunPaths {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const suffix = options.randomSuffix ?? ((bytes: number) => hex(bytes));
  const runId = options.runId ?? compactTimestamp(now, suffix(3));
  const childId = options.childId ?? randomUUID();
  const agentSlug = slugifyAgentName(options.agentName);
  const shortHex = suffix(2);
  const maxAgentForTerminal = 32 - "hc-".length - 1 - shortHex.length;
  const terminalSlug = agentSlug.slice(0, Math.max(1, maxAgentForTerminal)).replace(/-$/, "");
  const terminalName = `hc-${terminalSlug}-${shortHex}`;
  const slug = `${agentSlug.slice(0, 40)}-${shortHex}`;
  const runDir = path.join(runsRootFor(options), runId);
  const sessionDir = path.join(runDir, "sessions");

  return {
    runId,
    childId,
    agentSlug,
    slug,
    terminalName,
    sessionName: terminalName.slice(0, 80),
    runDir,
    sessionDir,
    taskFile: path.join(runDir, "task.md"),
    systemFile: path.join(runDir, "system.md"),
    resultFile: path.join(runDir, "result.json"),
    runFile: path.join(runDir, "run.json"),
  };
}

/** Validate hc terminal names: 1-32 of a-z 0-9 - _ . */
export function sanitizeTerminalName(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9\-_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return (cleaned || "hc-child").slice(0, 32);
}

/** Session display name: printable, bounded. */
export function sanitizeSessionName(name: string): string {
  const cleaned = name.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return (cleaned || "pi-hc-subagent").slice(0, 80);
}

export function sessionFileFor(sessionDir: string, childId: string): string {
  return path.join(sessionDir, `_${childId}.jsonl`);
}

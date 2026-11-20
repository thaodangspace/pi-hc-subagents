/**
 * Spawn one child terminal.
 *
 * Files and `run.json` are written before `terminal.run`. The only retry is
 * `name_taken`, which happens before the program starts; a spawn is never
 * retried after a task may have been delivered.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { CoreClient } from "../core/core-client.ts";
import { HcSubagentError, toHcSubagentError } from "../core/error.ts";
import { coreStatusOf, type SubagentRecord } from "../runtime/types.ts";
import { writeChildFiles, writeFileAtomic } from "./child-files.ts";
import type { SpawnPlan } from "./child-command.ts";
import type { RunPaths } from "./paths.ts";
import { sanitizeTerminalName } from "./paths.ts";

export interface RunMetadata {
  version: 1;
  runId: string;
  childId: string;
  parentSessionId: string;
  parentTerminalId: string;
  agent: string;
  agentSource: string;
  agentAccess: string;
  cwd: string;
  taskFile: string;
  systemFile: string;
  resultFile: string;
  sessionDir: string;
  sessionId: string;
  terminalName: string;
  origin: string;
  labels: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  state: "starting" | "spawned" | "working" | "blocked" | "completed" | "failed" | "cancelled";
  terminal?: string;
  turn?: number;
  coreStatus?: string;
  sessionFile?: string | null;
  settledAt?: string;
  outcome?: string;
  error?: string;
}

export interface SpawnChildOptions {
  signal?: AbortSignal;
  origin?: string;
  now?: () => Date;
  generateSuffix?: () => string;
}

export interface SpawnChildResult {
  terminal: Awaited<ReturnType<CoreClient["run"]>>;
  terminalName: string;
  retriedName: boolean;
  metadata: RunMetadata;
}

function newSuffix(): string {
  return randomBytes(2).toString("hex");
}

function regenerateTerminalName(plan: SpawnPlan, suffix: () => string): string {
  const base = plan.paths.terminalName.replace(/-[a-z0-9]+$/, "");
  return sanitizeTerminalName(`${base}-${suffix()}`);
}

/** Clone a plan with a new hc terminal name and matching `--name` display name. */
export function withTerminalName(plan: SpawnPlan, terminalName: string): SpawnPlan {
  const argv = [...plan.argv];
  const nameIndex = argv.indexOf("--name");
  if (nameIndex >= 0 && nameIndex + 1 < argv.length) argv[nameIndex + 1] = terminalName;
  return {
    ...plan,
    paths: { ...plan.paths, terminalName, sessionName: terminalName.slice(0, 80) },
    argv,
  };
}

export async function writeRunMetadata(paths: RunPaths, metadata: RunMetadata): Promise<void> {
  await writeFileAtomic(paths.runFile, `${JSON.stringify(metadata, null, 2)}\n`);
}

/** Merge a bounded state summary into the existing run.json. Best effort. */
export async function updateRunMetadataFile(
  file: string,
  patch: Partial<RunMetadata>,
  now: Date = new Date(),
): Promise<void> {
  let existing: RunMetadata;
  try {
    existing = JSON.parse(await readFile(file, "utf8")) as RunMetadata;
  } catch {
    return;
  }
  if (!existing || typeof existing !== "object" || existing.version !== 1) return;
  const next: RunMetadata = { ...existing, ...patch, updatedAt: now.toISOString() };
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
}

export function createRunMetadata(plan: SpawnPlan, options: SpawnChildOptions = {}): RunMetadata {
  const now = options.now?.() ?? new Date();
  const timestamp = now.toISOString();
  return {
    version: 1,
    runId: plan.paths.runId,
    childId: plan.paths.childId,
    parentSessionId: plan.env.PI_HC_PARENT_SESSION ?? "",
    parentTerminalId: plan.parent,
    agent: plan.agent.name,
    agentSource: plan.agent.source,
    agentAccess: plan.agent.access,
    cwd: plan.cwd,
    taskFile: plan.paths.taskFile,
    systemFile: plan.paths.systemFile,
    resultFile: plan.paths.resultFile,
    sessionDir: plan.paths.sessionDir,
    sessionId: plan.paths.childId,
    terminalName: plan.paths.terminalName,
    origin: options.origin ?? "tool",
    labels: { ...plan.labels },
    createdAt: timestamp,
    updatedAt: timestamp,
    state: "starting",
  };
}

export async function spawnChild(
  core: CoreClient,
  plan: SpawnPlan,
  options: SpawnChildOptions = {},
): Promise<SpawnChildResult> {
  await writeChildFiles(plan.paths, { task: plan.taskContent, system: plan.systemContent });
  let metadata = createRunMetadata(plan, options);

  const run = (candidate: SpawnPlan) =>
    core.run(
      {
        argv: candidate.argv,
        cwd: candidate.cwd,
        env: candidate.env,
        name: candidate.paths.terminalName,
        labels: candidate.labels,
        caller: candidate.parent,
        parent: candidate.parent,
        noNotify: true,
        rm: false,
        wait: false,
      },
      { ...(options.signal === undefined ? {} : { signal: options.signal }) },
    );

  let candidate = plan;
  let retriedName = false;
  try {
    let terminal;
    try {
      terminal = await run(candidate);
    } catch (error) {
      const normalized = toHcSubagentError(error);
      if (normalized.code !== "name_taken" || retriedName) throw normalized;
      retriedName = true;
      candidate = withTerminalName(candidate, regenerateTerminalName(candidate, options.generateSuffix ?? newSuffix));
      metadata = {
        ...metadata,
        terminalName: candidate.paths.terminalName,
        labels: { ...candidate.labels },
        updatedAt: (options.now?.() ?? new Date()).toISOString(),
      };
      await writeRunMetadata(candidate.paths, metadata);
      terminal = await run(candidate);
    }

    metadata = {
      ...metadata,
      state: "spawned",
      terminal: terminal.address,
      terminalName: terminal.name ?? candidate.paths.terminalName,
      labels: { ...terminal.labels },
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await writeRunMetadata(candidate.paths, metadata);
    return { terminal, terminalName: metadata.terminalName, retriedName, metadata };
  } catch (error) {
    const normalized = toHcSubagentError(error, "spawn_failed");
    metadata = {
      ...metadata,
      state: "failed",
      error: `${normalized.code}: ${normalized.message}`,
      updatedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await writeRunMetadata(plan.paths, metadata).catch(() => {});
    throw normalized.code === "name_taken"
      ? new HcSubagentError("name_taken", `terminal name ${candidate.paths.terminalName} is already taken`, {
          hint: normalized.hint,
          cause: normalized,
        })
      : normalized;
  }
}

export interface CreateRecordOptions {
  parentSessionId: string;
  origin?: string;
  background?: boolean;
  now?: () => Date;
  baselineTurn?: number;
  turnStartedAtMs?: number;
}

export function createSubagentRecord(
  plan: SpawnPlan,
  terminal: Awaited<ReturnType<CoreClient["run"]>>,
  options: CreateRecordOptions,
): SubagentRecord {
  const nowDate = options.now?.() ?? new Date();
  const now = nowDate.toISOString();
  const baselineTurn = options.baselineTurn ?? terminal.turn;
  return {
    version: 1,
    runId: plan.paths.runId,
    childId: plan.paths.childId,
    parentSessionId: options.parentSessionId,
    agent: plan.agent.name,
    agentSource: plan.agent.source,
    agentAccess: plan.agent.access,
    cwd: plan.cwd,
    terminal: terminal.address,
    terminalName: terminal.name ?? plan.paths.terminalName,
    sessionId: plan.paths.childId,
    sessionFile: null,
    runDir: plan.paths.runDir,
    resultFile: plan.paths.resultFile,
    ...(plan.agent.model === undefined ? {} : { model: plan.agent.model }),
    ...(plan.agent.thinking === undefined ? {} : { thinking: plan.agent.thinking }),
    state: "starting",
    terminalState: terminal.state,
    coreStatus: coreStatusOf(terminal),
    slug: plan.paths.slug,
    turn: terminal.turn,
    turns: [
      {
        index: 1,
        task: plan.task,
        startedAt: now,
        startedAtMs: options.turnStartedAtMs ?? nowDate.getTime(),
        baselineTurn,
        state: "running",
        terminal: terminal.address,
      },
    ],
    createdAt: now,
    updatedAt: now,
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    labels: { ...terminal.labels },
    background: options.background ?? false,
    origin: options.origin ?? "tool",
  };
}

export function markRecordFromTerminal(
  record: SubagentRecord,
  terminal: Awaited<ReturnType<CoreClient["get"]>>,
): SubagentRecord {
  return {
    ...record,
    terminal: terminal.address,
    terminalName: terminal.name ?? record.terminalName,
    terminalState: terminal.state,
    coreStatus: coreStatusOf(terminal),
    turn: terminal.turn,
    exitCode: terminal.exitCode,
    signal: terminal.signal,
    labels: { ...terminal.labels },
    updatedAt: new Date().toISOString(),
  };
}

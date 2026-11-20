/**
 * Resume reconciliation.
 *
 * Records come from bounded `pi.appendEntry` summaries and/or this parent's
 * `run.json` files. A terminal is reattached by address only — never by name —
 * and a recorded child that is no longer live becomes `failed`/`exited`.
 * Children from another parent session are never adopted.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CoreClient } from "../core/core-client.ts";
import type { TerminalRecord } from "../core/hc-types.ts";
import type { RunMetadata } from "../child/child-spawn.ts";
import {
  type PersistedRunSummary,
} from "./persistence.ts";
import { readResultFile } from "./result-store.ts";
import type { Registry } from "./registry.ts";
import { coreStatusOf, type SubagentRecord, type TurnOutcome } from "./types.ts";

export interface ReconcileOptions {
  registry: Registry;
  summaries: PersistedRunSummary[];
  core: Pick<CoreClient, "tryGet">;
  now?: () => Date;
}

export interface ReconcileResult {
  restored: SubagentRecord[];
  stale: SubagentRecord[];
}

export function recordFromSummary(summary: PersistedRunSummary): SubagentRecord {
  const lastTurn =
    summary.lastTurn ?? (summary.turn > 0 ? { startedAt: summary.createdAt, baselineTurn: 0 } : undefined);
  return {
    version: 1,
    runId: summary.runId,
    childId: summary.childId,
    parentSessionId: summary.parentSessionId,
    agent: summary.agent,
    agentSource: summary.agentSource,
    agentAccess: summary.agentAccess,
    cwd: summary.cwd,
    terminal: summary.terminal,
    terminalName: summary.terminalName,
    sessionId: summary.sessionId,
    sessionFile: summary.sessionFile,
    ...(summary.pipeName ? { pipeName: summary.pipeName } : {}),
    ...(summary.runDir ? { runDir: summary.runDir } : {}),
    ...(summary.resultFile ? { resultFile: summary.resultFile } : {}),
    ...(summary.model ? { model: summary.model } : {}),
    ...(summary.thinking ? { thinking: summary.thinking } : {}),
    state: summary.state,
    terminalState: "finished",
    coreStatus: "unknown",
    slug: summary.slug,
    turn: summary.turn,
    turns: lastTurn
      ? [
          {
            index: 1,
            task: "",
            startedAt: lastTurn.startedAt,
            ...(lastTurn.startedAtMs === undefined ? {} : { startedAtMs: lastTurn.startedAtMs }),
            baselineTurn: lastTurn.baselineTurn,
            state:
              summary.state === "completed"
                ? "completed"
                : summary.state === "failed"
                  ? "failed"
                  : summary.state === "cancelled"
                    ? "cancelled"
                    : "running",
            ...(summary.outcome ? { outcome: summary.outcome } : {}),
            ...(summary.usage ? { usage: summary.usage } : {}),
            ...(summary.sessionFile ? { sessionFile: summary.sessionFile } : {}),
            terminal: summary.terminal,
            ...(summary.settledAt ? { settledAt: summary.settledAt } : {}),
            ...(summary.error ? { error: summary.error } : {}),
          },
        ]
      : [],
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    ...(summary.settledAt ? { settledAt: summary.settledAt } : {}),
    labels: { ...summary.labels },
    background: summary.background,
    origin: summary.origin,
    ...(summary.error ? { error: summary.error } : {}),
  };
}

function terminalIsFinished(terminal: TerminalRecord): boolean {
  return terminal.state === "finished";
}

/**
 * Reconcile one record against the live core.
 *
 * Returns the refreshed record and whether it is stale (not live).
 */
export async function reconcileRecord(
  options: ReconcileOptions,
  summary: PersistedRunSummary,
): Promise<{ record: SubagentRecord; stale: boolean }> {
  const now = options.now?.() ?? new Date();
  let record = recordFromSummary(summary);

  let terminal: TerminalRecord | null = null;
  try {
    terminal = await options.core.tryGet(summary.terminal);
  } catch {
    terminal = null;
  }

  if (terminal && !terminalIsFinished(terminal)) {
    record = {
      ...record,
      terminal: terminal.address,
      terminalName: terminal.name ?? record.terminalName,
      terminalState: "live",
      coreStatus: coreStatusOf(terminal),
      turn: terminal.turn,
      updatedAt: now.toISOString(),
    };
    return { record, stale: false };
  }

  // The recorded process is gone. Prefer a published result, otherwise fail.
  const stored = record.resultFile ? await readResultFile(record.resultFile).catch(() => null) : null;
  if (stored) {
    // A terminal summary written after the result (for example a cancel) wins;
    // an in-flight summary is superseded by the published result.
    const summaryIsTerminal =
      record.state === "completed" || record.state === "failed" || record.state === "cancelled";
    const state = summaryIsTerminal
      ? record.state
      : stored.state === "completed"
        ? "completed"
        : stored.state === "cancelled"
          ? "cancelled"
          : "failed";
    const outcome = summaryIsTerminal ? record.turns.at(-1)?.outcome ?? stored.outcome : stored.outcome;
    const error = summaryIsTerminal ? record.error ?? stored.error : stored.error;
    const settledAt = summaryIsTerminal ? record.settledAt ?? stored.settledAt : stored.settledAt;
    const turnState = state === "completed" ? ("completed" as const) : state === "cancelled" ? ("cancelled" as const) : ("failed" as const);
    const turns =
      record.turns.length > 0
        ? record.turns.map((turn) => ({
            ...turn,
            state: turnState,
            outcome,
            usage: stored.usage,
            settledAt,
            ...(error ? { error } : {}),
          }))
        : [
            {
              index: 1,
              task: "",
              startedAt: stored.startedAt,
              baselineTurn: 0,
              state: turnState,
              outcome,
              usage: stored.usage,
              settledAt,
              terminal: stored.terminal,
              ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
              ...(error ? { error } : {}),
            },
          ];
    record = {
      ...record,
      state,
      terminalState: "finished",
      coreStatus: state === "completed" ? "done" : "error",
      ...(settledAt ? { settledAt } : {}),
      sessionFile: stored.sessionFile ?? record.sessionFile,
      ...(error ? { error } : {}),
      updatedAt: now.toISOString(),
      turns,
    };
  } else if (record.state !== "completed" && record.state !== "failed" && record.state !== "cancelled") {
    const nowIso = now.toISOString();
    const turns =
      record.turns.length > 0
        ? record.turns.map((turn) => ({
            ...turn,
            state: "failed" as const,
            outcome: "exited" as TurnOutcome,
            error: "recorded child is no longer live",
            settledAt: nowIso,
          }))
        : [
            {
              index: 1,
              task: "",
              startedAt: record.createdAt,
              baselineTurn: 0,
              state: "failed" as const,
              outcome: "exited" as const,
              error: "recorded child is no longer live",
              settledAt: nowIso,
              terminal: record.terminal,
            },
          ];
    record = {
      ...record,
      state: "failed",
      terminalState: "finished",
      coreStatus: "unknown",
      settledAt: nowIso,
      updatedAt: nowIso,
      error: "recorded child is no longer live",
      turns,
    };
  }
  return { record, stale: true };
}

export async function reconcileRuns(options: ReconcileOptions): Promise<ReconcileResult> {
  const restored: SubagentRecord[] = [];
  const stale: SubagentRecord[] = [];
  for (const summary of options.summaries) {
    if (options.registry.get(summary.childId)) continue;
    const reconciled = await reconcileRecord(options, summary);
    options.registry.create(reconciled.record);
    restored.push(reconciled.record);
    if (reconciled.stale) stale.push(reconciled.record);
  }
  return { restored, stale };
}

/**
 * Recover summaries from this parent's `run.json` files.
 *
 * Only runs whose `parentSessionId` matches are reconstructed; other sessions'
 * runs are ignored even if they live in the same runs root.
 */
export async function loadSummariesFromRunDirs(options: {
  runsRoot: string;
  parentSessionId: string;
}): Promise<PersistedRunSummary[]> {
  let entries;
  try {
    entries = await readdir(options.runsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: PersistedRunSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(options.runsRoot, entry.name);
    let metadata: RunMetadata;
    try {
      metadata = JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")) as RunMetadata;
    } catch {
      continue;
    }
    if (!metadata || metadata.version !== 1) continue;
    if (metadata.parentSessionId !== options.parentSessionId) continue;
    summaries.push(runMetadataToSummary(metadata));
  }
  return summaries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function runMetadataToSummary(metadata: RunMetadata): PersistedRunSummary {
  return {
    version: 1,
    runId: metadata.runId,
    childId: metadata.childId,
    parentSessionId: metadata.parentSessionId,
    agent: metadata.agent,
    agentSource: (metadata.agentSource as PersistedRunSummary["agentSource"]) ?? "user",
    agentAccess: (metadata.agentAccess as PersistedRunSummary["agentAccess"]) ?? "read-only",
    cwd: metadata.cwd,
    terminal: metadata.terminal ?? "",
    terminalName: metadata.terminalName,
    sessionId: metadata.sessionId,
    sessionFile: metadata.sessionFile ?? null,
    ...(metadata.pipeName ? { pipeName: metadata.pipeName } : {}),
    runDir: metadata.taskFile ? path.dirname(metadata.taskFile) : "",
    resultFile: metadata.resultFile,
    slug: metadata.slug ?? `${metadata.agent}-${metadata.childId.slice(0, 4)}`,
    state: (metadata.state as PersistedRunSummary["state"]) ?? "starting",
    background: metadata.background === true,
    origin: metadata.origin,
    turn: metadata.turn ?? 0,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
    ...(metadata.settledAt ? { settledAt: metadata.settledAt } : {}),
    ...(metadata.outcome ? { outcome: metadata.outcome as TurnOutcome } : {}),
    ...(metadata.error ? { error: metadata.error } : {}),
    ...(metadata.model ? { model: metadata.model } : {}),
    ...(metadata.thinking ? { thinking: metadata.thinking as PersistedRunSummary["thinking"] } : {}),
    labels: { ...metadata.labels },
  };
}

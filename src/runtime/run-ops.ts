/**
 * Runtime operations shared by the control tool and the intertool service.
 *
 * These return plain data (`SubagentResult`), not tool results, so external
 * consumers do not depend on pi's tool formatting.
 */
import path from "node:path";

import { updateRunMetadataFile } from "../child/child-spawn.ts";
import { locateSessionFile } from "../child/session-locate.ts";
import { parseSessionWithRetry } from "../child/session-read.ts";
import { abortChild, waitForChild } from "../child/wait-child.ts";
import { HcSubagentError, describeHcError, toHcSubagentError } from "../core/error.ts";
import type { TerminalRecord } from "../core/hc-types.ts";
import type { ToolSession } from "../tools/session.ts";
import {
  type FinalizeResult,
  finalizeFromSession,
  persistRunSummary,
  readScreenTail,
} from "./finalize.ts";
import { resolveChildId } from "./id-resolve.ts";
import { readResultFile } from "./result-store.ts";
import { ChildStateMachine } from "./state-machine.ts";
import { wakeSourceFor } from "./settle-hints.ts";
import type { SubagentRecord, SubagentState, TurnOutcome, Usage } from "./types.ts";

export interface SubagentBlocked {
  kind?: string;
  message?: string;
  screenTail?: string;
}

/** Plain result shape from SPEC §19.3. */
export interface SubagentResult {
  childId: string;
  runId: string;
  state: SubagentState;
  outcome: TurnOutcome;
  text?: string;
  error?: string;
  usage?: Usage;
  terminal: string;
  sessionFile?: string;
  resultFile?: string;
  durationMs?: number;
  blocked?: SubagentBlocked;
}

export function durationOf(record: SubagentRecord, now = Date.now()): number {
  const started = Date.parse(record.createdAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

export function turnStartedAtMsFor(record: SubagentRecord): number {
  const last = record.turns.at(-1);
  if (last?.startedAtMs) return last.startedAtMs;
  const iso = last?.startedAt ?? record.createdAt;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export async function findSessionFile(
  session: ToolSession,
  record: SubagentRecord,
  timeoutMs = 2000,
): Promise<string | null> {
  if (record.sessionFile) return record.sessionFile;
  if (!record.runDir) return null;
  const file = await locateSessionFile({
    sessionDir: path.join(record.runDir, "sessions"),
    childId: record.childId,
    timeoutMs,
  }).catch(() => null);
  if (file) {
    session.registry.update(record.childId, { sessionFile: file });
    void session.runtime.core.label(record.terminal, { "pi-hc-session": file }).catch(() => {});
  }
  return file;
}

export async function collectResultForRecord(
  session: ToolSession,
  record: SubagentRecord,
  terminal: TerminalRecord,
  final: boolean,
  waitMs = 2000,
): Promise<FinalizeResult> {
  const file = await findSessionFile(session, record, waitMs);
  const resultFile = record.resultFile ?? (record.runDir ? path.join(record.runDir, "result.json") : "");
  const startedAtMs = turnStartedAtMsFor(record);
  if (!file) {
    return finalizeFromSession({
      session,
      record,
      terminal,
      parsed: null,
      turnStartedAtMs: startedAtMs,
      resultFile,
      fallbackOutcome: final ? "incomplete" : "exited",
      fallbackError: "no session file is available for this child",
    });
  }
  const parsed = await parseSessionWithRetry(file, { turnStartedAtMs: startedAtMs, final }).catch(() => null);
  return finalizeFromSession({
    session,
    record,
    terminal,
    parsed,
    turnStartedAtMs: startedAtMs,
    resultFile,
    fallbackOutcome: final ? "incomplete" : "exited",
    fallbackError: "could not parse a result for this turn",
  });
}

export function toSubagentResult(record: SubagentRecord, finalized?: FinalizeResult): SubagentResult {
  const snapshot = finalized?.record ?? record;
  const last = snapshot.turns.at(-1);
  const state = finalized?.state ?? snapshot.state;
  const outcome: TurnOutcome =
    finalized?.outcome ??
    last?.outcome ??
    (state === "completed" ? "stop" : state === "cancelled" ? "aborted" : "incomplete");
  const text = last?.text;
  const usage = last?.usage;
  return {
    childId: snapshot.childId,
    runId: snapshot.runId,
    state,
    outcome,
    ...(text === undefined ? {} : { text }),
    ...(snapshot.error ? { error: snapshot.error } : {}),
    ...(usage ? { usage } : {}),
    terminal: snapshot.terminal,
    ...(snapshot.sessionFile ? { sessionFile: snapshot.sessionFile } : {}),
    ...(snapshot.resultFile ? { resultFile: snapshot.resultFile } : {}),
    durationMs: durationOf(snapshot),
    ...(snapshot.state === "blocked"
      ? {
          blocked: {
            ...(last?.blocked?.kind ? { kind: last.blocked.kind } : {}),
            ...(last?.blocked?.message ? { message: last.blocked.message } : {}),
            ...(snapshot.lastScreen ? { screenTail: snapshot.lastScreen } : {}),
          },
        }
      : {}),
  };
}

async function storedResult(session: ToolSession, record: SubagentRecord): Promise<SubagentResult | null> {
  if (!record.resultFile) return null;
  const stored = await readResultFile(record.resultFile);
  if (!stored) return null;
  return {
    childId: record.childId,
    runId: record.runId,
    state: stored.state,
    outcome: stored.outcome,
    ...(stored.text.length > 0 ? { text: stored.text } : {}),
    ...(stored.error ? { error: stored.error } : {}),
    usage: stored.usage,
    terminal: record.terminal,
    ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
    resultFile: record.resultFile,
    durationMs: durationOf(record),
  };
}

function isSettledRecord(record: SubagentRecord): boolean {
  return (
    record.state === "completed" ||
    record.state === "failed" ||
    record.state === "cancelled" ||
    record.terminalState === "finished"
  );
}

export interface WaitRecordOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Wait for the current turn and return a plain result. Never throws for blocked. */
export async function waitForRecord(
  session: ToolSession,
  record: SubagentRecord,
  options: WaitRecordOptions = {},
): Promise<SubagentResult> {
  if (isSettledRecord(record)) {
    const stored = await storedResult(session, record);
    if (stored) return stored;
    const terminal = await session.runtime.core.tryGet(record.terminal);
    if (!terminal) {
      return {
        ...toSubagentResult(record),
        outcome: record.turns.at(-1)?.outcome ?? "exited",
        error: record.error ?? `terminal ${record.terminal} is gone`,
      };
    }
    return toSubagentResult(record, await collectResultForRecord(session, record, terminal, true));
  }

  const terminal = await session.runtime.core.tryGet(record.terminal);
  if (!terminal) {
    return {
      ...toSubagentResult(record),
      state: "failed",
      outcome: "exited",
      error: `terminal ${record.terminal} no longer exists`,
    };
  }
  session.registry.applyTerminal(record.childId, terminal);

  const machine = new ChildStateMachine({
    baselineTurn: record.turn,
    startupTimeoutMs: session.runtime.config.startupTimeoutMs,
    waitTimeoutMs: options.timeoutMs ?? session.runtime.config.waitTimeoutMs,
    initialPhase: record.state === "starting" ? "starting" : "working",
    ...(record.turns.at(-1)?.startedAtMs === undefined ? {} : { startedAtMs: record.turns.at(-1)?.startedAtMs }),
  });

  const wake = wakeSourceFor(session.settleHints, record.childId);
  const outcome = await waitForChild({
    core: session.runtime.core,
    terminal: record.terminal,
    machine,
    pollIntervalMs: session.runtime.config.pollIntervalMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(wake === undefined ? {} : { wake }),
    onObservation(next) {
      session.registry.applyTerminal(record.childId, next);
    },
  });

  switch (outcome.kind) {
    case "settled":
    case "exited":
      return toSubagentResult(record, await collectResultForRecord(session, record, outcome.terminal, true));
    case "blocked": {
      const kind = outcome.transition.type === "blocked" ? outcome.transition.kind : null;
      const message = outcome.transition.type === "blocked" ? outcome.transition.message : null;
      const screenTail = await readScreenTail(session, record.terminal);
      const updated = session.registry.update(record.childId, {
        state: "blocked",
        coreStatus: "blocked",
        lastScreen: screenTail,
      });
      return {
        ...toSubagentResult(updated),
        state: "blocked",
        outcome: "blocked",
        blocked: {
          ...(kind ? { kind } : {}),
          ...(message ? { message } : {}),
          ...(screenTail ? { screenTail } : {}),
        },
      };
    }
    case "startup_timeout":
    case "wait_timeout": {
      const state: SubagentState = outcome.kind === "startup_timeout" ? "starting" : "working";
      const updated = session.registry.update(record.childId, { state });
      return { ...toSubagentResult(updated), state, outcome: "timeout" };
    }
    case "cancelled": {
      const updated = session.registry.update(record.childId, { state: "cancelled" });
      return { ...toSubagentResult(updated), state: "cancelled", outcome: "aborted", error: "wait aborted" };
    }
    case "terminal_lost":
      return {
        ...toSubagentResult(record),
        state: "failed",
        outcome: "exited",
        error: `terminal ${record.terminal} disappeared while waiting`,
      };
  }
}

export interface CancelRecordOptions {
  force?: boolean;
}

export async function cancelRecord(
  session: ToolSession,
  record: SubagentRecord,
  options: CancelRecordOptions = {},
): Promise<{ record: SubagentRecord; killed: boolean }> {
  const kill = options.force === true || session.runtime.config.killOnAbort;
  let killed = false;
  if (options.force === true) {
    try {
      await session.runtime.core.kill(record.terminal);
      killed = true;
    } catch (error) {
      const normalized = toHcSubagentError(error);
      if (normalized.code !== "not_found" && normalized.code !== "finished") throw normalized;
    }
  } else {
    const abort = await abortChild(session.runtime.core, record.terminal, {
      kill,
      pollMs: session.runtime.config.pollIntervalMs,
    }).catch(() => ({ interrupted: false, killed: false, outcome: null }));
    killed = abort.killed;
    // A blocked/idle child leaves `working` before the grace-kill step; cancel
    // still terminates it when the configured policy says to kill.
    if (kill && !killed) {
      try {
        await session.runtime.core.kill(record.terminal);
        killed = true;
      } catch (error) {
        const normalized = toHcSubagentError(error);
        if (normalized.code !== "not_found" && normalized.code !== "finished") throw normalized;
      }
    }
  }
  const now = new Date().toISOString();
  const updated = session.registry.update(record.childId, {
    state: "cancelled",
    terminalState: killed ? "finished" : record.terminalState,
    settledAt: now,
    error: killed ? "cancelled (killed)" : "cancelled",
    turns: record.turns.map((turn) =>
      turn.state === "running" || turn.state === "blocked"
        ? { ...turn, state: "cancelled" as const, outcome: "aborted" as const, settledAt: now }
        : turn,
    ),
  });
  if (updated.runDir) {
    await updateRunMetadataFile(path.join(updated.runDir, "run.json"), {
      state: "cancelled",
      outcome: "aborted",
      settledAt: now,
      ...(updated.sessionFile ? { sessionFile: updated.sessionFile } : {}),
    }).catch(() => {});
  }
  await persistRunSummary(updated, {
    state: "cancelled",
    outcome: "aborted",
    settledAt: now,
    ...(updated.sessionFile ? { sessionFile: updated.sessionFile } : {}),
  });
  session.notifier?.markDelivered(updated.childId, updated.turn, "result");
  if (killed) {
    await session.runtime.core.remove(record.terminal).catch(() => {});
  }
  return { record: updated, killed };
}

export function resolveOwnedRecord(session: ToolSession, id: string): SubagentRecord {
  const resolved = resolveChildId(session.registry, id);
  if (resolved.kind === "not_found") throw new HcSubagentError("not_found", resolved.message);
  if (resolved.kind === "ambiguous") {
    throw new HcSubagentError("not_found", resolved.message, { hint: "use a longer id" });
  }
  if (resolved.record.parentSessionId !== session.runtime.parentSessionId) {
    throw new HcSubagentError("not_found", `no subagent matches "${id}"`);
  }
  return resolved.record;
}

export function describeResultError(error: unknown): string {
  return describeHcError(error);
}

export function normalizeResultError(error: unknown): HcSubagentError {
  return toHcSubagentError(error);
}

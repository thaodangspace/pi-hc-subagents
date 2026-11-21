/**
 * Follow-up delivery over the private pipe (Milestone 3).
 *
 * A follow-up appends a new turn, sends through the child's Unix socket, then
 * optionally waits for the new turn. The session JSONL remains the result
 * source; the pipe only carries the message. Blocked children are never sent
 * input.
 */
import path from "node:path";

import { pipeClientFor, waitForPipe } from "../child/pipe-transport.ts";
import { waitForChild } from "../child/wait-child.ts";
import { HcSubagentError, toHcSubagentError } from "../core/error.ts";
import type { ToolSession } from "../tools/session.ts";
import type { FinalizeResult } from "./finalize.ts";
import { persistRunSummary, readScreenTail } from "./finalize.ts";
import { defaultMonitorHooks } from "./run-hooks.ts";
import { wakeSourceFor } from "./settle-hints.ts";
import { collectResultForRecord, findSessionFile } from "./run-ops.ts";
import { ChildStateMachine } from "./state-machine.ts";
import { type SubagentRecord, type TurnRecord, updateCurrentTurns } from "./types.ts";

export const MAX_FOLLOW_UP_BYTES = 256 * 1024;
const PIPE_READY_TIMEOUT_MS = 5_000;

export interface FollowUpOptions {
  message: string;
  /** Default true; false returns after delivery and lets a monitor wait. */
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface FollowUpBlocked {
  kind?: string;
  message?: string;
  screenTail?: string;
}

export interface FollowUpOutcome {
  record: SubagentRecord;
  baselineTurn: number;
  accepted: true;
  /** Present when wait was true and the turn settled/exited. */
  finalized?: FinalizeResult;
  /** Present when the new turn became blocked. */
  blocked?: FollowUpBlocked;
  /** Present when the wait timed out or was cancelled. */
  pending?: "timeout" | "cancelled" | "terminal_lost";
}

function resultFileFor(record: SubagentRecord): string {
  return record.resultFile ?? (record.runDir ? path.join(record.runDir, "result.json") : "");
}

export async function sendFollowUp(
  session: ToolSession,
  record: SubagentRecord,
  options: FollowUpOptions,
): Promise<FollowUpOutcome> {
  const message = options.message;
  if (message.trim().length === 0) throw new HcSubagentError("validation", "message must not be empty");
  if (Buffer.byteLength(message, "utf8") > MAX_FOLLOW_UP_BYTES) {
    throw new HcSubagentError("validation", `message exceeds ${MAX_FOLLOW_UP_BYTES} bytes`);
  }

  const terminal = await session.runtime.core.tryGet(record.terminal);
  if (!terminal) {
    throw new HcSubagentError("not_found", `terminal ${record.terminal} no longer exists`);
  }
  record = session.registry.applyTerminal(record.childId, terminal);
  if (terminal.state === "finished") {
    throw new HcSubagentError("finished", `child ${record.childId} has already finished`);
  }
  if (terminal.status?.state === "blocked") {
    const blocked = session.registry.update(record.childId, { state: "blocked", coreStatus: "blocked" });
    session.persistence?.append(blocked);
    throw new HcSubagentError("blocked", "the child is blocked; a human must answer before a follow-up", {
      hint: `attach with hc attach ${record.terminal}`,
      data: {
        kind: terminal.status?.kind ?? record.turns.at(-1)?.blocked?.kind,
      },
    });
  }
  if (!record.pipeName) {
    throw new HcSubagentError("unavailable", "this child has no private follow-up pipe", {
      hint: "the child was spawned before M3 or restored from an older run; start a new child",
    });
  }

  const client = pipeClientFor(session.runtime.cwd, record.childId, record.pipeName);
  await waitForPipe(client, {
    timeoutMs: PIPE_READY_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const baselineTurn = terminal.turn;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  try {
    await client.followUp(message, true, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    const normalized = toHcSubagentError(error);
    if (normalized.code === "blocked") {
      const kind = (normalized.data as { kind?: string } | undefined)?.kind;
      const now = new Date().toISOString();
      const blocked = session.registry.update(record.childId, {
        state: "blocked",
        coreStatus: "blocked",
        turns: updateCurrentTurns(record, () => ({
          state: "blocked" as const,
          blocked: { ...(kind ? { kind } : {}) },
          settledAt: now,
        })),
      });
      session.persistence?.append(blocked);
      session.onRecordChange?.(blocked);
    }
    throw normalized;
  }

  const turn: TurnRecord = {
    index: record.turns.length + 1,
    task: message,
    startedAt,
    startedAtMs,
    baselineTurn,
    state: "running",
    terminal: record.terminal,
  };
  let started = session.registry.update(record.childId, {
    state: "working",
    coreStatus: "working",
    turns: [...record.turns, turn],
  });
  session.persistence?.append(started);
  session.onRecordChange?.(started);

  if (options.wait === false) {
    const resultFile = resultFileFor(started);
    if (started.background && session.monitors && resultFile) {
      const machine = new ChildStateMachine({
        baselineTurn,
        startupTimeoutMs: session.runtime.config.startupTimeoutMs,
        waitTimeoutMs: Number.MAX_SAFE_INTEGER,
        initialPhase: "working",
        startedAtMs,
      });
      // A follow-up settles a new turn: a closed hub is restarted as a fresh episode.
      if (started.pipeName) session.settleHints?.start(started.childId, started.pipeName);
      const wake = wakeSourceFor(session.settleHints, started.childId);
      session.monitors.start({
        session,
        record: started,
        terminal,
        machine,
        turnStartedAtMs: startedAtMs,
        resultFile,
        locate: () => findSessionFile(session, started),
        pollIntervalMs: session.runtime.config.pollIntervalMs,
        ...(wake === undefined ? {} : { wake }),
        hooks: defaultMonitorHooks(session),
      });
    }
    return { record: started, baselineTurn, accepted: true };
  }

  const machine = new ChildStateMachine({
    baselineTurn,
    startupTimeoutMs: session.runtime.config.startupTimeoutMs,
    waitTimeoutMs: options.timeoutMs ?? session.runtime.config.waitTimeoutMs,
    initialPhase: "working",
    startedAtMs,
  });
  if (record.pipeName) session.settleHints?.start(record.childId, record.pipeName);
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

  if (outcome.kind === "blocked") {
    const kind = outcome.transition.type === "blocked" ? outcome.transition.kind : null;
    const blockedMessage = outcome.transition.type === "blocked" ? outcome.transition.message : null;
    const screenTail = await readScreenTail(session, record.terminal);
    started = session.registry.update(record.childId, {
      state: "blocked",
      coreStatus: "blocked",
      lastScreen: screenTail,
      turns: updateCurrentTurns(started, () => ({
        state: "blocked" as const,
        blocked: {
          ...(kind ? { kind } : {}),
          ...(blockedMessage ? { message: blockedMessage } : {}),
        },
      })),
    });
    await persistRunSummary(started, {
      state: "blocked",
      coreStatus: "blocked",
      ...(started.sessionFile ? { sessionFile: started.sessionFile } : {}),
    }).catch(() => {});
    session.persistence?.append(started);
    session.onRecordChange?.(started);
    return {
      record: started,
      baselineTurn,
      accepted: true,
      blocked: {
        ...(kind ? { kind } : {}),
        ...(blockedMessage ? { message: blockedMessage } : {}),
        ...(screenTail ? { screenTail } : {}),
      },
    };
  }

  if (outcome.kind === "cancelled") {
    return { record: session.registry.get(record.childId) ?? started, baselineTurn, accepted: true, pending: "cancelled" };
  }

  if (outcome.kind === "startup_timeout" || outcome.kind === "wait_timeout") {
    const updated = session.registry.update(record.childId, { state: "working" });
    session.persistence?.append(updated);
    session.onRecordChange?.(updated);
    return { record: updated, baselineTurn, accepted: true, pending: "timeout" };
  }

  if (outcome.kind === "terminal_lost") {
    const finalized = await collectResultForRecord(
      session,
      session.registry.get(record.childId) ?? started,
      { ...terminal, state: "finished" },
      true,
      0,
    );
    session.notifier?.markResultDelivered(finalized.record);
    session.service?.emitSettled(finalized);
    session.persistence?.append(finalized.record);
    session.onRecordChange?.(finalized.record);
    return { record: finalized.record, baselineTurn, accepted: true, finalized, pending: "terminal_lost" };
  }

  const finalized = await collectResultForRecord(
    session,
    session.registry.get(record.childId) ?? started,
    outcome.terminal,
    true,
  );
  session.notifier?.markResultDelivered(finalized.record);
  session.service?.emitSettled(finalized);
  session.persistence?.append(finalized.record);
  session.onRecordChange?.(finalized.record);
  return { record: finalized.record, baselineTurn, accepted: true, finalized };
}

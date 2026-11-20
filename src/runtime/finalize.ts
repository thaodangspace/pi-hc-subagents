/**
 * Publish a terminal turn.
 *
 * Shared by the synchronous tool, the async monitor, control `wait`/`result`,
 * and the intertool service. It updates the in-memory record, writes
 * `result.json` atomically, and updates the bounded `run.json` summary.
 */
import path from "node:path";

import type { TerminalRecord } from "../core/hc-types.ts";
import { stripControlCharacters } from "../core/jsonl.ts";
import { updateRunMetadataFile } from "../child/child-spawn.ts";
import type { ParsedSessionFile } from "../child/session-read.ts";
import {
  type SubagentResultDetails,
  detailsText,
  formatFailureContent,
  formatResultContent,
  truncateForModel,
} from "./result-format.ts";
import { buildResultJson, writeResultFile } from "./result-store.ts";
import type { SubagentRecord, TurnOutcome } from "./types.ts";
import { coreStatusOf, updateCurrentTurns } from "./types.ts";
import type { ToolSession } from "../tools/session.ts";

/** Serialize run.json writes per file so a late observation cannot win. */
const runSummaryQueues = new Map<string, Promise<void>>();

export function recordDurationMs(record: SubagentRecord, now = Date.now()): number {
  const started = Date.parse(record.createdAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

export async function persistRunSummary(record: SubagentRecord, patch: Record<string, unknown>): Promise<void> {
  if (!record.runDir) return;
  const file = path.join(record.runDir, "run.json");
  const previous = runSummaryQueues.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => updateRunMetadataFile(file, { turn: record.turn, ...patch } as never))
    .catch(() => {});
  runSummaryQueues.set(file, next);
  await next;
  if (runSummaryQueues.get(file) === next) runSummaryQueues.delete(file);
}

export function recordDetails(
  record: SubagentRecord,
  overrides: Partial<SubagentResultDetails> & { text?: string } = {},
): SubagentResultDetails {
  const textInfo = overrides.text === undefined ? { textTruncated: false } : detailsText(overrides.text);
  return {
    childId: record.childId,
    runId: record.runId,
    agent: record.agent,
    cwd: record.cwd,
    terminal: record.terminal,
    terminalName: record.terminalName,
    state: record.state,
    outcome: null,
    sessionFile: record.sessionFile,
    resultFile: record.resultFile ?? null,
    turn: record.turn,
    durationMs: recordDurationMs(record),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
    background: record.background,
    ...(overrides.text === undefined ? {} : textInfo),
    ...overrides,
  };
}

export async function readScreenTail(session: ToolSession, terminal: string): Promise<string> {
  try {
    const read = await session.runtime.core.read(terminal, 40);
    return truncateForModel(stripControlCharacters(read.text), { maxBytes: 4000, maxLines: 40 }).text;
  } catch {
    return "";
  }
}

export interface FinalizeOptions {
  session: ToolSession;
  record: SubagentRecord;
  terminal: TerminalRecord;
  parsed: ParsedSessionFile | null;
  turnStartedAtMs: number;
  resultFile: string;
  /** Failure to use when no session result is available. */
  fallbackOutcome: TurnOutcome;
  fallbackError: string;
  parseError?: string;
  /**
   * How the settling observation arrived. Only the settle path sets it; the
   * fallback/exited paths leave it undefined.
   */
  observedBy?: "push" | "poll";
}

export interface FinalizeResult {
  result: {
    content: Array<{ type: "text"; text: string }>;
    details: SubagentResultDetails;
    usage?: ParsedSessionFile["usage"];
    isError?: boolean;
  };
  record: SubagentRecord;
  outcome: TurnOutcome;
  state: SubagentRecord["state"];
}

export async function finalizeFromSession(options: FinalizeOptions): Promise<FinalizeResult> {
  const { session, record, terminal, parsed } = options;
  const now = new Date().toISOString();
  const observedPatch: { observedBy?: "push" | "poll" } =
    options.observedBy === undefined ? {} : { observedBy: options.observedBy };

  if (!parsed || parsed.state === "pending") {
    const error = options.parseError ?? options.fallbackError;
    const updated = session.registry.update(record.childId, {
      state: "failed",
      terminalState: terminal.state,
      coreStatus: coreStatusOf(terminal),
      turn: terminal.turn,
      settledAt: now,
      error,
      ...observedPatch,
      turns: updateCurrentTurns(record, () => ({
        state: "failed" as const,
        outcome: options.fallbackOutcome,
        error,
        settledAt: now,
      })),
    });
    const resultJson = buildResultJson({
      childId: updated.childId,
      turn: Math.max(1, terminal.turn),
      state: "failed",
      outcome: options.fallbackOutcome,
      text: "",
      sessionFile: updated.sessionFile,
      terminal: updated.terminal,
      startedAt: record.turns[0]?.startedAt ?? record.createdAt,
      settledAt: now,
      error,
    });
    await writeResultFile(options.resultFile, resultJson).catch(() => {});
    await persistRunSummary(updated, {
      state: "failed",
      outcome: options.fallbackOutcome,
      sessionFile: updated.sessionFile,
      error,
      settledAt: now,
    });
    const details = recordDetails(updated, {
      state: "failed",
      outcome: options.fallbackOutcome,
      sessionFile: updated.sessionFile,
      resultFile: options.resultFile,
      error,
      code: "incomplete",
      ...observedPatch,
    });
    session.persistence?.append(updated);
    return {
      record: updated,
      outcome: options.fallbackOutcome,
      state: "failed",
      result: {
        content: [
          {
            type: "text",
            text: formatFailureContent({
              agent: updated.agent,
              outcome: options.fallbackOutcome,
              terminal: updated.terminal,
              sessionFile: updated.sessionFile,
              durationMs: details.durationMs,
              error,
              attachHint: true,
            }),
          },
        ],
        details,
        isError: true,
      },
    };
  }

  const outcome = parsed.outcome === "pending" ? "incomplete" : parsed.outcome;
  const state = parsed.state === "completed" ? "completed" : parsed.state === "cancelled" ? "cancelled" : "failed";
  const textInfo = parsed.text.length > 0 ? detailsText(parsed.text) : { textTruncated: false };
  const updated = session.registry.update(record.childId, {
    state,
    terminalState: terminal.state,
    coreStatus: coreStatusOf(terminal),
    turn: terminal.turn,
    settledAt: now,
    sessionFile: parsed.sessionFile,
    error: parsed.error,
    ...observedPatch,
    turns: updateCurrentTurns(record, () => ({
      state:
        state === "completed" ? ("completed" as const) : state === "cancelled" ? ("cancelled" as const) : ("failed" as const),
      outcome,
      text: parsed.text,
      textTruncated: textInfo.textTruncated,
      error: parsed.error,
      usage: parsed.usage,
      sessionFile: parsed.sessionFile,
      settledAt: now,
    })),
  });

  const resultJson = buildResultJson({
    childId: updated.childId,
    turn: Math.max(1, terminal.turn),
    state,
    outcome,
    text: parsed.text,
    usage: parsed.usage,
    sessionFile: parsed.sessionFile,
    terminal: updated.terminal,
    startedAt: record.turns[0]?.startedAt ?? record.createdAt,
    settledAt: now,
    error: parsed.error ?? null,
  });
  await writeResultFile(options.resultFile, resultJson).catch(() => {});
  await persistRunSummary(updated, {
    state,
    outcome,
    sessionFile: parsed.sessionFile,
    ...(parsed.error ? { error: parsed.error } : {}),
    settledAt: now,
  });

  const details = recordDetails(updated, {
    state,
    outcome,
    sessionFile: parsed.sessionFile,
    resultFile: options.resultFile,
    usage: parsed.usage,
    text: parsed.text,
    textTruncated: textInfo.textTruncated,
    branchUncertain: parsed.branchUncertain,
    error: parsed.error,
    ...(parsed.error ? { code: "error" } : {}),
    ...observedPatch,
  });

  const contentText =
    state === "failed"
      ? formatFailureContent({
          agent: updated.agent,
          outcome,
          terminal: updated.terminal,
          sessionFile: parsed.sessionFile,
          durationMs: details.durationMs,
          error: parsed.error ?? "the child turn failed",
          attachHint: true,
        })
      : formatResultContent({
          agent: updated.agent,
          state,
          outcome,
          durationMs: details.durationMs,
          turns: record.turns.length,
          usage: parsed.usage,
          terminal: updated.terminal,
          terminalName: updated.terminalName,
          sessionFile: parsed.sessionFile,
          resultFile: options.resultFile,
          text: parsed.text,
          textTruncated: textInfo.textTruncated,
          error: parsed.error,
        });

  session.persistence?.append(updated);
  return {
    record: updated,
    outcome,
    state,
    result: {
      content: [{ type: "text", text: contentText }],
      details,
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      isError: state === "failed",
    },
  };
}

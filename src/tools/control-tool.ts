/**
 * `hc_subagent_control` — inspect and manage children owned by this parent.
 *
 * Milestone 3 adds `send` over the private child pipe. Screen output remains
 * lossy and is never treated as the result.
 */
import path from "node:path";

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

import { waitForChild } from "../child/wait-child.ts";
import { updateRunMetadataFile } from "../child/child-spawn.ts";
import { locateSessionFile } from "../child/session-locate.ts";
import { parseSessionWithRetry } from "../child/session-read.ts";
import { describeHcError, toHcSubagentError } from "../core/error.ts";
import { stripControlCharacters } from "../core/jsonl.ts";
import type { TerminalRecord } from "../core/hc-types.ts";
import { formatCandidates, resolveChildId } from "../runtime/id-resolve.ts";
import {
  type ModelFacingResult,
  type ResultVerbosity,
  type SubagentResultDetails,
  detailsText,
  formatBlockedContent,
  formatFailureContent,
  formatPendingContent,
  formatResultContent,
  modelFacingResult,
  truncateForModel,
} from "../runtime/result-format.ts";
import { readResultFile } from "../runtime/result-store.ts";
import { ChildStateMachine } from "../runtime/state-machine.ts";
import { wakeSourceFor } from "../runtime/settle-hints.ts";
import { renderSubagentToolResult } from "../ui/renderers.ts";
import type { SubagentRecord, SubagentState } from "../runtime/types.ts";
import { finalizeFromSession } from "../runtime/finalize.ts";
import { sendFollowUp } from "../runtime/follow-up.ts";
import type { ToolSession } from "./session.ts";

const ControlParams = Type.Object({
  action: StringEnum(["list", "wait", "output", "result", "attach", "interrupt", "kill", "send"] as const),
  id: Type.Optional(Type.String({ description: "Child id, terminal address/name, or slug" })),
  timeoutMs: Type.Optional(Type.Number()),
  lines: Type.Optional(Type.Number({ description: "For output; default 60" })),
  includeFinished: Type.Optional(Type.Boolean({ description: "For list; default true" })),
  message: Type.Optional(
    Type.String({ description: "For send; follow-up text delivered over the private pipe to a live child" }),
  ),
  wait: Type.Optional(Type.Boolean({ description: "For send; wait for the new turn. Default true" })),
  verbosity: Type.Optional(
    StringEnum(["summary", "full"] as const, {
      description:
        "Result detail for wait and result: summary (default, ~8 KiB, handoff section only) or full (up to 50 KiB). Ignored by list, output, attach, interrupt, kill, and send.",
    }),
  ),
});

type ControlParamsType = Static<typeof ControlParams>;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 1_800_000;

function durationOf(record: SubagentRecord): number {
  const started = Date.parse(record.createdAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

function detailsFor(
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
    durationMs: durationOf(record),
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.signal === undefined ? {} : { signal: record.signal }),
    background: record.background,
    ...(record.observedBy === undefined ? {} : { observedBy: record.observedBy }),
    ...(overrides.text === undefined ? {} : textInfo),
    ...overrides,
  };
}

function errorResult(
  message: string,
  code: string,
  details: SubagentResultDetails,
): AgentToolResult<SubagentResultDetails> {
  return {
    content: [{ type: "text", text: `[hc_subagent_control failed]\n${message}` }],
    details: { ...details, error: message, code },
    isError: true,
  };
}

function unknownDetails(): SubagentResultDetails {
  return {
    childId: "",
    runId: "",
    agent: "",
    cwd: "",
    terminal: "",
    terminalName: "",
    state: "failed",
    outcome: null,
    sessionFile: null,
    resultFile: null,
    turn: 0,
    durationMs: 0,
  };
}

function validateTimeout(value: number | undefined): string | null {
  if (value === undefined) return null;
  if (!Number.isFinite(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    return `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`;
  }
  return null;
}

async function findSessionFile(session: ToolSession, record: SubagentRecord, timeoutMs = 2000): Promise<string | null> {
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

function turnStartedAtMs(record: SubagentRecord): number {
  const last = record.turns.at(-1);
  if (last?.startedAtMs) return last.startedAtMs;
  const iso = last?.startedAt ?? record.createdAt;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

interface CollectedResult {
  result: AgentToolResult<SubagentResultDetails>;
  record: SubagentRecord;
}

async function collectResult(
  session: ToolSession,
  record: SubagentRecord,
  terminal: TerminalRecord,
  final: boolean,
  verbosity?: ResultVerbosity,
  waitMs = 2000,
): Promise<CollectedResult> {
  const file = await findSessionFile(session, record, waitMs);
  const resultFile = record.resultFile ?? (record.runDir ? path.join(record.runDir, "result.json") : "");
  if (!file) {
    return finalizeFromSession({
      session,
      record,
      terminal,
      parsed: null,
      turnStartedAtMs: turnStartedAtMs(record),
      resultFile,
      fallbackOutcome: final ? "incomplete" : "exited",
      fallbackError: "no session file is available for this child",
      ...(verbosity === undefined ? {} : { verbosity }),
    });
  }
  const parsed = await parseSessionWithRetry(file, {
    turnStartedAtMs: turnStartedAtMs(record),
    final,
  }).catch(() => null);
  return finalizeFromSession({
    session,
    record,
    terminal,
    parsed,
    turnStartedAtMs: turnStartedAtMs(record),
    resultFile,
    fallbackOutcome: final ? "incomplete" : "exited",
    fallbackError: "could not parse a result for this turn",
    ...(verbosity === undefined ? {} : { verbosity }),
  });
}

function isTerminalRecord(record: SubagentRecord): boolean {
  return (
    record.state === "completed" ||
    record.state === "failed" ||
    record.state === "cancelled" ||
    record.terminalState === "finished"
  );
}

async function storedResult(
  session: ToolSession,
  record: SubagentRecord,
  verbosity?: ResultVerbosity,
): Promise<CollectedResult | null> {
  if (!record.resultFile) return null;
  const stored = await readResultFile(record.resultFile);
  if (!stored) return null;
  // Computed once: the same selection feeds the content and the two flags.
  const facing: ModelFacingResult = modelFacingResult(stored.text, { verbosity });
  const details = detailsFor(record, {
    state: stored.state,
    outcome: stored.outcome,
    sessionFile: stored.sessionFile,
    resultFile: record.resultFile,
    usage: stored.usage,
    text: stored.text,
    textTruncated: stored.textTruncated,
    handoff: facing.handoff,
    contentCondensed: facing.condensed,
    ...(stored.error ? { error: stored.error } : {}),
  });
  const content =
    stored.state === "failed"
      ? formatFailureContent({
          agent: record.agent,
          outcome: stored.outcome,
          terminal: record.terminal,
          sessionFile: stored.sessionFile,
          durationMs: details.durationMs,
          error: stored.error ?? "the child turn failed",
          attachHint: true,
        })
      : formatResultContent({
          agent: record.agent,
          state: stored.state,
          outcome: stored.outcome,
          durationMs: details.durationMs,
          turns: record.turns.length,
          usage: stored.usage,
          terminal: record.terminal,
          terminalName: record.terminalName,
          sessionFile: stored.sessionFile,
          resultFile: record.resultFile,
          text: stored.text,
          textTruncated: stored.textTruncated,
          error: stored.error ?? undefined,
          ...(verbosity === undefined ? {} : { verbosity }),
          facing,
        });
  return {
    record,
    result: {
      content: [{ type: "text", text: content }],
      details,
      ...(stored.usage ? { usage: stored.usage } : {}),
      isError: stored.state === "failed",
    },
  };
}

async function listAction(session: ToolSession, params: ControlParamsType): Promise<AgentToolResult<SubagentResultDetails>> {
  const records = session.registry.listForParent(session.runtime.parentSessionId, {
    includeFinished: params.includeFinished ?? true,
  });
  if (records.length === 0) {
    return {
      content: [{ type: "text", text: "No subagents for this session." }],
      details: { ...unknownDetails(), state: "completed", outcome: null },
    };
  }
  const lines = records.map((record) => {
    const duration = Math.round(durationOf(record) / 1000);
    return `${record.slug}  ${record.state}  ${record.terminal}  ${record.agent}  ${record.cwd}  turn ${record.turn}  ${duration}s`;
  });
  const subagents = records.map((record) => ({
    childId: record.childId,
    runId: record.runId,
    agent: record.agent,
    state: record.state,
    terminal: record.terminal,
    terminalName: record.terminalName,
    cwd: record.cwd,
    turn: record.turn,
    durationMs: durationOf(record),
  }));
  const first = records[0] as SubagentRecord;
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { ...detailsFor(first), state: first.state, subagents } as SubagentResultDetails & {
      subagents: typeof subagents;
    },
  };
}

async function waitAction(
  session: ToolSession,
  record: SubagentRecord,
  params: ControlParamsType,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<SubagentResultDetails>> {
  const verbosity = params.verbosity as ResultVerbosity | undefined;
  if (isTerminalRecord(record)) {
    const stored = await storedResult(session, record, verbosity);
    if (stored) {
      session.notifier?.markResultDelivered(stored.record);
      return stored.result;
    }
    const existing = await session.runtime.core.tryGet(record.terminal);
    if (!existing) {
      return errorResult(
        `terminal ${record.terminal} is gone and no result file was found`,
        "not_settled",
        detailsFor(record, { code: "not_settled" }),
      );
    }
    const collected = await collectResult(session, record, existing, true, verbosity);
    session.notifier?.markResultDelivered(collected.record);
    return collected.result;
  }

  let terminal = await session.runtime.core.tryGet(record.terminal);
  if (!terminal) {
    return errorResult(`terminal ${record.terminal} no longer exists`, "not_found", detailsFor(record, { code: "not_found" }));
  }
  session.registry.applyTerminal(record.childId, terminal);

  const machine = new ChildStateMachine({
    baselineTurn: record.turn,
    startupTimeoutMs: session.runtime.config.startupTimeoutMs,
    waitTimeoutMs: params.timeoutMs ?? session.runtime.config.waitTimeoutMs,
    initialPhase: record.state === "starting" ? "starting" : "working",
    ...(record.turns.at(-1)?.startedAtMs === undefined
      ? {}
      : { startedAtMs: record.turns.at(-1)?.startedAtMs }),
  });

  // A wait on an existing child starts a fresh episode if its previous one was
  // closed; `start` is a no-op while the subscription is live.
  if (record.pipeName) session.settleHints?.start(record.childId, record.pipeName);
  const wake = wakeSourceFor(session.settleHints, record.childId);
  const outcome = await waitForChild({
    core: session.runtime.core,
    terminal: record.terminal,
    machine,
    pollIntervalMs: session.runtime.config.pollIntervalMs,
    ...(signal === undefined ? {} : { signal }),
    ...(wake === undefined ? {} : { wake }),
    onObservation(next) {
      session.registry.applyTerminal(record.childId, next);
    },
  });

  switch (outcome.kind) {
    case "settled":
    case "exited": {
      const collected = await collectResult(session, record, outcome.terminal, true, verbosity);
      session.notifier?.markResultDelivered(collected.record);
      return collected.result;
    }
    case "blocked": {
      const kind = outcome.transition.type === "blocked" ? outcome.transition.kind : null;
      const message = outcome.transition.type === "blocked" ? outcome.transition.message : null;
      let screenTail = "";
      try {
        screenTail = truncateForModel(stripControlCharacters((await session.runtime.core.read(record.terminal, 40)).text), {
          maxBytes: 4000,
          maxLines: 40,
        }).text;
      } catch {
        // screen is advisory
      }
      const updated = session.registry.update(record.childId, {
        state: "blocked",
        coreStatus: "blocked",
        lastScreen: screenTail,
      });
      return {
        content: [
          {
            type: "text",
            text: formatBlockedContent({
              agent: updated.agent,
              terminal: updated.terminal,
              terminalName: updated.terminalName,
              kind,
              message,
              screenTail,
              durationMs: durationOf(updated),
            }),
          },
        ],
        details: detailsFor(updated, {
          state: "blocked",
          outcome: "blocked",
          blocked: {
            ...(kind ? { kind } : {}),
            ...(message ? { message } : {}),
            ...(screenTail ? { screenTail } : {}),
          },
        }),
        isError: false,
      };
    }
    case "startup_timeout":
    case "wait_timeout": {
      const state: SubagentState = outcome.kind === "startup_timeout" ? "starting" : "working";
      const updated = session.registry.update(record.childId, { state });
      return {
        content: [
          {
            type: "text",
            text: formatPendingContent({
              agent: updated.agent,
              state,
              coreStatus: updated.coreStatus,
              terminal: updated.terminal,
              terminalName: updated.terminalName,
              sessionFile: updated.sessionFile,
              durationMs: durationOf(updated),
              reason: outcome.kind,
            }),
          },
        ],
        details: detailsFor(updated, { state, outcome: "timeout" }),
        isError: false,
      };
    }
    case "cancelled":
      terminal = outcome.terminal ?? terminal;
      return {
        content: [{ type: "text", text: `wait aborted for ${record.slug}; the child was left running.` }],
        details: detailsFor(record, { code: "aborted" }),
        isError: false,
      };
    case "terminal_lost":
      return (await collectResult(session, record, terminal, true, verbosity, 0)).result;
  }
}

async function outputAction(
  session: ToolSession,
  record: SubagentRecord,
  params: ControlParamsType,
): Promise<AgentToolResult<SubagentResultDetails>> {
  const lines = Math.min(1000, Math.max(1, Math.round(params.lines ?? 60)));
  try {
    const read = await session.runtime.core.read(record.terminal, lines);
    const text = truncateForModel(stripControlCharacters(read.text), { maxBytes: 20 * 1024, maxLines: 200 }).text;
    const content = [
      "[Subagent screen output — lossy, not a result]",
      `agent: ${record.agent}`,
      `terminal: ${record.terminal} (${record.terminalName})`,
      `state: ${record.state} (${record.coreStatus})`,
      `read: ${read.how}${read.complete ? "" : " (incomplete)"}`,
      "",
      text.length > 0 ? text : "(empty screen)",
    ].join("\n");
    return {
      content: [{ type: "text", text: content }],
      details: { ...detailsFor(record), lossy: true } as SubagentResultDetails & { lossy: boolean },
    };
  } catch (error) {
    const normalized = toHcSubagentError(error);
    return errorResult(describeHcError(error), normalized.code, detailsFor(record, { code: normalized.code }));
  }
}

async function resultAction(
  session: ToolSession,
  record: SubagentRecord,
  params: ControlParamsType,
): Promise<AgentToolResult<SubagentResultDetails>> {
  const verbosity = params.verbosity as ResultVerbosity | undefined;
  const stored = await storedResult(session, record, verbosity);
  if (stored) {
    session.notifier?.markResultDelivered(stored.record);
    return stored.result;
  }
  if (isTerminalRecord(record)) {
    const terminal = await session.runtime.core.tryGet(record.terminal);
    if (!terminal) {
      return errorResult(
        `terminal ${record.terminal} is gone and no result file was found`,
        "not_settled",
        detailsFor(record, { code: "not_settled" }),
      );
    }
    const collected = await collectResult(session, record, terminal, true, verbosity);
    session.notifier?.markResultDelivered(collected.record);
    return collected.result;
  }

  const terminal = await session.runtime.core.tryGet(record.terminal);
  if (!terminal) {
    return errorResult(`terminal ${record.terminal} no longer exists`, "not_found", detailsFor(record, { code: "not_found" }));
  }
  const file = await findSessionFile(session, record, 1000);
  if (!file) {
    return errorResult(
      "the current turn is not settled yet (session file not found)",
      "not_settled",
      detailsFor(record, { code: "not_settled" }),
    );
  }
  const parsed = await parseSessionWithRetry(
    file,
    { turnStartedAtMs: turnStartedAtMs(record), final: false },
    { attempts: 1 },
  ).catch(() => null);
  if (!parsed || parsed.state === "pending") {
    return errorResult(
      "the current turn is not settled yet",
      "not_settled",
      detailsFor(record, { code: "not_settled" }),
    );
  }
  const collected = await collectResult(session, record, terminal, false, verbosity);
  session.notifier?.markResultDelivered(collected.record);
  return collected.result;
}

async function attachAction(
  session: ToolSession,
  record: SubagentRecord,
): Promise<AgentToolResult<SubagentResultDetails>> {
  const content = [
    `hc attach ${record.terminal}`,
    "",
    `agent: ${record.agent}`,
    `state: ${record.state} (${record.coreStatus})`,
    `session: ${record.sessionFile ?? "(not discovered yet)"}`,
    `directory: ${record.cwd}`,
  ].join("\n");
  return { content: [{ type: "text", text: content }], details: detailsFor(record) };
}

async function interruptAction(
  session: ToolSession,
  record: SubagentRecord,
): Promise<AgentToolResult<SubagentResultDetails>> {
  try {
    const result = await session.runtime.core.interrupt(record.terminal);
    const terminal = await session.runtime.core.tryGet(record.terminal);
    if (terminal) session.registry.applyTerminal(record.childId, terminal);
    return {
      content: [
        {
          type: "text",
          text: `interrupted ${record.terminal}: ${result.outcome} (key ${result.key})`,
        },
      ],
      details: { ...detailsFor(record), interrupt: result } as SubagentResultDetails & {
        interrupt: typeof result;
      },
    };
  } catch (error) {
    const normalized = toHcSubagentError(error);
    return errorResult(describeHcError(error), normalized.code, detailsFor(record, { code: normalized.code }));
  }
}

async function killAction(
  session: ToolSession,
  record: SubagentRecord,
): Promise<AgentToolResult<SubagentResultDetails>> {
  session.monitors?.stop(record.childId);
  let terminalError: string | null = null;
  try {
    await session.runtime.core.kill(record.terminal);
  } catch (error) {
    const normalized = toHcSubagentError(error);
    if (normalized.code !== "not_found" && normalized.code !== "finished") terminalError = describeHcError(error);
  }
  if (terminalError) {
    return errorResult(terminalError, "unavailable", detailsFor(record, { code: "unavailable" }));
  }
  await session.runtime.core.remove(record.terminal).catch(() => {});
  const now = new Date().toISOString();
  const updated = session.registry.update(record.childId, {
    state: "cancelled",
    terminalState: "finished",
    settledAt: now,
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
      ...(updated.sessionFile ? { sessionFile: updated.sessionFile } : {}),
      settledAt: now,
    }).catch(() => {});
  }
  session.notifier?.markResultDelivered(updated);
  session.service?.emitCancelled(updated);
  session.persistence?.append(updated);
  session.onRecordChange?.(updated);
  return {
    content: [{ type: "text", text: `killed ${updated.slug} (${updated.terminal}). Run files were kept for inspection.` }],
    details: detailsFor(updated, { state: "cancelled", outcome: "aborted" }),
  };
}

async function sendAction(
  session: ToolSession,
  record: SubagentRecord,
  params: ControlParamsType,
  signal: AbortSignal | undefined,
): Promise<AgentToolResult<SubagentResultDetails>> {
  if (typeof params.message !== "string" || params.message.trim().length === 0) {
    return errorResult("send requires a non-empty message", "validation", detailsFor(record, { code: "validation" }));
  }
  try {
    const outcome = await sendFollowUp(session, record, {
      message: params.message,
      wait: params.wait ?? true,
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });

    if (outcome.finalized) {
      session.notifier?.markResultDelivered(outcome.record);
      return outcome.finalized.result;
    }

    if (outcome.blocked) {
      const content = formatBlockedContent({
        agent: outcome.record.agent,
        terminal: outcome.record.terminal,
        terminalName: outcome.record.terminalName,
        kind: outcome.blocked.kind,
        message: outcome.blocked.message,
        screenTail: outcome.blocked.screenTail,
        durationMs: durationOf(outcome.record),
      });
      return {
        content: [{ type: "text", text: content }],
        details: detailsFor(outcome.record, {
          state: "blocked",
          outcome: "blocked",
          blocked: outcome.blocked,
        }),
        isError: false,
      };
    }

    if (outcome.pending === "timeout") {
      return {
        content: [
          {
            type: "text",
            text: formatPendingContent({
              agent: outcome.record.agent,
              state: "working",
              coreStatus: outcome.record.coreStatus,
              terminal: outcome.record.terminal,
              terminalName: outcome.record.terminalName,
              sessionFile: outcome.record.sessionFile,
              durationMs: durationOf(outcome.record),
              reason: "wait_timeout",
            }),
          },
        ],
        details: detailsFor(outcome.record, { state: "working", outcome: "timeout" }),
        isError: false,
      };
    }

    if (outcome.pending === "cancelled") {
      return {
        content: [{ type: "text", text: `follow-up was delivered to ${record.slug}, but the wait was cancelled.` }],
        details: detailsFor(outcome.record, { state: "working", outcome: null, code: "aborted" }),
        isError: false,
      };
    }

    const hint =
      outcome.record.background && session.monitors
        ? "The result will be delivered as a custom message when the new turn settles."
        : "Use hc_subagent_control wait or result to retrieve the new turn.";
    return {
      content: [
        {
          type: "text",
          text: [
            `sent follow-up to ${outcome.record.slug} (${outcome.record.terminal})`,
            `turn: ${outcome.baselineTurn} -> new turn appended`,
            hint,
          ].join("\n"),
        },
      ],
      details: detailsFor(outcome.record, { state: "working", outcome: null }),
    };
  } catch (error) {
    const normalized = toHcSubagentError(error);
    const hint = normalized.hint ? `\n${normalized.hint}` : "";
    return errorResult(`${describeHcError(error)}${hint}`, normalized.code, detailsFor(record, { code: normalized.code }));
  }
}

export interface ControlToolOptions {
  exposure?: "direct" | "model-only";
}

export function registerControlTool(
  pi: ExtensionAPI,
  getSession: () => ToolSession | null,
  options: ControlToolOptions = {},
): void {
  pi.registerTool({
    name: "hc_subagent_control",
    ...(options.exposure === "model-only" ? { exposure: "model-only" as const } : {}),
    label: "HC Subagent Control",
    description:
      "Inspect and manage hc subagents owned by this session: list, wait, output, result, attach, interrupt, kill, send. send only works while the child is live; a child cannot be resumed after /reload or a parent restart.",
    promptSnippet:
      "Inspect or manage hc subagents (list, wait, output, result, attach, interrupt, kill, send).",
    promptGuidelines: [
      "Use hc_subagent_control wait or result instead of sleeping or polling for a subagent.",
      "Use hc_subagent_control output only for debugging; screen output is lossy and never the authoritative result.",
      "Never answer a blocked subagent's dialog; use hc_subagent_control attach to tell the user how to attach.",
      "Use hc_subagent_control send for a follow-up only while the child is live; it appends a new turn and never types into the terminal.",
      "After /reload or a parent restart a child cannot be resumed or reattached; start a new child instead of trying send.",
    ],
    parameters: ControlParams,
    renderResult(result, { expanded }, theme) {
      return renderSubagentToolResult(result as never, { expanded }, theme);
    },
    async execute(_toolCallId, params, signal) {
      const session = getSession();
      if (!session) {
        return errorResult("hc-subagents is not ready", "unavailable", unknownDetails());
      }
      const timeoutIssue = validateTimeout(params.timeoutMs);
      if (timeoutIssue) return errorResult(timeoutIssue, "validation", unknownDetails());

      if (params.action === "list") return listAction(session, params);

      const id = params.id?.trim() ?? "";
      if (id.length === 0) {
        return errorResult(`${params.action} requires an id`, "validation", unknownDetails());
      }
      const resolved = resolveChildId(session.registry, id);
      if (resolved.kind === "not_found") {
        return errorResult(resolved.message, "not_found", unknownDetails());
      }
      if (resolved.kind === "ambiguous") {
        return errorResult(
          `${resolved.message}\n${formatCandidates(resolved.candidates)}`,
          "ambiguous",
          unknownDetails(),
        );
      }
      const record = resolved.record;
      if (record.parentSessionId !== session.runtime.parentSessionId) {
        return errorResult(`no subagent matches "${id}"`, "not_found", unknownDetails());
      }

      switch (params.action) {
        case "wait":
          return waitAction(session, record, params, signal);
        case "output":
          return outputAction(session, record, params);
        case "result":
          return resultAction(session, record, params);
        case "attach":
          return attachAction(session, record);
        case "interrupt":
          return interruptAction(session, record);
        case "kill":
          return killAction(session, record);
        case "send":
          return sendAction(session, record, params, signal);
        default:
          return errorResult(`unsupported action ${params.action}`, "validation", unknownDetails());
      }
    },
  });
}

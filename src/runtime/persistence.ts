/**
 * Bounded session-local persistence.
 *
 * Only identifiers, paths, states, usage, and timestamps are appended with
 * `pi.appendEntry`. Task text and result text never enter session entries.
 */
import type { AgentAccess, AgentSourceKind, ThinkingLevel } from "../agents/agents.ts";
import type {
  SubagentRecord,
  SubagentState,
  TurnOutcome,
  Usage,
} from "./types.ts";

export const RUN_ENTRY_TYPE = "hc-subagents-run";
export const PERSISTENCE_VERSION = 1;

export interface PersistedTurnRef {
  startedAt: string;
  startedAtMs?: number;
  baselineTurn: number;
}

export interface PersistedRunSummary {
  version: 1;
  runId: string;
  childId: string;
  parentSessionId: string;
  agent: string;
  agentSource: AgentSourceKind;
  agentAccess: AgentAccess;
  cwd: string;
  terminal: string;
  terminalName: string;
  sessionId: string;
  sessionFile: string | null;
  pipeName?: string;
  runDir: string;
  resultFile: string;
  slug: string;
  state: SubagentState;
  background: boolean;
  origin: string;
  turn: number;
  createdAt: string;
  updatedAt: string;
  settledAt?: string;
  outcome?: TurnOutcome;
  usage?: Usage;
  error?: string;
  model?: string;
  thinking?: ThinkingLevel;
  labels: Record<string, string>;
  lastTurn?: PersistedTurnRef;
}

export interface PersistenceEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

export interface PersistenceSink {
  appendEntry(customType: string, data: unknown): void;
  getEntries(): PersistenceEntry[];
}

const AGENT_SOURCES: readonly AgentSourceKind[] = ["user", "project", "package"];
const AGENT_ACCESS: readonly AgentAccess[] = ["read-only", "write"];
const STATES: readonly SubagentState[] = [
  "queued",
  "starting",
  "working",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toPersistedSummary(record: SubagentRecord): PersistedRunSummary {
  const last = record.turns.at(-1);
  return {
    version: PERSISTENCE_VERSION,
    runId: record.runId,
    childId: record.childId,
    parentSessionId: record.parentSessionId,
    agent: record.agent,
    agentSource: record.agentSource,
    agentAccess: record.agentAccess,
    cwd: record.cwd,
    terminal: record.terminal,
    terminalName: record.terminalName,
    sessionId: record.sessionId,
    sessionFile: record.sessionFile,
    ...(record.pipeName ? { pipeName: record.pipeName } : {}),
    runDir: record.runDir ?? "",
    resultFile: record.resultFile ?? "",
    slug: record.slug,
    state: record.state,
    background: record.background,
    origin: record.origin,
    turn: record.turn,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.settledAt ? { settledAt: record.settledAt } : {}),
    ...(last?.outcome ? { outcome: last.outcome } : {}),
    ...(last?.usage ? { usage: last.usage } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.model ? { model: record.model } : {}),
    ...(record.thinking ? { thinking: record.thinking } : {}),
    labels: { ...record.labels },
    ...(last
      ? {
          lastTurn: {
            startedAt: last.startedAt,
            ...(last.startedAtMs === undefined ? {} : { startedAtMs: last.startedAtMs }),
            baselineTurn: last.baselineTurn,
          },
        }
      : {}),
  };
}

/** Parse one entry defensively; unknown or malformed summaries are ignored. */
export function parsePersistedSummary(value: unknown): PersistedRunSummary | null {
  if (!isRecord(value)) return null;
  if (value.version !== PERSISTENCE_VERSION) return null;
  if (typeof value.childId !== "string" || value.childId.length === 0) return null;
  if (typeof value.parentSessionId !== "string" || value.parentSessionId.length === 0) return null;
  if (typeof value.runId !== "string" || value.runId.length === 0) return null;
  if (typeof value.terminal !== "string" || value.terminal.length === 0) return null;
  if (typeof value.state !== "string" || !(STATES as readonly string[]).includes(value.state)) return null;
  if (typeof value.agent !== "string") return null;
  if (typeof value.agentSource !== "string" || !(AGENT_SOURCES as readonly string[]).includes(value.agentSource)) {
    return null;
  }
  if (typeof value.agentAccess !== "string" || !(AGENT_ACCESS as readonly string[]).includes(value.agentAccess)) {
    return null;
  }
  if (typeof value.createdAt !== "string" || typeof value.updatedAt !== "string") return null;
  if (!isRecord(value.labels)) return null;

  const summary: PersistedRunSummary = {
    version: 1,
    runId: value.runId,
    childId: value.childId,
    parentSessionId: value.parentSessionId,
    agent: value.agent,
    agentSource: value.agentSource as AgentSourceKind,
    agentAccess: value.agentAccess as AgentAccess,
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    terminal: value.terminal,
    terminalName: typeof value.terminalName === "string" ? value.terminalName : value.terminal,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : value.childId,
    sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : null,
    runDir: typeof value.runDir === "string" ? value.runDir : "",
    resultFile: typeof value.resultFile === "string" ? value.resultFile : "",
    slug: typeof value.slug === "string" ? value.slug : value.agent,
    state: value.state as SubagentState,
    background: value.background === true,
    origin: typeof value.origin === "string" ? value.origin : "tool",
    turn: typeof value.turn === "number" && Number.isInteger(value.turn) ? value.turn : 0,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    labels: Object.fromEntries(
      Object.entries(value.labels).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
  };
  if (typeof value.settledAt === "string") summary.settledAt = value.settledAt;
  if (typeof value.pipeName === "string") summary.pipeName = value.pipeName;
  if (typeof value.outcome === "string") summary.outcome = value.outcome as TurnOutcome;
  if (isRecord(value.usage)) summary.usage = value.usage as unknown as Usage;
  if (typeof value.error === "string") summary.error = value.error;
  if (typeof value.model === "string") summary.model = value.model;
  if (typeof value.thinking === "string") summary.thinking = value.thinking as ThinkingLevel;
  if (isRecord(value.lastTurn) && typeof value.lastTurn.startedAt === "string") {
    summary.lastTurn = {
      startedAt: value.lastTurn.startedAt,
      ...(typeof value.lastTurn.startedAtMs === "number" ? { startedAtMs: value.lastTurn.startedAtMs } : {}),
      baselineTurn:
        typeof value.lastTurn.baselineTurn === "number" && Number.isInteger(value.lastTurn.baselineTurn)
          ? value.lastTurn.baselineTurn
          : 0,
    };
  }
  return summary;
}

/** Latest summary per child, scoped to one parent session. */
export function summariesForParent(
  entries: PersistenceEntry[],
  parentSessionId: string,
): PersistedRunSummary[] {
  const byChild = new Map<string, PersistedRunSummary>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== RUN_ENTRY_TYPE) continue;
    const summary = parsePersistedSummary(entry.data);
    if (!summary || summary.parentSessionId !== parentSessionId) continue;
    const previous = byChild.get(summary.childId);
    if (!previous || previous.updatedAt <= summary.updatedAt) byChild.set(summary.childId, summary);
  }
  return [...byChild.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export class RunPersistence {
  readonly #sink: PersistenceSink;
  readonly #lastWritten = new Map<string, string>();

  constructor(sink: PersistenceSink) {
    this.#sink = sink;
  }

  append(record: SubagentRecord): void {
    const summary = toPersistedSummary(record);
    const serialized = JSON.stringify(summary);
    if (this.#lastWritten.get(record.childId) === serialized) return;
    try {
      this.#sink.appendEntry(RUN_ENTRY_TYPE, summary);
      this.#lastWritten.set(record.childId, serialized);
    } catch {
      // Persistence is best effort; run.json remains authoritative.
    }
  }

  restore(parentSessionId: string): PersistedRunSummary[] {
    let entries: PersistenceEntry[];
    try {
      entries = this.#sink.getEntries();
    } catch {
      return [];
    }
    const summaries = summariesForParent(entries, parentSessionId);
    for (const summary of summaries) this.#lastWritten.set(summary.childId, JSON.stringify(summary));
    return summaries;
  }
}

/** Merge summary lists, keeping the latest `updatedAt` per child. */
export function mergeSummaries(
  ...lists: Array<readonly PersistedRunSummary[]>
): PersistedRunSummary[] {
  const byChild = new Map<string, PersistedRunSummary>();
  for (const list of lists) {
    for (const summary of list) {
      const previous = byChild.get(summary.childId);
      if (!previous || previous.updatedAt <= summary.updatedAt) byChild.set(summary.childId, summary);
    }
  }
  return [...byChild.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

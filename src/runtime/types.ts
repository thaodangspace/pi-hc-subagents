/**
 * Shared data model for parent-side runs.
 */
import type { TerminalRecord } from "../core/hc-types.ts";
import type { AgentAccess, AgentSource, ThinkingLevel } from "../agents/agents.ts";

export type { ThinkingLevel };

export type SubagentState =
  | "queued"
  | "starting"
  | "working"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

export type TurnOutcome =
  | "stop"
  | "length"
  | "error"
  | "aborted"
  | "blocked"
  | "exited"
  | "timeout"
  | "spawn_failed"
  | "incomplete"
  | "no_text";

export type TurnState = "running" | "completed" | "failed" | "aborted" | "blocked" | "cancelled";

export type CoreStatusWord = "idle" | "working" | "done" | "blocked" | "error" | "unknown";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export interface TurnRecord {
  index: number;
  task: string;
  startedAt: string;
  settledAt?: string;
  baselineTurn: number;
  state: TurnState;
  outcome?: TurnOutcome;
  text?: string;
  textTruncated?: boolean;
  error?: string;
  usage?: Usage;
  sessionFile?: string;
  terminal: string;
  blocked?: { kind?: string; message?: string };
}

export interface SubagentRecord {
  version: 1;
  runId: string;
  childId: string;
  parentSessionId: string;
  agent: string;
  agentSource: AgentSource;
  agentAccess: AgentAccess;
  cwd: string;
  terminal: string;
  terminalName: string;
  sessionId: string;
  sessionFile: string | null;
  model?: string;
  thinking?: ThinkingLevel;
  state: SubagentState;
  terminalState: "live" | "finished";
  coreStatus: CoreStatusWord;
  slug: string;
  turn: number;
  turns: TurnRecord[];
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  settledAt?: string;
  exitCode?: number | null;
  signal?: number | null;
  labels: Record<string, string>;
  background: boolean;
  origin: string;
  lastScreen?: string;
  error?: string;
}

export function coreStatusOf(terminal: TerminalRecord): CoreStatusWord {
  const state = terminal.status?.state;
  if (state === "idle" || state === "working" || state === "done" || state === "blocked" || state === "error") {
    return state;
  }
  return "unknown";
}

export function isTerminalRecordState(record: SubagentRecord): boolean {
  return (
    record.state === "completed" ||
    record.state === "failed" ||
    record.state === "cancelled" ||
    record.terminalState === "finished"
  );
}

export function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

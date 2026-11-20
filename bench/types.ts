/**
 * Benchmark types.
 *
 * Records carry identifiers, states, paths, and usage only. Task text, result
 * text, and transcript bytes never reach `trials.jsonl` or `metrics.json`.
 */

export type Arm = "solo" | "subagent" | "routing" | "transcript";

/** Arms `BENCH_ARMS` accepts. */
export const ALL_ARMS: Arm[] = ["solo", "subagent", "routing", "transcript"];

/**
 * Arms a run gets when `BENCH_ARMS` is unset. `routing` is opt-in: it needs
 * `BENCH_CHILD_MODEL` and would otherwise duplicate `subagent`.
 */
export const DEFAULT_ARMS: Arm[] = ["solo", "subagent", "transcript"];

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  costUsd: number;
}

/** `input + cacheRead + cacheWrite`: tokens the provider actually processed. */
export function billedTokens(usage: UsageTotals): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

export function emptyUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, costUsd: 0 };
}

export function addUsage(into: UsageTotals, from: UsageTotals): void {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheWrite += from.cacheWrite;
  into.reasoning += from.reasoning;
  into.totalTokens += from.totalTokens;
  into.costUsd += from.costUsd;
}

export interface ExpectSpec {
  /** Every entry must appear in the answer. */
  all?: string[];
  /** At least one entry must appear. */
  any?: string[];
  /** No entry may appear. */
  none?: string[];
}

export interface TaskSpec {
  id: string;
  prompt: string;
  expect: ExpectSpec;
  timeoutMs?: number;
}

export interface TaskSuite {
  id: string;
  description?: string;
  fixture: string;
  /** Paths relative to the fixture root that are never copied into a trial. */
  exclude?: string[];
  agent: string;
  tools: string[];
  timeoutMs: number;
  tasks: TaskSpec[];
}

export interface SessionSummary {
  /** Absolute path; recorded because it is the authoritative artifact. */
  file: string;
  bytes: number;
  turns: number;
  usage: UsageTotals;
  /** Largest prompt sent in one turn: input + cacheRead + cacheWrite + output. */
  peakContext: number;
  /** Bytes of tool results the model received in this session. */
  toolResultBytes: number;
  /** Bytes of assistant text produced in this session. */
  assistantTextBytes: number;
}

export interface ChildSummary {
  runId: string;
  sessionFile: string;
  state: string | null;
  agent: string | null;
  usage: UsageTotals;
  peakContext: number;
}

export interface TrialRecord {
  version: 1;
  trialKey: string;
  arm: Arm;
  taskId: string;
  trial: number;
  repeats: number;
  startedAt: string;
  durationMs: number;
  exitCode: number;
  timedOut: boolean;
  resolved: boolean;
  missing: string[];
  model: string;
  /** Model pinned for delegated children; null for arms without a child. */
  childModel?: string | null;
  parent: SessionSummary | null;
  children: ChildSummary[];
  /** parent + children. */
  usage: UsageTotals;
  /** Parent billed tokens; the denominator for context amplification. */
  parentBilled: number;
  /** children billed divided by parent billed, or null when the arm has no child. */
  contextAmplification: number | null;
  /** Parent tool-result bytes divided by child session bytes. */
  returnedShare: number | null;
  error: string | null;
}

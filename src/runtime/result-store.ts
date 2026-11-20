/**
 * `result.json` publication.
 *
 * Written atomically with mode 0600 after a terminal turn. Full text is kept up
 * to 10 MiB; larger results keep a head and tail and mark `textTruncated`.
 * `blocked` and `working` turns never publish a result file.
 */
import { readFile } from "node:fs/promises";

import { emptyUsage, type SubagentState, type TurnOutcome, type Usage } from "./types.ts";
import { writeFileAtomic } from "../child/child-files.ts";

export const RESULT_VERSION = 1;
export const MAX_RESULT_TEXT_BYTES = 10 * 1024 * 1024;
const TRUNCATION_MARKER = "\n\n[... result truncated; full text is in the session file ...]\n\n";

export interface ResultJson {
  version: 1;
  childId: string;
  turn: number;
  state: SubagentState;
  outcome: TurnOutcome;
  text: string;
  textTruncated: boolean;
  usage: Usage;
  sessionFile: string | null;
  terminal: string;
  startedAt: string;
  settledAt: string;
  error: string | null;
}

export function boundResultText(text: string, maxBytes = MAX_RESULT_TEXT_BYTES): { text: string; textTruncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, textTruncated: false };
  const budget = Math.max(0, maxBytes - Buffer.byteLength(TRUNCATION_MARKER, "utf8"));
  const headBytes = Math.floor(budget * 0.6);
  const tailBytes = budget - headBytes;
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, headBytes).toString("utf8");
  const tail = buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf8");
  return { text: `${head}${TRUNCATION_MARKER}${tail}`, textTruncated: true };
}

export interface BuildResultInput {
  childId: string;
  turn: number;
  state: SubagentState;
  outcome: TurnOutcome;
  text: string;
  usage?: Usage;
  sessionFile: string | null;
  terminal: string;
  startedAt: string;
  settledAt: string;
  error?: string | null;
  maxTextBytes?: number;
}

export function buildResultJson(input: BuildResultInput): ResultJson {
  const bounded = boundResultText(input.text, input.maxTextBytes ?? MAX_RESULT_TEXT_BYTES);
  return {
    version: RESULT_VERSION,
    childId: input.childId,
    turn: input.turn,
    state: input.state,
    outcome: input.outcome,
    text: bounded.text,
    textTruncated: bounded.textTruncated,
    usage: input.usage ?? emptyUsage(),
    sessionFile: input.sessionFile,
    terminal: input.terminal,
    startedAt: input.startedAt,
    settledAt: input.settledAt,
    error: input.error ?? null,
  };
}

export async function writeResultFile(file: string, result: ResultJson): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(result, null, 2)}\n`);
}

export async function readResultFile(file: string): Promise<ResultJson | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== RESULT_VERSION || typeof record.childId !== "string") return null;
    if (typeof record.text !== "string" || typeof record.turn !== "number") return null;
    return value as ResultJson;
  } catch {
    return null;
  }
}

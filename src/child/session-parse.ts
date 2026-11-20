/**
 * Pure parser over a child's pi session JSONL.
 *
 * The session file is the authoritative result source. The parser selects the
 * last assistant message on the active branch at or after the turn start, maps
 * its stop reason to an outcome, and aggregates usage across the turn.
 */
import type { Usage } from "../runtime/types.ts";
import { emptyUsage } from "../runtime/types.ts";

export type ParsedOutcome =
  | "stop"
  | "length"
  | "error"
  | "aborted"
  | "no_text"
  | "incomplete";

export interface ParsedSessionResult {
  state: "completed" | "failed" | "cancelled" | "pending";
  outcome: ParsedOutcome | "pending";
  text: string;
  error?: string;
  usage?: Usage;
  assistantCount: number;
  stopReason: string | null;
  branchUncertain: boolean;
  lastAssistantTimestamp: number | null;
  incompleteReason?: string;
}

export interface ParseSessionOptions {
  /** Unix ms recorded immediately before task delivery. */
  turnStartedAtMs: number;
  /** Terminal status has been reached; pending becomes incomplete. */
  final?: boolean;
  /** Drop a leading partial line (tail read started mid-file). */
  dropLeadingPartial?: boolean;
}

interface JsonRecord {
  [key: string]: unknown;
}

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function parseLines(text: string, dropLeadingPartial: boolean): JsonRecord[] {
  const parts = text.split("\n");
  if (dropLeadingPartial) parts.shift();
  const entries: JsonRecord[] = [];
  for (const part of parts) {
    const line = part.trim();
    if (line.length === 0) continue;
    try {
      const value = JSON.parse(line) as unknown;
      const record = asRecord(value);
      if (record) entries.push(record);
    } catch {
      // Partial or malformed line: ignore and keep the rest.
    }
  }
  return entries;
}

function entryTimestamp(entry: JsonRecord): number | null {
  const message = asRecord(entry.message);
  const value = message?.timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isAssistant(entry: JsonRecord): boolean {
  if (entry.type !== "message") return false;
  const message = asRecord(entry.message);
  return message?.role === "assistant";
}

function textOf(message: JsonRecord): string {
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const blocks: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === "text" && typeof record.text === "string") blocks.push(record.text);
  }
  return blocks.join("\n").trim();
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function addUsage(target: Usage, raw: unknown): boolean {
  const usage = asRecord(raw);
  if (!usage) return false;
  let counted = false;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const value = finiteNumber(usage[key]);
    if (value !== null) {
      target[key] += value;
      counted = true;
    }
  }
  const cost = asRecord(usage.cost);
  if (cost) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      const value = finiteNumber(cost[key]);
      if (value !== null) {
        target.cost[key] += value;
        counted = true;
      }
    }
  } else {
    const numericCost = finiteNumber(usage.cost);
    if (numericCost !== null) {
      target.cost.total += numericCost;
      counted = true;
    }
  }
  return counted;
}

function selectBranch(entries: JsonRecord[]): { branch: JsonRecord[]; branchUncertain: boolean } {
  const byId = new Map<string, JsonRecord>();
  let lastWithId: JsonRecord | null = null;
  for (const entry of entries) {
    if (typeof entry.id === "string") {
      byId.set(entry.id, entry);
      lastWithId = entry;
    }
  }
  if (!lastWithId || byId.size === 0) {
    return { branch: entries, branchUncertain: true };
  }
  const branch: JsonRecord[] = [];
  let cursor: JsonRecord | undefined = lastWithId as JsonRecord | undefined;
  while (cursor) {
    branch.push(cursor);
    const parentId: unknown = cursor.parentId;
    cursor = typeof parentId === "string" ? byId.get(parentId) : undefined;
  }
  branch.reverse();
  // A tail read may not include the root. That is expected and not uncertain;
  // only fall back when the branch contains no assistant at all.
  return { branch, branchUncertain: false };
}

function mapOutcome(
  stopReason: string | null,
  text: string,
  errorMessage: string | null,
  final: boolean,
): { state: ParsedSessionResult["state"]; outcome: ParsedOutcome | "pending"; error?: string } {
  if (stopReason === "error") {
    return { state: "failed", outcome: "error", error: firstLine(errorMessage) ?? "provider error" };
  }
  if (stopReason === "aborted") return { state: "cancelled", outcome: "aborted" };
  if (stopReason === "length") return { state: "completed", outcome: "length" };
  if (stopReason === "stop") {
    return text.length > 0
      ? { state: "completed", outcome: "stop" }
      : { state: "completed", outcome: "no_text" };
  }
  if (stopReason === "toolUse" || stopReason === "pending" || stopReason === "deferred") {
    return final
      ? { state: "failed", outcome: "incomplete", error: `last assistant message is not final (${stopReason})` }
      : { state: "pending", outcome: "pending" };
  }
  if (stopReason === null) {
    return final
      ? { state: "failed", outcome: "incomplete", error: "no terminal assistant message" }
      : { state: "pending", outcome: "pending" };
  }
  // Unknown provider stop word: trust the text when present.
  return text.length > 0
    ? { state: "completed", outcome: "stop" }
    : final
      ? { state: "failed", outcome: "incomplete", error: `unknown stop reason ${stopReason}` }
      : { state: "pending", outcome: "pending" };
}

function firstLine(text: string | null): string | undefined {
  if (!text) return undefined;
  const line = text.split(/\r?\n/, 1)[0]?.trim();
  return line && line.length > 0 ? line : undefined;
}

export function parseSessionEntries(entries: JsonRecord[], options: ParseSessionOptions): ParsedSessionResult {
  const final = options.final ?? false;
  const branchSelection = selectBranch(entries);
  const branch = branchSelection.branch;

  let assistants = branch.filter(isAssistant);
  let branchUncertain = branchSelection.branchUncertain;
  if (assistants.length === 0 && !branchUncertain) {
    // The active leaf may have been abandoned after a /tree operation, or the
    // tail may begin after the leaf. Fall back by timestamp and mark the result.
    assistants = entries.filter(isAssistant);
    branchUncertain = true;
  }

  const timestamped = assistants.some((entry) => entryTimestamp(entry) !== null);
  const inTurn = timestamped
    ? assistants.filter((entry) => {
        const timestamp = entryTimestamp(entry);
        return timestamp === null ? false : timestamp >= options.turnStartedAtMs;
      })
    : assistants;

  if (inTurn.length === 0) {
    return {
      state: "pending",
      outcome: "pending",
      text: "",
      assistantCount: 0,
      stopReason: null,
      branchUncertain,
      lastAssistantTimestamp: null,
      ...(final ? { state: "failed", outcome: "incomplete", incompleteReason: "no assistant message for this turn" } : {}),
    };
  }

  const selected = inTurn[inTurn.length - 1] as JsonRecord;
  const message = asRecord(selected.message) ?? {};
  const text = textOf(message);
  const rawStopReason = message.stopReason;
  const stopReason = typeof rawStopReason === "string" ? rawStopReason : null;
  const rawError = message.errorMessage;
  const errorMessage = typeof rawError === "string" ? rawError : null;

  const usage = emptyUsage();
  let usageCounted = false;
  for (const entry of inTurn) {
    const entryMessage = asRecord(entry.message);
    if (entryMessage && addUsage(usage, entryMessage.usage)) usageCounted = true;
  }

  const mapped = mapOutcome(stopReason, text, errorMessage, final);
  const timestamp = entryTimestamp(selected);
  return {
    state: mapped.state,
    outcome: mapped.outcome,
    text,
    ...(mapped.error === undefined ? {} : { error: mapped.error }),
    ...(usageCounted ? { usage } : {}),
    assistantCount: inTurn.length,
    stopReason,
    branchUncertain,
    lastAssistantTimestamp: timestamp,
    ...(mapped.outcome === "incomplete" ? { incompleteReason: mapped.error } : {}),
  };
}

export function parseSessionText(text: string, options: ParseSessionOptions): ParsedSessionResult {
  return parseSessionEntries(parseLines(text, options.dropLeadingPartial ?? false), options);
}

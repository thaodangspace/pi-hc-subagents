/**
 * Session JSONL readers for the benchmark.
 *
 * The parser is deliberately independent from the extension's turn-scoped
 * parser: a benchmark needs whole-session totals, not the last turn's result.
 * Usage fields are the same ones `src/child/session-parse.ts` validates.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { type SessionSummary, type UsageTotals, addUsage, emptyUsageTotals } from "./types.ts";

export interface SessionRead {
  summary: SessionSummary;
  /** Final assistant text. Never persisted; only the verifier sees it. */
  finalText: string;
}

interface Record_ {
  [key: string]: unknown;
}

function asRecord(value: unknown): Record_ | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record_) : null;
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    const record = asRecord(part);
    if (!record) continue;
    if (typeof record.text === "string" && (record.type === undefined || record.type === "text")) {
      parts.push(record.text);
    }
  }
  return parts.join("\n");
}

function usageOf(message: Record_): UsageTotals | null {
  const usage = asRecord(message.usage);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  const totals = emptyUsageTotals();
  totals.input = finite(usage.input);
  totals.output = finite(usage.output);
  totals.cacheRead = finite(usage.cacheRead);
  totals.cacheWrite = finite(usage.cacheWrite);
  totals.reasoning = finite(usage.reasoning);
  totals.totalTokens = finite(usage.totalTokens);
  totals.costUsd = cost ? finite(cost.total) : finite(usage.cost);
  if (totals.totalTokens === 0) totals.totalTokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return totals;
}

export function summarizeEntries(text: string): SessionRead {
  const usage = emptyUsageTotals();
  let turns = 0;
  let peakContext = 0;
  let toolResultBytes = 0;
  let assistantTextBytes = 0;
  let finalText = "";
  let bytes = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    bytes += Buffer.byteLength(trimmed, "utf8") + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    const message = entry ? asRecord(entry.message) : null;
    if (!entry || !message) continue;
    const role = message.role;
    if (role === "assistant") {
      const turnUsage = usageOf(message);
      if (turnUsage && (turnUsage.input + turnUsage.output + turnUsage.cacheRead + turnUsage.cacheWrite) > 0) {
        turns += 1;
        addUsage(usage, turnUsage);
        const context = turnUsage.input + turnUsage.cacheRead + turnUsage.cacheWrite + turnUsage.output;
        if (context > peakContext) peakContext = context;
      }
      const assistantText = textOfContent(message.content);
      if (assistantText.length > 0) {
        assistantTextBytes += Buffer.byteLength(assistantText, "utf8");
        finalText = assistantText;
      }
      continue;
    }
    if (role === "toolResult") {
      const toolText = textOfContent(message.content);
      toolResultBytes += Buffer.byteLength(toolText, "utf8");
    }
  }

  return {
    summary: { file: "", bytes, turns, usage, peakContext, toolResultBytes, assistantTextBytes },
    finalText,
  };
}

export async function readSession(file: string): Promise<SessionRead | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const read = summarizeEntries(text);
  read.summary.file = file;
  if (read.summary.bytes === 0) read.summary.bytes = Buffer.byteLength(text, "utf8");
  return read;
}

/** Flat transcript used only by the `transcript` ablation arm. */
export async function readSessionTranscript(file: string, maxBytes: number): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return "";
  }
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    const message = entry ? asRecord(entry.message) : null;
    if (!message) continue;
    const role = message.role;
    const content = textOfContent(message.content);
    if (content.length === 0) continue;
    if (role === "assistant") lines.push(`assistant: ${content}`);
    else if (role === "toolResult") lines.push(`tool result: ${content}`);
    else if (role === "user") lines.push(`user: ${content}`);
  }
  const transcript = lines.join("\n\n");
  if (Buffer.byteLength(transcript, "utf8") <= maxBytes) return transcript;
  const head = Math.floor(maxBytes * 0.4);
  const tail = maxBytes - head;
  const buffer = Buffer.from(transcript, "utf8");
  return `${buffer.subarray(0, head).toString("utf8")}\n\n[... transcript truncated ...]\n\n${buffer
    .subarray(Math.max(head, buffer.length - tail))
    .toString("utf8")}`;
}

export async function listSessionFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(full);
    }
  }
  await walk(dir);
  found.sort();
  return found;
}

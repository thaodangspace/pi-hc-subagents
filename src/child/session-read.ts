/**
 * Tail-first session reads.
 *
 * Live pi appends to the session file, so a read can end mid-line. The parser
 * drops the leading partial line of a tail read and ignores a trailing partial
 * line. Large sessions are read in growing windows, not loaded whole.
 */
import { open, stat } from "node:fs/promises";

import { parseSessionText, type ParseSessionOptions, type ParsedSessionResult } from "./session-parse.ts";

export const SESSION_TAIL_INITIAL_BYTES = 4 * 1024 * 1024;
export const SESSION_TAIL_MAX_BYTES = 64 * 1024 * 1024;

export interface ReadTailResult {
  text: string;
  startOffset: number;
  size: number;
  droppedLeadingLine: boolean;
}

export async function readFileTail(file: string, maxBytes: number): Promise<ReadTailResult> {
  const info = await stat(file);
  const startOffset = Math.max(0, info.size - Math.max(0, maxBytes));
  const length = info.size - startOffset;
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, startOffset);
    return {
      text: buffer.toString("utf8"),
      startOffset,
      size: info.size,
      droppedLeadingLine: startOffset > 0,
    };
  } finally {
    await handle.close();
  }
}

export interface ParseSessionFileOptions extends ParseSessionOptions {
  initialTailBytes?: number;
  maxTailBytes?: number;
}

export interface ParsedSessionFile extends ParsedSessionResult {
  sessionFile: string;
  readBytes: number;
  fileSize: number;
}

export async function parseSessionFile(
  file: string,
  options: ParseSessionFileOptions,
): Promise<ParsedSessionFile> {
  const initial = options.initialTailBytes ?? SESSION_TAIL_INITIAL_BYTES;
  const maximum = options.maxTailBytes ?? SESSION_TAIL_MAX_BYTES;
  let window = Math.max(1024, initial);
  let last: { parsed: ParsedSessionResult; tail: ReadTailResult } | null = null;

  for (;;) {
    const tail = await readFileTail(file, Math.min(window, maximum));
    const parsed = parseSessionText(tail.text, {
      turnStartedAtMs: options.turnStartedAtMs,
      ...(options.final === undefined ? {} : { final: options.final }),
      dropLeadingPartial: tail.droppedLeadingLine,
    });
    last = { parsed, tail };
    // Enough history: an assistant for this turn was found, or we read the file.
    if (parsed.assistantCount > 0 || tail.startOffset === 0 || window >= maximum) break;
    window = Math.min(window * 2, maximum);
  }

  if (!last) throw new Error(`could not read ${file}`);
  return {
    ...last.parsed,
    sessionFile: file,
    readBytes: last.tail.size - last.tail.startOffset,
    fileSize: last.tail.size,
  };
}

export interface ParseRetryOptions {
  attempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
}

/**
 * Parse after terminal status. A live append can leave the last assistant at
 * `toolUse` for a moment; retry a few times before calling the turn incomplete.
 */
export async function parseSessionWithRetry(
  file: string,
  options: ParseSessionFileOptions,
  retry: ParseRetryOptions = {},
): Promise<ParsedSessionFile> {
  const attempts = Math.max(1, retry.attempts ?? 6);
  const delayMs = retry.delayMs ?? 100;
  let last: ParsedSessionFile | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const final = attempt === attempts - 1 ? Boolean(options.final) : false;
    last = await parseSessionFile(file, { ...options, final });
    if (last.state !== "pending") return last;
    if (attempt < attempts - 1) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          retry.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new Error("parse retry aborted"));
        };
        retry.signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
  if (!last) throw new Error(`could not parse ${file}`);
  return last;
}

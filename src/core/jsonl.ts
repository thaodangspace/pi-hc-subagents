/**
 * Line framing helpers shared by the JSON-RPC client and the child pipe protocol.
 *
 * `hc` uses one JSON message per line in plain mode. Socket chunks do not align
 * with lines, so every consumer needs the same splitter.
 */

export interface SplitResult {
  /** Complete lines, without their trailing newline. */
  lines: string[];
  /** Bytes after the last newline, kept for the next chunk. */
  remainder: string;
}

export function splitCompleteLines(chunk: string): SplitResult {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk.charCodeAt(i) !== 10) continue;
    let line = chunk.slice(start, i);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    lines.push(line);
    start = i + 1;
  }
  return { lines, remainder: chunk.slice(start) };
}

/** Stateful decoder that turns arbitrary chunks into complete lines. */
export class LineDecoder {
  #remainder = "";
  #maxLineBytes: number;

  constructor(options: { maxLineBytes?: number } = {}) {
    this.#maxLineBytes = options.maxLineBytes ?? 1024 * 1024;
  }

  get partial(): string {
    return this.#remainder;
  }

  push(chunk: string): string[] {
    const { lines, remainder } = splitCompleteLines(this.#remainder + chunk);
    this.#remainder = remainder;
    if (Buffer.byteLength(this.#remainder, "utf8") > this.#maxLineBytes) {
      throw new Error(`JSON line exceeds ${this.#maxLineBytes} bytes`);
    }
    return lines;
  }

  reset(): void {
    this.#remainder = "";
  }
}

/** Parse one JSONL line, returning `undefined` for blank or malformed lines. */
export function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * Split a text buffer into lines, dropping a leading partial line when the read
 * did not start at byte 0. Always keeps the final partial line for callers that
 * need to detect a live append.
 */
export function splitJsonlText(
  text: string,
  options: { dropLeadingPartial: boolean },
): { lines: string[]; partialLastLine: string } {
  const { lines, remainder } = splitCompleteLines(text);
  if (options.dropLeadingPartial && lines.length > 0) {
    lines.shift();
  }
  return { lines, partialLastLine: remainder };
}

export function stripControlCharacters(text: string): string {
  // Keep newlines and tabs; drop the rest of C0/C1 and DEL.
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

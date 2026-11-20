/**
 * Stable error model for the extension.
 *
 * Callers branch on `code`, never on message text. Codes mirror `hc`
 * `error.data.kind` values plus extension-local codes.
 */
export type HcSubagentErrorCode =
  | "not_found"
  | "blocked"
  | "status_mismatch"
  | "finished"
  | "unavailable"
  | "spawn_failed"
  | "name_taken"
  | "invalid_params"
  | "protocol"
  | "timeout"
  | "aborted"
  | "validation"
  | "unsupported"
  | "ambiguous"
  | "not_settled"
  | "project_agent_not_trusted"
  | "unknown";

export interface HcSubagentErrorOptions {
  hint?: string;
  rpcCode?: number;
  data?: unknown;
  cause?: unknown;
}

export class HcSubagentError extends Error {
  readonly code: HcSubagentErrorCode;
  readonly hint: string | undefined;
  readonly rpcCode: number | undefined;
  readonly data: unknown;

  constructor(code: HcSubagentErrorCode, message: string, options: HcSubagentErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = code === "aborted" ? "AbortError" : "HcSubagentError";
    this.code = code;
    this.hint = options.hint;
    this.rpcCode = options.rpcCode;
    this.data = options.data;
  }

  /** Retryable errors may succeed on a subsequent attempt without duplicating work. */
  get retryable(): boolean {
    return this.code === "unavailable" || this.code === "status_mismatch";
  }

  /** Expected failures that should be returned as structured results, not thrown. */
  get expected(): boolean {
    return (
      this.code === "not_found" ||
      this.code === "blocked" ||
      this.code === "finished" ||
      this.code === "timeout" ||
      this.code === "aborted" ||
      this.code === "not_settled" ||
      this.code === "ambiguous" ||
      this.code === "validation" ||
      this.code === "unsupported" ||
      this.code === "project_agent_not_trusted"
    );
  }
}

const KNOWN_KINDS = new Set<HcSubagentErrorCode>([
  "not_found",
  "blocked",
  "status_mismatch",
  "finished",
  "unavailable",
  "spawn_failed",
  "name_taken",
  "invalid_params",
  "protocol",
  "timeout",
  "aborted",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Map a JSON-RPC error object (`{code,message,data}`) to an HcSubagentError. */
export function rpcErrorToHcSubagentError(error: unknown): HcSubagentError {
  const record = asRecord(error);
  if (!record) {
    return new HcSubagentError("protocol", "hc returned a malformed error object", { data: error });
  }
  const data = asRecord(record.data);
  const kind = typeof data?.kind === "string" ? data.kind : undefined;
  const hint = typeof data?.hint === "string" ? data.hint : undefined;
  const rpcCode = typeof record.code === "number" ? record.code : undefined;
  const message = typeof record.message === "string" ? record.message : "hc request failed";
  const code: HcSubagentErrorCode =
    kind && KNOWN_KINDS.has(kind as HcSubagentErrorCode) ? (kind as HcSubagentErrorCode) : "unknown";
  return new HcSubagentError(code, message, {
    ...(hint === undefined ? {} : { hint }),
    ...(rpcCode === undefined ? {} : { rpcCode }),
    data: record.data,
  });
}

export function isHcSubagentError(error: unknown): error is HcSubagentError {
  return error instanceof HcSubagentError;
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof HcSubagentError) return error.code === "aborted";
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Normalize any thrown value, preserving HcSubagentError codes. */
export function toHcSubagentError(error: unknown, fallbackCode: HcSubagentErrorCode = "unknown"): HcSubagentError {
  if (error instanceof HcSubagentError) return error;
  if (isAbortError(error)) {
    return new HcSubagentError("aborted", "operation aborted", { cause: error });
  }
  if (error instanceof Error) {
    const nodeCode = (error as NodeJS.ErrnoException).code;
    if (nodeCode === "ECONNREFUSED" || nodeCode === "ENOENT" || nodeCode === "ECONNRESET" || nodeCode === "EPIPE") {
      return new HcSubagentError("unavailable", error.message, { cause: error });
    }
    return new HcSubagentError(fallbackCode, error.message, { cause: error });
  }
  return new HcSubagentError(fallbackCode, String(error), { cause: error });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One-line diagnostic with code and hint, for tool details and logs. */
export function describeHcError(error: unknown): string {
  const normalized = toHcSubagentError(error);
  const hint = normalized.hint ? ` (${normalized.hint})` : "";
  return `${normalized.code}: ${normalized.message}${hint}`;
}

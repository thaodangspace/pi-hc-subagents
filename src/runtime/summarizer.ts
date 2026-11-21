/**
 * Gated, single-shot model summarization for over-budget child reports.
 *
 * Pure control flow: no pi import, no network, no filesystem. The summarizer is
 * injected (its gateway is wired in `index.ts`), so every path is testable with
 * a fake and the default `resultSummarizer: "off"` never reaches this module.
 *
 * The P0 digest is always computed first and returned unchanged on any failed
 * gate or fault. Failures carry exactly one stable code and never provider text:
 * a caller may persist the code, and the child's words stay out of it.
 */
import {
  SUMMARIZER_INPUT_MAX_BYTES,
  SUMMARIZER_OUTPUT_MAX_BYTES,
  SUMMARIZER_TIMEOUT_MS,
  condenseByLines,
  modelFacingResult,
  type ModelFacingResult,
  type ResultVerbosity,
} from "./result-format.ts";

export { SUMMARIZER_INPUT_MAX_BYTES, SUMMARIZER_OUTPUT_MAX_BYTES, SUMMARIZER_TIMEOUT_MS };

/** Summarizer tokens/cost, kept separate from the child turn's usage. */
export interface SummarizerUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  durationMs: number;
}

export interface SummarizerRequest {
  text: string;
  signal: AbortSignal;
}

export interface SummarizerResponse {
  text: string;
  usage: Omit<SummarizerUsage, "durationMs">;
}

/** Injected gateway; a `null` gateway is the "no model/auth" degradation. */
export type ResultSummarizer = (request: SummarizerRequest) => Promise<SummarizerResponse>;

/** Stable fallback code; never provider or error message text. */
export type SummarizerErrorCode = "timeout" | "auth" | "unavailable" | "empty" | "aborted" | "error";

/**
 * Settled-turn facts the gates need beyond `text`/`verbosity`/`summarizer`.
 *
 * `facing` may be supplied when the caller already computed the P0 digest from
 * the same `text`; otherwise it is computed here.
 */
export interface SummarizeState {
  /** Config gate: `resultSummarizer === "model"`. */
  enabled: boolean;
  /** Turn gate: a failed/cancelled turn is never summarized. */
  failed: boolean;
  /** P0 digest precomputed from the same `text`. */
  facing?: ModelFacingResult;
}

export interface SummarizeReportOptions {
  text: string;
  verbosity?: ResultVerbosity;
  summarizer: ResultSummarizer | null | undefined;
  state: SummarizeState;
  signal?: AbortSignal;
  /** Test seam; defaults to `SUMMARIZER_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface SummarizeReportResult {
  /** The P0 digest, or the summary text on success (`condensed` is then true). */
  facing: ModelFacingResult;
  summarized: boolean;
  usage?: SummarizerUsage;
  error?: SummarizerErrorCode;
}

/**
 * No separate line budget: within 128 KiB a text has at most 65,536 lines (one
 * byte plus its newline per line), so the byte cap is the only input bound.
 */
const INPUT_MAX_LINES = Math.max(1, Math.floor(SUMMARIZER_INPUT_MAX_BYTES / 2));
const OUTPUT_MAX_LINES = Math.max(1, Math.floor(SUMMARIZER_OUTPUT_MAX_BYTES / 2));

/** Our own deadline/abort outcomes, distinguishable from provider throws. */
class SummarizerFailure extends Error {
  readonly code: "timeout" | "aborted";

  constructor(code: "timeout" | "aborted") {
    super(code);
    this.name = "SummarizerFailure";
    this.code = code;
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return SUMMARIZER_TIMEOUT_MS;
  return Math.trunc(value);
}

function tokenCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function costUsd(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeUsage(
  usage: SummarizerResponse["usage"] | undefined,
  durationMs: number,
): SummarizerUsage {
  return {
    inputTokens: tokenCount(usage?.inputTokens),
    outputTokens: tokenCount(usage?.outputTokens),
    costUsd: costUsd(usage?.costUsd),
    model: typeof usage?.model === "string" ? usage.model : "",
    durationMs: Math.max(0, Math.trunc(durationMs)),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function statusValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value === "string" && /^[1-5]\d\d$/.test(value)) return Number(value);
  return null;
}

/** Only structural status fields, never a message. */
function readStatus(error: unknown): number | null {
  const record = asRecord(error);
  if (!record) return null;
  const direct =
    statusValue(record.status) ?? statusValue(record.statusCode) ?? statusValue(record.httpStatus);
  if (direct !== null) return direct;
  const response = asRecord(record.response);
  if (!response) return null;
  return statusValue(response.status) ?? statusValue(response.statusCode);
}

const UNAVAILABLE_CODES = new Set([
  "offline",
  "unavailable",
  "no_auth",
  "noauth",
  "missing_auth",
  "missing_api_key",
  "enotfound",
  "econnrefused",
  "econnreset",
  "econnaborted",
  "etimedout",
  "eai_again",
  "enetunreach",
  "ehostunreach",
  "epipe",
  "und_err_connect_timeout",
  "und_err_socket",
  "network_error",
]);

const AUTH_CODES = new Set([
  "unauthorized",
  "forbidden",
  "invalid_api_key",
  "authentication_error",
  "permission_denied",
  "auth_error",
  "auth",
]);

const ABORT_CODES = new Set(["abort_err", "aborterror", "cancelled", "canceled"]);

/** Structural `code`/`name`/`type` fields (plus one level of `cause`/`error`). */
function readCodes(error: unknown): string[] {
  const codes: string[] = [];
  const collect = (record: Record<string, unknown> | null): void => {
    if (!record) return;
    for (const key of ["code", "name", "type", "errorType"]) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0 && value.length <= 64) {
        codes.push(value.toLowerCase());
      }
    }
  };
  const record = asRecord(error);
  if (!record) {
    if (typeof error === "string" && error.length > 0 && error.length <= 64) codes.push(error.toLowerCase());
    return codes;
  }
  collect(record);
  collect(asRecord(record.cause));
  collect(asRecord(record.error));
  return codes;
}

/**
 * One stable code from the error's status/code shape. The message is never
 * read, so provider or child text cannot reach a caller's details/logs.
 */
function classify(error: unknown): SummarizerErrorCode {
  if (error instanceof SummarizerFailure) return error.code;
  const status = readStatus(error);
  if (status === 401 || status === 403) return "auth";
  const codes = readCodes(error);
  if (
    codes.some(
      (code) =>
        code.startsWith("econn") || code.startsWith("enotfound") || UNAVAILABLE_CODES.has(code),
    )
  ) {
    return "unavailable";
  }
  if (codes.some((code) => ABORT_CODES.has(code))) return "aborted";
  if (codes.some((code) => AUTH_CODES.has(code) || code.endsWith("autherror"))) return "auth";
  return "error";
}

function summarizeResponse(
  response: SummarizerResponse | undefined,
  facing: ModelFacingResult,
  input: string,
  durationMs: number,
): SummarizeReportResult {
  const failed = (error: SummarizerErrorCode): SummarizeReportResult => ({
    facing,
    summarized: false,
    error,
  });
  if (!response || typeof response.text !== "string") return failed("error");
  const summary = response.text.trim();
  // A no-op summary (empty or the input verbatim) is not a summary.
  if (summary.length === 0 || summary === input.trim()) return failed("empty");
  try {
    const bounded = condenseByLines(summary, {
      maxBytes: SUMMARIZER_OUTPUT_MAX_BYTES,
      maxLines: OUTPUT_MAX_LINES,
    }).text;
    return {
      facing: { ...facing, text: bounded, condensed: true },
      summarized: true,
      usage: normalizeUsage(response.usage, durationMs),
    };
  } catch {
    return failed("error");
  }
}

/**
 * Summarize one over-budget, handoff-less child report.
 *
 * Order: P0 digest, gates, one bounded call raced against `timeoutMs` and
 * `signal`, output condense. Any failure returns the untouched digest plus one
 * code; a successful summary becomes the model-facing text and carries usage.
 */
export async function summarizeReport(options: SummarizeReportOptions): Promise<SummarizeReportResult> {
  const { text, summarizer, state, signal } = options;
  const facing = state.facing ?? modelFacingResult(text, { verbosity: options.verbosity });
  const skipped: SummarizeReportResult = { facing, summarized: false };

  if (!state.enabled) return skipped;
  if (!summarizer) return skipped;
  if (state.failed) return skipped;
  if (text.trim().length === 0) return skipped;
  if (facing.handoff) return skipped;
  if (!facing.condensed) return skipped;
  if (signal?.aborted) return { facing, summarized: false, error: "aborted" };

  const input = condenseByLines(text, {
    maxBytes: SUMMARIZER_INPUT_MAX_BYTES,
    maxLines: INPUT_MAX_LINES,
  }).text;

  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const controller = new AbortController();
  let settle!: (outcome: PromiseSettledResult<SummarizerResponse>) => void;
  const settled = new Promise<PromiseSettledResult<SummarizerResponse>>((resolve) => {
    settle = resolve;
  });

  const onAbort = (): void => {
    controller.abort();
    settle({ status: "rejected", reason: new SummarizerFailure("aborted") });
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    controller.abort();
    settle({ status: "rejected", reason: new SummarizerFailure("timeout") });
  }, timeoutMs);

  const startedAt = Date.now();
  const pending = Promise.resolve().then(() => summarizer({ text: input, signal: controller.signal }));
  // Attaching both handlers also keeps a late rejection from becoming unhandled.
  pending.then(
    (value) => settle({ status: "fulfilled", value }),
    (reason) => settle({ status: "rejected", reason }),
  );

  let outcome: PromiseSettledResult<SummarizerResponse>;
  try {
    outcome = await settled;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }

  if (outcome.status === "rejected") {
    return { facing, summarized: false, error: classify(outcome.reason) };
  }
  return summarizeResponse(outcome.value, facing, input, Date.now() - startedAt);
}

/**
 * Parent-side private pipe client.
 *
 * One request per connection, newline-delimited JSON, bounded frames. Errors
 * are normalized to the extension's stable codes so callers can distinguish
 * `blocked`, `unavailable`, `timeout`, and protocol failures.
 */
import net from "node:net";

import { HcSubagentError, toHcSubagentError, type HcSubagentErrorCode } from "../core/error.ts";
import { splitCompleteLines } from "../core/jsonl.ts";
import {
  MAX_PIPE_FRAME_BYTES,
  decodePipeNotification,
  decodePipeResponse,
  encodeFrame,
  pipeDir,
  pipeNameFor,
  pipePathFor,
  validatePipeName,
  type PipeNotification,
  type PipeResponse,
} from "./pipe-protocol.ts";

export const DEFAULT_PIPE_TIMEOUT_MS = 10_000;
const PIPE_CONNECT_TIMEOUT_MS = 5_000;

const KNOWN_CODES = new Set<string>([
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
  "validation",
  "unsupported",
  "ambiguous",
  "not_settled",
  "project_agent_not_trusted",
  "unknown",
]);

export interface PipeRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

let nextRequestId = 1;

function responseError(response: Extract<PipeResponse, { type: "error" }>): HcSubagentError {
  const code: HcSubagentErrorCode = KNOWN_CODES.has(response.code)
    ? (response.code as HcSubagentErrorCode)
    : "unknown";
  return new HcSubagentError(code, response.message, {
    ...(response.hint === undefined ? {} : { hint: response.hint }),
    data: response.kind === undefined ? undefined : { kind: response.kind },
  });
}

export class PipeClient {
  readonly path: string;
  readonly defaultTimeoutMs: number;

  constructor(socketPath: string, options: { timeoutMs?: number } = {}) {
    this.path = socketPath;
    this.defaultTimeoutMs = options.timeoutMs ?? DEFAULT_PIPE_TIMEOUT_MS;
  }

  ping(options: PipeRequestOptions = {}): Promise<Extract<PipeResponse, { type: "ok" }>> {
    return this.#request({ type: "ping" }, options);
  }

  prompt(text: string, options: PipeRequestOptions = {}): Promise<Extract<PipeResponse, { type: "ok" }>> {
    return this.#request({ type: "prompt", text }, options);
  }

  followUp(
    text: string,
    steer = true,
    options: PipeRequestOptions = {},
  ): Promise<Extract<PipeResponse, { type: "ok" }>> {
    return this.#request({ type: "follow_up", text, steer }, options);
  }

  interrupt(options: PipeRequestOptions = {}): Promise<Extract<PipeResponse, { type: "ok" }>> {
    return this.#request({ type: "interrupt" }, options);
  }

  shutdown(options: PipeRequestOptions = {}): Promise<Extract<PipeResponse, { type: "ok" }>> {
    return this.#request({ type: "shutdown" }, options);
  }

  result(options: PipeRequestOptions = {}): Promise<Extract<PipeResponse, { type: "ok" }>> {
    return this.#request({ type: "result" }, options);
  }

  #request(
    request: { type: string; [key: string]: unknown },
    options: PipeRequestOptions,
  ): Promise<Extract<PipeResponse, { type: "ok" }>> {
    if (options.signal?.aborted) {
      return Promise.reject(new HcSubagentError("aborted", "pipe request aborted"));
    }
    const id = `r${nextRequestId++}`;
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultTimeoutMs);

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      const socket = net.createConnection(this.path);

      const finish = (error: unknown, response?: Extract<PipeResponse, { type: "ok" }>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else if (response) resolve(response);
      };

      const onAbort = () => finish(new HcSubagentError("aborted", "pipe request aborted"));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(
        () => finish(new HcSubagentError("timeout", "the child pipe did not respond in time")),
        timeoutMs,
      );
      timer.unref?.();

      socket.setEncoding("utf8");
      socket.setTimeout(PIPE_CONNECT_TIMEOUT_MS, () =>
        finish(new HcSubagentError("timeout", "could not connect to the child pipe")),
      );
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.write(encodeFrame({ ...request, id }));
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_PIPE_FRAME_BYTES) {
          finish(new HcSubagentError("protocol", "child pipe response exceeds the size limit"));
          return;
        }
        const split = splitCompleteLines(buffer);
        buffer = split.remainder;
        for (const line of split.lines) {
          let response: PipeResponse;
          try {
            response = decodePipeResponse(line);
          } catch (error) {
            finish(error);
            return;
          }
          if (response.id !== id) continue;
          if (response.type === "error") {
            finish(responseError(response));
            return;
          }
          finish(null, response);
          return;
        }
      });
      socket.once("error", (error) => {
        finish(toHcSubagentError(error, "unavailable"));
      });
      socket.once("close", () => {
        if (!settled) finish(new HcSubagentError("unavailable", "the child pipe closed before responding"));
      });
    });
  }
}

export function pipeClientFor(parentCwd: string, childId: string, pipeName?: string): PipeClient {
  const name = pipeName ?? pipeNameFor(parentCwd, childId);
  const issue = validatePipeName(name);
  if (issue) throw new HcSubagentError("validation", issue);
  return new PipeClient(pipePathFor(name));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for a freshly spawned child to start listening. A missing socket is
 * expected during startup; other protocol/blocked errors are returned.
 */
export async function waitForPipe(
  client: PipeClient,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PIPE_TIMEOUT_MS;
  const intervalMs = Math.max(25, options.intervalMs ?? 100);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (options.signal?.aborted) throw new HcSubagentError("aborted", "pipe wait aborted");
    try {
      await client.ping({ timeoutMs: Math.min(1000, Math.max(100, deadline - Date.now())) });
      return;
    } catch (error) {
      const normalized = toHcSubagentError(error, "unavailable");
      if (normalized.code !== "unavailable" && normalized.code !== "timeout") throw normalized;
      if (Date.now() >= deadline) {
        throw new HcSubagentError("unavailable", "the child private pipe did not become available", {
          hint: "the child may still be starting, or it was spawned without child.ts",
          cause: error,
        });
      }
      await sleep(intervalMs);
    }
  }
}

/**
 * Reconnect policy promised by SPEC §8.6: 500 ms, 1 s, 2 s, 5 s, 10 s, 30 s.
 * One attempt per entry, so a dead child cannot leave an immortal timer.
 */
export const DEFAULT_NOTIFICATION_BACKOFF_MS: readonly number[] = [500, 1000, 2000, 5000, 10_000, 30_000];
export const MAX_NOTIFICATION_BACKOFF_MS = 30_000;

export type NotificationSubscriptionState = "connecting" | "open" | "degraded" | "closed";

export interface NotificationSubscriptionOptions {
  pipeName: string;
  /** Defaults to `pipeDir()`. */
  dir?: string;
  signal?: AbortSignal;
  onSettled(notification: PipeNotification): void;
  /** Terminal, non-retryable transport failure (for example a protocol violation). */
  onTransportError?(error: HcSubagentError): void;
  /** Terminal: the reconnect budget is exhausted. */
  onDegraded?(error: HcSubagentError): void;
  /** Called before each scheduled retry; `attempt` is 1-based. */
  onReconnect?(attempt: number, delayMs: number): void;
  backoffMs?: readonly number[];
  /** Test seam: returns a cancel function. Defaults to an unref'd `setTimeout`. */
  schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface NotificationSubscription {
  readonly path: string;
  readonly state: NotificationSubscriptionState;
  readonly reconnects: number;
  readonly lastError: HcSubagentError | null;
  close(): void;
}

/** A throwing listener must never crash the process or look like a protocol error. */
function containedRun(fn: () => void): void {
  try {
    fn();
  } catch {
    // Listener failures are the listener's problem; transport work continues.
  }
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const timer = setTimeout(run, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * Long-lived consumer of `settled` frames on a child's private pipe.
 *
 * The subscriber never sends requests: a frame carrying a string `id` is a
 * response and is ignored. It never throws into the caller — a malformed or
 * oversize frame ends the subscription as a terminal protocol error, and an
 * exhausted reconnect budget ends it as `degraded`. Exactly one terminal
 * condition wins; the rest are dropped, mirroring `PipeClient#request`.
 */
export function subscribeChildNotifications(
  options: NotificationSubscriptionOptions,
): NotificationSubscription {
  const issue = validatePipeName(options.pipeName);
  if (issue) throw new HcSubagentError("validation", issue);
  const socketPath = pipePathFor(options.pipeName, options.dir ?? pipeDir());
  const backoff = options.backoffMs ?? DEFAULT_NOTIFICATION_BACKOFF_MS;
  const scheduleFn = options.schedule ?? defaultSchedule;
  const signal = options.signal;

  let current: NotificationSubscriptionState = "connecting";
  let socket: net.Socket | null = null;
  let buffer = "";
  let attempts = 0;
  let reconnects = 0;
  let lastError: HcSubagentError | null = null;
  let hadConnection = false;
  let closed = false;
  let terminal = false;
  let cancelRetry: (() => void) | null = null;

  const clearRetry = (): void => {
    const cancel = cancelRetry;
    cancelRetry = null;
    if (cancel) containedRun(cancel);
  };

  const forgetSocket = (target: net.Socket | null): void => {
    if (socket !== target) return;
    socket = null;
    if (target && !target.destroyed) target.destroy();
  };

  const cleanup = (): void => {
    clearRetry();
    const target = socket;
    socket = null;
    buffer = "";
    if (target) target.destroy();
    signal?.removeEventListener("abort", onAbort);
  };

  /** The first terminal condition wins; later events are dropped. */
  const settleTerminal = (kind: "error" | "degraded", error: HcSubagentError): void => {
    if (terminal || closed) return;
    terminal = true;
    current = kind === "error" ? "closed" : "degraded";
    lastError = error;
    cleanup();
    if (kind === "error") {
      const onTransportError = options.onTransportError;
      if (onTransportError) containedRun(() => onTransportError(error));
    } else {
      const onDegraded = options.onDegraded;
      if (onDegraded) containedRun(() => onDegraded(error));
    }
  };

  const protocolError = (message: string): void => {
    settleTerminal("error", new HcSubagentError("protocol", message));
  };

  const degrade = (): void => {
    const cause = lastError;
    const error = new HcSubagentError(
      "unavailable",
      `the child notification pipe did not reconnect after ${attempts} attempt(s)`,
      {
        hint: "the child may have exited; polling remains authoritative",
        ...(cause === null ? {} : { cause }),
      },
    );
    settleTerminal("degraded", error);
  };

  const scheduleReconnect = (): void => {
    if (closed || terminal) return;
    if (attempts >= backoff.length) {
      degrade();
      return;
    }
    const index = attempts;
    attempts += 1;
    const attempt = attempts;
    const rawDelay = backoff[index] ?? 0;
    const delayMs = Math.min(MAX_NOTIFICATION_BACKOFF_MS, Math.max(0, rawDelay));
    current = "connecting";
    const onReconnect = options.onReconnect;
    if (onReconnect) containedRun(() => onReconnect(attempt, delayMs));
    if (closed || terminal) return;

    let fired = false;
    let cancel: () => void;
    try {
      cancel = scheduleFn(() => {
        if (fired) return;
        fired = true;
        cancelRetry = null;
        connect();
      }, delayMs);
    } catch (error) {
      settleTerminal("degraded", toHcSubagentError(error, "unavailable"));
      return;
    }
    if (!fired) {
      cancelRetry = () => {
        if (fired) return;
        fired = true;
        cancel();
      };
    }
  };

  const onDisconnect = (error: HcSubagentError | null): void => {
    if (closed || terminal) return;
    if (error) lastError = error;
    scheduleReconnect();
  };

  const handleLine = (line: string): void => {
    if (closed || terminal) return;
    if (line.trim().length === 0) return; // framing noise, same rule as the server
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      protocolError("child notification frame is not valid JSON");
      return;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      protocolError("child notification frame must be an object");
      return;
    }
    // The subscriber never sends requests, so a reply is not ours: ignore it.
    if (typeof (raw as { id?: unknown }).id === "string") return;
    let notification: PipeNotification;
    try {
      notification = decodePipeNotification(line);
    } catch (error) {
      protocolError(toHcSubagentError(error, "protocol").message);
      return;
    }
    containedRun(() => options.onSettled(notification));
  };

  const handleChunk = (chunk: string): void => {
    if (closed || terminal) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_PIPE_FRAME_BYTES) {
      protocolError(`child notification frame exceeds ${MAX_PIPE_FRAME_BYTES} bytes`);
      return;
    }
    const split = splitCompleteLines(buffer);
    buffer = split.remainder;
    for (const line of split.lines) {
      handleLine(line);
      if (closed || terminal) return;
    }
  };

  const connect = (): void => {
    if (closed || terminal) return;
    current = "connecting";
    buffer = "";
    let target: net.Socket;
    try {
      target = net.createConnection(socketPath);
    } catch (error) {
      lastError = toHcSubagentError(error, "unavailable");
      scheduleReconnect();
      return;
    }
    socket = target;
    target.setEncoding("utf8");
    target.unref?.();

    target.once("connect", () => {
      if (socket !== target || closed || terminal) return;
      if (hadConnection) reconnects += 1;
      hadConnection = true;
      attempts = 0;
      current = "open";
    });
    target.on("data", (chunk: string) => {
      if (socket !== target) return;
      handleChunk(chunk);
    });
    target.once("error", (error: Error) => {
      if (socket !== target) return;
      forgetSocket(target);
      onDisconnect(toHcSubagentError(error, "unavailable"));
    });
    target.once("close", () => {
      if (socket !== target) return;
      forgetSocket(target);
      onDisconnect(new HcSubagentError("unavailable", "the child notification pipe closed"));
    });
  };

  function onAbort(): void {
    close();
  }

  function close(): void {
    if (closed) return;
    closed = true;
    current = "closed";
    cleanup();
  }

  if (signal?.aborted) {
    closed = true;
    current = "closed";
  } else {
    signal?.addEventListener("abort", onAbort, { once: true });
    connect();
  }

  return {
    path: socketPath,
    get state(): NotificationSubscriptionState {
      return current;
    },
    get reconnects(): number {
      return reconnects;
    },
    get lastError(): HcSubagentError | null {
      return lastError;
    },
    close,
  };
}

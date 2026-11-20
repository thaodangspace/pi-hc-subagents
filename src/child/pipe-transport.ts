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
  decodePipeResponse,
  encodeFrame,
  pipeNameFor,
  pipePathFor,
  validatePipeName,
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

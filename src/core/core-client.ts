/**
 * JSON-RPC client for herdr-core (`hc`).
 *
 * Transport: one connection per request, UTF-8 line-delimited JSON. No pi
 * imports. The client only connects to `HC_TERMINAL_SOCKET`; callers cannot
 * supply a socket path from model input.
 */
import net from "node:net";

import { HcSubagentError, rpcErrorToHcSubagentError, toHcSubagentError } from "./error.ts";
import {
  decodeCoreEvent,
  decodeInterruptResult,
  decodeListResult,
  decodeReadResult,
  decodeRemoveResult,
  decodeSendResult,
  decodeServerStatus,
  decodeTerminal,
  decodeWaitResult,
} from "./hc-types.ts";
import type {
  CoreEvent,
  HcGetParams,
  HcLabelParams,
  HcListParams,
  HcReadParams,
  HcRunParams,
  HcSendParams,
  HcServerStatus,
  InterruptResult,
  ReadResult,
  RemoveResult,
  SendResult,
  TerminalListResult,
  TerminalRecord,
  WaitResult,
} from "./hc-types.ts";
import { LineDecoder, parseJsonLine } from "./jsonl.ts";

export const DEFAULT_TIMEOUT_MS = 15_000;
export const RUN_TIMEOUT_MS = 30_000;
export const SEND_TIMEOUT_MS = 30_000;
export const KILL_TIMEOUT_MS = 30_000;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_IN_FLIGHT = 4;

/** Methods and wire parameters this extension depends on. Used by the contract test. */
export const HC_METHODS = {
  "server.status": [] as string[],
  "terminal.run": [
    "argv",
    "cwd",
    "env",
    "name",
    "labels",
    "caller",
    "parent",
    "no_notify",
    "no_parent",
    "outlive_parent",
    "rm",
    "keep",
    "wait",
    "timeout",
  ],
  "terminal.get": ["terminal", "caller"],
  "terminal.list": ["labels", "all"],
  "terminal.read": ["terminal", "caller", "lines"],
  "terminal.send": ["terminal", "text", "caller", "wait", "timeout", "if"],
  "terminal.interrupt": ["terminal"],
  "terminal.kill": ["terminal", "caller"],
  "terminal.rm": ["terminal", "caller"],
  "terminal.label": ["terminal", "labels"],
} as const;

export interface CoreClientOptions {
  socketPath?: string | null;
  caller?: string | null;
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
  maxMessageBytes?: number;
  maxInFlight?: number;
}

interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HcRunResult {
  terminal: TerminalRecord;
}

let nextRequestId = 1;

function wireTimeoutSeconds(timeoutMs: number | null | undefined): number | null | undefined {
  if (timeoutMs === undefined || timeoutMs === null) return timeoutMs;
  return Math.max(0, timeoutMs) / 1000;
}

function omitUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) result[key] = item;
  }
  return result;
}

export class CoreClient {
  readonly socketPath: string | null;
  readonly caller: string | null;
  readonly defaultTimeoutMs: number;
  readonly maxMessageBytes: number;
  readonly maxInFlight: number;

  #active = 0;
  #queue: Array<() => void> = [];

  constructor(options: CoreClientOptions = {}) {
    const env = options.env ?? process.env;
    const socket = options.socketPath === undefined ? env.HC_TERMINAL_SOCKET : options.socketPath;
    const caller = options.caller === undefined ? env.HC_TERMINAL_ID : options.caller;
    this.socketPath = typeof socket === "string" && socket.length > 0 ? socket : null;
    this.caller = typeof caller === "string" && caller.length > 0 ? caller : null;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
    this.maxInFlight = Math.max(1, options.maxInFlight ?? MAX_IN_FLIGHT);
  }

  get available(): boolean {
    return this.socketPath !== null;
  }

  async serverStatus(): Promise<HcServerStatus> {
    return decodeServerStatus(await this.request("server.status", {}));
  }

  async serverVersion(): Promise<string | null> {
    if (!this.available) return null;
    try {
      return (await this.serverStatus()).version;
    } catch {
      return null;
    }
  }

  async run(params: HcRunParams, options: RequestOptions = {}): Promise<TerminalRecord> {
    const wire = omitUndefined({
      argv: params.argv,
      cwd: params.cwd,
      env: params.env,
      name: params.name,
      labels: params.labels,
      caller: params.caller === undefined ? this.caller : params.caller,
      parent: params.parent,
      no_notify: params.noNotify,
      no_parent: params.noParent,
      outlive_parent: params.outliveParent,
      rm: params.rm,
      keep: params.keep,
      wait: params.wait,
      timeout: params.timeoutSeconds,
    });
    return decodeTerminal(await this.request("terminal.run", wire, { timeoutMs: RUN_TIMEOUT_MS, ...options }));
  }

  async get(terminal: string, caller: string | null = this.caller): Promise<TerminalRecord> {
    const params: HcGetParams = { terminal, caller };
    return decodeTerminal(
      await this.request("terminal.get", omitUndefined({ terminal: params.terminal, caller: params.caller })),
    );
  }

  /** Get a terminal, returning null when hc reports it does not exist. */
  async tryGet(terminal: string, caller: string | null = this.caller): Promise<TerminalRecord | null> {
    try {
      return await this.get(terminal, caller);
    } catch (error) {
      if (toHcSubagentError(error).code === "not_found") return null;
      throw error;
    }
  }

  async list(params: HcListParams = {}): Promise<TerminalListResult> {
    return decodeListResult(await this.request("terminal.list", omitUndefined({ labels: params.labels, all: params.all })));
  }

  async read(terminal: string, lines = 60, caller: string | null = this.caller): Promise<ReadResult> {
    const params: HcReadParams = { terminal, lines, caller };
    return decodeReadResult(
      await this.request("terminal.read", omitUndefined({ terminal: params.terminal, lines: params.lines, caller: params.caller })),
    );
  }

  async send(terminal: string, text: string, params: Omit<HcSendParams, "terminal" | "text"> = {}): Promise<SendResult> {
    const wire = omitUndefined({
      terminal,
      text,
      caller: params.caller === undefined ? this.caller : params.caller,
      wait: params.wait,
      timeout: params.timeoutSeconds,
      if: params.onlyIf,
    });
    // `force` is intentionally never sent: machine messages must not answer dialogs.
    return decodeSendResult(await this.request("terminal.send", wire, { timeoutMs: SEND_TIMEOUT_MS }));
  }

  async interrupt(terminal: string): Promise<InterruptResult> {
    return decodeInterruptResult(await this.request("terminal.interrupt", { terminal }, { timeoutMs: KILL_TIMEOUT_MS }));
  }

  async kill(terminal: string): Promise<void> {
    await this.request("terminal.kill", omitUndefined({ terminal, caller: this.caller }), {
      timeoutMs: KILL_TIMEOUT_MS,
    });
  }

  async remove(terminal: string): Promise<RemoveResult> {
    return decodeRemoveResult(
      await this.request("terminal.rm", omitUndefined({ terminal, caller: this.caller }), { timeoutMs: KILL_TIMEOUT_MS }),
    );
  }

  async label(terminal: string, labels: HcLabelParams["labels"]): Promise<void> {
    const wire: Record<string, string> = {};
    for (const [key, value] of Object.entries(labels)) wire[key] = value ?? "";
    await this.request("terminal.label", { terminal, labels: wire });
  }

  async wait(terminal: string, timeoutMs = this.defaultTimeoutMs): Promise<WaitResult> {
    const timeout = wireTimeoutSeconds(timeoutMs);
    return decodeWaitResult(
      await this.request("terminal.wait", { terminal, timeout }, { timeoutMs: timeoutMs + 10_000 }),
    );
  }

  /**
   * Subscribe to `hc` events on a long-lived connection. Reconnects with
   * exponential backoff and re-subscribes from the last sequence.
   *
   * Milestone 2 uses this; it is implemented here so callers do not depend on a
   * second transport.
   */
  subscribe(
    filter: { childrenOf?: string; labels?: Record<string, string>; terminal?: string },
    onEvent: (event: CoreEvent) => void,
    onError?: (error: HcSubagentError) => void,
  ): () => void {
    if (!this.socketPath) {
      onError?.(new HcSubagentError("unavailable", "HC_TERMINAL_SOCKET is not set"));
      return () => {};
    }
    let closed = false;
    let socket: net.Socket | null = null;
    let reconnectTimer: NodeJS.Timeout | null = null;
    let attempt = 0;
    let afterSeq = 0;

    const connect = () => {
      if (closed || !this.socketPath) return;
      const decoder = new LineDecoder({ maxLineBytes: this.maxMessageBytes });
      socket = net.createConnection({ path: this.socketPath });
      socket.setEncoding("utf8");
      socket.on("connect", () => {
        attempt = 0;
        const params = omitUndefined({
          children_of: filter.childrenOf,
          labels: filter.labels,
          terminal: filter.terminal,
          after: afterSeq > 0 ? afterSeq : undefined,
        });
        socket?.write(`${JSON.stringify({ jsonrpc: "2.0", id: nextRequestId++, method: "events.subscribe", params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch (error) {
          onError?.(toHcSubagentError(error, "protocol"));
          socket?.destroy();
          return;
        }
        for (const line of lines) {
          const payload = parseJsonLine(line);
          if (typeof payload !== "object" || payload === null) continue;
          const record = payload as Record<string, unknown>;
          if (record.error) {
            onError?.(rpcErrorToHcSubagentError(record.error));
            continue;
          }
          try {
            const event = decodeCoreEvent(payload);
            if (event.seq > afterSeq) afterSeq = event.seq;
            onEvent(event);
          } catch (error) {
            onError?.(toHcSubagentError(error, "protocol"));
          }
        }
      });
      const scheduleReconnect = (error: HcSubagentError) => {
        if (closed) return;
        onError?.(error);
        const delay = [500, 1000, 2000, 5000, 10000][Math.min(attempt, 4)] ?? 10000;
        attempt++;
        reconnectTimer = setTimeout(connect, Math.min(delay, 30_000));
        reconnectTimer.unref?.();
      };
      socket.on("error", (error) => scheduleReconnect(toHcSubagentError(error, "unavailable")));
      socket.on("close", () => {
        if (!closed) scheduleReconnect(new HcSubagentError("unavailable", "hc event subscription closed"));
      });
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.destroy();
    };
  }

  /**
   * Send one JSON-RPC request. Concurrency is capped so a polling wait cannot
   * open unbounded sockets; each request uses its own connection.
   */
  async request(method: string, params: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    const release = await this.#acquire(options.signal);
    try {
      return await this.#requestOnce(method, params, options);
    } finally {
      release();
    }
  }

  async #acquire(signal: AbortSignal | undefined): Promise<() => void> {
    if (signal?.aborted) throw new HcSubagentError("aborted", "request aborted before start");
    if (this.#active < this.maxInFlight) {
      this.#active++;
      return () => this.#releaseSlot();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        cleanup();
        this.#active++;
        resolve();
      };
      const onAbort = () => {
        cleanup();
        const index = this.#queue.indexOf(waiter);
        if (index >= 0) this.#queue.splice(index, 1);
        reject(new HcSubagentError("aborted", "request aborted while queued"));
      };
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
    return () => this.#releaseSlot();
  }

  #releaseSlot(): void {
    this.#active--;
    const next = this.#queue.shift();
    if (next) next();
  }

  #requestOnce(method: string, params: Record<string, unknown>, options: RequestOptions): Promise<unknown> {
    const socketPath = this.socketPath;
    if (!socketPath) {
      return Promise.reject(new HcSubagentError("unavailable", "HC_TERMINAL_SOCKET is not set"));
    }
    const id = nextRequestId++;
    const payload = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise((resolve, reject) => {
      let settled = false;
      let bytes = 0;
      const decoder = new LineDecoder({ maxLineBytes: this.maxMessageBytes });
      const socket = net.createConnection({ path: socketPath });
      socket.setEncoding("utf8");

      const finish = (error: unknown, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(toHcSubagentError(error, "unavailable"));
        else resolve(result);
      };

      const onAbort = () => finish(new HcSubagentError("aborted", "hc request aborted", { cause: options.signal?.reason }));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      const timer = setTimeout(() => {
        finish(new HcSubagentError("timeout", `hc request ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      socket.on("connect", () => {
        socket.write(payload);
      });

      socket.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > this.maxMessageBytes) {
          finish(new HcSubagentError("protocol", `hc response exceeded ${this.maxMessageBytes} bytes`));
          return;
        }
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch (error) {
          finish(toHcSubagentError(error, "protocol"));
          return;
        }
        for (const line of lines) {
          const message = parseJsonLine(line);
          if (message === undefined) continue;
          if (typeof message !== "object" || message === null) {
            finish(new HcSubagentError("protocol", "hc response is not a JSON object"));
            return;
          }
          const record = message as Record<string, unknown>;
          if (record.id !== undefined && record.id !== id) continue;
          if (record.error !== undefined) {
            finish(rpcErrorToHcSubagentError(record.error));
            return;
          }
          if (!("result" in record)) {
            finish(new HcSubagentError("protocol", `hc response for ${method} has no result`));
            return;
          }
          finish(null, record.result);
          return;
        }
      });

      socket.on("error", (error) => {
        finish(toHcSubagentError(error, "unavailable"));
      });

      socket.on("close", () => {
        if (settled) return;
        finish(
          new HcSubagentError(
            "unavailable",
            `hc connection closed before a response to ${method}`,
            decoder.partial ? { data: decoder.partial } : {},
          ),
        );
      });
    });
  }
}

/** Create a client from the standard hc environment. */
export function createCoreClient(env: NodeJS.ProcessEnv = process.env): CoreClient {
  return new CoreClient({ env });
}

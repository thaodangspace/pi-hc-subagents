/**
 * Child-side pipe server.
 *
 * Starts a local-user-only Unix socket, validates and dispatches newline
 * framed requests, and deletes stale socket files left by a crashed child.
 * The server is deliberately independent of pi so it can be unit tested; the
 * package's `child.ts` supplies pi-specific handlers.
 */
import { chmod, lstat, unlink } from "node:fs/promises";
import net from "node:net";

import { HcSubagentError } from "../core/error.ts";
import { splitCompleteLines } from "../core/jsonl.ts";
import {
  MAX_PIPE_FRAME_BYTES,
  PIPE_VERSION,
  decodePipeRequest,
  encodeFrame,
  errorFrame,
  pipeDir,
  pipePathFor,
  validatePipeName,
  type PipeNotification,
  type PipeRequest,
  type PipeRequestType,
} from "./pipe-protocol.ts";

export class PipeRequestError extends Error {
  readonly code: string;
  readonly kind: string | undefined;
  readonly hint: string | undefined;

  constructor(code: string, message: string, options: { kind?: string | null; hint?: string | null } = {}) {
    super(message);
    this.name = "PipeRequestError";
    this.code = code;
    this.kind = options.kind ?? undefined;
    this.hint = options.hint ?? undefined;
  }
}

export type PipeHandlerResult = Record<string, unknown> | void;

export interface ChildPipeHandlers {
  ping?(): Promise<{ turn?: number }> | { turn?: number };
  prompt(text: string): Promise<PipeHandlerResult>;
  followUp(text: string, steer: boolean): Promise<PipeHandlerResult>;
  interrupt(): Promise<PipeHandlerResult>;
  shutdown(): Promise<PipeHandlerResult>;
  result(): Promise<PipeHandlerResult>;
}

export interface ChildPipeServerOptions {
  name: string;
  handlers: ChildPipeHandlers;
  dir?: string;
  /** Test seam: skip the live-server probe. */
  probeExisting?: boolean;
}

async function canConnect(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs, () => done(false));
  });
}

export class ChildPipeServer {
  readonly path: string;
  readonly #handlers: ChildPipeHandlers;
  readonly #options: ChildPipeServerOptions;
  #server: net.Server | null = null;
  #sockets = new Set<net.Socket>();
  #stopped = false;

  constructor(options: ChildPipeServerOptions) {
    this.#options = options;
    this.#handlers = options.handlers;
    this.path = pipePathFor(options.name, options.dir ?? pipeDir());
  }

  get listening(): boolean {
    return this.#server !== null && !this.#stopped;
  }

  async start(): Promise<void> {
    const issue = validatePipeName(this.#options.name);
    if (issue) throw new HcSubagentError("validation", issue);
    if (this.#server) return;
    await this.#prepareSocketPath();

    const server = net.createServer((socket) => this.#onConnection(socket));
    this.#server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.path);
      });
      await chmod(this.path, 0o600);
    } catch (error) {
      await this.stop().catch(() => {});
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        throw new HcSubagentError("unavailable", `private pipe is already in use: ${this.path}`, {
          cause: error,
        });
      }
      throw toPipeError(error);
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await unlink(this.path).catch(() => {});
  }

  broadcast(notification: PipeNotification): void {
    const frame = encodeFrame(notification);
    for (const socket of this.#sockets) {
      if (!socket.destroyed) socket.write(frame);
    }
  }

  async #prepareSocketPath(): Promise<void> {
    let info;
    try {
      info = await lstat(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw toPipeError(error);
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new HcSubagentError("unavailable", "private pipe socket is owned by another user");
    }
    if (!info.isSocket()) {
      await unlink(this.path);
      return;
    }
    if (this.#options.probeExisting === false) {
      await unlink(this.path);
      return;
    }
    if (await canConnect(this.path)) {
      throw new HcSubagentError("unavailable", `private pipe is already in use: ${this.path}`);
    }
    await unlink(this.path);
  }

  #onConnection(socket: net.Socket): void {
    this.#sockets.add(socket);
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => this.#sockets.delete(socket));

    let buffer = "";
    let chain = Promise.resolve();
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_PIPE_FRAME_BYTES) {
        socket.write(encodeFrame(errorFrame("0", "protocol", "pipe frame exceeds the size limit")));
        socket.destroy();
        return;
      }
      const split = splitCompleteLines(buffer);
      buffer = split.remainder;
      for (const line of split.lines) {
        chain = chain.then(() => this.#handleLine(socket, line));
      }
    });
  }

  async #handleLine(socket: net.Socket, line: string): Promise<void> {
    if (line.trim().length === 0) return;
    let request: PipeRequest;
    try {
      request = decodePipeRequest(line);
    } catch (error) {
      socket.write(encodeFrame(errorFrame("0", "protocol", errorMessage(error))));
      return;
    }

    if (request.type === "shutdown") {
      this.#write(socket, { type: "ok", id: request.id });
      setTimeout(() => {
        void this.#handlers.shutdown().catch(() => {});
        void this.stop();
      }, 25);
      return;
    }

    try {
      const payload = await this.#dispatch(request);
      this.#write(socket, { ...payload, type: "ok", id: request.id });
    } catch (error) {
      if (error instanceof PipeRequestError) {
        this.#write(
          socket,
          errorFrame(request.id, error.code, error.message, { kind: error.kind, hint: error.hint }),
        );
      } else if (error instanceof HcSubagentError) {
        this.#write(socket, errorFrame(request.id, error.code, error.message, { hint: error.hint }));
      } else {
        this.#write(socket, errorFrame(request.id, "unknown", errorMessage(error)));
      }
    }
  }

  async #dispatch(request: PipeRequest): Promise<PipeHandlerResult> {
    switch (request.type) {
      case "ping": {
        const pong = await this.#handlers.ping?.();
        return { version: PIPE_VERSION, ...pong };
      }
      case "prompt":
        return this.#handlers.prompt(request.text);
      case "follow_up":
        return this.#handlers.followUp(request.text, request.steer !== false);
      case "interrupt":
        return this.#handlers.interrupt();
      case "result":
        return this.#handlers.result();
      case "shutdown":
        return {};
      default:
        throw new PipeRequestError("protocol", `unsupported request ${String((request as { type?: unknown }).type)}`);
    }
  }

  #write(socket: net.Socket, response: unknown): void {
    if (!socket.destroyed) socket.write(encodeFrame(response));
  }
}

export async function startChildPipeServer(options: ChildPipeServerOptions): Promise<ChildPipeServer> {
  const server = new ChildPipeServer(options);
  await server.start();
  return server;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toPipeError(error: unknown): HcSubagentError {
  if (error instanceof HcSubagentError) return error;
  return new HcSubagentError("unavailable", errorMessage(error), { cause: error });
}

export type { PipeRequestType };

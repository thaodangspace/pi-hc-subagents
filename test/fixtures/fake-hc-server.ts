/**
 * Minimal fake hc JSON-RPC server for unit tests.
 *
 * Each connection may carry one or more newline-delimited requests. Handlers
 * return either a result value, `{ error }`, `{ raw }` (send exact bytes), or
 * `{ close: true }` / `{ delayMs, result }` to exercise transport failures.
 */
import net from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { splitCompleteLines } from "../../src/core/jsonl.ts";

export interface FakeResponse {
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  raw?: string;
  close?: boolean;
  delayMs?: number;
}

export type FakeHandler = (method: string, params: Record<string, unknown>) => FakeResponse | Promise<FakeResponse>;

export interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

export class FakeHcServer {
  readonly requests: RecordedRequest[] = [];
  socketPath = "";
  #server: net.Server | null = null;
  #dir = "";
  #handler: FakeHandler;

  constructor(handler?: FakeHandler) {
    this.#handler = handler ?? (() => ({ result: {} }));
  }

  setHandler(handler: FakeHandler): void {
    this.#handler = handler;
  }

  async start(): Promise<void> {
    this.#dir = await mkdtemp(path.join(os.tmpdir(), "fake-hc-"));
    this.socketPath = path.join(this.#dir, "core.sock");
    this.#server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let remainder = "";
      socket.on("data", (chunk: string) => {
        const split = splitCompleteLines(remainder + chunk);
        remainder = split.remainder;
        for (const line of split.lines) {
          void this.#handleLine(socket, line);
        }
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve, reject) => {
      this.#server?.once("error", reject);
      this.#server?.listen(this.socketPath, () => resolve());
    });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
      this.#server = null;
    });
    if (this.#dir) await rm(this.#dir, { recursive: true, force: true });
  }

  async #handleLine(socket: net.Socket, line: string): Promise<void> {
    if (line.trim().length === 0) return;
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(line) as Record<string, unknown>;
    } catch {
      socket.write("not-json\n");
      socket.end();
      return;
    }
    const method = String(request.method ?? "");
    const params = (request.params as Record<string, unknown>) ?? {};
    this.requests.push({ method, params });

    let response: FakeResponse;
    try {
      response = await this.#handler(method, params);
    } catch (error) {
      response = { error: { code: -32000, message: String(error) } };
    }

    if (response.delayMs) await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    if (response.close) {
      socket.destroy();
      return;
    }
    if (response.raw !== undefined) {
      socket.write(response.raw);
      socket.end();
      return;
    }
    const payload = response.error
      ? { jsonrpc: "2.0", id: request.id, error: response.error }
      : { jsonrpc: "2.0", id: request.id, result: response.result ?? {} };
    socket.write(`${JSON.stringify(payload)}\n`);
    socket.end();
  }
}

/**
 * Private child pipe protocol (Milestone 3).
 *
 * One JSON object per line over a Unix domain socket. The pipe is a local
 * machine-to-machine channel: it never carries ANSI keys, never uses TCP, and
 * never answers a permission dialog. `hc` status and the child session JSONL
 * remain authoritative.
 */
import { createHash } from "node:crypto";
import path from "node:path";

import { HcSubagentError } from "../core/error.ts";

export const PIPE_VERSION = 1;
export const MAX_PIPE_FRAME_BYTES = 1024 * 1024;
export const MAX_PIPE_MESSAGE_BYTES = 256 * 1024;
export const MAX_PIPE_ID_LENGTH = 128;
const PIPE_NAME_RE = /^pi-hc-[a-f0-9]{16}-[A-Za-z0-9._-]{1,64}$/;

export type PipeRequestType = "ping" | "prompt" | "follow_up" | "interrupt" | "shutdown" | "result";

export interface PipeRequestBase {
  type: PipeRequestType;
  id: string;
}

export type PipeRequest =
  | (PipeRequestBase & { type: "ping" })
  | (PipeRequestBase & { type: "prompt"; text: string; deliverAs?: "initial" })
  | (PipeRequestBase & { type: "follow_up"; text: string; steer?: boolean })
  | (PipeRequestBase & { type: "interrupt" })
  | (PipeRequestBase & { type: "shutdown" })
  | (PipeRequestBase & { type: "result" });

export interface PipeOkResponse {
  type: "ok";
  id: string;
  [key: string]: unknown;
}

export interface PipeErrorResponse {
  type: "error";
  id: string;
  code: string;
  message: string;
  kind?: string;
  hint?: string;
}

export type PipeResponse = PipeOkResponse | PipeErrorResponse;

export interface PipeSettledNotification {
  type: "settled";
  turn: number;
  status: "completed" | "failed" | "aborted";
  text?: string;
  sessionFile?: string | null;
}

export type PipeNotification = PipeSettledNotification;

function controlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_PIPE_ID_LENGTH &&
    !controlCharacters(value)
  );
}

export function validatePipeName(name: string): string | null {
  if (!PIPE_NAME_RE.test(name)) return "pipe name must match pi-hc-<16 hex>-<child id>";
  return null;
}

/** `pi-hc-<sha256(parentCwd)[0..16]>-<childId>` */
export function pipeNameFor(parentCwd: string, childId: string): string {
  const hash = createHash("sha256").update(path.resolve(parentCwd)).digest("hex").slice(0, 16);
  const safeChild = childId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  if (safeChild.length === 0) throw new HcSubagentError("validation", "child id is not pipe-safe");
  return `pi-hc-${hash}-${safeChild}`;
}

export function pipeDir(): string {
  return process.env.PI_HC_SUBAGENTS_TEST_PIPE_DIR ?? "/tmp";
}

export function pipePathFor(name: string, dir = pipeDir()): string {
  const issue = validatePipeName(name);
  if (issue) throw new HcSubagentError("validation", issue);
  const socketPath = path.join(dir, `${name}.sock`);
  // Linux sun_path is 108 bytes; keep a margin for other platforms.
  if (Buffer.byteLength(socketPath, "utf8") > 100) {
    throw new HcSubagentError("validation", "private pipe path is too long");
  }
  return socketPath;
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function decodePipeRequest(line: string): PipeRequest {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new HcSubagentError("protocol", "pipe frame is not valid JSON");
  }
  if (!isRecord(raw)) throw new HcSubagentError("protocol", "pipe frame must be an object");
  if (!validId(raw.id)) throw new HcSubagentError("protocol", "pipe request id is missing or invalid");
  const type = raw.type;
  switch (type) {
    case "ping":
    case "interrupt":
    case "shutdown":
    case "result":
      return { type, id: raw.id } as PipeRequest;
    case "prompt":
    case "follow_up": {
      if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
        throw new HcSubagentError("validation", "pipe message must not be empty");
      }
      if (Buffer.byteLength(raw.text, "utf8") > MAX_PIPE_MESSAGE_BYTES) {
        throw new HcSubagentError("validation", `pipe message exceeds ${MAX_PIPE_MESSAGE_BYTES} bytes`);
      }
      if (type === "follow_up") {
        return { type, id: raw.id, text: raw.text, ...(raw.steer === undefined ? {} : { steer: raw.steer === true }) };
      }
      return { type, id: raw.id, text: raw.text };
    }
    default:
      throw new HcSubagentError("protocol", `unknown pipe request type: ${String(type)}`);
  }
}

export function decodePipeResponse(line: string): PipeResponse {
  let raw: unknown;
  try {
    raw = JSON.parse(line) as unknown;
  } catch {
    throw new HcSubagentError("protocol", "pipe response is not valid JSON");
  }
  if (!isRecord(raw)) throw new HcSubagentError("protocol", "pipe response must be an object");
  if (!validId(raw.id)) throw new HcSubagentError("protocol", "pipe response id is missing or invalid");
  if (raw.type === "ok") return raw as unknown as PipeOkResponse;
  if (raw.type === "error") {
    if (typeof raw.code !== "string" || typeof raw.message !== "string") {
      throw new HcSubagentError("protocol", "pipe error response is malformed");
    }
    return raw as unknown as PipeErrorResponse;
  }
  throw new HcSubagentError("protocol", "unknown pipe response type");
}

export function errorFrame(
  id: string,
  code: string,
  message: string,
  options: { kind?: string | null; hint?: string | null } = {},
): PipeErrorResponse {
  return {
    type: "error",
    id,
    code,
    message,
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.hint ? { hint: options.hint } : {}),
  };
}

export function isPipeNotification(value: unknown): value is PipeNotification {
  return isRecord(value) && value.type === "settled";
}

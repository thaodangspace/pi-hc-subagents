/**
 * Types and decoders for the `hc` JSON-RPC boundary.
 *
 * Everything coming from the socket is `unknown` and must pass an explicit
 * decoder. Decoders are deliberately tolerant about unknown fields and strict
 * about fields the extension relies on.
 */
import { HcSubagentError } from "./error.ts";

export const HC_MIN_VERSION = "0.1.16";
export const HC_TESTED_VERSION = "0.1.21";

export type HcTerminalLifecycleState = "live" | "finished";

export interface HcStatus {
  state: string;
  kind: string | null;
  message: string;
  title: string;
  app: string;
  progress: number | null;
}

export interface HcForeground {
  argv: string[] | null;
  cwd: string | null;
  name: string | null;
  pid: number | null;
}

export interface TerminalRecord {
  address: string;
  name: string | null;
  cwd: string;
  argv: string[];
  state: HcTerminalLifecycleState;
  status: HcStatus | null;
  turn: number;
  exitCode: number | null;
  signal: number | null;
  parent: string | null;
  labels: Record<string, string>;
  createdMs: number;
  finishedMs: number | null;
  statusMs: number | null;
  reported: boolean;
  reason: string | null;
  keep: boolean;
  rm: boolean;
  foreground: HcForeground | null;
  pid: number | null;
  notify: boolean;
  identity: string;
  screen: string;
}

export interface ReadResult {
  text: string;
  complete: boolean;
  how: string;
  why: string | null;
}

export interface SendResult {
  turn: number;
  started: boolean | null;
  status: string | null;
  wait: WaitResult | null;
}

export interface InterruptResult {
  outcome: "stopped" | "exited" | "still_working" | "unknown" | string;
  key: string;
}

export interface RemoveResult {
  removed: string;
}

export interface WaitResult {
  terminal: string;
  ended: boolean;
  reason: string;
  turn: number;
  status: string | null;
  exitCode: number | null;
  signal: number | null;
  from: string | null;
  children: WaitResult[];
}

export interface HcCoreInfo {
  id: string;
  name: string;
}

export interface HcServerStatus {
  version: string;
  pid: number;
  uptimeMs: number;
  live: number;
  finished: number;
  core: HcCoreInfo | null;
}

export interface TerminalListResult {
  terminals: TerminalRecord[];
  hiddenFinished: number;
}

export interface CoreEvent {
  type: string;
  seq: number;
  version?: number;
  at?: string;
  terminal?: TerminalRecord;
  terminals?: TerminalRecord[];
  address?: string;
  status?: HcStatus | null;
  turn?: number;
  labels?: Record<string, string>;
  exitCode?: number | null;
  signal?: number | null;
  reason?: string | null;
  [key: string]: unknown;
}

export interface HcRunParams {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
  labels?: Record<string, string>;
  caller?: string | null;
  parent?: string | null;
  noNotify?: boolean;
  noParent?: boolean;
  outliveParent?: boolean;
  rm?: boolean;
  keep?: boolean;
  wait?: boolean;
  /** Seconds, matching the hc wire contract. */
  timeoutSeconds?: number | null;
}

export interface HcGetParams {
  terminal: string;
  caller?: string | null;
}

export interface HcListParams {
  labels?: Record<string, string>;
  all?: boolean;
}

export interface HcReadParams {
  terminal: string;
  lines?: number;
  caller?: string | null;
}

export interface HcSendParams {
  terminal: string;
  text: string;
  caller?: string | null;
  wait?: boolean;
  timeoutSeconds?: number | null;
  onlyIf?: "idle" | "working";
}

export interface HcLabelParams {
  terminal: string;
  labels: Record<string, string | null>;
}

function protocolError(message: string, data?: unknown): HcSubagentError {
  return new HcSubagentError("protocol", message, data === undefined ? {} : { data });
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireRecord(value: unknown, what: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw protocolError(`hc ${what} is not an object`, value);
  return record;
}

function readString(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") throw protocolError(`hc ${what}.${key} is not a string`, value);
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string, what: string, fallback?: number): number {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw protocolError(`hc ${what}.${key} is not a number`, value);
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalBoolean(record: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function stringMap(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string") result[key] = item;
  }
  return result;
}

export function decodeStatus(value: unknown): HcStatus | null {
  if (value === null || value === undefined) return null;
  const record = requireRecord(value, "status");
  const state = readString(record, "state", "status");
  return {
    state,
    kind: optionalString(record, "kind"),
    message: optionalString(record, "msg") ?? "",
    title: optionalString(record, "title") ?? "",
    app: optionalString(record, "app") ?? "",
    progress: optionalNumber(record, "progress"),
  };
}

export function decodeForeground(value: unknown): HcForeground | null {
  if (value === null || value === undefined) return null;
  const record = requireRecord(value, "foreground");
  const argv = Array.isArray(record.argv) ? stringArray(record.argv) : null;
  return {
    argv,
    cwd: optionalString(record, "cwd"),
    name: optionalString(record, "name"),
    pid: optionalNumber(record, "pid"),
  };
}

export function decodeTerminal(value: unknown): TerminalRecord {
  const record = requireRecord(value, "terminal");
  const rawState = readString(record, "state", "terminal");
  if (rawState !== "live" && rawState !== "finished") {
    throw protocolError(`hc terminal.state has unexpected value ${JSON.stringify(rawState)}`, rawState);
  }
  const address = readString(record, "address", "terminal");
  return {
    address,
    name: optionalString(record, "name"),
    cwd: optionalString(record, "cwd") ?? "",
    argv: stringArray(record.argv),
    state: rawState,
    status: decodeStatus(record.status),
    turn: readNumber(record, "turn", "terminal", 0),
    exitCode: optionalNumber(record, "exit_code"),
    signal: optionalNumber(record, "signal"),
    parent: optionalString(record, "parent"),
    labels: stringMap(record.labels),
    createdMs: readNumber(record, "created_ms", "terminal", 0),
    finishedMs: optionalNumber(record, "finished_ms"),
    statusMs: optionalNumber(record, "status_ms"),
    reported: optionalBoolean(record, "reported"),
    reason: optionalString(record, "reason"),
    keep: optionalBoolean(record, "keep"),
    rm: optionalBoolean(record, "rm"),
    foreground: decodeForeground(record.foreground),
    pid: optionalNumber(record, "pid"),
    notify: optionalBoolean(record, "notify"),
    identity: optionalString(record, "identity") ?? "",
    screen: optionalString(record, "screen") ?? "exact",
  };
}

export function decodeReadResult(value: unknown): ReadResult {
  const record = requireRecord(value, "read result");
  return {
    text: readString(record, "text", "read result"),
    complete: optionalBoolean(record, "complete", true),
    how: optionalString(record, "how") ?? "screen",
    why: optionalString(record, "why"),
  };
}

export function decodeWaitResult(value: unknown): WaitResult {
  const record = requireRecord(value, "wait result");
  const children = Array.isArray(record.children) ? record.children.map(decodeWaitResult) : [];
  return {
    terminal: readString(record, "terminal", "wait result"),
    ended: optionalBoolean(record, "ended"),
    reason: optionalString(record, "reason") ?? "timeout",
    turn: readNumber(record, "turn", "wait result", 0),
    status: optionalString(record, "status"),
    exitCode: optionalNumber(record, "exit_code"),
    signal: optionalNumber(record, "signal"),
    from: optionalString(record, "from"),
    children,
  };
}

export function decodeSendResult(value: unknown): SendResult {
  const record = requireRecord(value, "send result");
  return {
    turn: readNumber(record, "turn", "send result", 0),
    started: typeof record.started === "boolean" ? record.started : null,
    status: optionalString(record, "status"),
    wait: record.wait === null || record.wait === undefined ? null : decodeWaitResult(record.wait),
  };
}

export function decodeInterruptResult(value: unknown): InterruptResult {
  const record = requireRecord(value, "interrupt result");
  return {
    outcome: readString(record, "outcome", "interrupt result"),
    key: readString(record, "key", "interrupt result"),
  };
}

export function decodeRemoveResult(value: unknown): RemoveResult {
  const record = requireRecord(value, "remove result");
  return { removed: readString(record, "removed", "remove result") };
}

export function decodeListResult(value: unknown): TerminalListResult {
  const record = requireRecord(value, "list result");
  const terminals = Array.isArray(record.terminals) ? record.terminals.map(decodeTerminal) : [];
  return {
    terminals,
    hiddenFinished: readNumber(record, "hidden_finished", "list result", 0),
  };
}

export function decodeServerStatus(value: unknown): HcServerStatus {
  const record = requireRecord(value, "server status");
  const core = asRecord(record.core);
  return {
    version: readString(record, "version", "server status"),
    pid: readNumber(record, "pid", "server status", 0),
    uptimeMs: readNumber(record, "uptime_ms", "server status", 0),
    live: readNumber(record, "live", "server status", 0),
    finished: readNumber(record, "finished", "server status", 0),
    core: core && typeof core.id === "string" && typeof core.name === "string" ? { id: core.id, name: core.name } : null,
  };
}

/**
 * Decode a subscription event. Events are additive, so unknown types are kept
 * intact and known terminal payloads are decoded when present.
 */
export function decodeCoreEvent(value: unknown): CoreEvent {
  const record = requireRecord(value, "event");
  const type = readString(record, "type", "event");
  const event: CoreEvent = {
    ...record,
    type,
    seq: readNumber(record, "seq", "event", 0),
  };
  if (record.terminal !== undefined && record.terminal !== null) {
    try {
      event.terminal = decodeTerminal(record.terminal);
    } catch {
      // Preserve unknown event shapes rather than dropping the event.
    }
  }
  if (Array.isArray(record.terminals)) {
    const terminals: TerminalRecord[] = [];
    for (const item of record.terminals) {
      try {
        terminals.push(decodeTerminal(item));
      } catch {
        // Skip undecodable snapshots; callers can reconcile with list().
      }
    }
    event.terminals = terminals;
  }
  try {
    event.status = decodeStatus(record.status);
  } catch {
    // Keep the raw value.
  }
  return event;
}

/** Compare dotted numeric versions without a semver dependency. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] => {
    const match = value.trim().match(/^v?([0-9]+)(?:\.([0-9]+))?(?:\.([0-9]+))?/);
    if (!match) return [0, 0, 0];
    return [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)];
  };
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

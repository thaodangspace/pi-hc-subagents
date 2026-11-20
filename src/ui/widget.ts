/**
 * Status widget and footer.
 *
 * One line per active child, at most six lines plus an overflow marker. Never
 * includes task or result text. Rendering is debounced to 250 ms and refreshed
 * once per second so elapsed durations stay current.
 */
import { formatDuration } from "../runtime/result-format.ts";
import type { SubagentRecord } from "../runtime/types.ts";

export const WIDGET_KEY = "hc-subagents";
export const STATUS_KEY = "hc-subagents";
export const MAX_WIDGET_LINES = 6;
const DEBOUNCE_MS = 250;
const REFRESH_MS = 1_000;

export interface WidgetRecordLike {
  agent: string;
  state: SubagentRecord["state"];
  createdAt: string;
  model?: string;
  coreStatus?: string;
  lastScreen?: string;
  cwd: string;
  turns?: Array<{ blocked?: { kind?: string } }>;
}

export function isActiveState(state: SubagentRecord["state"]): boolean {
  return state !== "completed" && state !== "failed" && state !== "cancelled";
}

export function activeRecords<T extends Pick<WidgetRecordLike, "state">>(records: readonly T[]): T[] {
  return records.filter((record) => isActiveState(record.state));
}

function shortCwd(cwd: string): string {
  const normalized = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length <= 2) return normalized.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
  return `…/${parts.slice(-2).join("/")}`;
}

function horizontal(record: WidgetRecordLike): string {
  if (record.state === "blocked") {
    const kind = record.turns?.at(-1)?.blocked?.kind;
    return kind ?? "permission";
  }
  return record.model ?? record.coreStatus ?? "";
}

export function formatWidgetLines(
  records: readonly WidgetRecordLike[],
  options: { maxLines?: number; width?: number; now?: number } = {},
): string[] {
  const maxLines = Math.max(1, options.maxLines ?? MAX_WIDGET_LINES);
  const width = Math.max(20, options.width ?? 100);
  const now = options.now ?? Date.now();
  const active = activeRecords(records).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (active.length === 0) return [];

  const shown = active.length > maxLines ? active.slice(0, Math.max(0, maxLines - 1)) : active;
  const overflow = active.length - shown.length;
  const lines = shown.map((record) => {
    const duration = formatDuration(Math.max(0, now - Date.parse(record.createdAt)));
    const line = `↳ ${record.agent}  ${record.state}  ${duration}  ${horizontal(record)}  ${shortCwd(record.cwd)}`;
    return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
  });
  if (overflow > 0) lines.push(`+${overflow} more`);
  return lines;
}

export interface WidgetUi {
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

export interface HcSubagentsWidgetOptions {
  now?: () => number;
  width?: () => number;
  debounceMs?: number;
  intervalMs?: number;
}

export class HcSubagentsWidget {
  readonly #ui: WidgetUi;
  readonly #now: () => number;
  readonly #width: () => number;
  readonly #debounceMs: number;
  readonly #intervalMs: number;
  #records: readonly WidgetRecordLike[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #interval: ReturnType<typeof setInterval> | null = null;
  #lastRender = 0;
  #lastLines = "";
  #lastStatus: string | undefined;
  #disposed = false;

  constructor(ui: WidgetUi, options: HcSubagentsWidgetOptions = {}) {
    this.#ui = ui;
    this.#now = options.now ?? (() => Date.now());
    this.#width = options.width ?? (() => 100);
    this.#debounceMs = Math.max(0, options.debounceMs ?? DEBOUNCE_MS);
    this.#intervalMs = Math.max(250, options.intervalMs ?? REFRESH_MS);
  }

  start(): void {
    if (this.#interval || this.#disposed) return;
    this.#interval = setInterval(() => this.#render(), this.#intervalMs);
    this.#interval.unref?.();
  }

  refresh(records: readonly WidgetRecordLike[]): void {
    this.#records = records;
    this.#render();
  }

  clear(): void {
    this.#records = [];
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#lastLines = "";
    this.#lastStatus = undefined;
    try {
      this.#ui.setStatus(STATUS_KEY, undefined);
      this.#ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      // UI teardown races are harmless.
    }
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#interval) {
      clearInterval(this.#interval);
      this.#interval = null;
    }
    this.clear();
  }

  #render(force = false): void {
    if (this.#disposed) return;
    const now = this.#now();
    const elapsed = now - this.#lastRender;
    if (!force && elapsed < this.#debounceMs) {
      if (this.#timer) return;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#render(true);
      }, this.#debounceMs - elapsed);
      this.#timer.unref?.();
      return;
    }
    this.#lastRender = now;

    const active = activeRecords(this.#records);
    const status = active.length > 0 ? `${active.length} active` : undefined;
    const lines = formatWidgetLines(this.#records, { width: this.#width(), now });
    const serialized = lines.join("\n");

    try {
      if (status !== this.#lastStatus) {
        this.#ui.setStatus(STATUS_KEY, status);
        this.#lastStatus = status;
      }
      if (serialized !== this.#lastLines) {
        this.#ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });
        this.#lastLines = serialized;
      }
    } catch {
      // A closed UI must not break a monitor callback.
    }
  }
}

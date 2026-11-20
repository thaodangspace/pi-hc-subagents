/**
 * Parent-side settle-hint hub.
 *
 * One long-lived notification subscription per child, fanned out to any number
 * of bounded listeners. A hint is advisory: it says "the child's turn ended",
 * never what the child produced, and polling stays authoritative. Every
 * transport and listener failure is contained here so a wait loop never sees a
 * transport exception and never loses its poll fallback.
 */
import {
  subscribeChildNotifications,
  type NotificationSubscription,
} from "../child/pipe-transport.ts";
import type { HcSubagentError } from "../core/error.ts";
import type { PipeNotification, PipeNotificationStatus } from "../child/pipe-protocol.ts";
import type { WakeSource } from "./wake-gate.ts";

export const MAX_SETTLE_HINT_LISTENERS = 8;
export const MAX_SETTLE_HINT_SEEN = 32;
export const MAX_RETAINED_SETTLE_STATS = 64;

export interface SettleHint {
  childId: string;
  turn: number; // 0 = unknown turn
  status: PipeNotificationStatus;
  at: number; // Date.parse of the child frame's `at`
  sessionFile?: string | null;
}

export interface SettleHintStats {
  childId: string;
  state: "idle" | "connecting" | "open" | "degraded" | "closed";
  hints: number; // accepted unique hints (after de-dupe)
  wakes: number; // listener deliveries (fan-out count)
  /** Woken waits whose observation was not a terminal transition. */
  falseWakes: number;
  staleDrops: number; // per-listener skips whose `since` is after the hint `at`
  duplicateDrops: number; // repeated (turn,status) frames
  listenerErrors: number; // listener throws that were contained
  listenerDrops: number; // registrations refused by the listener cap
  duplicateStarts: number; // start() calls for a child that is already started
  listeners: number; // currently registered listeners
  reconnects: number; // transport reconnect count
  degraded: boolean; // sticky: the transport hit its reconnect budget once
}

export type SettleHintTransportInput = {
  pipeName: string;
  onSettled(notification: PipeNotification): void;
  onTransportError(error: HcSubagentError): void;
  onDegraded(error: HcSubagentError): void;
  onReconnect(attempt: number, delayMs: number): void;
};

export interface SettleHintHubOptions {
  /** Test seam; defaults to subscribeChildNotifications from src/child/pipe-transport.ts. */
  transport?: (input: SettleHintTransportInput) => NotificationSubscription;
}

type SettleHintState = SettleHintStats["state"];

interface ListenerRecord {
  listener: (hint: SettleHint) => void;
  sinceMs?: number;
}

interface ChildEntry {
  childId: string;
  subscription: NotificationSubscription | null;
  listeners: Set<ListenerRecord>;
  /** `turn:status` → hint `at`, FIFO-bounded so a noisy child stays cheap. */
  seen: Map<string, number>;
  hints: number;
  wakes: number;
  falseWakes: number;
  staleDrops: number;
  duplicateDrops: number;
  listenerErrors: number;
  listenerDrops: number;
  duplicateStarts: number;
  reconnects: number;
  degraded: boolean;
  /** Set once the channel is terminal, independent of what the subscription reports. */
  terminal: "degraded" | "closed" | null;
}

function newEntry(childId: string): ChildEntry {
  return {
    childId,
    subscription: null,
    listeners: new Set<ListenerRecord>(),
    seen: new Map<string, number>(),
    hints: 0,
    wakes: 0,
    falseWakes: 0,
    staleDrops: 0,
    duplicateDrops: 0,
    listenerErrors: 0,
    listenerDrops: 0,
    duplicateStarts: 0,
    reconnects: 0,
    degraded: false,
    terminal: null,
  };
}

function noop(): void {
  // Idempotent no-op unsubscribe (refused or already-closed registration).
}

function parseSince(since: number | string | undefined): number | undefined {
  if (typeof since === "number") return Number.isFinite(since) ? since : undefined;
  if (typeof since === "string") {
    const parsed = Date.parse(since);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * `at` is child-clock and decorative; a hand-built frame must not poison
 * staleness comparisons with `NaN`, so a non-finite parse reads as "very old".
 */
function hintTimestamp(at: string): number {
  const parsed = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function stateOf(entry: ChildEntry): SettleHintState {
  if (entry.terminal) return entry.terminal;
  const subscription = entry.subscription;
  if (subscription) return subscription.state;
  return "idle";
}

function reconnectsOf(entry: ChildEntry): number {
  const subscription = entry.subscription;
  if (!subscription) return entry.reconnects;
  try {
    return subscription.reconnects;
  } catch {
    return entry.reconnects;
  }
}

function snapshot(entry: ChildEntry): SettleHintStats {
  return {
    childId: entry.childId,
    state: stateOf(entry),
    hints: entry.hints,
    wakes: entry.wakes,
    falseWakes: entry.falseWakes,
    staleDrops: entry.staleDrops,
    duplicateDrops: entry.duplicateDrops,
    listenerErrors: entry.listenerErrors,
    listenerDrops: entry.listenerDrops,
    duplicateStarts: entry.duplicateStarts,
    listeners: entry.listeners.size,
    reconnects: reconnectsOf(entry),
    degraded: entry.degraded || entry.subscription?.state === "degraded",
  };
}

export class SettleHintHub {
  readonly #transport: (input: SettleHintTransportInput) => NotificationSubscription;
  readonly #active = new Map<string, ChildEntry>();
  /** FIFO of final snapshots for closed children, bounded by MAX_RETAINED_SETTLE_STATS. */
  readonly #retained = new Map<string, SettleHintStats>();

  constructor(options: SettleHintHubOptions = {}) {
    this.#transport =
      options.transport ?? ((input: SettleHintTransportInput) => subscribeChildNotifications(input));
  }

  get size(): number {
    return this.#active.size;
  }

  has(childId: string): boolean {
    return this.#active.has(childId);
  }

  /**
   * Idempotent per child. Returns false without a non-empty `pipeName`
   * (poll-only) or when the child is already started. Listeners registered
   * before the first `start()` are kept.
   */
  start(childId: string, pipeName: string): boolean {
    if (typeof childId !== "string" || childId.length === 0) return false;
    const name = typeof pipeName === "string" ? pipeName.trim() : "";
    if (name.length === 0) return false;

    const existing = this.#active.get(childId);
    if (existing?.subscription) {
      existing.duplicateStarts += 1;
      return false;
    }
    if (existing) return this.#attach(existing, pipeName);

    // A new episode for a child whose previous snapshot was retained.
    this.#retained.delete(childId);
    const entry = newEntry(childId);
    this.#active.set(childId, entry);
    return this.#attach(entry, pipeName);
  }

  /**
   * Idempotent close of the child's subscription. The final counters stay
   * readable through `stats(childId)`; listeners are released because a
   * closed child can no longer emit a hint.
   */
  close(childId: string): void {
    const entry = this.#active.get(childId);
    if (!entry) return;
    this.#retire(entry);
  }

  /** Close every subscription and empty the hub, including retained snapshots. */
  closeAll(): void {
    for (const entry of this.#active.values()) {
      const subscription = entry.subscription;
      entry.subscription = null;
      entry.listeners.clear();
      entry.seen.clear();
      if (subscription) {
        try {
          subscription.close();
        } catch {
          // Contained: teardown must not fail because a socket was already gone.
        }
      }
    }
    this.#active.clear();
    this.#retained.clear();
  }

  /**
   * Subscribe a listener; returns an idempotent unsubscribe. Registering for a
   * child the hub never saw opens an idle entry (no transport until `start`).
   * A closed child is not resurrected: its snapshot is final.
   */
  onSettled(
    childId: string,
    listener: (hint: SettleHint) => void,
    options: { since?: number | string } = {},
  ): () => void {
    if (typeof childId !== "string" || childId.length === 0) return noop;
    if (typeof listener !== "function") return noop;

    let entry = this.#active.get(childId);
    if (!entry) {
      if (this.#retained.has(childId)) return noop;
      entry = newEntry(childId);
      this.#active.set(childId, entry);
    }
    if (entry.listeners.size >= MAX_SETTLE_HINT_LISTENERS) {
      entry.listenerDrops += 1;
      return noop;
    }

    const record: ListenerRecord = { listener };
    const sinceMs = parseSince(options.since);
    if (sinceMs !== undefined) record.sinceMs = sinceMs;
    entry.listeners.add(record);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.#active.get(childId);
      if (!current || current !== entry) return;
      current.listeners.delete(record);
    };
  }

  /**
   * A wait loop woke but the observed transition was not terminal. Advisory
   * bookkeeping only: unknown or closed children are a silent no-op.
   */
  noteFalseWake(childId: string): void {
    const entry = this.#active.get(childId);
    if (!entry) return;
    entry.falseWakes += 1;
  }

  /**
   * A listener dropped a hint because its turn predated the wait. Counted on
   * the same `staleDrops` line as the hub's own `since` filter.
   */
  noteStaleWake(childId: string): void {
    const entry = this.#active.get(childId);
    if (!entry) return;
    entry.staleDrops += 1;
  }

  /** Final snapshot survives `close(childId)`; undefined only for a child the hub never saw. */
  stats(childId: string): SettleHintStats | undefined {
    const entry = this.#active.get(childId);
    if (entry) return snapshot(entry);
    const retained = this.#retained.get(childId);
    return retained ? { ...retained } : undefined;
  }

  #attach(entry: ChildEntry, pipeName: string): boolean {
    let subscription: NotificationSubscription;
    try {
      subscription = this.#transport({
        pipeName,
        onSettled: (notification) => this.#handleHint(entry, notification),
        onTransportError: () => {
          if (this.#active.get(entry.childId) !== entry) return;
          // A protocol failure ends the channel but is not budget exhaustion.
          entry.terminal ??= "closed";
        },
        onDegraded: () => {
          if (this.#active.get(entry.childId) !== entry) return;
          entry.degraded = true;
          entry.terminal ??= "degraded";
        },
        onReconnect: () => {
          // `reconnects` is read from the subscription on every snapshot.
        },
      });
    } catch {
      // Fail closed: the child is poll-only, its counters stay readable.
      entry.terminal = "closed";
      this.#retire(entry);
      return false;
    }
    entry.subscription = subscription;
    return true;
  }

  #handleHint(entry: ChildEntry, notification: PipeNotification): void {
    if (this.#active.get(entry.childId) !== entry) return;

    const key = `${notification.turn}:${notification.status}`;
    if (entry.seen.has(key)) {
      entry.duplicateDrops += 1;
      return;
    }
    const at = hintTimestamp(notification.at);
    entry.seen.set(key, at);
    while (entry.seen.size > MAX_SETTLE_HINT_SEEN) {
      const oldest = entry.seen.keys().next();
      if (oldest.done) break;
      entry.seen.delete(oldest.value);
    }
    entry.hints += 1;

    const hint: SettleHint = {
      childId: entry.childId,
      turn: notification.turn,
      status: notification.status,
      at,
    };
    if (notification.sessionFile !== undefined) hint.sessionFile = notification.sessionFile;

    // Snapshot the listener list: a listener may unsubscribe during fan-out.
    for (const record of [...entry.listeners]) {
      if (!entry.listeners.has(record)) continue;
      if (record.sinceMs !== undefined && at < record.sinceMs) {
        entry.staleDrops += 1;
        continue;
      }
      entry.wakes += 1;
      try {
        record.listener(hint);
      } catch {
        entry.listenerErrors += 1;
      }
    }
  }

  #retire(entry: ChildEntry): void {
    if (this.#active.get(entry.childId) === entry) this.#active.delete(entry.childId);
    const subscription = entry.subscription;
    if (subscription) entry.reconnects = reconnectsOf(entry);
    entry.subscription = null;
    if (subscription) {
      try {
        subscription.close();
      } catch {
        // Contained: the channel is gone either way, and the snapshot stays.
      }
    }
    entry.listeners.clear();
    entry.seen.clear();
    entry.terminal = "closed";
    this.#retained.delete(entry.childId);
    this.#retained.set(entry.childId, snapshot(entry));
    while (this.#retained.size > MAX_RETAINED_SETTLE_STATS) {
      const oldest = this.#retained.keys().next();
      if (oldest.done) break;
      this.#retained.delete(oldest.value);
    }
  }
}

/**
 * Bounded observability view of one child's hint channel. Counters only: no
 * task text, result text, paths, or per-hint detail.
 */
export interface SettleHintWakeSummary {
  mode: "push" | "poll";
  hints: number;
  wakes: number;
  falseWakes: number;
  staleDrops: number;
  duplicateDrops: number;
  reconnects: number;
  degraded: boolean;
}

const MAX_SUMMARY_COUNT = Number.MAX_SAFE_INTEGER;

/** Non-negative integer, saturating so a display line stays bounded. */
function boundedCount(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(MAX_SUMMARY_COUNT, Math.max(0, Math.trunc(value)));
}

function liveEpisode(state: SettleHintStats["state"] | undefined): boolean {
  return state === "connecting" || state === "open" || state === "degraded";
}

/**
 * One child's wake summary, or `undefined` when the feature is off or the hub
 * does not exist (poll-only). A retained final snapshot stays readable so an
 * operator can see how a finished run was settled.
 */
export function wakeSummary(
  hub: SettleHintHub | undefined,
  childId: string,
  enabled: boolean,
): SettleHintWakeSummary | undefined {
  if (!enabled || !hub) return undefined;
  const stats = typeof childId === "string" && childId.length > 0 ? hub.stats(childId) : undefined;
  return {
    mode: liveEpisode(stats?.state) ? "push" : "poll",
    hints: boundedCount(stats?.hints ?? 0),
    wakes: boundedCount(stats?.wakes ?? 0),
    falseWakes: boundedCount(stats?.falseWakes ?? 0),
    staleDrops: boundedCount(stats?.staleDrops ?? 0),
    duplicateDrops: boundedCount(stats?.duplicateDrops ?? 0),
    reconnects: boundedCount(stats?.reconnects ?? 0),
    degraded: stats?.degraded === true,
  };
}

/**
 * One bounded, newline-free aggregate line for `/hc-subagents config`. Child
 * ids are de-duplicated and only their counters are summed, so the line can
 * never grow with the number of children or leak their identities.
 */
export function formatSettleHintSummary(
  hub: SettleHintHub | undefined,
  enabled: boolean,
  childIds: readonly string[],
): string {
  let hints = 0;
  let wakes = 0;
  let falseWakes = 0;
  let staleDrops = 0;
  let duplicateDrops = 0;
  let reconnects = 0;
  let degraded = false;

  const seen = new Set<string>();
  for (const childId of childIds) {
    if (typeof childId !== "string" || childId.length === 0 || seen.has(childId)) continue;
    seen.add(childId);
    const summary = wakeSummary(hub, childId, enabled);
    if (!summary) continue;
    hints += summary.hints;
    wakes += summary.wakes;
    falseWakes += summary.falseWakes;
    staleDrops += summary.staleDrops;
    duplicateDrops += summary.duplicateDrops;
    reconnects += summary.reconnects;
    degraded ||= summary.degraded;
  }

  const mode = enabled && hub ? "push" : "poll";
  return [
    `settle hints: mode=${mode}`,
    `hints=${boundedCount(hints)}`,
    `wakes=${boundedCount(wakes)}`,
    `falseWakes=${boundedCount(falseWakes)}`,
    `stale=${boundedCount(staleDrops)}`,
    `dup=${boundedCount(duplicateDrops)}`,
    `reconnects=${boundedCount(reconnects)}`,
    `degraded=${degraded}`,
  ].join(" ");
}

/**
 * Structural wake source for one child, or `undefined` when no hub has a live
 * entry for it. This is the only bridge from the hub to the wait loops, so the
 * production path stays poll-only until a hub is started for the child.
 */
export function wakeSourceFor(hub: SettleHintHub | undefined, childId: string): WakeSource | undefined {
  if (!hub) return undefined;
  if (typeof childId !== "string" || childId.length === 0) return undefined;
  if (!hub.has(childId)) return undefined;
  return {
    subscribe: (listener, options) => hub.onSettled(childId, listener, options),
    stats: () => hub.stats(childId),
    noteFalseWake: () => hub.noteFalseWake(childId),
    noteStaleWake: () => hub.noteStaleWake(childId),
  };
}

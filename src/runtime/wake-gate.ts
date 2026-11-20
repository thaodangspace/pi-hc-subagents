/**
 * Shared wait primitive for the two poll loops (`waitForChild`, `AsyncMonitor`).
 *
 * A gate races `timer | wake() | abort()`. A wake only shortens a wait: the
 * state machine remains the only source of truth, and dropping every hint
 * leaves the poll cadence exactly as it was before the push channel existed.
 * One implementation means one set of double-resolve, coalescing, and
 * timer-leak rules for both layers.
 */
import type { SettleHint, SettleHintStats } from "./settle-hints.ts";

/** Two hints closer than this produce one wake; a hint storm cannot spin a loop. */
export const MIN_WAKE_GAP_MS = 100;

export type WakeWaitResult = "timer" | "wake" | "abort";

/**
 * Structural view of a settle-hint subscription. `SettleHintHub` satisfies it
 * through `wakeSourceFor()`, so `src/child/**` never imports the hub at runtime
 * and the production path can pass nothing until Phase 5 starts hubs.
 */
export interface WakeSource {
  subscribe(listener: (hint: SettleHint) => void, options?: { since?: number }): () => void;
  stats?(): SettleHintStats | undefined;
  noteFalseWake?(): void;
  noteStaleWake?(): void;
}

export interface WakeGateOptions {
  /** Coalescing floor; defaults to MIN_WAKE_GAP_MS. */
  minGapMs?: number;
  /** Test seam for the coalescing clock. */
  now?: () => number;
  /** Unref the timer (monitors) or keep it ref'd (foreground waits). */
  unref?: boolean;
}

export class WakeGate {
  readonly #minGapMs: number;
  readonly #now: () => number;
  readonly #unref: boolean;
  #waiting = false;
  #armed = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #resolve: ((result: WakeWaitResult) => void) | null = null;
  #lastWakeAt: number | null = null;

  constructor(options: WakeGateOptions = {}) {
    const gap = options.minGapMs ?? MIN_WAKE_GAP_MS;
    this.#minGapMs = Number.isFinite(gap) && gap > 0 ? gap : 0;
    this.#now = options.now ?? Date.now;
    this.#unref = options.unref === true;
  }

  /** A wait is pending. */
  get waiting(): boolean {
    return this.#waiting;
  }

  /** The gate's own timer is pending (never true after any exit path). */
  get armed(): boolean {
    return this.#armed;
  }

  /**
   * Resolve as `"timer"` after `ms`, or earlier as `"wake"`/`"abort"`.
   * One wait at a time: a concurrent call is a programming error.
   */
  wait(ms: number, signal?: AbortSignal): Promise<WakeWaitResult> {
    if (this.#waiting) throw new Error("WakeGate: a wait is already pending");
    if (signal?.aborted) return Promise.resolve("abort");

    this.#waiting = true;
    return new Promise<WakeWaitResult>((resolve) => {
      let settled = false;
      const finish = (result: WakeWaitResult): void => {
        if (settled) return;
        settled = true;
        this.#waiting = false;
        this.#resolve = null;
        if (this.#timer !== null) {
          clearTimeout(this.#timer);
          this.#timer = null;
        }
        this.#armed = false;
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => finish("abort");

      this.#resolve = finish;
      signal?.addEventListener("abort", onAbort, { once: true });

      const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
      this.#timer = setTimeout(() => {
        this.#timer = null;
        this.#armed = false;
        finish("timer");
      }, delay);
      this.#armed = true;
      if (this.#unref) this.#timer.unref?.();
    });
  }

  /**
   * Resolve a pending wait as `"wake"`. A wake with no waiter is a no-op and
   * does not start the coalescing window; a wake within `minGapMs` of the last
   * emitted wake is dropped.
   */
  wake(): void {
    if (!this.#waiting) return;
    const now = this.#now();
    if (this.#lastWakeAt !== null && now - this.#lastWakeAt < this.#minGapMs) return;
    this.#lastWakeAt = now;
    this.#resolve?.("wake");
  }

  /** Resolve a pending wait as `"abort"`; safe when idle. */
  abort(): void {
    if (!this.#waiting) return;
    this.#resolve?.("abort");
  }
}

/**
 * Background child monitors.
 *
 * One monitor per background child. It shares the wait state machine with the
 * synchronous path, publishes `result.json` on settlement, notifies the parent
 * through hooks, and releases its scheduler slot exactly once. Timers are
 * `unref`ed so a monitor never keeps the process alive on its own.
 */
import type { TerminalRecord } from "../core/hc-types.ts";
import { toHcSubagentError } from "../core/error.ts";
import { parseSessionWithRetry, type ParsedSessionFile } from "../child/session-read.ts";
import { abortChild } from "../child/wait-child.ts";
import type { ToolSession } from "../tools/session.ts";
import {
  type FinalizeResult,
  finalizeFromSession,
  persistRunSummary,
  readScreenTail,
} from "./finalize.ts";
import { ChildStateMachine, observationFromTerminal, type Transition } from "./state-machine.ts";
import { cleanupFinishedChild } from "./lifecycle.ts";
import type { SubagentRecord } from "./types.ts";
import { WakeGate, type WakeSource } from "./wake-gate.ts";

export interface MonitorHooks {
  onBlocked?: (record: SubagentRecord, episode: number, kind: string | null, message: string, screenTail: string) => void;
  /** Called after `result.json` is published, for both success and failure. */
  onSettled?: (finalized: FinalizeResult) => void;
  onStateChange?: (record: SubagentRecord, previousState: SubagentRecord["state"]) => void;
}

export interface MonitorOptions {
  session: ToolSession;
  record: SubagentRecord;
  /** The terminal snapshot returned by `terminal.run`. */
  terminal: TerminalRecord;
  machine: ChildStateMachine;
  turnStartedAtMs: number;
  resultFile: string;
  /** Resolves the child session file; may already be in flight. */
  locate: () => Promise<string | null>;
  cancelLocate?: () => void;
  /** Releases the scheduler slot; called exactly once. */
  release?: () => void;
  pollIntervalMs: number;
  /** Advisory settle-hint source; absent means the poll loop is unchanged. */
  wake?: WakeSource;
  hooks?: MonitorHooks;
}

const MIN_POLL_MS = 250;

export class AsyncMonitor {
  readonly childId: string;
  readonly #options: MonitorOptions;
  readonly #gate = new WakeGate({ unref: true });
  #stopped = false;
  #released = false;
  #onStop: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  /** True when the current observation followed a wake rather than a timer. */
  #woke = false;

  constructor(options: MonitorOptions) {
    this.#options = options;
    this.childId = options.record.childId;
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  set onStop(callback: () => void) {
    this.#onStop = callback;
  }

  start(): void {
    void this.#run().catch(() => this.stop("monitor error"));
  }

  stop(_reason = "stopped"): void {
    if (this.#stopped) return;
    this.#stopped = true;
    // Shutdown must never wait out an interval.
    this.#gate.abort();
    this.#options.cancelLocate?.();
    this.#release();
    this.#onStop?.();
  }

  async #run(): Promise<void> {
    const { machine } = this.#options;
    const wake = this.#options.wake;
    if (wake) {
      this.#unsubscribe = wake.subscribe(
        (hint) => {
          if (hint.turn > 0 && hint.turn <= machine.baselineTurn) {
            wake.noteStaleWake?.();
            return;
          }
          this.#gate.wake();
        },
        { since: machine.startedAtMs },
      );
    }
    try {
      await this.#observe(machine);
    } finally {
      this.#unsubscribe?.();
      this.#unsubscribe = null;
      this.#gate.abort();
    }
  }

  async #observe(machine: ChildStateMachine): Promise<void> {
    const { session, record } = this.#options;
    let last = this.#options.terminal;

    for (;;) {
      if (this.#stopped) return;

      let terminal: TerminalRecord;
      try {
        terminal = await session.runtime.core.get(record.terminal);
      } catch (error) {
        if (this.#stopped) return;
        const normalized = toHcSubagentError(error);
        if (normalized.code === "not_found" || normalized.code === "finished") {
          await this.#finishExited(last, "terminal was removed or could not be found");
          return;
        }
        if (normalized.code !== "unavailable" && normalized.code !== "timeout") {
          await this.#finishFallback(last, "error", normalized.message);
          return;
        }
        const deadline = machine.deadlineTransition();
        if (deadline?.type === "startup_timeout") {
          await this.#finishStartupTimeout(last);
          return;
        }
        if (deadline?.type === "cancelled") return;
        await this.#waitForWake();
        continue;
      }

      if (this.#stopped) return;
      last = terminal;
      const transition = machine.observe(observationFromTerminal(terminal));
      this.#applyTerminal(terminal, transition);

      switch (transition.type) {
        case "blocked":
          await this.#handleBlocked(terminal, transition);
          break;
        case "settled":
          await this.#finishSettled(terminal, this.#woke ? "push" : "poll");
          return;
        case "exited":
          await this.#finishExited(terminal, "terminal exited before producing a result");
          return;
        case "startup_timeout":
          await this.#finishStartupTimeout(terminal);
          return;
        case "cancelled":
          return;
        case "starting":
        case "working":
        case "continue":
        case "wait_timeout":
          // Monitors are unbounded: a background child may work for hours.
          if (this.#woke) this.#options.wake?.noteFalseWake?.();
          break;
      }

      await this.#waitForWake();
    }
  }

  #applyTerminal(terminal: TerminalRecord, transition: Transition): void {
    const { session, record, machine } = this.#options;
    const existing = session.registry.get(record.childId) ?? record;
    session.registry.applyTerminal(record.childId, terminal);

    let state: SubagentRecord["state"];
    if (transition.type === "blocked" || machine.phase === "blocked") {
      state = "blocked";
    } else if (machine.sawWorking || terminal.turn > machine.baselineTurn) {
      state = "working";
    } else {
      state = "starting";
    }

    if (state !== existing.state) {
      const updated = session.registry.update(record.childId, {
        state,
        coreStatus: (terminal.status?.state ?? existing.coreStatus) as SubagentRecord["coreStatus"],
      });
      void persistRunSummary(updated, {
        state: state === "blocked" ? "blocked" : "working",
        coreStatus: updated.coreStatus,
        ...(updated.sessionFile ? { sessionFile: updated.sessionFile } : {}),
      });
      this.#options.hooks?.onStateChange?.(updated, existing.state);
    }
  }

  async #handleBlocked(
    terminal: TerminalRecord,
    transition: Extract<Transition, { type: "blocked" }>,
  ): Promise<void> {
    const { session, record, hooks } = this.#options;
    const screenTail = await readScreenTail(session, terminal.address);
    if (this.#stopped) return;
    const previousState = (session.registry.get(record.childId) ?? record).state;
    const updated = session.registry.update(record.childId, {
      state: "blocked",
      coreStatus: "blocked",
      lastScreen: screenTail,
      turns: (session.registry.get(record.childId) ?? record).turns.map((turn) =>
        turn.state === "running"
          ? {
              ...turn,
              state: "blocked" as const,
              blocked: {
                ...(transition.kind ? { kind: transition.kind } : {}),
                ...(transition.message ? { message: transition.message } : {}),
              },
            }
          : turn,
      ),
    });
    await persistRunSummary(updated, {
      state: "blocked",
      coreStatus: "blocked",
      ...(updated.sessionFile ? { sessionFile: updated.sessionFile } : {}),
    });
    hooks?.onStateChange?.(updated, previousState);
    hooks?.onBlocked?.(updated, transition.episode, transition.kind, transition.message, screenTail);
  }

  async #finishSettled(terminal: TerminalRecord, observedBy: "push" | "poll"): Promise<void> {
    const parsed = await this.#parseSession(true);
    const finalized = await finalizeFromSession({
      session: this.#options.session,
      record: this.#options.session.registry.get(this.childId) ?? this.#options.record,
      terminal,
      parsed,
      turnStartedAtMs: this.#options.turnStartedAtMs,
      resultFile: this.#options.resultFile,
      fallbackOutcome: "incomplete",
      fallbackError: parsed ? "could not parse a result for this turn" : "no session file appeared for this child",
      observedBy,
    });
    await this.#publish(finalized);
  }

  async #finishExited(terminal: TerminalRecord, reason: string): Promise<void> {
    const parsed = await this.#parseSession(true);
    const failedParse = !parsed || parsed.state === "failed" || parsed.state === "pending";
    if (failedParse) {
      const finalized = await finalizeFromSession({
        session: this.#options.session,
        record: this.#options.session.registry.get(this.childId) ?? this.#options.record,
        terminal,
        parsed,
        turnStartedAtMs: this.#options.turnStartedAtMs,
        resultFile: this.#options.resultFile,
        fallbackOutcome: "exited",
        fallbackError:
          terminal.exitCode !== null
            ? `${reason} (exit ${terminal.exitCode})`
            : reason,
      });
      await this.#publish(finalized);
      return;
    }
    const finalized = await finalizeFromSession({
      session: this.#options.session,
      record: this.#options.session.registry.get(this.childId) ?? this.#options.record,
      terminal,
      parsed,
      turnStartedAtMs: this.#options.turnStartedAtMs,
      resultFile: this.#options.resultFile,
      fallbackOutcome: "incomplete",
      fallbackError: reason,
    });
    await this.#publish(finalized);
  }

  async #finishStartupTimeout(terminal: TerminalRecord): Promise<void> {
    const { session, record } = this.#options;
    if (session.runtime.config.killOnTimeout) {
      await abortChild(session.runtime.core, record.terminal, {
        kill: true,
        pollMs: session.runtime.config.pollIntervalMs,
      }).catch(() => {});
    }
    await this.#finishFallback(terminal, "timeout", "the task did not start before the startup timeout");
  }

  async #finishFallback(terminal: TerminalRecord, outcome: "error" | "timeout" | "exited", error: string): Promise<void> {
    const finalized = await finalizeFromSession({
      session: this.#options.session,
      record: this.#options.session.registry.get(this.childId) ?? this.#options.record,
      terminal: { ...terminal, state: terminal.state === "live" ? "live" : "finished" },
      parsed: null,
      turnStartedAtMs: this.#options.turnStartedAtMs,
      resultFile: this.#options.resultFile,
      fallbackOutcome: outcome,
      fallbackError: error,
    });
    await this.#publish(finalized);
  }

  async #parseSession(final: boolean): Promise<ParsedSessionFile | null> {
    const { session, record } = this.#options;
    const file = (await this.#options.locate().catch(() => null)) ?? record.sessionFile;
    if (!file) return null;
    const current = session.registry.get(this.childId) ?? record;
    if (current.sessionFile !== file) {
      session.registry.update(this.childId, { sessionFile: file });
      void session.runtime.core.label(record.terminal, { "pi-hc-session": file }).catch(() => {});
    }
    return parseSessionWithRetry(
      file,
      { turnStartedAtMs: this.#options.turnStartedAtMs, final },
      { attempts: 6, delayMs: 100 },
    ).catch(() => null);
  }

  async #publish(finalized: FinalizeResult): Promise<void> {
    const { session } = this.#options;
    this.#options.hooks?.onSettled?.(finalized);
    if (session.runtime.config.cleanup === "remove") {
      await cleanupFinishedChild(session, finalized.record, { remove: true }).catch(() => {});
    }
    this.stop("settled");
  }

  #release(): void {
    if (this.#released) return;
    this.#released = true;
    this.#options.release?.();
  }

  async #waitForWake(): Promise<void> {
    if (this.#stopped) return;
    const interval = Math.max(MIN_POLL_MS, this.#options.pollIntervalMs);
    const result = await this.#gate.wait(interval);
    // `abort` only follows stop(), which the loop top re-checks.
    this.#woke = result === "wake";
  }
}

export class MonitorManager {
  #monitors = new Map<string, AsyncMonitor>();

  start(options: MonitorOptions): AsyncMonitor {
    const existing = this.#monitors.get(options.record.childId);
    if (existing) existing.stop("replaced");
    const monitor = new AsyncMonitor(options);
    this.#monitors.set(options.record.childId, monitor);
    monitor.onStop = () => {
      if (this.#monitors.get(options.record.childId) === monitor) {
        this.#monitors.delete(options.record.childId);
      }
    };
    monitor.start();
    return monitor;
  }

  get(childId: string): AsyncMonitor | undefined {
    return this.#monitors.get(childId);
  }

  has(childId: string): boolean {
    return this.#monitors.has(childId);
  }

  get size(): number {
    return this.#monitors.size;
  }

  stop(childId: string): boolean {
    const monitor = this.#monitors.get(childId);
    if (!monitor) return false;
    monitor.stop("stopped");
    this.#monitors.delete(childId);
    return true;
  }

  stopAll(): void {
    for (const monitor of [...this.#monitors.values()]) monitor.stop("shutdown");
    this.#monitors.clear();
  }
}

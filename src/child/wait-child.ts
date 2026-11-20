/**
 * Poll `terminal.get` and drive the pure state machine.
 *
 * This is the single wait loop used by sync spawn, control wait, and (later)
 * async monitors. Blocked is returned immediately for sync callers; monitors
 * can continue observing after a blocked episode.
 */
import type { CoreClient } from "../core/core-client.ts";
import { HcSubagentError, toHcSubagentError } from "../core/error.ts";
import type { CoreEvent, TerminalRecord } from "../core/hc-types.ts";
import { HC_MIN_VERSION, compareVersions, decodeCoreEvent } from "../core/hc-types.ts";
import { ChildStateMachine, observationFromTerminal, type Transition } from "../runtime/state-machine.ts";
import { WakeGate, type WakeSource } from "../runtime/wake-gate.ts";

export type ObservedBy = "push" | "poll";

export type WaitOutcome =
  | { kind: "settled"; terminal: TerminalRecord; transition: Transition; observedBy: ObservedBy }
  | { kind: "blocked"; terminal: TerminalRecord; transition: Transition; episode: number }
  | { kind: "exited"; terminal: TerminalRecord }
  | { kind: "startup_timeout"; terminal: TerminalRecord | null }
  | { kind: "wait_timeout"; terminal: TerminalRecord | null }
  | { kind: "cancelled"; terminal: TerminalRecord | null; reason: string }
  | { kind: "terminal_lost" };

export interface WaitChildOptions {
  core: CoreClient;
  terminal: string;
  machine: ChildStateMachine;
  pollIntervalMs: number;
  signal?: AbortSignal;
  /**
   * Advisory settle-hint source. Absent (the default until a hub runs) means
   * the loop is exactly the pre-push poll loop.
   */
  wake?: WakeSource;
  onObservation?: (terminal: TerminalRecord, transition: Transition) => void;
}

const MIN_POLL_MS = 250;
const UNAVAILABLE_RETRY_MS = 250;

export async function waitForChild(options: WaitChildOptions): Promise<WaitOutcome> {
  const pollMs = Math.max(MIN_POLL_MS, options.pollIntervalMs);
  const wake = options.wake;
  const gate = new WakeGate();
  let lastTerminal: TerminalRecord | null = null;
  /** True when the current observation followed a wake rather than a poll timer. */
  let woke = false;

  // One subscription for the whole wait: hints only shorten a timer.
  const unsubscribe = wake?.subscribe(
    (hint) => {
      if (hint.turn > 0 && hint.turn <= options.machine.baselineTurn) {
        wake?.noteStaleWake?.();
        return;
      }
      gate.wake();
    },
    { since: options.machine.startedAtMs },
  );

  try {
    for (;;) {
      if (options.signal?.aborted) {
        options.machine.abort("tool aborted");
        return { kind: "cancelled", terminal: lastTerminal, reason: "tool aborted" };
      }

      let terminal: TerminalRecord | null = null;
      try {
        terminal = await options.core.get(options.terminal);
      } catch (error) {
        const normalized = toHcSubagentError(error);
        if (normalized.code === "aborted") {
          options.machine.abort("tool aborted");
          return { kind: "cancelled", terminal: lastTerminal, reason: "tool aborted" };
        }
        if (normalized.code === "not_found") return { kind: "terminal_lost" };
        if (normalized.code !== "unavailable" && normalized.code !== "timeout") throw normalized;
        // A transient core disconnect does not mean the child died, but the
        // overall wait deadline still applies.
        const deadline = options.machine.deadlineTransition();
        if (deadline?.type === "startup_timeout") return { kind: "startup_timeout", terminal: lastTerminal };
        if (deadline?.type === "wait_timeout") return { kind: "wait_timeout", terminal: lastTerminal };
        if (deadline?.type === "cancelled") {
          return { kind: "cancelled", terminal: lastTerminal, reason: deadline.reason };
        }
        woke = (await gate.wait(Math.min(pollMs, UNAVAILABLE_RETRY_MS), options.signal)) === "wake";
        continue;
      }

      lastTerminal = terminal;
      const transition = options.machine.observe(observationFromTerminal(terminal));
      options.onObservation?.(terminal, transition);

      switch (transition.type) {
        case "blocked":
          return {
            kind: "blocked",
            terminal,
            transition,
            episode: transition.episode,
          };
        case "settled":
          return { kind: "settled", terminal, transition, observedBy: woke ? "push" : "poll" };
        case "exited":
          return { kind: "exited", terminal };
        case "startup_timeout":
          return { kind: "startup_timeout", terminal };
        case "wait_timeout":
          return { kind: "wait_timeout", terminal };
        case "cancelled":
          return { kind: "cancelled", terminal, reason: transition.reason };
        case "starting":
        case "working":
        case "continue":
          if (woke) wake?.noteFalseWake?.();
          break;
      }

      woke = false;

      const waited = await gate.wait(pollMs, options.signal);
      if (waited === "abort") continue; // the loop top produces the existing cancelled outcome
      woke = waited === "wake";
    }
  } finally {
    unsubscribe?.();
    gate.abort();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abort policy: interrupt the current turn, wait up to 5 s for it to leave
 * `working`, then kill when `killOnAbort` is enabled.
 */
export async function abortChild(
  core: CoreClient,
  terminal: string,
  options: { kill: boolean; graceMs?: number; pollMs?: number },
): Promise<{ interrupted: boolean; killed: boolean; outcome: string | null }> {
  let interrupted = false;
  let outcome: string | null = null;
  try {
    const result = await core.interrupt(terminal);
    interrupted = true;
    outcome = result.outcome;
  } catch (error) {
    const normalized = toHcSubagentError(error);
    if (normalized.code !== "not_found" && normalized.code !== "finished") throw normalized;
  }

  const graceMs = options.graceMs ?? 5000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      const current = await core.get(terminal);
      if (current.state === "finished" || current.status?.state !== "working") {
        return { interrupted, killed: false, outcome };
      }
    } catch (error) {
      const normalized = toHcSubagentError(error);
      if (normalized.code === "not_found" || normalized.code === "finished") {
        return { interrupted, killed: false, outcome };
      }
    }
    await sleep(pollMs);
  }

  if (!options.kill) return { interrupted, killed: false, outcome };
  try {
    await core.kill(terminal);
    return { interrupted, killed: true, outcome };
  } catch (error) {
    const normalized = toHcSubagentError(error);
    if (normalized.code === "not_found" || normalized.code === "finished") {
      return { interrupted, killed: false, outcome };
    }
    throw normalized;
  }
}

export function terminalFromEvent(event: CoreEvent): TerminalRecord | null {
  return event.terminal ?? null;
}

export function decodeEventSafely(payload: unknown): CoreEvent | null {
  try {
    return decodeCoreEvent(payload);
  } catch {
    return null;
  }
}

export function isSupportedCore(version: string | null): boolean {
  return version !== null && compareVersions(version, HC_MIN_VERSION) >= 0;
}

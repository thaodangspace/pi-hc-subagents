/**
 * Pure child state machine.
 *
 * `terminal.turn` is the primary completion signal; status words are secondary.
 * Startup idle with an unchanged turn is not settlement. Blocked episodes are
 * never timed out or auto-answered.
 */

export type MachinePhase = "starting" | "working" | "blocked";

export interface StateMachineOptions {
  baselineTurn: number;
  startupTimeoutMs: number;
  waitTimeoutMs: number;
  now?: () => number;
}

export interface TerminalObservation {
  state: "live" | "finished";
  status: string | null;
  turn: number;
  exitCode?: number | null;
  signal?: number | null;
  statusKind?: string | null;
  statusMessage?: string | null;
}

export type Transition =
  | { type: "starting" }
  | { type: "working"; started: boolean }
  | { type: "blocked"; episode: number; kind: string | null; message: string }
  | { type: "settled"; reason: "turn_advanced" | "error_status"; status: string | null }
  | { type: "exited"; exitCode: number | null; signal: number | null }
  | { type: "startup_timeout" }
  | { type: "wait_timeout" }
  | { type: "cancelled"; reason: string }
  | { type: "continue" };

export class ChildStateMachine {
  readonly baselineTurn: number;
  readonly startupTimeoutMs: number;
  readonly waitTimeoutMs: number;
  readonly startedAtMs: number;
  readonly #now: () => number;
  readonly #startupDeadlineMs: number;
  readonly #waitDeadlineMs: number;

  #phase: MachinePhase = "starting";
  #sawWorking = false;
  #workStartedAtMs: number | null = null;
  #blockedEpisode = 0;
  #inBlockedEpisode = false;
  #cancelled: { reason: string } | null = null;
  #lastTransition: Transition = { type: "starting" };

  constructor(options: StateMachineOptions) {
    this.baselineTurn = options.baselineTurn;
    this.startupTimeoutMs = options.startupTimeoutMs;
    this.waitTimeoutMs = options.waitTimeoutMs;
    this.#now = options.now ?? (() => Date.now());
    this.startedAtMs = this.#now();
    this.#startupDeadlineMs = this.startedAtMs + options.startupTimeoutMs;
    this.#waitDeadlineMs = this.startedAtMs + options.waitTimeoutMs;
  }

  get phase(): MachinePhase {
    return this.#phase;
  }

  get sawWorking(): boolean {
    return this.#sawWorking;
  }

  get blockedEpisode(): number {
    return this.#blockedEpisode;
  }

  get workStartedAtMs(): number | null {
    return this.#workStartedAtMs;
  }

  get lastTransition(): Transition {
    return this.#lastTransition;
  }

  abort(reason = "aborted"): Transition {
    if (!this.#cancelled) this.#cancelled = { reason };
    const transition: Transition = { type: "cancelled", reason: this.#cancelled.reason };
    this.#lastTransition = transition;
    return transition;
  }

  observe(observation: TerminalObservation, now = this.#now()): Transition {
    const transition = this.#evaluate(observation, now);
    this.#lastTransition = transition;
    return transition;
  }

  #evaluate(observation: TerminalObservation, now: number): Transition {
    if (this.#cancelled) return { type: "cancelled", reason: this.#cancelled.reason };

    if (observation.state === "finished") {
      return {
        type: "exited",
        exitCode: observation.exitCode ?? null,
        signal: observation.signal ?? null,
      };
    }

    const status = observation.status;
    if (status === "working") {
      const firstWorking = !this.#sawWorking;
      this.#phase = "working";
      this.#sawWorking = true;
      this.#inBlockedEpisode = false;
      if (this.#workStartedAtMs === null) this.#workStartedAtMs = now;
      if (firstWorking) return { type: "working", started: true };
      if (now >= this.#waitDeadlineMs) return { type: "wait_timeout" };
      return { type: "working", started: false };
    }

    if (status === "blocked") {
      if (!this.#inBlockedEpisode) {
        this.#inBlockedEpisode = true;
        this.#blockedEpisode++;
        this.#phase = "blocked";
        return {
          type: "blocked",
          episode: this.#blockedEpisode,
          kind: observation.statusKind ?? null,
          message: observation.statusMessage ?? "",
        };
      }
      this.#phase = "blocked";
      return { type: "continue" };
    }

    if (this.#inBlockedEpisode) {
      // Leaving blocked clears the episode; a later block starts a new one.
      this.#inBlockedEpisode = false;
      this.#phase = "working";
    }

    if (status === "error") {
      return { type: "settled", reason: "error_status", status };
    }

    if (observation.turn > this.baselineTurn) {
      return { type: "settled", reason: "turn_advanced", status };
    }

    if (this.#phase === "starting") {
      if (now >= this.#startupDeadlineMs) return { type: "startup_timeout" };
      return { type: "starting" };
    }

    // A blocked child is never timed out: a human may be on the way.
    if (this.#phase === "blocked") return { type: "continue" };
    if (now >= this.#waitDeadlineMs) return { type: "wait_timeout" };
    return { type: "continue" };
  }
}

export function observationFromTerminal(terminal: {
  state: "live" | "finished";
  status: { state: string; kind?: string | null; message?: string } | null;
  turn: number;
  exitCode?: number | null;
  signal?: number | null;
}): TerminalObservation {
  return {
    state: terminal.state,
    status: terminal.status?.state ?? null,
    turn: terminal.turn,
    exitCode: terminal.exitCode ?? null,
    signal: terminal.signal ?? null,
    statusKind: terminal.status?.kind ?? null,
    statusMessage: terminal.status?.message ?? null,
  };
}

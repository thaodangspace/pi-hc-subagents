/**
 * Privacy-safe intertool events.
 *
 * Payloads carry identifiers, state, and paths — never task or result text
 * (except the explicit `taskPreview` opt-in on `spawned`). Listener failures
 * are isolated so one broken subscriber cannot break the producer.
 */
import type { SettleHintWakeSummary } from "../runtime/settle-hints.ts";
import type { SubagentRecord, SubagentState, TurnOutcome } from "../runtime/types.ts";

export const EVENT_NAMESPACE = "hc-subagents";
export const EVENT_VERSION = 1 as const;

export type SubagentEventType = "spawned" | "status" | "blocked" | "settled" | "failed" | "removed";

export interface SubagentEventBase {
  version: 1;
  seq: number;
  at: string;
  childId: string;
  runId: string;
  agent: string;
  terminal: string;
  state: SubagentState;
  turn: number;
}

export type SubagentEvent =
  | (SubagentEventBase & { type: "spawned"; taskPreview?: string })
  | (SubagentEventBase & {
      type: "status";
      coreStatus: string;
      previousState: SubagentState;
      /** Additive v1 field: bounded hint counters, never task/result text. */
      wake?: SettleHintWakeSummary;
    })
  | (SubagentEventBase & { type: "blocked"; kind?: string; message?: string })
  | (SubagentEventBase & { type: "settled"; outcome: TurnOutcome; resultPath: string })
  | (SubagentEventBase & { type: "failed"; outcome: TurnOutcome; error: string })
  | (SubagentEventBase & { type: "removed" });

export type SubagentEventListener = (event: SubagentEvent) => void;

export interface EventPublisherOptions {
  enabled: () => boolean;
  includeTaskPreview: () => boolean;
  emit?: (channel: string, payload: unknown) => void;
  now?: () => Date;
  onSubscriberError?: (error: unknown) => void;
}

function baseOf(record: SubagentRecord): Omit<SubagentEventBase, "version" | "seq" | "at"> {
  return {
    childId: record.childId,
    runId: record.runId,
    agent: record.agent,
    terminal: record.terminal,
    state: record.state,
    turn: record.turn,
  };
}

export class EventPublisher {
  readonly #options: EventPublisherOptions;
  readonly #listeners = new Set<SubagentEventListener>();
  #seq = 0;
  #disposed = false;

  constructor(options: EventPublisherOptions) {
    this.#options = options;
  }

  get seq(): number {
    return this.#seq;
  }

  subscribe(listener: SubagentEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get subscriberCount(): number {
    return this.#listeners.size;
  }

  spawned(record: SubagentRecord, task?: string): SubagentEvent | null {
    const extra =
      this.#options.includeTaskPreview() && typeof task === "string" && task.length > 0
        ? { taskPreview: task.slice(0, 200) }
        : {};
    return this.#emit({ ...baseOf(record), type: "spawned", ...extra });
  }

  status(
    record: SubagentRecord,
    previousState: SubagentState,
    wake?: SettleHintWakeSummary,
  ): SubagentEvent | null {
    return this.#emit({
      ...baseOf(record),
      type: "status",
      coreStatus: record.coreStatus,
      previousState,
      ...(wake === undefined ? {} : { wake }),
    });
  }

  blocked(record: SubagentRecord, kind?: string | null, message?: string | null): SubagentEvent | null {
    return this.#emit({
      ...baseOf(record),
      type: "blocked",
      ...(kind ? { kind } : {}),
      ...(message ? { message } : {}),
    });
  }

  settled(record: SubagentRecord, outcome: TurnOutcome, resultPath: string): SubagentEvent | null {
    return this.#emit({ ...baseOf(record), type: "settled", outcome, resultPath });
  }

  failed(record: SubagentRecord, outcome: TurnOutcome, error: string): SubagentEvent | null {
    return this.#emit({ ...baseOf(record), type: "failed", outcome, error });
  }

  removed(record: SubagentRecord): SubagentEvent | null {
    return this.#emit({ ...baseOf(record), type: "removed" });
  }

  dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }

  #emit(
    event: Omit<SubagentEventBase, "version" | "seq" | "at"> & { type: SubagentEventType } & Record<string, unknown>,
  ): SubagentEvent | null {
    if (this.#disposed || !this.#options.enabled()) return null;
    const payload = {
      ...event,
      version: EVENT_VERSION,
      seq: ++this.#seq,
      at: (this.#options.now?.() ?? new Date()).toISOString(),
    } as SubagentEvent;
    for (const listener of this.#listeners) {
      try {
        listener(payload);
      } catch (error) {
        this.#options.onSubscriberError?.(error);
      }
    }
    try {
      this.#options.emit?.(`${EVENT_NAMESPACE}:child.${payload.type}`, payload);
    } catch {
      // The shared bus is best effort.
    }
    return payload;
  }
}

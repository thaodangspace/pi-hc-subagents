/**
 * Parent notification queue for background children.
 *
 * Delivery is a custom message (`hc-subagent-result`), never a user message.
 * Notifications are deduplicated by `(childId, turn, type)` (blocked episodes
 * add their episode number), batched to at most three per delivery, and retried
 * while the parent is busy or compacting.
 */
import type { SubagentState, TurnOutcome } from "./types.ts";

export const ASYNC_MESSAGE_TYPE = "hc-subagent-result";
export const MAX_BATCH = 3;
const DEFAULT_RETRY_DELAY_MS = 2_000;
const MAX_TRACKED_KEYS = 500;
const SUMMARY_MAX_BYTES = 4 * 1024;

export type NotificationType = "result" | "blocked";

export interface NotificationItem {
  type: NotificationType;
  childId: string;
  turn: number;
  agent: string;
  state: SubagentState;
  outcome?: TurnOutcome | "blocked" | null;
  terminal: string;
  content: string;
  details: unknown;
  /** Overrides the default dedupe key (blocked episodes). */
  key?: string;
}

export interface NotificationMessage {
  customType: string;
  content: string;
  display: true;
  details?: unknown;
}

export interface NotificationSendOptions {
  triggerTurn?: boolean;
  deliverAs?: "steer" | "followUp" | "nextTurn";
}

export interface NotifierOptions {
  sendMessage: (message: NotificationMessage, options?: NotificationSendOptions) => void;
  /** True when the parent agent is idle and a new turn can be triggered. */
  isIdle: () => boolean;
  /** True while the parent is compacting; delivery is deferred. */
  isCompacting?: () => boolean;
  maxBatch?: number;
  retryDelayMs?: number;
  now?: () => number;
  maxTrackedKeys?: number;
  onError?: (error: unknown) => void;
  scheduleRetry?: (fn: () => void, delayMs: number) => void;
  cancelRetry?: () => void;
}

export function defaultNotificationKey(item: Pick<NotificationItem, "childId" | "turn" | "type">): string {
  return `${item.childId}:${item.turn}:${item.type}`;
}

function summaryContent(items: NotificationItem[], limit = SUMMARY_MAX_BYTES): string {
  const lines = [`[Subagent notifications] ${items.length} more ${items.length === 1 ? "result is" : "results are"} ready:`];
  for (const item of items) {
    const result = (item.details as { resultFile?: string | null } | undefined)?.resultFile;
    lines.push(
      `- ${item.agent} (${item.childId}, ${item.terminal}) ${item.state}${item.outcome ? ` (${item.outcome})` : ""}${
        result ? `: ${result}` : ""
      }`,
    );
  }
  lines.push("Use hc_subagent_control result <id> for the full text.");
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  return `${text.slice(0, limit)}\n[... summary truncated ...]`;
}

export class Notifier {
  readonly maxBatch: number;
  readonly retryDelayMs: number;
  readonly #sendMessage: NotifierOptions["sendMessage"];
  readonly #isIdle: NotifierOptions["isIdle"];
  readonly #isCompacting: NotifierOptions["isCompacting"];
  readonly #now: () => number;
  readonly #maxTrackedKeys: number;
  readonly #onError: NotifierOptions["onError"];
  readonly #scheduleRetry: (fn: () => void, delayMs: number) => void;
  readonly #cancelRetry: (() => void) | undefined;

  #queue: NotificationItem[] = [];
  #delivered = new Map<string, number>();
  #retryPending = false;
  #disposed = false;

  constructor(options: NotifierOptions) {
    this.#sendMessage = options.sendMessage;
    this.#isIdle = options.isIdle;
    this.#isCompacting = options.isCompacting;
    this.maxBatch = Math.max(1, options.maxBatch ?? MAX_BATCH);
    this.retryDelayMs = Math.max(1, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
    this.#now = options.now ?? (() => Date.now());
    this.#maxTrackedKeys = Math.max(1, options.maxTrackedKeys ?? MAX_TRACKED_KEYS);
    this.#onError = options.onError;
    this.#scheduleRetry =
      options.scheduleRetry ??
      ((fn, delayMs) => {
        const timer = setTimeout(fn, delayMs);
        timer.unref?.();
      });
    this.#cancelRetry = options.cancelRetry;
  }

  get pendingCount(): number {
    return this.#queue.length;
  }

  keyOf(item: NotificationItem): string {
    return item.key ?? defaultNotificationKey(item);
  }

  hasDelivered(childId: string, turn: number, type: NotificationType): boolean {
    return this.#delivered.has(`${childId}:${turn}:${type}`);
  }

  /** Mark a result delivered by another path (sync tool result / control wait). */
  markDelivered(childId: string, turn: number, type: NotificationType): void {
    this.#remember(`${childId}:${turn}:${type}`);
  }

  markKeyDelivered(key: string): void {
    this.#remember(key);
  }

  enqueue(item: NotificationItem): boolean {
    if (this.#disposed) return false;
    const key = this.keyOf(item);
    if (this.#delivered.has(key)) return false;
    if (this.#queue.some((existing) => this.keyOf(existing) === key)) return false;
    this.#queue.push(item);
    this.flush();
    return true;
  }

  /**
   * Deliver up to `maxBatch` queued notifications as custom messages.
   * Remaining items are collapsed into one bounded summary, so a notification
   * storm never floods the parent context.
   */
  flush(): void {
    if (this.#disposed || this.#queue.length === 0) return;
    if (this.#isCompacting?.()) {
      this.#scheduleRetryFlush();
      return;
    }
    const idle = this.#isIdle();
    const batch = this.#queue.splice(0, this.maxBatch);
    let failed = false;
    for (const item of batch) {
      if (this.#disposed) return;
      try {
        this.#send(item, idle);
        this.#remember(this.keyOf(item));
      } catch (error) {
        this.#queue.unshift(item);
        failed = true;
        this.#onError?.(error);
        break;
      }
    }

    if (failed) {
      this.#scheduleRetryFlush();
      return;
    }

    if (this.#queue.length > 0) {
      const overflow = this.#queue.splice(0);
      try {
        this.#sendMessage(
          {
            customType: ASYNC_MESSAGE_TYPE,
            content: summaryContent(overflow),
            display: true,
            details: { summary: true, children: overflow.map((item) => item.childId) },
          },
          idle ? { triggerTurn: true } : { deliverAs: "steer" },
        );
        for (const item of overflow) this.#remember(this.keyOf(item));
      } catch (error) {
        this.#queue.unshift(...overflow);
        this.#onError?.(error);
        this.#scheduleRetryFlush();
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#queue = [];
    this.#cancelRetry?.();
    this.#retryPending = false;
  }

  #send(item: NotificationItem, idle: boolean): void {
    this.#sendMessage(
      {
        customType: ASYNC_MESSAGE_TYPE,
        content: item.content,
        display: true,
        details: item.details,
      },
      idle ? { triggerTurn: true } : { deliverAs: "steer" },
    );
  }

  #remember(key: string): void {
    this.#delivered.set(key, this.#now());
    if (this.#delivered.size <= this.#maxTrackedKeys) return;
    const oldest = this.#delivered.keys().next();
    if (!oldest.done) this.#delivered.delete(oldest.value);
  }

  #scheduleRetryFlush(): void {
    if (this.#retryPending || this.#disposed) return;
    this.#retryPending = true;
    this.#scheduleRetry(() => {
      this.#retryPending = false;
      this.flush();
    }, this.retryDelayMs);
  }
}

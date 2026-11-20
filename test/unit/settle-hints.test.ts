import assert from "node:assert/strict";
import test from "node:test";

import { HcSubagentError } from "../../src/core/error.ts";
import {
  NOTIFICATION_VERSION,
  type PipeNotification,
} from "../../src/child/pipe-protocol.ts";
import type {
  NotificationSubscription,
  NotificationSubscriptionState,
} from "../../src/child/pipe-transport.ts";
import {
  MAX_RETAINED_SETTLE_STATS,
  MAX_SETTLE_HINT_LISTENERS,
  MAX_SETTLE_HINT_SEEN,
  SettleHintHub,
  type SettleHint,
  type SettleHintTransportInput,
} from "../../src/runtime/settle-hints.ts";

const AT_ISO = "2026-11-21T00:00:00.000Z";
const AT_MS = Date.parse(AT_ISO);

function frame(overrides: Partial<PipeNotification> = {}): PipeNotification {
  return {
    type: "settled",
    v: NOTIFICATION_VERSION,
    turn: 2,
    status: "completed",
    sessionFile: "/tmp/pi-hc-tests/session.jsonl",
    at: AT_ISO,
    ...overrides,
  };
}

/** Records what the hub asks of the transport; no sockets, no timers. */
class FakeSubscription implements NotificationSubscription {
  readonly path = "/tmp/pi-hc-tests/fake.sock";
  state: NotificationSubscriptionState = "connecting";
  reconnects = 0;
  lastError: HcSubagentError | null = null;
  closeCount = 0;
  readonly input: SettleHintTransportInput;

  constructor(input: SettleHintTransportInput) {
    this.input = input;
  }

  close(): void {
    this.closeCount += 1;
    this.state = "closed";
  }

  emit(overrides: Partial<PipeNotification> = {}): void {
    this.state = "open";
    this.input.onSettled(frame(overrides));
  }

  degrade(error = new HcSubagentError("unavailable", "reconnect budget exhausted")): void {
    this.state = "degraded";
    this.lastError = error;
    this.input.onDegraded(error);
  }

  fail(error = new HcSubagentError("protocol", "bad notification frame")): void {
    this.state = "closed";
    this.lastError = error;
    this.input.onTransportError(error);
  }

  reconnect(attempt: number, delayMs: number): void {
    this.reconnects += 1;
    this.input.onReconnect(attempt, delayMs);
  }
}

function fakeTransport(options: { factoryError?: HcSubagentError } = {}) {
  const subscriptions: FakeSubscription[] = [];
  const transport = (input: SettleHintTransportInput): NotificationSubscription => {
    if (options.factoryError) throw options.factoryError;
    const subscription = new FakeSubscription(input);
    subscriptions.push(subscription);
    return subscription;
  };
  return {
    transport,
    subscriptions,
    only(): FakeSubscription {
      assert.equal(subscriptions.length, 1);
      const subscription = subscriptions[0];
      assert.ok(subscription);
      return subscription;
    },
  };
}

function recorder(): { hints: SettleHint[]; listener: (hint: SettleHint) => void } {
  const hints: SettleHint[] = [];
  return {
    hints,
    listener: (hint) => {
      hints.push(hint);
    },
  };
}

test("start() is idempotent per child: one subscription, a counted duplicate start, listeners untouched", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  const seen = recorder();
  hub.onSettled("child-1", seen.listener);

  assert.equal(hub.start("child-1", "pi-hc-0123456789abcdef-child-1"), true);
  assert.equal(hub.start("child-1", "pi-hc-0123456789abcdef-child-1"), false);

  assert.equal(fake.subscriptions.length, 1);
  const stats = hub.stats("child-1");
  assert.equal(stats?.duplicateStarts, 1);
  assert.equal(stats?.wakes, 0);

  fake.only().emit();
  assert.equal(seen.hints.length, 1);
  assert.equal(hub.stats("child-1")?.wakes, 1);
  assert.equal(hub.stats("child-1")?.duplicateStarts, 1);
});

test("start() without a pipe name fails closed and never creates a transport", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });

  assert.equal(hub.start("child-1", ""), false);
  assert.equal(hub.start("child-1", "   "), false);
  assert.equal(fake.subscriptions.length, 0);
  assert.equal(hub.has("child-1"), false);
  assert.equal(hub.size, 0);
  assert.equal(hub.stats("child-1"), undefined);
  assert.doesNotThrow(() => hub.close("child-1"));
});

test("one frame fans out to every listener once, in registration order", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");

  const order: string[] = [];
  hub.onSettled("child-1", () => order.push("first"));
  hub.onSettled("child-1", () => order.push("second"));
  hub.onSettled("child-1", () => order.push("third"));

  fake.only().emit({ turn: 4 });

  assert.deepEqual(order, ["first", "second", "third"]);
  const stats = hub.stats("child-1");
  assert.equal(stats?.hints, 1);
  assert.equal(stats?.wakes, 3);
});

test("a repeated (turn,status) frame is a counted duplicate and is not delivered twice", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  const seen = recorder();
  hub.onSettled("child-1", seen.listener);

  fake.only().emit({ turn: 3, status: "completed" });
  fake.only().emit({ turn: 3, status: "completed" });
  fake.only().emit({ turn: 3, status: "failed" });

  assert.equal(seen.hints.length, 2);
  const stats = hub.stats("child-1");
  assert.equal(stats?.duplicateDrops, 1);
  assert.equal(stats?.hints, 2);
  assert.equal(stats?.wakes, 2);
});

test("the seen map is bounded: the oldest (turn,status) key is forgotten first", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  const seen = recorder();
  hub.onSettled("child-1", seen.listener);

  for (let turn = 1; turn <= MAX_SETTLE_HINT_SEEN + 1; turn += 1) {
    fake.only().emit({ turn });
  }
  assert.equal(seen.hints.length, MAX_SETTLE_HINT_SEEN + 1);
  // Turn 1 was evicted, so it is no longer recognised as a duplicate.
  fake.only().emit({ turn: 1 });
  assert.equal(seen.hints.length, MAX_SETTLE_HINT_SEEN + 2);
  assert.equal(hub.stats("child-1")?.duplicateDrops, 0);
});

test("a listener registered with since skips an older hint and is counted, others still run", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");

  const fresh = recorder();
  const staleIso = recorder();
  const staleNumber = recorder();
  const boundary = recorder();
  hub.onSettled("child-1", fresh.listener, { since: new Date(AT_MS - 1000).toISOString() });
  hub.onSettled("child-1", staleIso.listener, { since: "2026-11-21T00:10:00.000Z" });
  hub.onSettled("child-1", staleNumber.listener, { since: AT_MS + 1000 });
  hub.onSettled("child-1", boundary.listener, { since: AT_MS });

  fake.only().emit();

  assert.equal(fresh.hints.length, 1);
  assert.equal(boundary.hints.length, 1);
  assert.equal(staleIso.hints.length, 0);
  assert.equal(staleNumber.hints.length, 0);
  const stats = hub.stats("child-1");
  assert.equal(stats?.staleDrops, 2);
  assert.equal(stats?.wakes, 2);
});

test("a throwing listener is contained and counted, and the next listener still runs", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");

  const calls: string[] = [];
  hub.onSettled("child-1", () => {
    calls.push("thrower");
    throw new Error("listener boom");
  });
  hub.onSettled("child-1", () => calls.push("survivor"));

  assert.doesNotThrow(() => fake.only().emit());

  assert.deepEqual(calls, ["thrower", "survivor"]);
  const stats = hub.stats("child-1");
  assert.equal(stats?.listenerErrors, 1);
  assert.equal(stats?.wakes, 2);
  assert.equal(stats?.listenerDrops, 0);
});

test("the 9th listener is refused with a no-op unsubscribe while the first 8 keep working", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");

  const delivered: string[] = [];
  for (let index = 0; index < MAX_SETTLE_HINT_LISTENERS; index += 1) {
    hub.onSettled("child-1", () => delivered.push(`listener-${index}`));
  }
  const refused = recorder();
  const unsubscribe = hub.onSettled("child-1", refused.listener);

  const stats = hub.stats("child-1");
  assert.equal(stats?.listenerDrops, 1);
  assert.equal(stats?.listeners, MAX_SETTLE_HINT_LISTENERS);
  assert.doesNotThrow(() => unsubscribe());
  assert.equal(hub.stats("child-1")?.listeners, MAX_SETTLE_HINT_LISTENERS);

  fake.only().emit();
  assert.equal(refused.hints.length, 0);
  assert.equal(delivered.length, MAX_SETTLE_HINT_LISTENERS);
  assert.equal(hub.stats("child-1")?.wakes, MAX_SETTLE_HINT_LISTENERS);
});

test("unsubscribe is idempotent, decrements listeners once, and works before start()", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });

  const early = recorder();
  const unsubscribe = hub.onSettled("child-1", early.listener);
  assert.equal(hub.stats("child-1")?.listeners, 1);
  assert.equal(hub.stats("child-1")?.state, "idle");

  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  fake.only().emit();
  assert.equal(early.hints.length, 1);

  unsubscribe();
  unsubscribe();
  assert.equal(hub.stats("child-1")?.listeners, 0);

  fake.only().emit({ turn: 5 });
  assert.equal(early.hints.length, 1);
});

test("close() is idempotent, closes the subscription once, and retains the final snapshot", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  hub.onSettled("child-1", () => {});
  const subscription = fake.only();
  subscription.emit();

  hub.close("child-1");
  hub.close("child-1");

  assert.equal(subscription.closeCount, 1);
  assert.equal(subscription.state, "closed");
  assert.equal(hub.size, 0);
  assert.equal(hub.has("child-1"), false);
  const stats = hub.stats("child-1");
  assert.equal(stats?.state, "closed");
  assert.equal(stats?.hints, 1);
  assert.equal(stats?.wakes, 1);
  assert.equal(stats?.listeners, 0);
});

test("retained closed snapshots are bounded to MAX_RETAINED_SETTLE_STATS in FIFO order", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });

  for (let index = 0; index < MAX_RETAINED_SETTLE_STATS + 2; index += 1) {
    const childId = `child-${index}`;
    hub.start(childId, `pi-hc-0123456789abcdef-${childId}`);
    hub.close(childId);
  }

  assert.equal(hub.stats("child-0"), undefined);
  assert.equal(hub.stats("child-1"), undefined);
  assert.equal(hub.stats("child-2")?.state, "closed");
  assert.equal(hub.stats(`child-${MAX_RETAINED_SETTLE_STATS + 1}`)?.state, "closed");
});

test("closeAll() empties subscriptions, listeners, seen maps, and retained snapshots", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  hub.start("child-2", "pi-hc-0123456789abcdef-child-2");
  hub.onSettled("child-1", () => {});
  const first = fake.subscriptions[0];
  assert.ok(first);
  first.emit();
  hub.close("child-2");

  hub.closeAll();

  assert.equal(hub.size, 0);
  assert.equal(hub.has("child-1"), false);
  assert.equal(hub.stats("child-1"), undefined);
  assert.equal(hub.stats("child-2"), undefined);
  assert.equal(first.closeCount, 1);
});

test("onDegraded marks the child degraded, mirrors reconnects, and keeps listeners", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  hub.onSettled("child-1", () => {});
  const subscription = fake.only();
  subscription.reconnect(1, 500);
  subscription.reconnect(2, 1000);
  subscription.degrade();

  const stats = hub.stats("child-1");
  assert.equal(stats?.state, "degraded");
  assert.equal(stats?.degraded, true);
  assert.equal(stats?.listeners, 1);
  assert.equal(stats?.reconnects, 2);
});

test("onTransportError closes the child without marking it degraded", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  const subscription = fake.only();
  subscription.reconnect(1, 500);
  subscription.fail();

  const stats = hub.stats("child-1");
  assert.equal(stats?.state, "closed");
  assert.equal(stats?.degraded, false);
  assert.equal(stats?.reconnects, 1);
  assert.equal(subscription.closeCount, 0);
});

test("a hint carries the child id, turn, status, timestamp, and session file only", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  const seen = recorder();
  hub.onSettled("child-1", seen.listener);

  fake.only().emit({ turn: 7, status: "failed", sessionFile: "/tmp/pi-hc-tests/other.jsonl" });
  fake.only().emit({ turn: 8, status: "aborted", sessionFile: undefined });

  assert.deepEqual(seen.hints[0], {
    childId: "child-1",
    turn: 7,
    status: "failed",
    at: AT_MS,
    sessionFile: "/tmp/pi-hc-tests/other.jsonl",
  });
  const withoutFile = seen.hints[1];
  assert.ok(withoutFile);
  assert.equal(Object.hasOwn(withoutFile, "sessionFile"), false);
});

test("a non-ISO at is coerced to 0 instead of poisoning staleness comparisons", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  const unfiltered = recorder();
  const filtered = recorder();
  hub.onSettled("child-1", unfiltered.listener);
  hub.onSettled("child-1", filtered.listener, { since: AT_MS });

  fake.only().emit({ at: "not-a-timestamp" });

  assert.equal(unfiltered.hints[0]?.at, 0);
  assert.equal(filtered.hints.length, 0);
  assert.equal(hub.stats("child-1")?.staleDrops, 1);
});

test("a throwing transport is contained: stats survive as closed and no caller error escapes", () => {
  const fake = fakeTransport({ factoryError: new HcSubagentError("validation", "pipe name is invalid") });
  const hub = new SettleHintHub({ transport: fake.transport });

  assert.doesNotThrow(() => hub.start("child-1", "pi-hc-0123456789abcdef-child-1"));
  assert.equal(hub.start("child-1", "pi-hc-0123456789abcdef-child-1"), false);
  assert.equal(hub.size, 0);
  const stats = hub.stats("child-1");
  assert.equal(stats?.state, "closed");
  assert.equal(stats?.hints, 0);
  assert.equal(stats?.listenerDrops, 0);
});

test("a throwing subscription.close() is contained and the child is still counted closed", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({
    transport: (input) => {
      const subscription = new FakeSubscription(input);
      subscription.close = () => {
        subscription.closeCount += 1;
        throw new HcSubagentError("unavailable", "socket already gone");
      };
      return subscription;
    },
  });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");

  assert.doesNotThrow(() => hub.close("child-1"));
  assert.equal(hub.stats("child-1")?.state, "closed");
  assert.doesNotThrow(() => hub.closeAll());
  assert.equal(hub.size, 0);
});

test("stats snapshots contain no text, task, or prompt keys", () => {
  const fake = fakeTransport();
  const hub = new SettleHintHub({ transport: fake.transport });
  hub.start("child-1", "pi-hc-0123456789abcdef-child-1");
  hub.onSettled("child-1", () => {});
  fake.only().emit({ status: "completed" });
  fake.only().degrade();

  const json = JSON.stringify(hub.stats("child-1"));
  for (const key of ["text", "task", "prompt"]) {
    assert.equal(json.includes(`"${key}"`), false, `stats must not carry a ${key} field`);
  }
});

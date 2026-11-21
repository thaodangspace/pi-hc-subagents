import assert from "node:assert/strict";
import test from "node:test";

import type { FinalizeResult } from "../../src/runtime/finalize.ts";
import { recordDetails } from "../../src/runtime/finalize.ts";
import { blockedNotification, resultNotification } from "../../src/runtime/notification.ts";
import {
  Notifier,
  resultDeliveryKey,
  type NotificationItem,
  type NotificationMessage,
} from "../../src/runtime/notifier.ts";
import type { SubagentRecord, TurnRecord } from "../../src/runtime/types.ts";

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
  return {
    type: "result",
    childId: "child-1",
    turn: 1,
    agent: "reviewer",
    state: "completed",
    outcome: "stop",
    terminal: "t12",
    content: "result body",
    details: { resultFile: "/runs/r1/result.json" },
    ...overrides,
  };
}

function turnRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index: 1,
    task: "task",
    startedAt: "2026-11-21T03:59:00.000Z",
    startedAtMs: Date.parse("2026-11-21T03:59:00.000Z"),
    baselineTurn: 0,
    state: "completed",
    outcome: "stop",
    text: "result body",
    terminal: "t12",
    ...overrides,
  };
}

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    version: 1,
    runId: "run-1",
    childId: "child-1",
    parentSessionId: "parent-1",
    agent: "reviewer",
    agentSource: "user",
    agentAccess: "read-only",
    cwd: "/repo",
    terminal: "t12",
    terminalName: "rev-1",
    sessionId: "child-1",
    sessionFile: "/runs/r1/sessions/child-1.jsonl",
    state: "completed",
    terminalState: "live",
    coreStatus: "done",
    slug: "reviewer-a1b2",
    turn: 1,
    turns: [turnRecord()],
    createdAt: "2026-11-21T03:59:00.000Z",
    updatedAt: "2026-11-21T04:00:00.000Z",
    labels: {},
    background: true,
    origin: "tool",
    ...overrides,
  };
}

function settledRecord(value: string, overrides: Partial<TurnRecord> = {}): SubagentRecord {
  return record({ turns: [turnRecord({ settledAt: value, ...overrides })] });
}

function finalizedFor(record: SubagentRecord): FinalizeResult {
  return {
    record,
    outcome: "stop",
    state: "completed",
    result: { content: [], details: recordDetails(record, { state: "completed", outcome: "stop" }) },
  };
}

function recorder(overrides: { idle?: boolean; compacting?: boolean } = {}) {
  const messages: Array<{ message: NotificationMessage; options: unknown }> = [];
  const errors: unknown[] = [];
  const notifier = new Notifier({
    sendMessage(message, options) {
      messages.push({ message, options });
    },
    isIdle: () => overrides.idle ?? true,
    isCompacting: () => overrides.compacting ?? false,
    retryDelayMs: 10,
    onError: (error) => errors.push(error),
  });
  return { notifier, messages, errors };
}

test("an idle parent receives a custom message with triggerTurn", () => {
  const { notifier, messages } = recorder();
  assert.equal(notifier.enqueue(item()), true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.message.customType, "hc-subagent-result");
  assert.deepEqual(messages[0]?.options, { triggerTurn: true });
  assert.match(messages[0]?.message.content ?? "", /result body/);
});

test("a streaming parent receives deliverAs steer instead of a user message", () => {
  const { notifier, messages } = recorder({ idle: false });
  notifier.enqueue(item());
  assert.deepEqual(messages[0]?.options, { deliverAs: "steer" });
});

test("items without a deliveryKey fall back to the (childId, turn, type) key", () => {
  const { notifier, messages } = recorder();
  assert.equal(notifier.enqueue(item()), true);
  assert.equal(notifier.enqueue(item({ content: "different body" })), false);
  assert.equal(messages.length, 1);
});

test("two settles that share an hc turn are both delivered", () => {
  const { notifier, messages } = recorder();
  // Same childId and turn: only the settle time tells the publishes apart.
  const first = settledRecord("2026-11-21T04:00:00.000Z", { text: "first answer" });
  const second = settledRecord("2026-11-21T04:00:01.000Z", { text: "second answer" });
  assert.equal(first.turn, second.turn);
  assert.equal(resultDeliveryKey(first), "child-1:1:result:2026-11-21T04:00:00.000Z");
  assert.notEqual(resultDeliveryKey(first), resultDeliveryKey(second));

  assert.equal(notifier.enqueue(resultNotification(first, finalizedFor(first))), true);
  assert.equal(notifier.enqueue(resultNotification(second, finalizedFor(second))), true);
  assert.equal(messages.length, 2, "both settles reach the parent");
  assert.match(messages[0]?.message.content ?? "", /first answer/);
  assert.match(messages[1]?.message.content ?? "", /second answer/);
});

test("a replay of one settle is delivered once", () => {
  const { notifier, messages } = recorder();
  const settled = settledRecord("2026-11-21T04:00:00.000Z");
  assert.equal(notifier.enqueue(resultNotification(settled, finalizedFor(settled))), true);
  assert.equal(notifier.enqueue(resultNotification(settled, finalizedFor(settled))), false);
  assert.equal(messages.length, 1, "the same settle is not announced twice");
});

test("markResultDelivered suppresses that settle only", () => {
  const { notifier, messages } = recorder();
  const delivered = settledRecord("2026-11-21T04:00:00.000Z");
  const later = settledRecord("2026-11-21T04:00:05.000Z");
  notifier.markResultDelivered(delivered);

  assert.equal(notifier.enqueue(resultNotification(delivered, finalizedFor(delivered))), false);
  assert.equal(notifier.enqueue(resultNotification(later, finalizedFor(later))), true);
  assert.equal(messages.length, 1, "a later settle still notifies");
});

test("legacy records without a settle time keep the turn-only key", () => {
  const { notifier, messages } = recorder();
  const legacy = record({ turns: [turnRecord()] });
  assert.equal(resultDeliveryKey(legacy), "child-1:1:result");
  notifier.markResultDelivered(legacy);
  assert.equal(notifier.enqueue(resultNotification(legacy, finalizedFor(legacy))), false);
  assert.equal(messages.length, 0);
});

test("blocked episodes use episode-scoped keys on one turn", () => {
  const { notifier, messages } = recorder();
  const blocked = record({ state: "blocked", coreStatus: "blocked" });
  const first = blockedNotification(blocked, 1, "permission", "Allow the fake tool?", "tail");
  const second = blockedNotification(blocked, 2, "permission", "Allow the fake tool?", "tail");
  assert.equal(first.deliveryKey, "child-1:1:blocked:1");
  assert.equal(second.deliveryKey, "child-1:1:blocked:2");

  assert.equal(notifier.enqueue(first), true);
  assert.equal(notifier.enqueue(second), true);
  assert.equal(notifier.enqueue(blockedNotification(blocked, 1, "permission", "Allow the fake tool?", "tail")), false);
  assert.equal(messages.length, 2, "two episodes deliver, a replay of one does not");
});

test("the delivered map still evicts oldest-first at the cap", () => {
  const messages: NotificationMessage[] = [];
  const notifier = new Notifier({ sendMessage: (message) => messages.push(message), isIdle: () => true, maxTrackedKeys: 2 });
  const settle = (at: string): NotificationItem => {
    const current = settledRecord(at);
    return resultNotification(current, finalizedFor(current));
  };
  const oldest = settle("2026-11-21T04:00:00.000Z");
  const middle = settle("2026-11-21T04:00:01.000Z");
  const newest = settle("2026-11-21T04:00:02.000Z");

  for (const entry of [oldest, middle, newest]) assert.equal(notifier.enqueue(entry), true);
  assert.equal(notifier.enqueue(newest), false, "the newest key is still tracked");
  assert.equal(notifier.enqueue(oldest), true, "the oldest key was evicted");
  assert.equal(messages.length, 4);
});

test("compaction defers delivery and a later flush retries", () => {
  const messages: NotificationMessage[] = [];
  let compacting = true;
  const notifier = new Notifier({
    sendMessage: (message) => messages.push(message),
    isIdle: () => true,
    isCompacting: () => compacting,
    retryDelayMs: 5,
    scheduleRetry: (fn, delay) => {
      setTimeout(fn, delay).unref?.();
    },
  });
  notifier.enqueue(item());
  assert.equal(notifier.pendingCount, 1);
  assert.equal(messages.length, 0);
  compacting = false;
  notifier.flush();
  assert.equal(notifier.pendingCount, 0);
  assert.equal(messages.length, 1);
});

test("send failures keep the notification queued for retry", async () => {
  let fail = true;
  const messages: NotificationMessage[] = [];
  const notifier = new Notifier({
    sendMessage(message) {
      if (fail) throw new Error("busy");
      messages.push(message);
    },
    isIdle: () => true,
    retryDelayMs: 5,
    scheduleRetry: (fn, delay) => {
      setTimeout(fn, delay).unref?.();
    },
  });
  notifier.enqueue(item());
  assert.equal(notifier.pendingCount, 1);
  fail = false;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(notifier.pendingCount, 0);
  assert.equal(messages.length, 1);
});

test("immediate flushes deliver each notification once", () => {
  const { notifier, messages } = recorder();
  for (let index = 1; index <= 6; index++) {
    notifier.enqueue(
      item({ childId: `child-${index}`, turn: 1, content: `result ${index}`, details: { resultFile: `/runs/r${index}/result.json` } }),
    );
  }
  assert.equal(messages.length, 6);
  assert.equal(new Set(messages.map((entry) => entry.message.content)).size, 6);
});

test("batching collapses overflow into one summary when several complete together", () => {
  const messages: NotificationMessage[] = [];
  let compacting = true;
  const notifier = new Notifier({
    sendMessage: (message) => messages.push(message),
    isIdle: () => true,
    isCompacting: () => compacting,
    retryDelayMs: 1000,
    scheduleRetry: () => {},
  });
  for (let index = 1; index <= 7; index++) {
    notifier.enqueue(
      item({
        childId: `child-${index}`,
        agent: `agent-${index}`,
        turn: 1,
        content: `content ${index}`,
        details: { resultFile: `/runs/${index}/result.json` },
      }),
    );
  }
  compacting = false;
  notifier.flush();
  assert.equal(messages.length, 4, "three individual notifications plus one summary");
  assert.match(messages[3]?.content ?? "", /4 more results are ready/);
  assert.match(messages[3]?.content ?? "", /child-7/);
  assert.match(messages[3]?.content ?? "", /\/runs\/7\/result\.json/);
});

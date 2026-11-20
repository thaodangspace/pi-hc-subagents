import assert from "node:assert/strict";
import test from "node:test";

import { Notifier, type NotificationItem, type NotificationMessage } from "../../src/runtime/notifier.ts";

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

test("duplicate (childId, turn, type) notifications are suppressed", () => {
  const { notifier, messages } = recorder();
  assert.equal(notifier.enqueue(item()), true);
  assert.equal(notifier.enqueue(item({ content: "different body" })), false);
  assert.equal(messages.length, 1);
});

test("markDelivered prevents a synchronous result from being sent again", () => {
  const { notifier, messages } = recorder();
  notifier.markDelivered("child-1", 1, "result");
  assert.equal(notifier.enqueue(item()), false);
  assert.equal(messages.length, 0);
});

test("blocked episodes use distinct keys but the same turn", () => {
  const { notifier, messages } = recorder();
  notifier.enqueue(item({ type: "blocked", key: "child-1:1:blocked:1", content: "first" }));
  notifier.enqueue(item({ type: "blocked", key: "child-1:1:blocked:2", content: "second" }));
  assert.equal(messages.length, 2);
  assert.match(messages[0]?.message.content ?? "", /first/);
  assert.match(messages[1]?.message.content ?? "", /second/);
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

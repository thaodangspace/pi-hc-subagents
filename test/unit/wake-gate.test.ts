import assert from "node:assert/strict";
import test from "node:test";

import { MIN_WAKE_GAP_MS, WakeGate } from "../../src/runtime/wake-gate.ts";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Deterministic coalescing clock; timers stay real so the suite stays fast. */
function clock(start = 0): { now: () => number; set: (value: number) => void; advance: (ms: number) => void } {
  let value = start;
  return {
    now: () => value,
    set: (next) => {
      value = next;
    },
    advance: (ms) => {
      value += ms;
    },
  };
}

test("wait() resolves \"timer\" when nothing wakes it and disarms", async () => {
  const gate = new WakeGate();
  const started = Date.now();
  const result = await gate.wait(20);
  const elapsed = Date.now() - started;

  assert.equal(result, "timer");
  assert.equal(gate.waiting, false);
  assert.equal(gate.armed, false);
  assert.ok(elapsed >= 15, `waited ${elapsed}ms`);
});

test("wake() resolves a pending wait as \"wake\" and clears the timer", async () => {
  const gate = new WakeGate();
  const pending = gate.wait(10_000, undefined);
  assert.equal(gate.waiting, true);
  assert.equal(gate.armed, true);

  gate.wake();

  assert.equal(await pending, "wake");
  assert.equal(gate.waiting, false);
  assert.equal(gate.armed, false);
});

test("a wait resolves once; a second wake is harmless", async () => {
  const gate = new WakeGate();
  const pending = gate.wait(10_000);
  gate.wake();
  gate.wake();
  gate.abort();

  assert.equal(await pending, "wake");
  assert.equal(gate.waiting, false);
  assert.equal(gate.armed, false);
  // Idle calls are no-ops, never throws.
  assert.doesNotThrow(() => {
    gate.wake();
    gate.abort();
  });
});

test("coalescing drops wakes inside MIN_WAKE_GAP_MS and emits after it", async () => {
  const time = clock();
  const gate = new WakeGate({ now: time.now });

  const first = gate.wait(10_000);
  time.set(0);
  gate.wake();
  assert.equal(await first, "wake");

  const second = gate.wait(10_000);
  time.advance(5);
  gate.wake();
  assert.equal(gate.waiting, true, "a 5 ms wake is dropped, the wait is still armed");
  gate.abort();
  assert.equal(await second, "abort");

  const third = gate.wait(10_000);
  time.advance(MIN_WAKE_GAP_MS - 5);
  gate.wake();
  assert.equal(await third, "wake", "a wake at exactly MIN_WAKE_GAP_MS is emitted");
});

test("a dropped wake leaves the gate armed and a later wake still resolves it", async () => {
  const time = clock();
  const gate = new WakeGate({ now: time.now });

  const first = gate.wait(10_000);
  time.set(0);
  gate.wake();
  assert.equal(await first, "wake");

  const second = gate.wait(10_000);
  time.advance(5);
  gate.wake();
  assert.equal(gate.waiting, true);
  time.advance(MIN_WAKE_GAP_MS);
  gate.wake();
  assert.equal(await second, "wake");
  assert.equal(gate.armed, false);
});

test("wake() while idle neither arms the gate nor starts the coalescing window", async () => {
  const time = clock();
  const gate = new WakeGate({ now: time.now });

  gate.wake();
  gate.wake();
  assert.equal(gate.waiting, false);
  assert.equal(gate.armed, false);

  const pending = gate.wait(10_000);
  time.set(0);
  gate.wake();
  assert.equal(await pending, "wake", "the first real wake is not poisoned by an idle wake");
});

test("abort() resolves \"abort\", clears the timer, and is safe when idle", async () => {
  const gate = new WakeGate();
  const pending = gate.wait(10_000);
  assert.equal(gate.armed, true);
  gate.abort();

  assert.equal(await pending, "abort");
  assert.equal(gate.armed, false);
  assert.equal(gate.waiting, false);
  assert.doesNotThrow(() => gate.abort());
});

test("a pre-aborted signal resolves immediately without arming a timer", async () => {
  const gate = new WakeGate();
  const controller = new AbortController();
  controller.abort();

  assert.equal(await gate.wait(10_000, controller.signal), "abort");
  assert.equal(gate.armed, false);
  assert.equal(gate.waiting, false);
});

test("an abort event during a wait resolves \"abort\" and removes its listener", async () => {
  const gate = new WakeGate();
  const controller = new AbortController();
  const pending = gate.wait(10_000, controller.signal);
  controller.abort();

  assert.equal(await pending, "abort");
  assert.equal(gate.waiting, false);
  assert.equal(gate.armed, false);
  // A later hint must not touch a finished wait.
  assert.doesNotThrow(() => gate.wake());
});

test("waiting and armed reflect the live state across waits", async () => {
  const gate = new WakeGate();
  assert.equal(gate.waiting, false);
  assert.equal(gate.armed, false);

  const first = gate.wait(10_000);
  assert.equal(gate.waiting, true);
  assert.equal(gate.armed, true);
  await assert.rejects(async () => gate.wait(10), /already pending/);

  gate.wake();
  await first;
  assert.equal(gate.waiting, false);
  assert.equal(gate.armed, false);

  const second = gate.wait(10_000);
  assert.equal(gate.armed, true);
  gate.abort();
  assert.equal(await second, "abort");
});

test("unref'd and ref'd timers both disarm on every exit path", async () => {
  for (const unref of [true, false]) {
    const gate = new WakeGate({ unref });

    const timed = gate.wait(10);
    assert.equal(await timed, "timer");
    assert.equal(gate.armed, false);

    const woken = gate.wait(10_000);
    gate.wake();
    assert.equal(await woken, "wake");
    assert.equal(gate.armed, false);

    const aborted = gate.wait(10_000);
    gate.abort();
    assert.equal(await aborted, "abort");
    assert.equal(gate.armed, false);
  }
  await tick(1);
});

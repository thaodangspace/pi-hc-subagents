import assert from "node:assert/strict";
import test from "node:test";

import type { CoreClient } from "../../src/core/core-client.ts";
import type { TerminalRecord } from "../../src/core/hc-types.ts";
import { waitForChild } from "../../src/child/wait-child.ts";
import type { SettleHint } from "../../src/runtime/settle-hints.ts";
import { ChildStateMachine } from "../../src/runtime/state-machine.ts";
import type { WakeSource } from "../../src/runtime/wake-gate.ts";

const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    address: "t-1",
    name: null,
    cwd: "/tmp/pi-hc-tests",
    argv: [],
    state: "live",
    status: { state: "working", kind: null, message: "", title: "", app: "", progress: null },
    turn: 1,
    exitCode: null,
    signal: null,
    parent: null,
    labels: {},
    createdMs: 0,
    finishedMs: null,
    statusMs: null,
    reported: false,
    reason: null,
    keep: false,
    rm: false,
    foreground: null,
    pid: null,
    notify: false,
    identity: "t-1",
    screen: "",
    ...overrides,
  };
}

function doneTerminal(turn = 2): TerminalRecord {
  return terminal({
    turn,
    status: { state: "done", kind: null, message: "", title: "", app: "", progress: null },
  });
}

/** Counts `terminal.get` calls; the next snapshot comes from `next()`. */
class FakeCore {
  gets = 0;
  readonly #next: () => TerminalRecord;

  constructor(next: () => TerminalRecord) {
    this.#next = next;
  }

  async get(): Promise<TerminalRecord> {
    this.gets += 1;
    return this.#next();
  }
}

function core(next: () => TerminalRecord): { fake: FakeCore; client: CoreClient } {
  const fake = new FakeCore(next);
  return { fake, client: fake as unknown as CoreClient };
}

/** Stand-in for `wakeSourceFor(hub, childId)`; no hub, no sockets. */
class FakeWake implements WakeSource {
  falseWakes = 0;
  staleDrops = 0;
  subscribes = 0;
  unsubscribes = 0;
  since: number | undefined;
  readonly listeners = new Set<(hint: SettleHint) => void>();

  subscribe(listener: (hint: SettleHint) => void, options?: { since?: number }): () => void {
    this.subscribes += 1;
    this.since = options?.since;
    this.listeners.add(listener);
    return () => {
      this.unsubscribes += 1;
      this.listeners.delete(listener);
    };
  }

  stats(): undefined {
    return undefined;
  }

  noteFalseWake(): void {
    this.falseWakes += 1;
  }

  noteStaleWake(): void {
    this.staleDrops += 1;
  }

  emit(overrides: Partial<SettleHint> = {}): void {
    const hint: SettleHint = {
      childId: "child-1",
      turn: 2,
      status: "completed",
      at: Date.now(),
      ...overrides,
    };
    for (const listener of [...this.listeners]) listener(hint);
  }
}

function machine(baselineTurn = 0): ChildStateMachine {
  return new ChildStateMachine({
    baselineTurn,
    startupTimeoutMs: 60_000,
    waitTimeoutMs: 60_000,
    startedAtMs: Date.now(),
  });
}

test("a hint settles a 5 s poll loop in well under the poll interval", async () => {
  let done = false;
  const { fake, client } = core(() => (done ? doneTerminal(2) : terminal()));
  const wake = new FakeWake();
  const stateMachine = machine();
  const started = Date.now();

  setTimeout(() => {
    done = true;
    wake.emit({ turn: 2 });
  }, 20);

  const outcome = await waitForChild({
    core: client,
    terminal: "t-1",
    machine: stateMachine,
    pollIntervalMs: 5000,
    wake,
  });
  const elapsed = Date.now() - started;

  assert.equal(outcome.kind, "settled");
  assert.equal(outcome.kind === "settled" ? outcome.observedBy : null, "push");
  assert.ok(elapsed < 500, `settled in ${elapsed}ms`);
  assert.equal(fake.gets, 2, "one initial poll plus one wake-triggered poll");
  assert.equal(wake.subscribes, 1);
  assert.equal(wake.unsubscribes, 1);
  assert.equal(wake.since, stateMachine.startedAtMs);
});

test("without a hint the poll cadence is unchanged: one get in 300 ms of a 5 s interval", async () => {
  const { fake, client } = core(() => terminal());
  const wake = new FakeWake();
  const controller = new AbortController();

  setTimeout(() => assert.equal(fake.gets, 1), 300);
  const pending = waitForChild({
    core: client,
    terminal: "t-1",
    machine: machine(),
    pollIntervalMs: 5000,
    signal: controller.signal,
    wake,
  });

  await tick(320);
  const abortedAt = Date.now();
  controller.abort();
  const outcome = await pending;

  assert.equal(fake.gets, 1);
  assert.equal(outcome.kind, "cancelled");
  assert.ok(Date.now() - abortedAt < 150, "abort does not wait out the interval");
  assert.equal(wake.falseWakes, 0);
  assert.equal(wake.unsubscribes, 1);
});

test("a hint while the child still works is a counted false wake and the poll settles it", async () => {
  let done = false;
  const { fake, client } = core(() => (done ? doneTerminal(2) : terminal()));
  const wake = new FakeWake();

  setTimeout(() => wake.emit({ turn: 2 }), 20);
  setTimeout(() => {
    done = true;
  }, 80);

  const outcome = await waitForChild({
    core: client,
    terminal: "t-1",
    machine: machine(),
    pollIntervalMs: 250,
    wake,
  });

  assert.equal(outcome.kind, "settled");
  assert.equal(outcome.kind === "settled" ? outcome.observedBy : null, "poll");
  assert.equal(wake.falseWakes, 1);
  assert.equal(fake.gets, 3, "initial poll, wake poll, timer poll");
});

test("a stale-turn hint (turn <= baselineTurn) issues no extra get", async () => {
  const { fake, client } = core(() => terminal({ turn: 2 }));
  const wake = new FakeWake();
  const controller = new AbortController();
  const stateMachine = machine(2);

  setTimeout(() => wake.emit({ turn: 2 }), 20);
  const pending = waitForChild({
    core: client,
    terminal: "t-1",
    machine: stateMachine,
    pollIntervalMs: 5000,
    signal: controller.signal,
    wake,
  });

  await tick(120);
  assert.equal(fake.gets, 1);
  assert.equal(wake.staleDrops, 1);
  assert.equal(wake.falseWakes, 0);

  controller.abort();
  assert.equal((await pending).kind, "cancelled");
});

test("a turn-0 hint is treated as unknown and still wakes the loop", async () => {
  let done = false;
  const { fake, client } = core(() => (done ? doneTerminal(2) : terminal()));
  const wake = new FakeWake();

  setTimeout(() => {
    done = true;
    wake.emit({ turn: 0 });
  }, 20);

  const outcome = await waitForChild({
    core: client,
    terminal: "t-1",
    machine: machine(1),
    pollIntervalMs: 5000,
    wake,
  });

  assert.equal(outcome.kind, "settled");
  assert.equal(wake.staleDrops, 0);
  assert.equal(fake.gets, 2);
});

test("two hints 5 ms apart produce exactly one extra get", async () => {
  const { fake, client } = core(() => terminal());
  const wake = new FakeWake();
  const controller = new AbortController();

  const pending = waitForChild({
    core: client,
    terminal: "t-1",
    machine: machine(),
    pollIntervalMs: 5000,
    signal: controller.signal,
    wake,
  });

  await tick(20);
  wake.emit({ turn: 2 });
  await tick(5);
  wake.emit({ turn: 3 });

  await tick(150);
  assert.equal(fake.gets, 2, "the coalesced second hint issued no get");

  wake.emit({ turn: 4 });
  await tick(50);
  assert.equal(fake.gets, 3, "a hint outside the coalescing gap wakes again");

  controller.abort();
  assert.equal((await pending).kind, "cancelled");
});

test("an AbortSignal during a wake wait returns cancelled immediately", async () => {
  const { fake, client } = core(() => terminal());
  const wake = new FakeWake();
  const controller = new AbortController();

  const pending = waitForChild({
    core: client,
    terminal: "t-1",
    machine: machine(),
    pollIntervalMs: 5000,
    signal: controller.signal,
    wake,
  });

  await tick(30);
  const abortedAt = Date.now();
  controller.abort();
  const outcome = await pending;

  assert.equal(outcome.kind, "cancelled");
  assert.ok(Date.now() - abortedAt < 150, `cancelled in ${Date.now() - abortedAt}ms`);
  assert.equal(fake.gets, 1);
  assert.equal(wake.unsubscribes, 1);
});

test("no wake source: the loop is the unchanged poll loop with observedBy poll", async () => {
  let done = false;
  const { fake, client } = core(() => (done ? doneTerminal(2) : terminal()));
  setTimeout(() => {
    done = true;
  }, 80);

  const outcome = await waitForChild({
    core: client,
    terminal: "t-1",
    machine: machine(),
    pollIntervalMs: 250,
  });

  assert.equal(outcome.kind, "settled");
  assert.equal(outcome.kind === "settled" ? outcome.observedBy : null, "poll");
  assert.equal(fake.gets, 2);
});

test("the wake subscription is released even when the wait throws", async () => {
  const wake = new FakeWake();
  const client = {
    async get(): Promise<TerminalRecord> {
      throw new Error("boom");
    },
  } as unknown as CoreClient;

  await assert.rejects(async () =>
    waitForChild({
      core: client,
      terminal: "t-1",
      machine: machine(),
      pollIntervalMs: 5000,
      wake,
    }),
  );
  assert.equal(wake.subscribes, 1);
  assert.equal(wake.unsubscribes, 1);
  assert.equal(wake.listeners.size, 0);
});

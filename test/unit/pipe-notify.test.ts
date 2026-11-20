import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import test from "node:test";

import { HcSubagentError } from "../../src/core/error.ts";
import {
  MAX_PIPE_FRAME_BYTES,
  NOTIFICATION_VERSION,
  pipeNameFor,
  pipePathFor,
  type PipeNotification,
} from "../../src/child/pipe-protocol.ts";
import { startChildPipeServer } from "../../src/child/pipe-server.ts";
import {
  subscribeChildNotifications,
  type NotificationSubscription,
} from "../../src/child/pipe-transport.ts";

function uniqueName(): string {
  return pipeNameFor("/tmp/pi-hc-tests", `notify-${randomBytes(6).toString("hex")}`);
}

async function scratchDir(): Promise<string> {
  return mkdtemp(path.join("/tmp", "hc-notify-"));
}

function frame(overrides: Partial<PipeNotification> = {}): PipeNotification {
  return {
    type: "settled",
    v: NOTIFICATION_VERSION,
    turn: 2,
    status: "completed",
    sessionFile: "/tmp/pi-hc-tests/session.jsonl",
    at: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

/** Ref'd polling wait, so an unref'd socket/timer cannot let the loop exit. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ManualTimers {
  schedule: (run: () => void, delayMs: number) => () => void;
  fireNext(): boolean;
  pending: Map<number, () => void>;
  delays: number[];
}

/** Test seam: no real backoff sleeps, and pending timers are countable. */
function manualTimers(): ManualTimers {
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const delays: number[] = [];
  return {
    pending,
    delays,
    schedule(run, delayMs) {
      const id = nextId++;
      pending.set(id, run);
      delays.push(delayMs);
      return () => {
        pending.delete(id);
      };
    },
    fireNext() {
      const entry = pending.entries().next();
      if (entry.done) return false;
      pending.delete(entry.value[0]);
      entry.value[1]();
      return true;
    },
  };
}

interface RawServer {
  path: string;
  writeRaw(text: string): void;
  accepted(): number;
  stop(): Promise<void>;
}

/**
 * A bare socket server, so a test can write bytes the typed `ChildPipeServer`
 * never emits (bad JSON, oversize frames, a stray response frame).
 */
async function startRawServer(dir: string, name: string): Promise<RawServer> {
  const socketPath = pipePathFor(name, dir);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return {
    path: socketPath,
    writeRaw(text) {
      for (const socket of sockets) {
        if (!socket.destroyed) socket.write(text);
      }
    },
    accepted() {
      return sockets.size;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

function recorder() {
  const settled: PipeNotification[] = [];
  const errors: HcSubagentError[] = [];
  const degraded: HcSubagentError[] = [];
  const retries: Array<{ attempt: number; delayMs: number }> = [];
  return {
    settled,
    errors,
    degraded,
    retries,
    options: {
      onSettled: (notification: PipeNotification) => settled.push(notification),
      onTransportError: (error: HcSubagentError) => errors.push(error),
      onDegraded: (error: HcSubagentError) => degraded.push(error),
      onReconnect: (attempt: number, delayMs: number) => retries.push({ attempt, delayMs }),
    },
  };
}

async function closeSubscription(subscription: NotificationSubscription | null): Promise<void> {
  subscription?.close();
}

test("a broadcast settled frame reaches onSettled exactly once, decoded", async () => {
  const dir = await scratchDir();
  const name = uniqueName();
  const server = await startChildPipeServer({
    name,
    dir,
    handlers: {
      prompt: async () => ({}),
      followUp: async () => ({}),
      interrupt: async () => ({}),
      shutdown: async () => ({}),
      result: async () => ({}),
    },
  });
  const rec = recorder();
  let subscription: NotificationSubscription | null = null;
  try {
    subscription = subscribeChildNotifications({ pipeName: name, dir, ...rec.options });
    assert.equal(subscription.path, server.path);
    await waitFor(() => subscription?.state === "open", "subscription open");

    const sent = frame();
    // Give the server a moment to register the accepted socket before broadcasting.
    await sleep(20);
    server.broadcast(sent);
    await waitFor(() => rec.settled.length > 0, "settled frame");
    await sleep(20);

    assert.equal(rec.settled.length, 1, "exactly one delivery per frame");
    assert.deepEqual(rec.settled[0], sent);
    assert.deepEqual(rec.errors, []);
    assert.deepEqual(rec.degraded, []);
    assert.equal(subscription.reconnects, 0);
    assert.equal(subscription.state, "open");
  } finally {
    await closeSubscription(subscription);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a malformed line is one terminal protocol error, never a settle", async () => {
  const dir = await scratchDir();
  const name = uniqueName();
  const server = await startRawServer(dir, name);
  const rec = recorder();
  let subscription: NotificationSubscription | null = null;
  try {
    subscription = subscribeChildNotifications({ pipeName: name, dir, ...rec.options });
    await waitFor(() => subscription?.state === "open" && server.accepted() === 1, "open + accepted");

    server.writeRaw("{not json\n");
    await waitFor(() => rec.errors.length > 0, "protocol error");

    assert.equal(rec.errors.length, 1);
    assert.equal(rec.errors[0]?.code, "protocol");
    assert.equal(rec.settled.length, 0, "a bad frame never settles");
    assert.equal(rec.degraded.length, 0);
    assert.equal(subscription.state, "closed");
    assert.equal(subscription.lastError?.code, "protocol");
    assert.equal(rec.retries.length, 0, "a protocol error never reconnects");

    // A second bad frame on the same (now destroyed) socket cannot double-report.
    server.writeRaw("still not json\n");
    await sleep(50);
    assert.equal(rec.errors.length, 1);
    assert.equal(rec.settled.length, 0);
    assert.equal(subscription.state, "closed");
  } finally {
    await closeSubscription(subscription);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an oversize frame is one terminal protocol error and is never buffered unbounded", async () => {
  const dir = await scratchDir();
  const name = uniqueName();
  const server = await startRawServer(dir, name);
  const rec = recorder();
  const timers = manualTimers();
  let subscription: NotificationSubscription | null = null;
  try {
    subscription = subscribeChildNotifications({
      pipeName: name,
      dir,
      backoffMs: [10],
      schedule: timers.schedule,
      ...rec.options,
    });
    await waitFor(() => subscription?.state === "open" && server.accepted() === 1, "open + accepted");

    server.writeRaw("x".repeat(MAX_PIPE_FRAME_BYTES + 1024));
    await waitFor(() => rec.errors.length > 0, "oversize protocol error");

    assert.equal(rec.errors.length, 1);
    assert.equal(rec.errors[0]?.code, "protocol");
    assert.match(rec.errors[0]?.message ?? "", /exceeds/);
    assert.equal(rec.settled.length, 0);
    assert.equal(rec.degraded.length, 0);
    assert.equal(subscription.state, "closed");
    assert.equal(timers.pending.size, 0, "no retry is scheduled by a terminal error");
  } finally {
    await closeSubscription(subscription);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restarted server is reconnected once and keeps delivering frames", async () => {
  const dir = await scratchDir();
  const name = uniqueName();
  const handlers = {
    prompt: async () => ({}),
    followUp: async () => ({}),
    interrupt: async () => ({}),
    shutdown: async () => ({}),
    result: async () => ({}),
  };
  let server = await startChildPipeServer({ name, dir, handlers });
  const rec = recorder();
  let subscription: NotificationSubscription | null = null;
  try {
    subscription = subscribeChildNotifications({
      pipeName: name,
      dir,
      backoffMs: [10, 20, 50],
      ...rec.options,
    });
    await waitFor(() => subscription?.state === "open", "initial open");
    await sleep(20);
    server.broadcast(frame({ turn: 1 }));
    await waitFor(() => rec.settled.length === 1, "first frame");

    await server.stop();
    await waitFor(() => subscription?.state === "connecting", "waiting for a retry");
    server = await startChildPipeServer({ name, dir, handlers });
    await waitFor(() => subscription?.reconnects === 1 && subscription.state === "open", "reconnect", 3000);

    await sleep(20);
    server.broadcast(frame({ turn: 2, status: "failed" }));
    await waitFor(() => rec.settled.length === 2, "second frame");

    assert.equal(subscription.reconnects, 1);
    assert.deepEqual(
      rec.settled.map((item) => item.turn),
      [1, 2],
    );
    assert.deepEqual(rec.errors, []);
    assert.deepEqual(rec.degraded, []);
    assert.equal(rec.retries.length, 1);
    assert.deepEqual(rec.retries[0], { attempt: 1, delayMs: 10 });
  } finally {
    await closeSubscription(subscription);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an absent server exhausts the backoff budget once and then degrades", async () => {
  const dir = await scratchDir();
  const name = uniqueName();
  const rec = recorder();
  const timers = manualTimers();
  let subscription: NotificationSubscription | null = null;
  try {
    subscription = subscribeChildNotifications({
      pipeName: name,
      dir,
      backoffMs: [1000, 40_000, 20],
      schedule: timers.schedule,
      ...rec.options,
    });
    assert.equal(subscription.state, "connecting");

    const deadline = Date.now() + 3000;
    while (rec.degraded.length === 0) {
      assert.ok(Date.now() < deadline, "degrade budget is bounded");
      if (timers.pending.size === 0) {
        await waitFor(() => timers.pending.size > 0 || rec.degraded.length > 0, "next retry or degrade");
        if (rec.degraded.length > 0) break;
      }
      timers.fireNext();
    }

    assert.equal(rec.degraded.length, 1, "onDegraded fires exactly once");
    assert.equal(rec.degraded[0]?.code, "unavailable");
    assert.equal(rec.errors.length, 0);
    assert.equal(rec.settled.length, 0);
    assert.equal(subscription.state, "degraded");
    assert.deepEqual(timers.delays, [1000, 30_000, 20], "delays are capped at 30 s, one per attempt");
    assert.deepEqual(
      rec.retries.map((item) => item.attempt),
      [1, 2, 3],
    );
    assert.equal(timers.pending.size, 0, "no timer survives degradation");

    subscription.close();
    assert.equal(subscription.state, "closed");
    assert.equal(timers.pending.size, 0);
  } finally {
    await closeSubscription(subscription);
    await rm(dir, { recursive: true, force: true });
  }
});

test("close is idempotent during connect and after degradation", async () => {
  const dir = await scratchDir();
  const name = uniqueName();
  try {
    const rec = recorder();
    const timers = manualTimers();
    const duringConnect = subscribeChildNotifications({
      pipeName: name,
      dir,
      backoffMs: [5000],
      schedule: timers.schedule,
      ...rec.options,
    });
    duringConnect.close();
    duringConnect.close();
    assert.equal(duringConnect.state, "closed");
    assert.equal(timers.pending.size, 0, "close during connect cancels the retry timer");
    await sleep(20);
    assert.deepEqual(rec.errors, [], "close is not an error");

    const degradedRec = recorder();
    const degradedTimers = manualTimers();
    const missingName = uniqueName();
    const subscription = subscribeChildNotifications({
      pipeName: missingName,
      dir,
      backoffMs: [1],
      schedule: degradedTimers.schedule,
      ...degradedRec.options,
    });
    const deadline = Date.now() + 3000;
    while (degradedRec.degraded.length === 0) {
      assert.ok(Date.now() < deadline, "degrade budget is bounded");
      if (degradedTimers.pending.size === 0) {
        await waitFor(
          () => degradedTimers.pending.size > 0 || degradedRec.degraded.length > 0,
          "next retry or degrade",
        );
        if (degradedRec.degraded.length > 0) break;
      }
      degradedTimers.fireNext();
    }
    assert.equal(subscription.state, "degraded");
    subscription.close();
    subscription.close();
    assert.equal(subscription.state, "closed");
    assert.equal(degradedTimers.pending.size, 0, "close after degradation leaves no timer");
    assert.equal(degradedRec.errors.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a response frame with a string id is ignored, not mistaken for a settle", async () => {
  const dir = await scratchDir();
  const name = uniqueName();
  const server = await startRawServer(dir, name);
  const rec = recorder();
  const timers = manualTimers();
  let subscription: NotificationSubscription | null = null;
  try {
    subscription = subscribeChildNotifications({
      pipeName: name,
      dir,
      backoffMs: [10],
      schedule: timers.schedule,
      ...rec.options,
    });
    await waitFor(() => subscription?.state === "open" && server.accepted() === 1, "open + accepted");

    server.writeRaw(`${JSON.stringify({ type: "ok", id: "r1", turn: 2 })}\n`);
    server.writeRaw(`${JSON.stringify({ type: "error", id: "r2", code: "blocked", message: "no" })}\n`);
    await sleep(50);

    assert.equal(rec.settled.length, 0, "replies are not notifications");
    assert.equal(rec.errors.length, 0, "replies are not protocol errors");
    assert.equal(subscription.state, "open");

    server.writeRaw(`${JSON.stringify(frame({ turn: 4 }))}\n`);
    await waitFor(() => rec.settled.length === 1, "settled after replies");
    assert.equal(rec.settled[0]?.turn, 4);
  } finally {
    await closeSubscription(subscription);
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("an invalid pipe name throws a validation error before any I/O", () => {
  assert.throws(
    () =>
      subscribeChildNotifications({
        pipeName: "../../etc/passwd",
        onSettled: () => {},
      }),
    (error: unknown) => {
      assert.ok(error instanceof HcSubagentError);
      assert.equal(error.code, "validation");
      return true;
    },
  );
});

import assert from "node:assert/strict";
import test from "node:test";

import { Scheduler } from "../../src/runtime/scheduler.ts";

test("maxConcurrency admits FIFO and releases slots exactly once", async () => {
  const scheduler = new Scheduler({ maxConcurrency: 2, parallelWrites: false });
  const releases: Array<() => void> = [];
  const order: number[] = [];

  const acquire = (index: number) =>
    scheduler.acquire({ write: false, cwd: "/repo" }).then((release) => {
      order.push(index);
      releases.push(release);
    });

  await Promise.all([acquire(1), acquire(2)]);
  assert.deepEqual(order, [1, 2]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.queuedCount, 0);

  const third = acquire(3);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, [1, 2], "third waits for a slot");
  assert.equal(scheduler.queuedCount, 1);

  releases[0]?.();
  releases[0]?.();
  await third;
  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(scheduler.activeCount, 2);
  assert.equal(scheduler.queuedCount, 0);

  releases[1]?.();
  releases[2]?.();
  assert.equal(scheduler.activeCount, 0);
});

test("write-capable tasks in the same cwd are serialized", async () => {
  const scheduler = new Scheduler({ maxConcurrency: 4, parallelWrites: false });
  const first = await scheduler.acquire({ write: true, cwd: "/repo" });
  assert.equal(scheduler.writeCount("/repo"), 1);

  let secondAdmitted = false;
  const second = scheduler.acquire({ write: true, cwd: "/repo" }).then((release) => {
    secondAdmitted = true;
    return release;
  });
  const otherCwd = scheduler.acquire({ write: true, cwd: "/other" });
  const readOnly = scheduler.acquire({ write: false, cwd: "/repo" });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(secondAdmitted, false, "same-cwd write waits");
  // Read-only work and writes in another cwd may proceed.
  const otherRelease = await otherCwd;
  const readRelease = await readOnly;
  assert.equal(scheduler.activeCount, 3);

  first();
  const secondRelease = await second;
  assert.equal(secondAdmitted, true);
  assert.equal(scheduler.writeCount("/repo"), 1);

  secondRelease();
  otherRelease();
  readRelease();
  assert.equal(scheduler.activeCount, 0);
});

test("parallelWrites allows overlapping writes in the same cwd", async () => {
  const scheduler = new Scheduler({ maxConcurrency: 2, parallelWrites: true });
  const first = await scheduler.acquire({ write: true, cwd: "/repo" });
  const second = await scheduler.acquire({ write: true, cwd: "/repo" });
  assert.equal(scheduler.writeCount("/repo"), 2);
  first();
  second();
});

test("aborting a queued acquire removes it without leaking a slot", async () => {
  const scheduler = new Scheduler({ maxConcurrency: 1, parallelWrites: false });
  const release = await scheduler.acquire({ write: false, cwd: "/repo" });
  const controller = new AbortController();
  const queued = scheduler.acquire({ write: false, cwd: "/repo", signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(scheduler.queuedCount, 1);
  controller.abort();
  await assert.rejects(queued, /aborted/);
  assert.equal(scheduler.queuedCount, 0);
  release();
  assert.equal(scheduler.activeCount, 0);
});

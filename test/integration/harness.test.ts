/**
 * Harness self-tests: the safety nets that stop interrupted test runs from
 * leaking a core (and its holder process and RAM) forever.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  ORPHAN_MIN_AGE_MS,
  hcAvailable,
  isOrphanRoot,
  pruneOrphanedHcRoots,
  startIsolatedHc,
} from "./harness.ts";

const available = await hcAvailable();

test("isOrphanRoot keeps active and fresh roots", () => {
  const now = 10_000_000;
  const candidate = { root: "/tmp/hcit-abc", mtimeMs: now - ORPHAN_MIN_AGE_MS - 1 };
  assert.equal(isOrphanRoot(candidate, { activeRoots: [], minAgeMs: ORPHAN_MIN_AGE_MS, now }), true);
  assert.equal(
    isOrphanRoot(candidate, { activeRoots: [candidate.root], minAgeMs: ORPHAN_MIN_AGE_MS, now }),
    false,
  );
  assert.equal(
    isOrphanRoot(
      { root: "/tmp/hcit-abc", mtimeMs: now - 1_000 },
      { activeRoots: [], minAgeMs: ORPHAN_MIN_AGE_MS, now },
    ),
    false,
  );
});

test("pruneOrphanedHcRoots removes only abandoned hcit-* roots", async () => {
  const tmpdir = await mkdtemp(path.join("/tmp", "hcp-"));
  const stale = new Date(Date.now() - ORPHAN_MIN_AGE_MS * 3);
  try {
    const fresh = path.join(tmpdir, "hcit-fresh");
    const abandoned = path.join(tmpdir, "hcit-abandoned");
    const active = path.join(tmpdir, "hcit-active");
    for (const dir of [fresh, abandoned, active]) await mkdir(dir, { recursive: true });
    const unrelated = path.join(tmpdir, "not-an-hc-root");
    await mkdir(unrelated);
    // Both the abandoned and the active root are old enough; only ownership differs.
    await utimes(abandoned, stale, stale);
    await utimes(active, stale, stale);
    await utimes(unrelated, stale, stale);

    const result = await pruneOrphanedHcRoots({ tmpdir, activeRoots: [active] });

    assert.deepEqual(result.removed, [abandoned]);
    assert.deepEqual(result.failed, []);
    assert.equal(existsSync(abandoned), false);
    assert.equal(existsSync(active), true, "a root this process still owns is never pruned");
    assert.equal(existsSync(fresh), true, "a recent root may belong to another test process");
    assert.equal(existsSync(unrelated), true);
  } finally {
    await rm(tmpdir, { recursive: true, force: true });
  }
});

test(
  "pruneOrphanedHcRoots stops the core that still owns an abandoned root",
  { skip: !available },
  async () => {
    // A private tmp dir keeps the prune from touching a sibling test process's
    // live core.
    const tmpdir = await mkdtemp(path.join("/tmp", "hcp-live-"));
    const previous = process.env.PI_HC_SUBAGENTS_TEST_TMPDIR;
    process.env.PI_HC_SUBAGENTS_TEST_TMPDIR = tmpdir;
    let isolated: Awaited<ReturnType<typeof startIsolatedHc>> | null = null;
    try {
      isolated = await startIsolatedHc({ createParent: false });
      const status = JSON.parse(
        (await isolated.hc(["server", "status", "--json"])).stdout || "{}",
      ) as { pid?: number };
      const corePid = status.pid;
      assert.equal(typeof corePid, "number");

      // Simulate a killed test process: the root is no longer active here.
      const result = await pruneOrphanedHcRoots({ tmpdir, minAgeMs: 0, activeRoots: [] });

      assert.deepEqual(result.removed, [isolated.root]);
      assert.deepEqual(result.failed, []);
      assert.equal(existsSync(isolated.root), false);
      const deadline = Date.now() + 10_000;
      while (isAlive(corePid as number)) {
        if (Date.now() > deadline) assert.fail(`orphaned core ${corePid} is still running`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      await isolated?.cleanup();
      if (previous === undefined) delete process.env.PI_HC_SUBAGENTS_TEST_TMPDIR;
      else process.env.PI_HC_SUBAGENTS_TEST_TMPDIR = previous;
      await rm(tmpdir, { recursive: true, force: true });
    }
  },
);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

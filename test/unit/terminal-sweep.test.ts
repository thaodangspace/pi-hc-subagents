import assert from "node:assert/strict";
import test from "node:test";

import { HcSubagentError } from "../../src/core/error.ts";
import type { TerminalRecord } from "../../src/core/hc-types.ts";
import {
  SWEEP_DEFAULT_MAX_REMOVALS,
  SWEEP_PARENT_LABEL,
  selectSweepCandidates,
  sweepFinishedTerminals,
} from "../../src/runtime/terminal-sweep.ts";

const PARENT = "parent-1";

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    address: "t12",
    name: "hc-reviewer-a1b2",
    cwd: "/repo",
    argv: [],
    state: "finished",
    status: null,
    turn: 1,
    exitCode: 0,
    signal: null,
    parent: null,
    labels: { [SWEEP_PARENT_LABEL]: PARENT, "pi-hc-subagents": "1" },
    createdMs: 1_000,
    finishedMs: 2_000,
    statusMs: null,
    reported: true,
    reason: "exit",
    keep: false,
    rm: false,
    foreground: null,
    pid: 1,
    notify: false,
    identity: "ghostty",
    screen: "exact",
    ...overrides,
  };
}

test("selectSweepCandidates keeps only own-parent finished terminals", () => {
  const candidates = selectSweepCandidates(
    [
      terminal({ address: "own", finishedMs: 5_000 }),
      terminal({ address: "other-parent", labels: { [SWEEP_PARENT_LABEL]: "parent-2" } }),
      terminal({ address: "unlabeled", labels: {} }),
      terminal({ address: "live", state: "live", finishedMs: null }),
    ],
    { parentSessionId: PARENT },
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.address),
    ["own"],
  );
});

test("selectSweepCandidates protects registry terminals and caps the batch", () => {
  const terminals = [
    terminal({ address: "protected", finishedMs: 1_000 }),
    terminal({ address: "old", finishedMs: 2_000 }),
    terminal({ address: "new", finishedMs: 3_000 }),
  ];
  assert.deepEqual(
    selectSweepCandidates(terminals, { parentSessionId: PARENT, protectedTerminals: ["protected"] }).map(
      (candidate) => candidate.address,
    ),
    ["old", "new"],
  );
  // Oldest finished first, so a cap always drops the most recent ones.
  assert.deepEqual(
    selectSweepCandidates(terminals, { parentSessionId: PARENT, protectedTerminals: ["protected"], maxRemovals: 1 }).map(
      (candidate) => candidate.address,
    ),
    ["old"],
  );
  assert.deepEqual(selectSweepCandidates(terminals, { parentSessionId: PARENT, maxRemovals: 0 }), []);
  assert.deepEqual(selectSweepCandidates(terminals, { parentSessionId: "" }), []);
});

test("selectSweepCandidates falls back to createdMs for ordering", () => {
  const candidates = selectSweepCandidates(
    [
      terminal({ address: "b", createdMs: 2_000, finishedMs: null }),
      terminal({ address: "a", createdMs: 1_000, finishedMs: null }),
    ],
    { parentSessionId: PARENT },
  );
  assert.deepEqual(
    candidates.map((candidate) => candidate.address),
    ["a", "b"],
  );
});

test("sweepFinishedTerminals lists by parent label and removes candidates", async () => {
  const listCalls: unknown[] = [];
  const removed: string[] = [];
  const result = await sweepFinishedTerminals({
    core: {
      list: async (params) => {
        listCalls.push(params);
        return {
          terminals: [
            terminal({ address: "t1" }),
            terminal({ address: "t2", labels: { [SWEEP_PARENT_LABEL]: "parent-2" } }),
            terminal({ address: "t3", state: "live" }),
          ],
          hiddenFinished: 0,
        };
      },
      remove: async (address) => {
        removed.push(address);
        return { removed: address };
      },
    },
    parentSessionId: PARENT,
    protectedTerminals: ["t-protected"],
  });

  assert.deepEqual(listCalls, [{ all: true, labels: { [SWEEP_PARENT_LABEL]: PARENT } }]);
  assert.deepEqual(removed, ["t1"]);
  assert.deepEqual(result, { scanned: 3, removed: ["t1"], failed: [] });
});

test("sweepFinishedTerminals treats already-gone terminals as removed and records real failures", async () => {
  const result = await sweepFinishedTerminals({
    core: {
      list: async () => ({
        terminals: [terminal({ address: "gone" }), terminal({ address: "broken" })],
        hiddenFinished: 0,
      }),
      remove: async (address) => {
        if (address === "gone") throw new HcSubagentError("not_found", "no such terminal");
        throw new HcSubagentError("unavailable", "socket closed");
      },
    },
    parentSessionId: PARENT,
  });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.failed, [{ terminal: "broken", error: "socket closed" }]);
});

test("sweepFinishedTerminals never throws and skips work when disabled", async () => {
  let listed = 0;
  const failing = await sweepFinishedTerminals({
    core: {
      list: async () => {
        listed++;
        throw new HcSubagentError("unavailable", "no endpoint");
      },
      remove: async () => assert.fail("must not remove without a listing"),
    },
    parentSessionId: PARENT,
  });
  assert.deepEqual(failing, { scanned: 0, removed: [], failed: [] });
  assert.equal(listed, 1);

  const disabled = await sweepFinishedTerminals({
    core: {
      list: async () => {
        listed++;
        return { terminals: [], hiddenFinished: 0 };
      },
      remove: async () => ({ removed: "" }),
    },
    parentSessionId: PARENT,
    maxRemovals: 0,
  });
  assert.deepEqual(disabled, { scanned: 0, removed: [], failed: [] });
  assert.equal(listed, 1);

  const noParent = await sweepFinishedTerminals({
    core: {
      list: async () => {
        listed++;
        return { terminals: [], hiddenFinished: 0 };
      },
      remove: async () => ({ removed: "" }),
    },
    parentSessionId: "",
  });
  assert.deepEqual(noParent, { scanned: 0, removed: [], failed: [] });
  assert.equal(listed, 1);
  assert.equal(SWEEP_DEFAULT_MAX_REMOVALS, 50);
});

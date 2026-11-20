import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { RunMetadata } from "../../src/child/child-spawn.ts";
import {
  RUN_ENTRY_TYPE,
  RunPersistence,
  mergeSummaries,
  parsePersistedSummary,
  summariesForParent,
  toPersistedSummary,
  type PersistedRunSummary,
  type PersistenceEntry,
} from "../../src/runtime/persistence.ts";
import { cleanupExpiredRuns } from "../../src/runtime/retention.ts";
import {
  loadSummariesFromRunDirs,
  reconcileRuns,
  runMetadataToSummary,
} from "../../src/runtime/reconcile.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { buildResultJson, writeResultFile } from "../../src/runtime/result-store.ts";
import type { SubagentRecord } from "../../src/runtime/types.ts";

const TASK_SECRET = "SECRET TASK INSTRUCTIONS";
const RESULT_SECRET = "SECRET FINAL RESULT";

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    version: 1,
    runId: "20261120T120000Z-abcdef",
    childId: "child-1",
    parentSessionId: "parent-a",
    agent: "reviewer",
    agentSource: "user",
    agentAccess: "read-only",
    cwd: "/repo",
    terminal: "t12",
    terminalName: "hc-reviewer-a1b2",
    sessionId: "child-1",
    sessionFile: "/runs/run-1/sessions/child-1.jsonl",
    runDir: "/runs/run-1",
    resultFile: "/runs/run-1/result.json",
    state: "completed",
    terminalState: "finished",
    coreStatus: "done",
    slug: "reviewer-a1b2",
    turn: 1,
    turns: [
      {
        index: 1,
        task: TASK_SECRET,
        startedAt: "2026-11-20T12:00:00.000Z",
        startedAtMs: 1_700_000_000_000,
        baselineTurn: 0,
        state: "completed",
        outcome: "stop",
        text: RESULT_SECRET,
        usage: {
          input: 10,
          output: 5,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 15,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        terminal: "t12",
      },
    ],
    createdAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:01:00.000Z",
    settledAt: "2026-11-20T12:01:00.000Z",
    labels: { "pi-hc-run": "20261120T120000Z-abcdef" },
    background: true,
    origin: "tool",
    ...overrides,
  };
}

test("persisted summaries never contain task or result text", () => {
  const summary = toPersistedSummary(record());
  const json = JSON.stringify(summary);
  assert.equal(json.includes(TASK_SECRET), false);
  assert.equal(json.includes(RESULT_SECRET), false);
  assert.equal(summary.lastTurn?.startedAtMs, 1_700_000_000_000);
  assert.equal(summary.usage?.totalTokens, 15);
});

test("summaries are scoped to one parent session and the latest write wins", () => {
  const first = toPersistedSummary(record({ childId: "child-1", updatedAt: "2026-11-20T12:01:00.000Z" }));
  const second = toPersistedSummary(
    record({ childId: "child-1", state: "failed", updatedAt: "2026-11-20T12:02:00.000Z" }),
  );
  const other = toPersistedSummary(record({ childId: "child-2", parentSessionId: "parent-b" }));
  const entries: PersistenceEntry[] = [
    { type: "custom", customType: RUN_ENTRY_TYPE, data: first },
    { type: "custom", customType: RUN_ENTRY_TYPE, data: other },
    { type: "custom", customType: RUN_ENTRY_TYPE, data: second },
    { type: "message" },
  ];
  const summaries = summariesForParent(entries, "parent-a");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0]?.state, "failed");
  assert.equal(mergeSummaries(summaries, [other]).length, 2);
});

test("malformed persistence entries are ignored", () => {
  assert.equal(parsePersistedSummary(null), null);
  assert.equal(parsePersistedSummary({ version: 1 }), null);
  assert.equal(parsePersistedSummary({ ...toPersistedSummary(record()), version: 2 }), null);
  assert.equal(parsePersistedSummary({ ...toPersistedSummary(record()), state: "bogus" }), null);
});

test("RunPersistence deduplicates identical summaries and restores them", () => {
  const entries: PersistenceEntry[] = [];
  const persistence = new RunPersistence({
    appendEntry(customType, data) {
      entries.push({ type: "custom", customType, data });
    },
    getEntries: () => entries,
  });
  persistence.append(record());
  persistence.append(record());
  assert.equal(entries.length, 1);
  persistence.append(record({ state: "failed", updatedAt: "2026-11-20T12:02:00.000Z" }));
  assert.equal(entries.length, 2);
  const restored = persistence.restore("parent-a");
  assert.equal(restored.length, 1);
  assert.equal(restored[0]?.state, "failed");
});

function runMetadata(overrides: Partial<RunMetadata> = {}): RunMetadata {
  return {
    version: 1,
    runId: "run-1",
    childId: "child-1",
    parentSessionId: "parent-a",
    parentTerminalId: "t3",
    agent: "reviewer",
    agentSource: "user",
    agentAccess: "read-only",
    cwd: "/repo",
    taskFile: "/runs/run-1/task.md",
    systemFile: "/runs/run-1/system.md",
    resultFile: "/runs/run-1/result.json",
    sessionDir: "/runs/run-1/sessions",
    sessionId: "child-1",
    terminalName: "hc-reviewer-a1b2",
    origin: "tool",
    slug: "reviewer-a1b2",
    background: true,
    labels: {},
    createdAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:01:00.000Z",
    state: "completed",
    terminal: "t12",
    ...overrides,
  };
}

test("run.json recovery only reconstructs this parent's runs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hc-persist-"));
  try {
    for (const [dir, parent] of [
      ["run-a", "parent-a"],
      ["run-b", "parent-b"],
    ] as const) {
      await mkdir(path.join(root, dir), { recursive: true });
      await writeFile(
        path.join(root, dir, "run.json"),
        JSON.stringify(runMetadata({ parentSessionId: parent, runId: dir, childId: `child-${dir}` })),
        "utf8",
      );
    }
    const summaries = await loadSummariesFromRunDirs({ runsRoot: root, parentSessionId: "parent-a" });
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]?.runId, "run-a");
    assert.equal(summaries[0]?.slug, "reviewer-a1b2");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a resumed child that is no longer live becomes failed/exited", async () => {
  const registry = new Registry();
  const { restored, stale } = await reconcileRuns({
    registry,
    summaries: [runMetadataToSummary(runMetadata({ state: "working" }))],
    core: { tryGet: async () => null } as never,
  });
  assert.equal(restored.length, 1);
  assert.equal(stale.length, 1);
  assert.equal(registry.all()[0]?.state, "failed");
  assert.equal(registry.all()[0]?.turns[0]?.outcome, "exited");
});

test("a still-live recorded child is kept and looked up by address only", async () => {
  const registry = new Registry();
  const calls: string[] = [];
  const { stale } = await reconcileRuns({
    registry,
    summaries: [runMetadataToSummary(runMetadata({ state: "working" }))],
    core: {
      tryGet: async (terminal: string) => {
        calls.push(terminal);
        return {
          address: terminal,
          name: "someone-elses-name",
          cwd: "/repo",
          argv: [],
          state: "live",
          status: { state: "working", kind: null, message: "" },
          turn: 1,
          exitCode: null,
          signal: null,
          parent: null,
          labels: {},
          createdMs: 0,
          finishedMs: null,
          statusMs: null,
          reported: true,
          reason: null,
          keep: false,
          rm: false,
          foreground: null,
          pid: 1,
          notify: false,
          identity: null,
        };
      },
    } as never,
  });
  assert.deepEqual(calls, ["t12"]);
  assert.equal(stale.length, 0);
  assert.equal(registry.all()[0]?.terminalState, "live");
});

test("a published result wins over a stale summary", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "hc-resume-"));
  const registry = new Registry();
  try {
    await writeResultFile(
      path.join(runDir, "result.json"),
      buildResultJson({
        childId: "child-1",
        turn: 1,
        state: "completed",
        outcome: "stop",
        text: RESULT_SECRET,
        sessionFile: "/runs/run-1/sessions/child-1.jsonl",
        terminal: "t12",
        startedAt: "2026-11-20T12:00:00.000Z",
        settledAt: "2026-11-20T12:01:00.000Z",
      }),
    );
    const summary = runMetadataToSummary(
      runMetadata({ state: "working", resultFile: path.join(runDir, "result.json") }),
    );
    await reconcileRuns({ registry, summaries: [summary], core: { tryGet: async () => null } as never });
    assert.equal(registry.all()[0]?.state, "completed");
    assert.equal(registry.all()[0]?.turns[0]?.outcome, "stop");
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
});

test("retention deletes only expired inactive runs with no live terminal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hc-retention-"));
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const old = "2026-11-18T12:00:00.000Z";
  const recent = "2026-11-20T11:30:00.000Z";
  const writeRun = async (name: string, state: string, updatedAt: string, terminal = "t1") => {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "run.json"), JSON.stringify({ state, updatedAt, terminal }), "utf8");
    return dir;
  };
  try {
    const expired = await writeRun("expired", "completed", old, "t1");
    const active = await writeRun("active", "working", old, "t2");
    const recentDir = await writeRun("recent", "completed", recent, "t3");
    const live = await writeRun("live", "completed", old, "t4");
    const missing = path.join(root, "missing-run-json");
    await mkdir(missing, { recursive: true });

    const result = await cleanupExpiredRuns({
      runsRoot: root,
      retentionDays: 1,
      now: () => now,
      isTerminalLive: async (terminal) => terminal === "t4",
    });
    assert.deepEqual(result.removed, [expired]);
    assert.equal(result.kept.includes(active), true);
    assert.equal(result.kept.includes(recentDir), true);
    assert.equal(result.kept.includes(live), true);
    assert.equal(result.kept.includes(missing), true);
    await assert.rejects(readFile(path.join(expired, "run.json")));
    await readFile(path.join(active, "run.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retention is disabled when retentionDays is zero", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hc-retention-"));
  try {
    const dir = path.join(root, "old");
    await mkdir(dir);
    await writeFile(path.join(dir, "run.json"), JSON.stringify({ state: "completed", updatedAt: "2020-01-01T00:00:00.000Z" }));
    const result = await cleanupExpiredRuns({ runsRoot: root, retentionDays: 0 });
    assert.deepEqual(result.removed, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

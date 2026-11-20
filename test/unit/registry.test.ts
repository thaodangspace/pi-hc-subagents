import assert from "node:assert/strict";
import test from "node:test";

import { Registry } from "../../src/runtime/registry.ts";
import type { SubagentRecord } from "../../src/runtime/types.ts";
import type { TerminalRecord } from "../../src/core/hc-types.ts";

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
    terminalName: "hc-reviewer-a1b2",
    sessionId: "child-1",
    sessionFile: null,
    state: "working",
    terminalState: "live",
    coreStatus: "working",
    slug: "reviewer-a1b2",
    turn: 0,
    turns: [],
    createdAt: "2026-11-20T03:40:00.000Z",
    updatedAt: "2026-11-20T03:40:00.000Z",
    labels: {},
    background: false,
    origin: "tool",
    ...overrides,
  };
}

function terminal(overrides: Partial<TerminalRecord> = {}): TerminalRecord {
  return {
    address: "t12",
    name: "hc-reviewer-a1b2",
    cwd: "/repo",
    argv: [],
    state: "live",
    status: { state: "working", kind: null, message: "", title: "", app: "pi", progress: null },
    turn: 2,
    exitCode: null,
    signal: null,
    parent: "t3",
    labels: { a: "b" },
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
    identity: "ghostty",
    screen: "exact",
    ...overrides,
  };
}

test("resolves exact child id, terminal, name, and slug in order", () => {
  const registry = new Registry();
  registry.create(record());
  for (const id of ["child-1", "t12", "hc-reviewer-a1b2", "reviewer-a1b2"]) {
    const resolution = registry.resolve(id);
    assert.equal(resolution.kind, "found", id);
    if (resolution.kind === "found") assert.equal(resolution.record.childId, "child-1");
  }
  assert.deepEqual(registry.resolve("nope"), { kind: "none" });
});

test("exact child id wins over a terminal that shares the string", () => {
  const registry = new Registry();
  registry.create(record({ childId: "shared", terminal: "shared-2", terminalName: "n", slug: "s" }));
  registry.create(record({ childId: "other", terminal: "shared", terminalName: "hc-x", slug: "x" }));
  const resolution = registry.resolve("shared");
  assert.equal(resolution.kind, "found");
  if (resolution.kind === "found") assert.equal(resolution.record.childId, "shared");
});

test("unique suffix matches resolve; ambiguous suffixes report candidates", () => {
  const registry = new Registry();
  registry.create(record({ childId: "child-1", terminalName: "hc-reviewer-aaaa", slug: "reviewer-aaaa" }));
  assert.equal(registry.resolve("aaaa").kind, "found");

  registry.create(record({ childId: "child-2", terminalName: "hc-scout-aaaa", slug: "scout-aaaa", terminal: "t13" }));
  const resolution = registry.resolve("aaaa");
  assert.equal(resolution.kind, "ambiguous");
  if (resolution.kind === "ambiguous") assert.equal(resolution.candidates.length, 2);
});

test("list is scoped to the parent session and can hide finished runs", () => {
  const registry = new Registry();
  registry.create(record({ childId: "a", createdAt: "2026-01-01T00:00:00.000Z" }));
  registry.create(record({ childId: "b", terminal: "t13", createdAt: "2026-01-02T00:00:00.000Z", state: "completed" }));
  registry.create(record({ childId: "c", parentSessionId: "parent-2", createdAt: "2026-01-03T00:00:00.000Z" }));

  const all = registry.listForParent("parent-1");
  assert.deepEqual(all.map((item) => item.childId), ["a", "b"]);
  const active = registry.listForParent("parent-1", { includeFinished: false });
  assert.deepEqual(active.map((item) => item.childId), ["a"]);
});

test("applyTerminal updates status, turn, labels, and exit fields", () => {
  const registry = new Registry();
  registry.create(record());
  const updated = registry.applyTerminal("child-1", terminal({ state: "finished", exitCode: 0, turn: 3 }));
  assert.equal(updated.terminalState, "finished");
  assert.equal(updated.exitCode, 0);
  assert.equal(updated.turn, 3);
  assert.equal(updated.coreStatus, "working", "status word is preserved even after exit");
  assert.deepEqual(updated.labels, { a: "b" });
});

test("update refuses unknown children and remove drops the record", () => {
  const registry = new Registry();
  assert.throws(() => registry.update("missing", {}));
  registry.create(record());
  registry.remove("child-1");
  assert.equal(registry.get("child-1"), undefined);
});

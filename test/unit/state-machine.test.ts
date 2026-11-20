import assert from "node:assert/strict";
import test from "node:test";

import { ChildStateMachine, observationFromTerminal } from "../../src/runtime/state-machine.ts";

function machine(options: { baselineTurn?: number; startupTimeoutMs?: number; waitTimeoutMs?: number; now?: () => number } = {}) {
  let clock = 0;
  const now = options.now ?? (() => clock);
  const state = new ChildStateMachine({
    baselineTurn: options.baselineTurn ?? 0,
    startupTimeoutMs: options.startupTimeoutMs ?? 60_000,
    waitTimeoutMs: options.waitTimeoutMs ?? 600_000,
    now,
  });
  return { state, advance: (ms: number) => (clock += ms), clock: () => clock };
}

function observe(state: ChildStateMachine, overrides: Partial<Parameters<typeof observationFromTerminal>[0]> = {}) {
  return state.observe(
    observationFromTerminal({
      state: "live",
      status: { state: "idle", kind: null, message: "" },
      turn: 0,
      exitCode: null,
      signal: null,
      ...overrides,
    }),
  );
}

test("startup idle with turn 0 does not settle", () => {
  const { state } = machine();
  const transition = observe(state);
  assert.equal(transition.type, "starting");
  assert.equal(state.phase, "starting");
  assert.equal(state.sawWorking, false);
});

test("working then done with an advanced turn settles", () => {
  const { state } = machine();
  assert.equal(observe(state, { status: { state: "working", kind: null, message: "" } }).type, "working");
  assert.equal(state.phase, "working");
  const transition = observe(state, { status: { state: "done", kind: null, message: "" }, turn: 1 });
  assert.equal(transition.type, "settled");
  if (transition.type === "settled") assert.equal(transition.reason, "turn_advanced");
});

test("a stale done with turn 0 does not settle", () => {
  const { state } = machine();
  assert.equal(observe(state, { status: { state: "done", kind: null, message: "" }, turn: 0 }).type, "starting");
  assert.notEqual(state.phase, "completed");
});

test("an error status is a terminal turn", () => {
  const { state } = machine();
  const transition = observe(state, { status: { state: "error", kind: null, message: "boom" }, turn: 1 });
  assert.equal(transition.type, "settled");
  if (transition.type === "settled") assert.equal(transition.reason, "error_status");
});

test("blocked -> working -> completed preserves one blocked episode", () => {
  const { state } = machine();
  const blocked = observe(state, {
    status: { state: "blocked", kind: "permission", message: "Allow?" },
  });
  assert.equal(blocked.type, "blocked");
  if (blocked.type === "blocked") {
    assert.equal(blocked.episode, 1);
    assert.equal(blocked.kind, "permission");
    assert.equal(blocked.message, "Allow?");
  }
  assert.equal(state.phase, "blocked");

  const working = observe(state, { status: { state: "working", kind: null, message: "" } });
  assert.equal(working.type, "working");
  assert.equal(state.phase, "working");

  const settled = observe(state, { status: { state: "done", kind: null, message: "" }, turn: 1 });
  assert.equal(settled.type, "settled");
});

test("a second blocked episode increments the episode counter", () => {
  const { state } = machine();
  observe(state, { status: { state: "blocked", kind: "question", message: "Q1" } });
  observe(state, { status: { state: "working", kind: null, message: "" } });
  const second = observe(state, { status: { state: "blocked", kind: "question", message: "Q2" } });
  assert.equal(second.type, "blocked");
  if (second.type === "blocked") assert.equal(second.episode, 2);
});

test("terminal exit is reported as exited before result parsing", () => {
  const { state } = machine();
  const transition = observe(state, {
    state: "finished",
    status: null,
    exitCode: 3,
    signal: null,
  });
  assert.equal(transition.type, "exited");
  if (transition.type === "exited") assert.equal(transition.exitCode, 3);
});

test("startup timeout leaves the child in starting", () => {
  const { state, advance } = machine({ startupTimeoutMs: 1000 });
  advance(1001);
  assert.equal(observe(state).type, "startup_timeout");
  assert.equal(state.phase, "starting");
});

test("wait timeout applies while working but never while blocked", () => {
  const { state, advance } = machine({ startupTimeoutMs: 60_000, waitTimeoutMs: 1000 });
  observe(state, { status: { state: "working", kind: null, message: "" } });
  advance(1001);
  assert.equal(observe(state, { status: { state: "working", kind: null, message: "" } }).type, "wait_timeout");

  const blocked = machine({ startupTimeoutMs: 60_000, waitTimeoutMs: 1000 });
  observe(blocked.state, { status: { state: "blocked", kind: "auth", message: "login" } });
  blocked.advance(5000);
  assert.equal(observe(blocked.state, { status: { state: "blocked", kind: "auth", message: "login" } }).type, "continue");
});

test("abort is sticky and returns cancelled", () => {
  const { state } = machine();
  assert.equal(state.abort("tool aborted").type, "cancelled");
  const transition = observe(state, { status: { state: "working", kind: null, message: "" } });
  assert.equal(transition.type, "cancelled");
  if (transition.type === "cancelled") assert.equal(transition.reason, "tool aborted");
});

test("working starts the duration only once", () => {
  const { state, advance } = machine();
  advance(5000);
  observe(state, { status: { state: "working", kind: null, message: "" } });
  assert.equal(state.workStartedAtMs, 5000);
  advance(1000);
  observe(state, { status: { state: "working", kind: null, message: "" } });
  assert.equal(state.workStartedAtMs, 5000);
});

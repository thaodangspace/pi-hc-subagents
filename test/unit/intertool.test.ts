import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../../src/config/schema.ts";
import {
  SERVICE_SYMBOL_NAME,
  IntertoolServiceV1,
  installService,
  removeService,
  serviceFrom,
} from "../../src/intertool/service.ts";
import { EventPublisher, type SubagentEvent } from "../../src/intertool/events.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import type { SubagentRecord } from "../../src/runtime/types.ts";
import type { ToolSession } from "../../src/tools/session.ts";

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    version: 1,
    runId: "run-1",
    childId: "child-1",
    parentSessionId: "parent-a",
    agent: "reviewer",
    agentSource: "user",
    agentAccess: "read-only",
    cwd: "/repo",
    terminal: "t12",
    terminalName: "hc-reviewer-a1b2",
    sessionId: "child-1",
    sessionFile: null,
    runDir: "/runs/run-1",
    resultFile: "/runs/run-1/result.json",
    state: "working",
    terminalState: "live",
    coreStatus: "working",
    slug: "reviewer-a1b2",
    turn: 1,
    turns: [],
    createdAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:00.000Z",
    labels: {},
    background: true,
    origin: "intertool",
    ...overrides,
  };
}

function fakeSession(registry = new Registry()): ToolSession {
  const runtime = {
    prerequisites: { coreVersion: "0.1.21" },
    config: { ...DEFAULT_CONFIG },
    parentSessionId: "parent-a",
    cwd: "/repo",
    trusted: true,
    agentDir: "/tmp/agent",
    agentDirs: { package: "/tmp/package", user: "/tmp/agent/agents", project: null },
    env: {},
  } as never;
  return {
    runtime: runtime as ToolSession["runtime"],
    registry,
    scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
  };
}

test("events are ordered, versioned, and carry no task or result text", () => {
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const publisher = new EventPublisher({
    enabled: () => true,
    includeTaskPreview: () => false,
    emit: (channel, payload) => emitted.push({ channel, payload }),
  });
  const events: SubagentEvent[] = [];
  publisher.subscribe((event) => events.push(event));
  publisher.spawned(record(), "SECRET TASK");
  publisher.status(record({ state: "blocked" }), "working");
  publisher.settled(record({ state: "completed" }), "stop", "/runs/run-1/result.json");
  assert.deepEqual(events.map((event) => event.type), ["spawned", "status", "settled"]);
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  const json = JSON.stringify(events);
  assert.equal(json.includes("SECRET TASK"), false);
  assert.equal(emitted[0]?.channel, "hc-subagents:child.spawned");
  assert.equal((emitted[2]?.payload as SubagentEvent).seq, 3);
});

test("task preview is opt-in and bounded", () => {
  const publisher = new EventPublisher({ enabled: () => true, includeTaskPreview: () => true });
  const events: SubagentEvent[] = [];
  publisher.subscribe((event) => events.push(event));
  publisher.spawned(record(), "x".repeat(500));
  const event = events[0];
  assert.equal(event?.type, "spawned");
  assert.equal((event as { taskPreview?: string }).taskPreview?.length, 200);
});

test("a throwing subscriber does not break other subscribers or the producer", () => {
  const seen: string[] = [];
  const errors: unknown[] = [];
  const publisher = new EventPublisher({
    enabled: () => true,
    includeTaskPreview: () => false,
    onSubscriberError: (error) => errors.push(error),
  });
  publisher.subscribe(() => {
    throw new Error("subscriber exploded");
  });
  publisher.subscribe((event) => seen.push(event.type));
  assert.doesNotThrow(() => publisher.removed(record()));
  assert.deepEqual(seen, ["removed"]);
  assert.equal(errors.length, 1);
});

test("disabled events are not emitted", () => {
  const publisher = new EventPublisher({ enabled: () => false, includeTaskPreview: () => false });
  const seen: SubagentEvent[] = [];
  publisher.subscribe((event) => seen.push(event));
  assert.equal(publisher.spawned(record()), null);
  assert.equal(seen.length, 0);
});

test("service installs and removes the v1 symbol", () => {
  const target: Record<symbol, unknown> = {};
  const service = new IntertoolServiceV1({
    session: fakeSession(),
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  installService(service, target);
  assert.equal(target[Symbol.for(SERVICE_SYMBOL_NAME)], service);
  assert.equal(serviceFrom(target)?.version, 1);
  removeService(target);
  assert.equal(serviceFrom(target), undefined);
});

test("capabilities advertise the M3 feature set", () => {
  const service = new IntertoolServiceV1({
    session: fakeSession(),
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  assert.deepEqual(service.capabilities.features, [
    "spawn",
    "wait",
    "send",
    "cancel",
    "events",
    "project-agents",
    "providers",
    "result-adapters",
  ]);
  assert.equal(service.capabilities.backend, "hc-local");
  assert.equal(service.capabilities.coreVersion, "0.1.21");
});

test("service send rejects a blocked child without touching the pipe", async () => {
  const registry = new Registry();
  registry.create(record({ state: "blocked", coreStatus: "blocked" }));
  const session = fakeSession(registry);
  (session.runtime as unknown as { core: unknown }).core = {
    tryGet: async () => ({
      address: "t12",
      state: "live",
      status: { state: "blocked", kind: "permission" },
      turn: 1,
    }),
  };
  const service = new IntertoolServiceV1({
    session,
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  await assert.rejects(() => service.send("child-1", "please continue"), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "blocked");
    return true;
  });
});

test("get and list only expose this parent session's children", async () => {
  const registry = new Registry();
  registry.create(record());
  registry.create(record({ childId: "other-child", parentSessionId: "parent-b", terminal: "t99" }));
  const service = new IntertoolServiceV1({
    session: fakeSession(registry),
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  const all = await service.list();
  assert.equal(all.length, 1);
  assert.equal(all[0]?.childId, "child-1");
  assert.equal(service.get("child-1")?.agent, "reviewer");
  assert.equal(service.get("other-child"), undefined);
  assert.equal(service.get("nope"), undefined);
});

test("subscribers receive emitted child events; cancel rejects unknown ids", async () => {
  const registry = new Registry();
  registry.create(record());
  const service = new IntertoolServiceV1({
    session: fakeSession(registry),
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  const seen: string[] = [];
  const off = service.subscribe((event) => seen.push(event.type));
  service.emitBlocked(registry.all()[0] as SubagentRecord, "permission", "allow?");
  off();
  service.emitStatus(registry.all()[0] as SubagentRecord, "working");
  assert.deepEqual(seen, ["blocked"]);
  await assert.rejects(service.cancel("missing"), /no subagent matches/);
});

test("agent sources can be registered and removed", () => {
  const session = fakeSession();
  const service = new IntertoolServiceV1({
    session,
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  const source = {
    id: "test-source",
    precedence: 30,
    discover: async () => [],
  };
  const off = service.registerAgentSource(source);
  assert.deepEqual(session.agentSources?.map((entry) => entry.id), ["test-source"]);
  off();
  assert.deepEqual(session.agentSources, []);
});

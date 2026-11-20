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
import type { PipeNotification } from "../../src/child/pipe-protocol.ts";
import type { NotificationSubscriptionState } from "../../src/child/pipe-transport.ts";
import { SettleHintHub, type SettleHintTransportInput } from "../../src/runtime/settle-hints.ts";
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

function settlementSubscription(): {
  subscription: {
    path: string;
    state: NotificationSubscriptionState;
    reconnects: number;
    lastError: null;
    close(): void;
  };
  transport(input: SettleHintTransportInput): typeof subscription;
  fire(overrides?: Partial<PipeNotification>): void;
} {
  let input: SettleHintTransportInput | undefined;
  const subscription = {
    path: "/tmp/pi-hc-tests/fake.sock",
    state: "open" as NotificationSubscriptionState,
    reconnects: 0,
    lastError: null,
    close() {
      subscription.state = "closed";
    },
  };
  return {
    subscription,
    transport(value: SettleHintTransportInput) {
      input = value;
      return subscription;
    },
    fire(overrides = {}) {
      input?.onSettled({
        type: "settled",
        v: 1,
        turn: 2,
        status: "completed",
        at: "2026-11-21T00:00:00.000Z",
        ...overrides,
      });
    },
  };
}

test("status events carry an additive bounded wake summary", () => {
  const registry = new Registry();
  registry.create(record({ turns: [{ index: 1, task: "SECRET TASK", startedAt: "2026-11-20T12:00:00.000Z", baselineTurn: 0, state: "running", terminal: "t12" }] }));
  const session = fakeSession(registry);

  const transport = settlementSubscription();
  const hub = new SettleHintHub({ transport: transport.transport });
  session.settleHints = hub;
  assert.equal(hub.start("child-1", "pi-hc-0123456789abcdef-child-1"), true);
  transport.fire();

  const service = new IntertoolServiceV1({
    session,
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  const events: SubagentEvent[] = [];
  service.subscribe((event) => events.push(event));
  service.emitStatus(registry.all()[0] as SubagentRecord, "starting");

  assert.equal(events.length, 1);
  const event = events[0] as SubagentEvent & { wake?: unknown };
  assert.equal(event.version, 1);
  assert.equal(event.type, "status");
  assert.equal(event.seq, 1);
  assert.equal(event.childId, "child-1");
  assert.equal(event.runId, "run-1");
  assert.equal(event.agent, "reviewer");
  assert.equal(event.terminal, "t12");
  assert.equal(event.state, "working");
  assert.equal(event.turn, 1);
  assert.equal(event.coreStatus, "working");
  assert.equal(event.previousState, "starting");
  assert.deepEqual(event.wake, {
    mode: "push",
    hints: 1,
    wakes: 0,
    falseWakes: 0,
    staleDrops: 0,
    duplicateDrops: 0,
    reconnects: 0,
    degraded: false,
  });

  const wakeJson = JSON.stringify(event.wake);
  for (const forbidden of ['"text"', '"task"', '"prompt"', "child-1", "/tmp", "/runs"]) {
    assert.equal(wakeJson.includes(forbidden), false, `wake summary must not carry ${forbidden}`);
  }
  assert.equal(Object.hasOwn(event, "task"), false);
  assert.equal(Object.hasOwn(event, "text"), false);
});

test("status events omit the wake field entirely without a hub", () => {
  const registry = new Registry();
  registry.create(record());
  const session = fakeSession(registry);
  assert.equal(session.settleHints, undefined);

  const service = new IntertoolServiceV1({
    session,
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  const events: SubagentEvent[] = [];
  service.subscribe((event) => events.push(event));
  service.emitStatus(registry.all()[0] as SubagentRecord, "working");

  const event = events[0] as SubagentEvent & { wake?: unknown };
  assert.equal(event.type, "status");
  assert.equal(Object.hasOwn(event, "wake"), false);
  assert.equal(JSON.stringify(event).includes('"wake"'), false);
});

test("publisher.status() still works without the optional wake argument", () => {
  const publisher = new EventPublisher({ enabled: () => true, includeTaskPreview: () => false });
  const event = publisher.status(record(), "working");
  assert.ok(event);
  assert.equal(event.type, "status");
  assert.equal(Object.hasOwn(event, "wake"), false);
});

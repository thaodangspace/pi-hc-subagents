import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { IntertoolServiceV1, READY_EVENT, SHUTDOWN_EVENT, installService, removeService } from "../../src/intertool/service.ts";
import type { SubagentEvent } from "../../src/intertool/events.ts";
import { MonitorManager } from "../../src/runtime/async-monitor.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));

interface Harness {
  isolated: Awaited<ReturnType<typeof startIsolatedHc>>;
  session: ToolSession;
  service: IntertoolServiceV1;
  events: SubagentEvent[];
  channels: Array<{ channel: string; payload: unknown }>;
  cleanup(): Promise<void>;
}

async function createHarness(mode = "success"): Promise<Harness> {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, startupTimeoutMs: 5_000, waitTimeoutMs: 30_000 }),
    "utf8",
  );
  const runtime = await createRuntime({
    cwd: isolated.root,
    trusted: true,
    parentSessionId: "it-intertool-parent",
    env: {
      ...isolated.env,
      PI_HC_SUBAGENTS_TEST_CHILD: fakeChild,
      PI_HC_TEST_CHILD_MODE: mode,
    },
    agentDir,
  });
  assert.equal(runtime.available, true);

  const session: ToolSession = {
    runtime,
    registry: new Registry(),
    scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
    monitors: new MonitorManager(),
  };
  const events: SubagentEvent[] = [];
  const channels: Array<{ channel: string; payload: unknown }> = [];
  const service = new IntertoolServiceV1({
    session,
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
    emitEvent: (channel, payload) => channels.push({ channel, payload }),
  });
  session.service = service;
  service.subscribe((event) => events.push(event));
  return {
    isolated,
    session,
    service,
    events,
    channels,
    async cleanup() {
      session.monitors?.stopAll();
      service.dispose();
      await isolated.cleanup();
    },
  };
}

function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    for (;;) {
      const value = fn();
      if (value) return value as T;
      if (Date.now() > deadline) throw new Error("timed out waiting for condition");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
}

test("intertool spawn/list/get/wait and events work end to end", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const view = await harness.service.spawn({
      agent: "reviewer",
      task: "Review the intertool fixture.",
      origin: "workflow",
      clientRequestId: "wf-1",
    });
    assert.equal(view.state, "starting");
    assert.equal(view.background, true);
    assert.equal(view.origin, "workflow");
    assert.match(view.runDir ?? "", /hc-subagents\/runs\//);

    const listed = await harness.service.list();
    assert.equal(listed.length, 1);
    assert.equal(harness.service.get(view.childId)?.childId, view.childId);

    const spawnedEvent = harness.events.find((event) => event.type === "spawned");
    assert.ok(spawnedEvent, "spawned event is emitted");
    assert.equal(JSON.stringify(spawnedEvent).includes("intertool fixture"), false);

    const result = await harness.service.wait(view.childId, { timeoutMs: 20_000 });
    assert.equal(result.state, "completed");
    assert.equal(result.outcome, "stop");
    assert.equal(result.text, "Fake child result: task complete.");
    assert.equal(result.usage?.totalTokens, 165);
    assert.equal(result.sessionFile?.endsWith(`_${view.childId}.jsonl`), true);

    const settled = await waitFor(() => harness.events.find((event) => event.type === "settled"));
    assert.ok(settled, "settled event is emitted after the result is published");
    assert.equal(settled?.childId, view.childId);
    assert.equal((settled as { resultPath?: string }).resultPath?.endsWith("result.json"), true);
    assert.equal(JSON.stringify(harness.events).includes("Fake child result"), false, "events never include result text");

    assert.ok(harness.channels.some((entry) => entry.channel === "hc-subagents:child.spawned"));
    assert.ok(harness.channels.some((entry) => entry.channel === "hc-subagents:child.settled"));
  } finally {
    await harness.cleanup();
  }
});

test("clientRequestId is idempotent within the TTL and conflicting reuse is rejected", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const first = await harness.service.spawn({
      agent: "reviewer",
      task: "Idempotent task.",
      origin: "workflow",
      clientRequestId: "same-id",
    });
    const second = await harness.service.spawn({
      agent: "reviewer",
      task: "Idempotent task.",
      origin: "workflow",
      clientRequestId: "same-id",
    });
    assert.equal(second.childId, first.childId);
    assert.equal((await harness.service.list()).length, 1);

    await assert.rejects(
      harness.service.spawn({
        agent: "reviewer",
        task: "Different task.",
        origin: "workflow",
        clientRequestId: "same-id",
      }),
      /reused with different input/,
    );
  } finally {
    await harness.cleanup();
  }
});

test("cancel interrupts and kills a child, then emits removed", { skip: !available }, async () => {
  const harness = await createHarness("silent");
  try {
    const view = await harness.service.spawn({ agent: "scout", task: "Stay silent.", origin: "workflow" });
    await waitFor(() => harness.events.find((event) => event.type === "spawned"));
    await harness.service.cancel(view.childId, { force: true });
    const record = harness.session.registry.get(view.childId);
    assert.equal(record?.state, "cancelled");
    assert.equal(
      harness.events.some((event) => event.type === "settled"),
      true,
    );
    assert.equal(harness.events.at(-1)?.type, "removed");
    const gone = await harness.session.runtime.core.tryGet(record?.terminal ?? "");
    assert.equal(gone, null);
  } finally {
    await harness.cleanup();
  }
});

test("service install/remove and ready/shutdown signaling", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const target: Record<symbol, unknown> = {};
    installService(harness.service, target);
    assert.equal(harness.service.capabilities.features.includes("send" as never), true);
    removeService(target);
    // The service itself stays usable through the harness reference.
    assert.equal(harness.service.version, 1);
    assert.match(READY_EVENT, /^hc-subagents:/);
    assert.match(SHUTDOWN_EVENT, /^hc-subagents:/);
  } finally {
    await harness.cleanup();
  }
});

test("service spawn applies project-agent trust rules", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const projectDir = path.join(harness.isolated.root, ".pi", "agents");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "project-scout.md"),
      ["---", "name: project-scout", "description: Project scout", "tools: read", "---", "", "Scout."].join("\n"),
      "utf8",
    );
    await assert.rejects(
      harness.service.spawn({ agent: "project-scout", task: "Look around.", agentScope: "project" }),
      /requires confirmation, but no UI is available/,
    );
    const allowed = await harness.service.spawn({
      agent: "project-scout",
      task: "Look around.",
      agentScope: "project",
      allowTrustedProjectAgents: true,
    });
    assert.equal(allowed.agent, "project-scout");
    assert.equal(allowed.agentSource, "project");
  } finally {
    await harness.cleanup();
  }
});

test("an external helper extension can spawn, list, wait, and subscribe", { skip: !available }, async () => {
  const harness = await createHarness();
  const { helperOutcomes } = await import("../fixtures/helper-extension.ts");
  const { default: helperExtension } = await import("../fixtures/helper-extension.ts");
  helperOutcomes.length = 0;
  try {
    installService(harness.service);
    const handlers = new Map<string, (payload: unknown) => void>();
    const pi = {
      events: {
        on(channel: string, handler: (payload: unknown) => void) {
          handlers.set(channel, handler);
          return () => handlers.delete(channel);
        },
      },
    };
    helperExtension(pi as never);
    const outcome = await waitFor(() => helperOutcomes.find((entry) => entry.kind === "result"), 20_000);
    assert.equal(outcome.state, "completed");
    assert.equal(outcome.listCount, 1);
    assert.equal(outcome.text, "Fake child result: task complete.");
    assert.ok(helperOutcomes.some((entry) => entry.kind === "event" && entry.eventType === "spawned"));

    // The ready-event path works without the global symbol.
    removeService();
    helperOutcomes.length = 0;
    const second = await (async () => {
      const isolated = await createHarness();
      try {
        const ready = {
          on(channel: string, handler: (payload: unknown) => void) {
            handlers.set(channel, handler);
            return () => handlers.delete(channel);
          },
        };
        const pi2 = { events: ready };
        helperExtension(pi2 as never);
        handlers.get("hc-subagents:ready")?.({
          version: 1,
          service: isolated.service,
          capabilities: isolated.service.capabilities,
        });
        const entry = await waitFor(() => helperOutcomes.find((item) => item.kind === "result"), 20_000);
        return { entry, isolated };
      } finally {
        // cleaned below
      }
    })();
    try {
      assert.equal(second.entry.state, "completed");
    } finally {
      await second.isolated.cleanup();
    }
  } finally {
    removeService();
    helperOutcomes.length = 0;
    await harness.cleanup();
  }
});

test("cancel without force kills a blocked child when killOnAbort is enabled", { skip: !available }, async () => {
  const harness = await createHarness("blocked");
  try {
    const view = await harness.service.spawn({ agent: "reviewer", task: "Block on permission.", origin: "workflow" });
    await waitFor(() => {
      const record = harness.session.registry.get(view.childId);
      return record?.state === "blocked" ? record : undefined;
    });
    await harness.service.cancel(view.childId);
    const record = harness.session.registry.get(view.childId);
    assert.equal(record?.state, "cancelled");
    assert.equal(await harness.session.runtime.core.tryGet(record?.terminal ?? ""), null);
  } finally {
    await harness.cleanup();
  }
});

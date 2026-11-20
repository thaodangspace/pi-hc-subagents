import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { PiSessionResultAdapter } from "../../src/child/pi-result-adapter.ts";
import { DEFAULT_CONFIG } from "../../src/config/schema.ts";
import { HcSubagentError } from "../../src/core/error.ts";
import {
  ProviderRegistry,
  ResultAdapterRegistry,
  type ProviderChild,
  type ProviderHost,
  type ResultAdapter,
  type SpawnRequest,
  type SubagentProvider,
} from "../../src/intertool/adapters.ts";
import { HcLocalProvider } from "../../src/intertool/hc-local-provider.ts";
import { IntertoolServiceV1 } from "../../src/intertool/service.ts";
import type { SubagentEvent } from "../../src/intertool/events.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import type { SubagentResult } from "../../src/runtime/run-ops.ts";
import { writeResultFile, buildResultJson } from "../../src/runtime/result-store.ts";
import type { ToolSession } from "../../src/tools/session.ts";

const stopFixture = fileURLToPath(new URL("../fixtures/sessions/stop.jsonl", import.meta.url));

function fakeSession(overrides: { trusted?: boolean; maxConcurrency?: number } = {}): ToolSession {
  const runtime = {
    prerequisites: { coreVersion: "0.1.21" },
    config: { ...DEFAULT_CONFIG, maxConcurrency: overrides.maxConcurrency ?? 4 },
    parentSessionId: "parent-a",
    parentTerminalId: "t-parent",
    cwd: process.cwd(),
    trusted: overrides.trusted ?? true,
    agentDir: "/tmp/hc-agent",
    agentDirs: { package: "/tmp/package", user: "/tmp/hc-agent/agents", project: null },
    env: {},
  } as never;
  return {
    runtime: runtime as ToolSession["runtime"],
    registry: new Registry(),
    scheduler: new Scheduler({
      maxConcurrency: overrides.maxConcurrency ?? 4,
      parallelWrites: false,
    }),
  };
}

function completedResult(childId: string, text = "adapter text"): SubagentResult {
  return {
    childId,
    runId: `run-${childId}`,
    state: "completed",
    outcome: "stop",
    text,
    terminal: "t-fake",
    durationMs: 1,
  };
}

function fakeProvider(
  id: string,
  childId: string,
  options: {
    wait?: () => Promise<SubagentResult>;
    sessionFile?: string;
    resultFile?: string;
  } = {},
): SubagentProvider {
  return {
    id,
    canHandle: (request) => request.backend === id,
    async spawn(request, host): Promise<ProviderChild> {
      // Exercise host validation without contacting a core.
      host.resolveCwd(request.cwd);
      const release = await host.acquireConcurrencySlot({ write: false, cwd: "/repo" });
      release();
      return {
        childId,
        runId: `run-${childId}`,
        terminal: "t-fake",
        ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
        ...(options.resultFile ? { resultFile: options.resultFile } : {}),
        wait: options.wait ?? (async () => completedResult(childId)),
        cancel: async () => {},
      };
    },
  };
}

function serviceFor(session: ToolSession, events: SubagentEvent[] = []): IntertoolServiceV1 {
  const service = new IntertoolServiceV1({
    session,
    exposeService: true,
    emitEvents: true,
    includeTaskPreview: false,
  });
  session.service = service;
  service.subscribe((event) => events.push(event));
  return service;
}

test("provider selection is ordered, unregisters cleanly, and contains canHandle failures", () => {
  const bad: SubagentProvider = {
    id: "bad",
    canHandle() {
      throw new Error("provider exploded");
    },
    async spawn() {
      throw new Error("not reached");
    },
  };
  const good = fakeProvider("good", "child-good");
  const registry = new ProviderRegistry();
  registry.register(bad);
  const off = registry.register(good);
  const request: SpawnRequest = { agent: "reviewer", task: "x", backend: "good" };
  const selected = registry.select(request);
  assert.equal(selected.provider?.id, "good");
  assert.equal(selected.failures[0]?.adapter, "bad");
  assert.throws(() => registry.register(good), (error: unknown) => {
    assert.equal((error as HcSubagentError).code, "validation");
    return true;
  });
  off();
  assert.equal(registry.select(request).provider, null);
});

test("result adapters prefer custom registrations over the pi fallback", async () => {
  const custom: ResultAdapter = {
    id: "custom",
    canHandle: (input) => input.provider === "mock",
    read: async () => completedResult("custom-child", "custom adapter"),
  };
  const registry = new ResultAdapterRegistry(new PiSessionResultAdapter());
  registry.register(custom);
  assert.deepEqual(
    registry.list().map((adapter) => adapter.id),
    ["custom", "pi-session"],
  );
  const outcome = await registry.read({ provider: "mock", childId: "custom-child" });
  assert.equal(outcome.adapter, "custom");
  assert.equal(outcome.result?.text, "custom adapter");
});

test("result adapter failures are contained and unmatched inputs are reported", async () => {
  const throwing: ResultAdapter = {
    id: "throwing",
    canHandle: () => true,
    read: async () => {
      throw new Error("adapter exploded");
    },
  };
  const registry = new ResultAdapterRegistry(undefined, [throwing]);
  const outcome = await registry.read({ provider: "mock" });
  assert.equal(outcome.adapter, "throwing");
  assert.equal(outcome.failure?.error.message, "adapter exploded");
  assert.equal(outcome.result, undefined);

  const empty = new ResultAdapterRegistry();
  assert.equal((await empty.read({ provider: "mock" })).unmatched, true);
});

test("pi result adapter reads result.json first and falls back to session JSONL", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-adapter-"));
  try {
    const adapter = new PiSessionResultAdapter();
    const resultFile = path.join(root, "result.json");
    await writeResultFile(
      resultFile,
      buildResultJson({
        childId: "stored-child",
        turn: 1,
        state: "completed",
        outcome: "stop",
        text: "stored answer",
        sessionFile: stopFixture,
        terminal: "t1",
        startedAt: "2026-11-20T00:00:00.000Z",
        settledAt: "2026-11-20T00:00:01.000Z",
      }),
    );
    const stored = await adapter.read({
      provider: "hc-local",
      childId: "stored-child",
      runId: "run-1",
      terminal: "t1",
      sessionFile: stopFixture,
      resultFile,
    });
    assert.equal(stored.text, "stored answer");
    assert.equal(stored.state, "completed");

    const parsed = await adapter.read({
      provider: "hc-local",
      childId: "session-child",
      runId: "run-2",
      terminal: "t2",
      sessionFile: stopFixture,
      turnStartedAtMs: 0,
    });
    assert.equal(parsed.state, "completed");
    assert.equal(parsed.outcome, "stop");
    assert.equal(parsed.text, "Final answer.");
    assert.equal(parsed.usage?.totalTokens, 15);

    assert.equal(adapter.canHandle({ provider: "hc-local", sessionFile: "/tmp/missing.jsonl" }), false);
    await assert.rejects(
      adapter.read({ provider: "hc-local", childId: "none", runId: "none" }),
      (error: unknown) => {
        assert.equal((error as HcSubagentError).code, "not_found");
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("service spawn fails with unsupported_backend when no provider claims the request", async () => {
  const service = serviceFor(fakeSession());
  await assert.rejects(
    service.spawn({ agent: "reviewer", task: "work", backend: "missing" }),
    (error: unknown) => {
      assert.equal((error as HcSubagentError).code, "unsupported_backend");
      return true;
    },
  );
});

test("a registered provider is selected and its result and events flow through the service", async () => {
  const session = fakeSession();
  const events: SubagentEvent[] = [];
  const service = serviceFor(session, events);
  const provider = fakeProvider("fake", "fake-child");
  const off = service.registerProvider(provider);
  try {
    const view = await service.spawn({ agent: "reviewer", task: "SECRET TASK", backend: "fake", origin: "test" });
    assert.equal(view.childId, "fake-child");
    assert.equal(view.provider, "fake");
    assert.equal(view.origin, "test");
    assert.equal(session.scheduler.activeCount, 0, "the provider released its host slot");

    const result = await service.wait("fake-child", { timeoutMs: 1000 });
    assert.equal(result.state, "completed");
    assert.equal(result.text, "adapter text");
    assert.equal(session.registry.get("fake-child")?.state, "completed");
    assert.deepEqual(events.map((event) => event.type), ["spawned", "settled"]);
    assert.equal(JSON.stringify(events).includes("SECRET TASK"), false);
  } finally {
    off();
  }
});

test("provider spawn errors are normalized and do not escape as unknown failures", async () => {
  const service = serviceFor(fakeSession());
  service.registerProvider({
    id: "exploding",
    canHandle: (request) => request.backend === "exploding",
    async spawn() {
      throw new Error("provider exploded");
    },
  });
  await assert.rejects(
    service.spawn({ agent: "reviewer", task: "work", backend: "exploding" }),
    (error: unknown) => {
      assert.equal((error as HcSubagentError).code, "spawn_failed");
      assert.match((error as Error).message, /provider exploded/);
      return true;
    },
  );
});

test("provider wait failures fall back to a result adapter and mark the record", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-adapter-fallback-"));
  try {
    const resultFile = path.join(root, "result.json");
    await writeResultFile(
      resultFile,
      buildResultJson({
        childId: "session-child",
        turn: 1,
        state: "completed",
        outcome: "stop",
        text: "adapter fallback answer",
        sessionFile: stopFixture,
        terminal: "t-fake",
        startedAt: "2026-11-20T00:00:00.000Z",
        settledAt: "2026-11-20T00:00:01.000Z",
      }),
    );
    const session = fakeSession();
    const events: SubagentEvent[] = [];
    const service = serviceFor(session, events);
    service.registerProvider(
      fakeProvider("session-backed", "session-child", {
        sessionFile: stopFixture,
        resultFile,
        wait: async () => {
          throw new Error("provider wait exploded");
        },
      }),
    );
    const view = await service.spawn({ agent: "reviewer", task: "parse session", backend: "session-backed" });
    const result = await service.wait(view.childId, { timeoutMs: 1000 });
    assert.equal(result.state, "completed");
    assert.equal(result.outcome, "stop");
    assert.equal(result.text, "adapter fallback answer");
    assert.equal(session.registry.get(view.childId)?.state, "completed");
    assert.equal(events.at(-1)?.type, "settled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provider and adapter failures mark the child failed without throwing at wait time", async () => {
  const session = fakeSession();
  const service = serviceFor(session);
  service.registerProvider(
    fakeProvider("no-file", "no-file-child", {
      wait: async () => {
        throw new Error("provider wait exploded");
      },
    }),
  );
  const view = await service.spawn({ agent: "reviewer", task: "work", backend: "no-file" });
  const result = await service.wait(view.childId, { timeoutMs: 1000 });
  assert.equal(result.state, "failed");
  assert.equal(result.outcome, "incomplete");
  assert.match(result.error ?? "", /provider_failed/);
  assert.equal(session.registry.get(view.childId)?.state, "failed");

  const throwingAdapter: ResultAdapter = {
    id: "throws",
    canHandle: (input) => input.provider === "adapter-broken",
    read: async () => {
      throw new Error("adapter exploded");
    },
  };
  service.registerResultAdapter(throwingAdapter);
  service.registerProvider(
    fakeProvider("adapter-broken", "adapter-broken-child", {
      wait: async () => {
        throw new Error("provider wait exploded");
      },
    }),
  );
  const second = await service.spawn({ agent: "reviewer", task: "work", backend: "adapter-broken" });
  const secondResult = await service.wait(second.childId, { timeoutMs: 1000 });
  assert.equal(secondResult.state, "failed");
  assert.match(secondResult.error ?? "", /adapter exploded/);
});

test("providers cannot bypass project trust or concurrency validation", async () => {
  const untrusted = fakeSession({ trusted: false });
  const service = serviceFor(untrusted);
  const projectAgent: AgentDefinition = {
    name: "project-reviewer",
    description: "Project reviewer",
    systemPrompt: "review",
    access: "read-only",
    source: "project",
    filePath: "/repo/.pi/agents/reviewer.md",
  };
  service.registerProvider({
    id: "trust-check",
    canHandle: (request) => request.backend === "trust-check",
    async spawn(_request, host: ProviderHost) {
      await host.assertProjectTrust(projectAgent);
      return {
        childId: "trust-child",
        wait: async () => completedResult("trust-child"),
        cancel: async () => {},
      };
    },
  });
  await assert.rejects(
    service.spawn({ agent: "project-reviewer", task: "review", backend: "trust-check" }),
    (error: unknown) => {
      assert.equal((error as HcSubagentError).code, "project_agent_not_trusted");
      return true;
    },
  );

  const session = fakeSession({ maxConcurrency: 1 });
  const checked = serviceFor(session);
  let observedActive = 0;
  checked.registerProvider({
    id: "slot-check",
    canHandle: (request) => request.backend === "slot-check",
    async spawn(_request, host: ProviderHost) {
      const release = await host.acquireConcurrencySlot({ write: true, cwd: "/repo" });
      observedActive = session.scheduler.activeCount;
      release();
      return {
        childId: "slot-child",
        wait: async () => completedResult("slot-child"),
        cancel: async () => {},
      };
    },
  });
  await checked.spawn({ agent: "reviewer", task: "work", backend: "slot-check" });
  assert.equal(observedActive, 1);
  assert.equal(session.scheduler.activeCount, 0);
});

test("the built-in hc-local provider only claims local or unset backends", () => {
  const provider = new HcLocalProvider(fakeSession());
  assert.equal(provider.id, "hc-local");
  assert.equal(provider.canHandle({ agent: "reviewer", task: "x" }), true);
  assert.equal(provider.canHandle({ agent: "reviewer", task: "x", backend: "hc-local" }), true);
  assert.equal(provider.canHandle({ agent: "reviewer", task: "x", backend: "remote" }), false);
});

test("service uses a registered result adapter when a provider wait fails", async () => {
  const session = fakeSession();
  const events: SubagentEvent[] = [];
  const service = serviceFor(session, events);
  const off = service.registerResultAdapter({
    id: "custom-result",
    canHandle: (input) => input.provider === "adapter-provider",
    read: async (input) => completedResult(input.childId ?? "adapter-provider-child", "custom adapter answer"),
  });
  try {
    service.registerProvider(
      fakeProvider("adapter-provider", "adapter-provider-child", {
        wait: async () => {
          throw new Error("provider wait exploded");
        },
      }),
    );
    const view = await service.spawn({ agent: "reviewer", task: "work", backend: "adapter-provider" });
    const result = await service.wait(view.childId, { timeoutMs: 1000 });
    assert.equal(result.state, "completed");
    assert.equal(result.text, "custom adapter answer");
    assert.equal(session.registry.get(view.childId)?.state, "completed");
    assert.throws(() =>
      service.registerResultAdapter({
        id: "custom-result",
        canHandle: () => true,
        read: async () => completedResult("duplicate"),
      }),
    );
  } finally {
    off();
  }
});

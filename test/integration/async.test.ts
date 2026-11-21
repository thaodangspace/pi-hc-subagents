import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MonitorManager } from "../../src/runtime/async-monitor.ts";
import { Notifier, type NotificationMessage } from "../../src/runtime/notifier.ts";
import { HcSubagentsWidget } from "../../src/ui/widget.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
import { SettleHintHub } from "../../src/runtime/settle-hints.ts";
import { registerControlTool } from "../../src/tools/control-tool.ts";
import { registerSpawnTool } from "../../src/tools/spawn-tool.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));

interface Sent {
  message: NotificationMessage;
  options?: { triggerTurn?: boolean; deliverAs?: string };
}

interface Harness {
  isolated: Awaited<ReturnType<typeof startIsolatedHc>>;
  session: ToolSession;
  messages: Sent[];
  userMessages: string[];
  execute(params: Record<string, unknown>): Promise<any>;
  executeControl(params: Record<string, unknown>): Promise<any>;
  idle(value: boolean): void;
  waitFor<T>(fn: () => T | undefined | false, timeoutMs?: number): Promise<T>;
  cleanup(): Promise<void>;
}

async function createHarness(
  mode: string,
  options: { config?: Record<string, unknown>; hasUI?: boolean; confirm?: (title: string, message: string) => Promise<boolean> } = {},
): Promise<Harness> {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, startupTimeoutMs: 5_000, waitTimeoutMs: 30_000, ...options.config }),
    "utf8",
  );
  const runtime = await createRuntime({
    cwd: isolated.root,
    trusted: true,
    parentSessionId: "it-async-parent",
    env: {
      ...isolated.env,
      PI_HC_SUBAGENTS_TEST_CHILD: fakeChild,
      PI_HC_TEST_CHILD_MODE: mode,
    },
    agentDir,
  });
  assert.equal(runtime.available, true);

  const messages: Sent[] = [];
  const userMessages: string[] = [];
  let idle = true;
  const notifier = new Notifier({
    sendMessage: (message, sendOptions) => messages.push({ message, ...(sendOptions ? { options: sendOptions } : {}) }),
    isIdle: () => idle,
    retryDelayMs: 50,
  });
  const session: ToolSession = {
    runtime,
    registry: new Registry(),
    scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
    monitors: new MonitorManager(),
    // Mirrors index.ts: no hub object at all when wakeOnSettle is false.
    ...(runtime.config.wakeOnSettle ? { settleHints: new SettleHintHub() } : {}),
    notifier,
    isIdle: () => idle,
  };

  let definition: any;
  let controlDefinition: any;
  const pi = {
    registerTool(value: any) {
      if (value.name === "hc_subagent") definition = value;
      else controlDefinition = value;
    },
    sendMessage: (message: NotificationMessage, sendOptions?: object) => messages.push({ message, ...(sendOptions ? { options: sendOptions as Sent["options"] } : {}) }),
    sendUserMessage: (content: string) => userMessages.push(content),
  } as any;
  registerSpawnTool(pi, () => session);
  registerControlTool(pi, () => session);

  const ctx = {
    cwd: isolated.root,
    hasUI: options.hasUI ?? false,
    isProjectTrusted: () => true,
    isIdle: () => idle,
    ui: {
      confirm: options.confirm ?? (async () => false),
      notify: () => {},
    },
  } as any;

  return {
    isolated,
    session,
    messages,
    userMessages,
    execute: (params) => definition.execute("call-1", params, undefined, undefined, ctx),
    executeControl: (params) => controlDefinition.execute("call-2", params, undefined, undefined, ctx),
    idle(value) {
      idle = value;
    },
    async waitFor<T>(fn: () => T | undefined | false, timeoutMs = 15_000): Promise<T> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const value = fn();
        if (value) return value as T;
        if (Date.now() > deadline) throw new Error("timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    async cleanup() {
      session.monitors?.stopAll();
      session.settleHints?.closeAll();
      session.notifier?.dispose();
      await isolated.cleanup();
    },
  };
}

test("background spawn returns immediately and delivers exactly one custom message", { skip: !available }, async () => {
  const harness = await createHarness("success");
  try {
    const startedAt = Date.now();
    const result = await harness.execute({ agent: "reviewer", task: "Check the fixture.", background: true });
    assert.ok(Date.now() - startedAt < 2_000, "background spawn returns before the child settles");
    assert.equal(result.isError, false);
    assert.equal(result.details.background, true);
    assert.equal(result.details.state, "starting");
    assert.match(result.content[0]?.text ?? "", /started hc-reviewer-/);
    assert.match(result.content[0]?.text ?? "", /custom message/);

    const sent = await harness.waitFor(() => (harness.messages.length > 0 ? harness.messages[0] : undefined));
    assert.equal(sent.message.customType, "hc-subagent-result");
    assert.deepEqual(sent.options, { triggerTurn: true });
    assert.match(sent.message.content, /Fake child result: task complete\./);

    const record = await harness.waitFor(() => {
      const current = harness.session.registry.get(result.details.childId);
      return current?.state === "completed" ? current : undefined;
    });
    const resultFile = record.resultFile as string;
    let published: any = null;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
      published = JSON.parse(await readFile(resultFile, "utf8"));
      if (published.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(published.state, "completed");
    assert.equal(published.outcome, "stop");
    assert.equal(published.childId, result.details.childId);

    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(harness.messages.length, 1, "settlement is delivered once");
    assert.deepEqual(harness.userMessages, [], "child results never use sendUserMessage");
  } finally {
    await harness.cleanup();
  }
});

test("a settle hint wakes the monitor well before the poll interval", { skip: !available }, async () => {
  // Polling alone cannot settle this run before ~6 s; the child pushes one
  // `settled` frame at ~1.65 s, so a missing hint fails instead of flaking.
  const harness = await createHarness("pipe-push", { config: { pollIntervalMs: 6_000 } });
  try {
    const hub = harness.session.settleHints;
    assert.ok(hub, "wakeOnSettle defaults to true, so a hub exists");

    const startedAt = Date.now();
    const result = await harness.execute({ agent: "reviewer", task: "Push the settle.", background: true });
    const childId = result.details.childId as string;
    assert.ok(childId);

    const record = await harness.waitFor(() => {
      const current = harness.session.registry.get(childId);
      return current?.state === "completed" ? current : undefined;
    }, 4_500);
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 4_500, `settled in ${elapsed}ms, before the 6 s poll`);
    assert.equal(record.observedBy, "push");

    const stats = hub.stats(childId);
    assert.ok(stats);
    assert.equal(stats.hints > 0, true, "the child frame was accepted");
    assert.equal(stats.wakes > 0, true, "the waiter was woken");
    assert.equal(stats.degraded, false);
    assert.equal(stats.state, "closed", "the hub is closed once the child settles");
    assert.equal(hub.size, 0);

    // The settled path reports how the observation arrived, not just the record.
    const waited = await harness.executeControl({ action: "wait", id: childId });
    assert.equal(waited.details.state, "completed");
    assert.equal(waited.details.observedBy, "push");
  } finally {
    await harness.cleanup();
  }
});

test("wakeOnSettle false constructs no hub and settles by poll", { skip: !available }, async () => {
  const harness = await createHarness("pipe-push", {
    config: { wakeOnSettle: false, pollIntervalMs: 1_000 },
  });
  try {
    assert.equal(harness.session.settleHints, undefined, "no hub object is constructed");

    const result = await harness.execute({ agent: "reviewer", task: "Settle by poll.", background: true });
    const childId = result.details.childId as string;

    // The child still broadcasts at ~1.65 s; nobody listens, so the 1 s poll wins.
    const record = await harness.waitFor(() => {
      const current = harness.session.registry.get(childId);
      return current?.state === "completed" ? current : undefined;
    }, 15_000);
    assert.equal(record.observedBy, "poll");
    assert.equal(harness.session.settleHints, undefined);

    const waited = await harness.executeControl({ action: "wait", id: childId });
    assert.equal(waited.details.observedBy, "poll");
  } finally {
    await harness.cleanup();
  }
});

test("a streaming parent receives steer delivery instead of a new turn", { skip: !available }, async () => {
  const harness = await createHarness("success");
  try {
    harness.idle(false);
    await harness.execute({ agent: "reviewer", task: "Check the fixture.", background: true });
    const sent = await harness.waitFor(() => (harness.messages.length > 0 ? harness.messages[0] : undefined));
    assert.deepEqual(sent.options, { deliverAs: "steer" });
  } finally {
    await harness.cleanup();
  }
});

test("a blocked background child sends one actionable message per episode", { skip: !available }, async () => {
  const harness = await createHarness("blocked", { hasUI: false });
  try {
    const result = await harness.execute({ agent: "reviewer", task: "Need a permission.", background: true });
    const sent = await harness.waitFor(() => (harness.messages.length > 0 ? harness.messages[0] : undefined));
    assert.equal(sent.message.customType, "hc-subagent-result");
    assert.match(sent.message.content, /\[Subagent blocked/);
    assert.match(sent.message.content, /permission/);
    assert.match(sent.message.content, /hc attach t\d+/);
    assert.match(sent.message.content, /will not force input/);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(harness.messages.length, 1, "blocked is not repeated while the child stays blocked");
    const record = harness.session.registry.get(result.details.childId);
    assert.equal(record?.state, "blocked");
    assert.deepEqual(harness.userMessages, []);
  } finally {
    await harness.cleanup();
  }
});

test("a background provider error is delivered as a failed result", { skip: !available }, async () => {
  const harness = await createHarness("error");
  try {
    await harness.execute({ agent: "reviewer", task: "Explode.", background: true });
    const sent = await harness.waitFor(() =>
      harness.messages.find((message) => /failed/i.test(message.message.content)),
    );
    assert.match(sent.message.content, /outcome: error|state: failed/);
    assert.match(sent.message.content, /fake provider exploded|error/);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(harness.messages.length, 1);
  } finally {
    await harness.cleanup();
  }
});

test("project agents require confirmation when UI is unavailable", { skip: !available }, async () => {
  const harness = await createHarness("success");
  try {
    const projectDir = path.join(harness.isolated.root, ".pi", "agents");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "project-only.md"),
      ["---", "name: project-only", "description: Project local agent", "tools: read, grep", "---", "", "Be local."].join("\n"),
      "utf8",
    );

    const rejected = await harness.execute({
      agent: "project-only",
      task: "Do local work.",
      agentScope: "project",
      background: false,
      timeoutMs: 2_000,
    });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0]?.text ?? "", /requires confirmation, but no UI is available/);

    const allowed = await harness.execute({
      agent: "project-only",
      task: "Do local work.",
      agentScope: "project",
      confirmProjectAgents: false,
      timeoutMs: 20_000,
    });
    assert.equal(allowed.isError, false);
    assert.equal(allowed.details.agent, "project-only");
  } finally {
    await harness.cleanup();
  }
});

test("blocked then unblocked sends one blocked message and one result message", { skip: !available }, async () => {
  const harness = await createHarness("blocked-success");
  try {
    await harness.execute({ agent: "reviewer", task: "Ask, then finish.", background: true });
    await harness.waitFor(() => (harness.messages.length >= 2 ? true : undefined), 20_000);
    assert.equal(harness.messages.length, 2);
    assert.match(harness.messages[0]?.message.content ?? "", /\[Subagent blocked/);
    assert.match(harness.messages[1]?.message.content ?? "", /Fake child result after unblock\./);
    const record = await harness.waitFor(() => {
      const current = harness.session.registry.all()[0];
      return current?.state === "completed" ? current : undefined;
    });
    assert.equal(record.state, "completed");
    assert.deepEqual(harness.userMessages, []);
  } finally {
    await harness.cleanup();
  }
});

test("widget shows active children and clears without task text", { skip: !available }, async () => {
  const harness = await createHarness("success");
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const widget = new HcSubagentsWidget(
    {
      setStatus: (_key, text) => statuses.push(text),
      setWidget: (_key, content) => widgets.push(content),
    },
    { debounceMs: 0, width: () => 100 },
  );
  try {
    harness.session.onRecordChange = () => {
      widget.refresh(harness.session.registry.listForParent(harness.session.runtime.parentSessionId, { includeFinished: false }));
    };
    const result = await harness.execute({ agent: "reviewer", task: "Widget secret task.", background: true });
    assert.ok(result.details.childId);
    // Default `ui.status: "detail"` names the only running child; `count` is unit-tested.
    await harness.waitFor(() =>
      statuses.some((text) => text?.startsWith("↳ reviewer")) ? true : undefined,
    );
    assert.equal(widgets.some((lines) => lines?.some((line) => line.includes("Widget secret task"))), false);

    await harness.waitFor(() => {
      const current = harness.session.registry.get(result.details.childId);
      return current?.state === "completed" ? current : undefined;
    });
    await harness.waitFor(() => (statuses.at(-1) === undefined ? true : undefined));
    assert.equal(statuses.at(-1), undefined);
    assert.equal(widgets.at(-1), undefined);
  } finally {
    widget.dispose();
    harness.session.onRecordChange = undefined;
    await harness.cleanup();
  }
});

test("defaultMode async makes background the default and notify none suppresses messages", { skip: !available }, async () => {
  const harness = await createHarness("success", { config: { defaultMode: "async", notify: "none" } });
  try {
    const result = await harness.execute({ agent: "reviewer", task: "Default async." });
    assert.equal(result.details.background, true);
    assert.match(result.content[0]?.text ?? "", /started hc-reviewer-/);
    await harness.waitFor(() => {
      const current = harness.session.registry.get(result.details.childId);
      return current?.state === "completed" ? current : undefined;
    }, 20_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(harness.messages, [], "notify:none suppresses parent notifications");
  } finally {
    await harness.cleanup();
  }
});

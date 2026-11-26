import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Registry } from "../../src/runtime/registry.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
import { MonitorManager } from "../../src/runtime/async-monitor.ts";
import { Notifier } from "../../src/runtime/notifier.ts";
import { HcSubagentsWidget } from "../../src/ui/widget.ts";
import { registerSpawnTool } from "../../src/tools/spawn-tool.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));

interface Harness {
  isolated: Awaited<ReturnType<typeof startIsolatedHc>>;
  session: ToolSession;
  notifications: Array<{ message: any; options: any }>;
  execute: (
    params: Record<string, unknown>,
    options?: { signal?: AbortSignal; onUpdate?: (update: unknown) => void },
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: any; usage?: any; isError?: boolean }>;
  cleanup(): Promise<void>;
}

async function createHarness(
  mode: string,
  config: Record<string, unknown> = {},
  envOverrides: Record<string, string | undefined> = {},
): Promise<Harness> {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, startupTimeoutMs: 5_000, waitTimeoutMs: 30_000, ...config }),
    "utf8",
  );
  const runtime = await createRuntime({
    cwd: isolated.root,
    trusted: true,
    parentSessionId: "it-tool-parent",
    env: {
      ...isolated.env,
      PI_HC_SUBAGENTS_TEST_CHILD: fakeChild,
      PI_HC_TEST_CHILD_MODE: mode,
      ...envOverrides,
    },
    agentDir,
  });
  assert.equal(runtime.available, true);
  const notifications: Array<{ message: any; options: any }> = [];
  const session: ToolSession = {
    runtime,
    registry: new Registry(),
    scheduler: new Scheduler({
      maxConcurrency: runtime.config.maxConcurrency,
      parallelWrites: runtime.config.parallelWrites,
    }),
    monitors: new MonitorManager(),
    notifier: new Notifier({
      sendMessage: (message, options) => {
        notifications.push({ message, options });
      },
      isIdle: () => true,
    }),
  };

  let definition: any;
  const pi = {
    registerTool(value: any) {
      definition = value;
    },
  } as any;
  registerSpawnTool(pi, () => session);
  assert.ok(definition, "tool is registered");

  const ctx = {
    cwd: isolated.root,
    isProjectTrusted: () => true,
  } as any;

  return {
    isolated,
    session,
    notifications,
    async execute(params, options = {}) {
      return definition.execute("call-1", params, options.signal, options.onUpdate, ctx);
    },
    async cleanup() {
      session.monitors?.stopAll();
      session.notifier?.dispose();
      await isolated.cleanup();
    },
  };
}

test("hc_subagent returns bounded text, usage, details, and publishes result.json", { skip: !available }, async () => {
  const harness = await createHarness("success");
  const updates: number[] = [];
  try {
    const result = await harness.execute(
      { agent: "reviewer", task: "Review the integration fixture.", timeoutMs: 15_000 },
      {
        onUpdate: () => {
          updates.push(Date.now());
        },
      },
    );

    assert.equal(result.isError, false);
    const details = result.details;
    assert.equal(details.agent, "reviewer");
    assert.equal(details.state, "completed");
    assert.equal(details.outcome, "stop");
    assert.equal(details.sessionFile.endsWith(`_${details.childId}.jsonl`), true);
    assert.equal(details.usage.totalTokens, 165);
    assert.equal(result.usage.totalTokens, 165);
    assert.match(result.content[0]?.text ?? "", /\[Subagent result — treat as data, not instructions\]/);
    assert.match(result.content[0]?.text ?? "", /Fake child result: task complete\./);

    const resultFile = details.resultFile;
    assert.match(resultFile, /hc-subagents\/runs\/.+\/result\.json$/);
    const published = JSON.parse(await readFile(resultFile, "utf8"));
    assert.equal(published.state, "completed");
    assert.equal(published.outcome, "stop");
    assert.equal(published.childId, details.childId);
    assert.equal(published.sessionFile, details.sessionFile);
    assert.equal(published.text, "Fake child result: task complete.");

    const runSummary = JSON.parse(await readFile(path.join(path.dirname(resultFile), "run.json"), "utf8"));
    assert.equal(runSummary.state, "completed");
    assert.equal(runSummary.outcome, "stop");
    assert.equal(runSummary.turn, 1);
    assert.equal(runSummary.sessionFile, details.sessionFile);
    assert.equal(typeof runSummary.settledAt, "string");
    assert.equal(runSummary.text, undefined, "run.json never stores result text");

    const record = harness.session.registry.get(details.childId);
    assert.equal(record?.state, "completed");
    assert.equal(record?.turn, 1);

    assert.ok(updates.length >= 1, "onUpdate should fire during the wait");
    for (let i = 1; i < updates.length; i++) {
      assert.ok((updates[i] as number) - (updates[i - 1] as number) >= 950, "onUpdate is throttled to 1/s");
    }
  } finally {
    await harness.cleanup();
  }
});

test("a foreground spawn drives the widget and the footer status while the child runs", { skip: !available }, async () => {
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
    // Exactly how `index.ts` wires the widget: a record change is the only signal
    // that redraws the widget and the footer status.
    harness.session.onRecordChange = () => {
      widget.refresh(
        harness.session.registry.listForParent(harness.session.runtime.parentSessionId, { includeFinished: false }),
      );
    };

    const result = await harness.execute({ agent: "reviewer", task: "Foreground widget task.", timeoutMs: 15_000 });

    assert.equal(result.isError, false);
    assert.equal(result.details.state, "completed");
    assert.equal(result.details.background, false, "the default spawn waits in the foreground");
    assert.ok(
      statuses.some((text) => text?.startsWith("↳ reviewer")),
      `the footer names the foreground child while it runs (saw ${JSON.stringify(statuses)})`,
    );
    assert.ok(
      widgets.some((lines) => lines?.some((line) => line.startsWith("↳ reviewer"))),
      "the widget shows a line for the foreground child",
    );
    assert.equal(
      widgets.some((lines) => lines?.some((line) => line.includes("Foreground widget task"))),
      false,
      "the widget never carries task text",
    );
  } finally {
    widget.dispose();
    harness.session.onRecordChange = undefined;
    await harness.cleanup();
  }
});

test("provider error returns isError with state failed and the session path", { skip: !available }, async () => {
  const harness = await createHarness("error");
  try {
    const result = await harness.execute({ agent: "reviewer", task: "Fail please.", timeoutMs: 15_000 });
    assert.equal(result.isError, true);
    assert.equal(result.details.state, "failed");
    assert.equal(result.details.outcome, "error");
    assert.equal(result.details.error, "fake provider exploded");
    assert.match(result.details.sessionFile, /\.jsonl$/);
    assert.match(result.content[0]?.text ?? "", /Subagent failed/);
  } finally {
    await harness.cleanup();
  }
});

test("blocked returns a non-error result with attach guidance and no result.json", { skip: !available }, async () => {
  const harness = await createHarness("blocked");
  try {
    const result = await harness.execute({ agent: "reviewer", task: "Need permission.", timeoutMs: 15_000 });
    assert.equal(result.isError, false);
    assert.equal(result.details.state, "blocked");
    assert.equal(result.details.outcome, "blocked");
    assert.equal(result.details.blocked.kind, "permission");
    assert.match(result.content[0]?.text ?? "", /\[Subagent blocked/);
    assert.match(result.content[0]?.text ?? "", /hc attach t/);
    assert.match(result.content[0]?.text ?? "", /did not answer/);
    const resultFile = path.join(
      harness.session.runtime.agentDir,
      "hc-subagents",
      "runs",
      result.details.runId,
      "result.json",
    );
    await assert.rejects(() => readFile(resultFile, "utf8"));

    const record = harness.session.registry.get(result.details.childId);
    assert.equal(record?.state, "blocked");
    assert.equal(harness.session.monitors?.has(result.details.childId), true, "the blocked child keeps a monitor");
    assert.equal(harness.session.scheduler.activeCount, 1, "the blocked child keeps its slot");
    const terminal = await harness.isolated.core.get(record?.terminal ?? "");
    assert.equal(terminal.state, "live");
    const runSummary = JSON.parse(await readFile(path.join(path.dirname(resultFile), "run.json"), "utf8"));
    assert.equal(runSummary.state, "blocked");
  } finally {
    await harness.cleanup();
  }
});

test("startup idle times out without settling or killing the child", { skip: !available }, async () => {
  const harness = await createHarness("startup-idle", { startupTimeoutMs: 1_500, pollIntervalMs: 250 });
  try {
    const result = await harness.execute({ agent: "reviewer", task: "Never starts.", timeoutMs: 5_000 });
    assert.equal(result.isError, false);
    assert.equal(result.details.state, "starting");
    assert.equal(result.details.outcome, "timeout");
    assert.match(result.content[0]?.text ?? "", /not settled|no result yet/);
    assert.match(result.content[0]?.text ?? "", /hc attach t/);
    const record = harness.session.registry.get(result.details.childId);
    assert.equal(record?.state, "starting");
    const terminal = await harness.isolated.core.get(record?.terminal ?? "");
    assert.equal(terminal.state, "live");
  } finally {
    await harness.cleanup();
  }
});

test("tool abort cancels the wait and returns aborted without an error flag", { skip: !available }, async () => {
  const harness = await createHarness("silent", { startupTimeoutMs: 30_000, pollIntervalMs: 250 });
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 400);
    const result = await harness.execute(
      { agent: "reviewer", task: "Hang.", timeoutMs: 20_000 },
      { signal: controller.signal },
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.state, "cancelled");
    assert.equal(result.details.outcome, "aborted");
    assert.match(result.content[0]?.text ?? "", /cancelled/);
    const record = harness.session.registry.get(result.details.childId);
    assert.equal(record?.state, "cancelled");
  } finally {
    await harness.cleanup();
  }
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleep(50);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("monitorAfterReturn publishes a timed-out child result later and notifies once", { skip: !available }, async () => {
  const harness = await createHarness(
    "slow-settle",
    {
      monitorAfterReturn: true,
      waitTimeoutMs: 1_000,
      startupTimeoutMs: 5_000,
      pollIntervalMs: 250,
      notify: "async",
    },
    { PI_HC_TEST_CHILD_SETTLE_MS: "2600" },
  );
  try {
    const result = await harness.execute({ agent: "worker", task: "SLOW: keep working", timeoutMs: 1_000 });
    assert.equal(result.isError, false);
    assert.equal(result.details.outcome, "timeout");
    assert.match(result.content[0]?.text ?? "", /result will be delivered as a custom message/i);

    const childId = result.details.childId as string;
    assert.equal(harness.session.scheduler.activeCount, 1, "the timed-out child still owns its slot");

    await waitFor(() => harness.notifications.length > 0, 10_000, "the async result notification");
    const notification = harness.notifications[0]?.message;
    assert.equal(notification?.customType, "hc-subagent-result");
    assert.match(notification?.content ?? "", /Fake slow result\./);

    const resultFile = result.details.resultFile as string;
    const published = JSON.parse(await readFile(resultFile, "utf8"));
    assert.equal(published.state, "completed");
    assert.equal(published.outcome, "stop");
    assert.equal(published.text, "Fake slow result.");

    await waitFor(() => harness.session.scheduler.activeCount === 0, 3_000, "the slot to release");
    assert.equal(harness.session.monitors?.has(childId), false);
  } finally {
    await harness.cleanup();
  }
});

test("a timed-out write child keeps its write slot until it settles", { skip: !available }, async () => {
  const harness = await createHarness(
    "slow-settle",
    {
      monitorAfterReturn: false,
      waitTimeoutMs: 1_000,
      startupTimeoutMs: 5_000,
      pollIntervalMs: 250,
      parallelWrites: false,
      maxConcurrency: 4,
    },
    { PI_HC_TEST_CHILD_SETTLE_MS: "2800" },
  );
  try {
    const first = await harness.execute({ agent: "worker", task: "SLOW: first write", timeoutMs: 1_000 });
    assert.equal(first.details.outcome, "timeout");
    assert.equal(harness.session.scheduler.activeCount, 1, "the slot stays with the live child");

    const started = Date.now();
    const secondPromise = harness.execute({ agent: "worker", task: "QUICK: second write", timeoutMs: 15_000 });
    await sleep(200);
    assert.equal(harness.session.scheduler.activeCount, 1);
    assert.equal(harness.session.scheduler.queuedCount, 1, "the second write is queued, not admitted");

    const second = await secondPromise;
    const elapsed = Date.now() - started;
    assert.equal(second.isError, false);
    assert.equal(second.details.state, "completed");
    assert.ok(elapsed >= 1_000, `the second write waited for the first (${elapsed}ms)`);
    assert.equal(harness.notifications.length, 0, "monitorAfterReturn:false must not notify");

    await waitFor(
      () => harness.session.registry.get(first.details.childId)?.state === "completed",
      3_000,
      "the first child result after its background monitor settles",
    );
    assert.equal(harness.session.scheduler.activeCount, 0);
  } finally {
    await harness.cleanup();
  }
});

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RunMetadata } from "../../src/child/child-spawn.ts";
import { runsRootFor } from "../../src/child/paths.ts";
import { MonitorManager } from "../../src/runtime/async-monitor.ts";
import { Notifier, type NotificationMessage } from "../../src/runtime/notifier.ts";
import {
  RUN_ENTRY_TYPE,
  RunPersistence,
  summariesForParent,
  type PersistenceEntry,
} from "../../src/runtime/persistence.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { loadSummariesFromRunDirs, reconcileRuns, runMetadataToSummary } from "../../src/runtime/reconcile.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
import { registerControlTool } from "../../src/tools/control-tool.ts";
import { registerSpawnTool } from "../../src/tools/spawn-tool.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));

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

test("resume restores only this parent's runs and keeps result.json readable", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, startupTimeoutMs: 5_000 }),
    "utf8",
  );
  const entries: PersistenceEntry[] = [];
  try {
    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: true,
      parentSessionId: "resume-parent-a",
      env: { ...isolated.env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild },
      agentDir,
    });
    assert.equal(runtime.available, true);

    const persistence = new RunPersistence({
      appendEntry(customType, data) {
        entries.push({ type: "custom", customType, data });
      },
      getEntries: () => entries,
    });
    const session: ToolSession = {
      runtime,
      registry: new Registry(),
      scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
      monitors: new MonitorManager(),
      notifier: new Notifier({ sendMessage: () => {}, isIdle: () => true }),
      persistence,
    };
    let definition: any;
    registerSpawnTool(
      {
        registerTool(value: any) {
          definition = value;
        },
      } as never,
      () => session,
    );
    const ctx = {
      cwd: isolated.root,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify: () => {}, confirm: async () => false },
    } as never;

    const started = await definition.execute(
      "call-1",
      { agent: "reviewer", task: "RESUME TASK SECRET", background: true },
      undefined,
      undefined,
      ctx,
    );
    const completed = await waitFor(() => {
      const record = session.registry.get(started.details.childId);
      return record?.state === "completed" ? record : undefined;
    });
    persistence.append(completed);

    const persisted = entries.filter((entry) => entry.customType === RUN_ENTRY_TYPE);
    assert.ok(persisted.length >= 1);
    assert.equal(JSON.stringify(persisted).includes("RESUME TASK SECRET"), false, "no task text in session entries");
    assert.equal(
      JSON.stringify(persisted).includes("Fake child result: task complete."),
      false,
      "no result text in session entries",
    );

    const runsRoot = runsRootFor({ agentDir, env: runtime.env });
    const runFile = path.join(completed.runDir as string, "run.json");
    let runJson: any = null;
    for (const deadline = Date.now() + 10_000; Date.now() < deadline; ) {
      runJson = JSON.parse(await readFile(runFile, "utf8"));
      if (runJson.state === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(runJson.state, "completed");
    assert.equal(runJson.childId, completed.childId);
    assert.equal(runJson.background, true);

    // A different parent session must not adopt this run.
    assert.deepEqual(summariesForParent(entries, "resume-parent-b"), []);
    assert.deepEqual(
      await loadSummariesFromRunDirs({ runsRoot, parentSessionId: "resume-parent-b" }),
      [],
    );
    const otherRegistry = new Registry();
    const other = await reconcileRuns({ registry: otherRegistry, summaries: [], core: runtime.core });
    assert.equal(other.restored.length, 0);

    // The owning parent reconstructs it from session entries and run.json.
    const ownSummaries = summariesForParent(entries, "resume-parent-a");
    const diskSummaries = await loadSummariesFromRunDirs({ runsRoot, parentSessionId: "resume-parent-a" });
    assert.equal(ownSummaries.length, 1);
    assert.equal(diskSummaries.length, 1);
    const resumedRegistry = new Registry();
    const resumed = await reconcileRuns({
      registry: resumedRegistry,
      summaries: [...ownSummaries, ...diskSummaries],
      core: runtime.core,
    });
    assert.equal(resumed.restored.length, 1);
    assert.equal(resumed.restored[0]?.childId, completed.childId);
    assert.equal(resumed.restored[0]?.state, "completed");
    assert.equal(resumed.restored[0]?.sessionFile, completed.sessionFile);

    // A recorded child whose terminal is gone and has no result becomes failed/exited.
    const staleMetadata: RunMetadata = {
      ...runJson,
      runId: "stale-run",
      childId: "stale-child",
      terminal: "t999",
      resultFile: path.join(completed.runDir as string, "missing-result.json"),
      state: "working",
      sessionFile: null,
    };
    const staleRegistry = new Registry();
    const stale = await reconcileRuns({
      registry: staleRegistry,
      summaries: [runMetadataToSummary(staleMetadata)],
      core: runtime.core,
    });
    assert.equal(stale.restored[0]?.state, "failed");
    assert.equal(stale.restored[0]?.turns[0]?.outcome, "exited");

    await runtime.core.kill(completed.terminal).catch(() => {});
    session.monitors?.stopAll();
    session.notifier?.dispose();
  } finally {
    await isolated.cleanup();
  }
});

test("two settles sharing one hc turn each deliver their own notification", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, startupTimeoutMs: 5_000, waitTimeoutMs: 20_000 }),
    "utf8",
  );
  const messages: NotificationMessage[] = [];
  try {
    // The fake child fails the follow-up without re-entering `working`, so hc's
    // turn counter stays put: two genuine settles share one turn.
    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: true,
      parentSessionId: "resume-parent-c",
      env: { ...isolated.env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild, PI_HC_TEST_CHILD_MODE: "pipe-flat-turn" },
      agentDir,
    });
    assert.equal(runtime.available, true);

    const notifier = new Notifier({
      sendMessage: (message) => messages.push(message),
      isIdle: () => true,
    });
    const session: ToolSession = {
      runtime,
      registry: new Registry(),
      scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
      monitors: new MonitorManager(),
      notifier,
    };
    const tools: Record<string, any> = {};
    const pi = {
      registerTool(value: any) {
        tools[value.name] = value;
      },
    };
    registerSpawnTool(pi as never, () => session);
    registerControlTool(pi as never, () => session);
    assert.ok(tools.hc_subagent, "spawn tool registered");
    assert.ok(tools.hc_subagent_control, "control tool registered");
    const ctx = {
      cwd: isolated.root,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify: () => {}, confirm: async () => false },
    } as never;

    const started = await tools.hc_subagent.execute(
      "call-1",
      { agent: "reviewer", task: "first turn", background: true },
      undefined,
      undefined,
      ctx,
    );
    const childId = started.details.childId as string;
    await waitFor(() => session.registry.get(childId)?.state === "completed");
    await waitFor(() => messages.length >= 1);
    const firstSettle = session.registry.get(childId);
    assert.ok(firstSettle);
    const firstSettledAt = firstSettle.turns.at(-1)?.settledAt;
    const firstTurn = firstSettle.turn;
    assert.ok(firstSettledAt, "the settled turn carries its settle time");

    // A follow-up with wait:false settles under a monitor instead of the caller.
    const sent = await tools.hc_subagent_control.execute(
      "call-2",
      { action: "send", id: childId, message: "second turn", wait: false },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(sent.isError, true, JSON.stringify(sent));

    await waitFor(() => (session.registry.get(childId)?.turns.length ?? 0) === 2);
    await waitFor(() => session.registry.get(childId)?.turns.at(-1)?.state === "failed");
    await waitFor(() => messages.length >= 2);
    const secondSettle = session.registry.get(childId);
    assert.ok(secondSettle);
    const secondSettledAt = secondSettle.turns.at(-1)?.settledAt;
    assert.ok(secondSettledAt);
    assert.equal(secondSettle.turn, firstTurn, "the second settle shares the first turn");
    assert.notEqual(secondSettledAt, firstSettledAt, "each settle has its own settle time");

    assert.equal(messages.length, 2, "each settle reaches the parent exactly once");
    assert.match(messages[0]?.content ?? "", /^status: completed$/m);
    assert.match(messages[0]?.content ?? "", /Fake initial result\./);
    assert.match(messages[1]?.content ?? "", /^status: failed$/m);
    assert.match(messages[1]?.content ?? "", /Fake follow-up result: second turn/);

    await runtime.core.kill(firstSettle.terminal).catch(() => {});
    session.monitors?.stopAll();
    session.notifier?.dispose();
  } finally {
    await isolated.cleanup();
  }
});

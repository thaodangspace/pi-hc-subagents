import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RunMetadata } from "../../src/child/child-spawn.ts";
import { runsRootFor } from "../../src/child/paths.ts";
import { MonitorManager } from "../../src/runtime/async-monitor.ts";
import { Notifier } from "../../src/runtime/notifier.ts";
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

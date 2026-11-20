import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Registry } from "../../src/runtime/registry.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
import { registerSpawnTool } from "../../src/tools/spawn-tool.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));

interface Harness {
  isolated: Awaited<ReturnType<typeof startIsolatedHc>>;
  session: ToolSession;
  execute(params: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    details: any;
    isError?: boolean;
  }>;
  cleanup(): Promise<void>;
}

async function createHarness(config: Record<string, unknown> = {}): Promise<Harness> {
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
    parentSessionId: "it-batch-parent",
    env: {
      ...isolated.env,
      PI_HC_SUBAGENTS_TEST_CHILD: fakeChild,
      PI_HC_TEST_CHILD_MODE: "task",
    },
    agentDir,
  });
  assert.equal(runtime.available, true);
  const session: ToolSession = {
    runtime,
    registry: new Registry(),
    scheduler: new Scheduler({
      maxConcurrency: runtime.config.maxConcurrency,
      parallelWrites: runtime.config.parallelWrites,
    }),
  };
  let definition: any;
  registerSpawnTool({ registerTool: (value: any) => (definition = value) } as any, () => session);
  return {
    isolated,
    session,
    execute: (params) => definition.execute("batch-call", params, undefined, undefined, { cwd: isolated.root, isProjectTrusted: () => true, hasUI: false }),
    cleanup: () => isolated.cleanup(),
  };
}

test("tasks runs read-only children concurrently and one failure does not cancel the other", { skip: !available }, async () => {
  const harness = await createHarness({ maxConcurrency: 2 });
  try {
    const result = await harness.execute({
      tasks: [
        { agent: "scout", task: "SUCCESS first scout" },
        { agent: "scout", task: "FAIL second scout" },
      ],
      timeoutMs: 20_000,
    });

    assert.equal(result.details.mode, "parallel");
    assert.equal(result.details.results.length, 2);
    assert.equal(result.details.results[0].state, "completed");
    assert.equal(result.details.results[1].state, "failed");
    assert.match(result.details.results[0].text, /Handled task: SUCCESS first scout/);
    assert.match(result.content[0]?.text ?? "", /2 tasks, 1 completed, 1 failed/);
    assert.match(result.content[0]?.text ?? "", /Full per-task results are in details\.results\[\]/);

    assert.equal(harness.session.registry.all().length, 2);
    for (const record of harness.session.registry.all()) {
      assert.equal(record.state === "completed" || record.state === "failed", true);
      assert.match(record.sessionFile ?? "", /\.jsonl$/);
    }
  } finally {
    await harness.cleanup();
  }
});

test("chain substitutes {previous}, runs in order, and stops on the first failure", { skip: !available }, async () => {
  const harness = await createHarness({ maxConcurrency: 2 });
  try {
    const result = await harness.execute({
      chain: [
        { agent: "scout", task: "first step" },
        { agent: "scout", task: "second uses {previous}" },
        { agent: "scout", task: "third step" },
      ],
      timeoutMs: 20_000,
    });

    assert.equal(result.details.mode, "chain");
    assert.equal(result.details.results.length, 3);
    assert.equal(result.details.results[0].state, "completed");
    assert.equal(result.details.results[1].state, "completed");
    assert.equal(result.details.results[2].state, "completed");
    assert.match(result.details.results[0].text, /Handled task: first step/);
    assert.match(result.details.results[1].text, /second uses Handled task: first step/);
    assert.match(result.details.results[2].text, /Handled task: third step/);
    assert.equal(harness.session.registry.all().length, 3);

    const failure = await harness.execute({
      chain: [
        { agent: "scout", task: "FAIL first step" },
        { agent: "scout", task: "never runs" },
      ],
      timeoutMs: 20_000,
    });
    assert.equal(failure.isError, true);
    assert.equal(failure.details.results[0].state, "failed");
    assert.equal(failure.details.results[1].skipped, true);
    assert.match(failure.content[0]?.text ?? "", /1 skipped/);
    assert.equal(harness.session.registry.all().length, 4, "the skipped step created no child");
  } finally {
    await harness.cleanup();
  }
});

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { buildSpawnPlan } from "../../src/child/child-command.ts";
import { createSubagentRecord, spawnChild } from "../../src/child/child-spawn.ts";
import { createRunPaths } from "../../src/child/paths.ts";
import { pipeClientFor, waitForPipe } from "../../src/child/pipe-transport.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
import type { SubagentRecord } from "../../src/runtime/types.ts";
import { registerControlTool } from "../../src/tools/control-tool.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));

function agent(): AgentDefinition {
  return {
    name: "reviewer",
    description: "Read-only review",
    systemPrompt: "You are a reviewer.",
    tools: ["read", "grep"],
    access: "read-only",
    source: "user",
    filePath: "/agents/reviewer.md",
  };
}

interface Harness {
  isolated: Awaited<ReturnType<typeof startIsolatedHc>>;
  session: ToolSession;
  execute(params: Record<string, unknown>): Promise<{
    content: Array<{ type: string; text: string }>;
    details: any;
    isError?: boolean;
  }>;
  spawn(mode: string, suffix: string): Promise<SubagentRecord>;
  cleanup(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, startupTimeoutMs: 5_000, waitTimeoutMs: 15_000 }),
    "utf8",
  );
  const runtime = await createRuntime({
    cwd: isolated.root,
    trusted: true,
    parentSessionId: "it-pipe-parent",
    env: { ...isolated.env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild },
    agentDir,
  });
  assert.equal(runtime.available, true);
  const session: ToolSession = {
    runtime,
    registry: new Registry(),
    scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
  };
  let definition: any;
  registerControlTool({ registerTool: (value: any) => (definition = value) } as any, () => session);

  let counter = 0;
  const spawn = async (mode: string, suffix: string): Promise<SubagentRecord> => {
    counter++;
    const childId = `7${counter}111111-2222-4333-8444-55555555555${counter}`.slice(0, 36);
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(isolated.root, "runs"),
      runId: `20261120T06000${counter}Z-a1b2c${counter}`,
      childId,
      randomSuffix: () => suffix.slice(0, 4),
    });
    const plan = buildSpawnPlan({
      agent: agent(),
      task: "Pipe test task.",
      cwd: isolated.root,
      paths,
      parentTerminalId: isolated.parentTerminal?.address ?? "t1",
      parentSessionId: "it-pipe-parent",
      trust: { projectTrusted: true, parentCwd: isolated.root },
      env: { ...isolated.env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild, PI_HC_TEST_CHILD_MODE: mode },
    });
    const spawned = await spawnChild(isolated.core, plan);
    return session.registry.create(
      createSubagentRecord(plan, spawned.terminal, {
        parentSessionId: "it-pipe-parent",
        origin: "tool",
        turnStartedAtMs: Date.now(),
      }),
    );
  };

  return {
    isolated,
    session,
    execute: (params) => definition.execute("call-1", params, undefined, undefined, { cwd: isolated.root }),
    spawn,
    cleanup: () => isolated.cleanup(),
  };
}

test("send delivers a follow-up over the private pipe and appends a turn", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const record = await harness.spawn("pipe", "pipe1");
    assert.match(record.pipeName ?? "", /^pi-hc-[a-f0-9]{16}-/);

    const initial = await harness.execute({ action: "wait", id: record.childId, timeoutMs: 10_000 });
    assert.equal(initial.details.state, "completed");
    assert.match(initial.content[0]?.text ?? "", /Fake initial result\./);
    const firstTurn = harness.session.registry.get(record.childId)?.turns.length ?? 0;
    assert.equal(firstTurn, 1);

    const sent = await harness.execute({
      action: "send",
      id: record.childId,
      message: "add more tests",
      timeoutMs: 15_000,
    });
    assert.equal(sent.isError, false, JSON.stringify(sent));
    assert.equal(sent.details.state, "completed");
    assert.equal(sent.details.outcome, "stop");
    assert.match(sent.content[0]?.text ?? "", /Fake follow-up result: add more tests/);

    const updated = harness.session.registry.get(record.childId);
    assert.equal(updated?.turns.length, 2);
    assert.equal(updated?.turns[0]?.state, "completed");
    assert.equal(updated?.turns[0]?.text, "Fake initial result.");
    assert.equal(updated?.turns[1]?.state, "completed");
    assert.match(updated?.turns[1]?.text ?? "", /Fake follow-up result/);

    const resultAgain = await harness.execute({ action: "result", id: record.childId });
    assert.match(resultAgain.content[0]?.text ?? "", /Fake follow-up result/);
  } finally {
    await harness.cleanup();
  }
});

test("send steers a streaming child and never types into the PTY", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const record = await harness.spawn("pipe-streaming", "pipe2");
    const sent = await harness.execute({
      action: "send",
      id: record.childId,
      message: "steer to the smaller diff",
      timeoutMs: 15_000,
    });
    assert.equal(sent.isError, false, JSON.stringify(sent));
    assert.equal(sent.details.state, "completed");
    assert.match(sent.content[0]?.text ?? "", /Fake follow-up result: steer to the smaller diff/);

    const screen = await harness.isolated.core.read(record.terminal, 20);
    assert.doesNotMatch(screen.text, /steer to the smaller diff/);
  } finally {
    await harness.cleanup();
  }
});

test("send rejects a blocked child and does not append a turn", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const record = await harness.spawn("blocked", "pipe3");
    await harness.execute({ action: "wait", id: record.childId, timeoutMs: 10_000 });
    const before = harness.session.registry.get(record.childId)?.turns.length;

    const sent = await harness.execute({
      action: "send",
      id: record.childId,
      message: "answer the dialog",
      timeoutMs: 5_000,
    });
    assert.equal(sent.isError, true);
    assert.equal(sent.details.code, "blocked");
    assert.match(sent.content[0]?.text ?? "", /blocked/i);
    assert.match(sent.content[0]?.text ?? "", /hc attach/);
    assert.equal(harness.session.registry.get(record.childId)?.turns.length, before);
  } finally {
    await harness.cleanup();
  }
});

test("interrupt and shutdown travel over the private pipe", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const record = await harness.spawn("pipe-streaming", "pipe4");
    const client = pipeClientFor(harness.isolated.root, record.childId, record.pipeName);
    await waitForPipe(client, { timeoutMs: 5_000 });

    await client.interrupt();
    await client.shutdown();

    const deadline = Date.now() + 5_000;
    let terminal = await harness.isolated.core.tryGet(record.terminal);
    while (terminal && terminal.state === "live" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      terminal = await harness.isolated.core.tryGet(record.terminal);
    }
    assert.equal(terminal === null || terminal.state === "finished", true, "the child exited after shutdown");
  } finally {
    await harness.cleanup();
  }
});

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { buildSpawnPlan } from "../../src/child/child-command.ts";
import { createSubagentRecord, spawnChild } from "../../src/child/child-spawn.ts";
import { createRunPaths } from "../../src/child/paths.ts";
import type { TerminalRecord } from "../../src/core/hc-types.ts";
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
  execute(
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; details: any; isError?: boolean }>;
  spawn(mode: string, suffix?: string): Promise<SubagentRecord>;
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
    parentSessionId: "it-control-parent",
    env: { ...isolated.env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild },
    agentDir,
  });
  const session: ToolSession = {
    runtime,
    registry: new Registry(),
    scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
  };
  let definition: any;
  registerControlTool({ registerTool: (value: any) => (definition = value) } as any, () => session);

  let counter = 0;
  const spawn = async (mode: string, suffix = "control"): Promise<SubagentRecord> => {
    counter++;
    const childId = `5${counter}111111-2222-4333-8444-55555555555${counter}`.slice(0, 36);
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(isolated.root, "runs"),
      runId: `20261120T05000${counter}Z-a1b2c${counter}`,
      childId,
      randomSuffix: () => suffix.slice(0, 4),
    });
    const plan = buildSpawnPlan({
      agent: agent(),
      task: "Control test task.",
      cwd: isolated.root,
      paths,
      parentTerminalId: isolated.parentTerminal?.address ?? "t1",
      parentSessionId: "it-control-parent",
      trust: { projectTrusted: true, parentCwd: isolated.root },
      env: { ...isolated.env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild, PI_HC_TEST_CHILD_MODE: mode },
    });
    const spawned = await spawnChild(isolated.core, plan);
    return session.registry.create(
      createSubagentRecord(plan, spawned.terminal, {
        parentSessionId: "it-control-parent",
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

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 8000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("list, wait, result, attach, and output work against a real child", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const record = await harness.spawn("success", "ctl1");
    const listed = await harness.execute({ action: "list" });
    assert.equal(listed.isError, undefined);
    assert.match(listed.content[0]?.text ?? "", /reviewer/);
    assert.match(listed.content[0]?.text ?? "", new RegExp(record.terminal));
    assert.doesNotMatch(listed.content[0]?.text ?? "", /Control test task/);

    const attach = await harness.execute({ action: "attach", id: record.childId });
    assert.match(attach.content[0]?.text ?? "", new RegExp(`hc attach ${record.terminal}`));

    const waited = await harness.execute({ action: "wait", id: record.childId, timeoutMs: 10_000 });
    assert.equal(waited.isError, false);
    assert.equal(waited.details.state, "completed");
    assert.equal(waited.details.outcome, "stop");
    assert.match(waited.content[0]?.text ?? "", /Fake child result: task complete\./);

    const result = await harness.execute({ action: "result", id: record.slug });
    assert.equal(result.isError, false);
    assert.match(result.content[0]?.text ?? "", /Fake child result: task complete\./);

    const output = await harness.execute({ action: "output", id: record.terminal, lines: 30 });
    assert.match(output.content[0]?.text ?? "", /\[Subagent screen output — lossy, not a result\]/);
    assert.equal(output.details.lossy, true);

    // Shorter id suffix resolves too.
    const bySuffix = await harness.execute({ action: "attach", id: record.slug.slice(-4) });
    assert.match(bySuffix.content[0]?.text ?? "", /hc attach/);

    await harness.isolated.core.kill(record.terminal);
  } finally {
    await harness.cleanup();
  }
});

test("interrupt and kill manage a live child", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const record = await harness.spawn("silent", "ctl2");
    const interrupted = await harness.execute({ action: "interrupt", id: record.childId });
    assert.equal(interrupted.isError, undefined);
    assert.match(interrupted.content[0]?.text ?? "", /interrupted/);

    const killed = await harness.execute({ action: "kill", id: record.childId });
    assert.equal(killed.isError, undefined);
    assert.equal(killed.details.state, "cancelled");
    const updated = harness.session.registry.get(record.childId);
    assert.equal(updated?.state, "cancelled");
    assert.equal(await harness.isolated.core.tryGet(record.terminal), null);
  } finally {
    await harness.cleanup();
  }
});

test("blocked and not_settled are distinct outcomes", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const blocked = await harness.spawn("blocked", "ctl3");
    const waited = await harness.execute({ action: "wait", id: blocked.childId, timeoutMs: 10_000 });
    assert.equal(waited.isError, false);
    assert.equal(waited.details.state, "blocked");
    assert.equal(waited.details.outcome, "blocked");

    const idle = await harness.spawn("startup-idle", "ctl4");
    const notSettled = await harness.execute({ action: "result", id: idle.childId });
    assert.equal(notSettled.isError, true);
    assert.equal(notSettled.details.code, "not_settled");

    await harness.isolated.core.kill(blocked.terminal);
    await harness.isolated.core.kill(idle.terminal);
  } finally {
    await harness.cleanup();
  }
});

test("ambiguous and unknown ids return clear errors", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const base = harness.session.registry.get("none");
    assert.equal(base, undefined);
    const now = new Date().toISOString();
    const fakeRecord = (childId: string, terminal: string, slug: string): SubagentRecord => ({
      version: 1,
      runId: `run-${childId}`,
      childId,
      parentSessionId: "it-control-parent",
      agent: "reviewer",
      agentSource: "user",
      agentAccess: "read-only",
      cwd: harness.isolated.root,
      terminal,
      terminalName: `hc-${slug}`,
      sessionId: childId,
      sessionFile: null,
      state: "starting",
      terminalState: "live",
      coreStatus: "unknown",
      slug,
      turn: 0,
      turns: [],
      createdAt: now,
      updatedAt: now,
      labels: {},
      background: false,
      origin: "tool",
    });
    harness.session.registry.create(fakeRecord("aaaa-1", "t91", "aaa-aaaa"));
    harness.session.registry.create(fakeRecord("aaaa-2", "t92", "bbb-aaaa"));

    const ambiguous = await harness.execute({ action: "attach", id: "aaaa" });
    assert.equal(ambiguous.isError, true);
    assert.equal(ambiguous.details.code, "ambiguous");
    assert.match(ambiguous.content[0]?.text ?? "", /ambiguous/);

    const missing = await harness.execute({ action: "attach", id: "no-such-child" });
    assert.equal(missing.isError, true);
    assert.equal(missing.details.code, "not_found");
  } finally {
    await harness.cleanup();
  }
});

test("a control wait timeout returns the current state without killing", { skip: !available }, async () => {
  const harness = await createHarness();
  try {
    const record = await harness.spawn("startup-idle", "ctl5");
    const waited = await harness.execute({ action: "wait", id: record.childId, timeoutMs: 1_200 });
    assert.equal(waited.isError, false);
    assert.equal(waited.details.outcome, "timeout");
    const terminal = await harness.isolated.core.get(record.terminal);
    assert.equal(terminal.state, "live");
    await harness.isolated.core.kill(record.terminal);
  } finally {
    await harness.cleanup();
  }
});

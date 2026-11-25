import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { buildSpawnPlan } from "../../src/child/child-command.ts";
import { createSubagentRecord, spawnChild } from "../../src/child/child-spawn.ts";
import { createRunPaths } from "../../src/child/paths.ts";
import { shutdownOwnedChildren } from "../../src/runtime/lifecycle.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { cancelRecord } from "../../src/runtime/run-ops.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { SettleHintHub } from "../../src/runtime/settle-hints.ts";
import { sweepFinishedTerminals } from "../../src/runtime/terminal-sweep.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
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

async function createSession(
  isolated: Awaited<ReturnType<typeof startIsolatedHc>>,
  parentSessionId = "it-lifecycle-parent",
  options: { mode?: string; settleHints?: SettleHintHub; config?: Record<string, unknown> } = {},
): Promise<ToolSession> {
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, ...options.config }),
    "utf8",
  );
  const runtime = await createRuntime({
    cwd: isolated.root,
    trusted: true,
    parentSessionId,
    env: {
      ...isolated.env,
      PI_HC_SUBAGENTS_TEST_CHILD: fakeChild,
      PI_HC_TEST_CHILD_MODE: options.mode ?? "silent",
    },
    agentDir,
  });
  return {
    runtime,
    registry: new Registry(),
    scheduler: new Scheduler({ maxConcurrency: 4, parallelWrites: false }),
    ...(options.settleHints === undefined ? {} : { settleHints: options.settleHints }),
  };
}

async function spawnSilentChild(session: ToolSession, suffix: string): Promise<ReturnType<typeof createSubagentRecord>> {
  const isolatedRoot = session.runtime.cwd;
  const paths = createRunPaths({
    agentName: "reviewer",
    runsRoot: path.join(isolatedRoot, "runs"),
    runId: `20261120T04000${suffix}Z-a1b2c3`,
    childId: `${suffix}111111-2222-4333-8444-555555555555`.slice(0, 36),
    randomSuffix: () => "life",
  });
  const plan = buildSpawnPlan({
    agent: agent(),
    task: "Hold the terminal.",
    cwd: isolatedRoot,
    paths,
    parentTerminalId: session.runtime.parentTerminalId ?? "t1",
    parentSessionId: session.runtime.parentSessionId,
    trust: { projectTrusted: true, parentCwd: isolatedRoot },
    env: session.runtime.env,
  });
  const spawned = await spawnChild(session.runtime.core, plan);
  return session.registry.create(
    createSubagentRecord(plan, spawned.terminal, {
      parentSessionId: session.runtime.parentSessionId,
      turnStartedAtMs: Date.now(),
    }),
  );
}

async function waitForFinished(
  isolated: Awaited<ReturnType<typeof startIsolatedHc>>,
  address: string,
  timeoutMs = 8000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const terminal = await isolated.core.get(address);
    if (terminal.state === "finished") return terminal;
    if (Date.now() > deadline) throw new Error(`terminal ${address} did not finish`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test("session shutdown kills all owned children", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const session = await createSession(isolated);
    const first = await spawnSilentChild(session, "1");
    const second = await spawnSilentChild(session, "2");

    const result = await shutdownOwnedChildren(session);
    assert.deepEqual(result.failed, []);
    assert.equal(result.killed.length, 2);
    assert.equal(session.registry.get(first.childId)?.state, "cancelled");

    // Default `sweepFinishedTerminals`: shutdown also removes what it killed,
    // so a finished session leaves no terminal behind.
    assert.equal(await isolated.core.tryGet(first.terminal), null);
    assert.equal(await isolated.core.tryGet(second.terminal), null);
  } finally {
    await isolated.cleanup();
  }
});

test(
  "shutdown keeps killed terminals when sweepFinishedTerminals is off",
  { skip: !available },
  async () => {
    const isolated = await startIsolatedHc();
    try {
      const session = await createSession(isolated, "it-lifecycle-keep", {
        config: { sweepFinishedTerminals: false },
      });
      const child = await spawnSilentChild(session, "a");
      const result = await shutdownOwnedChildren(session);
      assert.deepEqual(result.failed, []);
      assert.equal((await waitForFinished(isolated, child.terminal)).state, "finished");
      assert.equal((await isolated.core.tryGet(child.terminal))?.state, "finished");
    } finally {
      await isolated.cleanup();
    }
  },
);

test("a child ends when its hc parent ends", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const session = await createSession(isolated, "it-parent-relation");
    const child = await spawnSilentChild(session, "3");
    const parent = isolated.parentTerminal;
    assert.ok(parent);
    await isolated.core.kill(parent.address);
    const finished = await waitForFinished(isolated, child.terminal);
    assert.equal(finished.state, "finished");
  } finally {
    await isolated.cleanup();
  }
});

test("shutdown never touches another parent session's records", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const session = await createSession(isolated, "parent-a");
    const other = await createSession(isolated, "parent-b");
    const mine = await spawnSilentChild(session, "4");
    const theirs = await spawnSilentChild(other, "5");

    // Move their record into this registry to prove the parent filter matters.
    other.registry.remove(theirs.childId);
    session.registry.create(theirs);

    const result = await shutdownOwnedChildren(session);
    assert.deepEqual(result.killed, [mine.terminal]);
    const theirTerminal = await isolated.core.get(theirs.terminal);
    assert.equal(theirTerminal.state, "live");
    await isolated.core.kill(theirs.terminal);
  } finally {
    await isolated.cleanup();
  }
});

test("the start-up sweep removes only this parent's finished terminals", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const session = await createSession(isolated, "it-sweep-mine");
    const other = await createSession(isolated, "it-sweep-theirs");
    const mine = await spawnSilentChild(session, "7");
    const theirs = await spawnSilentChild(other, "8");

    // A terminal still owned by an unfinished record is protected even when
    // hc already reports it finished.
    const protectedTerminal = await spawnSilentChild(session, "9");

    // Every child ends without a shutdown, so all three terminals are
    // `finished` and only ownership decides what the sweep may remove.
    for (const address of [mine.terminal, theirs.terminal, protectedTerminal.terminal]) {
      await isolated.core.kill(address);
      assert.equal((await waitForFinished(isolated, address)).state, "finished");
    }

    const result = await sweepFinishedTerminals({
      core: isolated.core,
      parentSessionId: session.runtime.parentSessionId,
      protectedTerminals: [protectedTerminal.terminal],
    });

    assert.deepEqual(result.removed, [mine.terminal]);
    assert.deepEqual(result.failed, []);
    assert.equal(await isolated.core.tryGet(mine.terminal), null);
    assert.equal((await isolated.core.tryGet(protectedTerminal.terminal))?.state, "finished");
    assert.equal((await isolated.core.get(theirs.terminal)).state, "finished");
  } finally {
    await isolated.cleanup();
  }
});

async function waitForClosedEpisodes(hub: SettleHintHub, childId: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (hub.stats(childId)?.state === "open") return;
    if (Date.now() > deadline) throw new Error("the settle-hint subscription did not open");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("cancel closes the child's settle-hint subscription and closeAll empties the hub", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const hub = new SettleHintHub();
    const session = await createSession(isolated, "it-settle-cancel", { mode: "pipe", settleHints: hub });
    const child = await spawnSilentChild(session, "6");
    assert.match(child.pipeName ?? "", /^pi-hc-[a-f0-9]{16}-/);

    assert.equal(hub.start(child.childId, child.pipeName as string), true);
    await waitForClosedEpisodes(hub, child.childId);
    assert.equal(hub.stats(child.childId)?.degraded, false);
    assert.equal(hub.size, 1);

    await cancelRecord(session, child);
    assert.equal(hub.stats(child.childId)?.state, "closed");
    assert.equal(hub.stats(child.childId)?.degraded, false);
    assert.equal(hub.size, 0, "a cancelled child keeps no live subscription");

    // session_shutdown: teardown calls closeAll(); nothing stays subscribed.
    hub.closeAll();
    assert.equal(hub.size, 0);
    assert.equal(hub.stats(child.childId), undefined, "closeAll also drops the retained snapshot");
  } finally {
    await isolated.cleanup();
  }
});

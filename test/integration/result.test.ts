import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { buildSpawnPlan } from "../../src/child/child-command.ts";
import { spawnChild } from "../../src/child/child-spawn.ts";
import { createRunPaths } from "../../src/child/paths.ts";
import { parseSessionFile } from "../../src/child/session-read.ts";
import { locateSessionFile } from "../../src/child/session-locate.ts";
import { buildResultJson, readResultFile, writeResultFile } from "../../src/runtime/result-store.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));

function reviewerAgent(): AgentDefinition {
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

async function waitForTerminal(
  core: Awaited<ReturnType<typeof startIsolatedHc>>["core"],
  address: string,
  wanted: Set<string>,
  timeoutMs = 8000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const terminal = await core.get(address);
    if (wanted.has(terminal.status?.state ?? "") || terminal.state === "finished") return terminal;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${[...wanted].join("/")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("fake child success parses to text, outcome, and usage and publishes result.json", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const cwd = path.join(isolated.root, "repo");
  await mkdir(cwd, { recursive: true });
  try {
    const childId = "41111111-2222-4333-8444-555555555555";
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(isolated.root, "runs"),
      runId: "20261120T034011Z-a1b2c3",
      childId,
      randomSuffix: () => "9f0e",
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "Review the fake task.",
      cwd,
      paths,
      parentTerminalId: isolated.parentTerminal?.address ?? "t1",
      parentSessionId: "it-parent-session",
      trust: { projectTrusted: false, parentCwd: cwd },
      env: {
        ...process.env,
        ...isolated.env,
        PI_HC_SUBAGENTS_TEST_CHILD: fakeChild,
        PI_HC_TEST_CHILD_MODE: "success",
      },
    });
    const spawned = await spawnChild(isolated.core, plan);
    const settled = await waitForTerminal(isolated.core, spawned.terminal.address, new Set(["done", "error"]));
    assert.equal(settled.status?.state, "done");

    const sessionFile = await locateSessionFile({ sessionDir: paths.sessionDir, childId, timeoutMs: 8000 });
    assert.ok(sessionFile);

    const parsed = await parseSessionFile(sessionFile, {
      turnStartedAtMs: Date.now() - 60_000,
      final: true,
    });
    assert.equal(parsed.state, "completed");
    assert.equal(parsed.outcome, "stop");
    assert.equal(parsed.text, "Fake child result: task complete.");
    assert.equal(parsed.usage?.totalTokens, 165);
    assert.equal(parsed.usage?.cost.total, 0.033);
    assert.equal(parsed.sessionFile, sessionFile);

    const result = buildResultJson({
      childId,
      turn: settled.turn,
      state: parsed.state,
      outcome: parsed.outcome,
      text: parsed.text,
      usage: parsed.usage,
      sessionFile,
      terminal: settled.address,
      startedAt: new Date().toISOString(),
      settledAt: new Date().toISOString(),
      error: parsed.error ?? null,
    });
    await writeResultFile(paths.resultFile, result);
    const read = await readResultFile(paths.resultFile);
    assert.equal(read?.text, "Fake child result: task complete.");
    assert.equal(read?.sessionFile, sessionFile);
    assert.equal(read?.terminal, settled.address);
    assert.equal(read?.textTruncated, false);

    await isolated.core.kill(spawned.terminal.address);
  } finally {
    await isolated.cleanup();
  }
});

test("fake child provider error parses to a structured failure", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const cwd = path.join(isolated.root, "repo");
  await mkdir(cwd, { recursive: true });
  try {
    const childId = "42222222-2222-4333-8444-555555555555";
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(isolated.root, "runs"),
      runId: "20261120T034012Z-a1b2c3",
      childId,
      randomSuffix: () => "9f0e",
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "Review the fake task.",
      cwd,
      paths,
      parentTerminalId: isolated.parentTerminal?.address ?? "t1",
      parentSessionId: "it-parent-session",
      trust: { projectTrusted: false, parentCwd: cwd },
      env: {
        ...process.env,
        ...isolated.env,
        PI_HC_SUBAGENTS_TEST_CHILD: fakeChild,
        PI_HC_TEST_CHILD_MODE: "error",
      },
    });
    const spawned = await spawnChild(isolated.core, plan);
    const settled = await waitForTerminal(isolated.core, spawned.terminal.address, new Set(["error", "done"]));
    assert.equal(settled.status?.state, "error");

    const sessionFile = await locateSessionFile({ sessionDir: paths.sessionDir, childId, timeoutMs: 8000 });
    assert.ok(sessionFile);
    const parsed = await parseSessionFile(sessionFile, { turnStartedAtMs: Date.now() - 60_000, final: true });
    assert.equal(parsed.state, "failed");
    assert.equal(parsed.outcome, "error");
    assert.equal(parsed.error, "fake provider exploded");

    await isolated.core.kill(spawned.terminal.address);
  } finally {
    await isolated.cleanup();
  }
});

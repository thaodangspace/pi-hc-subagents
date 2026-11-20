import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { HcSubagentError } from "../../src/core/error.ts";
import { buildSpawnPlan } from "../../src/child/child-command.ts";
import { spawnChild } from "../../src/child/child-spawn.ts";
import { createRunPaths } from "../../src/child/paths.ts";
import { locateSessionFile } from "../../src/child/session-locate.ts";
import { resolvePiInvocation } from "../../src/child/pi-invocation.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));
const CHILD_ID = "11111111-2222-4333-8444-555555555555";

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

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000, intervalMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("spawn creates one child with parent, no_notify, labels, env, and cwd", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const cwd = path.join(isolated.root, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd, { recursive: true });
  try {
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(isolated.root, "runs"),
      runId: "20261120T034008Z-a1b2c3",
      childId: CHILD_ID,
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
    assert.equal(spawned.retriedName, false);
    assert.equal(spawned.terminal.parent, isolated.parentTerminal?.address);
    assert.equal(spawned.terminal.notify, false);
    assert.equal(spawned.terminal.cwd, plan.cwd);
    assert.equal(spawned.terminal.name, "hc-reviewer-9f0e");
    assert.equal(spawned.terminal.labels["pi-hc-run"], "20261120T034008Z-a1b2c3");
    assert.equal(spawned.terminal.labels["pi-hc-child"], CHILD_ID);
    assert.equal(spawned.terminal.labels["pi-hc-parent"], "it-parent-session");
    assert.equal(spawned.terminal.labels["pi-hc-agent"], "reviewer");

    const sessionFile = await locateSessionFile({ sessionDir: paths.sessionDir, childId: CHILD_ID, timeoutMs: 8000 });
    assert.ok(sessionFile, "session file should be discovered by child ID suffix");
    assert.ok(sessionFile.endsWith(`_${CHILD_ID}.jsonl`));

    await waitFor(async () => {
      const terminal = await isolated.core.get(spawned.terminal.address);
      return terminal.turn >= 1 ? terminal : null;
    });
    const settled = await isolated.core.get(spawned.terminal.address);
    assert.equal(settled.status?.state, "done");
    assert.equal(settled.turn, 1);

    const metadata = JSON.parse(await readFile(paths.runFile, "utf8"));
    assert.equal(metadata.state, "spawned");
    assert.equal(metadata.terminal, spawned.terminal.address);
    assert.equal(metadata.childId, CHILD_ID);

    const childEnv = JSON.parse(await readFile(path.join(paths.runDir, "child-env.json"), "utf8"));
    assert.equal(childEnv.PI_HC_SUBAGENT, "1");
    assert.equal(childEnv.PI_HC_RUN_ID, "20261120T034008Z-a1b2c3");
    assert.equal(childEnv.PI_HC_CHILD_ID, CHILD_ID);
    assert.equal(childEnv.PI_HC_PARENT_SESSION, "it-parent-session");
    assert.equal(childEnv.HC_TERMINAL_ID, spawned.terminal.address);
    assert.notEqual(childEnv.HC_TERMINAL_ID, isolated.parentTerminal?.address);
    assert.ok(!childEnv.PI_MODEL, "parent model must not leak into the child");
    assert.ok(!childEnv.PI_PROVIDER);
    assert.ok(!childEnv.PI_SESSION_ID, "stale parent session metadata must not leak into the child");
    assert.equal(childEnv.hasPath, true);

    const childArgs = JSON.parse(await readFile(path.join(paths.runDir, "child-args.json"), "utf8"));
    assert.ok(childArgs.argv.includes("--session-id"));
    assert.ok(childArgs.argv.includes("--session-dir"));
    assert.ok(childArgs.argv.includes("--exclude-tools"));
    assert.equal(childArgs.argv.at(-1), `@${paths.taskFile}`);
    assert.equal(childArgs.cwd, plan.cwd);

    const tasks = await isolated.core.list({ labels: { "pi-hc-run": "20261120T034008Z-a1b2c3" } });
    assert.equal(tasks.terminals.length, 1);

    await isolated.core.kill(spawned.terminal.address);
  } finally {
    await isolated.cleanup();
  }
});

test("name_taken regenerates the terminal name once and never duplicates the task", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const cwd = path.join(isolated.root, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(cwd, { recursive: true });
  try {
    const blocker = await isolated.core.run({
      argv: ["sh", "-c", "sleep 60"],
      name: "hc-reviewer-0000",
      noNotify: true,
      parent: isolated.parentTerminal?.address ?? null,
      wait: false,
    });
    assert.equal(blocker.name, "hc-reviewer-0000");

    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(isolated.root, "runs"),
      runId: "20261120T034009Z-a1b2c3",
      childId: "22222222-2222-4333-8444-555555555555",
      randomSuffix: (bytes) => (bytes === 3 ? "a1b2c3" : "0000"),
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "Review.",
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

    const spawned = await spawnChild(isolated.core, plan, { generateSuffix: () => "beef" });
    assert.equal(spawned.retriedName, true);
    assert.equal(spawned.terminal.name, "hc-reviewer-beef");

    const children = await isolated.core.list({ labels: { "pi-hc-run": "20261120T034009Z-a1b2c3" } });
    assert.equal(children.terminals.length, 1);
    await isolated.core.kill(spawned.terminal.address);
    await isolated.core.kill(blocker.address);
  } finally {
    await isolated.cleanup();
  }
});

test("validation failures happen before any terminal is created", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const before = await isolated.core.list();
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(isolated.root, "runs"),
      runId: "20261120T034010Z-a1b2c3",
      childId: "33333333-2222-4333-8444-555555555555",
      randomSuffix: () => "9f0e",
    });
    assert.throws(
      () =>
        buildSpawnPlan({
          agent: reviewerAgent(),
          task: "Review.",
          cwd: path.join(isolated.root, "missing-cwd"),
          paths,
          parentTerminalId: isolated.parentTerminal?.address ?? "t1",
          parentSessionId: "p",
          trust: { projectTrusted: false, parentCwd: isolated.root },
          env: { ...isolated.env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild },
        }),
      (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
    );
    const after = await isolated.core.list();
    assert.equal(after.terminals.length, before.terminals.length);
  } finally {
    await isolated.cleanup();
  }
});

test("missing pi is reported as an invalid invocation", () => {
  const result = resolvePiInvocation({
    argv1: "/does/not/exist.js",
    execPath: "/usr/bin/node",
    exists: () => false,
    env: { PATH: "/nowhere" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /cannot execute pi/);
});

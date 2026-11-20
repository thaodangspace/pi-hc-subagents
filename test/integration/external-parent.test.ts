/**
 * The parent runs outside an hc terminal and reaches the core through an
 * explicit socket. Children are either root terminals (no anchor) or parented
 * to a configured anchor terminal.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { buildSpawnPlan } from "../../src/child/child-command.ts";
import { spawnChild } from "../../src/child/child-spawn.ts";
import { createRunPaths } from "../../src/child/paths.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { createRuntime } from "../../src/runtime/runtime.ts";
import { Scheduler } from "../../src/runtime/scheduler.ts";
import { registerSpawnTool } from "../../src/tools/spawn-tool.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();
const fakeChild = fileURLToPath(new URL("../fixtures/fake-child.ts", import.meta.url));
const PARENT_SESSION = "it-external-parent";

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

function parentlessEnv(isolated: Awaited<ReturnType<typeof startIsolatedHc>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...isolated.env };
  delete env.HC_TERMINAL_ID;
  delete env.HC_TERMINAL_SOCKET;
  env.PI_HC_SUBAGENTS_SOCKET = isolated.socketPath;
  return env;
}

test("outside hc with a socket, plan and spawn create a root child", { skip: !available }, async () => {
  const isolated = await startIsolatedHc({ createParent: false });
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  try {
    const env = parentlessEnv(isolated);
    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: false,
      parentSessionId: PARENT_SESSION,
      env,
      agentDir,
    });
    assert.equal(runtime.available, true);
    assert.equal(runtime.mode, "ready");
    assert.equal(runtime.parentTerminalId, null);
    assert.equal(runtime.core.socketPath, isolated.socketPath);

    const paths = createRunPaths({
      agentName: "reviewer",
      agentDir,
      runId: "20261120T040000Z-b2c3d4",
      childId: "11111111-2222-4333-8444-555555555555",
      randomSuffix: () => "0a1b",
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "Review the external fixture.",
      cwd: isolated.root,
      paths,
      parentTerminalId: runtime.parentTerminalId,
      parentSessionId: PARENT_SESSION,
      trust: { projectTrusted: false, parentCwd: isolated.root },
      env: { ...env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild, PI_HC_TEST_CHILD_MODE: "success" },
    });
    assert.equal(plan.parent, null);
    assert.equal(plan.caller, null);
    assert.equal(plan.noParent, true);

    const spawned = await spawnChild(isolated.core, plan);
    assert.equal(spawned.terminal.parent, null);
    assert.equal(spawned.terminal.notify, false);
    assert.equal(spawned.terminal.labels["pi-hc-parent"], PARENT_SESSION);

    const raw = JSON.parse((await isolated.hc(["get", spawned.terminal.address])).stdout) as {
      parent?: string | null;
      die_with_parent?: boolean;
    };
    assert.equal(raw.parent, null);
    assert.equal(raw.die_with_parent, false);

    const metadata = JSON.parse(await readFile(paths.runFile, "utf8")) as { parentTerminalId: string };
    assert.equal(metadata.parentTerminalId, "");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await isolated.cleanup();
  }
});

test("outside hc with a configured anchor, children are parented to it", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  const anchor = isolated.parentTerminal?.address;
  try {
    assert.ok(anchor, "isolated hc should have a parent terminal");
    await writeFile(
      path.join(agentDir, "hc-subagents.json"),
      JSON.stringify({ hc: { socketPath: isolated.socketPath, parentTerminal: anchor } }),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { ...isolated.env };
    delete env.HC_TERMINAL_ID;
    delete env.HC_TERMINAL_SOCKET;

    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: false,
      parentSessionId: PARENT_SESSION,
      env,
      agentDir,
    });
    assert.equal(runtime.available, true);
    assert.equal(runtime.parentTerminalId, anchor);
    assert.deepEqual(runtime.configWarnings, []);

    const paths = createRunPaths({
      agentName: "reviewer",
      agentDir,
      runId: "20261120T040100Z-c3d4e5",
      childId: "11111111-2222-4333-8444-666666666666",
      randomSuffix: () => "2c3d",
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "Review the anchored fixture.",
      cwd: isolated.root,
      paths,
      parentTerminalId: runtime.parentTerminalId,
      parentSessionId: PARENT_SESSION,
      trust: { projectTrusted: false, parentCwd: isolated.root },
      env: { ...env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild, PI_HC_TEST_CHILD_MODE: "success" },
    });
    assert.equal(plan.parent, anchor);
    assert.equal(plan.noParent, false);

    const spawned = await spawnChild(isolated.core, plan);
    assert.equal(spawned.terminal.parent, anchor);

    const metadata = JSON.parse(await readFile(paths.runFile, "utf8")) as { parentTerminalId: string };
    assert.equal(metadata.parentTerminalId, anchor);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await isolated.cleanup();
  }
});

test("outside hc, session_start registers both tools from the configured socket", { skip: !available }, async () => {
  const isolated = await startIsolatedHc({ createParent: false });
  const agentDir = await mkdtemp(path.join("/tmp", "hc-ext-"));
  const saved = {
    terminalId: process.env.HC_TERMINAL_ID,
    socket: process.env.HC_TERMINAL_SOCKET,
    configuredSocket: process.env.PI_HC_SUBAGENTS_SOCKET,
    configuredParent: process.env.PI_HC_SUBAGENTS_PARENT_TERMINAL,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    subagent: process.env.PI_HC_SUBAGENT,
  };
  try {
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HC_TERMINAL_SOCKET;
    delete process.env.PI_HC_SUBAGENTS_PARENT_TERMINAL;
    delete process.env.PI_HC_SUBAGENT;
    process.env.PI_HC_SUBAGENTS_SOCKET = isolated.socketPath;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const handlers = new Map<string, (...args: any[]) => any>();
    const tools: string[] = [];
    const notifications: string[] = [];
    const pi = {
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, handler);
        return () => {};
      },
      registerTool(definition: { name: string }) {
        tools.push(definition.name);
      },
      registerCommand() {},
      registerMessageRenderer() {},
      appendEntry() {},
      sendMessage() {},
    };
    const hcSubagentsExtension = (await import("../../index.ts")).default;
    hcSubagentsExtension(pi as any);
    const ctx = {
      cwd: isolated.root,
      hasUI: false,
      ui: { notify: (message: string) => notifications.push(message) },
      isProjectTrusted: () => false,
      sessionManager: { getSessionId: () => PARENT_SESSION, getEntries: () => [] },
    };
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    assert.deepEqual(tools.sort(), ["hc_subagent", "hc_subagent_control"]);
    assert.deepEqual(notifications, []);
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
  } finally {
    for (const [key, value] of [
      ["HC_TERMINAL_ID", saved.terminalId],
      ["HC_TERMINAL_SOCKET", saved.socket],
      ["PI_HC_SUBAGENTS_SOCKET", saved.configuredSocket],
      ["PI_HC_SUBAGENTS_PARENT_TERMINAL", saved.configuredParent],
      ["PI_CODING_AGENT_DIR", saved.agentDir],
      ["PI_HC_SUBAGENT", saved.subagent],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(agentDir, { recursive: true, force: true });
    await isolated.cleanup();
  }
});

test("outside hc, hc_subagent waits for a parentless fake child", { skip: !available }, async () => {
  const isolated = await startIsolatedHc({ createParent: false });
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    path.join(agentDir, "hc-subagents.json"),
    JSON.stringify({ pollIntervalMs: 250, startupTimeoutMs: 5_000, waitTimeoutMs: 30_000 }),
    "utf8",
  );
  try {
    const env = parentlessEnv(isolated);
    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: true,
      parentSessionId: PARENT_SESSION,
      env: { ...env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild, PI_HC_TEST_CHILD_MODE: "success" },
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
    const result = await definition.execute(
      "external-call",
      { agent: "reviewer", task: "Review the external fixture.", timeoutMs: 15_000 },
      undefined,
      undefined,
      { cwd: isolated.root, isProjectTrusted: () => true },
    );
    assert.equal(result.isError, false);
    assert.equal(result.details.state, "completed");
    assert.equal(result.details.outcome, "stop");
    const raw = JSON.parse((await isolated.hc(["get", result.details.terminal])).stdout) as {
      parent?: string | null;
    };
    assert.equal(raw.parent, null);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await isolated.cleanup();
  }
});

test("outside hc, a vanished anchor reports not_found with a hint", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const agentDir = path.join(isolated.root, "agent");
  await mkdir(agentDir, { recursive: true });
  const anchor = "t999999";
  try {
    await writeFile(
      path.join(agentDir, "hc-subagents.json"),
      JSON.stringify({ hc: { socketPath: isolated.socketPath, parentTerminal: anchor } }),
      "utf8",
    );
    const env: NodeJS.ProcessEnv = { ...isolated.env };
    delete env.HC_TERMINAL_ID;
    delete env.HC_TERMINAL_SOCKET;
    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: false,
      parentSessionId: PARENT_SESSION,
      env,
      agentDir,
    });
    assert.equal(runtime.parentTerminalId, anchor);

    const paths = createRunPaths({
      agentName: "reviewer",
      agentDir,
      runId: "20261120T040200Z-d4e5f6",
      childId: "11111111-2222-4333-8444-777777777777",
      randomSuffix: () => "4e5f",
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "Review the missing anchor fixture.",
      cwd: isolated.root,
      paths,
      parentTerminalId: anchor,
      parentSessionId: PARENT_SESSION,
      trust: { projectTrusted: false, parentCwd: isolated.root },
      env: { ...env, PI_HC_SUBAGENTS_TEST_CHILD: fakeChild, PI_HC_TEST_CHILD_MODE: "success" },
    });
    await assert.rejects(
      () => spawnChild(isolated.core, plan),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error as { code: string }).code === "not_found" &&
        /parent terminal t999999 does not exist/.test(error.message) &&
        /hc\.parentTerminal/.test((error as { hint?: string }).hint ?? ""),
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await isolated.cleanup();
  }
});

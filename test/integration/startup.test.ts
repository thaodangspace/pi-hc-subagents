import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { createRuntime } from "../../src/runtime/runtime.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();

test("createRuntime returns available inside an isolated hc terminal", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const agentDir = await mkdtemp(path.join("/tmp", "hcr-"));
  try {
    const runtime = await createRuntime({
      cwd: isolated.root,
      trusted: true,
      parentSessionId: "it-session",
      env: isolated.env,
      agentDir,
    });
    assert.equal(runtime.available, true);
    assert.equal(runtime.mode, "ready");
    assert.equal(runtime.prerequisites.reason, "ok");
    assert.equal(runtime.parentTerminalId, isolated.parentTerminal?.address);
    assert.match(runtime.prerequisites.coreVersion ?? "", /^0\.1\./);
    assert.equal(runtime.config.maxConcurrency, 4);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
    await isolated.cleanup();
  }
});

test("createRuntime selects setup mode outside hc", async () => {
  const root = await mkdtemp(path.join("/tmp", "hcr-"));
  try {
    const runtime = await createRuntime({
      cwd: root,
      trusted: false,
      parentSessionId: "it-session",
      env: { PATH: process.env.PATH ?? "" },
      agentDir: root,
    });
    assert.equal(runtime.available, false);
    assert.equal(runtime.mode, "setup");
    assert.equal(runtime.prerequisites.reason, "missing_env");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("inside hc, session_start registers both tools; shutdown clears them", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  const agentDir = await mkdtemp(path.join("/tmp", "hcr-"));
  const saved = {
    terminalId: process.env.HC_TERMINAL_ID,
    socket: process.env.HC_TERMINAL_SOCKET,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    subagent: process.env.PI_HC_SUBAGENT,
  };
  try {
    process.env.HC_TERMINAL_ID = isolated.env.HC_TERMINAL_ID;
    process.env.HC_TERMINAL_SOCKET = isolated.env.HC_TERMINAL_SOCKET;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.PI_HC_SUBAGENT;

    const handlers = new Map<string, (...args: any[]) => any>();
    const tools: string[] = [];
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
    const notifications: string[] = [];
    const ctx = {
      cwd: isolated.root,
      hasUI: false,
      ui: { notify: (message: string) => notifications.push(message) },
      isProjectTrusted: () => true,
      sessionManager: { getSessionId: () => "it-wiring-session" },
    };
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    assert.deepEqual(tools.sort(), ["hc_subagent", "hc_subagent_control"]);
    assert.deepEqual(notifications, []);
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
  } finally {
    for (const [key, value] of [
      ["HC_TERMINAL_ID", saved.terminalId],
      ["HC_TERMINAL_SOCKET", saved.socket],
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

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import hcSubagentsExtension from "../../index.ts";

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

interface MockContext {
  cwd: string;
  hasUI: boolean;
  notifications: Array<{ message: string; type?: string }>;
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
  isProjectTrusted(): boolean;
  sessionManager: { getSessionId(): string };
}

function createContext(cwd: string): MockContext {
  const notifications: Array<{ message: string; type?: string }> = [];
  return {
    cwd,
    hasUI: true,
    notifications,
    ui: {
      notify(message, type) {
        notifications.push({ message, ...(type === undefined ? {} : { type }) });
      },
    },
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "parent-session" },
  };
}

test("outside hc, session_start registers no tools and shows setup guidance", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-setup-"));
  const savedTerminalId = process.env.HC_TERMINAL_ID;
  const savedSocket = process.env.HC_TERMINAL_SOCKET;
  const savedConfiguredSocket = process.env.PI_HC_SUBAGENTS_SOCKET;
  const savedConfiguredParent = process.env.PI_HC_SUBAGENTS_PARENT_TERMINAL;
  const savedAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    const tools: string[] = [];
    const commands = new Map<string, any>();
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HC_TERMINAL_SOCKET;
    delete process.env.PI_HC_SUBAGENTS_SOCKET;
    delete process.env.PI_HC_SUBAGENTS_PARENT_TERMINAL;
    delete process.env.PI_HC_SUBAGENT;
    // The machine's global config may set hc.socketPath, which would make
    // prereq detection succeed and register tools. Isolate the agent dir so
    // the assertion is about this test's empty environment, not the dev box.
    process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");

    const pi = {
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, handler);
        return () => {};
      },
      registerTool(definition: { name: string }) {
        tools.push(definition.name);
      },
      registerCommand(name: string, options: unknown) {
        commands.set(name, options);
      },
      registerMessageRenderer() {},
      appendEntry() {},
      sendMessage() {},
    };

    hcSubagentsExtension(pi as any);
    const ctx = createContext(root);
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);

    assert.deepEqual(tools, []);
    assert.equal(ctx.notifications.length, 1);
    assert.match(ctx.notifications[0]?.message ?? "", /not running inside a herdr-core terminal/);

    const command = commands.get("hc-subagents");
    assert.ok(command);
    await command.handler("", ctx);
    const guidance = ctx.notifications.at(-1)?.message ?? "";
    assert.match(guidance, /requires pi to run inside a herdr-core terminal/);
    assert.match(guidance, /hc run --bg --name pi pi/);
    assert.match(guidance, /PI_HC_SUBAGENTS_SOCKET/);

    // A second session_start must not spam the setup notification.
    await handlers.get("session_start")?.({ type: "session_start" }, createContext(root));
  } finally {
    restoreEnv("HC_TERMINAL_ID", savedTerminalId);
    restoreEnv("HC_TERMINAL_SOCKET", savedSocket);
    restoreEnv("PI_HC_SUBAGENTS_SOCKET", savedConfiguredSocket);
    restoreEnv("PI_HC_SUBAGENTS_PARENT_TERMINAL", savedConfiguredParent);
    restoreEnv("PI_CODING_AGENT_DIR", savedAgentDir);
    await rm(root, { recursive: true, force: true });
  }
});

test("in child mode, session_start registers no tools and stays quiet", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-setup-"));
  try {
    const handlers = new Map<string, (...args: any[]) => any>();
    const tools: string[] = [];
    process.env.PI_HC_SUBAGENT = "1";
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
    hcSubagentsExtension(pi as any);
    const ctx = createContext(root);
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    assert.deepEqual(tools, []);
    assert.deepEqual(ctx.notifications, []);
    delete process.env.PI_HC_SUBAGENT;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

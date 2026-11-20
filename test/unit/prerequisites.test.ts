import assert from "node:assert/strict";
import test from "node:test";

import { CoreClient } from "../../src/core/core-client.ts";
import { detectPrerequisites } from "../../src/runtime/prerequisites.ts";
import { FakeHcServer } from "../fixtures/fake-hc-server.ts";

const READY_PI = { ok: true, invocation: ["pi"] };
const MISSING_PI = { ok: false, invocation: ["pi"], reason: "cannot execute pi" };

function baseEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    HC_TERMINAL_ID: "t3",
    HC_TERMINAL_SOCKET: "/tmp/core.sock",
    ...overrides,
  };
}

async function withServer(
  version: string,
  run: (core: CoreClient, socketPath: string) => Promise<void>,
): Promise<void> {
  const server = new FakeHcServer((method) => {
    if (method === "server.status") {
      return { result: { version, pid: 1, uptime_ms: 1, live: 0, finished: 0 } };
    }
    return { result: {} };
  });
  await server.start();
  try {
    await run(new CoreClient({ socketPath: server.socketPath, caller: "t3" }), server.socketPath);
  } finally {
    await server.stop();
  }
}

test("missing hc environment selects setup mode", async () => {
  const result = await detectPrerequisites({
    env: {},
    core: new CoreClient({ socketPath: null }),
    piInvocation: READY_PI,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "missing_env");
  assert.deepEqual(result.missingEnv, ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]);
  assert.equal(result.parentTerminalId, null);
});

test("child mode never registers tools", async () => {
  const result = await detectPrerequisites({
    env: baseEnv({ PI_HC_SUBAGENT: "1" }),
    core: new CoreClient({ socketPath: null }),
    piInvocation: READY_PI,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "child_mode");
});

test("an unreachable core selects setup mode with a hint", async () => {
  const result = await detectPrerequisites({
    env: baseEnv(),
    core: new CoreClient({ socketPath: "/tmp/definitely-missing-hc.sock" }),
    piInvocation: READY_PI,
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "core_unreachable");
  assert.match(result.message, /not reachable/);
});

test("an old core version is rejected", async () => {
  await withServer("0.1.9", async (core, socketPath) => {
    const result = await detectPrerequisites({
      env: baseEnv({ HC_TERMINAL_SOCKET: socketPath }),
      core,
      piInvocation: READY_PI,
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, "core_too_old");
    assert.equal(result.coreVersion, "0.1.9");
    assert.match(result.message, /0\.1\.16/);
  });
});

test("a supported core with a resolvable pi is ready", async () => {
  await withServer("0.1.21", async (core, socketPath) => {
    const result = await detectPrerequisites({
      env: baseEnv({ HC_TERMINAL_SOCKET: socketPath }),
      core,
      piInvocation: READY_PI,
      parentSessionId: "session-1",
    });
    assert.equal(result.available, true);
    assert.equal(result.reason, "ok");
    assert.equal(result.coreVersion, "0.1.21");
    assert.equal(result.parentTerminalId, "t3");
    assert.equal(result.parentSessionId, "session-1");
  });
});

test("a missing pi binary is rejected even when the core is ready", async () => {
  await withServer("0.1.21", async (core, socketPath) => {
    const result = await detectPrerequisites({
      env: baseEnv({ HC_TERMINAL_SOCKET: socketPath }),
      core,
      piInvocation: MISSING_PI,
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, "missing_pi");
    assert.match(result.message, /cannot execute pi/);
  });
});

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import childPipeExtension from "../../child.ts";
import { HcSubagentError } from "../../src/core/error.ts";
import { pipeNameFor, pipePathFor } from "../../src/child/pipe-protocol.ts";
import { PipeClient } from "../../src/child/pipe-transport.ts";
import { FakeHcServer } from "../fixtures/fake-hc-server.ts";

const fixtureSession = fileURLToPath(new URL("../fixtures/sessions/stop.jsonl", import.meta.url));

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("child.ts starts the pipe, labels the session, delivers safely, and never registers tools", async () => {
  const pipeName = pipeNameFor("/tmp/pi-hc-child-tests", `child-${randomBytes(6).toString("hex")}`);
  const fakeHc = new FakeHcServer(() => ({ result: {} }));
  await fakeHc.start();
  process.env.PI_HC_SUBAGENT = "1";
  process.env.PI_HC_PIPE = pipeName;
  process.env.HC_TERMINAL_ID = "t-child";
  process.env.HC_TERMINAL_SOCKET = fakeHc.socketPath;

  const handlers = new Map<string, (...args: any[]) => any>();
  const sent: Array<{ text: string; options: unknown }> = [];
  let aborted = 0;
  let shutdownRequested = 0;
  let idle = true;
  let toolRegistrations = 0;
  const sessionText = await readFile(fixtureSession, "utf8");

  const pi = {
    on(name: string, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
      return () => {};
    },
    sendUserMessage(text: string, options?: unknown) {
      sent.push({ text, options });
    },
    registerTool() {
      toolRegistrations++;
    },
  } as any;

  const context = {
    hasUI: false,
    ui: { notify() {} },
    sessionManager: {
      getSessionFile: () => fixtureSession,
    },
    isIdle: () => idle,
    abort: () => {
      aborted++;
    },
    shutdown: () => {
      shutdownRequested++;
    },
  } as any;

  childPipeExtension(pi);
  await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, context);
  await sleep(25);
  assert.equal(
    fakeHc.requests.some((request) => {
      const labels = request.params.labels as Record<string, string> | undefined;
      return request.method === "terminal.label" && labels?.["pi-hc-session"] === fixtureSession;
    }),
    true,
    "child labels its terminal with the session file",
  );

  const client = new PipeClient(pipePathFor(pipeName), { timeoutMs: 2000 });
  try {
    const pong = await client.ping();
    assert.equal(pong.version, 1);

    await client.prompt("do the first thing");
    assert.deepEqual(sent.at(-1), { text: "do the first thing", options: undefined });

    idle = false;
    await client.followUp("steer this", true);
    assert.deepEqual(sent.at(-1), { text: "steer this", options: { deliverAs: "steer" } });
    await client.followUp("queue this", false);
    assert.deepEqual(sent.at(-1), { text: "queue this", options: { deliverAs: "followUp" } });

    handlers.get("ui_prompt_start")?.({ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm" });
    await assert.rejects(() => client.followUp("answer it", true), (error: unknown) => {
      assert.equal((error as HcSubagentError).code, "blocked");
      return true;
    });
    handlers.get("ui_prompt_end")?.({ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm" });

    await client.interrupt();
    assert.equal(aborted, 1);

    const result = await client.result();
    assert.equal(result.sessionFile, fixtureSession);
    assert.ok(String(result.text).length > 0);
    assert.equal(sessionText.includes("assistant"), true);

    await client.shutdown();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(shutdownRequested, 1);
    assert.equal(toolRegistrations, 0);
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, context);
    await fakeHc.stop();
    delete process.env.PI_HC_SUBAGENT;
    delete process.env.PI_HC_PIPE;
    delete process.env.HC_TERMINAL_ID;
    delete process.env.HC_TERMINAL_SOCKET;
  }
});

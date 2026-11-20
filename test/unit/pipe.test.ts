import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import test from "node:test";

import { HcSubagentError } from "../../src/core/error.ts";
import {
  MAX_PIPE_FRAME_BYTES,
  MAX_PIPE_MESSAGE_BYTES,
  MAX_PIPE_SESSION_FILE_BYTES,
  NOTIFICATION_VERSION,
  decodePipeNotification,
  decodePipeRequest,
  decodePipeResponse,
  encodeFrame,
  errorFrame,
  isPipeNotification,
  pipeNameFor,
  pipePathFor,
  validatePipeName,
} from "../../src/child/pipe-protocol.ts";
import { PipeRequestError, startChildPipeServer } from "../../src/child/pipe-server.ts";
import { PipeClient, waitForPipe } from "../../src/child/pipe-transport.ts";

function uniqueName(): string {
  return pipeNameFor("/tmp/pi-hc-tests", `unit-${randomBytes(6).toString("hex")}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("pipe names are short, validated, and derived from parent cwd + child id", () => {
  const name = pipeNameFor("/repo", "child-123");
  assert.match(name, /^pi-hc-[a-f0-9]{16}-child-123$/);
  assert.equal(pipeNameFor("/repo", "child-123"), name);
  assert.notEqual(pipeNameFor("/other", "child-123"), name);
  assert.equal(validatePipeName(name), null);
  assert.match(validatePipeName("../../etc/passwd") ?? "", /must match/);
  assert.match(validatePipeName("pi-hc-abc-child") ?? "", /must match/);
  const socketPath = pipePathFor(name);
  assert.equal(socketPath.endsWith(`/${name}.sock`), true);
  assert.ok(Buffer.byteLength(socketPath) < 100);
});

test("frames are bounded and validated", () => {
  const request = decodePipeRequest(encodeFrame({ type: "follow_up", id: "r1", text: "go", steer: true }).trim());
  assert.deepEqual(request, { type: "follow_up", id: "r1", text: "go", steer: true });
  assert.throws(() => decodePipeRequest("{"), /valid JSON/);
  assert.throws(() => decodePipeRequest(JSON.stringify({ type: "ping" })), /id/);
  assert.throws(() => decodePipeRequest(JSON.stringify({ type: "prompt", id: "r1", text: " " })), /must not be empty/);
  assert.throws(
    () => decodePipeRequest(JSON.stringify({ type: "prompt", id: "r1", text: "x".repeat(MAX_PIPE_MESSAGE_BYTES + 1) })),
    /exceeds/,
  );
  assert.throws(() => decodePipeRequest(JSON.stringify({ type: "wat", id: "r1" })), /unknown/);
  assert.deepEqual(decodePipeResponse(encodeFrame({ type: "ok", id: "r1", turn: 2 }).trim()), {
    type: "ok",
    id: "r1",
    turn: 2,
  });
  assert.deepEqual(errorFrame("r1", "blocked", "no", { kind: "permission" }), {
    type: "error",
    id: "r1",
    code: "blocked",
    message: "no",
    kind: "permission",
  });
});

test("settled notifications are versioned and strictly decoded", () => {
  const frame = {
    type: "settled",
    v: NOTIFICATION_VERSION,
    turn: 3,
    status: "completed",
    sessionFile: "/tmp/pi-hc/session.jsonl",
    at: "2026-11-21T00:00:00.000Z",
  };
  const decoded = decodePipeNotification(encodeFrame(frame).trim());
  assert.deepEqual(decoded, frame);
  assert.equal(isPipeNotification(decoded), true);
  assert.deepEqual(
    decodePipeNotification(JSON.stringify({ ...frame, turn: 0, status: "aborted", sessionFile: null })),
    { ...frame, turn: 0, status: "aborted", sessionFile: null },
  );
  const withoutSession = decodePipeNotification(
    JSON.stringify({ type: "settled", v: 1, turn: 1, status: "failed", at: frame.at }),
  );
  assert.equal("sessionFile" in withoutSession, false);

  const withExtra = decodePipeNotification(encodeFrame({ ...frame, text: "must not travel" }).trim());
  assert.equal("text" in withExtra, false, "a notification never carries result text");

  const reject = (payload: unknown) => {
    assert.throws(
      () => decodePipeNotification(JSON.stringify(payload)),
      (error: unknown) => {
        assert.ok(error instanceof HcSubagentError);
        assert.equal(error.code, "protocol");
        return true;
      },
    );
    assert.equal(isPipeNotification(payload), false);
  };

  reject({ ...frame, v: undefined });
  reject({ ...frame, v: 2 });
  reject({ ...frame, turn: 1.5 });
  reject({ ...frame, turn: -1 });
  reject({ ...frame, turn: "3" });
  reject({ ...frame, status: "done" });
  reject({ ...frame, at: undefined });
  reject({ ...frame, at: "yesterday" });
  reject({ ...frame, sessionFile: "/" + "x".repeat(MAX_PIPE_SESSION_FILE_BYTES) });
  reject({ ...frame, sessionFile: "/tmp/a\u0000b" });
  reject({ ...frame, type: "other" });
  reject(["settled"]);
  assert.throws(() => decodePipeNotification("{"), /valid JSON/);

  const overLong = JSON.stringify({ ...frame, sessionFile: "/".repeat(MAX_PIPE_FRAME_BYTES + 1) });
  assert.ok(Buffer.byteLength(overLong, "utf8") > MAX_PIPE_FRAME_BYTES);
  assert.throws(() => decodePipeNotification(overLong), /exceeds/);
});

test("server and client round trip ping, prompt, follow_up, interrupt, result, and shutdown", async () => {
  const calls: string[] = [];
  const name = uniqueName();
  const server = await startChildPipeServer({
    name,
    handlers: {
      ping: () => ({ turn: 2 }),
      prompt: async (text) => {
        calls.push(`prompt:${text}`);
        return { turn: 3 };
      },
      followUp: async (text, steer) => {
        calls.push(`follow_up:${steer}:${text}`);
        return { turn: 4 };
      },
      interrupt: async () => {
        calls.push("interrupt");
        return { turn: 4 };
      },
      result: async () => {
        calls.push("result");
        return { text: "final", state: "completed", outcome: "stop" };
      },
      shutdown: async () => {
        calls.push("shutdown");
      },
    },
  });

  const client = new PipeClient(server.path);
  try {
    assert.equal((await client.ping()).turn, 2);
    assert.equal((await client.prompt("hello")).turn, 3);
    assert.equal((await client.followUp("more", true)).turn, 4);
    assert.equal((await client.interrupt()).turn, 4);
    const result = await client.result();
    assert.equal(result.text, "final");
    assert.deepEqual(calls, ["prompt:hello", "follow_up:true:more", "interrupt", "result"]);

    const mode = (await stat(server.path)).mode & 0o777;
    assert.equal(mode, 0o600, "socket is owner-only");

    assert.equal((await client.shutdown()).type, "ok");
    await sleep(150);
    assert.equal(server.listening, false);
    await assert.rejects(() => new PipeClient(server.path).ping({ timeoutMs: 200 }), (error: unknown) => {
      assert.equal((error as HcSubagentError).code, "unavailable");
      return true;
    });
    assert.deepEqual(calls, ["prompt:hello", "follow_up:true:more", "interrupt", "result", "shutdown"]);
  } finally {
    await server.stop();
  }
});

test("stale socket files are removed before bind", async () => {
  const name = uniqueName();
  const socketPath = pipePathFor(name);
  await writeFile(socketPath, "stale", { mode: 0o600 });
  const server = await startChildPipeServer({
    name,
    handlers: {
      prompt: async () => ({}),
      followUp: async () => ({}),
      interrupt: async () => ({}),
      shutdown: async () => ({}),
      result: async () => ({}),
    },
  });
  try {
    assert.equal(server.listening, true);
    assert.equal((await new PipeClient(server.path).ping()).type, "ok");
  } finally {
    await server.stop();
  }
});

test("blocked and timeout errors preserve stable codes", async () => {
  const name = uniqueName();
  const server = await startChildPipeServer({
    name,
    handlers: {
      prompt: async () => {
        throw new PipeRequestError("blocked", "waiting for a human", { kind: "permission", hint: "attach" });
      },
      followUp: async () => {
        await sleep(250);
        return {};
      },
      interrupt: async () => ({}),
      shutdown: async () => ({}),
      result: async () => ({}),
    },
  });
  const client = new PipeClient(server.path);
  try {
    await assert.rejects(() => client.prompt("go"), (error: unknown) => {
      assert.equal((error as HcSubagentError).code, "blocked");
      assert.equal((error as HcSubagentError).hint, "attach");
      assert.deepEqual((error as HcSubagentError).data, { kind: "permission" });
      return true;
    });
    await assert.rejects(() => client.followUp("slow", true, { timeoutMs: 40 }), (error: unknown) => {
      assert.equal((error as HcSubagentError).code, "timeout");
      return true;
    });
  } finally {
    await server.stop();
  }
});

test("waitForPipe tolerates a child that is still starting", async () => {
  const name = uniqueName();
  const path = pipePathFor(name);
  const client = new PipeClient(path);
  const waiting = waitForPipe(client, { timeoutMs: 3000, intervalMs: 25 });
  await sleep(100);
  const server = await startChildPipeServer({
    name,
    handlers: {
      prompt: async () => ({}),
      followUp: async () => ({}),
      interrupt: async () => ({}),
      shutdown: async () => ({}),
      result: async () => ({}),
    },
  });
  try {
    await waiting;
  } finally {
    await server.stop();
  }
});

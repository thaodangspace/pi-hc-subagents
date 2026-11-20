import assert from "node:assert/strict";
import test from "node:test";

import { CoreClient, HC_METHODS, createCoreClient } from "../../src/core/core-client.ts";
import { HcSubagentError } from "../../src/core/error.ts";
import {
  compareVersions,
  decodeCoreEvent,
  decodeTerminal,
  decodeWaitResult,
} from "../../src/core/hc-types.ts";
import { LineDecoder, splitCompleteLines, splitJsonlText } from "../../src/core/jsonl.ts";
import { FakeHcServer } from "../fixtures/fake-hc-server.ts";

function terminalFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: "t12",
    name: "hc-reviewer-a1b2",
    cwd: "/repo",
    argv: ["pi", "--session-id", "x"],
    state: "live",
    status: { state: "working", msg: "review thing", kind: null, title: "", app: "pi", progress: 42 },
    turn: 3,
    exit_code: null,
    signal: null,
    parent: "t3",
    labels: { "pi-hc-agent": "reviewer", "pi-hc-run": "r1" },
    created_ms: 1000,
    finished_ms: null,
    status_ms: 2000,
    reported: true,
    reason: null,
    keep: false,
    rm: false,
    foreground: { argv: ["pi"], cwd: "/repo/src", name: "pi", pid: 1234 },
    pid: 1234,
    notify: false,
    identity: "ghostty",
    screen: "exact",
    ...overrides,
  };
}

async function withServer(
  handler: Parameters<FakeHcServer["setHandler"]>[0],
  run: (server: FakeHcServer, client: CoreClient) => Promise<void>,
): Promise<void> {
  const server = new FakeHcServer(handler);
  await server.start();
  const client = new CoreClient({ socketPath: server.socketPath, caller: "t3" });
  try {
    await run(server, client);
  } finally {
    await server.stop();
  }
}

test("request/response round trip decodes server version", async () => {
  await withServer(
    () => ({ result: { version: "0.1.21", pid: 1, uptime_ms: 5, live: 2, finished: 0 } }),
    async (server, client) => {
      const status = await client.serverStatus();
      assert.equal(status.version, "0.1.21");
      assert.equal(status.live, 2);
      assert.equal(server.requests[0]?.method, "server.status");
      assert.deepEqual(server.requests[0]?.params, {});
    },
  );
});

test("serverVersion returns null when the socket is unavailable", async () => {
  const client = new CoreClient({ socketPath: null });
  assert.equal(client.available, false);
  assert.equal(await client.serverVersion(), null);
});

test("terminal.get sends caller and decodes the full record", async () => {
  await withServer(
    (method) => {
      assert.equal(method, "terminal.get");
      return { result: terminalFixture() };
    },
    async (server, client) => {
      const terminal = await client.get("t12");
      assert.equal(terminal.address, "t12");
      assert.equal(terminal.name, "hc-reviewer-a1b2");
      assert.equal(terminal.parent, "t3");
      assert.equal(terminal.turn, 3);
      assert.equal(terminal.state, "live");
      assert.equal(terminal.status?.state, "working");
      assert.equal(terminal.status?.message, "review thing");
      assert.equal(terminal.status?.progress, 42);
      assert.equal(terminal.foreground?.cwd, "/repo/src");
      assert.equal(terminal.labels["pi-hc-agent"], "reviewer");
      assert.deepEqual(server.requests[0]?.params, { terminal: "t12", caller: "t3" });
    },
  );
});

test("error.data.kind and hint map to stable error codes", async () => {
  await withServer(
    () => ({
      error: {
        code: -32000,
        message: "no terminal t99",
        data: { kind: "not_found", hint: "run hc ls" },
      },
    }),
    async (_server, client) => {
      await assert.rejects(
        () => client.get("t99"),
        (error: unknown) => {
          assert.ok(error instanceof HcSubagentError);
          assert.equal(error.code, "not_found");
          assert.equal(error.hint, "run hc ls");
          assert.equal(error.rpcCode, -32000);
          return true;
        },
      );
    },
  );
});

test("tryGet returns null for not_found and rethrows other errors", async () => {
  let errorKind = "not_found";
  await withServer(
    () => ({ error: { code: -32000, message: "x", data: { kind: errorKind } } }),
    async (_server, client) => {
      assert.equal(await client.tryGet("t99"), null);
      errorKind = "unavailable";
      await assert.rejects(() => client.tryGet("t99"), /unavailable|x/);
    },
  );
});

test("request times out with a timeout code", async () => {
  await withServer(
    () => ({ result: {}, delayMs: 100 }),
    async (_server, client) => {
      await assert.rejects(
        () => client.request("server.status", {}, { timeoutMs: 20 }),
        (error: unknown) => error instanceof HcSubagentError && error.code === "timeout",
      );
    },
  );
});

test("abort destroys the request and rejects with AbortError", async () => {
  await withServer(
    () => ({ result: {}, delayMs: 200 }),
    async (_server, client) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      await assert.rejects(
        () => client.request("server.status", {}, { signal: controller.signal, timeoutMs: 2000 }),
        (error: unknown) => error instanceof HcSubagentError && error.code === "aborted" && error.name === "AbortError",
      );
    },
  );
});

test("connection closed before response maps to unavailable", async () => {
  await withServer(
    () => ({ close: true }),
    async (_server, client) => {
      await assert.rejects(
        () => client.request("server.status", {}, { timeoutMs: 500 }),
        (error: unknown) => error instanceof HcSubagentError && error.code === "unavailable",
      );
    },
  );
});

test("malformed JSON and missing result are protocol failures", async () => {
  let raw = "not-json\n";
  await withServer(
    () => ({ raw }),
    async (_server, client) => {
      await assert.rejects(
        () => client.request("server.status", {}, { timeoutMs: 500 }),
        (error: unknown) => error instanceof HcSubagentError && error.code === "unavailable",
      );
      raw = `${JSON.stringify({ jsonrpc: "2.0", id: 1, nothing: true })}\n`;
      await assert.rejects(() => client.request("server.status", {}, { timeoutMs: 500 }));
    },
  );
});

test("run translates camelCase wire names and never sends unknown keys", async () => {
  await withServer(
    () => ({ result: terminalFixture({ name: "hc-scout-1234" }) }),
    async (server, client) => {
      await client.run({
        argv: ["pi", "@task.md"],
        cwd: "/repo",
        env: { PATH: "/bin" },
        name: "hc-scout-1234",
        labels: { a: "b" },
        parent: "t3",
        noNotify: true,
        outliveParent: false,
        rm: false,
        wait: false,
      });
      const params = server.requests[0]?.params ?? {};
      assert.equal(params.no_notify, true);
      assert.equal(params.outlive_parent, false);
      assert.equal(params.parent, "t3");
      assert.equal(params.caller, "t3");
      assert.equal(params.wait, false);
      assert.equal(params.noNotify, undefined);
      assert.equal(params.onlyIf, undefined);
    },
  );
});

test("send maps onlyIf to if and timeout to seconds, never force", async () => {
  await withServer(
    () => ({ result: { turn: 4, started: true, status: "working", wait: null } }),
    async (server, client) => {
      const sent = await client.send("t12", "focus", { wait: true, onlyIf: "idle", timeoutSeconds: 30 });
      assert.equal(sent.turn, 4);
      const params = server.requests[0]?.params ?? {};
      assert.equal(params.if, "idle");
      assert.equal(params.timeout, 30);
      assert.equal(params.force, undefined);
    },
  );
});

test("label maps null to an empty value", async () => {
  await withServer(
    () => ({ result: terminalFixture() }),
    async (server, client) => {
      await client.label("t12", { keep: "yes", gone: null });
      assert.deepEqual(server.requests[0]?.params, { terminal: "t12", labels: { keep: "yes", gone: "" } });
    },
  );
});

test("list and read decode typed results", async () => {
  await withServer(
    (method) => {
      if (method === "terminal.list") {
        return { result: { terminals: [terminalFixture()], hidden_finished: 2 } };
      }
      return { result: { text: "hello", complete: false, how: "screen", why: "working" } };
    },
    async (_server, client) => {
      const list = await client.list({ all: true });
      assert.equal(list.terminals.length, 1);
      assert.equal(list.hiddenFinished, 2);
      const read = await client.read("t12", 40);
      assert.equal(read.text, "hello");
      assert.equal(read.complete, false);
      assert.equal(read.why, "working");
    },
  );
});

test("decoders reject malformed terminal records with protocol errors", () => {
  assert.throws(() => decodeTerminal({}), (error: unknown) => error instanceof HcSubagentError && error.code === "protocol");
  assert.throws(
    () => decodeTerminal({ address: "t1", state: "zombie" }),
    (error: unknown) => error instanceof HcSubagentError && error.code === "protocol",
  );
  assert.throws(() => decodeWaitResult({ reason: "x" }));
});

test("decodeCoreEvent keeps unknown types and decodes snapshots", () => {
  const event = decodeCoreEvent({ type: "created", seq: 7, terminal: terminalFixture() });
  assert.equal(event.type, "created");
  assert.equal(event.seq, 7);
  assert.equal(event.terminal?.address, "t12");
  const unknown = decodeCoreEvent({ type: "future.thing", seq: 8, extra: 1 });
  assert.equal(unknown.type, "future.thing");
  assert.equal(unknown.extra, 1);
});

test("line framing handles partial lines and CRLF", () => {
  assert.deepEqual(splitCompleteLines("a\nb\r\nc"), { lines: ["a", "b"], remainder: "c" });
  const decoder = new LineDecoder();
  assert.deepEqual(decoder.push('{"a":'), []);
  assert.deepEqual(decoder.push("1}\n"), ['{"a":1}']);
  assert.equal(decoder.partial, "");
  assert.deepEqual(splitJsonlText("junk\n{\"x\":1}\npartial", { dropLeadingPartial: true }), {
    lines: ['{"x":1}'],
    partialLastLine: "partial",
  });
});

test("compareVersions handles the minimum-core guard", () => {
  assert.equal(compareVersions("0.1.21", "0.1.16"), 1);
  assert.equal(compareVersions("0.1.16", "0.1.16"), 0);
  assert.equal(compareVersions("0.1.9", "0.1.16"), -1);
  assert.equal(compareVersions("v1.0.0", "0.9.9"), 1);
});

test("contract list names the methods the client relies on", () => {
  assert.deepEqual(Object.keys(HC_METHODS).sort(), [
    "server.status",
    "terminal.get",
    "terminal.interrupt",
    "terminal.kill",
    "terminal.label",
    "terminal.list",
    "terminal.read",
    "terminal.rm",
    "terminal.run",
    "terminal.send",
  ]);
});

test("createCoreClient prefers the hc environment over a configured socket", () => {
  const inside = createCoreClient({ HC_TERMINAL_SOCKET: "/tmp/env.sock" }, "/tmp/config.sock");
  assert.equal(inside.socketPath, "/tmp/env.sock");

  const outside = createCoreClient({}, "/tmp/config.sock");
  assert.equal(outside.socketPath, "/tmp/config.sock");
  assert.equal(outside.caller, null);

  const none = createCoreClient({}, null);
  assert.equal(none.socketPath, null);
});

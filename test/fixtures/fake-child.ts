/**
 * Test-only fake child.
 *
 * Launched by integration tests through PI_HC_SUBAGENTS_TEST_CHILD. It speaks
 * the same argv surface as a pi child, emits OSC 7501 status words, writes a
 * synthetic pi session JSONL, and stays alive so the terminal remains live.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { NOTIFICATION_VERSION } from "../../src/child/pipe-protocol.ts";
import { startChildPipeServer, type ChildPipeServer } from "../../src/child/pipe-server.ts";

type Mode =
  | "success"
  | "error"
  | "blocked"
  | "blocked-success"
  | "startup-idle"
  | "empty"
  | "length"
  | "aborted"
  | "tooluse"
  | "silent"
  | "exit-early"
  | "task"
  | "pipe"
  | "pipe-streaming"
  | "pipe-push"
  | "pipe-flat-turn"
  | "slow-settle";

function parseArgs(argv: string[]): { sessionId: string; sessionDir: string; name: string; taskFile: string | null } {
  let sessionId = "";
  let sessionDir = "";
  let name = "";
  let taskFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--session-id") sessionId = argv[++i] ?? "";
    else if (arg === "--session-dir") sessionDir = argv[++i] ?? "";
    else if (arg === "--name") name = argv[++i] ?? "";
    else if (arg.startsWith("@")) taskFile = arg.slice(1);
  }
  return { sessionId, sessionDir, name, taskFile };
}

function emitStatus(state: string, message: string, kind?: string): void {
  const pairs = [`state=${state}`, "app=pi"];
  if (kind) pairs.push(`kind=${kind}`);
  pairs.push(`msg=${Buffer.from(message, "utf8").toString("base64")}`);
  process.stdout.write(`\x1b]7501;${pairs.join(":")}\x1b\\`);
}

function mode(): Mode {
  const value = process.env.PI_HC_TEST_CHILD_MODE;
  switch (value) {
    case "error":
    case "blocked":
    case "blocked-success":
    case "startup-idle":
    case "empty":
    case "length":
    case "aborted":
    case "tooluse":
    case "silent":
    case "exit-early":
    case "task":
    case "pipe":
    case "pipe-streaming":
    case "pipe-push":
    case "pipe-flat-turn":
    case "slow-settle":
      return value;
    default:
      return "success";
  }
}

function usage(): Record<string, unknown> {
  return {
    input: 100,
    output: 50,
    cacheRead: 10,
    cacheWrite: 5,
    totalTokens: 165,
    cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033 },
  };
}

function writeSession(options: {
  sessionDir: string;
  sessionId: string;
  taskText: string;
  stopReason: "stop" | "error" | "length" | "aborted" | "toolUse";
  text: string;
  finalAfterMs?: number;
  followUp?: string;
  existingFile?: string;
}): string {
  mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = options.existingFile ?? path.join(options.sessionDir, `${stamp}_${options.sessionId}.jsonl`);
  const iso = new Date().toISOString();
  const now = Date.now();
  const entries: unknown[] = [
    { type: "session", version: 3, id: options.sessionId, timestamp: iso, cwd: process.cwd() },
    {
      type: "message",
      id: "sys00001",
      parentId: null,
      timestamp: iso,
      message: { role: "system", content: "", timestamp: now },
    },
    {
      type: "message",
      id: "usr00001",
      parentId: "sys00001",
      timestamp: iso,
      message: { role: "user", content: options.taskText, timestamp: now + 1 },
    },
  ];
  const assistant = (id: string, parentId: string, stopReason: string, text: string, offset: number) => ({
    type: "message",
    id,
    parentId,
    timestamp: iso,
    message: {
      role: "assistant",
      content: text.length > 0 ? [{ type: "text", text }] : [],
      api: "fake",
      provider: "fake",
      model: "fake-model",
      usage: usage(),
      stopReason,
      ...(stopReason === "error" ? { errorMessage: "fake provider exploded" } : {}),
      timestamp: now + offset,
    },
  });
  entries.push(assistant("ast00001", "usr00001", options.stopReason, options.text, 2));
  let assistantParent = "ast00001";
  if (options.followUp !== undefined) {
    entries.push({
      type: "message",
      id: "usr00002",
      parentId: "usr00001",
      timestamp: iso,
      message: { role: "user", content: options.followUp, timestamp: now + 3 },
    });
    assistantParent = "usr00002";
  }
  if (options.followUp !== undefined) {
    entries.push(assistant("ast00002", assistantParent, options.stopReason, options.text, 4));
  }
  if (options.stopReason === "toolUse" && options.finalAfterMs !== undefined) {
    entries.push(assistant("ast00002", "ast00001", "stop", options.text || "final after tool use", 100));
  }
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
  return file;
}

const args = parseArgs(process.argv.slice(2));
const selectedMode = mode();
const keepAlive = setInterval(() => {}, 1 << 30);

let pipeServer: ChildPipeServer | null = null;
let fakeSessionFile: string | null = null;
let lastPipeText = "Fake pipe result.";
let pipeTurns = 0;

function shutdown(code = 0): void {
  void pipeServer?.stop().finally(() => process.exit(code));
  setTimeout(() => process.exit(code), 300).unref?.();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

async function startFakePipe(): Promise<void> {
  const name = process.env.PI_HC_PIPE ?? "";
  if (!name) {
    emitStatus("error", "PI_HC_PIPE is missing");
    return;
  }
  pipeServer = await startChildPipeServer({
    name,
    handlers: {
      ping: () => ({ turn: pipeTurns }),
      prompt: async (text) => {
        lastPipeText = `Fake prompt result: ${actualTask(text)}`;
        return { turn: pipeTurns };
      },
      followUp: async (text) => {
        pipeTurns++;
        lastPipeText = `Fake follow-up result: ${actualTask(text)}`;
        // `pipe-flat-turn` fails the follow-up without re-entering `working`, so
        // hc's turn counter does not advance: two settles share one turn and
        // only the settle time tells them apart.
        const flatTurn = selectedMode === "pipe-flat-turn";
        fakeSessionFile = writeSession({
          sessionDir: args.sessionDir,
          sessionId: args.sessionId,
          taskText: actualTask(taskText),
          stopReason: flatTurn ? "error" : "stop",
          text: lastPipeText,
          followUp: actualTask(text),
          ...(fakeSessionFile === null ? {} : { existingFile: fakeSessionFile }),
        });
        if (flatTurn) {
          emitStatus("error", "fake follow-up failed");
          return { turn: pipeTurns };
        }
        emitStatus("working", args.name || "fake child");
        setTimeout(() => emitStatus("done", args.name || "fake child"), 100);
        return { turn: pipeTurns };
      },
      interrupt: async () => {
        emitStatus("idle", args.name || "fake child");
        return { turn: pipeTurns };
      },
      shutdown: async () => {
        setTimeout(() => shutdown(0), 50);
        return {};
      },
      result: async () => ({
        text: lastPipeText,
        state: "completed",
        outcome: "stop",
        sessionFile: fakeSessionFile,
      }),
    },
  });
}

if (args.taskFile) {
  const runDir = path.dirname(args.taskFile);
  try {
    writeFileSync(
      path.join(runDir, "child-args.json"),
      `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid }, null, 2)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(runDir, "child-env.json"),
      `${JSON.stringify(
        {
          PI_HC_SUBAGENT: process.env.PI_HC_SUBAGENT ?? null,
          PI_HC_RUN_ID: process.env.PI_HC_RUN_ID ?? null,
          PI_HC_CHILD_ID: process.env.PI_HC_CHILD_ID ?? null,
          PI_HC_PARENT_SESSION: process.env.PI_HC_PARENT_SESSION ?? null,
          HC_TERMINAL_ID: process.env.HC_TERMINAL_ID ?? null,
          HC_SESSION: process.env.HC_SESSION ?? null,
          PI_SESSION_ID: process.env.PI_SESSION_ID ?? null,
          PI_MODEL: process.env.PI_MODEL ?? null,
          PI_PROVIDER: process.env.PI_PROVIDER ?? null,
          hasPath: typeof process.env.PATH === "string" && process.env.PATH.length > 0,
          hasAnthropicKey: typeof process.env.ANTHROPIC_API_KEY === "string",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Diagnostics only; keep the mode behavior.
  }
}

const taskText = args.taskFile ? readFileSync(args.taskFile, "utf8") : "fake task";

function actualTask(text: string): string {
  const match = text.match(/# Delegated task\n\n([\s\S]*?)\n\n## Context/);
  return (match?.[1] ?? text).trim();
}

function finishAndStayAlive(): void {
  // Keep the terminal live so status/turn remain observable after settling.
  setTimeout(() => {}, 60_000);
}

switch (selectedMode) {
  case "startup-idle":
    emitStatus("idle", args.name || "fake child");
    finishAndStayAlive();
    break;
  case "silent":
    finishAndStayAlive();
    break;
  case "blocked":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      emitStatus("blocked", "Allow the fake permission?", "permission");
    }, 100);
    finishAndStayAlive();
    break;
  case "blocked-success":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => emitStatus("blocked", "Allow the fake permission?", "permission"), 100);
    setTimeout(() => emitStatus("working", args.name || "fake child"), 500);
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText,
        stopReason: "stop",
        text: "Fake child result after unblock.",
      });
      emitStatus("done", args.name || "fake child");
    }, 700);
    finishAndStayAlive();
    break;
  case "error":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText,
        stopReason: "error",
        text: "",
      });
      emitStatus("error", "fake provider exploded");
    }, 100);
    finishAndStayAlive();
    break;
  case "empty":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText,
        stopReason: "stop",
        text: "",
      });
      emitStatus("done", args.name || "fake child");
    }, 100);
    finishAndStayAlive();
    break;
  case "length":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText,
        stopReason: "length",
        text: "truncated result ".repeat(30),
      });
      emitStatus("done", args.name || "fake child");
    }, 100);
    finishAndStayAlive();
    break;
  case "aborted":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText,
        stopReason: "aborted",
        text: "partial",
      });
      emitStatus("idle", args.name || "fake child");
    }, 100);
    finishAndStayAlive();
    break;
  case "tooluse":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText,
        stopReason: "toolUse",
        text: "",
        finalAfterMs: 100,
      });
    }, 100);
    setTimeout(() => emitStatus("done", args.name || "fake child"), 350);
    finishAndStayAlive();
    break;
  case "slow-settle": {
    // Settles after a configurable delay, or quickly when the task says QUICK.
    // Used by timeout/monitor tests to keep a write child alive past a short wait.
    const task = actualTask(taskText);
    const quick = /\bQUICK\b/i.test(task);
    const configured = Number(process.env.PI_HC_TEST_CHILD_SETTLE_MS ?? "2000");
    const delay = quick ? 100 : Number.isFinite(configured) ? Math.max(250, configured) : 2000;
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText: task,
        stopReason: "stop",
        text: quick ? "Fake quick result." : "Fake slow result.",
      });
      emitStatus("done", args.name || "fake child");
    }, delay);
    finishAndStayAlive();
    break;
  }
  case "slow-settle": {
    // Settles after a configurable delay, or quickly when the task says QUICK.
    // Used by timeout/monitor tests to keep a write child alive past a short wait.
    const task = actualTask(taskText);
    const quick = /\bQUICK\b/i.test(task);
    const configured = Number(process.env.PI_HC_TEST_CHILD_SETTLE_MS ?? "2000");
    const delay = quick ? 100 : Number.isFinite(configured) ? Math.max(250, configured) : 2000;
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText: task,
        stopReason: "stop",
        text: quick ? "Fake quick result." : "Fake slow result.",
      });
      emitStatus("done", args.name || "fake child");
    }, delay);
    finishAndStayAlive();
    break;
  }
  case "exit-early":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => process.exit(3), 150);
    break;
  case "pipe":
  case "pipe-flat-turn":
    emitStatus("working", args.name || "fake child");
    void startFakePipe()
      .then(() => {
        setTimeout(() => {
          fakeSessionFile = writeSession({
            sessionDir: args.sessionDir,
            sessionId: args.sessionId,
            taskText: actualTask(taskText),
            stopReason: "stop",
            text: "Fake initial result.",
          });
          setTimeout(() => emitStatus("done", args.name || "fake child"), 100);
        }, 150);
      })
      .catch(() => emitStatus("error", "fake pipe failed"));
    finishAndStayAlive();
    break;
  case "pipe-streaming":
    emitStatus("working", args.name || "fake child");
    void startFakePipe().catch(() => emitStatus("error", "fake pipe failed"));
    finishAndStayAlive();
    break;
  case "pipe-push":
    // Settles in one turn and broadcasts exactly one Phase-1 `settled` frame so
    // an integration test can prove the parent woke on push, not on its poll.
    // The frame is broadcast after `done`, matching child.ts (agent_settled
    // fires once the terminal already reports the settled turn).
    emitStatus("working", args.name || "fake child");
    void startFakePipe()
      .then(() => {
        setTimeout(() => {
          fakeSessionFile = writeSession({
            sessionDir: args.sessionDir,
            sessionId: args.sessionId,
            taskText: actualTask(taskText),
            stopReason: "stop",
            text: "Fake push result.",
          });
          emitStatus("done", args.name || "fake child");
          setTimeout(() => {
            pipeServer?.broadcast({
              type: "settled",
              v: NOTIFICATION_VERSION,
              turn: pipeTurns,
              status: "completed",
              ...(fakeSessionFile === null ? {} : { sessionFile: fakeSessionFile }),
              at: new Date().toISOString(),
            });
          }, 150);
        }, 1_500);
      })
      .catch(() => emitStatus("error", "fake pipe failed"));
    finishAndStayAlive();
    break;
  case "task": {
    const task = actualTask(taskText);
    const fails = /\bFAIL\b/i.test(task);
    const slow = /\bSLOW\b/i.test(task);
    emitStatus("working", args.name || "fake child");
    setTimeout(
      () => {
        writeSession({
          sessionDir: args.sessionDir,
          sessionId: args.sessionId,
          taskText: task,
          stopReason: fails ? "error" : "stop",
          text: fails ? "" : `Handled task: ${task}`,
        });
        setTimeout(() => emitStatus(fails ? "error" : "done", fails ? "fake task failed" : args.name || "fake child"), 100);
      },
      slow ? 700 : 100,
    );
    finishAndStayAlive();
    break;
  }
  case "success":
  default:
    emitStatus("working", args.name || "fake child");
    setTimeout(() => {
      writeSession({
        sessionDir: args.sessionDir,
        sessionId: args.sessionId,
        taskText,
        stopReason: "stop",
        text: "Fake child result: task complete.",
      });
      setTimeout(() => emitStatus("done", args.name || "fake child"), 100);
    }, 100);
    finishAndStayAlive();
    break;
}

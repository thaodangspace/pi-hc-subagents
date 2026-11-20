/**
 * Test-only fake child.
 *
 * Launched by integration tests through PI_HC_SUBAGENTS_TEST_CHILD. It speaks
 * the same argv surface as a pi child, emits OSC 7501 status words, writes a
 * synthetic pi session JSONL, and stays alive so the terminal remains live.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type Mode =
  | "success"
  | "error"
  | "blocked"
  | "startup-idle"
  | "empty"
  | "length"
  | "aborted"
  | "tooluse"
  | "silent"
  | "exit-early";

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
    case "startup-idle":
    case "empty":
    case "length":
    case "aborted":
    case "tooluse":
    case "silent":
    case "exit-early":
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
}): string {
  mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(options.sessionDir, `${stamp}_${options.sessionId}.jsonl`);
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
  if (options.stopReason === "toolUse" && options.finalAfterMs !== undefined) {
    entries.push(assistant("ast00002", "ast00001", "stop", options.text || "final after tool use", 100));
  }
  writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { mode: 0o600 });
  return file;
}

const args = parseArgs(process.argv.slice(2));
const selectedMode = mode();
const keepAlive = setInterval(() => {}, 1 << 30);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

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
  case "exit-early":
    emitStatus("working", args.name || "fake child");
    setTimeout(() => process.exit(3), 150);
    break;
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

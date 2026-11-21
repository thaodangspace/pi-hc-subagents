import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { NotificationSubscriptionState } from "../../src/child/pipe-transport.ts";
import { DEFAULT_CONFIG } from "../../src/config/schema.ts";
import { Registry } from "../../src/runtime/registry.ts";
import { modelFacingResult } from "../../src/runtime/result-format.ts";
import { buildResultJson, writeResultFile } from "../../src/runtime/result-store.ts";
import type { ExtensionRuntime } from "../../src/runtime/runtime.ts";
import { SettleHintHub } from "../../src/runtime/settle-hints.ts";
import type { SubagentRecord } from "../../src/runtime/types.ts";
import type { ToolSession } from "../../src/tools/session.ts";
import { registerHcSubagentsCommand } from "../../src/ui/command.ts";

const SUMMARY_RE =
  /^settle hints: mode=(push|poll) hints=\d+ wakes=\d+ falseWakes=\d+ stale=\d+ dup=\d+ reconnects=\d+ degraded=(true|false)$/;

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    version: 1,
    runId: "run-1",
    childId: "child-1",
    parentSessionId: "parent-a",
    agent: "reviewer",
    agentSource: "user",
    agentAccess: "read-only",
    cwd: "/repo",
    terminal: "t12",
    terminalName: "hc-reviewer-a1b2",
    sessionId: "child-1",
    sessionFile: null,
    runDir: "/runs/run-1",
    resultFile: "/runs/run-1/result.json",
    state: "working",
    terminalState: "live",
    coreStatus: "working",
    slug: "reviewer-a1b2",
    turn: 1,
    turns: [
      {
        index: 1,
        task: "SECRET TASK TEXT",
        startedAt: "2026-11-20T12:00:00.000Z",
        baselineTurn: 0,
        state: "running",
        terminal: "t12",
      },
    ],
    createdAt: "2026-11-20T12:00:00.000Z",
    updatedAt: "2026-11-20T12:00:00.000Z",
    labels: {},
    background: true,
    origin: "tool",
    ...overrides,
  };
}

function hubWithOpenEpisode(childId = "child-1", frameCount = 1): SettleHintHub {
  let emit: ((turn: number) => void) | undefined;
  const subscription = {
    path: "/tmp/pi-hc-tests/fake.sock",
    state: "open" as NotificationSubscriptionState,
    reconnects: 0,
    lastError: null,
    close() {
      subscription.state = "closed";
    },
  };
  const hub = new SettleHintHub({
    transport: (input) => {
      emit = (turn) =>
        input.onSettled({
          type: "settled",
          v: 1,
          turn,
          status: "completed",
          at: "2026-11-21T00:00:00.000Z",
        });
      return subscription;
    },
  });
  hub.start(childId, `pi-hc-0123456789abcdef-${childId}`);
  for (let turn = 1; turn <= frameCount; turn += 1) emit?.(turn);
  return hub;
}

function harness(
  options: {
    wakeOnSettle?: boolean;
    hub?: SettleHintHub;
    record?: boolean;
    recordOverrides?: Partial<SubagentRecord>;
  } = {},
): {
  run: (args: string) => Promise<void>;
  notifications: Array<{ message: string; type?: string }>;
} {
  const registry = new Registry();
  if (options.record !== false) registry.create(record(options.recordOverrides));
  const config = { ...DEFAULT_CONFIG, wakeOnSettle: options.wakeOnSettle ?? true };
  const runtime = {
    available: true,
    mode: "ready",
    prerequisites: { available: true, coreVersion: "0.1.21", minimumVersion: "0.1.0" },
    config,
    loadedConfig: {
      config,
      warnings: [],
      paths: {
        global: "/tmp/agent/hc-subagents.json",
        project: "/repo/.pi/hc-subagents.json",
        projectIgnored: false,
        globalExists: false,
        projectExists: true,
      },
    },
    agentDirs: { user: "/tmp/agent/agents", project: null, package: "/tmp/package/agents" },
    parentSessionId: "parent-a",
  } as unknown as ExtensionRuntime;

  const session: ToolSession = {
    runtime,
    registry,
    scheduler: null as unknown as ToolSession["scheduler"],
    ...(options.hub === undefined ? {} : { settleHints: options.hub }),
  };

  const notifications: Array<{ message: string; type?: string }> = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const pi = {
    registerCommand(name: string, definition: unknown) {
      commands.set(name, definition as { handler: (args: string, ctx: unknown) => Promise<void> });
    },
  };
  registerHcSubagentsCommand(pi as never, {
    getSession: () => session,
    getRuntime: () => runtime,
  });
  const command = commands.get("hc-subagents");
  assert.ok(command, "the command is registered");

  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, ...(type === undefined ? {} : { type }) });
      },
    },
  };

  return {
    async run(args: string) {
      await command.handler(args, ctx);
    },
    notifications,
  };
}

function summaryLine(notifications: Array<{ message: string }>): string {
  const message = notifications.at(-1)?.message ?? "";
  const matches = message.split("\n").filter((line) => line.startsWith("settle hints:"));
  assert.equal(matches.length, 1, "exactly one settle hints line");
  const line = matches[0] ?? "";
  assert.match(line, SUMMARY_RE);
  return line;
}

test("/hc-subagents config prints exactly one bounded settle hints line", async () => {
  const harnessed = harness({ hub: hubWithOpenEpisode() });
  await harnessed.run("config");

  assert.equal(harnessed.notifications.length, 1);
  const message = harnessed.notifications[0]?.message ?? "";
  const line = summaryLine(harnessed.notifications);
  assert.equal(
    line,
    "settle hints: mode=push hints=1 wakes=0 falseWakes=0 stale=0 dup=0 reconnects=0 degraded=false",
  );
  assert.equal(line.includes("\n"), false);
  assert.ok(line.length < 200);
  // The line is appended after the diagnostics block and is the last line.
  assert.equal(message.split("\n").at(-1), line);
  // No task text, child id, or work path may leak into the summary line.
  for (const forbidden of ["SECRET TASK TEXT", "child-1", "/runs", "/tmp", '"task"']) {
    assert.equal(line.includes(forbidden), false, `summary must not contain ${forbidden}`);
  }
});

test("/hc-subagents config reports poll mode with wakeOnSettle disabled", async () => {
  const harnessed = harness({ wakeOnSettle: false, hub: hubWithOpenEpisode() });
  await harnessed.run("config");

  assert.equal(
    summaryLine(harnessed.notifications),
    "settle hints: mode=poll hints=0 wakes=0 falseWakes=0 stale=0 dup=0 reconnects=0 degraded=false",
  );
});

test("/hc-subagents config prints the zero line without a hub or children", async () => {
  const empty = harness({ hub: undefined });
  await empty.run("config");
  assert.equal(
    summaryLine(empty.notifications),
    "settle hints: mode=poll hints=0 wakes=0 falseWakes=0 stale=0 dup=0 reconnects=0 degraded=false",
  );

  const noChildren = harness({ hub: hubWithOpenEpisode(), record: false });
  await noChildren.run("config");
  assert.equal(
    summaryLine(noChildren.notifications),
    "settle hints: mode=push hints=0 wakes=0 falseWakes=0 stale=0 dup=0 reconnects=0 degraded=false",
  );
});

test("/hc-subagents result prints the persisted summary the model saw", async () => {
  const root = await mkdtemp(path.join("/tmp", "hc-command-summary-"));
  const resultFile = path.join(root, "result.json");
  const summary = [
    "Status: done.",
    "Changed: src/ui/command.ts:170 — preferred the persisted summary.",
    "Next: none.",
  ].join("\n");
  const narration = Array.from(
    { length: 120 },
    (_, index) => `NARRATION ${index} ${"reading files and thinking ".repeat(6)}`,
  ).join("\n");
  try {
    await writeResultFile(
      resultFile,
      buildResultJson({
        childId: "child-1",
        turn: 1,
        state: "completed",
        outcome: "stop",
        text: narration,
        sessionFile: "/runs/run-1/sessions/child-1.jsonl",
        terminal: "t12",
        startedAt: "2026-11-20T12:00:00.000Z",
        settledAt: "2026-11-20T12:01:00.000Z",
        summary,
      }),
    );
    const harnessed = harness({
      recordOverrides: { resultFile, state: "completed", terminalState: "finished" },
    });
    await harnessed.run("result child-1");

    assert.equal(harnessed.notifications.length, 1);
    // The command prints the model-facing body, not the child's raw narration.
    assert.equal(harnessed.notifications[0]?.message, modelFacingResult(summary).text);
    assert.ok(!(harnessed.notifications[0]?.message ?? "").includes("NARRATION"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

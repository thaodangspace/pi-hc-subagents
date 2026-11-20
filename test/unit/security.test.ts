import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { buildSpawnPlan } from "../../src/child/child-command.ts";
import { createRunMetadata, writeRunMetadata } from "../../src/child/child-spawn.ts";
import { createRunPaths } from "../../src/child/paths.ts";
import { HC_METHODS } from "../../src/core/core-client.ts";
import { decodePipeRequest } from "../../src/child/pipe-protocol.ts";

const TASK_SECRET = "SECRET TASK INSTRUCTIONS";
const RESULT_SECRET = "SECRET RESULT TEXT";
const API_SECRET = "sk-ant-secret-should-not-be-in-files";

function reviewerAgent(): AgentDefinition {
  return {
    name: "reviewer",
    description: "Read-only review",
    systemPrompt: "review",
    tools: ["read", "grep"],
    access: "read-only",
    source: "user",
    filePath: "/agents/reviewer.md",
  };
}

test("child environment keeps provider credentials but strips parent identity markers", async () => {
  const cwd = await mkdtemp(path.join("/tmp", "hc-security-cwd-"));
  try {
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(cwd, "runs"),
      runId: "r1",
      childId: "11111111-2222-4333-8444-555555555555",
      randomSuffix: () => "abcd",
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: TASK_SECRET,
      cwd,
      paths,
      parentTerminalId: "t3",
      parentSessionId: "parent-session",
      trust: { projectTrusted: true, parentCwd: cwd },
      env: {
        PATH: "/bin",
        ANTHROPIC_API_KEY: API_SECRET,
        OPENAI_API_KEY: "openai-secret",
        HC_TERMINAL_ID: "t3",
        HC_TERMINAL_SOCKET: "/tmp/core.sock",
        PI_SESSION_ID: "stale-session",
        PI_SESSION_FILE: "/tmp/stale.jsonl",
      },
      piInvocation: ["/opt/pi/bin/pi"],
    });

    assert.equal(plan.env.ANTHROPIC_API_KEY, API_SECRET);
    assert.equal(plan.env.OPENAI_API_KEY, "openai-secret");
    assert.equal(plan.env.PATH, "/bin");
    assert.equal(plan.env.HC_TERMINAL_ID, undefined);
    assert.equal(plan.env.HC_TERMINAL_SOCKET, undefined);
    assert.equal(plan.env.PI_SESSION_ID, "");
    assert.equal(plan.env.PI_SESSION_FILE, "");
    assert.equal(plan.env.PI_HC_SUBAGENT, "1");
    assert.equal(plan.env.PI_HC_PARENT_SESSION, "parent-session");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run metadata contains no environment, task text, or provider secret and is 0600", async () => {
  const cwd = await mkdtemp(path.join("/tmp", "hc-security-meta-"));
  try {
    const paths = createRunPaths({
      agentName: "reviewer",
      runsRoot: path.join(cwd, "runs"),
      runId: "r1",
      childId: "11111111-2222-4333-8444-555555555555",
      randomSuffix: () => "abcd",
    });
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: TASK_SECRET,
      cwd,
      paths,
      parentTerminalId: "t3",
      parentSessionId: "parent-session",
      trust: { projectTrusted: true, parentCwd: cwd },
      env: { PATH: "/bin", ANTHROPIC_API_KEY: API_SECRET },
      piInvocation: ["/opt/pi/bin/pi"],
    });
    const metadata = createRunMetadata(plan, { origin: "test", provider: "hc-local" });
    const serialized = JSON.stringify(metadata);
    assert.equal(serialized.includes(TASK_SECRET), false, "task text never lands in run.json");
    assert.equal(serialized.includes(RESULT_SECRET), false, "result text never lands in run.json");
    assert.equal(serialized.includes(API_SECRET), false, "provider secrets never land in run.json");
    assert.equal(serialized.includes("ANTHROPIC_API_KEY"), false);
    assert.equal(metadata.provider, "hc-local");

    await writeRunMetadata(paths, metadata);
    assert.equal((await stat(paths.runFile)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.runDir)).mode & 0o777, 0o700);
    const written = await readFile(paths.runFile, "utf8");
    assert.equal(written.includes(TASK_SECRET), false);
    assert.equal(written.includes(API_SECRET), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("force is never part of the send surface or the private pipe protocol", () => {
  assert.equal((HC_METHODS["terminal.send"] as readonly string[]).includes("force"), false);
  const request = decodePipeRequest(
    JSON.stringify({ type: "follow_up", id: "r1", text: "continue", steer: true, force: true }),
  );
  assert.deepEqual(request, { type: "follow_up", id: "r1", text: "continue", steer: true });
  assert.equal("force" in request, false);
});

test("force is ignored by the pipe decoder for prompt and follow_up", () => {
  const blocked = decodePipeRequest(
    JSON.stringify({ type: "prompt", id: "r2", text: "answer the dialog", force: true }),
  );
  assert.equal("force" in blocked, false);
});

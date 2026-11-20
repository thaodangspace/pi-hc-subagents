import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import type { AgentDefinition } from "../../src/agents/agents.ts";
import { HcSubagentError } from "../../src/core/error.ts";
import { buildSpawnPlan, isCwdInside, MAX_TASK_BYTES } from "../../src/child/child-command.ts";
import { buildSystemFile, buildTaskFile, DELEGATION_CONTRACT } from "../../src/child/child-prompt.ts";
import { createRunPaths, sanitizeSessionName, sanitizeTerminalName } from "../../src/child/paths.ts";
import { getPiInvocation } from "../../src/child/pi-invocation.ts";

const CHILD_ID = "11111111-2222-4333-8444-555555555555";
const FIXED_NOW = new Date("2026-11-20T03:40:08.000Z");
const deterministicSuffix = (bytes: number): string => (bytes === 3 ? "a1b2c3" : "9f0e");

function reviewerAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "reviewer",
    description: "Read-only review",
    systemPrompt: "You are a reviewer.",
    tools: ["read", "grep"],
    access: "read-only",
    model: "anthropic/claude-sonnet-4-5",
    thinking: "medium",
    skills: ["skill-one"],
    extensions: ["./ext-one.ts"],
    source: "user",
    filePath: "/agents/reviewer.md",
    ...overrides,
  };
}

async function scratchCwd(name = "hc plan"): Promise<string> {
  return mkdtemp(path.join("/tmp", `${name}-`));
}

function pathsFor(agentName = "reviewer") {
  return createRunPaths({
    agentName,
    runsRoot: "/tmp/hc-runs",
    now: FIXED_NOW,
    runId: "20261120T034008Z-a1b2c3",
    childId: CHILD_ID,
    randomSuffix: deterministicSuffix,
  });
}

test("run paths are deterministic and bounded", () => {
  const paths = pathsFor();
  assert.equal(paths.runId, "20261120T034008Z-a1b2c3");
  assert.equal(paths.childId, CHILD_ID);
  assert.equal(paths.slug, "reviewer-9f0e");
  assert.equal(paths.terminalName, "hc-reviewer-9f0e");
  assert.equal(paths.runDir, "/tmp/hc-runs/20261120T034008Z-a1b2c3");
  assert.equal(paths.sessionDir, `${paths.runDir}/sessions`);
  assert.equal(paths.taskFile, `${paths.runDir}/task.md`);
  assert.equal(paths.systemFile, `${paths.runDir}/system.md`);
  assert.equal(paths.resultFile, `${paths.runDir}/result.json`);

  const longName = pathsFor("A Very Long Agent Name With Symbols !!!");
  assert.ok(longName.terminalName.length <= 32);
  assert.match(longName.terminalName, /^[a-z0-9\-_.]+$/);
  assert.ok(longName.sessionName.length <= 80);
});

test("terminal and session names are sanitized", () => {
  assert.equal(sanitizeTerminalName("Bad Name!"), "bad-name");
  assert.equal(sanitizeTerminalName("---"), "hc-child");
  assert.equal(sanitizeTerminalName("x".repeat(60)).length, 32);
  assert.ok(sanitizeSessionName("a\u0000b\nc").length <= 80);
  assert.equal(sanitizeSessionName("\u0000"), "pi-hc-subagent");
});

test("argv order is exact and @task.md is last", async () => {
  const cwd = await scratchCwd();
  try {
    const paths = pathsFor();
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "Review src/index.ts",
      cwd,
      paths,
      parentTerminalId: "t3",
      parentSessionId: "parent-session",
      trust: { projectTrusted: true, parentCwd: cwd },
      excludeTools: ["extra_tool", "hc_subagent"],
      env: { PATH: "/bin" },
      piInvocation: ["/opt/pi/bin/pi"],
    });

    assert.deepEqual(plan.argv, [
      "/opt/pi/bin/pi",
      "--session-id",
      CHILD_ID,
      "--session-dir",
      `${paths.runDir}/sessions`,
      "--name",
      "hc-reviewer-9f0e",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "--thinking",
      "medium",
      "--tools",
      "read,grep",
      "--exclude-tools",
      "hc_subagent,hc_subagent_control,extra_tool",
      "--skill",
      "skill-one",
      "-e",
      "./ext-one.ts",
      "--append-system-prompt",
      paths.systemFile,
      "-a",
      `@${paths.taskFile}`,
    ]);
    assert.equal(plan.argv.at(-1)?.startsWith("@"), true);
    assert.equal((plan as unknown as { shell?: unknown }).shell, undefined);
    assert.equal((plan as unknown as { line?: unknown }).line, undefined);
    assert.equal(plan.trustFlag, true);
    assert.equal(plan.parent, "t3");
    assert.equal(plan.caller, "t3");
    assert.deepEqual(plan.labels, {
      "pi-hc-subagents": "1",
      "pi-hc-run": "20261120T034008Z-a1b2c3",
      "pi-hc-child": CHILD_ID,
      "pi-hc-parent": "parent-session",
      "pi-hc-agent": "reviewer",
    });
    assert.match(plan.taskContent, /# Delegated task[\s\S]*Review src\/index\.ts[\s\S]*Parent session: parent-session/);
    assert.match(plan.systemContent, /You are a reviewer\.[\s\S]*## Delegation contract/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("read-only agents without tools receive an explicit safe allowlist", async () => {
  const cwd = await scratchCwd();
  try {
    const plan = buildSpawnPlan({
      agent: reviewerAgent({ tools: undefined }),
      task: "look",
      cwd,
      paths: pathsFor(),
      parentTerminalId: "t3",
      parentSessionId: "p",
      trust: { projectTrusted: false, parentCwd: cwd },
      env: { PATH: "/bin" },
      piInvocation: ["pi"],
    });
    const index = plan.argv.indexOf("--tools");
    assert.notEqual(index, -1);
    assert.equal(plan.argv[index + 1], "read,grep,find,ls");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("child environment filters hc and stale session metadata but keeps credentials", async () => {
  const cwd = await scratchCwd();
  try {
    const plan = buildSpawnPlan({
      agent: reviewerAgent(),
      task: "look",
      cwd,
      paths: pathsFor(),
      parentTerminalId: "t3",
      parentSessionId: "parent-session",
      trust: { projectTrusted: false, parentCwd: cwd },
      env: {
        PATH: "/usr/bin",
        HOME: "/home/user",
        ANTHROPIC_API_KEY: "secret",
        HTTPS_PROXY: "http://proxy",
        HC_TERMINAL_ID: "t3",
        HC_TERMINAL_SOCKET: "/tmp/core.sock",
        HC_SESSION: "session",
        HC_SCOPE: "scope",
        PI_SESSION_ID: "stale",
        PI_SESSION_FILE: "/tmp/stale.jsonl",
        PI_PROVIDER: "openai",
        PI_MODEL: "gpt",
        PI_REASONING_LEVEL: "high",
        PI_HC_PIPE: "/tmp/stale.sock",
        KEEP: "yes",
      },
      piInvocation: ["pi"],
    });
    assert.equal(plan.env.PATH, "/usr/bin");
    assert.equal(plan.env.HOME, "/home/user");
    assert.equal(plan.env.ANTHROPIC_API_KEY, "secret");
    assert.equal(plan.env.HTTPS_PROXY, "http://proxy");
    assert.equal(plan.env.KEEP, "yes");
    for (const removed of [
      "HC_TERMINAL_ID",
      "HC_TERMINAL_SOCKET",
      "HC_SESSION",
      "HC_SCOPE",
      "PI_SESSION_ID",
      "PI_SESSION_FILE",
      "PI_PROVIDER",
      "PI_MODEL",
      "PI_REASONING_LEVEL",
      "PI_HC_PIPE",
    ]) {
      const value = plan.env[removed];
      assert.ok(value === undefined || value === "", `${removed} should be cleared`);
    }
    assert.equal(plan.env.PI_HC_SUBAGENT, "1");
    assert.equal(plan.env.PI_HC_RUN_ID, "20261120T034008Z-a1b2c3");
    assert.equal(plan.env.PI_HC_CHILD_ID, CHILD_ID);
    assert.equal(plan.env.PI_HC_PARENT_SESSION, "parent-session");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("trust flag requires a trusted project and a child cwd inside the parent", async () => {
  const cwd = await scratchCwd();
  const outside = await scratchCwd("hc-outside");
  try {
    const make = (parentCwd: string, projectTrusted: boolean, childCwd: string) =>
      buildSpawnPlan({
        agent: reviewerAgent(),
        task: "look",
        cwd: childCwd,
        paths: pathsFor(),
        parentTerminalId: "t3",
        parentSessionId: "p",
        trust: { projectTrusted, parentCwd },
        env: { PATH: "/bin" },
        piInvocation: ["pi"],
      });

    assert.equal(make(cwd, true, cwd).trustFlag, true);
    assert.equal(make(cwd, false, cwd).trustFlag, false);
    assert.equal(make(cwd, true, outside).trustFlag, false);
    assert.equal(isCwdInside("/repo", "/repo/src"), true);
    assert.equal(isCwdInside("/repo", "/repository"), false);
    assert.equal(isCwdInside("/repo", "/other"), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("validation rejects write tools on read-only agents", async () => {
  const cwd = await scratchCwd();
  try {
    assert.throws(
      () =>
        buildSpawnPlan({
          agent: reviewerAgent({ tools: ["read", "bash"] }),
          task: "look",
          cwd,
          paths: pathsFor(),
          parentTerminalId: "t3",
          parentSessionId: "p",
          trust: { projectTrusted: true, parentCwd: cwd },
          env: { PATH: "/bin" },
          piInvocation: ["pi"],
        }),
      (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("validation rejects missing cwd, empty tasks, oversized tasks, and bad session ids", async () => {
  const cwd = await scratchCwd();
  try {
    const base = {
      agent: reviewerAgent(),
      cwd,
      paths: pathsFor(),
      parentTerminalId: "t3",
      parentSessionId: "p",
      trust: { projectTrusted: false, parentCwd: cwd },
      env: { PATH: "/bin" },
      piInvocation: ["pi"],
    };
    assert.throws(
      () => buildSpawnPlan({ ...base, cwd: path.join(cwd, "missing"), task: "x" }),
      (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
    );
    assert.throws(
      () => buildSpawnPlan({ ...base, task: "   " }),
      (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
    );
    assert.throws(
      () => buildSpawnPlan({ ...base, task: "x".repeat(MAX_TASK_BYTES + 1) }),
      (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
    );
    assert.throws(
      () =>
        buildSpawnPlan({
          ...base,
          task: "x",
          paths: { ...pathsFor(), childId: "-bad-" },
        }),
      (error: unknown) => error instanceof HcSubagentError && error.code === "validation",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("project agents with extensions require trust", async () => {
  const cwd = await scratchCwd();
  try {
    assert.throws(
      () =>
        buildSpawnPlan({
          agent: reviewerAgent({ source: "project", extensions: ["./x.ts"] }),
          task: "look",
          cwd,
          paths: pathsFor(),
          parentTerminalId: "t3",
          parentSessionId: "p",
          trust: { projectTrusted: false, parentCwd: cwd },
          env: { PATH: "/bin" },
          piInvocation: ["pi"],
        }),
      (error: unknown) => error instanceof HcSubagentError && error.code === "project_agent_not_trusted",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("task and system files contain the delegation contract", () => {
  const task = buildTaskFile({
    task: "Find the bug\r\nin parser",
    parentSessionId: "p",
    cwd: "/repo",
    agentName: "reviewer",
    runId: "r1",
  });
  assert.doesNotMatch(task, /\r/);
  assert.match(task, /Find the bug\nin parser/);
  const system = buildSystemFile("");
  assert.equal(system.trim(), DELEGATION_CONTRACT);
});

test("getPiInvocation prefers the running script and falls back safely", () => {
  assert.deepEqual(
    getPiInvocation({ argv1: "/opt/pi/dist/index.js", execPath: "/usr/bin/node", exists: () => true }),
    ["/usr/bin/node", "/opt/pi/dist/index.js"],
  );
  assert.deepEqual(
    getPiInvocation({ argv1: "/$bunfs/root/pi", execPath: "/usr/bin/node", exists: () => true }),
    ["pi"],
  );
  assert.deepEqual(
    getPiInvocation({ argv1: "/missing.js", execPath: "/opt/pi/bin/pi", exists: () => false }),
    ["/opt/pi/bin/pi"],
  );
  assert.deepEqual(
    getPiInvocation({ argv1: undefined, execPath: "/usr/bin/node", exists: () => false }),
    ["pi"],
  );
});

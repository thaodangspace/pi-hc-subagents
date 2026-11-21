/**
 * Unit tests for the benchmark math, verifier, usage parser, and arm builders.
 *
 * No network, no model, no hc: every case runs on synthetic records so the
 * measured numbers cannot drift unnoticed.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareAgentDir } from "../../bench/agent-dir.ts";
import { buildArmInvocation, ORCHESTRATOR_PROMPT, SUBAGENT_TOOLS } from "../../bench/arms.ts";
import {
  bootstrapCI,
  mcnemarExact,
  pairTrials,
  passAtK,
  passHatK,
  quantile,
  summarizeArm,
  summarizePairs,
  wilsonInterval,
} from "../../bench/metrics.ts";
import { renderReport, renderScatterSvg, renderTrialsCsv } from "../../bench/report.ts";
import { checkModelAvailable, loadConfig } from "../../bench/run.ts";
import { parseSuite, verifyAnswer } from "../../bench/tasks.ts";
import {
  type TrialRecord,
  type UsageTotals,
  addUsage,
  billedTokens,
  emptyUsageTotals,
} from "../../bench/types.ts";
import { summarizeEntries } from "../../bench/usage.ts";
import { fixtureDigest, isExcluded, prepareWorkspace } from "../../bench/workspace.ts";

function usage(input: number, output: number, cacheRead: number, costUsd: number): UsageTotals {
  const totals = emptyUsageTotals();
  totals.input = input;
  totals.output = output;
  totals.cacheRead = cacheRead;
  totals.totalTokens = input + output + cacheRead;
  totals.costUsd = costUsd;
  return totals;
}

function trial(overrides: Partial<TrialRecord> & { arm: TrialRecord["arm"]; taskId: string; trial: number }): TrialRecord {
  const parentUsage = usage(overrides.parentBilled ?? 1_000, 100, 0, 0.01);
  const base: TrialRecord = {
    version: 1,
    trialKey: `${overrides.arm}-${overrides.taskId}-${overrides.trial}`,
    arm: overrides.arm,
    taskId: overrides.taskId,
    trial: overrides.trial,
    repeats: 2,
    startedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 1_000,
    exitCode: 0,
    timedOut: false,
    resolved: true,
    missing: [],
    model: "test/model",
    parent: {
      file: "/tmp/parent.jsonl",
      bytes: 1,
      turns: 2,
      usage: parentUsage,
      peakContext: overrides.parentBilled ?? 1_100,
      toolResultBytes: 500,
      assistantTextBytes: 100,
    },
    children: [],
    usage: parentUsage,
    parentBilled: billedTokens(parentUsage),
    contextAmplification: null,
    returnedShare: null,
    error: null,
  };
  return { ...base, ...overrides };
}

const suite = {
  id: "unit",
  fixture: "bench/fixture/tiny",
  agent: "scout",
  tools: ["read", "grep"],
  timeoutMs: 1_000,
  tasks: [{ id: "t1", prompt: "find the thing", expect: { all: ["src/config.ts"] } }],
};

test("pass@k and pass^k use the unbiased estimators and disagree where they should", () => {
  assert.equal(passAtK(2, 4, 2), 1 - 1 / 6);
  assert.equal(passAtK(0, 4, 2), 0);
  assert.equal(passAtK(4, 4, 2), 1);
  assert.equal(passHatK(3, 4, 2), 0.5);
  assert.equal(passHatK(1, 4, 2), 0);
  assert.equal(passHatK(4, 4, 4), 1);
});

test("quantile interpolates and rejects empty input", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([5], 0.95), 5);
  assert.equal(quantile([], 0.5), null);
});

test("wilson interval stays inside [0,1] and narrows with n", () => {
  const small = wilsonInterval(3, 4);
  const large = wilsonInterval(75, 100);
  assert.ok(small.low >= 0 && small.high <= 1);
  assert.ok(large.high - large.low < small.high - small.low);
  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 1 });
});

test("exact McNemar only fires when discordant pairs are lopsided", () => {
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(3, 3), 1);
  assert.ok(mcnemarExact(5, 0) < 0.1);
  assert.ok(mcnemarExact(2, 1) > 0.5);
});

test("bootstrap CI is deterministic per seed and contains the point estimate", () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8];
  const first = bootstrapCI(values, (sample) => sample.reduce((total, value) => total + value, 0) / sample.length, {
    resamples: 500,
    seed: 7,
  });
  const second = bootstrapCI(values, (sample) => sample.reduce((total, value) => total + value, 0) / sample.length, {
    resamples: 500,
    seed: 7,
  });
  assert.deepEqual(first, second);
  assert.ok(first && first.low <= first.high);
});

test("summarizeArm computes cost per resolved and refuses to fake it at zero", () => {
  const records = [
    trial({ arm: "solo", taskId: "a", trial: 0, resolved: true, usage: usage(1_000, 0, 0, 0.1) }),
    trial({ arm: "solo", taskId: "a", trial: 1, resolved: false, usage: usage(1_000, 0, 0, 0.1) }),
    trial({ arm: "solo", taskId: "b", trial: 0, resolved: true, usage: usage(1_000, 0, 0, 0.1) }),
    trial({ arm: "solo", taskId: "b", trial: 1, resolved: false, usage: usage(1_000, 0, 0, 0.1) }),
  ];
  const summary = summarizeArm(records);
  assert.equal(summary.trials, 4);
  assert.equal(summary.resolved, 2);
  assert.equal(summary.resolveRate, 0.5);
  assert.ok(Math.abs((summary.costPerResolved ?? 0) - 0.2) < 1e-9);
  assert.equal(summary.billedPerResolved, 2_000);
  assert.equal(summary.passHatK, 0, "no task resolved twice");

  const failed = summarizeArm(records.map((record) => ({ ...record, resolved: false })));
  assert.equal(failed.costPerResolved, null);
  assert.equal(failed.billedPerResolved, null);
});

test("summary bills children into totals but keeps parent context separate", () => {
  const parent = usage(1_000, 100, 0, 0.01);
  const childUsage = usage(5_000, 500, 0, 0.02);
  const record = trial({ arm: "subagent", taskId: "a", trial: 0, parentBilled: 1_000 });
  const total = emptyUsageTotals();
  addUsage(total, parent);
  addUsage(total, childUsage);
  const summary = summarizeArm([{ ...record, usage: total, children: [{ runId: "r", sessionFile: "/tmp/c.jsonl", state: "completed", agent: "scout", usage: childUsage, peakContext: 5_500 }] }]);
  assert.equal(summary.billed, 6_000);
  assert.equal(summary.parentBilled, 1_000);
});

test("pairTrials pairs by task and repetition and drops unpaired trials", () => {
  const solo = [
    trial({ arm: "solo", taskId: "a", trial: 0, resolved: true }),
    trial({ arm: "solo", taskId: "a", trial: 1, resolved: false }),
    trial({ arm: "solo", taskId: "b", trial: 0, resolved: true }),
  ];
  const subagent = [
    trial({ arm: "subagent", taskId: "a", trial: 0, resolved: false }),
    trial({ arm: "subagent", taskId: "a", trial: 1, resolved: true }),
  ];
  const pairs = pairTrials(solo, subagent);
  assert.equal(pairs.length, 2);
  const summary = summarizePairs(pairs);
  assert.equal(summary.leftOnly, 1);
  assert.equal(summary.rightOnly, 1);
  assert.equal(summary.mcnemarP, 1);
  assert.ok(summary.billedDeltaPct === 0);
  assert.ok(summary.billedDeltaCI);
});

test("verifyAnswer is literal, case-insensitive, whitespace-tolerant, and reports what is missing", () => {
  const ok = verifyAnswer("  Found DEFAULT_TIMEOUT_MS in SRC/Config.ts  ", { all: ["DEFAULT_TIMEOUT_MS", "src/config.ts"] });
  assert.equal(ok.resolved, true);
  assert.deepEqual(ok.missing, []);

  const missing = verifyAnswer("found it in src/config.ts", { all: ["DEFAULT_TIMEOUT_MS"] });
  assert.equal(missing.resolved, false);
  assert.deepEqual(missing.missing, ["DEFAULT_TIMEOUT_MS"]);

  const any = verifyAnswer("30_000", { any: ["30000", "30_000"] });
  assert.equal(any.resolved, true);

  const forbidden = verifyAnswer("src/config.ts and src/legacy/retry.ts", { all: ["src/config.ts"], none: ["src/legacy/retry.ts"] });
  assert.equal(forbidden.resolved, false);
});

test("parseSuite rejects duplicate ids and empty expectations", () => {
  assert.throws(() => parseSuite({ id: "x", fixture: "f", agent: "a", tools: ["read"], tasks: [{ id: "t", prompt: "p", expect: {} }] }), /empty expect/);
  assert.throws(
    () =>
      parseSuite({
        id: "x",
        fixture: "f",
        agent: "a",
        tools: ["read"],
        tasks: [
          { id: "t", prompt: "p", expect: { all: ["a"] } },
          { id: "t", prompt: "q", expect: { all: ["b"] } },
        ],
      }),
    /duplicate task id/,
  );
  const parsed = parseSuite({
    id: "x",
    fixture: "f",
    agent: "a",
    tools: ["read"],
    tasks: [{ id: "t", prompt: "p", expect: { all: ["a"] } }],
  });
  assert.equal(parsed.timeoutMs, 240_000);
  assert.equal(parsed.tasks[0]?.id, "t");
});

test("summarizeEntries aggregates usage, peak context, tool bytes, and final text", () => {
  const lines = [
    { type: "session", version: 3 },
    { type: "message", message: { role: "system", content: "" } },
    { type: "message", message: { role: "user", content: "q" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.01 } },
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "x".repeat(400) }],
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final answer" }],
        usage: { input: 50, output: 20, cacheRead: 900, cacheWrite: 0, totalTokens: 970, cost: { total: 0.02 } },
      },
    },
  ];
  const read = summarizeEntries(lines.map((line) => JSON.stringify(line)).join("\n"));
  assert.equal(read.summary.turns, 2);
  assert.equal(read.summary.usage.input, 150);
  assert.equal(read.summary.usage.cacheRead, 900);
  assert.ok(Math.abs(read.summary.usage.costUsd - 0.03) < 1e-12);
  assert.equal(read.summary.peakContext, 970);
  assert.equal(read.summary.toolResultBytes, 400);
  assert.equal(read.finalText, "final answer");
});

test("arm builders keep fairness flags and never build a shell line", () => {
  const base = {
    suite: { ...suite, agent: "scout" },
    task: suite.tasks[0]!,
    model: "test/model",
    thinking: "low",
    piPath: "/usr/local/bin/pi",
    extensionPath: "/repo/index.ts",
    sessionDir: "/tmp/sessions",
    systemFile: "/tmp/system.md",
    runName: "run-1",
    childModel: "test/model",
  };

  const solo = buildArmInvocation({ ...base, arm: "solo" });
  assert.equal(solo.argv[0], "/usr/local/bin/pi");
  assert.ok(solo.argv.includes("--no-extensions"), "a user extension must not hand the baseline the delegation tool");
  assert.ok(!solo.argv.includes("--no-context-files"), "the child loads project context, so the baseline must too");
  assert.ok(!solo.argv.includes("--no-skills"), "the child loads skills, so the baseline must too");
  assert.equal(solo.argv[solo.argv.indexOf("--tools") + 1], "read,grep");
  assert.equal(solo.argv[solo.argv.indexOf("--append-system-prompt") + 1], "/tmp/system.md");
  assert.equal(solo.argv[solo.argv.length - 1], "find the thing");
  assert.ok(!solo.argv.includes("-e"), "solo must not load the extension");

  const subagent = buildArmInvocation({ ...base, arm: "subagent" });
  assert.equal(subagent.argv[subagent.argv.indexOf("-e") + 1], "/repo/index.ts");
  assert.equal(subagent.argv[subagent.argv.indexOf("--tools") + 1], SUBAGENT_TOOLS.join(","));
  assert.equal(subagent.argv[subagent.argv.indexOf("--append-system-prompt") + 1], ORCHESTRATOR_PROMPT);
  assert.ok(subagent.prompt.includes("hc_subagent"));
  assert.ok(subagent.prompt.includes("model: test/model"), "the child model must be pinned in the tool call");
  assert.ok(!subagent.argv.includes("read,grep"), "the parent must not keep the child's read tools");

  const transcript = buildArmInvocation({ ...base, arm: "transcript", transcript: "assistant: saw src/config.ts" });
  assert.ok(transcript.prompt.includes("saw src/config.ts"));
  assert.equal(transcript.argv[transcript.argv.length - 1], transcript.prompt);

  const routing = buildArmInvocation({ ...base, arm: "routing", childModel: "test/cheap" });
  assert.ok(!routing.argv.includes("--no-context-files"), "routing keeps the same context parity as subagent");
  assert.equal(routing.argv[routing.argv.indexOf("--tools") + 1], SUBAGENT_TOOLS.join(","));
  assert.equal(routing.argv[routing.argv.indexOf("--model") + 1], "test/model", "the parent keeps the parent model");
  assert.ok(routing.prompt.includes("model: test/cheap"), "routing pins the cheaper child model");
  assert.equal(routing.argv[routing.argv.indexOf("-e") + 1], "/repo/index.ts");
});

test("loadConfig fails closed without an explicit opt-in and a model", () => {
  const untrusted = loadConfig({});
  assert.equal(untrusted.ok, false);
  if (!untrusted.ok) assert.match(untrusted.error, /BENCH_LIVE_MODEL/);

  const noModel = loadConfig({ BENCH_LIVE_MODEL: "1" });
  assert.equal(noModel.ok, false);
  if (!noModel.ok) assert.match(noModel.error, /BENCH_MODEL/);

  const badArm = loadConfig({ BENCH_LIVE_MODEL: "1", BENCH_MODEL: "m", BENCH_ARMS: "solo,ghost" });
  assert.equal(badArm.ok, false);

  const ok = loadConfig({ BENCH_LIVE_MODEL: "1", BENCH_MODEL: "test/model", BENCH_REPEATS: "2" });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config.repeats, 2);
    assert.deepEqual(ok.config.arms, ["solo", "subagent", "transcript"]);
    assert.equal(ok.config.childModel, null);
    assert.equal(ok.config.extensionPath.endsWith("index.ts"), true);
  }
});

test("checkModelAvailable rejects a model the run's agent dir cannot resolve", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hc-bench-auth-"));
  try {
    const okPath = path.join(root, "pi-ok");
    const badPath = path.join(root, "pi-bad");
    await writeFile(okPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(badPath, "#!/bin/sh\necho invalid >&2\nexit 2\n", { mode: 0o700 });
    assert.equal(await checkModelAvailable({ piPath: okPath, model: "test/model", agentDir: root }), null);
    const problem = await checkModelAvailable({ piPath: badPath, model: "test/model", agentDir: root });
    assert.ok(problem);
    assert.match(problem, /not usable/);
    assert.match(problem, /BENCH_ISOLATE_AGENT_DIR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("routing requires a distinct child model and is never a default arm", () => {
  const missing = loadConfig({ BENCH_LIVE_MODEL: "1", BENCH_MODEL: "test/model", BENCH_ARMS: "subagent,routing" });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /BENCH_CHILD_MODEL/);

  const same = loadConfig({
    BENCH_LIVE_MODEL: "1",
    BENCH_MODEL: "test/model",
    BENCH_ARMS: "subagent,routing",
    BENCH_CHILD_MODEL: "test/model",
  });
  assert.equal(same.ok, false);
  if (!same.ok) assert.match(same.error, /must differ/);

  const stray = loadConfig({ BENCH_LIVE_MODEL: "1", BENCH_MODEL: "test/model", BENCH_CHILD_MODEL: "test/cheap" });
  assert.equal(stray.ok, false);
  if (!stray.ok) assert.match(stray.error, /only applies to the routing arm/);

  const ok = loadConfig({
    BENCH_LIVE_MODEL: "1",
    BENCH_MODEL: "test/model",
    BENCH_ARMS: "solo,subagent,routing",
    BENCH_CHILD_MODEL: "test/cheap",
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.config.arms, ["solo", "subagent", "routing"]);
    assert.equal(ok.config.childModel, "test/cheap");
  }
});

test("workspace prep skips excluded paths and the digest ignores them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bench-ws-"));
  try {
    const fixture = path.join(root, "fixture");
    await mkdir(path.join(fixture, "src"), { recursive: true });
    await mkdir(path.join(fixture, "node_modules/dep"), { recursive: true });
    await mkdir(path.join(fixture, "bench/results"), { recursive: true });
    await writeFile(path.join(fixture, "src/a.ts"), "export const A = 1;\n");
    await writeFile(path.join(fixture, "keep.txt"), "keep\n");
    await writeFile(path.join(fixture, "node_modules/dep/index.js"), "nope\n");
    await writeFile(path.join(fixture, "bench/results/old.json"), "nope\n");
    const exclude = ["node_modules", "bench/results"];

    const before = await fixtureDigest(fixture, exclude);
    await writeFile(path.join(fixture, "node_modules/dep/index.js"), "changed\n");
    await writeFile(path.join(fixture, "bench/results/old.json"), "changed\n");
    assert.equal(await fixtureDigest(fixture, exclude), before, "excluded files must not affect the digest");

    const workspace = path.join(root, "work");
    await prepareWorkspace(fixture, workspace, exclude);
    assert.equal(await readFile(path.join(workspace, "src/a.ts"), "utf8"), "export const A = 1;\n");
    assert.equal(await readFile(path.join(workspace, "keep.txt"), "utf8"), "keep\n");
    await assert.rejects(readFile(path.join(workspace, "node_modules/dep/index.js")));
    await assert.rejects(readFile(path.join(workspace, "bench/results/old.json")));

    assert.equal(isExcluded("node_modules/dep/index.js", exclude), true);
    assert.equal(isExcluded("src/node_modules/x.js", exclude), true);
    assert.equal(isExcluded("bench/results", exclude), true);
    assert.equal(isExcluded("bench/resultsx/a", exclude), false);
    assert.equal(isExcluded("src/a.ts", exclude), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("report and CSV carry metrics but never task or result text", () => {
  const records = [
    trial({ arm: "solo", taskId: "a", trial: 0, resolved: true }),
    trial({ arm: "subagent", taskId: "a", trial: 0, resolved: false, parentBilled: 400 }),
  ];
  const plan = { model: "test/model", suite: "unit", repeats: 1, arms: ["solo", "subagent"], piVersion: "x", hcVersion: "y" };
  const report = renderReport(records, plan);
  assert.match(report, /Delegation benchmark/);
  assert.match(report, /Reading this report/);
  assert.doesNotMatch(report, /find the thing/);
  const csv = renderTrialsCsv(records);
  assert.match(csv, /^arm,task,trial,resolved/);
  assert.doesNotMatch(csv, /find the thing/);
  assert.match(renderScatterSvg(records), /<svg/);
});

test("report marks routing as the child-model-only change", () => {
  const records = [
    trial({ arm: "solo", taskId: "a", trial: 0 }),
    trial({ arm: "subagent", taskId: "a", trial: 0 }),
    trial({ arm: "routing", taskId: "a", trial: 0, childModel: "test/cheap" }),
  ];
  const plan = {
    model: "test/model",
    childModel: "test/cheap",
    suite: "unit",
    repeats: 1,
    arms: ["solo", "subagent", "routing"],
  };
  const report = renderReport(records, plan);
  assert.match(report, /routing \(same delegation, cheaper child model\)/);
  assert.match(report, /child model \(routing\): `test\/cheap`/);
  assert.match(report, /Routing \(same parent and prompt, different child model\)/);
  const csv = renderTrialsCsv(records);
  assert.match(csv, /child_model/);
  assert.match(csv, /test\/cheap/);
});

test("isolated agent dir copies only credentials and cleans up", async () => {
  const source = await mkdtemp(path.join(os.tmpdir(), "bench-src-"));
  try {
    await writeFile(path.join(source, "auth.json"), '{"token":"secret"}', { mode: 0o600 });
    await writeFile(path.join(source, "settings.json"), "{}");
    await writeFile(path.join(source, "skills.txt"), "x");

    const inherited = await prepareAgentDir({ PI_CODING_AGENT_DIR: source });
    assert.equal(inherited.mode, "inherit");
    assert.equal(inherited.path, null);

    const explicit = await prepareAgentDir({ BENCH_AGENT_DIR: source });
    assert.equal(explicit.mode, "explicit");
    assert.equal(explicit.path, source);

    const isolated = await prepareAgentDir({ PI_CODING_AGENT_DIR: source, BENCH_ISOLATE_AGENT_DIR: "1" });
    assert.equal(isolated.mode, "isolated");
    assert.ok(isolated.path);
    const copied = await readFile(path.join(isolated.path as string, "auth.json"), "utf8");
    assert.match(copied, /secret/);
    await assert.rejects(readFile(path.join(isolated.path as string, "settings.json")));
    const mode = (await import("node:fs/promises")).stat(isolated.path as string);
    assert.equal((await mode).mode & 0o777, 0o700);
    await isolated.cleanup();
    await assert.rejects(readFile(path.join(isolated.path as string, "auth.json")));
  } finally {
    await rm(source, { recursive: true, force: true });
  }
});

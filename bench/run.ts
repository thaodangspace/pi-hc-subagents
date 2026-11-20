/**
 * Delegation benchmark orchestrator.
 *
 * Runs every task under each arm in an isolated workspace and an isolated
 * session directory, then records token/cost/context metrics per trial.
 * `sol` is the single-agent baseline, `subagent` delegates to a real child
 * through a real herdr-core terminal, and `transcript` is the ablation where
 * the parent must absorb the child's exploration instead of a summary.
 *
 * Usage:
 *   BENCH_LIVE_MODEL=1 BENCH_MODEL=provider/model npm run bench
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { appendFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareAgentDir, type AgentDir } from "./agent-dir.ts";
import { buildArmInvocation } from "./arms.ts";
import { ensureHc, toolVersion, type BenchHc } from "./hc.ts";
import { summarizeArm, summarizePairs, pairTrials, type ArmSummary } from "./metrics.ts";
import { renderReport, renderScatterSvg, renderTrialsCsv } from "./report.ts";
import { loadSuite, verifyAnswer } from "./tasks.ts";
import {
  ALL_ARMS,
  DEFAULT_ARMS,
  addUsage,
  billedTokens,
  emptyUsageTotals,
  type Arm,
  type ChildSummary,
  type SessionSummary,
  type TaskSpec,
  type TaskSuite,
  type TrialRecord,
  type UsageTotals,
} from "./types.ts";
import { listSessionFiles, readSession, readSessionTranscript } from "./usage.ts";
import { fixtureDigest, prepareWorkspace, writePrivateFile } from "./workspace.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

export interface BenchConfig {
  model: string;
  /**
   * Child model for the `routing` arm. `null` unless routing is selected;
   * `subagent` keeps using `model` so the existing comparison is unchanged.
   */
  childModel: string | null;
  thinking: string | null;
  suitePath: string;
  fixtureDir: string;
  outputDir: string;
  arms: Arm[];
  repeats: number;
  taskIds: string[] | null;
  maxCostUsd: number;
  timeoutMs: number | null;
  dryRun: boolean;
  piPath: string;
  extensionPath: string;
  socketPath: string | null;
  parentTerminal: string | null;
}

export type ConfigResult = { ok: true; config: BenchConfig } | { ok: false; error: string };

function compactNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function parseList(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const values = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  return values.length > 0 ? values : null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  if (env.BENCH_LIVE_MODEL !== "1") {
    return {
      ok: false,
      error: "refusing to run: set BENCH_LIVE_MODEL=1 to confirm you want to spend real model tokens",
    };
  }
  const model = env.BENCH_MODEL?.trim();
  if (!model) {
    return { ok: false, error: "BENCH_MODEL is required, for example BENCH_MODEL=anthropic/claude-haiku-4-5" };
  }
  const arms = parseList(env.BENCH_ARMS) ?? DEFAULT_ARMS;
  const unknown = arms.filter((arm) => !ALL_ARMS.includes(arm as Arm));
  if (unknown.length > 0) {
    return { ok: false, error: `unknown BENCH_ARMS entries: ${unknown.join(", ")} (allowed: ${ALL_ARMS.join(", ")})` };
  }
  const childModel = env.BENCH_CHILD_MODEL?.trim() || null;
  if (arms.includes("routing")) {
    if (!childModel) {
      return {
        ok: false,
        error: "BENCH_CHILD_MODEL is required for the routing arm, for example BENCH_CHILD_MODEL=anthropic/claude-haiku-4-5",
      };
    }
    if (childModel === model) {
      return {
        ok: false,
        error: "BENCH_CHILD_MODEL must differ from BENCH_MODEL; an equal model only duplicates the subagent arm",
      };
    }
  } else if (childModel) {
    return {
      ok: false,
      error: "BENCH_CHILD_MODEL only applies to the routing arm; add routing to BENCH_ARMS or unset it",
    };
  }
  const repeats = Number.parseInt(env.BENCH_REPEATS ?? "3", 10);
  if (!Number.isFinite(repeats) || repeats < 1) {
    return { ok: false, error: `BENCH_REPEATS must be a positive integer, got ${env.BENCH_REPEATS}` };
  }
  const maxCostRaw = env.BENCH_MAX_COST_USD ?? "3";
  const maxCostUsd = Number.parseFloat(maxCostRaw);
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    return { ok: false, error: `BENCH_MAX_COST_USD must be a positive number, got ${maxCostRaw}` };
  }
  const timeoutRaw = env.BENCH_TIMEOUT_MS;
  const timeoutMs = timeoutRaw === undefined ? null : Number.parseInt(timeoutRaw, 10);

  const suitePath = path.resolve(REPO_ROOT, env.BENCH_SUITE_FILE ?? "bench/tasks/tiny.json");
  const slug = model.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const outputDir = path.resolve(REPO_ROOT, env.BENCH_OUT ?? path.join("bench/results", `${compactNow()}-${slug}`));

  return {
    ok: true,
    config: {
      model,
      childModel,
      thinking: env.BENCH_THINKING?.trim() || null,
      suitePath,
      fixtureDir: "",
      outputDir,
      arms: arms as Arm[],
      repeats,
      taskIds: parseList(env.BENCH_TASKS),
      maxCostUsd,
      timeoutMs: timeoutMs !== null && Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : null,
      dryRun: env.BENCH_DRY_RUN === "1",
      piPath: env.BENCH_PI?.trim() || "pi",
      extensionPath: path.join(REPO_ROOT, "index.ts"),
      socketPath: env.BENCH_HC_SOCKET?.trim() || null,
      parentTerminal: env.BENCH_PARENT_TERMINAL?.trim() || null,
    },
  };
}

interface RunOutcome {
  code: number;
  timedOut: boolean;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
}

function runPi(argv: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; logDir: string }): Promise<RunOutcome> {
  const [command, ...args] = argv;
  if (!command) return Promise.resolve({ code: -1, timedOut: false, durationMs: 0, stdoutTail: "", stderrTail: "empty argv" });
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutLog = createWriteStream(path.join(options.logDir, "stdout.log"), { mode: 0o600 });
    const stderrLog = createWriteStream(path.join(options.logDir, "stderr.log"), { mode: 0o600 });
    let timedOut = false;
    let stdoutTail = "";
    let stderrTail = "";
    const tail = (current: string, chunk: string): string => (current + chunk).slice(-8192);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdoutTail = tail(stdoutTail, chunk);
      stdoutLog.write(chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = tail(stderrTail, chunk);
      stderrLog.write(chunk);
    });

    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // already gone
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 5000).unref();
    }, options.timeoutMs);

    const finish = (code: number, spawnError?: string): void => {
      clearTimeout(timer);
      stdoutLog.end();
      stderrLog.end();
      resolve({
        code,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTail,
        stderrTail: spawnError ? `${stderrTail}${spawnError}` : stderrTail,
      });
    };

    child.on("error", (error) => finish(-1, String(error)));
    child.on("close", (code) => finish(code ?? -1));
  });
}

async function newestSessionFile(dir: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates: { file: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name);
    const info = await stat(file);
    candidates.push({ file, mtime: info.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}

async function readChildren(runsRoot: string): Promise<ChildSummary[]> {
  const files = await listSessionFiles(runsRoot);
  const children: ChildSummary[] = [];
  for (const file of files) {
    const read = await readSession(file);
    if (!read) continue;
    const runDir = path.dirname(path.dirname(file));
    let state: string | null = null;
    let agent: string | null = null;
    try {
      const result = JSON.parse(await readFile(path.join(runDir, "result.json"), "utf8")) as {
        state?: unknown;
        agent?: unknown;
      };
      state = typeof result.state === "string" ? result.state : null;
    } catch {
      state = null;
    }
    try {
      const run = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")) as { agent?: unknown };
      agent = typeof run.agent === "string" ? run.agent : null;
    } catch {
      agent = null;
    }
    children.push({
      runId: path.basename(runDir),
      sessionFile: file,
      state,
      agent,
      usage: read.summary.usage,
      peakContext: read.summary.peakContext,
    });
  }
  return children;
}

function parentEnv(input: {
  base: NodeJS.ProcessEnv;
  arm: Arm;
  agentDir: string | null;
  runsRoot: string;
  socketPath: string | null;
  parentTerminal: string | null;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.base };
  delete env.HC_TERMINAL_ID;
  delete env.HC_TERMINAL_SOCKET;
  delete env.PI_HC_SUBAGENT;
  delete env.PI_HC_RUN_ID;
  delete env.PI_HC_CHILD_ID;
  delete env.PI_HC_PARENT_SESSION;
  delete env.PI_HC_PIPE;
  delete env.PI_HC_SUBAGENTS_SOCKET;
  delete env.PI_HC_SUBAGENTS_PARENT_TERMINAL;
  if (input.agentDir) env.PI_CODING_AGENT_DIR = input.agentDir;
  env.PI_HC_SUBAGENTS_RUNS_ROOT = input.runsRoot;
  if ((input.arm === "subagent" || input.arm === "routing") && input.socketPath) {
    env.PI_HC_SUBAGENTS_SOCKET = input.socketPath;
    if (input.parentTerminal) env.PI_HC_SUBAGENTS_PARENT_TERMINAL = input.parentTerminal;
  }
  return env;
}

export interface TrialInput {
  config: BenchConfig;
  suite: TaskSuite;
  task: TaskSpec;
  arm: Arm;
  trial: number;
  repeats: number;
  systemFile: string;
  transcriptFiles: string[];
  hc: BenchHc | null;
  agentDir: AgentDir;
}

export async function runTrial(input: TrialInput): Promise<TrialRecord> {
  const { config, suite, task, arm, trial } = input;
  const trialKey = `${arm}-${task.id}-${trial}`;
  const trialDir = path.join(config.outputDir, "trials", trialKey);
  const workspace = path.join(trialDir, "work");
  const sessionDir = path.join(trialDir, "sessions");
  const runsRoot = path.join(trialDir, "runs");
  const logDir = path.join(trialDir, "logs");
  await mkdir(trialDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await mkdir(runsRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await prepareWorkspace(config.fixtureDir, workspace, suite.exclude ?? []);

  let transcript = "";
  if (arm === "transcript" && input.transcriptFiles.length > 0) {
    const parts: string[] = [];
    for (const file of input.transcriptFiles) parts.push(await readSessionTranscript(file, 200_000));
    transcript = parts.filter((part) => part.length > 0).join("\n\n");
  }

  const armChildModel = arm === "routing" ? config.childModel ?? config.model : config.model;
  const invocation = buildArmInvocation({
    arm,
    suite,
    task,
    model: config.model,
    thinking: config.thinking,
    piPath: config.piPath,
    extensionPath: config.extensionPath,
    sessionDir,
    systemFile: input.systemFile,
    runName: trialKey,
    childModel: armChildModel,
    transcript,
  });

  const env = parentEnv({
    base: { ...process.env, ...(input.hc?.env ?? {}) },
    arm,
    agentDir: input.agentDir.path,
    runsRoot,
    socketPath: input.hc?.socketPath ?? config.socketPath,
    parentTerminal: input.hc?.parentTerminal ?? config.parentTerminal,
  });

  const timeoutMs = config.timeoutMs ?? task.timeoutMs ?? suite.timeoutMs;
  const outcome = await runPi(invocation.argv, { cwd: workspace, env, timeoutMs, logDir });

  const parentFile = await newestSessionFile(sessionDir);
  const parentRead = parentFile ? await readSession(parentFile) : null;
  const parent: SessionSummary | null = parentRead ? parentRead.summary : null;
  const finalText = parentRead?.finalText ?? "";
  const verification = verifyAnswer(finalText, task.expect);

  const children = arm === "subagent" || arm === "routing" ? await readChildren(runsRoot) : [];
  // The transcript arm consumed a child's session, so its cost belongs in the
  // total. Without this the ablation looks cheaper than it is: the child's
  // tokens were already paid for by the paired subagent trial.
  const consumed: ChildSummary[] = [];
  if (arm === "transcript") {
    for (const file of input.transcriptFiles) {
      const read = await readSession(file);
      if (!read) continue;
      consumed.push({
        runId: path.basename(path.dirname(path.dirname(file))),
        sessionFile: file,
        state: null,
        agent: null,
        usage: read.summary.usage,
        peakContext: read.summary.peakContext,
      });
    }
  }
  const allChildren = [...children, ...consumed];

  const usage: UsageTotals = emptyUsageTotals();
  if (parent) addUsage(usage, parent.usage);
  const childrenBilled = allChildren.reduce((total, child) => total + billedTokens(child.usage), 0);
  for (const child of allChildren) addUsage(usage, child.usage);

  const parentBilled = parent ? billedTokens(parent.usage) : 0;
  const childSessionBytes = await sumBytes(allChildren.map((child) => child.sessionFile));

  return {
    version: 1,
    trialKey,
    arm,
    taskId: task.id,
    trial,
    repeats: input.repeats,
    startedAt: new Date(Date.now() - outcome.durationMs).toISOString(),
    durationMs: outcome.durationMs,
    exitCode: outcome.code,
    timedOut: outcome.timedOut,
    resolved: verification.resolved && outcome.code === 0,
    missing: verification.missing,
    model: config.model,
    childModel: arm === "subagent" || arm === "routing" ? armChildModel : null,
    parent,
    children: allChildren,
    usage,
    parentBilled,
    contextAmplification:
      (arm === "subagent" || arm === "routing") && childrenBilled > 0 && parentBilled > 0
        ? childrenBilled / parentBilled
        : null,
    returnedShare:
      (arm === "subagent" || arm === "routing") && childrenBilled > 0 && childSessionBytes > 0 && parent
        ? parent.toolResultBytes / childSessionBytes
        : null,
    error: outcome.code === 0 ? null : outcome.timedOut ? "timeout" : `${outcome.stderrTail || outcome.stdoutTail}`.slice(-512) || `exit ${outcome.code}`,
  };
}

async function sumBytes(files: string[]): Promise<number> {
  let total = 0;
  for (const file of files) {
    try {
      total += (await stat(file)).size;
    } catch {
      // ignore
    }
  }
  return total;
}

interface RunMetadata {
  startedAt: string;
  finishedAt?: string;
  model: string;
  childModel: string | null;
  thinking: string | null;
  suite: TaskSuite["id"];
  fixtureDigest: string;
  arms: Arm[];
  repeats: number;
  taskIds: string[];
  piVersion: string;
  hcVersion: string;
  commit: string | null;
  node: string;
  platform: string;
  agentDirMode: string;
  agentDigest: string;
  /** Quantities only; task and result text never reach the metadata. */
  privacy: "ids, states, paths, and usage only";
}

async function gitCommit(): Promise<string | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const result = await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

function armOrder(arm: Arm, trial: number): number {
  if (arm === "transcript") return 4;
  const order: Arm[] = trial % 2 === 0 ? ["solo", "subagent", "routing"] : ["routing", "subagent", "solo"];
  const index = order.indexOf(arm);
  return index === -1 ? order.length : index;
}

export async function run(config: BenchConfig): Promise<{ outputDir: string; records: TrialRecord[] }> {
  const suite = await loadSuite(config.suitePath);
  const fixtureDir = path.resolve(REPO_ROOT, suite.fixture);
  const tasks = suite.tasks.filter(
    (task) => config.taskIds === null || config.taskIds.includes(task.id),
  );
  if (tasks.length === 0) {
    throw new Error(`no tasks selected: suite ${suite.id} has ${suite.tasks.map((task) => task.id).join(", ")}`);
  }
  config.fixtureDir = fixtureDir;

  await mkdir(config.outputDir, { recursive: true });
  const agentDir = await prepareAgentDir();
  const agentFile = path.resolve(REPO_ROOT, "agents", `${suite.agent}.md`);
  const agentRaw = await readFile(agentFile, "utf8");
  try {
  const metadata: RunMetadata = {
    startedAt: new Date().toISOString(),
    model: config.model,
    childModel: config.childModel,
    thinking: config.thinking,
    suite: suite.id,
    fixtureDigest: await fixtureDigest(fixtureDir, suite.exclude ?? []),
    arms: config.arms,
    repeats: config.repeats,
    taskIds: tasks.map((task) => task.id),
    piVersion: await toolVersion(config.piPath, ["--version"]),
    hcVersion: config.arms.includes("subagent") ? await toolVersion("hc", ["--version"]) : "not used",
    commit: await gitCommit(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    agentDirMode: agentDir.mode,
    agentDigest: createHash("sha256").update(agentRaw).digest("hex"),
    privacy: "ids, states, paths, and usage only",
  };
  await writeFile(path.join(config.outputDir, "plan.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

  const { parseAgentFile } = await import("../src/agents/frontmatter.ts");
  const { buildSystemFile } = await import("../src/child/child-prompt.ts");
  const parsedAgent = parseAgentFile(agentRaw);
  if (!parsedAgent.ok) throw new Error(`cannot parse ${agentFile}: ${parsedAgent.error ?? "invalid frontmatter"}`);
  const systemText = buildSystemFile(parsedAgent.body);
  const systemFile = path.join(config.outputDir, "system.md");
  await writePrivateFile(systemFile, systemText);

  const plannedTrials = tasks.length * config.repeats * config.arms.length;
  process.stdout.write(
    `plan: suite=${suite.id} tasks=${tasks.length} arms=${config.arms.join(",")} repeats=${config.repeats} trials=${plannedTrials}\n` +
      `model=${config.model}${config.childModel ? ` child=${config.childModel}` : ""}${config.thinking ? ` thinking=${config.thinking}` : ""} out=${config.outputDir}\n`,
  );

  if (config.dryRun) {
    for (const task of tasks) {
      for (const arm of config.arms) {
        const invocation = buildArmInvocation({
          arm,
          suite,
          task,
          model: config.model,
          thinking: config.thinking,
          piPath: config.piPath,
          extensionPath: config.extensionPath,
          sessionDir: path.join(config.outputDir, "dry", `${arm}-${task.id}`, "sessions"),
          systemFile,
          runName: `${arm}-${task.id}-0`,
          childModel: arm === "routing" ? config.childModel : config.model,
        });
        process.stdout.write(`  ${arm} ${task.id}: ${invocation.argv.length} argv entries\n`);
      }
    }
    return { outputDir: config.outputDir, records: [] };
  }

  const hc = config.arms.some((arm) => arm === "subagent" || arm === "routing") ? await ensureHc({}) : null;
  const recordsFile = path.join(config.outputDir, "trials.jsonl");
  const records: TrialRecord[] = [];
  const transcripts = new Map<string, string[]>();
  let spentUsd = 0;
  let aborted: string | null = null;

  bindSignalHandlers(hc);

  try {
    for (const task of tasks) {
      for (let trial = 0; trial < config.repeats; trial += 1) {
        const key = `${task.id}#${trial}`;
        const ordered = [...config.arms].sort((left, right) => armOrder(left, trial) - armOrder(right, trial));
        for (const arm of ordered) {
          if (aborted) break;
          const transcriptFiles = transcripts.get(key) ?? [];
          if (arm === "transcript" && transcriptFiles.length === 0) {
            process.stdout.write(`  skip transcript ${task.id}#${trial}: no subagent transcript\n`);
            continue;
          }
          const record = await runTrial({
            config,
            suite,
            task,
            arm,
            trial,
            repeats: config.repeats,
            systemFile,
            transcriptFiles,
            hc,
            agentDir,
          });
          records.push(record);
          await appendFile(recordsFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });

          if (arm === "subagent" || (arm === "routing" && !transcripts.has(key))) {
            const files = record.children.map((child) => child.sessionFile);
            if (files.length > 0) transcripts.set(key, files);
          }
          spentUsd += record.usage.costUsd;

          const billed = billedTokens(record.usage);
          process.stdout.write(
            `  ${arm} ${task.id}#${trial} resolved=${record.resolved} billed=${billed} cost=$${record.usage.costUsd.toFixed(4)}` +
              `${record.timedOut ? " TIMEOUT" : ""}${record.exitCode !== 0 ? ` exit=${record.exitCode}` : ""}\n`,
          );

          if (spentUsd > config.maxCostUsd) {
            aborted = `spend limit reached: $${spentUsd.toFixed(4)} > BENCH_MAX_COST_USD=$${config.maxCostUsd}`;
            process.stdout.write(`  aborting: ${aborted}\n`);
          }
        }
        if (aborted) break;
      }
      if (aborted) break;
    }
  } finally {
    await hc?.stop();
  }

  metadata.finishedAt = new Date().toISOString();
  await writeFile(path.join(config.outputDir, "plan.json"), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

  const summaries: ArmSummary[] = config.arms
    .map((arm) => summarizeArm(records.filter((record) => record.arm === arm)))
    .filter((summary) => summary.trials > 0);
  const comparisons = summaries
    .filter((summary) => summary.arm !== "solo")
    .map((summary) => ({
      arm: summary.arm,
      versus: "solo",
      ...summarizePairs(pairTrials(records.filter((record) => record.arm === "solo"), records.filter((record) => record.arm === summary.arm))),
    }));

  await writeFile(
    path.join(config.outputDir, "metrics.json"),
    `${JSON.stringify({ plan: metadata, summaries, comparisons }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const report = renderReport(records, metadata);
  await writeFile(path.join(config.outputDir, "REPORT.md"), report, { mode: 0o600 });
  await writeFile(path.join(config.outputDir, "trials.csv"), renderTrialsCsv(records), { mode: 0o600 });
  await writeFile(path.join(config.outputDir, "pareto.svg"), renderScatterSvg(records), { mode: 0o600 });
  process.stdout.write(`\n${report}\n`);
  process.stdout.write(`wrote ${path.join(config.outputDir, "REPORT.md")}\n`);

  return { outputDir: config.outputDir, records };
  } finally {
    await agentDir.cleanup();
  }
}

function bindSignalHandlers(hc: BenchHc | null): void {
  const shutdown = (): void => {
    void hc?.stop().finally(() => process.exit(130));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function main(): Promise<void> {
  const result = loadConfig();
  if (!result.ok) {
    process.stderr.write(`${result.error}\n`);
    process.exit(2);
  }
  await run(result.config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

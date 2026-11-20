/**
 * Deterministic child launch contract.
 *
 * Builds the exact argv, environment, labels, and file paths for a child. It
 * never uses a shell, a `line`, or PTY input. Validation happens before any
 * terminal is created.
 */
import fs from "node:fs";
import path from "node:path";

import { effectiveAgentTools, validateAgentForSpawn, type AgentDefinition } from "../agents/agents.ts";
import { HcSubagentError } from "../core/error.ts";
import { buildSystemFile, buildTaskFile } from "./child-prompt.ts";
import type { RunPaths } from "./paths.ts";
import { resolvePiInvocation } from "./pi-invocation.ts";

export const MAX_TASK_BYTES = 256 * 1024;
export const MAX_SYSTEM_BYTES = 128 * 1024;
export const HC_TOOL_NAMES = ["hc_subagent", "hc_subagent_control"] as const;

export interface SpawnPlanTrust {
  projectTrusted: boolean;
  parentCwd: string;
}

export interface BuildSpawnPlanInput {
  agent: AgentDefinition;
  task: string;
  cwd: string;
  paths: RunPaths;
  parentTerminalId: string;
  parentSessionId: string;
  trust: SpawnPlanTrust;
  excludeTools?: string[];
  env?: NodeJS.ProcessEnv;
  piInvocation?: string[];
}

export interface SpawnPlan {
  agent: AgentDefinition;
  task: string;
  cwd: string;
  paths: RunPaths;
  argv: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  parent: string;
  caller: string;
  trustFlag: boolean;
  taskContent: string;
  systemContent: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCwdInside(parentCwd: string, childCwd: string): boolean {
  const parent = path.resolve(parentCwd);
  const child = path.resolve(childCwd);
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function resolveChildInvocation(
  env: NodeJS.ProcessEnv,
  override?: string[],
): { invocation: string[]; testChild: boolean } {
  const testChild = env.PI_HC_SUBAGENTS_TEST_CHILD;
  if (testChild && testChild.length > 0) {
    const absolute = path.resolve(testChild);
    if (!fs.existsSync(absolute)) {
      throw new HcSubagentError("validation", `PI_HC_SUBAGENTS_TEST_CHILD does not exist: ${absolute}`);
    }
    if (/\.(?:ts|js|mjs|cjs)$/.test(absolute)) {
      return { invocation: [process.execPath, absolute], testChild: true };
    }
    return { invocation: [absolute], testChild: true };
  }
  if (override) return { invocation: override, testChild: false };
  const resolved = resolvePiInvocation({ env });
  if (!resolved.ok) {
    throw new HcSubagentError("validation", resolved.reason ?? "cannot resolve pi", {
      hint: "install pi or ensure it is on PATH",
    });
  }
  return { invocation: resolved.invocation, testChild: false };
}

function buildChildEnv(parentEnv: NodeJS.ProcessEnv, markers: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (key.startsWith("HC_")) continue;
    if (key.startsWith("PI_SESSION_")) continue;
    if (key === "PI_PROVIDER" || key === "PI_MODEL" || key === "PI_REASONING_LEVEL") continue;
    if (key === "PI_HC_PIPE") continue;
    env[key] = value;
  }
  return { ...env, ...markers };
}

function validateCwd(cwd: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new HcSubagentError("validation", `cwd does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new HcSubagentError("validation", `cwd is not a directory: ${cwd}`);
  }
}

export function buildSpawnPlan(input: BuildSpawnPlanInput): SpawnPlan {
  const env = input.env ?? process.env;
  const cwd = path.resolve(input.cwd);
  if (!isRecord(input.agent)) throw new HcSubagentError("validation", "agent definition is missing");
  validateAgentForSpawn(input.agent, { trusted: input.trust.projectTrusted });
  validateCwd(cwd);

  if (input.agent.source === "project" && (input.agent.extensions?.length ?? 0) > 0 && !input.trust.projectTrusted) {
    throw new HcSubagentError(
      "project_agent_not_trusted",
      `project agent ${input.agent.name} declares extensions and requires a trusted project`,
    );
  }

  const taskContent = buildTaskFile({
    task: input.task,
    parentSessionId: input.parentSessionId,
    cwd,
    agentName: input.agent.name,
    runId: input.paths.runId,
  });
  const systemContent = buildSystemFile(input.agent.systemPrompt);

  const taskBytes = Buffer.byteLength(taskContent, "utf8");
  if (taskBytes > MAX_TASK_BYTES) {
    throw new HcSubagentError("validation", `task is ${taskBytes} bytes; maximum is ${MAX_TASK_BYTES}`);
  }
  const systemBytes = Buffer.byteLength(systemContent, "utf8");
  if (systemBytes > MAX_SYSTEM_BYTES) {
    throw new HcSubagentError("validation", `system prompt is ${systemBytes} bytes; maximum is ${MAX_SYSTEM_BYTES}`);
  }

  if (input.task.trim().length === 0) {
    throw new HcSubagentError("validation", "task must not be empty");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(input.paths.childId)) {
    throw new HcSubagentError("validation", `invalid session id: ${input.paths.childId}`);
  }

  const { invocation } = resolveChildInvocation(env, input.piInvocation);

  const excludeTools = [
    ...new Set([...HC_TOOL_NAMES, ...(input.excludeTools ?? []), ...(input.agent.tools?.filter((tool) =>
      HC_TOOL_NAMES.includes(tool as (typeof HC_TOOL_NAMES)[number]),
    ) ?? [])]),
  ];
  const tools = effectiveAgentTools(input.agent);
  const cwdInsideParent = isCwdInside(input.trust.parentCwd, cwd);
  const trustFlag = input.trust.projectTrusted && cwdInsideParent;

  const argv: string[] = [
    ...invocation,
    "--session-id",
    input.paths.childId,
    "--session-dir",
    input.paths.sessionDir,
    "--name",
    input.paths.sessionName,
    ...(input.agent.model ? ["--model", input.agent.model] : []),
    ...(input.agent.thinking ? ["--thinking", input.agent.thinking] : []),
    ...(tools && tools.length > 0 ? ["--tools", tools.join(",")] : []),
    "--exclude-tools",
    excludeTools.join(","),
    ...(input.agent.skills ?? []).flatMap((skill) => ["--skill", skill]),
    ...(input.agent.extensions ?? []).flatMap((extension) => ["-e", extension]),
    "--append-system-prompt",
    input.paths.systemFile,
    ...(trustFlag ? ["-a"] : []),
    `@${input.paths.taskFile}`,
  ];

  const labels: Record<string, string> = {
    "pi-hc-subagents": "1",
    "pi-hc-run": input.paths.runId,
    "pi-hc-child": input.paths.childId,
    "pi-hc-parent": input.parentSessionId,
    "pi-hc-agent": input.paths.agentSlug,
  };

  return {
    agent: input.agent,
    task: input.task,
    cwd,
    paths: input.paths,
    argv,
    env: buildChildEnv(env, {
      PI_HC_SUBAGENT: "1",
      PI_HC_RUN_ID: input.paths.runId,
      PI_HC_CHILD_ID: input.paths.childId,
      PI_HC_PARENT_SESSION: input.parentSessionId,
    }),
    labels,
    parent: input.parentTerminalId,
    caller: input.parentTerminalId,
    trustFlag,
    taskContent,
    systemContent,
  };
}

/** Snapshot-friendly description; no secrets, no task text. */
export function summarizeSpawnPlan(plan: SpawnPlan): Record<string, unknown> {
  return {
    runId: plan.paths.runId,
    childId: plan.paths.childId,
    terminalName: plan.paths.terminalName,
    agent: plan.agent.name,
    agentSource: plan.agent.source,
    cwd: plan.cwd,
    argv: plan.argv,
    labels: plan.labels,
    trustFlag: plan.trustFlag,
  };
}

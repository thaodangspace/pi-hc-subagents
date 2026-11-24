/**
 * Deterministic child launch contract.
 *
 * Builds the exact argv, environment, labels, and file paths for a child. It
 * never uses a shell, a `line`, or PTY input. Validation happens before any
 * terminal is created.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { effectiveAgentTools, validateAgentForSpawn, type AgentDefinition, type ThinkingLevel } from "../agents/agents.ts";
import { HcSubagentError } from "../core/error.ts";
import { buildSystemFile, buildTaskFile } from "./child-prompt.ts";
import type { RunPaths } from "./paths.ts";
import { resolvePiInvocation } from "./pi-invocation.ts";
import { pipeNameFor } from "./pipe-protocol.ts";

export const MAX_TASK_BYTES = 256 * 1024;
export const MAX_SYSTEM_BYTES = 128 * 1024;
export const HC_TOOL_NAMES = ["hc_subagent", "hc_subagent_control"] as const;
export const CHILD_ENTRY = fileURLToPath(new URL("../../child.ts", import.meta.url));

/**
 * hc merges per-terminal env over the core environment, so omission alone
 * cannot remove inherited values. Empty strings clear parent-specific
 * variables; pi treats them as unset.
 */
const CLEARED_CHILD_ENV = [
  "PI_MODEL",
  "PI_PROVIDER",
  "PI_REASONING_LEVEL",
  "PI_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_HC_PIPE",
  "PI_HC_ALLOWED_COMMANDS",
  "PI_HC_SUBAGENTS_SOCKET",
  "PI_HC_SUBAGENTS_PARENT_TERMINAL",
] as const;

export interface SpawnPlanTrust {
  projectTrusted: boolean;
  parentCwd: string;
}

export interface BuildSpawnPlanInput {
  agent: AgentDefinition;
  task: string;
  cwd: string;
  paths: RunPaths;
  /** Anchor terminal, or null when the parent runs outside hc parentless. */
  parentTerminalId: string | null;
  parentSessionId: string;
  trust: SpawnPlanTrust;
  excludeTools?: string[];
  env?: NodeJS.ProcessEnv;
  piInvocation?: string[];
  /**
   * Parent model used when the agent does not pin one. Keeps a delegated child
   * on the model the user is actually talking to instead of pi's ambient
   * default, which can be a different provider entirely.
   */
  defaultModel?: string | null;
  /** Parent thinking level used when the agent does not pin one. */
  defaultThinking?: ThinkingLevel | null;
}

export interface SpawnPlan {
  agent: AgentDefinition;
  /** Effective model: agent override, else the parent default, else null. */
  model: string | null;
  /** Effective thinking level: agent override, else the parent default. */
  thinking: ThinkingLevel | null;
  task: string;
  cwd: string;
  paths: RunPaths;
  argv: string[];
  env: Record<string, string>;
  labels: Record<string, string>;
  /** Anchor terminal for `terminal.run`; null starts a root terminal. */
  parent: string | null;
  /** hc caller identity; null when the parent has no hc terminal. */
  caller: string | null;
  /** True when children must be started without an hc parent. */
  noParent: boolean;
  trustFlag: boolean;
  taskContent: string;
  systemContent: string;
  /** Private follow-up pipe name; also passed as PI_HC_PIPE. */
  pipeName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCwdInside(parentCwd: string, childCwd: string): boolean {
  const canonical = (value: string): string => {
    try {
      return fs.realpathSync(value);
    } catch {
      return path.resolve(value);
    }
  };
  const parent = canonical(parentCwd);
  const child = canonical(childCwd);
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
  for (const key of CLEARED_CHILD_ENV) env[key] = "";
  return { ...env, ...markers };
}

function resolveExistingCwd(cwd: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(cwd);
  } catch {
    throw new HcSubagentError("validation", `cwd does not exist: ${cwd}`);
  }
  if (!stat.isDirectory()) {
    throw new HcSubagentError("validation", `cwd is not a directory: ${cwd}`);
  }
  try {
    return fs.realpathSync(cwd);
  } catch {
    return path.resolve(cwd);
  }
}

function resolveModel(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HcSubagentError("validation", "model id contains control characters");
  }
  return trimmed;
}

/**
 * The Herdr app's adoption labels, opt-in.
 *
 * A terminal carrying `herdr.space`/`herdr.tab` shows up in the Herdr app as a
 * pane in that space; an id the app does not know becomes a new, unnamed space
 * (named after the terminal's folder) or a new tab. hc never interprets a
 * label, so an install without the app keeps them as plain data.
 *
 * Off by default: a child already shows under its parent's tab in the agents
 * list, and a pane per child is a choice, not a default. `PI_HC_HERDR=1` (or a
 * space) turns them on, `PI_HC_HERDR_TAB` pins a tab (default: the run id, so
 * one run's children share a tab), and `PI_HC_HERDR=0` keeps them off even when
 * a space is set.
 */
export function herdrLabels(env: NodeJS.ProcessEnv, runId: string): Record<string, string> {
  const flag = (env["PI_HC_HERDR"] ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return {};
  const space = (env["PI_HC_HERDR_SPACE"] ?? "").trim();
  const on = flag === "1" || flag === "true" || flag === "on" || space.length > 0;
  if (!on) return {};
  const tab = (env["PI_HC_HERDR_TAB"] ?? "").trim();
  return {
    "herdr.space": space.length > 0 ? space : "pi-hc",
    "herdr.tab": tab.length > 0 ? tab : runId,
  };
}

export function buildSpawnPlan(input: BuildSpawnPlanInput): SpawnPlan {
  const env = input.env ?? process.env;
  if (!isRecord(input.agent)) throw new HcSubagentError("validation", "agent definition is missing");
  validateAgentForSpawn(input.agent, { trusted: input.trust.projectTrusted });
  const cwd = resolveExistingCwd(input.cwd);
  const model = resolveModel(input.agent.model ?? input.defaultModel ?? null);
  const thinking = input.agent.thinking ?? input.defaultThinking ?? null;

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
  const pipeName = pipeNameFor(input.trust.parentCwd, input.paths.childId);
  const parentTerminalId = input.parentTerminalId?.trim() || null;

  const excludeTools = [
    ...new Set([
      ...HC_TOOL_NAMES,
      ...(input.excludeTools ?? []),
      ...(input.agent.disallowedTools ?? []),
      ...(input.agent.tools?.filter((tool) =>
        HC_TOOL_NAMES.includes(tool as (typeof HC_TOOL_NAMES)[number]),
      ) ?? []),
    ]),
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
    ...(model ? ["--model", model] : []),
    ...(thinking ? ["--thinking", thinking] : []),
    ...(tools && tools.length > 0 ? ["--tools", tools.join(",")] : []),
    "--exclude-tools",
    excludeTools.join(","),
    ...(input.agent.skills ?? []).flatMap((skill) => ["--skill", skill]),
    "-e",
    CHILD_ENTRY,
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
    ...herdrLabels(env, input.paths.runId),
  };

  return {
    agent: input.agent,
    model,
    thinking,
    task: input.task,
    cwd,
    paths: input.paths,
    argv,
    env: buildChildEnv(env, {
      PI_HC_SUBAGENT: "1",
      PI_HC_RUN_ID: input.paths.runId,
      PI_HC_CHILD_ID: input.paths.childId,
      PI_HC_PARENT_SESSION: input.parentSessionId,
      PI_HC_PIPE: pipeName,
      ...(input.agent.allowedCommands && input.agent.allowedCommands.length > 0
        ? { PI_HC_ALLOWED_COMMANDS: JSON.stringify(input.agent.allowedCommands) }
        : {}),
    }),
    labels,
    parent: parentTerminalId,
    caller: parentTerminalId,
    noParent: parentTerminalId === null,
    trustFlag,
    taskContent,
    systemContent,
    pipeName,
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
    disallowedTools: plan.agent.disallowedTools ?? [],
    allowedCommands: plan.agent.allowedCommands ?? [],
    model: plan.model,
    thinking: plan.thinking,
    cwd: plan.cwd,
    argv: plan.argv,
    labels: plan.labels,
    trustFlag: plan.trustFlag,
  };
}

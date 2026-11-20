/**
 * Start a background run.
 *
 * Shared by the `hc_subagent` tool (background mode) and the intertool
 * service. It applies the same agent resolution, trust, concurrency, run-dir,
 * spawn, and monitor rules as the synchronous path.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  type AgentDefinition,
  type AgentScope,
  type ThinkingLevel,
  discoverAgents,
  resolveAgent,
  validateAgentForSpawn,
} from "../agents/agents.ts";
import { authorizeProjectAgent } from "../agents/project-policy.ts";
import { buildSpawnPlan } from "../child/child-command.ts";
import { createSubagentRecord, spawnChild } from "../child/child-spawn.ts";
import { createRunPaths } from "../child/paths.ts";
import { locateSessionFile } from "../child/session-locate.ts";
import { HcSubagentError } from "../core/error.ts";
import type { ToolSession } from "../tools/session.ts";
import { ChildStateMachine } from "./state-machine.ts";
import { defaultMonitorHooks } from "./run-hooks.ts";
import type { SubagentRecord } from "./types.ts";

export interface StartBackgroundRunRequest {
  agentName: string;
  task: string;
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
  agentScope?: AgentScope;
  origin: string;
  trusted: boolean;
  parentCwd: string;
  /** Explicit pre-approval for trusted project agents. */
  allowProjectAgents: boolean;
  promptProjectAgent?: (agent: AgentDefinition) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface StartedBackgroundRun {
  record: SubagentRecord;
  agent: AgentDefinition;
  cwd: string;
  task: string;
}

function applyOverrides(agent: AgentDefinition, request: StartBackgroundRunRequest): AgentDefinition {
  return {
    ...agent,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
  };
}

export async function startBackgroundRun(
  session: ToolSession,
  request: StartBackgroundRunRequest,
): Promise<StartedBackgroundRun> {
  const { runtime, scheduler, registry } = session;
  if (!session.monitors) {
    throw new HcSubagentError("unavailable", "background monitors are not initialized");
  }

  const discovery = await discoverAgents({
    cwd: request.parentCwd,
    scope: request.agentScope ?? runtime.config.agentScope,
    trusted: request.trusted,
    agentDir: runtime.agentDir,
    packageDir: runtime.agentDirs.package,
  });
  const agent = applyOverrides(resolveAgent(discovery, request.agentName), request);
  validateAgentForSpawn(agent, { trusted: request.trusted });
  await authorizeProjectAgent(agent, {
    trusted: request.trusted,
    allowWithoutPrompt: request.allowProjectAgents,
    hasUI: request.promptProjectAgent !== undefined,
    ...(request.promptProjectAgent === undefined ? {} : { confirm: request.promptProjectAgent }),
  });

  const requestedCwd = request.cwd ?? agent.cwd ?? request.parentCwd;
  const cwd = path.resolve(request.parentCwd, requestedCwd);

  const release = await scheduler.acquire({ write: agent.access === "write", cwd, signal: request.signal });
  let releaseSlot: (() => void) | null = release;
  let locateController: AbortController | null = null;
  try {
    const paths = createRunPaths({
      agentName: agent.name,
      agentDir: runtime.agentDir,
      env: runtime.env,
    });
    const plan = buildSpawnPlan({
      agent,
      task: request.task,
      cwd,
      paths,
      parentTerminalId: runtime.parentTerminalId ?? "",
      parentSessionId: runtime.parentSessionId,
      trust: { projectTrusted: request.trusted, parentCwd: request.parentCwd },
      excludeTools: runtime.config.excludeTools,
      env: runtime.env,
    });

    const turnStartedAtMs = Date.now();
    const spawned = await spawnChild(runtime.core, plan, {
      origin: request.origin,
      background: true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    const record = registry.create(
      createSubagentRecord(plan, spawned.terminal, {
        parentSessionId: runtime.parentSessionId,
        origin: request.origin,
        background: true,
        now: () => new Date(),
        turnStartedAtMs,
      }),
    );

    await mkdir(paths.sessionDir, { recursive: true, mode: 0o700 }).catch(() => {});

    locateController = new AbortController();
    const locateSignal = request.signal
      ? AbortSignal.any([request.signal, locateController.signal])
      : locateController.signal;
    const locatePromise = locateSessionFile({
      sessionDir: paths.sessionDir,
      childId: paths.childId,
      signal: locateSignal,
    }).catch(() => null);

    const machine = new ChildStateMachine({
      baselineTurn: spawned.terminal.turn,
      startupTimeoutMs: runtime.config.startupTimeoutMs,
      // Background work is unbounded; only startup has a deadline.
      waitTimeoutMs: Number.MAX_SAFE_INTEGER,
      startedAtMs: turnStartedAtMs,
    });

    const slot = releaseSlot;
    releaseSlot = null;
    const controller = locateController;
    locateController = null;
    session.monitors.start({
      session,
      record,
      terminal: spawned.terminal,
      machine,
      turnStartedAtMs,
      resultFile: paths.resultFile,
      locate: () => locatePromise,
      cancelLocate: () => controller?.abort(),
      ...(slot === null ? {} : { release: slot }),
      pollIntervalMs: runtime.config.pollIntervalMs,
      hooks: defaultMonitorHooks(session),
    });

    session.persistence?.append(record);
    session.onRecordChange?.(record);
    return { record, agent, cwd, task: request.task };
  } catch (error) {
    locateController?.abort();
    releaseSlot?.();
    throw error;
  }
}

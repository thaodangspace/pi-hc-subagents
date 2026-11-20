/**
 * Once-per-session runtime state.
 *
 * `index.ts` creates this during `session_start`, after prerequisites. Later
 * phases attach the registry, scheduler, and lifecycle helpers.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CoreClient, createCoreClient } from "../core/core-client.ts";
import { type HcSubagentsConfig, type ConfigWarning } from "../config/schema.ts";
import { type LoadedConfig, loadConfig, resolveAgentDir } from "../config/config.ts";
import { detectPrerequisites, type PrerequisitesResult } from "./prerequisites.ts";

export type RuntimeMode = "ready" | "setup" | "child";

export interface AgentDirectories {
  user: string;
  project: string | null;
  package: string;
}

export interface ExtensionRuntime {
  available: boolean;
  mode: RuntimeMode;
  prerequisites: PrerequisitesResult;
  core: CoreClient;
  config: HcSubagentsConfig;
  configWarnings: ConfigWarning[];
  loadedConfig: LoadedConfig;
  agentDirs: AgentDirectories;
  cwd: string;
  trusted: boolean;
  parentSessionId: string;
  parentTerminalId: string | null;
  createdAt: string;
}

export interface CreateRuntimeOptions {
  cwd: string;
  trusted: boolean;
  parentSessionId: string;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
  core?: CoreClient;
}

const PACKAGE_AGENTS_DIR = fileURLToPath(new URL("../../agents", import.meta.url));

function findNearestProjectAgentsDir(cwd: string): string | null {
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, ".pi", "agents");
    if (path.dirname(current) === current) return null;
    // Existence is checked lazily by discovery; returning the nearest candidate
    // keeps diagnostics stable even before an agents directory exists.
    if (nearestExists(candidate)) return candidate;
    current = path.dirname(current);
  }
}

function nearestExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export async function createRuntime(options: CreateRuntimeOptions): Promise<ExtensionRuntime> {
  const env = options.env ?? process.env;
  const agentDir = options.agentDir ?? resolveAgentDir(env);
  const loaded = await loadConfig({
    cwd: options.cwd,
    trusted: options.trusted,
    env,
    agentDir,
  });
  const core = options.core ?? createCoreClient(env);
  const prerequisites = await detectPrerequisites({
    env,
    core,
    parentSessionId: options.parentSessionId,
  });
  const mode: RuntimeMode =
    prerequisites.reason === "child_mode" ? "child" : prerequisites.available ? "ready" : "setup";

  return {
    available: prerequisites.available,
    mode,
    prerequisites,
    core,
    config: loaded.config,
    configWarnings: loaded.warnings,
    loadedConfig: loaded,
    agentDirs: {
      user: path.join(agentDir, "agents"),
      project: findNearestProjectAgentsDir(options.cwd),
      package: PACKAGE_AGENTS_DIR,
    },
    cwd: options.cwd,
    trusted: options.trusted,
    parentSessionId: options.parentSessionId,
    parentTerminalId: prerequisites.parentTerminalId,
    createdAt: new Date().toISOString(),
  };
}

/** Effective config + where agents are discovered from. */
export function runtimeDiagnostics(runtime: ExtensionRuntime): string {
  const dirs = [
    `agents.user: ${runtime.agentDirs.user}`,
    `agents.project: ${runtime.agentDirs.project ?? "(none)"}`,
    `agents.package: ${runtime.agentDirs.package}`,
    `hc: ${runtime.prerequisites.coreVersion ?? "unknown"}`,
    `mode: ${runtime.mode}`,
  ];
  return dirs.join("\n");
}

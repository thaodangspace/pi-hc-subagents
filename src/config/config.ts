/**
 * Load and merge configuration.
 *
 * Precedence: env > project (trusted only) > global > defaults.
 */
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  type ConfigWarning,
  type HcSubagentsConfig,
  applyConfigLayer,
  cloneDefaultConfig,
  envOverrides,
  validateConfig,
} from "./schema.ts";

export interface ConfigPaths {
  global: string;
  project: string;
  projectIgnored: boolean;
  globalExists: boolean;
  projectExists: boolean;
}

export interface LoadConfigOptions {
  cwd: string;
  trusted: boolean;
  env?: NodeJS.ProcessEnv;
  /** pi agent directory; defaults to PI_CODING_AGENT_DIR or ~/.pi/agent. */
  agentDir?: string;
}

export interface LoadedConfig {
  config: HcSubagentsConfig;
  warnings: ConfigWarning[];
  paths: ConfigPaths;
}

export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR;
  return override && override.length > 0 ? path.resolve(override) : path.join(os.homedir(), ".pi", "agent");
}

export function configPaths(options: { cwd: string; agentDir?: string }): { global: string; project: string } {
  return {
    global: path.join(options.agentDir ?? resolveAgentDir(), "hc-subagents.json"),
    project: path.join(options.cwd, ".pi", "hc-subagents.json"),
  };
}

async function readJsonIfPresent(file: string): Promise<{ exists: boolean; value?: unknown; error?: string }> {
  try {
    const text = await readFile(file, "utf8");
    return { exists: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false };
    return { exists: true, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const paths = configPaths({ cwd: options.cwd, agentDir: options.agentDir });
  const warnings: ConfigWarning[] = [];
  let config = cloneDefaultConfig();

  const globalFile = await readJsonIfPresent(paths.global);
  if (globalFile.error) {
    warnings.push({ source: "global", field: "<file>", message: globalFile.error });
  } else if (globalFile.exists) {
    const validated = validateConfig(globalFile.value, "global");
    warnings.push(...validated.warnings);
    config = applyConfigLayer(config, validated.value);
  }

  const projectFile = await readJsonIfPresent(paths.project);
  const projectIgnored = projectFile.exists && !options.trusted;
  if (projectFile.exists && options.trusted) {
    if (projectFile.error) {
      warnings.push({ source: "project", field: "<file>", message: projectFile.error });
    } else {
      const validated = validateConfig(projectFile.value, "project");
      warnings.push(...validated.warnings);
      config = applyConfigLayer(config, validated.value);
    }
  }

  const fromEnv = envOverrides(env);
  warnings.push(...fromEnv.warnings);
  config = applyConfigLayer(config, fromEnv.value);

  return {
    config,
    warnings,
    paths: {
      ...paths,
      projectIgnored,
      globalExists: globalFile.exists,
      projectExists: projectFile.exists,
    },
  };
}

/** Human-readable config diagnostics for `/hc-subagents config`. */
export function formatConfigDiagnostics(loaded: LoadedConfig, extra: Record<string, string> = {}): string {
  const lines: string[] = [];
  lines.push("pi-hc-subagents configuration");
  lines.push(`global: ${loaded.paths.global}${loaded.paths.globalExists ? "" : " (absent)"}`);
  lines.push(
    `project: ${loaded.paths.project}${loaded.paths.projectExists ? "" : " (absent)"}${
      loaded.paths.projectIgnored ? " (ignored: project is not trusted)" : ""
    }`,
  );
  for (const [key, value] of Object.entries(extra)) lines.push(`${key}: ${value}`);
  lines.push("");
  lines.push(JSON.stringify(loaded.config, null, 2));
  if (loaded.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const warning of loaded.warnings) {
      lines.push(`- ${warning.source}.${warning.field}: ${warning.message}`);
    }
  }
  return lines.join("\n");
}

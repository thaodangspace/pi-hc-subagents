/**
 * pi agent-dir handling for benchmark runs.
 *
 * `--model` and the `--no-*` flags already neutralise user settings, skills,
 * extensions, and context files, but provider auth still lives in the agent
 * dir. Three modes:
 *
 * - `inherit` (default): use whatever `PI_CODING_AGENT_DIR` already points at,
 *   so credentials keep working.
 * - `explicit`: `BENCH_AGENT_DIR=/path` for a dedicated bench profile.
 * - `isolated`: `BENCH_ISOLATE_AGENT_DIR=1` copies only auth and model catalog
 *   into a private temp dir, so package agents are used with no user overrides.
 *   The copy is removed at the end and never written into the results dir.
 */
import { chmod, cp, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type AgentDirMode = "inherit" | "explicit" | "isolated";

export interface AgentDir {
  mode: AgentDirMode;
  /** null means "leave PI_CODING_AGENT_DIR untouched". */
  path: string | null;
  cleanup(): Promise<void>;
}

const CREDENTIAL_FILES = ["auth.json", "models.json", "models-store.json"];

export function defaultAgentDirSource(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

export async function prepareAgentDir(env: NodeJS.ProcessEnv = process.env): Promise<AgentDir> {
  const explicit = env.BENCH_AGENT_DIR?.trim();
  if (explicit) {
    return { mode: "explicit", path: path.resolve(explicit), cleanup: async () => {} };
  }

  if (env.BENCH_ISOLATE_AGENT_DIR !== "1") {
    return { mode: "inherit", path: null, cleanup: async () => {} };
  }

  const source = defaultAgentDirSource(env);
  const destination = await mkdtemp(path.join(os.tmpdir(), "pi-bench-agent-"));
  for (const file of CREDENTIAL_FILES) {
    const from = path.join(source, file);
    if (!existsSync(from)) continue;
    const to = path.join(destination, file);
    await cp(from, to);
    await chmod(to, 0o600);
  }

  return {
    mode: "isolated",
    path: destination,
    cleanup: async () => {
      await rm(destination, { recursive: true, force: true });
    },
  };
}

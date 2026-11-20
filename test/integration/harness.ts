/**
 * Isolated herdr-core harness for integration tests.
 *
 * Every test gets its own HC_SESSION and scratch XDG paths. Cleanup stops the
 * core, which ends its terminals. The developer's core is never touched.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { CoreClient } from "../../src/core/core-client.ts";
import type { TerminalRecord } from "../../src/core/hc-types.ts";

const execFileAsync = promisify(execFile);

export interface IsolatedHcOptions {
  /** Additional environment for both hc itself and the client. */
  env?: NodeJS.ProcessEnv;
  /** Start a long-lived shell terminal that acts as the parent. Default true. */
  createParent?: boolean;
}

export interface IsolatedHc {
  root: string;
  session: string;
  socketPath: string;
  env: NodeJS.ProcessEnv;
  core: CoreClient;
  parentTerminal: TerminalRecord | null;
  /** Run a command through the isolated hc CLI, returning parsed JSON when possible. */
  hc(args: string[], options?: { input?: string }): Promise<{ stdout: string; stderr: string; code: number }>;
  cleanup(): Promise<void>;
}

export async function hcAvailable(): Promise<boolean> {
  try {
    await execFileAsync("hc", ["--version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function findSocket(runtimeDir: string, session: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const found = await findFileWithSuffix(runtimeDir, `${session}.sock`);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`hc socket for ${session} was not created under ${runtimeDir}`);
}

async function findFileWithSuffix(dir: string, suffix: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFileWithSuffix(full, suffix);
      if (nested) return nested;
    } else if (entry.name.endsWith(suffix)) {
      return full;
    }
  }
  return null;
}

function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ stdout, stderr: `${stderr}${String(error)}`, code: -1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

export async function startIsolatedHc(options: IsolatedHcOptions = {}): Promise<IsolatedHc> {
  // Keep the runtime path short: Unix socket paths are limited to ~104 bytes.
  const root = await mkdtemp(path.join(process.env.PI_HC_SUBAGENTS_TEST_TMPDIR ?? "/tmp", "hcit-"));
  const session = `hct-${randomUUID().slice(0, 8)}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    HC_SESSION: session,
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_RUNTIME_DIR: path.join(root, "run"),
    HC_TERMINAL_ID: undefined,
    HC_TERMINAL_SOCKET: undefined,
  };
  for (const dir of [env.XDG_STATE_HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR]) {
    if (dir) await mkdir(dir, { recursive: true });
  }

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await runCommand("hc", ["server", "stop", "--json"], env);
    await rm(root, { recursive: true, force: true });
  };

  const start = await runCommand("hc", ["server", "start", "--json"], env);
  if (start.code !== 0) {
    await cleanup();
    throw new Error(`failed to start isolated hc: ${start.stderr || start.stdout}`);
  }

  const socketPath = await findSocket(env.XDG_RUNTIME_DIR as string, session);
  const core = new CoreClient({ socketPath, caller: null, env });

  let parentTerminal: TerminalRecord | null = null;
  if (options.createParent !== false) {
    const parentRun = await runCommand(
      "hc",
      ["run", "--bg", "--no-notify", "--no-parent", "--name", "it-parent", "--json", "sh", "-c", "sleep 3600"],
      env,
    );
    if (parentRun.code !== 0) {
      await cleanup();
      throw new Error(`failed to start parent terminal: ${parentRun.stderr || parentRun.stdout}`);
    }
    const parsed = JSON.parse(parentRun.stdout) as { address?: string };
    if (!parsed.address) {
      await cleanup();
      throw new Error(`parent terminal did not report an address: ${parentRun.stdout}`);
    }
    parentTerminal = await core.get(parsed.address);
    env.HC_TERMINAL_ID = parsed.address;
    env.HC_TERMINAL_SOCKET = socketPath;
  } else {
    env.HC_TERMINAL_SOCKET = socketPath;
  }

  return {
    root,
    session,
    socketPath,
    env,
    core: new CoreClient({ socketPath, caller: parentTerminal?.address ?? null, env }),
    parentTerminal,
    hc: (args, runOptions) => runCommandWithInput("hc", args, env, runOptions?.input),
    cleanup,
  };
}

function runCommandWithInput(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => resolve({ stdout, stderr: `${stderr}${String(error)}`, code: -1 }));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? -1 }));
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }
  });
}

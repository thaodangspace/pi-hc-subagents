/**
 * herdr-core lifecycle for the benchmark.
 *
 * Default mode starts a private core under the benchmark root so the
 * developer's core and terminals are never touched. `BENCH_HC_SOCKET` (or an
 * inherited `HC_TERMINAL_SOCKET`) points the benchmark at an existing core
 * instead, which is what the container image uses.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm } from "node:fs/promises";

import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface BenchHc {
  socketPath: string;
  /** Terminal children are parented to, or null for root terminals. */
  parentTerminal: string | null;
  /** True when this module started (and must stop) the core. */
  owned: boolean;
  /** Environment every pi parent must inherit (XDG + HC_SESSION). */
  env: NodeJS.ProcessEnv;
  stop(): Promise<void>;
}

async function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync(command, args, { env, timeout: 30_000 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message ?? String(error),
      code: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

async function findSocket(runtimeDir: string, session: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const found = await search(runtimeDir, `${session}.sock`);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`hc socket for ${session} was not created under ${runtimeDir}`);
}

async function search(dir: string, suffix: string): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await search(full, suffix);
      if (nested) return nested;
    } else if (entry.name.endsWith(suffix)) {
      return full;
    }
  }
  return null;
}

export interface EnsureHcOptions {
  env?: NodeJS.ProcessEnv;
}

/** Unix socket paths are limited to about 104 bytes on macOS and Linux. */
const MAX_SOCKET_PATH_BYTES = 100;

export async function ensureHc(options: EnsureHcOptions): Promise<BenchHc> {
  const env = options.env ?? process.env;
  const configured = env.BENCH_HC_SOCKET?.trim();
  if (configured) {
    assertSocketPath(configured);
    return {
      socketPath: configured,
      parentTerminal: env.BENCH_PARENT_TERMINAL?.trim() || null,
      owned: false,
      env: {},
      stop: async () => {},
    };
  }

  const inheritedSocket = env.HC_TERMINAL_SOCKET?.trim();
  if (inheritedSocket) {
    return {
      socketPath: inheritedSocket,
      parentTerminal: env.HC_TERMINAL_ID?.trim() || null,
      owned: false,
      env: {},
      stop: async () => {},
    };
  }

  // Keep both the runtime dir and the session name short: hc appends
  // `herdr-core/<session>.sock`, and Unix socket paths cap out near 100 bytes.
  // os.tmpdir() on macOS is a long /var/folders path, so prefer /tmp.
  const baseTmp = env.BENCH_TMPDIR?.trim() || "/tmp";
  const session = `b-${randomUUID().slice(0, 6)}`;
  const coreRoot = path.join(baseTmp, `hcb-${randomUUID().slice(0, 6)}`);
  const coreEnv: NodeJS.ProcessEnv = {
    ...env,
    HC_SESSION: session,
    XDG_STATE_HOME: path.join(coreRoot, "state"),
    XDG_CONFIG_HOME: path.join(coreRoot, "config"),
    XDG_RUNTIME_DIR: path.join(coreRoot, "run"),
    HC_TERMINAL_ID: undefined,
    HC_TERMINAL_SOCKET: undefined,
  };
  for (const dir of [coreEnv.XDG_STATE_HOME, coreEnv.XDG_CONFIG_HOME, coreEnv.XDG_RUNTIME_DIR]) {
    if (dir) await mkdir(dir, { recursive: true, mode: 0o700 });
  }

  const start = await run("hc", ["server", "start", "--json"], coreEnv);
  if (start.code !== 0) {
    throw new Error(`failed to start a private hc core: ${start.stderr || start.stdout}`);
  }
  const socketPath = await findSocket(coreEnv.XDG_RUNTIME_DIR as string, session);

  let parentTerminal: string | null = null;
  const parent = await run(
    "hc",
    ["run", "--bg", "--no-notify", "--no-parent", "--name", "bench-parent", "--json", "sh", "-c", "sleep 86400"],
    coreEnv,
  );
  if (parent.code === 0) {
    try {
      const parsed = JSON.parse(parent.stdout) as { address?: string };
      parentTerminal = typeof parsed.address === "string" ? parsed.address : null;
    } catch {
      parentTerminal = null;
    }
  }

  const benchEnv: NodeJS.ProcessEnv = {
    HC_SESSION: session,
    XDG_STATE_HOME: coreEnv.XDG_STATE_HOME,
    XDG_CONFIG_HOME: coreEnv.XDG_CONFIG_HOME,
    XDG_RUNTIME_DIR: coreEnv.XDG_RUNTIME_DIR,
  };

  return {
    socketPath,
    parentTerminal,
    owned: true,
    env: benchEnv,
    stop: async () => {
      await run("hc", ["server", "stop", "--json"], coreEnv);
      await rm(coreRoot, { recursive: true, force: true });
    },
  };
}

function assertSocketPath(socketPath: string): void {
  const bytes = Buffer.byteLength(socketPath, "utf8");
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new Error(
      `hc socket path is ${bytes} bytes, over the ~${MAX_SOCKET_PATH_BYTES} byte Unix limit: ${socketPath}`,
    );
  }
}

export async function toolVersion(command: string, args: string[]): Promise<string> {
  const result = await run(command, args, process.env);
  const text = (result.stdout || result.stderr).trim().split("\n")[0] ?? "";
  return result.code === 0 ? text : "unavailable";
}

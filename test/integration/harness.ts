/**
 * Isolated herdr-core harness for integration tests.
 *
 * Every test gets its own HC_SESSION and scratch XDG paths. Cleanup stops the
 * core, which ends its terminals. The developer's core is never touched.
 *
 * Two safety nets keep a killed test run from leaking cores (each leaked core
 * keeps a holder process and a few MB of RAM forever):
 * - every started core is stopped synchronously on `exit`, `SIGINT`, and
 *   `SIGTERM`;
 * - `startIsolatedHc` prunes `hcit-*` roots that outlived their test process
 *   (no longer active here and older than `ORPHAN_MIN_AGE_MS`), stopping the
 *   core that still owns them before removing the directory.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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

/**
 * A root must be abandoned for this long before the harness dares to remove it,
 * so a slow test file can never lose the core another file is still using.
 */
export const ORPHAN_MIN_AGE_MS = 30 * 60 * 1000;

/** Roots this process still owns; never pruned. */
const activeCores = new Set<{ root: string; env: NodeJS.ProcessEnv }>();
let exitHookInstalled = false;

function stopCoreSync(env: NodeJS.ProcessEnv): void {
  spawnSync("hc", ["server", "stop", "--json"], { env, timeout: 5000, stdio: "ignore" });
}

function stopActiveCoresSync(): void {
  for (const core of activeCores) stopCoreSync(core.env);
  activeCores.clear();
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // `exit` is synchronous only: stop each core with a blocking CLI call instead
  // of awaiting, so a plain process exit or a failed assertion cannot leak.
  process.on("exit", stopActiveCoresSync);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.on(signal, () => {
      stopActiveCoresSync();
      process.exit(code);
    });
  }
}

/** Whether an `hcit-*` root is abandoned and safe to remove. */
export function isOrphanRoot(
  candidate: { root: string; mtimeMs: number },
  options: { activeRoots: Iterable<string>; minAgeMs: number; now: number },
): boolean {
  if (new Set(options.activeRoots).has(candidate.root)) return false;
  return options.now - candidate.mtimeMs >= options.minAgeMs;
}

export interface OrphanPruneOptions {
  /** Directory holding `hcit-*` roots; defaults to the harness tmp dir. */
  tmpdir?: string;
  minAgeMs?: number;
  now?: number;
  /** Override the in-process active set (tests only). */
  activeRoots?: Iterable<string>;
}

export interface OrphanPruneResult {
  removed: string[];
  failed: Array<{ root: string; error: string }>;
}

async function sessionOfRoot(root: string): Promise<string | null> {
  const socket = await findFileWithSuffix(path.join(root, "run"), ".sock");
  if (socket) return path.basename(socket).replace(/\.sock$/, "");
  // A socket-less root still names its session in the state directory.
  const stateDir = path.join(root, "state", "herdr-core");
  try {
    const entries = await readdir(stateDir, { withFileTypes: true });
    const session = entries.find((entry) => entry.isDirectory());
    return session ? session.name : null;
  } catch {
    return null;
  }
}

/**
 * Confirm the env for an existing isolated root. `hc server stop` needs the
 * session name because the socket is stored per session.
 */
function rootEnv(root: string, session: string | null, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    ...(session === null ? {} : { HC_SESSION: session }),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_RUNTIME_DIR: path.join(root, "run"),
    HC_TERMINAL_ID: undefined,
    HC_TERMINAL_SOCKET: undefined,
  };
}

/**
 * Stop and delete `hcit-*` roots left behind by interrupted test runs. Best
 * effort: an unreadable or in-use root is kept, never removed speculatively.
 */
export async function pruneOrphanedHcRoots(options: OrphanPruneOptions = {}): Promise<OrphanPruneResult> {
  const result: OrphanPruneResult = { removed: [], failed: [] };
  const tmpdir = options.tmpdir ?? process.env.PI_HC_SUBAGENTS_TEST_TMPDIR ?? "/tmp";
  const minAgeMs = options.minAgeMs ?? ORPHAN_MIN_AGE_MS;
  const now = options.now ?? Date.now();
  const activeRoots = options.activeRoots ?? [...activeCores].map((core) => core.root);

  let entries;
  try {
    entries = await readdir(tmpdir, { withFileTypes: true });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("hcit-")) continue;
    const root = path.join(tmpdir, entry.name);
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(root)).mtimeMs;
    } catch {
      continue;
    }
    if (!isOrphanRoot({ root, mtimeMs }, { activeRoots, minAgeMs, now })) continue;
    try {
      const session = await sessionOfRoot(root);
      // Without a session there is no socket to address: only the directory is
      // ours to delete. Never guess a session name (`default` would be someone
      // else's core).
      if (session !== null) await runCommand("hc", ["server", "stop", "--json"], rootEnv(root, session));
      await rm(root, { recursive: true, force: true });
      result.removed.push(root);
    } catch (error) {
      result.failed.push({ root, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

let pruneOnce: Promise<void> | null = null;

/** Prune abandoned roots once per process; never fails a test. */
async function pruneOrphansOnce(): Promise<void> {
  pruneOnce ??= pruneOrphanedHcRoots()
    .then(() => {})
    .catch(() => {});
  await pruneOnce;
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
  installExitHook();
  await pruneOrphansOnce();

  // Keep the runtime path short: Unix socket paths are limited to ~104 bytes.
  const root = await mkdtemp(path.join(process.env.PI_HC_SUBAGENTS_TEST_TMPDIR ?? "/tmp", "hcit-"));
  const session = `hct-${randomUUID().slice(0, 8)}`;
  const env: NodeJS.ProcessEnv = rootEnv(root, session, options.env);
  for (const dir of [env.XDG_STATE_HOME, env.XDG_CONFIG_HOME, env.XDG_RUNTIME_DIR]) {
    if (dir) await mkdir(dir, { recursive: true });
  }

  let cleaned = false;
  const tracked = { root, env };
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    activeCores.delete(tracked);
    await runCommand("hc", ["server", "stop", "--json"], env);
    await rm(root, { recursive: true, force: true });
  };

  const start = await runCommand("hc", ["server", "start", "--json"], env);
  if (start.code !== 0) {
    await cleanup();
    throw new Error(`failed to start isolated hc: ${start.stderr || start.stdout}`);
  }
  // Registered only after the core exists, and cleared by `cleanup`.
  activeCores.add(tracked);

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

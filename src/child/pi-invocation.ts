/**
 * Resolve the pi binary to launch for a child.
 *
 * The same installation as the parent is preferred so child sessions use the
 * same pi version. A missing binary fails before any terminal is created.
 */
import fs from "node:fs";
import path from "node:path";

export interface PiInvocationContext {
  argv1?: string | undefined;
  execPath?: string;
  exists?: (candidate: string) => boolean;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const BUN_VIRTUAL_ROOT = /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/;

/** The exact `[binary, ...args]` prefix used by the child command. */
export function getPiInvocation(context: PiInvocationContext = {}): string[] {
  const script = context.argv1 ?? process.argv[1];
  const execPath = context.execPath ?? process.execPath;
  const exists = context.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const bunVirtual =
    !!script && (script.startsWith("/$bunfs/root/") || BUN_VIRTUAL_ROOT.test(script));
  if (script && !bunVirtual && exists(script)) {
    return [execPath, script];
  }
  const exec = path.basename(execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exec)) return [execPath];
  return ["pi"];
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether an invocation can actually be executed on this machine. */
export function isInvocationResolvable(invocation: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  const binary = invocation[0];
  if (!binary) return false;
  if (path.isAbsolute(binary) || binary.includes(path.sep) || (path.sep === "/" && binary.includes("\\"))) {
    return isExecutableFile(binary);
  }
  const pathValue = env.PATH ?? env.Path ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, binary + extension);
      if (isExecutableFile(candidate)) return true;
    }
  }
  return false;
}

export interface ResolvedPiInvocation {
  ok: boolean;
  invocation: string[];
  reason?: string;
}

export function resolvePiInvocation(context: PiInvocationContext = {}): ResolvedPiInvocation {
  const invocation = getPiInvocation(context);
  const env = context.env ?? process.env;
  if (!isInvocationResolvable(invocation, env)) {
    return {
      ok: false,
      invocation,
      reason: `cannot execute pi (${invocation.join(" ")})`,
    };
  }
  return { ok: true, invocation };
}

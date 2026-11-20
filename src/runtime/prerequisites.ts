/**
 * Fail-closed prerequisite detection.
 *
 * All requirements are hard: terminal identity, a reachable core, a supported
 * core version, and a resolvable pi invocation. Tools are only registered when
 * every check passes.
 */
import type { CoreClient } from "../core/core-client.ts";
import { describeHcError } from "../core/error.ts";
import { HC_MIN_VERSION, compareVersions } from "../core/hc-types.ts";
import { type ResolvedPiInvocation, resolvePiInvocation } from "../child/pi-invocation.ts";

export type PrerequisiteReason =
  | "ok"
  | "child_mode"
  | "missing_env"
  | "core_unreachable"
  | "core_too_old"
  | "missing_pi";

export interface PrerequisitesResult {
  available: boolean;
  reason: PrerequisiteReason;
  message: string;
  coreVersion: string | null;
  parentTerminalId: string | null;
  parentSessionId: string | null;
  missingEnv: string[];
  minimumVersion: string;
  pi: ResolvedPiInvocation;
}

export interface DetectPrerequisitesOptions {
  env?: NodeJS.ProcessEnv;
  core: CoreClient;
  piInvocation?: ResolvedPiInvocation;
  parentSessionId?: string | null;
}

export function detectPrerequisitesSyncEnv(env: NodeJS.ProcessEnv): {
  terminalId: string | null;
  socket: string | null;
  missing: string[];
} {
  const terminalId = env.HC_TERMINAL_ID && env.HC_TERMINAL_ID.length > 0 ? env.HC_TERMINAL_ID : null;
  const socket = env.HC_TERMINAL_SOCKET && env.HC_TERMINAL_SOCKET.length > 0 ? env.HC_TERMINAL_SOCKET : null;
  const missing: string[] = [];
  if (!terminalId) missing.push("HC_TERMINAL_ID");
  if (!socket) missing.push("HC_TERMINAL_SOCKET");
  return { terminalId, socket, missing };
}

export async function detectPrerequisites(options: DetectPrerequisitesOptions): Promise<PrerequisitesResult> {
  const env = options.env ?? process.env;
  const pi = options.piInvocation ?? resolvePiInvocation({ env });
  const base = {
    parentSessionId: options.parentSessionId ?? null,
    minimumVersion: HC_MIN_VERSION,
    pi,
  };

  if (env.PI_HC_SUBAGENT === "1") {
    return {
      ...base,
      available: false,
      reason: "child_mode",
      message: "running as a delegated child; subagent tools are disabled",
      coreVersion: null,
      parentTerminalId: null,
      missingEnv: [],
    };
  }

  const { terminalId, missing } = detectPrerequisitesSyncEnv(env);
  if (missing.length > 0) {
    return {
      ...base,
      available: false,
      reason: "missing_env",
      message: `not running inside a herdr-core terminal (${missing.join(", ")} not set)`,
      coreVersion: null,
      parentTerminalId: terminalId,
      missingEnv: missing,
    };
  }

  let coreVersion: string | null = null;
  try {
    coreVersion = (await options.core.serverStatus()).version;
  } catch (error) {
    return {
      ...base,
      available: false,
      reason: "core_unreachable",
      message: `herdr-core is not reachable: ${describeHcError(error)}`,
      coreVersion: null,
      parentTerminalId: terminalId,
      missingEnv: [],
    };
  }

  if (!coreVersion || compareVersions(coreVersion, HC_MIN_VERSION) < 0) {
    return {
      ...base,
      available: false,
      reason: "core_too_old",
      message: `herdr-core ${coreVersion ?? "(unknown)"} is older than the required ${HC_MIN_VERSION}`,
      coreVersion,
      parentTerminalId: terminalId,
      missingEnv: [],
    };
  }

  if (!pi.ok) {
    return {
      ...base,
      available: false,
      reason: "missing_pi",
      message: `cannot resolve the pi executable: ${pi.reason ?? "unknown"}`,
      coreVersion,
      parentTerminalId: terminalId,
      missingEnv: [],
    };
  }

  return {
    ...base,
    available: true,
    reason: "ok",
    message: `hc ${coreVersion} ready`,
    coreVersion,
    parentTerminalId: terminalId,
    missingEnv: [],
  };
}

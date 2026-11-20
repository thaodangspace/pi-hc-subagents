/**
 * Fail-closed prerequisite detection.
 *
 * All requirements are hard: a reachable core, a supported core version, and a
 * resolvable pi invocation. The parent may run inside an `hc` terminal
 * (`HC_TERMINAL_ID` + `HC_TERMINAL_SOCKET`) or outside one with an explicitly
 * configured socket (`hc.socketPath` / `PI_HC_SUBAGENTS_SOCKET`). Tools are
 * only registered when every check passes.
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
  /**
   * Terminal children are parented to. `null` means the parent runs outside
   * `hc` without an anchor: children start as root terminals.
   */
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
  /**
   * Config fallback (`hc.parentTerminal`). `HC_TERMINAL_ID` wins whenever it
   * is set, so a config file can never re-parent a session started inside hc.
   */
  parentTerminal?: string | null;
}

function nonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function detectPrerequisitesSyncEnv(env: NodeJS.ProcessEnv): {
  terminalId: string | null;
  socket: string | null;
  missing: string[];
} {
  const terminalId = nonEmpty(env.HC_TERMINAL_ID);
  const socket = nonEmpty(env.HC_TERMINAL_SOCKET);
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

  // The core client already resolved the endpoint: env first, then config.
  const socketPath = options.core.socketPath;
  const envTerminalId = nonEmpty(env.HC_TERMINAL_ID);
  const configuredTerminalId = nonEmpty(options.parentTerminal);
  const parentTerminalId = envTerminalId ?? configuredTerminalId;

  if (!socketPath) {
    const missing: string[] = [];
    // A configured anchor is useless without a socket, so only report the
    // pieces that are actually absent.
    if (!parentTerminalId) missing.push("HC_TERMINAL_ID");
    missing.push("HC_TERMINAL_SOCKET");
    return {
      ...base,
      available: false,
      reason: "missing_env",
      message: parentTerminalId
        ? "no herdr-core socket (HC_TERMINAL_SOCKET or PI_HC_SUBAGENTS_SOCKET/hc.socketPath)"
        : `not running inside a herdr-core terminal (${missing.join(", ")} not set)`,
      coreVersion: null,
      parentTerminalId,
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
      parentTerminalId,
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
      parentTerminalId,
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
      parentTerminalId,
      missingEnv: [],
    };
  }

  return {
    ...base,
    available: true,
    reason: "ok",
    message: parentTerminalId
      ? `hc ${coreVersion} ready`
      : `hc ${coreVersion} ready (external session; children start without an hc parent)`,
    coreVersion,
    parentTerminalId,
    missingEnv: [],
  };
}

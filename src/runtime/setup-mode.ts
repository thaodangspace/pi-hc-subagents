/**
 * User-facing setup mode: the extension is loaded, but tools are not.
 */
import { HC_MIN_VERSION } from "../core/hc-types.ts";
import type { PrerequisitesResult } from "./prerequisites.ts";

export function setupMessage(prerequisites: PrerequisitesResult): string {
  const lines: string[] = [];
  lines.push("hc-subagents requires pi to run inside a herdr-core terminal.");
  lines.push("");
  lines.push("Start it with: hc run --bg --name pi pi");
  lines.push("Or open pi inside the Herdr app.");
  lines.push("");
  lines.push("Outside hc, point at a running core socket instead:");
  lines.push("  PI_HC_SUBAGENTS_SOCKET=/path/to/core.sock pi");
  lines.push("(or set hc.socketPath in hc-subagents.json)");
  lines.push("Children then start as root terminals unless hc.parentTerminal /");
  lines.push("PI_HC_SUBAGENTS_PARENT_TERMINAL names a live terminal to parent them to.");
  lines.push("");
  switch (prerequisites.reason) {
    case "missing_env":
      lines.push(`Missing: ${prerequisites.missingEnv.join(", ")}`);
      break;
    case "core_unreachable":
      lines.push(prerequisites.message);
      lines.push("Check that the core is running: hc server status");
      break;
    case "core_too_old":
      lines.push(`Required: hc >= ${HC_MIN_VERSION}; found ${prerequisites.coreVersion ?? "unknown"}.`);
      lines.push("Update with: hc update");
      break;
    case "missing_pi":
      lines.push(prerequisites.message);
      lines.push("Ensure `pi` is on PATH or reinstall pi.");
      break;
    default:
      lines.push(prerequisites.message);
      break;
  }
  return lines.join("\n");
}

export function setupNotification(prerequisites: PrerequisitesResult): string {
  if (prerequisites.reason === "missing_env") {
    return "hc-subagents: pi is not running inside a herdr-core terminal; subagent tools are disabled. Run /hc-subagents for setup.";
  }
  return `hc-subagents: subagent tools are disabled (${prerequisites.reason}). Run /hc-subagents for details.`;
}

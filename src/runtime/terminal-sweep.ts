/**
 * Start-up sweep of this parent's own finished hc terminals.
 *
 * A child terminal is kept for inspection by default (`cleanup: "keep"`), and
 * `session_shutdown` kills but does not remove it, so a resumed session would
 * accumulate `finished` terminals in the core forever. This sweep removes the
 * ones this parent left behind.
 *
 * Rules:
 * - Per-parent ownership: only terminals labeled `pi-hc-parent=<sessionId>`
 *   are candidates (invariant 9), and the label filter is applied by the core.
 * - Only `finished` terminals are removed; a `live` child is never touched.
 * - A terminal still owned by a registry record is protected, so a restored or
 *   in-flight run keeps its terminal even if hc already reported it finished.
 * - Bounded: at most `maxRemovals` per start, oldest `finishedMs` first.
 * - Best effort and contained: a core error leaves everything as it was and
 *   never fails the session.
 */
import type { CoreClient } from "../core/core-client.ts";
import { toHcSubagentError } from "../core/error.ts";
import type { TerminalRecord } from "../core/hc-types.ts";

/** Label written on every child terminal by `buildSpawnPlan`. */
export const SWEEP_PARENT_LABEL = "pi-hc-parent";
export const SWEEP_DEFAULT_MAX_REMOVALS = 50;

export interface TerminalSweepOptions {
  core: Pick<CoreClient, "list" | "remove">;
  parentSessionId: string;
  /** Terminals owned by a known record; never removed by the sweep. */
  protectedTerminals?: Iterable<string>;
  maxRemovals?: number;
}

export interface TerminalSweepResult {
  /** How many terminals the filtered listing returned. */
  scanned: number;
  removed: string[];
  failed: Array<{ terminal: string; error: string }>;
}

export interface SweepSelectionOptions {
  parentSessionId: string;
  protectedTerminals?: Iterable<string>;
  maxRemovals?: number;
}

/**
 * The part of the sweep that does not touch hc: finished, own-parent,
 * unprotected terminals, oldest first, capped.
 */
export function selectSweepCandidates(
  terminals: readonly TerminalRecord[],
  options: SweepSelectionOptions,
): TerminalRecord[] {
  if (!options.parentSessionId) return [];
  const protectedTerminals = new Set(options.protectedTerminals ?? []);
  const maxRemovals = Math.max(0, options.maxRemovals ?? SWEEP_DEFAULT_MAX_REMOVALS);
  if (maxRemovals === 0) return [];
  return terminals
    .filter((terminal) => terminal.state === "finished")
    .filter((terminal) => terminal.labels[SWEEP_PARENT_LABEL] === options.parentSessionId)
    .filter((terminal) => !protectedTerminals.has(terminal.address))
    .sort((a, b) => (a.finishedMs ?? a.createdMs) - (b.finishedMs ?? b.createdMs))
    .slice(0, maxRemovals);
}

export async function sweepFinishedTerminals(options: TerminalSweepOptions): Promise<TerminalSweepResult> {
  const result: TerminalSweepResult = { scanned: 0, removed: [], failed: [] };
  const maxRemovals = Math.max(0, options.maxRemovals ?? SWEEP_DEFAULT_MAX_REMOVALS);
  if (!options.parentSessionId || maxRemovals === 0) return result;

  let terminals: TerminalRecord[];
  try {
    const listing = await options.core.list({
      all: true,
      labels: { [SWEEP_PARENT_LABEL]: options.parentSessionId },
    });
    terminals = listing.terminals;
  } catch {
    // No endpoint, an old core, or a disconnect: nothing was changed.
    return result;
  }
  result.scanned = terminals.length;

  for (const terminal of selectSweepCandidates(terminals, options)) {
    try {
      await options.core.remove(terminal.address);
      result.removed.push(terminal.address);
    } catch (error) {
      const normalized = toHcSubagentError(error);
      // `not_found`/`finished` mean it is already gone, which is the goal.
      if (normalized.code === "not_found" || normalized.code === "finished") continue;
      result.failed.push({ terminal: terminal.address, error: normalized.message });
    }
  }
  return result;
}

/**
 * Parent lifecycle: owned-child cleanup and terminal policy.
 *
 * A parent quit kills every child it started. Transient core disconnects never
 * kill a child. Cleanup after a terminal turn follows `cleanup: keep|remove`;
 * `sweepFinishedTerminals` also removes the killed terminals on shutdown, so a
 * session that ends does not leave `finished` terminals behind forever.
 */
import path from "node:path";

import { updateRunMetadataFile } from "../child/child-spawn.ts";
import { HcSubagentError, toHcSubagentError } from "../core/error.ts";
import type { ToolSession } from "../tools/session.ts";
import type { SubagentRecord } from "./types.ts";

export interface ShutdownResult {
  killed: string[];
  failed: Array<{ terminal: string; error: string }>;
}

export async function shutdownOwnedChildren(session: ToolSession): Promise<ShutdownResult> {
  const records = session.registry.listForParent(session.runtime.parentSessionId);
  const killed: string[] = [];
  const failed: Array<{ terminal: string; error: string }> = [];

  await Promise.all(
    records.map(async (record) => {
      if (!record.terminal) return;
      try {
        await session.runtime.core.kill(record.terminal);
        killed.push(record.terminal);
        if (record.state !== "completed" && record.state !== "failed") {
          const nowIso = new Date().toISOString();
          const updated = session.registry.update(record.childId, {
            state: "cancelled",
            terminalState: "finished",
            settledAt: nowIso,
            turns: record.turns.map((turn) =>
              turn.state === "running" || turn.state === "blocked"
                ? { ...turn, state: "cancelled" as const, outcome: "aborted" as const, settledAt: nowIso }
                : turn,
            ),
          });
          if (updated.runDir) {
            await updateRunMetadataFile(path.join(updated.runDir, "run.json"), {
              state: "cancelled",
              outcome: "aborted",
              settledAt: nowIso,
              ...(updated.sessionFile ? { sessionFile: updated.sessionFile } : {}),
            }).catch(() => {});
          }
        }
      } catch (error) {
        const normalized = toHcSubagentError(error);
        if (normalized.code === "not_found" || normalized.code === "finished") return;
        failed.push({ terminal: record.terminal, error: normalized.message });
      }
      if (shouldRemoveOnShutdown(session, record)) {
        await session.runtime.core.remove(record.terminal).catch(() => {});
      }
    }),
  );

  return { killed, failed };
}

/**
 * Shutdown removes a terminal when `cleanup: "remove"` asks for it or when the
 * start-up sweep is enabled: nothing is left to inspect once the parent session
 * is gone, and `terminal.kill` has already made the child dead.
 */
function shouldRemoveOnShutdown(session: ToolSession, record: SubagentRecord): boolean {
  return session.runtime.config.cleanup === "remove" || session.runtime.config.sweepFinishedTerminals;
}

export interface CleanupOptions {
  /** Remove the terminal after killing it. */
  remove: boolean;
}

/** Kill and optionally remove a child after its terminal turn. */
export async function cleanupFinishedChild(
  session: ToolSession,
  record: SubagentRecord,
  options: CleanupOptions,
): Promise<void> {
  // Close before the early-out: a kept child no longer needs the hint socket.
  session.settleHints?.close(record.childId);
  if (!options.remove) return;
  try {
    await session.runtime.core.kill(record.terminal);
  } catch (error) {
    const normalized = toHcSubagentError(error);
    if (normalized.code !== "not_found" && normalized.code !== "finished") throw normalized;
  }
  try {
    await session.runtime.core.remove(record.terminal);
  } catch (error) {
    const normalized = toHcSubagentError(error);
    if (normalized.code !== "not_found" && normalized.code !== "finished") throw normalized;
  }
}

/** A child is safe to remove only when it is not starting, working, or blocked. */
export function isSafeToRemove(record: SubagentRecord): boolean {
  return record.state === "completed" || record.state === "failed" || record.state === "cancelled";
}

export function assertOwned(session: ToolSession, record: SubagentRecord): void {
  if (record.parentSessionId !== session.runtime.parentSessionId) {
    throw new HcSubagentError("not_found", `child ${record.childId} does not belong to this session`);
  }
}

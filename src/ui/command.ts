/**
 * `/hc-subagents` command.
 *
 * Works in TUI, RPC, and print mode: interactive selection only when UI is
 * available, plain notifications otherwise. Actions never block on a child.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatConfigDiagnostics } from "../config/config.ts";
import { formatDuration } from "../runtime/result-format.ts";
import { resolveChildId } from "../runtime/id-resolve.ts";
import { readResultFile } from "../runtime/result-store.ts";
import { cancelRecord } from "../runtime/run-ops.ts";
import { formatSettleHintSummary } from "../runtime/settle-hints.ts";
import type { SubagentRecord } from "../runtime/types.ts";
import type { ExtensionRuntime } from "../runtime/runtime.ts";
import { setupMessage } from "../runtime/setup-mode.ts";
import type { ToolSession } from "../tools/session.ts";

export const COMMAND_NAME = "hc-subagents";

export interface CommandDeps {
  getSession: () => ToolSession | null;
  getRuntime: () => ExtensionRuntime | null;
}

const HELP_TEXT = [
  "Usage: /hc-subagents [list|attach <id>|result <id>|kill <id>|config]",
  "",
  "list         current children (default)",
  "attach <id>  print the hc attach command",
  "result <id>  print the last settled result",
  "kill <id>    interrupt and kill a child",
  "config       effective configuration and agent directories",
].join("\n");

function durationOf(record: SubagentRecord): number {
  const started = Date.parse(record.createdAt);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

function listLines(records: SubagentRecord[]): string[] {
  return records.map(
    (record) =>
      `${record.slug}  ${record.state}  ${record.terminal}  ${record.agent}  ${formatDuration(durationOf(record))}  ${record.cwd}`,
  );
}

function recordLabel(record: SubagentRecord): string {
  return `${record.slug} (${record.state}, ${record.terminal})`;
}

async function resolveForCommand(
  session: ToolSession,
  ctx: ExtensionCommandContext,
  action: string,
  id: string,
): Promise<SubagentRecord | null> {
  if (id.length > 0) {
    const resolved = resolveChildId(session.registry, id);
    if (resolved.kind === "found") return resolved.record;
    if (resolved.kind === "ambiguous") {
      ctx.ui.notify(`Ambiguous id. Candidates:\n${resolved.candidates.map(recordLabel).join("\n")}`, "warning");
      return null;
    }
    ctx.ui.notify(`No subagent matches "${id}".`, "warning");
    return null;
  }

  const records = session.registry.listForParent(session.runtime.parentSessionId, { includeFinished: true });
  if (records.length === 0) {
    ctx.ui.notify("No subagents yet.", "info");
    return null;
  }
  if (records.length === 1) return records[0] as SubagentRecord;
  if (!ctx.hasUI) {
    ctx.ui.notify(`${action} requires an id:\n${records.map(recordLabel).join("\n")}`, "warning");
    return null;
  }
  const choice = await ctx.ui.select(`Select a subagent to ${action}`, records.map(recordLabel));
  if (!choice) return null;
  const selected = records.find((record) => recordLabel(record) === choice);
  return selected ?? null;
}

export function registerHcSubagentsCommand(pi: ExtensionAPI, deps: CommandDeps): void {
  pi.registerCommand(COMMAND_NAME, {
    description: "Inspect and manage hc subagents",
    async handler(args, ctx) {
      const runtime = deps.getRuntime();
      if (!runtime) {
        ctx.ui.notify("hc-subagents has not initialized yet. Try again after this turn.", "warning");
        return;
      }
      if (runtime.mode === "child") {
        ctx.ui.notify("hc-subagents: delegated children cannot spawn subagents.", "info");
        return;
      }

      const tokens = args.trim().length > 0 ? args.trim().split(/\s+/) : [];
      const action = tokens[0] ?? "list";
      const id = tokens.slice(1).join(" ").trim();
      const session = deps.getSession();

      if (action === "config") {
        const diagnostics = formatConfigDiagnostics(runtime.loadedConfig, {
          "agents.user": runtime.agentDirs.user,
          "agents.project": runtime.agentDirs.project ?? "(none)",
          "agents.package": runtime.agentDirs.package,
          "hc.version": runtime.prerequisites.coreVersion ?? "unknown",
          mode: runtime.mode,
          "defaultMode": runtime.config.defaultMode,
          "wakeOnSettle": String(runtime.config.wakeOnSettle),
          "ui.status": runtime.config.ui.status,
          "retentionDays": String(runtime.config.retentionDays),
          "intertool.exposeService": String(runtime.config.intertool.exposeService),
        });
        const childIds =
          session?.registry
            .listForParent(runtime.parentSessionId, { includeFinished: true })
            .map((record) => record.childId) ?? [];
        const settleSummary = formatSettleHintSummary(
          session?.settleHints,
          runtime.config.wakeOnSettle,
          childIds,
        );
        ctx.ui.notify(`${diagnostics}\n${settleSummary}`, "info");
        return;
      }

      if (!runtime.available) {
        ctx.ui.notify(setupMessage(runtime.prerequisites), "warning");
        return;
      }
      if (!session) {
        ctx.ui.notify("hc-subagents is still starting; try again in a moment.", "warning");
        return;
      }

      switch (action) {
        case "list": {
          const records = session.registry.listForParent(runtime.parentSessionId, { includeFinished: true });
          if (records.length === 0) {
            ctx.ui.notify("No subagents yet.", "info");
            return;
          }
          ctx.ui.notify(listLines(records).join("\n"), "info");
          return;
        }
        case "attach":
        case "result":
        case "kill": {
          const record = await resolveForCommand(session, ctx, action, id);
          if (!record) return;
          if (action === "attach") {
            ctx.ui.notify(
              [
                `hc attach ${record.terminal}`,
                `agent: ${record.agent}`,
                `state: ${record.state} (${record.coreStatus})`,
                `session: ${record.sessionFile ?? "(not discovered yet)"}`,
                `directory: ${record.cwd}`,
              ].join("\n"),
              "info",
            );
            return;
          }
          if (action === "result") {
            const stored = record.resultFile ? await readResultFile(record.resultFile) : null;
            // Prefer the persisted summary so the human reads the same text the
            // model saw; a result without a summary is unchanged.
            const text = stored?.summary ?? stored?.text ?? record.turns.at(-1)?.text;
            if (!text || text.length === 0) {
              ctx.ui.notify(`${record.slug} has no settled result yet (state: ${record.state}).`, "warning");
              return;
            }
            ctx.ui.notify(text, "info");
            return;
          }
          session.monitors?.stop(record.childId);
          const { record: cancelled, killed } = await cancelRecord(session, record, { force: true });
          session.notifier?.markResultDelivered(cancelled);
          session.service?.emitCancelled(cancelled);
          session.persistence?.append(cancelled);
          session.onRecordChange?.(cancelled);
          ctx.ui.notify(
            `${killed ? "killed" : "cancelled"} ${cancelled.slug} (${cancelled.terminal}). Run files were kept.`,
            "info",
          );
          return;
        }
        default:
          ctx.ui.notify(HELP_TEXT, "info");
      }
    },
  });
}

/**
 * pi-hc-subagents — delegate tasks to interactive pi subagents in herdr-core terminals.
 *
 * `index.ts` is wiring only. Business logic lives in `src/`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatConfigDiagnostics } from "./src/config/config.ts";
import { Registry } from "./src/runtime/registry.ts";
import { Scheduler } from "./src/runtime/scheduler.ts";
import { type ExtensionRuntime, createRuntime } from "./src/runtime/runtime.ts";
import { setupMessage, setupNotification } from "./src/runtime/setup-mode.ts";
import { formatDuration } from "./src/runtime/result-format.ts";
import { shutdownOwnedChildren } from "./src/runtime/lifecycle.ts";
import { registerControlTool } from "./src/tools/control-tool.ts";
import { registerSpawnTool } from "./src/tools/spawn-tool.ts";
import type { ToolSession } from "./src/tools/session.ts";

const COMMAND_NAME = "hc-subagents";

const HELP_TEXT = [
  "Usage: /hc-subagents [list|config]",
  "",
  "list    current children (default)",
  "config  effective configuration and agent directories",
  "",
  "Use hc_subagent_control for attach/result/kill actions.",
].join("\n");

export default function hcSubagentsExtension(pi: ExtensionAPI): void {
  let runtime: ExtensionRuntime | null = null;
  let toolSession: ToolSession | null = null;
  let toolsRegistered = false;
  let setupNotified = false;

  pi.registerCommand(COMMAND_NAME, {
    description: "Inspect and manage hc subagents",
    async handler(args, ctx) {
      const text = args.trim();
      if (!runtime) {
        ctx.ui.notify("hc-subagents has not initialized yet. Try again after this turn.", "warning");
        return;
      }
      if (runtime.mode === "child") {
        ctx.ui.notify("hc-subagents: delegated children cannot spawn subagents.", "info");
        return;
      }
      if (!runtime.available) {
        ctx.ui.notify(setupMessage(runtime.prerequisites), "warning");
        return;
      }

      const [action = "list"] = text.length > 0 ? text.split(/\s+/, 1) : ["list"];
      switch (action) {
        case "config": {
          const diagnostics = formatConfigDiagnostics(runtime.loadedConfig, {
            "agents.user": runtime.agentDirs.user,
            "agents.project": runtime.agentDirs.project ?? "(none)",
            "agents.package": runtime.agentDirs.package,
            "hc.version": runtime.prerequisites.coreVersion ?? "unknown",
            mode: runtime.mode,
          });
          ctx.ui.notify(diagnostics, "info");
          return;
        }
        case "list": {
          const records = toolSession?.registry.listForParent(runtime.parentSessionId) ?? [];
          if (records.length === 0) {
            ctx.ui.notify("No subagents yet.", "info");
            return;
          }
          const lines = records.map((record) => {
            const duration = formatDuration(Date.now() - Date.parse(record.createdAt));
            return `${record.slug}  ${record.state}  ${record.terminal}  ${record.agent}  ${duration}`;
          });
          ctx.ui.notify(lines.join("\n"), "info");
          return;
        }
        default:
          ctx.ui.notify(HELP_TEXT, "info");
          return;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    if (toolSession) {
      await shutdownOwnedChildren(toolSession).catch(() => {});
      toolSession = null;
    }
    runtime = await createRuntime({
      cwd: ctx.cwd,
      trusted: ctx.isProjectTrusted(),
      parentSessionId: ctx.sessionManager.getSessionId(),
    });

    if (runtime.mode === "child") {
      toolSession = null;
      return;
    }

    if (runtime.configWarnings.length > 0 && ctx.hasUI) {
      const summary = runtime.configWarnings
        .slice(0, 3)
        .map((warning) => `${warning.source}.${warning.field}: ${warning.message}`)
        .join("; ");
      ctx.ui.notify(`hc-subagents config warnings: ${summary}`, "warning");
    }

    if (!runtime.available && !setupNotified) {
      setupNotified = true;
      if (ctx.hasUI) ctx.ui.notify(setupNotification(runtime.prerequisites), "warning");
    }

    if (runtime.mode === "ready") {
      toolSession = {
        runtime,
        registry: new Registry(),
        scheduler: new Scheduler({
          maxConcurrency: runtime.config.maxConcurrency,
          parallelWrites: runtime.config.parallelWrites,
        }),
      };
      if (!toolsRegistered) {
        registerSpawnTool(pi, () => toolSession, { exposure: runtime.config.exposure });
        registerControlTool(pi, () => toolSession, { exposure: runtime.config.exposure });
        toolsRegistered = true;
      }
    } else {
      toolSession = null;
    }
    // Tools are registered only after prerequisite checks. Never expose a tool
    // when the runtime is not ready.
  });

  pi.on("session_shutdown", async () => {
    const current = toolSession;
    toolSession = null;
    runtime = null;
    if (current) {
      // Kill every child this parent started; hc parent relation is the second
      // line of defense if this handler cannot run.
      await shutdownOwnedChildren(current).catch(() => {});
    }
  });
}

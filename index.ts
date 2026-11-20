/**
 * pi-hc-subagents — delegate tasks to interactive pi subagents in herdr-core terminals.
 *
 * `index.ts` is wiring only. Business logic lives in `src/`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { formatConfigDiagnostics } from "./src/config/config.ts";
import { type ExtensionRuntime, createRuntime, runtimeDiagnostics } from "./src/runtime/runtime.ts";
import { setupMessage, setupNotification } from "./src/runtime/setup-mode.ts";

const COMMAND_NAME = "hc-subagents";

const HELP_TEXT = [
  "Usage: /hc-subagents [list|config|attach <id>|result <id>|kill <id>]",
  "",
  "list    current children (default)",
  "config  effective configuration and agent directories",
  "attach  print the hc attach command for a child",
  "result  print a child's final result",
  "kill    end a child terminal",
].join("\n");

export default function hcSubagentsExtension(pi: ExtensionAPI): void {
  let runtime: ExtensionRuntime | null = null;
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
          // The registry arrives in phase 5/8; until then report the honest empty state.
          ctx.ui.notify("No subagents yet.\n\n" + runtimeDiagnostics(runtime), "info");
          return;
        }
        default:
          ctx.ui.notify(HELP_TEXT, "info");
          return;
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    runtime = await createRuntime({
      cwd: ctx.cwd,
      trusted: ctx.isProjectTrusted(),
      parentSessionId: ctx.sessionManager.getSessionId(),
    });

    if (runtime.mode === "child") return;

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

    // Tools are registered in phase 7, after prerequisite checks. Never expose
    // a tool when the runtime is not ready.
  });

  pi.on("session_shutdown", async () => {
    // Lifecycle cleanup arrives in phase 8.
    runtime = null;
  });
}

/**
 * pi-hc-subagents — delegate tasks to interactive pi subagents in herdr-core terminals.
 *
 * `index.ts` is wiring only. Business logic lives in `src/`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { runsRootFor } from "./src/child/paths.ts";
import { Registry } from "./src/runtime/registry.ts";
import { Scheduler } from "./src/runtime/scheduler.ts";
import { type ExtensionRuntime, createRuntime, modelRef } from "./src/runtime/runtime.ts";
import { setupNotification } from "./src/runtime/setup-mode.ts";
import { shutdownOwnedChildren } from "./src/runtime/lifecycle.ts";
import { MonitorManager } from "./src/runtime/async-monitor.ts";
import { SettleHintHub } from "./src/runtime/settle-hints.ts";
import { Notifier } from "./src/runtime/notifier.ts";
import { RunPersistence, mergeSummaries, type PersistenceEntry } from "./src/runtime/persistence.ts";
import { loadSummariesFromRunDirs, reconcileRuns } from "./src/runtime/reconcile.ts";
import { cleanupExpiredRuns } from "./src/runtime/retention.ts";
import {
  IntertoolServiceV1,
  READY_EVENT,
  SHUTDOWN_EVENT,
  installService,
  removeService,
} from "./src/intertool/service.ts";
import { HcSubagentsWidget } from "./src/ui/widget.ts";
import { registerHcSubagentsCommand } from "./src/ui/command.ts";
import { registerHcSubagentsRenderers } from "./src/ui/renderers.ts";
import { PiSessionResultAdapter } from "./src/child/pi-result-adapter.ts";
import { ProviderRegistry, ResultAdapterRegistry } from "./src/intertool/adapters.ts";
import { HcLocalProvider } from "./src/intertool/hc-local-provider.ts";
import { registerControlTool } from "./src/tools/control-tool.ts";
import { registerSpawnTool } from "./src/tools/spawn-tool.ts";
import type { ToolSession } from "./src/tools/session.ts";

export default function hcSubagentsExtension(pi: ExtensionAPI): void {
  let runtime: ExtensionRuntime | null = null;
  let toolSession: ToolSession | null = null;
  let widget: HcSubagentsWidget | null = null;
  let toolsRegistered = false;
  let setupNotified = false;
  let compacting = false;

  registerHcSubagentsRenderers(pi);

  registerHcSubagentsCommand(pi, {
    getSession: () => toolSession,
    getRuntime: () => runtime,
  });

  function refreshWidget(): void {
    if (!widget || !toolSession) return;
    widget.refresh(
      toolSession.registry.listForParent(toolSession.runtime.parentSessionId, { includeFinished: false }),
    );
  }

  async function teardownSession(): Promise<void> {
    const current = toolSession;
    widget?.dispose();
    widget = null;
    toolSession = null;
    runtime = null;
    if (!current) return;
    current.monitors?.stopAll();
    if (current.service) {
      if (current.runtime.config.intertool.exposeService) {
        try {
          pi.events?.emit?.(SHUTDOWN_EVENT, { version: 1 });
        } catch {
          // Bus is best effort.
        }
        removeService();
      }
      current.service.dispose();
    }
    current.notifier?.dispose();
    current.settleHints?.closeAll();
    await shutdownOwnedChildren(current).catch(() => {});
    for (const record of current.registry.listForParent(current.runtime.parentSessionId)) {
      current.persistence?.append(record);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    await teardownSession();
    runtime = await createRuntime({
      cwd: ctx.cwd,
      trusted: ctx.isProjectTrusted(),
      parentSessionId: ctx.sessionManager.getSessionId(),
      parentModel: modelRef(ctx.model),
      parentThinking: ctx.thinkingLevel ?? null,
    });

    if (runtime.mode === "child") return;

    if (runtime.configWarnings.length > 0 && ctx.hasUI) {
      const summary = runtime.configWarnings
        .slice(0, 3)
        .map((warning) => `${warning.source}.${warning.field}: ${warning.message}`)
        .join("; ");
      ctx.ui.notify(`hc-subagents config warnings: ${summary}`, "warning");
    }

    if (!runtime.available) {
      if (!setupNotified) {
        setupNotified = true;
        if (ctx.hasUI) ctx.ui.notify(setupNotification(runtime.prerequisites), "warning");
      }
      return;
    }

    const persistence = new RunPersistence({
      appendEntry: (customType, data) => pi.appendEntry(customType, data),
      getEntries: () =>
        (ctx.sessionManager.getEntries?.() ?? []) as PersistenceEntry[],
    });

    const session: ToolSession = {
      runtime,
      registry: new Registry(),
      scheduler: new Scheduler({
        maxConcurrency: runtime.config.maxConcurrency,
        parallelWrites: runtime.config.parallelWrites,
      }),
      persistence,
      monitors: new MonitorManager(),
      // No hub at all when the feature is off: an ignored socket is dead weight.
      ...(runtime.config.wakeOnSettle ? { settleHints: new SettleHintHub() } : {}),
      isIdle: () => (typeof ctx.isIdle === "function" ? ctx.isIdle() : true),
    };
    session.providers = new ProviderRegistry([new HcLocalProvider(session)]);
    session.resultAdapters = new ResultAdapterRegistry(new PiSessionResultAdapter());

    const fromEntries = persistence.restore(runtime.parentSessionId);
    const runsRoot = runsRootFor({ agentDir: runtime.agentDir, env: runtime.env });
    const fromDisk = await loadSummariesFromRunDirs({
      runsRoot,
      parentSessionId: runtime.parentSessionId,
    }).catch(() => []);
    const reconciled = await reconcileRuns({
      registry: session.registry,
      summaries: mergeSummaries(fromEntries, fromDisk),
      core: runtime.core,
    }).catch(() => ({ restored: [], stale: [] }));
    // Stale runs never got a hub, so this is a best-effort no-op that keeps the
    // "every end-of-life path closes" rule uniform.
    for (const stale of reconciled.stale) session.settleHints?.close(stale.childId);

    session.notifier = new Notifier({
      sendMessage: (message, options) => pi.sendMessage(message, options),
      isIdle: () => (typeof ctx.isIdle === "function" ? ctx.isIdle() : true),
      isCompacting: () => compacting,
    });

    if (runtime.config.intertool.exposeService || runtime.config.intertool.emitEvents) {
      const service = new IntertoolServiceV1({
        session,
        exposeService: runtime.config.intertool.exposeService,
        emitEvents: runtime.config.intertool.emitEvents,
        includeTaskPreview: runtime.config.intertool.includeTaskPreview,
        ...(pi.events === undefined
          ? {}
          : { emitEvent: (channel: string, payload: unknown) => pi.events.emit(channel, payload) }),
      });
      session.service = service;
      if (runtime.config.intertool.exposeService) {
        installService(service);
        try {
          pi.events?.emit?.(READY_EVENT, {
            version: 1,
            service,
            capabilities: service.capabilities,
          });
        } catch {
          // Consumers can also find the symbol.
        }
      }
    }

    if (ctx.hasUI) {
      widget = new HcSubagentsWidget(ctx.ui, { width: () => process.stdout.columns ?? 100 });
      widget.start();
    }
    session.onRecordChange = () => refreshWidget();

    toolSession = session;
    if (!toolsRegistered) {
      registerSpawnTool(pi, () => toolSession, { exposure: runtime.config.exposure });
      registerControlTool(pi, () => toolSession, { exposure: runtime.config.exposure });
      toolsRegistered = true;
    }
    refreshWidget();

    // Retention is best effort and never blocks tool use.
    const retained = await cleanupExpiredRuns({
      runsRoot,
      retentionDays: runtime.config.retentionDays,
      isTerminalLive: async (terminal) => {
        const record = await runtime?.core.tryGet(terminal).catch(() => null);
        return record?.state === "live";
      },
    }).catch(() => null);
    if (retained && retained.removed.length > 0) {
      const removed = new Set(retained.removed);
      for (const record of session.registry.listForParent(runtime.parentSessionId)) {
        if (record.runDir && removed.has(record.runDir)) session.settleHints?.close(record.childId);
      }
    }
    // Tools are registered only after prerequisite checks. Never expose a tool
    // when the runtime is not ready.
  });

  pi.on("agent_settled", () => {
    // A settled agent has no compaction in flight; this also clears a cancelled
    // compaction that never emitted session_compact_failed.
    compacting = false;
    toolSession?.notifier?.flush();
    refreshWidget();
  });

  pi.on("session_before_compact", () => {
    compacting = true;
  });

  pi.on("session_compact", () => {
    compacting = false;
    toolSession?.notifier?.flush();
  });

  pi.on("session_compact_failed", () => {
    compacting = false;
    toolSession?.notifier?.flush();
  });

  pi.on("session_shutdown", async () => {
    await teardownSession();
  });
}

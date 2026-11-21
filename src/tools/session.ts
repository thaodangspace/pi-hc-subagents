/**
 * Active tool session: the runtime plus run-scoped services.
 */
import type { MonitorManager } from "../runtime/async-monitor.ts";
import type { Notifier } from "../runtime/notifier.ts";
import type { RunPersistence } from "../runtime/persistence.ts";
import type { Scheduler } from "../runtime/scheduler.ts";
import type { Registry } from "../runtime/registry.ts";
import type { ExtensionRuntime } from "../runtime/runtime.ts";
import type { IntertoolServiceV1 } from "../intertool/service.ts";
import type { SubagentRecord } from "../runtime/types.ts";
import type { AgentSource } from "../agents/agents.ts";
import type { AgentCatalog } from "../runtime/agent-catalog.ts";
import type { ProviderRegistry, ResultAdapterRegistry } from "../intertool/adapters.ts";
import type { SettleHintHub } from "../runtime/settle-hints.ts";

export interface ToolSession {
  runtime: ExtensionRuntime;
  registry: Registry;
  scheduler: Scheduler;
  /** Background monitors; absent in minimal test sessions. */
  monitors?: MonitorManager;
  /** Settle-hint subscriptions (one per child); absent in minimal test sessions. */
  settleHints?: SettleHintHub;
  /** Parent notification queue. */
  notifier?: Notifier;
  /** Session-local persistence of bounded run summaries. */
  persistence?: RunPersistence;
  /** Intertool service v1; present when enabled. */
  service?: IntertoolServiceV1;
  /** Backend providers; the built-in local provider is always registered first. */
  providers?: ProviderRegistry;
  /** Result readers; the pi session adapter is the fallback. */
  resultAdapters?: ResultAdapterRegistry;
  /** Called after records change so the UI can refresh. */
  onRecordChange?: (record?: SubagentRecord) => void;
  /** True when the parent agent is idle; used by notification delivery. */
  isIdle?: () => boolean;
  /** Extra agent sources registered through the intertool service. */
  agentSources?: AgentSource[];
  /** Cached agent catalog injected into the parent prompt. */
  agentCatalog?: AgentCatalog;
  /** Unix ms when `agentCatalog` was last refreshed. */
  agentCatalogAt?: number;
}

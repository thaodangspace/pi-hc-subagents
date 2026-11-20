/**
 * Intertool service v1.
 *
 * Consumers reach this object through
 * `globalThis[Symbol.for("pi-hc-subagents.service.v1")]` and/or the
 * `hc-subagents:ready` event. It is in-process only and applies the same agent,
 * trust, concurrency, and recording rules as the tools.
 *
 * Providers are an extension point (see `adapters.ts`): the service validates
 * the request, picks the first matching provider, and contains provider/adapter
 * failures instead of crashing the parent.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

import {
  type AgentDefinition,
  type AgentScope,
  type AgentSource,
  discoverAgents,
  resolveAgent,
  validateAgentForSpawn,
} from "../agents/agents.ts";
import { PiSessionResultAdapter } from "../child/pi-result-adapter.ts";
import { HcSubagentError, toHcSubagentError } from "../core/error.ts";
import type { FinalizeResult } from "../runtime/finalize.ts";
import { sendFollowUp } from "../runtime/follow-up.ts";
import {
  type SubagentResult,
  cancelRecord,
  resolveOwnedRecord,
  toSubagentResult,
  turnStartedAtMsFor,
  waitForRecord,
} from "../runtime/run-ops.ts";
import type { SubagentRecord, SubagentState, TurnOutcome, TurnState } from "../runtime/types.ts";
import { updateCurrentTurns } from "../runtime/types.ts";
import type { ToolSession } from "../tools/session.ts";
import {
  type ProviderCancelOptions,
  type ProviderChild,
  type ProviderHost,
  type ProviderWaitOptions,
  ProviderRegistry,
  type ResultAdapter,
  ResultAdapterRegistry,
  type SpawnRequest,
  type SubagentProvider,
} from "./adapters.ts";
import { EventPublisher, type SubagentEvent, type SubagentEventListener } from "./events.ts";
import { HcLocalProvider } from "./hc-local-provider.ts";

export const SERVICE_SYMBOL_NAME = "pi-hc-subagents.service.v1";
export const READY_EVENT = "hc-subagents:ready";
export const SHUTDOWN_EVENT = "hc-subagents:shutdown";
export const SERVICE_VERSION = 1 as const;
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

export type ServiceFeature =
  | "spawn"
  | "wait"
  | "send"
  | "cancel"
  | "events"
  | "project-agents"
  | "providers"
  | "result-adapters";

export interface HcSubagentsCapabilities {
  backend: "hc-local";
  coreVersion: string;
  piVersion: string;
  platforms: string[];
  maxConcurrency: number;
  features: ServiceFeature[];
}

export type { SpawnRequest };

export type SubagentView = Readonly<SubagentRecord>;

export interface SendOutcome {
  childId: string;
  turn: number;
  accepted: boolean;
  state: SubagentState;
  outcome?: TurnOutcome | "blocked" | "pending";
  result?: SubagentResult;
}

export interface HcSubagentsService {
  readonly version: 1;
  readonly capabilities: HcSubagentsCapabilities;
  list(filter?: { includeFinished?: boolean }): Promise<SubagentView[]>;
  get(id: string): SubagentView | undefined;
  spawn(request: SpawnRequest): Promise<SubagentView>;
  wait(id: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SubagentResult>;
  send(id: string, message: string, opts?: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal }): Promise<SendOutcome>;
  cancel(id: string, opts?: { force?: boolean }): Promise<void>;
  subscribe(listener: SubagentEventListener): () => void;
  registerAgentSource?(source: AgentSource): () => void;
  registerProvider?(provider: SubagentProvider): () => void;
  registerResultAdapter?(adapter: ResultAdapter): () => void;
}

export interface IntertoolServiceOptions {
  session: ToolSession;
  exposeService: boolean;
  emitEvents: boolean;
  includeTaskPreview: boolean;
  piVersion?: string;
  emitEvent?: (channel: string, payload: unknown) => void;
  now?: () => number;
  onSubscriberError?: (error: unknown) => void;
  /** Override the session registries (tests/embedded hosts). */
  providers?: ProviderRegistry;
  resultAdapters?: ResultAdapterRegistry;
}

interface IdempotencyEntry {
  at: number;
  fingerprint: string;
  view: SubagentView;
}

interface ProviderHandle {
  child: ProviderChild;
  providerId: string;
}

function cloneView(record: SubagentRecord): SubagentView {
  return structuredClone(record);
}

function fingerprint(agent: string, task: string, cwd: string | undefined): string {
  return createHash("sha256").update(`${agent}\u0000${task}\u0000${cwd ?? ""}`).digest("hex");
}

function isTerminalState(state: SubagentState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

function turnStateOf(state: SubagentState): TurnState {
  switch (state) {
    case "blocked":
      return "blocked";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "running";
  }
}

function resolveProviderCwd(parentCwd: string, requested?: string): string {
  const candidate = path.resolve(parentCwd, requested ?? parentCwd);
  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    throw new HcSubagentError("validation", `cwd does not exist: ${candidate}`);
  }
  if (!stat.isDirectory()) {
    throw new HcSubagentError("validation", `cwd is not a directory: ${candidate}`);
  }
  return candidate;
}

function syntheticRecord(
  session: ToolSession,
  request: SpawnRequest,
  child: ProviderChild,
  providerId: string,
): SubagentRecord {
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const terminal = child.terminal ?? "";
  const agent = child.agent;
  const childId = child.childId;
  return {
    version: 1,
    runId: child.runId ?? childId,
    childId,
    parentSessionId: session.runtime.parentSessionId,
    agent: agent?.name ?? request.agent,
    agentSource: agent?.source ?? "user",
    agentAccess: agent?.access ?? "read-only",
    cwd: child.cwd ?? request.cwd ?? session.runtime.cwd,
    terminal,
    terminalName: terminal,
    sessionId: childId,
    sessionFile: child.sessionFile ?? null,
    ...(child.runDir ? { runDir: child.runDir } : {}),
    ...(child.resultFile ? { resultFile: child.resultFile } : {}),
    ...(request.model === undefined && agent?.model === undefined ? {} : { model: request.model ?? agent?.model }),
    ...(request.thinking === undefined && agent?.thinking === undefined
      ? {}
      : { thinking: request.thinking ?? agent?.thinking }),
    state: "starting",
    terminalState: "live",
    coreStatus: "unknown",
    slug: `provider-${childId.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 24)}`,
    turn: 1,
    turns: [
      {
        index: 1,
        task: request.task,
        startedAt: now,
        startedAtMs: nowDate.getTime(),
        baselineTurn: 0,
        state: "running",
        terminal,
      },
    ],
    createdAt: now,
    updatedAt: now,
    labels: {},
    background: true,
    origin: request.origin ?? "intertool",
    provider: providerId,
  };
}

export class IntertoolServiceV1 implements HcSubagentsService {
  readonly version = SERVICE_VERSION;
  readonly capabilities: HcSubagentsCapabilities;
  readonly #session: ToolSession;
  readonly #events: EventPublisher;
  readonly #now: () => number;
  readonly #providers: ProviderRegistry;
  readonly #resultAdapters: ResultAdapterRegistry;
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #providerChildren = new Map<string, ProviderHandle>();
  readonly #emittedSpawned = new Set<string>();
  readonly #emittedTerminal = new Set<string>();
  readonly #emittedBlocked = new Set<string>();
  #disposed = false;

  constructor(options: IntertoolServiceOptions) {
    this.#session = options.session;
    this.#now = options.now ?? (() => Date.now());
    if (!this.#session.providers) {
      this.#session.providers = new ProviderRegistry([new HcLocalProvider(this.#session)]);
    }
    if (!this.#session.resultAdapters) {
      this.#session.resultAdapters = new ResultAdapterRegistry(new PiSessionResultAdapter());
    }
    this.#providers = options.providers ?? this.#session.providers;
    this.#resultAdapters = options.resultAdapters ?? this.#session.resultAdapters;
    this.#events = new EventPublisher({
      enabled: () => options.emitEvents,
      includeTaskPreview: () => options.includeTaskPreview,
      ...(options.emitEvent === undefined ? {} : { emit: options.emitEvent }),
      ...(options.onSubscriberError === undefined ? {} : { onSubscriberError: options.onSubscriberError }),
      now: () => new Date(this.#now()),
    });
    this.capabilities = {
      backend: "hc-local",
      coreVersion: options.session.runtime.prerequisites.coreVersion ?? "unknown",
      piVersion: options.piVersion ?? process.env.PI_VERSION ?? "unknown",
      platforms: [process.platform],
      maxConcurrency: options.session.runtime.config.maxConcurrency,
      features: [
        "spawn",
        "wait",
        "send",
        "cancel",
        "events",
        "project-agents",
        "providers",
        "result-adapters",
      ],
    };
  }

  async list(filter: { includeFinished?: boolean } = {}): Promise<SubagentView[]> {
    this.#assertAlive();
    return this.#session.registry
      .listForParent(this.#session.runtime.parentSessionId, filter)
      .map(cloneView);
  }

  get(id: string): SubagentView | undefined {
    if (this.#disposed) return undefined;
    try {
      return cloneView(resolveOwnedRecord(this.#session, id));
    } catch {
      return undefined;
    }
  }

  async spawn(request: SpawnRequest): Promise<SubagentView> {
    this.#assertAlive();
    if (typeof request.agent !== "string" || request.agent.trim().length === 0) {
      throw new HcSubagentError("validation", "agent must not be empty");
    }
    if (typeof request.task !== "string" || request.task.trim().length === 0) {
      throw new HcSubagentError("validation", "task must not be empty");
    }
    if (Buffer.byteLength(request.task, "utf8") > 256 * 1024) {
      throw new HcSubagentError("validation", "task exceeds 262144 bytes");
    }
    if (request.backend !== undefined && (typeof request.backend !== "string" || request.backend.trim().length === 0)) {
      throw new HcSubagentError("validation", "backend must be a non-empty string");
    }

    const origin = request.origin ?? "intertool";
    const taskCwd = request.cwd ?? this.#session.runtime.cwd;
    const fingerprintValue = fingerprint(request.agent, request.task, taskCwd);
    if (request.clientRequestId) {
      const key = `${origin}:${request.clientRequestId}`;
      const existing = this.#idempotency.get(key);
      if (existing && this.#now() - existing.at <= IDEMPOTENCY_TTL_MS) {
        if (existing.fingerprint === fingerprintValue) {
          const current = this.#session.registry.get(existing.view.childId);
          return structuredClone(current ?? existing.view);
        }
        throw new HcSubagentError("validation", `clientRequestId ${request.clientRequestId} was reused with different input`);
      }
      this.#pruneIdempotency();
    }

    if (request.signal?.aborted) throw new HcSubagentError("aborted", "spawn aborted before start");

    const selection = this.#providers.select(request);
    if (!selection.provider) {
      const registered = this.#providers.list().map((provider) => provider.id).join(", ") || "none";
      throw new HcSubagentError(
        "unsupported_backend",
        `no provider handles backend "${request.backend ?? "hc-local"}"`,
        { hint: `registered providers: ${registered}` },
      );
    }

    let child: ProviderChild;
    try {
      child = await selection.provider.spawn(request, this.#createHost(request));
    } catch (error) {
      const normalized = toHcSubagentError(error, "spawn_failed");
      throw normalized.code === "unknown"
        ? new HcSubagentError("spawn_failed", normalized.message, {
            ...(normalized.hint === undefined ? {} : { hint: normalized.hint }),
            cause: normalized,
          })
        : normalized;
    }

    if (
      !child ||
      typeof child.childId !== "string" ||
      child.childId.trim().length === 0 ||
      child.childId.length > 128 ||
      typeof child.wait !== "function" ||
      typeof child.cancel !== "function"
    ) {
      throw new HcSubagentError("protocol", `provider ${selection.provider.id} returned an invalid child`);
    }

    let record: SubagentRecord;
    if (child.record) {
      if (child.record.parentSessionId !== this.#session.runtime.parentSessionId) {
        throw new HcSubagentError("protocol", "provider returned a child owned by another parent session");
      }
      if (child.record.childId !== child.childId) {
        throw new HcSubagentError("protocol", "provider record and child ids do not match");
      }
      record = this.#session.registry.get(child.record.childId) ?? this.#session.registry.create(child.record);
      if (record.provider === undefined) {
        record = this.#session.registry.update(record.childId, { provider: selection.provider.id });
      }
    } else {
      record = this.#session.registry.create(syntheticRecord(this.#session, request, child, selection.provider.id));
    }
    this.#providerChildren.set(record.childId, { child, providerId: selection.provider.id });
    this.emitSpawned(record, request.task);

    const view = cloneView(record);
    if (request.clientRequestId) {
      this.#idempotency.set(`${origin}:${request.clientRequestId}`, {
        at: this.#now(),
        fingerprint: fingerprintValue,
        view,
      });
    }
    return structuredClone(view);
  }

  async wait(id: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<SubagentResult> {
    this.#assertAlive();
    const record = resolveOwnedRecord(this.#session, id);
    const handle = this.#providerChildren.get(record.childId);
    if (handle) {
      try {
        const result = await handle.child.wait({
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
          ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        });
        const updated = this.#applyProviderResult(record, result);
        if (isTerminalState(result.state)) {
          this.#emitProviderTerminal(updated, result.outcome, result.resultFile ?? updated.resultFile ?? "", result.error);
          this.#providerChildren.delete(record.childId);
          this.#session.notifier?.markDelivered(updated.childId, updated.turn, "result");
        } else if (result.state === "blocked") {
          this.#providerChildren.set(record.childId, handle);
          this.emitBlocked(updated, result.blocked?.kind, result.blocked?.message, updated.turn);
        }
        return result;
      } catch (error) {
        const normalized = toHcSubagentError(error, "provider_failed");
        const adapted = await this.#readWithAdapter(record, handle.providerId);
        if (adapted) {
          this.#providerChildren.delete(record.childId);
          return adapted;
        }
        this.#providerChildren.delete(record.childId);
        return this.#failProviderRecord(record, normalized);
      }
    }

    const result = await waitForRecord(this.#session, record, {
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (isTerminalState(result.state)) {
      this.#session.notifier?.markDelivered(record.childId, record.turn, "result");
    }
    return result;
  }

  async send(
    id: string,
    message: string,
    opts: { wait?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<SendOutcome> {
    this.#assertAlive();
    if (typeof message !== "string" || message.trim().length === 0) {
      throw new HcSubagentError("validation", "message must not be empty");
    }
    const record = resolveOwnedRecord(this.#session, id);
    const handle = this.#providerChildren.get(record.childId);
    if ((handle && handle.providerId !== "hc-local") || (!handle && record.provider && record.provider !== "hc-local")) {
      throw new HcSubagentError(
        "unsupported",
        `provider ${handle?.providerId ?? record.provider} does not support follow-up messages`,
      );
    }
    const outcome = await sendFollowUp(this.#session, record, {
      message,
      wait: opts.wait ?? true,
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (outcome.finalized) {
      this.#session.notifier?.markDelivered(outcome.record.childId, outcome.record.turn, "result");
      return {
        childId: outcome.record.childId,
        turn: outcome.record.turn,
        accepted: true,
        state: outcome.finalized.state,
        outcome: outcome.finalized.outcome,
        result: toSubagentResult(outcome.record, outcome.finalized),
      };
    }
    if (outcome.blocked) {
      return {
        childId: outcome.record.childId,
        turn: outcome.record.turn,
        accepted: true,
        state: "blocked",
        outcome: "blocked",
      };
    }
    return {
      childId: outcome.record.childId,
      turn: outcome.record.turn,
      accepted: true,
      state: outcome.record.state,
      outcome: "pending",
    };
  }

  async cancel(id: string, opts: { force?: boolean } = {}): Promise<void> {
    this.#assertAlive();
    const record = resolveOwnedRecord(this.#session, id);
    this.#session.monitors?.stop(record.childId);
    const handle = this.#providerChildren.get(record.childId);
    if (handle) {
      try {
        await handle.child.cancel({
          ...(opts.force === undefined ? {} : { force: opts.force }),
        });
      } catch (error) {
        const normalized = toHcSubagentError(error, "provider_failed");
        this.#failProviderRecord(record, normalized);
        this.#providerChildren.delete(record.childId);
        throw normalized;
      }
      let updated = this.#session.registry.get(record.childId) ?? record;
      if (updated.state !== "cancelled") {
        const now = new Date().toISOString();
        updated = this.#session.registry.update(record.childId, {
          state: "cancelled",
          settledAt: now,
          error: "cancelled",
          turns: updateCurrentTurns(updated, () => ({
            state: "cancelled" as const,
            outcome: "aborted" as const,
            settledAt: now,
          })),
        });
      }
      this.#events.settled(updated, "aborted", updated.resultFile ?? "");
      this.#events.removed(updated);
      this.#session.persistence?.append(updated);
      this.#session.onRecordChange?.(updated);
      this.#providerChildren.delete(record.childId);
      return;
    }

    const { record: cancelled } = await cancelRecord(this.#session, record, {
      ...(opts.force === undefined ? {} : { force: opts.force }),
    });
    this.#events.settled(cancelled, "aborted", cancelled.resultFile ?? "");
    this.#events.removed(cancelled);
    this.#session.persistence?.append(cancelled);
    this.#session.onRecordChange?.(cancelled);
  }

  subscribe(listener: SubagentEventListener): () => void {
    if (this.#disposed) return () => {};
    return this.#events.subscribe(listener);
  }

  registerAgentSource(source: AgentSource): () => void {
    if (this.#disposed) return () => {};
    const sources = (this.#session.agentSources ??= []);
    if (!sources.some((existing) => existing.id === source.id)) sources.push(source);
    return () => {
      const index = sources.indexOf(source);
      if (index >= 0) sources.splice(index, 1);
    };
  }

  registerProvider(provider: SubagentProvider): () => void {
    if (this.#disposed) throw new HcSubagentError("unavailable", "hc-subagents service is shut down");
    return this.#providers.register(provider);
  }

  registerResultAdapter(adapter: ResultAdapter): () => void {
    if (this.#disposed) throw new HcSubagentError("unavailable", "hc-subagents service is shut down");
    return this.#resultAdapters.register(adapter);
  }

  /** Emit `spawned` once per child, regardless of caller (tool or service). */
  emitSpawned(record: SubagentRecord, task?: string): void {
    if (this.#disposed || this.#emittedSpawned.has(record.childId)) return;
    this.#emittedSpawned.add(record.childId);
    this.#events.spawned(record, task);
  }

  /** Monitor hook: a child changed working/starting state. */
  emitStatus(record: SubagentRecord, previousState: SubagentState): void {
    if (this.#disposed) return;
    this.#events.status(record, previousState);
  }

  /** One blocked event per episode, even if several callers observe it. */
  emitBlocked(record: SubagentRecord, kind?: string | null, message?: string | null, episode = 0): void {
    if (this.#disposed) return;
    const key = `${record.childId}:${record.turn}:blocked:${episode}`;
    if (this.#emittedBlocked.has(key)) return;
    this.#emittedBlocked.add(key);
    this.#events.blocked(record, kind, message);
  }

  /** Control/command kill: mark the run cancelled and notify consumers once. */
  emitCancelled(record: SubagentRecord): void {
    const key = `${record.childId}:${record.turn}`;
    if (this.#disposed || this.#emittedTerminal.has(key)) return;
    this.#emittedTerminal.add(key);
    this.#events.settled(record, "aborted", record.resultFile ?? "");
    this.#events.removed(record);
  }

  /** Publish after result.json so consumers can read it (once per turn). */
  emitSettled(finalized: FinalizeResult): void {
    const record = finalized.record;
    const key = `${record.childId}:${record.turn}`;
    if (this.#disposed || this.#emittedTerminal.has(key)) return;
    this.#emittedTerminal.add(key);
    const resultPath = finalized.result.details.resultFile ?? record.resultFile ?? "";
    if (finalized.state === "failed") {
      this.#events.failed(record, finalized.outcome, finalized.result.details.error ?? "child failed");
      return;
    }
    this.#events.settled(record, finalized.outcome, resultPath);
  }

  dispose(): void {
    this.#disposed = true;
    this.#idempotency.clear();
    this.#providerChildren.clear();
    this.#emittedSpawned.clear();
    this.#emittedTerminal.clear();
    this.#emittedBlocked.clear();
    this.#events.dispose();
  }

  get subscriberCount(): number {
    return this.#events.subscriberCount;
  }

  #createHost(request: SpawnRequest): ProviderHost {
    const session = this.#session;
    const runtime = session.runtime;
    const trusted = runtime.trusted;
    return {
      parentSessionId: runtime.parentSessionId,
      parentTerminalId: runtime.parentTerminalId ?? "",
      parentless: runtime.parentTerminalId === null,
      config: runtime.config,
      async resolveAgent(name: string, scope?: AgentScope): Promise<AgentDefinition> {
        const discovery = await discoverAgents({
          cwd: runtime.cwd,
          scope: scope ?? request.agentScope ?? runtime.config.agentScope,
          trusted,
          agentDir: runtime.agentDir,
          packageDir: runtime.agentDirs.package,
          ...(session.agentSources === undefined ? {} : { extraSources: session.agentSources }),
        });
        let agent = resolveAgent(discovery, name);
        if (request.model !== undefined) agent = { ...agent, model: request.model };
        if (request.thinking !== undefined) agent = { ...agent, thinking: request.thinking };
        validateAgentForSpawn(agent, { trusted });
        return agent;
      },
      resolveCwd(cwd?: string): string {
        return resolveProviderCwd(runtime.cwd, cwd);
      },
      assertProjectTrust(agent: AgentDefinition): void {
        if (agent.source !== "project") return;
        if (!trusted) {
          throw new HcSubagentError("project_agent_not_trusted", `project agent ${agent.name} requires a trusted project`, {
            hint: "trust this project in pi before using project-local agents",
          });
        }
        if (request.allowTrustedProjectAgents === true) return;
        throw new HcSubagentError(
          "project_agent_not_trusted",
          `project agent ${agent.name} requires confirmation, but no UI is available`,
          { hint: "pass allowTrustedProjectAgents:true only when you trust this project" },
        );
      },
      acquireConcurrencySlot(options = {}): Promise<() => void> {
        return session.scheduler.acquire({
          write: options.write === true,
          cwd: options.cwd ?? runtime.cwd,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      },
    };
  }

  #applyProviderResult(record: SubagentRecord, result: SubagentResult): SubagentRecord {
    const now = new Date().toISOString();
    const settled = isTerminalState(result.state);
    return this.#session.registry.update(record.childId, {
      state: result.state,
      ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
      ...(result.resultFile ? { resultFile: result.resultFile } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(settled ? { settledAt: now } : {}),
      turns: updateCurrentTurns(record, () => ({
        state: turnStateOf(result.state),
        outcome: result.outcome,
        ...(result.text === undefined ? {} : { text: result.text }),
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.error ? { error: result.error } : {}),
        ...(settled ? { settledAt: now } : {}),
      })),
    });
  }

  #emitProviderTerminal(
    record: SubagentRecord,
    outcome: TurnOutcome,
    resultPath: string,
    error?: string,
  ): void {
    const key = `${record.childId}:${record.turn}`;
    if (this.#disposed || this.#emittedTerminal.has(key)) return;
    this.#emittedTerminal.add(key);
    if (record.state === "failed" || outcome === "error") {
      this.#events.failed(record, outcome, error ?? record.error ?? "child failed");
      return;
    }
    this.#events.settled(record, outcome, resultPath);
  }

  async #readWithAdapter(record: SubagentRecord, providerId: string): Promise<SubagentResult | null> {
    const outcome = await this.#resultAdapters.read({
      provider: providerId,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      ...(record.resultFile ? { resultFile: record.resultFile } : {}),
      childId: record.childId,
      runId: record.runId,
      terminal: record.terminal,
      turnStartedAtMs: turnStartedAtMsFor(record),
      durationMs: Math.max(0, this.#now() - Date.parse(record.createdAt)),
      final: true,
    });
    if (outcome.result) {
      const updated = this.#applyProviderResult(record, outcome.result);
      if (isTerminalState(updated.state)) {
        this.#emitProviderTerminal(updated, outcome.result.outcome, outcome.result.resultFile ?? updated.resultFile ?? "", outcome.result.error);
        this.#session.notifier?.markDelivered(updated.childId, updated.turn, "result");
      }
      return outcome.result;
    }
    if (outcome.failure) {
      return this.#failProviderRecord(record, outcome.failure.error);
    }
    return null;
  }

  #failProviderRecord(record: SubagentRecord, error: HcSubagentError): SubagentResult {
    const now = new Date().toISOString();
    const updated = this.#session.registry.update(record.childId, {
      state: "failed",
      settledAt: now,
      error: `provider_failed: ${error.message}`,
      turns: updateCurrentTurns(record, () => ({
        state: "failed" as const,
        outcome: "incomplete" as const,
        error: `provider_failed: ${error.message}`,
        settledAt: now,
      })),
    });
    this.#emitProviderTerminal(updated, "incomplete", updated.resultFile ?? "", updated.error);
    this.#session.persistence?.append(updated);
    this.#session.onRecordChange?.(updated);
    return {
      ...toSubagentResult(updated),
      state: "failed",
      outcome: "incomplete",
      error: updated.error,
    };
  }

  #assertAlive(): void {
    if (this.#disposed) throw new HcSubagentError("unavailable", "hc-subagents service is shut down");
  }

  #pruneIdempotency(): void {
    const now = this.#now();
    for (const [key, entry] of this.#idempotency) {
      if (now - entry.at > IDEMPOTENCY_TTL_MS) this.#idempotency.delete(key);
    }
    while (this.#idempotency.size > 200) {
      const oldest = this.#idempotency.keys().next();
      if (oldest.done) break;
      this.#idempotency.delete(oldest.value);
    }
  }
}

export interface ServiceInstallTarget {
  [key: symbol]: unknown;
}

export function installService(
  service: IntertoolServiceV1,
  target: ServiceInstallTarget = globalThis as unknown as ServiceInstallTarget,
): void {
  (target as Record<symbol, unknown>)[Symbol.for(SERVICE_SYMBOL_NAME)] = service;
}

export function removeService(target: ServiceInstallTarget = globalThis as unknown as ServiceInstallTarget): void {
  delete (target as Record<symbol, unknown>)[Symbol.for(SERVICE_SYMBOL_NAME)];
}

export function serviceFrom(
  target: ServiceInstallTarget = globalThis as unknown as ServiceInstallTarget,
): HcSubagentsService | undefined {
  return (target as Record<symbol, unknown>)[Symbol.for(SERVICE_SYMBOL_NAME)] as HcSubagentsService | undefined;
}

export const SERVICE_EVENT_TYPES: readonly string[] = [
  READY_EVENT,
  SHUTDOWN_EVENT,
  "hc-subagents:child.spawned",
  "hc-subagents:child.status",
  "hc-subagents:child.blocked",
  "hc-subagents:child.settled",
  "hc-subagents:child.failed",
  "hc-subagents:child.removed",
];

export type { SubagentEvent, SubagentEventListener };

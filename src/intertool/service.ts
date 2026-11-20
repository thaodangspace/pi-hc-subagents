/**
 * Intertool service v1.
 *
 * Consumers reach this object through
 * `globalThis[Symbol.for("pi-hc-subagents.service.v1")]` and/or the
 * `hc-subagents:ready` event. It is in-process only and applies the same agent,
 * trust, concurrency, and recording rules as the tools.
 */
import { createHash } from "node:crypto";

import type { AgentDefinition, AgentScope, AgentSource, ThinkingLevel } from "../agents/agents.ts";
import { HcSubagentError } from "../core/error.ts";
import type { ToolSession } from "../tools/session.ts";
import { EventPublisher, type SubagentEvent, type SubagentEventListener } from "./events.ts";
import type { FinalizeResult } from "../runtime/finalize.ts";
import {
  type SubagentResult,
  cancelRecord,
  resolveOwnedRecord,
  waitForRecord,
} from "../runtime/run-ops.ts";
import { startBackgroundRun } from "../runtime/run-background.ts";
import type { SubagentRecord, SubagentState, TurnOutcome } from "../runtime/types.ts";

export const SERVICE_SYMBOL_NAME = "pi-hc-subagents.service.v1";
export const READY_EVENT = "hc-subagents:ready";
export const SHUTDOWN_EVENT = "hc-subagents:shutdown";
export const SERVICE_VERSION = 1 as const;
export const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

export type ServiceFeature = "spawn" | "wait" | "send" | "cancel" | "events" | "project-agents";

export interface HcSubagentsCapabilities {
  backend: "hc-local";
  coreVersion: string;
  piVersion: string;
  platforms: string[];
  maxConcurrency: number;
  features: ServiceFeature[];
}

export interface SpawnRequest {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
  background?: boolean;
  agentScope?: AgentScope;
  origin?: string;
  clientRequestId?: string;
  /** Explicit pre-approval for trusted project agents (no UI prompt). */
  allowTrustedProjectAgents?: boolean;
  signal?: AbortSignal;
}

export type SubagentView = Readonly<SubagentRecord>;

export interface HcSubagentsService {
  readonly version: 1;
  readonly capabilities: HcSubagentsCapabilities;
  list(filter?: { includeFinished?: boolean }): Promise<SubagentView[]>;
  get(id: string): SubagentView | undefined;
  spawn(request: SpawnRequest): Promise<SubagentView>;
  wait(id: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SubagentResult>;
  cancel(id: string, opts?: { force?: boolean }): Promise<void>;
  subscribe(listener: SubagentEventListener): () => void;
  registerAgentSource?(source: AgentSource): () => void;
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
}

interface IdempotencyEntry {
  at: number;
  fingerprint: string;
  view: SubagentView;
}

function cloneView(record: SubagentRecord): SubagentView {
  return structuredClone(record);
}

function fingerprint(agent: string, task: string, cwd: string | undefined): string {
  return createHash("sha256").update(`${agent}\u0000${task}\u0000${cwd ?? ""}`).digest("hex");
}

export class IntertoolServiceV1 implements HcSubagentsService {
  readonly version = SERVICE_VERSION;
  readonly capabilities: HcSubagentsCapabilities;
  readonly #session: ToolSession;
  readonly #events: EventPublisher;
  readonly #now: () => number;
  readonly #idempotency = new Map<string, IdempotencyEntry>();
  readonly #emittedSpawned = new Set<string>();
  readonly #emittedTerminal = new Set<string>();
  readonly #emittedBlocked = new Set<string>();
  #disposed = false;

  constructor(options: IntertoolServiceOptions) {
    this.#session = options.session;
    this.#now = options.now ?? (() => Date.now());
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
      features: ["spawn", "wait", "cancel", "events", "project-agents"],
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
    const origin = request.origin ?? "intertool";
    const taskCwd = request.cwd ?? this.#session.runtime.cwd;
    const fingerprintValue = fingerprint(request.agent, request.task, taskCwd);
    if (request.clientRequestId) {
      const key = `${origin}:${request.clientRequestId}`;
      const existing = this.#idempotency.get(key);
      if (existing && this.#now() - existing.at <= IDEMPOTENCY_TTL_MS) {
        if (existing.fingerprint === fingerprintValue) return structuredClone(existing.view);
        throw new HcSubagentError("validation", `clientRequestId ${request.clientRequestId} was reused with different input`);
      }
      this.#pruneIdempotency();
    }

    if (request.signal?.aborted) throw new HcSubagentError("aborted", "spawn aborted before start");
    const started = await startBackgroundRun(this.#session, {
      agentName: request.agent,
      task: request.task,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      ...(request.agentScope === undefined ? {} : { agentScope: request.agentScope }),
      origin,
      trusted: this.#session.runtime.trusted,
      parentCwd: this.#session.runtime.cwd,
      allowProjectAgents: request.allowTrustedProjectAgents === true,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });
    this.emitSpawned(started.record, request.task);
    const view = cloneView(started.record);
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
    const result = await waitForRecord(this.#session, record, {
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    });
    if (result.state === "completed" || result.state === "failed" || result.state === "cancelled") {
      this.#session.notifier?.markDelivered(record.childId, record.turn, "result");
    }
    return result;
  }

  async cancel(id: string, opts: { force?: boolean } = {}): Promise<void> {
    this.#assertAlive();
    const record = resolveOwnedRecord(this.#session, id);
    this.#session.monitors?.stop(record.childId);
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
    this.#emittedSpawned.clear();
    this.#emittedTerminal.clear();
    this.#emittedBlocked.clear();
    this.#events.dispose();
  }

  get subscriberCount(): number {
    return this.#events.subscriberCount;
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

/**
 * Intertool extension points: providers and result adapters.
 *
 * Providers add backends without changing the service. Result adapters turn a
 * provider's durable artifacts (usually a pi session JSONL) into the common
 * `SubagentResult`. Registration is trusted code, so both registries are
 * deliberately small and contain failures instead of crashing the parent.
 */
import type { AgentDefinition, AgentScope, ThinkingLevel } from "../agents/agents.ts";
import type { HcSubagentsConfig } from "../config/schema.ts";
import { HcSubagentError, toHcSubagentError } from "../core/error.ts";
import type { SubagentResult } from "../runtime/run-ops.ts";
import type { SubagentRecord } from "../runtime/types.ts";

/** A request to start one child. Shared by the service and providers. */
export interface SpawnRequest {
  agent: string;
  task: string;
  cwd?: string;
  model?: string;
  thinking?: ThinkingLevel;
  background?: boolean;
  agentScope?: AgentScope;
  /** Recorded in `run.json`; defaults to `intertool`. */
  origin?: string;
  /** Idempotency key per origin. */
  clientRequestId?: string;
  /** Explicit pre-approval for trusted project agents (no UI prompt). */
  allowTrustedProjectAgents?: boolean;
  /**
   * Provider id. Omitted or `"hc-local"` selects the built-in provider; a
   * custom provider can claim a different id without replacing the default.
   */
  backend?: string;
  signal?: AbortSignal;
}

/**
 * Validation surface handed to a provider. Providers MUST use it for agent
 * resolution, trust checks, cwd validation, and concurrency admission; they
 * must never build raw argv, env, or shell lines from model input.
 */
export interface ProviderHost {
  readonly parentSessionId: string;
  readonly parentTerminalId: string;
  readonly config: Readonly<HcSubagentsConfig>;
  resolveAgent(name: string, scope?: AgentScope): Promise<AgentDefinition>;
  resolveCwd(cwd?: string): string;
  /** Reject an untrusted project agent (and apply the confirmation policy). */
  assertProjectTrust(agent: AgentDefinition): void | Promise<void>;
  /**
   * Acquire one scheduler slot. The optional details are an additive extension
   * so hosts can apply write/cwd serialization; the release is idempotent.
   */
  acquireConcurrencySlot(options?: {
    write?: boolean;
    cwd?: string;
    signal?: AbortSignal;
  }): Promise<() => void>;
}

export interface ProviderWaitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProviderCancelOptions {
  force?: boolean;
}

/**
 * A child owned by a provider. `record` is optional because remote providers
 * may not have a local run record; the service synthesizes a bounded view when
 * it is absent.
 */
export interface ProviderChild {
  childId: string;
  runId?: string;
  terminal?: string;
  sessionFile?: string;
  runDir?: string;
  resultFile?: string;
  agent?: AgentDefinition;
  cwd?: string;
  /** Local providers hand back the already-registered record. */
  record?: SubagentRecord;
  wait(options?: ProviderWaitOptions): Promise<SubagentResult>;
  cancel(options?: ProviderCancelOptions): Promise<void>;
  readOutput?(lines?: number): Promise<string>;
}

export interface SubagentProvider {
  readonly id: string;
  readonly description?: string;
  canHandle(request: SpawnRequest): boolean;
  spawn(request: SpawnRequest, host: ProviderHost): Promise<ProviderChild>;
}

export interface ResultAdapterInput {
  /** Provider id, e.g. `hc-local` or a custom backend. */
  provider: string;
  sessionFile?: string;
  terminal?: string;
  // Additive metadata so an adapter can build a complete SubagentResult.
  childId?: string;
  runId?: string;
  resultFile?: string;
  turnStartedAtMs?: number;
  durationMs?: number;
  final?: boolean;
}

export interface ResultAdapter {
  readonly id: string;
  canHandle(input: ResultAdapterInput): boolean;
  read(input: ResultAdapterInput): Promise<SubagentResult>;
}

export interface AdapterFailure {
  adapter: string;
  error: HcSubagentError;
}

export interface AdapterReadOutcome {
  result?: SubagentResult;
  adapter?: string;
  failure?: AdapterFailure;
  /** No registered adapter claimed the input. */
  unmatched?: true;
}

function assertAdapterId(id: unknown, kind: string): string {
  if (typeof id !== "string" || id.trim().length === 0 || id.length > 64) {
    throw new HcSubagentError("validation", `${kind} id must be a non-empty string of at most 64 characters`);
  }
  return id;
}

/** Ordered provider registry; the first provider that can handle a request wins. */
export class ProviderRegistry {
  readonly #providers: SubagentProvider[] = [];

  constructor(initial: readonly SubagentProvider[] = []) {
    for (const provider of initial) this.register(provider);
  }

  register(provider: SubagentProvider): () => void {
    const id = assertAdapterId(provider?.id, "provider");
    if (this.#providers.some((existing) => existing.id === id)) {
      throw new HcSubagentError("validation", `provider ${id} is already registered`);
    }
    this.#providers.push(provider);
    return () => {
      const index = this.#providers.indexOf(provider);
      if (index >= 0) this.#providers.splice(index, 1);
    };
  }

  list(): readonly SubagentProvider[] {
    return [...this.#providers];
  }

  /**
   * Select a provider without letting a broken `canHandle` disable the whole
   * service. Returns `provider: null` when nothing claims the request.
   */
  select(request: SpawnRequest): { provider: SubagentProvider | null; failures: AdapterFailure[] } {
    const failures: AdapterFailure[] = [];
    for (const provider of this.#providers) {
      let handles = false;
      try {
        handles = provider.canHandle(request) === true;
      } catch (error) {
        failures.push({ adapter: provider.id, error: toHcSubagentError(error, "provider_failed") });
        continue;
      }
      if (handles) return { provider, failures };
    }
    return { provider: null, failures };
  }
}

/**
 * Ordered result-adapter registry. Custom adapters run before the built-in
 * fallback so packages can override result extraction for their backend.
 */
export class ResultAdapterRegistry {
  readonly #adapters: ResultAdapter[] = [];
  readonly #fallback: ResultAdapter | undefined;

  constructor(fallback?: ResultAdapter, initial: readonly ResultAdapter[] = []) {
    this.#fallback = fallback;
    for (const adapter of initial) this.register(adapter);
  }

  register(adapter: ResultAdapter): () => void {
    const id = assertAdapterId(adapter?.id, "result adapter");
    if (this.#adapters.some((existing) => existing.id === id)) {
      throw new HcSubagentError("validation", `result adapter ${id} is already registered`);
    }
    this.#adapters.push(adapter);
    return () => {
      const index = this.#adapters.indexOf(adapter);
      if (index >= 0) this.#adapters.splice(index, 1);
    };
  }

  list(): readonly ResultAdapter[] {
    return this.#fallback ? [...this.#adapters, this.#fallback] : [...this.#adapters];
  }

  select(input: ResultAdapterInput): { adapter: ResultAdapter | null; failures: AdapterFailure[] } {
    const failures: AdapterFailure[] = [];
    for (const adapter of this.list()) {
      let handles = false;
      try {
        handles = adapter.canHandle(input) === true;
      } catch (error) {
        failures.push({ adapter: adapter.id, error: toHcSubagentError(error, "adapter_failed") });
        continue;
      }
      if (handles) return { adapter, failures };
    }
    return { adapter: null, failures };
  }

  /** Read with failure containment; never throws for adapter code. */
  async read(input: ResultAdapterInput): Promise<AdapterReadOutcome> {
    const selected = this.select(input);
    if (!selected.adapter) return { unmatched: true };
    try {
      const result = await selected.adapter.read(input);
      return { result, adapter: selected.adapter.id };
    } catch (error) {
      return {
        adapter: selected.adapter.id,
        failure: { adapter: selected.adapter.id, error: toHcSubagentError(error, "adapter_failed") },
      };
    }
  }
}

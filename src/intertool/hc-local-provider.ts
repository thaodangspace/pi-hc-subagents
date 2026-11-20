/**
 * Built-in provider: one interactive pi child in a local herdr-core terminal.
 *
 * All validation flows through the `ProviderHost`, then `startBackgroundRun`
 * starts the child with an already-resolved agent, cwd, and scheduler slot.
 * This keeps the default backend on the same trust/concurrency path as before.
 */
import { cancelRecord, type SubagentResult, waitForRecord } from "../runtime/run-ops.ts";
import { startBackgroundRun } from "../runtime/run-background.ts";
import type { SubagentRecord } from "../runtime/types.ts";
import type { ToolSession } from "../tools/session.ts";
import type {
  ProviderCancelOptions,
  ProviderChild,
  ProviderHost,
  ProviderWaitOptions,
  SpawnRequest,
  SubagentProvider,
} from "./adapters.ts";

export const HC_LOCAL_PROVIDER_ID = "hc-local";

export class HcLocalProviderChild implements ProviderChild {
  readonly #session: ToolSession;
  readonly childId: string;
  readonly runId: string;
  readonly terminal: string;
  readonly sessionFile?: string;
  readonly runDir?: string;
  readonly resultFile?: string;
  readonly #initial: SubagentRecord;

  constructor(session: ToolSession, record: SubagentRecord) {
    this.#session = session;
    this.#initial = record;
    this.childId = record.childId;
    this.runId = record.runId;
    this.terminal = record.terminal;
    this.sessionFile = record.sessionFile ?? undefined;
    this.runDir = record.runDir;
    this.resultFile = record.resultFile;
  }

  get record(): SubagentRecord {
    return this.#session.registry.get(this.childId) ?? this.#initial;
  }

  get cwd(): string {
    return this.record.cwd;
  }

  async wait(options: ProviderWaitOptions = {}): Promise<SubagentResult> {
    return waitForRecord(this.#session, this.record, options);
  }

  async cancel(options: ProviderCancelOptions = {}): Promise<void> {
    await cancelRecord(this.#session, this.record, {
      ...(options.force === undefined ? {} : { force: options.force }),
    });
  }

  async readOutput(lines = 60): Promise<string> {
    const read = await this.#session.runtime.core.read(this.terminal, lines);
    return read.text;
  }
}

export class HcLocalProvider implements SubagentProvider {
  readonly id = HC_LOCAL_PROVIDER_ID;
  readonly description = "Interactive pi child in a local herdr-core terminal";
  readonly #session: ToolSession;

  constructor(session: ToolSession) {
    this.#session = session;
  }

  canHandle(request: SpawnRequest): boolean {
    return request.backend === undefined || request.backend === this.id;
  }

  async spawn(request: SpawnRequest, host: ProviderHost): Promise<ProviderChild> {
    const agent = await host.resolveAgent(request.agent, request.agentScope);
    await host.assertProjectTrust(agent);
    const cwd = host.resolveCwd(request.cwd ?? agent.cwd);
    const release = await host.acquireConcurrencySlot({
      write: agent.access === "write",
      cwd,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    });

    try {
      const started = await startBackgroundRun(this.#session, {
        agentName: agent.name,
        task: request.task,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
        ...(request.agentScope === undefined ? {} : { agentScope: request.agentScope }),
        origin: request.origin ?? "intertool",
        trusted: this.#session.runtime.trusted,
        parentCwd: this.#session.runtime.cwd,
        allowProjectAgents: request.allowTrustedProjectAgents === true,
        provider: this.id,
        prepared: { agent, cwd, release },
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      return new HcLocalProviderChild(this.#session, started.record);
    } catch (error) {
      release();
      throw error;
    }
  }
}

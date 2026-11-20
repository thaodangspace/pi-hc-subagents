/**
 * Test-only "external" helper extension.
 *
 * It uses only the global service symbol and `pi.events` — no internal imports
 * — to prove the public intertool surface is usable by another extension.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface HelperOutcome {
  kind: "result" | "event";
  childId?: string;
  listCount?: number;
  state?: string;
  text?: string;
  eventType?: string;
}

export const helperOutcomes: HelperOutcome[] = [];

interface ServiceLike {
  spawn(request: Record<string, unknown>): Promise<{ childId: string }>;
  list(): Promise<unknown[]>;
  wait(id: string, options?: { timeoutMs?: number }): Promise<{ state: string; text?: string }>;
  subscribe(listener: (event: { type: string }) => void): () => void;
}

async function useService(service: ServiceLike): Promise<void> {
  const unsubscribe = service.subscribe((event) => helperOutcomes.push({ kind: "event", eventType: event.type }));
  try {
    const view = await service.spawn({
      agent: "reviewer",
      task: "Helper extension spawn.",
      origin: "helper",
      clientRequestId: "helper-1",
    });
    const list = await service.list();
    const result = await service.wait(view.childId, { timeoutMs: 20_000 });
    helperOutcomes.push({
      kind: "result",
      childId: view.childId,
      listCount: list.length,
      state: result.state,
      ...(result.text === undefined ? {} : { text: result.text }),
    });
  } finally {
    unsubscribe();
  }
}

export default function helperExtension(pi: ExtensionAPI): void {
  const symbol = Symbol.for("pi-hc-subagents.service.v1");
  const existing = (globalThis as Record<symbol, unknown>)[symbol] as ServiceLike | undefined;
  if (existing) {
    void useService(existing);
    return;
  }
  pi.events.on("hc-subagents:ready", (payload) => {
    const service = (payload as { service?: ServiceLike } | undefined)?.service;
    if (service) void useService(service);
  });
}

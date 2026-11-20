/**
 * In-memory run registry.
 *
 * Identity is per parent session: `list` only ever returns children started by
 * the current parent. Lookups accept a child ID, terminal address, terminal
 * name, slug, or a unique suffix.
 */
import { coreStatusOf, type SubagentRecord } from "./types.ts";
import type { TerminalRecord } from "../core/hc-types.ts";

export type IdResolution =
  | { kind: "found"; record: SubagentRecord }
  | { kind: "none" }
  | { kind: "ambiguous"; candidates: SubagentRecord[] };

export class Registry {
  #byChildId = new Map<string, SubagentRecord>();

  create(record: SubagentRecord): SubagentRecord {
    this.#byChildId.set(record.childId, record);
    return record;
  }

  get(childId: string): SubagentRecord | undefined {
    return this.#byChildId.get(childId);
  }

  all(): SubagentRecord[] {
    return [...this.#byChildId.values()];
  }

  listForParent(parentSessionId: string, options: { includeFinished?: boolean } = {}): SubagentRecord[] {
    const includeFinished = options.includeFinished ?? true;
    return this.all()
      .filter((record) => record.parentSessionId === parentSessionId)
      .filter((record) => includeFinished || (record.state !== "completed" && record.state !== "failed" && record.state !== "cancelled"))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  update(childId: string, patch: Partial<SubagentRecord>): SubagentRecord {
    const existing = this.#byChildId.get(childId);
    if (!existing) throw new Error(`unknown child ${childId}`);
    const updated = { ...existing, ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
    this.#byChildId.set(childId, updated);
    return updated;
  }

  /** Apply a terminal snapshot without changing run-local state. */
  applyTerminal(childId: string, terminal: TerminalRecord): SubagentRecord {
    return this.update(childId, {
      terminal: terminal.address,
      terminalName: terminal.name ?? this.get(childId)?.terminalName ?? terminal.address,
      terminalState: terminal.state,
      coreStatus: coreStatusOf(terminal),
      turn: terminal.turn,
      exitCode: terminal.exitCode,
      signal: terminal.signal,
      labels: { ...terminal.labels },
    });
  }

  remove(childId: string): void {
    this.#byChildId.delete(childId);
  }

  resolve(id: string): IdResolution {
    const needle = id.trim();
    if (needle.length === 0) return { kind: "none" };
    const exact = this.all();
    const exactMatch =
      exact.find((record) => record.childId === needle) ??
      exact.find((record) => record.terminal === needle) ??
      exact.find((record) => record.terminalName === needle) ??
      exact.find((record) => record.slug === needle);
    if (exactMatch) return { kind: "found", record: exactMatch };

    const lower = needle.toLowerCase();
    const suffixMatches = exact.filter((record) =>
      [record.childId, record.terminal, record.terminalName, record.slug].some((candidate) =>
        candidate.toLowerCase().endsWith(lower),
      ),
    );
    if (suffixMatches.length === 1) return { kind: "found", record: suffixMatches[0] as SubagentRecord };
    if (suffixMatches.length > 1) return { kind: "ambiguous", candidates: suffixMatches };
    return { kind: "none" };
  }

  /** Case-insensitive match used by commands; returns all candidates. */
  search(fragment: string): SubagentRecord[] {
    const lower = fragment.trim().toLowerCase();
    if (!lower) return [];
    return this.all().filter((record) =>
      [record.childId, record.terminal, record.terminalName, record.slug, record.agent].some((candidate) =>
        candidate.toLowerCase().includes(lower),
      ),
    );
  }
}

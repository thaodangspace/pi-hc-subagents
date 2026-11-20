/**
 * Child identifier resolution for control actions.
 */
import type { Registry } from "./registry.ts";
import type { SubagentRecord } from "./types.ts";

export type IdResolutionResult =
  | { kind: "found"; record: SubagentRecord }
  | { kind: "not_found"; message: string }
  | { kind: "ambiguous"; message: string; candidates: SubagentRecord[] };

export function resolveChildId(registry: Registry, id: string): IdResolutionResult {
  const resolution = registry.resolve(id);
  if (resolution.kind === "found") return resolution;
  if (resolution.kind === "ambiguous") {
    const candidates = resolution.candidates;
    return {
      kind: "ambiguous",
      candidates,
      message: `ambiguous id "${id}"; candidates: ${candidates
        .map((record) => `${record.slug} (${record.terminal})`)
        .join(", ")}`,
    };
  }
  return { kind: "not_found", message: `no subagent matches "${id}"` };
}

export function formatCandidates(records: SubagentRecord[]): string {
  return records.map((record) => `${record.slug} (${record.terminal}, ${record.state})`).join("\n");
}

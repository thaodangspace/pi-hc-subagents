/**
 * Result adapter for pi children.
 *
 * A published `result.json` is preferred because it is the stable, bounded
 * artifact. Otherwise the child session JSONL is parsed exactly like the local
 * wait/monitor paths; the PTY screen is never scraped for a final answer.
 */
import { existsSync } from "node:fs";

import { parseSessionWithRetry } from "../child/session-read.ts";
import { HcSubagentError } from "../core/error.ts";
import type { SubagentResult } from "../runtime/run-ops.ts";
import { readResultFile } from "../runtime/result-store.ts";
import type { SubagentState, TurnOutcome } from "../runtime/types.ts";
import type { ResultAdapter, ResultAdapterInput } from "../intertool/adapters.ts";

export const PI_SESSION_RESULT_ADAPTER_ID = "pi-session";

export class PiSessionResultAdapter implements ResultAdapter {
  readonly id = PI_SESSION_RESULT_ADAPTER_ID;

  canHandle(input: ResultAdapterInput): boolean {
    if (input.sessionFile && input.sessionFile.endsWith(".jsonl")) {
      return existsSync(input.sessionFile);
    }
    return typeof input.resultFile === "string" && existsSync(input.resultFile);
  }

  async read(input: ResultAdapterInput): Promise<SubagentResult> {
    const childId = input.childId ?? "";
    const runId = input.runId ?? "";
    const terminal = input.terminal ?? "";

    if (input.resultFile) {
      const stored = await readResultFile(input.resultFile);
      if (stored) {
        return {
          childId: stored.childId,
          runId,
          state: stored.state,
          outcome: stored.outcome,
          ...(stored.text.length > 0 ? { text: stored.text } : {}),
          ...(stored.error ? { error: stored.error } : {}),
          usage: stored.usage,
          terminal: stored.terminal || terminal,
          ...(stored.sessionFile ? { sessionFile: stored.sessionFile } : {}),
          resultFile: input.resultFile,
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        };
      }
    }

    const sessionFile = input.sessionFile;
    if (!sessionFile) {
      throw new HcSubagentError("not_found", "the pi result adapter has no session file or result file");
    }

    const parsed = await parseSessionWithRetry(
      sessionFile,
      {
        turnStartedAtMs: input.turnStartedAtMs ?? 0,
        final: input.final ?? true,
      },
      { attempts: 3, delayMs: 50 },
    );
    const state: SubagentState =
      parsed.state === "completed"
        ? "completed"
        : parsed.state === "cancelled"
          ? "cancelled"
          : parsed.state === "pending"
            ? "failed"
            : "failed";
    const outcome: TurnOutcome =
      parsed.outcome === "pending" ? "incomplete" : parsed.outcome;
    return {
      childId,
      runId,
      state,
      outcome,
      ...(parsed.text.length > 0 ? { text: parsed.text } : {}),
      ...(parsed.error ? { error: parsed.error } : {}),
      ...(parsed.usage ? { usage: parsed.usage } : {}),
      terminal,
      sessionFile,
      ...(input.resultFile ? { resultFile: input.resultFile } : {}),
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    };
  }
}

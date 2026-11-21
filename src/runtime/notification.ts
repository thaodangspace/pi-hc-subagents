/**
 * Notification payload builders.
 *
 * Content is bounded and never includes the full transcript. Details keep the
 * same shape as tool results so `/hc-subagents` and renderers can reuse it.
 */
import type { FinalizeResult } from "./finalize.ts";
import { recordDetails } from "./finalize.ts";
import type { NotificationItem } from "./notifier.ts";
import { blockedEpisodeKey, resultDeliveryKey } from "./notifier.ts";
import {
  ASYNC_CONTENT_MAX_BYTES,
  formatAsyncResultContent,
  formatBlockedContent,
  truncateForModel,
} from "./result-format.ts";
import type { SubagentRecord } from "./types.ts";

export function resultNotification(record: SubagentRecord, finalized: FinalizeResult): NotificationItem {
  const details = finalized.result.details;
  const content = formatAsyncResultContent({
    agent: record.agent,
    childId: record.childId,
    state: finalized.state === "completed" ? "completed" : finalized.state,
    outcome: finalized.outcome,
    durationMs: details.durationMs,
    turns: record.turns.length,
    usage: details.usage,
    terminal: record.terminal,
    terminalName: record.terminalName,
    sessionFile: details.sessionFile,
    resultFile: details.resultFile,
    text: record.turns.at(-1)?.text ?? "",
    textTruncated: details.textTruncated ?? false,
    error: details.error,
    // A live child with a pipe can be resumed, so it may settle and notify again.
    resumable: record.terminalState === "live" && Boolean(record.pipeName),
  });
  return {
    type: "result",
    childId: record.childId,
    turn: record.turn,
    agent: record.agent,
    state: finalized.state === "completed" ? "completed" : finalized.state,
    outcome: finalized.outcome,
    terminal: record.terminal,
    content,
    details,
    deliveryKey: resultDeliveryKey(finalized.record),
  };
}

export function blockedNotification(
  record: SubagentRecord,
  episode: number,
  kind: string | null,
  message: string,
  screenTail: string,
): NotificationItem {
  const details = recordDetails(record, {
    state: "blocked",
    outcome: "blocked",
    blocked: {
      ...(kind ? { kind } : {}),
      ...(message ? { message } : {}),
      ...(screenTail ? { screenTail } : {}),
    },
  });
  const bounded = truncateForModel(
    formatBlockedContent({
      agent: record.agent,
      terminal: record.terminal,
      terminalName: record.terminalName,
      kind,
      message,
      screenTail,
      durationMs: details.durationMs,
    }),
    { maxBytes: ASYNC_CONTENT_MAX_BYTES, maxLines: 200 },
  );
  return {
    type: "blocked",
    childId: record.childId,
    turn: record.turn,
    agent: record.agent,
    state: "blocked",
    outcome: "blocked",
    terminal: record.terminal,
    content: bounded.text,
    details,
    deliveryKey: blockedEpisodeKey(record, episode),
  };
}

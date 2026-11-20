/**
 * Monitor hooks: notifications, intertool events, persistence, and UI refresh.
 */
import type { MonitorHooks } from "./async-monitor.ts";
import type { FinalizeResult } from "./finalize.ts";
import { blockedNotification, resultNotification } from "./notification.ts";
import type { ToolSession } from "../tools/session.ts";

export function defaultMonitorHooks(session: ToolSession): MonitorHooks {
  return {
    onStateChange(record, previousState) {
      try {
        session.service?.emitStatus(record, previousState);
      } catch {
        // Events never break a monitor.
      }
      session.onRecordChange?.(record);
    },
    onBlocked(record, episode, kind, message, screenTail) {
      try {
        session.service?.emitBlocked(record, kind, message, episode);
      } catch {
        // Events never break a monitor.
      }
      if (session.runtime.config.notify !== "none") {
        try {
          session.notifier?.enqueue(blockedNotification(record, episode, kind, message, screenTail));
        } catch {
          // Notification failures are retried by the queue.
        }
      }
      session.persistence?.append(record);
      session.onRecordChange?.(record);
    },
    onSettled(finalized: FinalizeResult) {
      try {
        session.service?.emitSettled(finalized);
      } catch {
        // Events never break a monitor.
      }
      if (session.runtime.config.notify !== "none") {
        try {
          session.notifier?.enqueue(resultNotification(finalized.record, finalized));
        } catch {
          // Notification failures are retried by the queue.
        }
      }
      session.persistence?.append(finalized.record);
      session.onRecordChange?.(finalized.record);
    },
  };
}

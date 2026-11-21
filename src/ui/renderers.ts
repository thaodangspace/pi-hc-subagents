/**
 * Message renderers for async child notifications.
 *
 * Compact card by default; expanded shows the bounded notification content and
 * the result path. Task text is never rendered.
 */
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ASYNC_MESSAGE_TYPE } from "../runtime/notifier.ts";

interface HcMessageDetails {
  agent?: string;
  state?: string;
  outcome?: string | null;
  /** Outcome word from the result details; preferred over the raw `outcome`. */
  status?: string;
  terminal?: string;
  sessionFile?: string | null;
  resultFile?: string | null;
  summary?: boolean;
  children?: string[];
}

function bodyText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text: unknown }).text) : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function preview(text: string, limit = 600): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…\n${text.slice(-200)}`;
}

/** Compact card titles stay on one line and never split a word. */
export const TITLE_MAX_CHARS = 72;

function boundedTitle(title: string, limit = TITLE_MAX_CHARS): string {
  const flat = title.replace(/\s+/g, " ").trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit - 1);
  const lastSpace = cut.lastIndexOf(" ");
  const head = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${head.trimEnd()}…`;
}

/**
 * Outcome word for a card title.
 *
 * `details.status` is the outcome word the model reads in the notification
 * content; `details.outcome` is the raw pi turn outcome (`stop`, `length`, …)
 * and is only a fallback for older detail objects. The renderer never parses
 * the content string for this.
 */
function statusWord(details: { status?: unknown; outcome?: unknown }): string {
  if (typeof details.status === "string" && details.status.length > 0) return details.status;
  if (typeof details.outcome === "string" && details.outcome.length > 0) return details.outcome;
  return "";
}

export interface ToolResultLike {
  content?: Array<{ type: string; text?: string }>;
  details?: {
    agent?: string;
    state?: string;
    outcome?: string | null;
    status?: string;
    terminal?: string;
    durationMs?: number;
    usage?: { totalTokens?: number };
    background?: boolean;
    error?: string;
  };
  isError?: boolean;
}

/** Compact tool result card; expanded shows the bounded model-facing content. */
export function renderSubagentToolResult(
  result: ToolResultLike,
  options: { expanded: boolean },
  theme: { fg(color: string, text: string): string },
) {
  const details = result.details ?? {};
  const icon = result.isError ? "✗" : details.state === "blocked" ? "?" : details.state === "completed" ? "✓" : "●";
  const color = result.isError ? "error" : details.state === "blocked" ? "warning" : "success";
  const duration =
    typeof details.durationMs === "number" && Number.isFinite(details.durationMs)
      ? ` · ${Math.max(0, Math.round(details.durationMs / 1000))}s`
      : "";
  const outcome = statusWord(details);
  const outcomeTag = outcome && outcome !== details.state ? ` (${outcome})` : "";
  const title = `${icon} ${details.agent ?? "subagent"} ${details.state ?? ""}${outcomeTag}${duration}`;
  const lines = [theme.fg(color, boundedTitle(title))];
  if (details.terminal) lines.push(theme.fg("dim", `${details.terminal}${details.background ? " · background" : ""}`));
  if (options.expanded) {
    const body = (result.content ?? []).map((part) => part.text ?? "").join("\n").trim();
    if (body.length > 0) lines.push(body);
  }
  if (details.error) lines.push(theme.fg("error", details.error));

  const box = new Box(0, 0, (text) => text);
  box.addChild(new Text(lines.join("\n"), 0, 0));
  return box;
}

export function registerHcSubagentsRenderers(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(ASYNC_MESSAGE_TYPE, (message, options, theme) => {
    const details = (message.details ?? {}) as HcMessageDetails;
    const outcome = statusWord(details);
    const title = details.summary
      ? "[hc-subagents] more results are ready"
      : `[hc-subagents] ${details.agent ?? "child"} ${details.state ?? ""}${
          outcome && outcome !== details.state ? ` (${outcome})` : ""
        }`.trim();
    const body = bodyText(message.content);
    const lines = [theme.fg(details.state === "blocked" ? "warning" : "accent", boundedTitle(title))];
    lines.push(options.expanded ? body : preview(body));
    if (details.terminal) lines.push(theme.fg("dim", `terminal: ${details.terminal}`));
    if (options.expanded && details.resultFile) lines.push(theme.fg("dim", `result: ${details.resultFile}`));
    if (options.expanded && details.sessionFile) lines.push(theme.fg("dim", `session: ${details.sessionFile}`));

    const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });
}

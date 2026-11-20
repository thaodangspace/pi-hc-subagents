/**
 * Agent frontmatter parsing.
 *
 * pi's `parseFrontmatter` uses a real YAML parser. A malformed file yields
 * `ok: false` instead of taking down discovery of every other agent.
 */
import { parseFrontmatter as parsePiFrontmatter } from "@earendil-works/pi-coding-agent";

export interface ParsedAgentFile {
  ok: boolean;
  frontmatter: Record<string, unknown>;
  body: string;
  error?: string;
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseAgentFile(content: string): ParsedAgentFile {
  try {
    const parsed = parsePiFrontmatter<Record<string, unknown>>(normalizeNewlines(content));
    return {
      ok: true,
      frontmatter: parsed.frontmatter ?? {},
      body: parsed.body,
    };
  } catch (error) {
    return {
      ok: false,
      frontmatter: {},
      body: normalizeNewlines(content),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

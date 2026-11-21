/**
 * Counting summarizer fake shared by the runner and finalize tests.
 *
 * Not a `.test.ts` file on purpose: importing it must not re-register another
 * file's cases. It never touches the network; behaviour is fixed at
 * construction time.
 */
import type {
  ResultSummarizer,
  SummarizerRequest,
  SummarizerResponse,
  SummarizerUsage,
} from "../../../src/runtime/summarizer.ts";

export interface FakeSummarizerBehaviour {
  /** Fixed text, or a function of the request (e.g. echo it back verbatim). */
  text?: string | ((request: SummarizerRequest) => string);
  usage?: Partial<Omit<SummarizerUsage, "durationMs">>;
  /** Reject with this value instead of resolving. */
  fail?: unknown;
  /** Return a promise that never settles. */
  hang?: boolean;
}

export interface FakeSummarizer {
  summarizer: ResultSummarizer;
  calls: SummarizerRequest[];
  callCount(): number;
  lastRequest(): SummarizerRequest | undefined;
}

export function fakeSummarizer(behaviour: FakeSummarizerBehaviour = {}): FakeSummarizer {
  const calls: SummarizerRequest[] = [];
  const summarizer: ResultSummarizer = (request) => {
    calls.push(request);
    if (behaviour.hang === true) return new Promise<SummarizerResponse>(() => {});
    if ("fail" in behaviour) return Promise.reject(behaviour.fail);
    const text =
      typeof behaviour.text === "function" ? behaviour.text(request) : (behaviour.text ?? "SUMMARY");
    return Promise.resolve({
      text,
      usage: {
        inputTokens: 1200,
        outputTokens: 180,
        costUsd: 0.0004,
        model: "test/model",
        ...behaviour.usage,
      },
    });
  };
  return {
    summarizer,
    calls,
    callCount: () => calls.length,
    lastRequest: () => calls.at(-1),
  };
}

import { TimeoutError } from "./errors.ts";

export const BASE_DELAY_MS = 250;
export const MAX_ATTEMPTS = 5;

export interface RetryOptions {
  attempts?: number;
  onAttempt?: (attempt: number) => void;
}

/**
 * Retry `operation` with exponential backoff.
 *
 * When the last attempt fails the error from that attempt is rethrown, so
 * callers see the real failure and not a wrapper. A non-Error rejection is
 * wrapped in a TimeoutError because there is nothing else to rethrow.
 */
export async function retry<T>(operation: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? MAX_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    options.onAttempt?.(attempt);
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }

  if (lastError instanceof Error) throw lastError;
  throw new TimeoutError(`retry exhausted after ${attempts} attempts`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

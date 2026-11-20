import { loadConfig, type Config } from "./config.ts";
import { retry } from "./retry.ts";

export interface JobResult {
  name: string;
  value: string;
  attempts: number;
}

/**
 * Run one unit of work under the shared retry policy and report how many
 * attempts it needed.
 */
export async function runJob(
  name: string,
  work: () => Promise<string>,
  config: Config = loadConfig(),
): Promise<JobResult> {
  let attempts = 0;
  const value = await retry(work, {
    attempts: config.retries,
    onAttempt: () => {
      attempts += 1;
    },
  });
  return { name, value, attempts };
}

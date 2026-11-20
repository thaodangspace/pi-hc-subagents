import { loadConfig, validateConfig, type Config } from "./config.ts";
import { TransportError } from "./errors.ts";
import { retry } from "./retry.ts";

export interface Response {
  status: number;
  body: string;
}

/**
 * Fetch `url` and retry transport failures.
 *
 * validateConfig runs before the first attempt so a bad port or timeout never
 * turns into a confusing fetch error.
 */
export async function request(
  url: string,
  config: Config = loadConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  validateConfig(config);

  return retry(
    async () => {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(config.timeoutMs) });
      if (!response.ok) {
        throw new TransportError(`${url} responded with ${response.status}`);
      }
      return { status: response.status, body: await response.text() };
    },
    { attempts: config.retries },
  );
}

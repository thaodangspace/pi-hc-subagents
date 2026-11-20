import { TransportError } from "../errors.ts";

/**
 * Deprecated hand-rolled retry loop, kept until the 2.0 release.
 * TODO: delete this module and use src/retry.ts everywhere.
 */
export const BASE_DELAY_MS = 250;

export async function retryLegacy<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await operation();
    } catch (error) {
      if (index === attempts - 1) {
        throw new TransportError(`legacy retry gave up after ${attempts} attempts: ${String(error)}`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, BASE_DELAY_MS * (index + 1));
      });
    }
  }
  throw new TransportError("legacy retry reached an unreachable state");
}

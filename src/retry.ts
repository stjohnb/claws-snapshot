import * as log from "./log.js";
import { formatMs } from "./format.js";
import { sleep } from "./util.js";

/**
 * Retries `fn` up to `maxRetries` times on errors where `isTransient(err)` returns true,
 * using exponential backoff (1s, 2s, 4s, …). Non-transient errors and errors after all
 * retries are rethrown immediately.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  isTransient: (err: Error) => boolean,
  label: string,
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries && isTransient(error)) {
        attempt++;
        const delay = 1000 * 2 ** (attempt - 1); // 1s, 2s, 4s, …
        log.warn(`${label} transient error (attempt ${attempt}/${maxRetries}), retrying in ${formatMs(delay)}`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

import os from "node:os";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Expand a leading `~/` in a path to the user's home directory. */
export function resolveIdentityFile(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return os.homedir() + filePath.slice(1);
  }
  return filePath;
}

/**
 * Map over items with a bounded number of concurrent in-flight calls,
 * preserving input order in the returned array. Rejects on the first
 * failing call (Promise.all semantics).
 *
 * Implemented as a worker pool over a shared cursor, not fixed batches: a
 * worker that finishes picks up the next unclaimed index immediately, so a
 * single slow item never idles the other slots behind a barrier (#2531).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  // Clamp: 0/negative/NaN would otherwise mean "no workers" (or, in the old
  // batch loop, an infinite loop). One worker is the safe floor.
  const width = Math.min(Math.max(1, Math.floor(concurrency) || 1), items.length);
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/**
 * Like mapWithConcurrency but never rejects: each item's outcome is
 * returned as a PromiseSettledResult, preserving input order.
 */
export function mapSettledWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return mapWithConcurrency(items, concurrency, (item) =>
    Promise.resolve(fn(item)).then(
      (value): PromiseSettledResult<R> => ({ status: "fulfilled", value }),
      (reason): PromiseSettledResult<R> => ({ status: "rejected", reason }),
    ),
  );
}

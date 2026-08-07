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
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.all(batch.map((item) => fn(item)));
    for (let j = 0; j < settled.length; j++) {
      results[i + j] = settled[j];
    }
  }
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

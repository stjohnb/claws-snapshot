// ── Generic TTL cache with deduplication ──
//
// Lives in its own module (rather than inside github.ts, where it originated)
// so `forgejo.ts` can keep its own cache without value-importing github.ts —
// github.ts value-imports forgejo.ts to route Forgejo repos, and a module-level
// `new TTLCache()` on both sides of that cycle would race module initialisation.

import * as log from "./log.js";

/**
 * How long past its TTL a forge list may be served to a dashboard page that
 * passes `staleOk` — the page renders from it while one background refresh
 * runs. Jobs and `/api` paths never pass `staleOk`.
 */
export const STALE_OK_MS = 10 * 60_000;

/** Map a forge read's `staleOk` flag onto {@link TTLCache.dedupedFetch}'s options. */
export function staleOpts(staleOk: boolean | undefined): DedupedFetchOptions | undefined {
  return staleOk ? { staleMs: STALE_OK_MS } : undefined;
}

export interface DedupedFetchOptions {
  /**
   * Serve an entry up to this long past its TTL, starting one deduped
   * background refresh, instead of awaiting the fetcher. A failed refresh
   * keeps the stale value. Omit for a strict read.
   */
  staleMs?: number;
}

export class TTLCache<T> {
  private cache = new Map<string, { value: T; fetchedAt: number; expiresAt: number }>();
  private inFlight = new Map<string, Promise<T>>();
  /** Longest `staleMs` any caller has asked for: expired entries are kept this long. */
  private maxStaleMs = 0;

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.value;
    if (entry && Date.now() >= entry.expiresAt + this.maxStaleMs) this.cache.delete(key);
    return undefined;
  }

  set(key: string, value: T, ttlMs: number): void {
    const now = Date.now();
    this.cache.set(key, { value, fetchedAt: now, expiresAt: now + ttlMs });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  async dedupedFetch(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
    opts?: DedupedFetchOptions,
  ): Promise<T> {
    const staleMs = opts?.staleMs ?? 0;
    if (staleMs > this.maxStaleMs) this.maxStaleMs = staleMs;

    const cached = this.get(key);
    if (cached !== undefined) return cached;

    if (staleMs > 0) {
      const entry = this.cache.get(key);
      if (entry && Date.now() < entry.expiresAt + staleMs) {
        if (!this.inFlight.has(key)) {
          this.startFetch(key, ttlMs, fetcher).catch((err: unknown) => {
            log.warn(`[ttl-cache] background refresh of ${key} failed; keeping the stale value: ${err instanceof Error ? err.message : String(err)}`);
          });
        }
        return entry.value;
      }
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    return this.startFetch(key, ttlMs, fetcher);
  }

  private startFetch(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const promise = fetcher().then((result) => {
      this.set(key, result, ttlMs);
      this.inFlight.delete(key);
      return result;
    }).catch((err) => {
      this.inFlight.delete(key);
      throw err;
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}

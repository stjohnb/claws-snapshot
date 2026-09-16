// ── Generic TTL cache with deduplication ──
//
// Lives in its own module (rather than inside github.ts, where it originated)
// so `forgejo.ts` can keep its own cache without value-importing github.ts —
// github.ts value-imports forgejo.ts to route Forgejo repos, and a module-level
// `new TTLCache()` on both sides of that cycle would race module initialisation.

export class TTLCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();
  private inFlight = new Map<string, Promise<T>>();

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.value;
    if (entry) this.cache.delete(key);
    return undefined;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  async dedupedFetch(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const existing = this.inFlight.get(key);
    if (existing) return existing;

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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./log.js", () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { TTLCache, STALE_OK_MS, staleOpts } from "./ttl-cache.js";
import * as log from "./log.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("TTLCache.dedupedFetch", () => {
  it("serves a fresh entry without calling the fetcher again", async () => {
    const cache = new TTLCache<string>();
    const fetcher = vi.fn(async () => "v1");
    expect(await cache.dedupedFetch("k", 1000, fetcher)).toBe("v1");
    vi.advanceTimersByTime(500);
    expect(await cache.dedupedFetch("k", 1000, fetcher, { staleMs: 5000 })).toBe("v1");
    expect(await cache.dedupedFetch("k", 1000, fetcher)).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("returns a stale entry at once and starts exactly one background refresh", async () => {
    const cache = new TTLCache<string>();
    await cache.dedupedFetch("k", 1000, async () => "v1");
    vi.advanceTimersByTime(2000);

    const refresh = deferred<string>();
    const fetcher = vi.fn(() => refresh.promise);
    expect(await cache.dedupedFetch("k", 1000, fetcher, { staleMs: 5000 })).toBe("v1");
    expect(await cache.dedupedFetch("k", 1000, fetcher, { staleMs: 5000 })).toBe("v1");
    expect(fetcher).toHaveBeenCalledTimes(1);

    refresh.resolve("v2");
    await flush();
    expect(await cache.dedupedFetch("k", 1000, fetcher, { staleMs: 5000 })).toBe("v2");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the stale value and logs the key when the background refresh fails", async () => {
    const cache = new TTLCache<string>();
    await cache.dedupedFetch("pr-list:org/repo", 1000, async () => "v1");
    vi.advanceTimersByTime(2000);

    const fetcher = vi.fn(async () => { throw new Error("forge down"); });
    expect(await cache.dedupedFetch("pr-list:org/repo", 1000, fetcher, { staleMs: 5000 })).toBe("v1");
    await flush();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("pr-list:org/repo"));
  });

  it("serves the stale value again after a failed refresh, retrying once more", async () => {
    const cache = new TTLCache<string>();
    await cache.dedupedFetch("k", 1000, async () => "v1");
    vi.advanceTimersByTime(2000);
    const failing = vi.fn(async () => { throw new Error("boom"); });
    expect(await cache.dedupedFetch("k", 1000, failing, { staleMs: 5000 })).toBe("v1");
    await flush();
    expect(await cache.dedupedFetch("k", 1000, failing, { staleMs: 5000 })).toBe("v1");
    await flush();
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("awaits a fresh fetch once an entry is past ttl + staleMs", async () => {
    const cache = new TTLCache<string>();
    await cache.dedupedFetch("k", 1000, async () => "v1");
    vi.advanceTimersByTime(7000);
    expect(await cache.dedupedFetch("k", 1000, async () => "v2", { staleMs: 5000 })).toBe("v2");
  });

  it("never gives a strict caller a stale value", async () => {
    const cache = new TTLCache<string>();
    await cache.dedupedFetch("k", 1000, async () => "v1");
    vi.advanceTimersByTime(2000);
    expect(cache.get("k")).toBeUndefined();
    expect(await cache.dedupedFetch("k", 1000, async () => "v2")).toBe("v2");
  });

  it("makes a strict caller await a background refresh already in flight", async () => {
    const cache = new TTLCache<string>();
    await cache.dedupedFetch("k", 1000, async () => "v1");
    vi.advanceTimersByTime(2000);

    const refresh = deferred<string>();
    const fetcher = vi.fn(() => refresh.promise);
    expect(await cache.dedupedFetch("k", 1000, fetcher, { staleMs: 5000 })).toBe("v1");

    const strictFetcher = vi.fn(async () => "other");
    const strict = cache.dedupedFetch("k", 1000, strictFetcher);
    refresh.resolve("v2");
    expect(await strict).toBe("v2");
    expect(strictFetcher).not.toHaveBeenCalled();
  });

  it("keeps an expired entry for stale-ok callers after a strict get misses it", async () => {
    const cache = new TTLCache<string>();
    await cache.dedupedFetch("k", 1000, async () => "v1", { staleMs: 5000 });
    vi.advanceTimersByTime(2000);
    // A strict get of the expired entry must not evict what a stale-ok caller can still use.
    expect(cache.get("k")).toBeUndefined();
    const refresh = deferred<string>();
    expect(await cache.dedupedFetch("k", 1000, () => refresh.promise, { staleMs: 5000 })).toBe("v1");
    refresh.resolve("v2");
  });
});

describe("staleOpts", () => {
  it("maps staleOk onto the shared ten-minute stale allowance", () => {
    expect(STALE_OK_MS).toBe(10 * 60_000);
    expect(staleOpts(true)).toEqual({ staleMs: STALE_OK_MS });
    expect(staleOpts(false)).toBeUndefined();
    expect(staleOpts(undefined)).toBeUndefined();
  });
});

import { describe, it, expect } from "vitest";
import { sleep, mapWithConcurrency, mapSettledWithConcurrency } from "./util.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("mapWithConcurrency", () => {
  it("preserves input order in the result", async () => {
    const items = [5, 4, 3, 2, 1];
    const result = await mapWithConcurrency(items, 2, async (n) => {
      await sleep(n);
      return n * 10;
    });
    expect(result).toEqual([50, 40, 30, 20, 10]);
  });

  it("returns a result array with the same length as items", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    const result = await mapWithConcurrency(items, 3, async (n) => n);
    expect(result.length).toBe(items.length);
  });

  it("never exceeds the concurrency cap", async () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const concurrency = 3;
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(items, concurrency, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(0);
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
  });

  it("rejects if any fn call rejects", async () => {
    const items = [1, 2, 3];
    await expect(
      mapWithConcurrency(items, 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      }),
    ).rejects.toThrow("boom");
  });

  it("returns an empty array for empty items", async () => {
    const result = await mapWithConcurrency<number, number>([], 3, async (n) => n);
    expect(result).toEqual([]);
  });

  it("processes all items and preserves order when length is not a multiple of concurrency", async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await mapWithConcurrency(items, 3, async (n) => n * 2);
    expect(result).toEqual([2, 4, 6, 8, 10]);
  });

  it("starts the next item as soon as a slot frees, not at a batch barrier", async () => {
    const gates = new Map<number, () => void>();
    const started: number[] = [];
    const p = mapWithConcurrency([0, 1, 2, 3], 2, async (n) => {
      started.push(n);
      await new Promise<void>((res) => gates.set(n, res));
      return n * 10;
    });
    await tick();
    expect(started).toEqual([0, 1]);
    gates.get(1)!(); // item 1 finishes; item 0 is still in flight
    await tick();
    expect(started).toEqual([0, 1, 2]); // batching would stall here
    gates.get(0)!();
    gates.get(2)!();
    await tick();
    gates.get(3)!();
    await expect(p).resolves.toEqual([0, 10, 20, 30]);
  });

  it("stops handing out new items after a rejection", async () => {
    const started: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
        started.push(n);
        if (n === 1) throw new Error("boom");
        await sleep(1);
        return n;
      }),
    ).rejects.toThrow("boom");
    await sleep(20);
    expect(started).toEqual([1, 2]);
  });

  it("handles a concurrency larger than the item count", async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (n) => n * 3);
    expect(result).toEqual([3, 6]);
  });

  it("treats a non-positive concurrency as serial rather than hanging", async () => {
    const result = await mapWithConcurrency([1, 2, 3], 0, async (n) => n + 1);
    expect(result).toEqual([2, 3, 4]);
  });
});

describe("mapSettledWithConcurrency", () => {
  it("returns PromiseSettledResult entries in input order", async () => {
    const items = [3, 2, 1];
    const result = await mapSettledWithConcurrency(items, 2, async (n) => {
      await sleep(n);
      return n * 10;
    });
    expect(result).toEqual([
      { status: "fulfilled", value: 30 },
      { status: "fulfilled", value: 20 },
      { status: "fulfilled", value: 10 },
    ]);
  });

  it("isolates a rejecting fn while siblings still resolve, and never rejects overall", async () => {
    const items = [1, 2, 3];
    const result = await mapSettledWithConcurrency(items, 3, async (n) => {
      if (n === 2) throw new Error("item 2 failed");
      return n;
    });
    expect(result[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(result[1].status).toBe("rejected");
    if (result[1].status === "rejected") {
      expect(result[1].reason).toBeInstanceOf(Error);
      expect(result[1].reason.message).toBe("item 2 failed");
    }
    expect(result[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("respects the concurrency cap", async () => {
    const items = [1, 2, 3, 4, 5, 6];
    const concurrency = 2;
    let inFlight = 0;
    let maxInFlight = 0;
    await mapSettledWithConcurrency(items, concurrency, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(0);
      inFlight--;
      return n;
    });
    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
  });

  it("returns an empty array for empty items", async () => {
    const result = await mapSettledWithConcurrency<number, number>([], 3, async (n) => n);
    expect(result).toEqual([]);
  });

  it("processes all items and preserves order when length is not a multiple of concurrency", async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await mapSettledWithConcurrency(items, 3, async (n) => n * 2);
    expect(result).toEqual([
      { status: "fulfilled", value: 2 },
      { status: "fulfilled", value: 4 },
      { status: "fulfilled", value: 6 },
      { status: "fulfilled", value: 8 },
      { status: "fulfilled", value: 10 },
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { sleep, mapWithConcurrency, mapSettledWithConcurrency } from "./util.js";

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

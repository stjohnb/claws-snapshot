import { describe, it, expect } from "vitest";
import { formatMs } from "./format.js";

describe("formatMs", () => {
  it("returns '0ms' for zero", () => {
    expect(formatMs(0)).toBe("0ms");
  });

  it("returns '0ms' for negative values", () => {
    expect(formatMs(-100)).toBe("0ms");
  });

  it("returns milliseconds for values under 1000", () => {
    expect(formatMs(1)).toBe("1ms");
    expect(formatMs(999)).toBe("999ms");
  });

  it("returns seconds only", () => {
    expect(formatMs(5000)).toBe("5s");
  });

  it("returns minutes and seconds", () => {
    expect(formatMs(65_000)).toBe("1m 5s");
  });

  it("returns minutes only when seconds are zero", () => {
    expect(formatMs(120_000)).toBe("2m");
  });

  it("returns hours and minutes", () => {
    expect(formatMs(5_400_000)).toBe("1h 30m");
  });

  it("returns hours only when minutes are zero", () => {
    expect(formatMs(3_600_000)).toBe("1h");
  });
});

import { describe, it, expect } from "vitest";
import { CHARTJS_SOURCE } from "./chartjs.js";

describe("vendored Chart.js", () => {
  it("is the full v4.5.1 UMD bundle", () => {
    expect(CHARTJS_SOURCE).toContain("Chart.js v4.5.1");
    expect(CHARTJS_SOURCE.length).toBeGreaterThan(200_000);
  });
});

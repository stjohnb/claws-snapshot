import { describe, it, expect } from "vitest";
import { excerptLog } from "./log-excerpt.js";

describe("excerptLog", () => {
  it("passes short input through untouched", () => {
    expect(excerptLog("hello world", 20_000)).toBe("hello world");
  });

  it("returns empty string unchanged", () => {
    expect(excerptLog("", 20_000)).toBe("");
  });

  it("keeps head and tail with a marker for long input", () => {
    const text = "x".repeat(25_000);
    const result = excerptLog(text, 20_000);
    expect(result.startsWith(text.slice(0, 10))).toBe(true);
    expect(result.endsWith(text.slice(-10))).toBe(true);
    expect(result).toContain("elided");
  });

  it("keeps a trailing ##[error] line in the final 100 chars", () => {
    const text = "pass\n".repeat(6000) + "##[error]Process completed with exit code 1.";
    const result = excerptLog(text, 20_000);
    expect(result).toContain("##[error]Process completed with exit code 1.");
  });
});

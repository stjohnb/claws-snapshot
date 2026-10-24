import { describe, expect, it, vi } from "vitest";

vi.mock("./version.js", () => ({ VERSION: "2026.10.05-abc" }));

const { sessionUpgradedSince } = await import("./session-upgrade.js");

describe("sessionUpgradedSince", () => {
  it("is false for a session launched under the running version", () => {
    expect(sessionUpgradedSince("2026.10.05-abc")).toBe(false);
  });

  it("is true for a session launched under an older version", () => {
    expect(sessionUpgradedSince("2026.10.01-def")).toBe(true);
  });

  it("is false when the launch version is unknown", () => {
    expect(sessionUpgradedSince(null)).toBe(false);
    expect(sessionUpgradedSince(undefined)).toBe(false);
    expect(sessionUpgradedSince("")).toBe(false);
  });
});

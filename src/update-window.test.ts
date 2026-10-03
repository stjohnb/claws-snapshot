import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockPR } from "./test-helpers.js";

const mockWindow = vi.hoisted(() => ({ enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" }));
vi.mock("./config.js", () => ({
  get THIRD_PARTY_UPDATE_WINDOW() {
    return mockWindow;
  },
}));

vi.mock("./github.js", () => ({
  isDependabotPR: (pr: { author: { login: string } }) =>
    pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot",
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
}));

const mockGetRepoConfig = vi.hoisted(() => vi.fn());
vi.mock("./repo-config.js", () => ({ getRepoConfig: mockGetRepoConfig }));

import {
  describeUpdateWindow,
  isInsideUpdateWindow,
  isThirdPartyUpdateDeferred,
  isThirdPartyUpdatePR,
  localMinutesOfDay,
  minutesInWindow,
  utcOffsetsAcrossYear,
} from "./update-window.js";

const REPO = "St-John-Software/fleet-infra";
// 14:00 BST (13:00 UTC) — outside the window.
const AFTERNOON = new Date("2026-09-24T13:00:00Z");
// 23:30 BST (22:30 UTC) — inside the window.
const LATE_EVENING = new Date("2026-09-24T22:30:00Z");

beforeEach(() => {
  Object.assign(mockWindow, { enabled: true, start: "22:00", end: "07:00", timezone: "Europe/London" });
  mockGetRepoConfig.mockReset().mockReturnValue(null);
});

describe("minutesInWindow", () => {
  it("wraps midnight when start > end", () => {
    expect(minutesInWindow(23 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(minutesInWindow(3 * 60, 22 * 60, 7 * 60)).toBe(true);
    expect(minutesInWindow(7 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(minutesInWindow(12 * 60, 22 * 60, 7 * 60)).toBe(false);
    expect(minutesInWindow(22 * 60, 22 * 60, 7 * 60)).toBe(true);
  });

  it("handles a same-day window", () => {
    expect(minutesInWindow(2 * 60, 1 * 60, 5 * 60)).toBe(true);
    expect(minutesInWindow(6 * 60, 1 * 60, 5 * 60)).toBe(false);
  });
});

describe("localMinutesOfDay", () => {
  it("evaluates in the configured zone, not host time", () => {
    // 21:30 UTC in summer is 22:30 in London.
    const d = new Date("2026-07-01T21:30:00Z");
    expect(localMinutesOfDay(d, "Europe/London")).toBe(22 * 60 + 30);
    expect(localMinutesOfDay(d, "UTC")).toBe(21 * 60 + 30);
  });

  it("reports midnight as 0, not 24", () => {
    expect(localMinutesOfDay(new Date("2026-01-15T00:00:00Z"), "Europe/London")).toBe(0);
  });
});

describe("isInsideUpdateWindow", () => {
  it("uses Europe/London across the DST boundary", () => {
    // 21:30 UTC: 22:30 BST (inside) in summer, 21:30 GMT (outside) in winter.
    expect(isInsideUpdateWindow(new Date("2026-07-01T21:30:00Z"))).toBe(true);
    expect(isInsideUpdateWindow(new Date("2026-01-15T21:30:00Z"))).toBe(false);
  });

  it("is always true when the window is disabled", () => {
    mockWindow.enabled = false;
    expect(isInsideUpdateWindow(AFTERNOON)).toBe(true);
  });
});

describe("isThirdPartyUpdatePR", () => {
  it("matches a human-authored renovate/* branch", () => {
    expect(isThirdPartyUpdatePR(mockPR({ author: { login: "stjohnb" }, headRefName: "renovate/x" }))).toBe(true);
  });

  it("matches Dependabot by login, including app/dependabot", () => {
    expect(isThirdPartyUpdatePR(mockPR({ author: { login: "app/dependabot" } }))).toBe(true);
    expect(isThirdPartyUpdatePR(mockPR({ author: { login: "dependabot[bot]" } }))).toBe(true);
  });

  it("matches renovate[bot] by login and dependabot/* by branch", () => {
    expect(isThirdPartyUpdatePR(mockPR({ author: { login: "app/renovate" } }))).toBe(true);
    expect(isThirdPartyUpdatePR(mockPR({ headRefName: "dependabot/npm/lodash" }))).toBe(true);
  });

  it("never matches an own-app auto-bump PR", () => {
    const pr = mockPR({ headRefName: "automation/bump-claws", labels: [{ name: "auto-bump" }], author: { login: "app/claws" } });
    expect(isThirdPartyUpdatePR(pr)).toBe(false);
  });
});

describe("isThirdPartyUpdateDeferred", () => {
  const renovate = mockPR({ author: { login: "stjohnb" }, headRefName: "renovate/x" });

  it("defers a third-party PR outside the window and not inside it", () => {
    expect(isThirdPartyUpdateDeferred(REPO, renovate, AFTERNOON)).toBe(true);
    expect(isThirdPartyUpdateDeferred(REPO, renovate, LATE_EVENING)).toBe(false);
  });

  it("never defers an auto-bump PR", () => {
    const pr = mockPR({ headRefName: "automation/bump-claws", labels: [{ name: "auto-bump" }] });
    expect(isThirdPartyUpdateDeferred(REPO, pr, AFTERNOON)).toBe(false);
  });

  it("honours the per-repo opt-out", () => {
    mockGetRepoConfig.mockReturnValue({ dependencyUpdateWindow: false });
    expect(isThirdPartyUpdateDeferred(REPO, renovate, AFTERNOON)).toBe(false);
    expect(mockGetRepoConfig).toHaveBeenCalledWith(REPO);
  });

  it("never defers when the window is disabled", () => {
    mockWindow.enabled = false;
    expect(isThirdPartyUpdateDeferred(REPO, renovate, AFTERNOON)).toBe(false);
  });
});

describe("describeUpdateWindow", () => {
  it("formats start, end and zone", () => {
    expect(describeUpdateWindow()).toBe("22:00–07:00 Europe/London");
  });
});

describe("utcOffsetsAcrossYear", () => {
  it("returns winter and summer offsets in minutes", () => {
    expect(utcOffsetsAcrossYear("Europe/London", 2026)).toEqual({ january: 0, july: 60 });
    expect(utcOffsetsAcrossYear("UTC", 2026)).toEqual({ january: 0, july: 0 });
  });
});

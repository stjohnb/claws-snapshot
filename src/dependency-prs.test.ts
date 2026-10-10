import { describe, it, expect, vi } from "vitest";
import { mockPR } from "./test-helpers.js";

vi.mock("./github.js", () => ({
  isDependabotPR: (pr: { author: { login: string } }) =>
    pr.author.login === "dependabot[bot]" || pr.author.login === "app/dependabot",
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
}));

import { isDependencyUpdatePR, isThirdPartyUpdatePR, parsePRViewKind } from "./dependency-prs.js";

describe("parsePRViewKind and isDependencyUpdatePR", () => {
  it("parses only the three exact view names", () => {
    expect(parsePRViewKind("deps")).toBe("deps");
    expect(parsePRViewKind("other")).toBe("other");
    expect(parsePRViewKind("all")).toBe("all");
    expect(parsePRViewKind(undefined)).toBeUndefined();
    expect(parsePRViewKind("DEPS")).toBeUndefined();
    expect(parsePRViewKind("x")).toBeUndefined();
  });
  it("counts third-party updates and auto-bumps, not major auto-bumps or Claws PRs", () => {
    expect(isDependencyUpdatePR(mockPR({ headRefName: "renovate/foo" }))).toBe(true);
    expect(isDependencyUpdatePR(mockPR({ headRefName: "automation/bump-x", labels: [{ name: "auto-bump" }] }))).toBe(true);
    expect(isDependencyUpdatePR(mockPR({ headRefName: "automation/bump-x", labels: [{ name: "auto-bump" }, { name: "major-update" }] }))).toBe(false);
    expect(isDependencyUpdatePR(mockPR({ headRefName: "claws/issue-1-abc1" }))).toBe(false);
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

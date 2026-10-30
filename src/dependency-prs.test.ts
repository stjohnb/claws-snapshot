import { describe, it, expect, vi } from "vitest";
import { mockPR } from "./test-helpers.js";

vi.mock("./github.js", () => ({
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
}));

import { isDependencyUpdatePR, isImageScanPR, isImageScanPrunePR, isImageScanSnapshotPR, isThirdPartyUpdatePR, parsePRViewKind } from "./dependency-prs.js";

describe("parsePRViewKind and isDependencyUpdatePR", () => {
  it("parses only the three exact view names", () => {
    expect(parsePRViewKind("deps")).toBe("deps");
    expect(parsePRViewKind("other")).toBe("other");
    expect(parsePRViewKind("all")).toBe("all");
    expect(parsePRViewKind("blocked")).toBe("blocked");
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

  it("matches renovate[bot] by login", () => {
    expect(isThirdPartyUpdatePR(mockPR({ author: { login: "app/renovate" } }))).toBe(true);
  });

  it("no longer matches a Dependabot PR", () => {
    expect(isThirdPartyUpdatePR(mockPR({ author: { login: "dependabot[bot]" }, headRefName: "dependabot/npm/lodash" }))).toBe(false);
  });

  it("never matches an own-app auto-bump PR", () => {
    const pr = mockPR({ headRefName: "automation/bump-claws", labels: [{ name: "auto-bump" }], author: { login: "app/claws" } });
    expect(isThirdPartyUpdatePR(pr)).toBe(false);
  });
});

describe("image-scan PR classes", () => {
  it("match the two generated branches exactly, whatever the labels", () => {
    const snapshot = mockPR({ headRefName: "automation/image-scan-advisories", labels: [{ name: "auto-bump" }] });
    const prune = mockPR({ headRefName: "automation/image-scan-exceptions-prune" });
    expect(isImageScanSnapshotPR(snapshot)).toBe(true);
    expect(isImageScanPrunePR(snapshot)).toBe(false);
    expect(isImageScanPrunePR(prune)).toBe(true);
    expect(isImageScanPR(snapshot) && isImageScanPR(prune)).toBe(true);
    expect(isImageScanPR(mockPR({ headRefName: "automation/image-scan-advisories-2" }))).toBe(false);
    expect(isImageScanPR(mockPR({ headRefName: "automation/bump-app-1.2.3", labels: [{ name: "auto-bump" }] }))).toBe(false);
  });
});

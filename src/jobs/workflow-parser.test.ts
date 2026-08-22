import { describe, it, expect } from "vitest";
import { GITHUB_HOSTED_LABEL_PREFIXES, isGitHubHostedLabel } from "./workflow-parser.js";

describe("isGitHubHostedLabel", () => {
  it.each([
    "ubuntu-latest",
    "ubuntu-22.04",
    "windows-latest",
    "windows-2022",
    "macos-latest",
    "macos-14",
    "ubuntu-24.04-arm",
  ])("returns true for %s", (label) => {
    expect(isGitHubHostedLabel(label)).toBe(true);
  });

  it.each(["self-hosted", "linux", "macos", "ubuntu", "windows", ""])(
    "returns false for %s",
    (label) => {
      expect(isGitHubHostedLabel(label)).toBe(false);
    },
  );
});

describe("GITHUB_HOSTED_LABEL_PREFIXES", () => {
  it("contains exactly the three GitHub-hosted OS prefixes", () => {
    expect(GITHUB_HOSTED_LABEL_PREFIXES).toEqual(["ubuntu-", "windows-", "macos-"]);
  });
});

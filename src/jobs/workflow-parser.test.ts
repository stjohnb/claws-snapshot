import { describe, it, expect } from "vitest";
import {
  GITHUB_HOSTED_LABEL_PREFIXES,
  hostedRunnerExemptionReason,
  isGitHubHostedLabel,
} from "./workflow-parser.js";

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

describe("hostedRunnerExemptionReason", () => {
  it("returns the trimmed reason when the marker has one", () => {
    expect(
      hostedRunnerExemptionReason(
        "# claws-allow-github-hosted-runner: provisions the runner while the pool is down\njobs:\n",
      ),
    ).toBe("provisions the runner while the pool is down");
  });

  it("returns null when the marker's reason is empty", () => {
    expect(hostedRunnerExemptionReason("# claws-allow-github-hosted-runner:\njobs:\n")).toBeNull();
  });

  it("returns null when the marker's reason is whitespace only", () => {
    expect(hostedRunnerExemptionReason("# claws-allow-github-hosted-runner:    \njobs:\n")).toBeNull();
  });

  it("tolerates extra spaces after the leading #", () => {
    expect(hostedRunnerExemptionReason("#   claws-allow-github-hosted-runner: x\n")).toBe("x");
  });

  it("returns null when the file has no marker", () => {
    expect(hostedRunnerExemptionReason("name: CI\njobs:\n  build:\n    runs-on: ubuntu-latest\n")).toBeNull();
  });

  it("returns null when the marker text appears on a non-comment line", () => {
    expect(
      hostedRunnerExemptionReason(
        "jobs:\n  build:\n    steps:\n      - run: echo claws-allow-github-hosted-runner: nope\n",
      ),
    ).toBeNull();
  });

  it("finds the marker deep inside a long header comment block", () => {
    const content = [
      "# This workflow provisions an on-demand Hetzner runner.",
      "# It intentionally runs on GitHub-hosted infrastructure because the",
      "# self-hosted pool (nas, ryzen) may be offline when this needs to run.",
      "# claws-allow-github-hosted-runner: provisions the runner while the pool is down",
      "name: hetzner-runner-up",
      "jobs:",
      "  up:",
      "    runs-on: ubuntu-latest",
    ].join("\n");
    expect(hostedRunnerExemptionReason(content)).toBe(
      "provisions the runner while the pool is down",
    );
  });
});

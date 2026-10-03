import { describe, it, expect, vi } from "vitest";
import { mockPR } from "./test-helpers.js";

const mockForgejoRepos = vi.hoisted(() => new Set<string>(["forge-org/perudo"]));
vi.mock("./config.js", () => ({
  isForgejoRepo: (fullName: string) => mockForgejoRepos.has(fullName),
}));
vi.mock("./github.js", () => ({
  isForkPR: (pr: { isCrossRepository?: boolean }) => pr.isCrossRepository === true,
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
  isAllowedHumanActor: async (login: string) => login === "stjohnb",
}));

import { isRenovateMajorUpdate, isTrustedRenovatePR, renovateUpdateTypes } from "./renovate.js";

/** The body shape of fleet-infra #1655's Renovate PR. */
const TABLE_BODY = [
  "This PR contains the following updates:",
  "",
  "| Package | Update | Change |",
  "|---|---|---|",
  "| [ollama/ollama](https://github.com/ollama/ollama) | minor | `0.11.0` -> `0.12.0` |",
  "",
  "---",
  "",
  "### Configuration",
].join("\n");

function renovate(over: Parameters<typeof mockPR>[0] = {}) {
  return mockPR({ headRefName: "renovate/ollama-ollama-0.x", title: "chore(deps): update ollama/ollama to v0.12.0", body: TABLE_BODY, ...over });
}

describe("renovateUpdateTypes", () => {
  it("reads the Update column of Renovate's table", () => {
    expect(renovateUpdateTypes(TABLE_BODY)).toEqual(["minor"]);
  });

  it("reads every row of a grouped PR, whatever the column order", () => {
    const body = "| Update | Package |\n|:-:|---|\n| `patch` | a |\n| **major** | b |\n\nafter";
    expect(renovateUpdateTypes(body)).toEqual(["patch", "major"]);
  });

  it("is null for a body without the table", () => {
    expect(renovateUpdateTypes("Bumps things.")).toBeNull();
    expect(renovateUpdateTypes(undefined)).toBeNull();
    expect(renovateUpdateTypes("| Update |\n|---|\n")).toBeNull();
  });
});

describe("isRenovateMajorUpdate", () => {
  it("is false for a minor update", () => {
    expect(isRenovateMajorUpdate(renovate())).toBe(false);
  });

  it("is true for a major row in the table", () => {
    expect(isRenovateMajorUpdate(renovate({ body: TABLE_BODY.replace("| minor |", "| major |") }))).toBe(true);
  });

  it("is true for a major-update label, a (major) title or a renovate/major- branch", () => {
    expect(isRenovateMajorUpdate(renovate({ labels: [{ name: "major-update" }] }))).toBe(true);
    expect(isRenovateMajorUpdate(renovate({ title: "chore(deps): update ollama to v1 (major)" }))).toBe(true);
    expect(isRenovateMajorUpdate(renovate({ headRefName: "renovate/major-ollama" }))).toBe(true);
  });

  it("fails closed when the body has no Update column", () => {
    expect(isRenovateMajorUpdate(renovate({ body: "custom template" }))).toBe(true);
  });
});

describe("isTrustedRenovatePR", () => {
  it("trusts the Renovate app and an allowed human actor's PAT", async () => {
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "app/renovate" } }))).toBe(true);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stjohnb" } }))).toBe(true);
  });

  it("trusts the renovate account on a Forgejo repo only", async () => {
    expect(await isTrustedRenovatePR("forge-org/perudo", renovate({ author: { login: "renovate" } }))).toBe(true);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "renovate" } }))).toBe(false);
  });

  it("rejects forks, non-renovate/ branches and other logins", async () => {
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stjohnb" }, isCrossRepository: true }))).toBe(false);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stjohnb" }, headRefName: "deps/x" }))).toBe(false);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stranger" } }))).toBe(false);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "other[bot]" } }))).toBe(false);
  });
});

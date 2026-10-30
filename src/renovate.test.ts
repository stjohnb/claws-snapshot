import { describe, it, expect, vi } from "vitest";
import { mockPR } from "./test-helpers.js";

vi.mock("./config.js", () => ({}));
vi.mock("./github.js", () => ({
  isForkPR: (pr: { isCrossRepository?: boolean }) => pr.isCrossRepository === true,
  normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
  isAllowedHumanActor: async (login: string) => login === "stjohnb",
}));

import { classifyRenovateUpdate, isRenovateMajorUpdate, isTrustedRenovatePR, renovateApprovalHoldReason, RENOVATE_UPDATE_TYPE_UNKNOWN_REASON, renovateUpdateTypes, renovateChangeVersions } from "./renovate.js";

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
  it("trusts the Forgejo renovate account and an allowed human actor's PAT", async () => {
    expect(await isTrustedRenovatePR("forge-org/perudo", renovate({ author: { login: "renovate" } }))).toBe(true);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stjohnb" } }))).toBe(true);
  });

  it("no longer trusts GitHub's Renovate app", async () => {
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "app/renovate" } }))).toBe(false);
  });

  it("rejects forks, non-renovate/ branches and other logins", async () => {
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stjohnb" }, isCrossRepository: true }))).toBe(false);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stjohnb" }, headRefName: "deps/x" }))).toBe(false);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "stranger" } }))).toBe(false);
    expect(await isTrustedRenovatePR("gh-org/fleet-infra", renovate({ author: { login: "other[bot]" } }))).toBe(false);
  });
});

const GARDEN_BODY = [
  "## Summary",
  "Refreshes the lockfile.",
  "",
  "## Changes",
  "- package-lock.json",
  "",
  "---",
  "*— CI fixed with: sonnet (provider: claude) —*",
  "",
  "---",
  "",
  "| Package | Update | Change |",
  "|---|---|---|",
  "| [@types/node](https://github.com/DefinitelyTyped) | patch | `26.6.2` -> `26.6.3` |",
  "",
  "### Configuration",
].join("\n");

describe("rewritten Renovate bodies", () => {
  it("classifies a Garden #2-shaped body by the appended table", () => {
    expect(renovateUpdateTypes(GARDEN_BODY)).toEqual(["patch"]);
    expect(isRenovateMajorUpdate(renovate({ body: GARDEN_BODY }))).toBe(false);
  });

  it("sees a major row in a later table", () => {
    const body = TABLE_BODY + "\n\n| Package | Update | Change |\n|---|---|---|\n| b | major | 1 -> 2 |";
    expect(renovateUpdateTypes(body)).toEqual(["minor", "major"]);
    expect(isRenovateMajorUpdate(renovate({ body }))).toBe(true);
  });

  it("reads Renovate's major title shape", () => {
    expect(isRenovateMajorUpdate(renovate({ body: "", title: "update actions/upload-artifact action to v5" }))).toBe(true);
    expect(classifyRenovateUpdate(renovate({ body: "", title: "update dependency @types/node to v26.6.3" }))).toBe("unknown");
  });

  it("classifies a bodyless PR as unknown and still fails closed", () => {
    expect(classifyRenovateUpdate(renovate({ body: "" }))).toBe("unknown");
    expect(isRenovateMajorUpdate(renovate({ body: "" }))).toBe(true);
  });

  it("explains the hold only for a trusted PR with an unclassifiable body", async () => {
    const pr = renovate({ body: "custom template", author: { login: "renovate" } });
    expect(await renovateApprovalHoldReason("forge-org/perudo", pr)).toBe(RENOVATE_UPDATE_TYPE_UNKNOWN_REASON);
    expect(await renovateApprovalHoldReason("forge-org/perudo", { ...pr, body: TABLE_BODY })).toBeNull();
    expect(await renovateApprovalHoldReason("forge-org/perudo", { ...pr, author: { login: "someone" } })).toBeNull();
  });
});

const CHANGE_HEAD = [
  "| Package | Change | [Age](https://docs.renovatebot.com/merge-confidence/) | [Confidence](https://docs.renovatebot.com/merge-confidence/) |",
  "|---|---|---|---|",
];
const badge = "![age](https://developer.mend.io/api/mc/badges/age/npm/x/1)";
function changeBody(...changes: string[]): string {
  const rows = changes.map((c) => {
    const [from, to] = c.split(" → ");
    return `| [x](https://example.com/x) | [\`${from}\` → \`${to}\`](https://renovatebot.com/diffs/npm/x/1/2) | ${badge} | ${badge} |`;
  });
  return ["This PR contains the following updates:", "", ...CHANGE_HEAD, ...rows, "", "---"].join("\n");
}
const kind = (...changes: string[]) => classifyRenovateUpdate(renovate({ body: changeBody(...changes) }));

describe("Change-column classification (no Update column)", () => {
  it("reads versions from linked, code-ticked cells", () => {
    expect(renovateChangeVersions(changeBody("^2.1.3 → ^2.1.4"))).toEqual([{ from: "^2.1.3", to: "^2.1.4" }]);
  });

  it("treats minor, patch and 0.x minor bumps as non-major", () => {
    expect(kind("^2.1.3 → ^2.2.0")).toBe("non-major");
    expect(kind("^2.1.3 → ^2.1.4")).toBe("non-major");
    expect(kind("0.3.1 → 0.4.0")).toBe("non-major");
    expect(kind("^26 → ^26.6.4")).toBe("non-major");
    expect(kind("26-bookworm-slim → 26.11.1-bookworm-slim")).toBe("non-major");
  });

  it("treats any row changing the leading major as major", () => {
    expect(kind("^2.1.3 → ^2.1.4", "^1.52.0 → ^2.0.0")).toBe("major");
  });

  it("ignores range prefixes", () => {
    expect(kind("~1.2.3 → ~1.3.0")).toBe("non-major");
    expect(kind("==1.2.3 → ==1.2.4")).toBe("non-major");
    expect(kind(">=0.3.1 → >=0.4.0")).toBe("non-major");
    expect(kind("==1.2.3 → ==2.0.0")).toBe("major");
  });

  it("fails closed on an unreadable row unless another row is major", () => {
    expect(kind("abc → def")).toBe("unknown");
    expect(kind("^1.0.0 → ^1.0.1", "abc → def")).toBe("unknown");
    expect(kind("abc → def", "1.0.0 → 2.0.0")).toBe("major");
  });

  it("classifies from the Update column only when both are present", () => {
    const body = "| Package | Update | Change |\n|---|---|---|\n| a | minor | `1.0.0` -> `2.0.0` |";
    expect(classifyRenovateUpdate(renovate({ body }))).toBe("non-major");
  });

  it("is not held for approval when non-major", async () => {
    const pr = renovate({ headRefName: "renovate/x", body: changeBody("1.0.0 → 1.1.0") });
    expect(await renovateApprovalHoldReason("o/r", pr)).toBeNull();
  });
});

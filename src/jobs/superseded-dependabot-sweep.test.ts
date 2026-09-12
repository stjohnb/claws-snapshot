import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo, mockPR } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: {
    refined: "Refined",
    ready: "Ready",
    priority: "Priority",
    problematic: "Claws Problematic",
    automerge: "Automerge",
  },
}));

vi.mock("../log.js", async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    runContext: new AsyncLocalStorage(),
  };
});

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const mockGh = vi.hoisted(() => ({
  isDependabotPR: vi.fn((pr: { author: { login: string } }) => pr.author.login === "dependabot[bot]"),
  isForkPR: vi.fn().mockReturnValue(false),
  isDispatchSkippable: vi.fn().mockReturnValue(false),
  listOpenIssues: vi.fn().mockResolvedValue([]),
  listRecentlyClosedIssues: vi.fn().mockResolvedValue([]),
  getPRBody: vi.fn().mockResolvedValue(""),
  fetchRepoFileWithSha: vi.fn().mockResolvedValue(null),
  getIssueComments: vi.fn().mockResolvedValue([]),
  commentOnIssue: vi.fn().mockResolvedValue(undefined),
  closePR: vi.fn().mockResolvedValue(undefined),
  removeQueueItem: vi.fn(),
}));
vi.mock("../github.js", () => mockGh);

const mockDb = vi.hoisted(() => ({
  hasActiveWorkForPR: vi.fn().mockReturnValue(false),
}));
vi.mock("../db.js", () => mockDb);

vi.mock("../worker.js", () => ({
  AGENT_KINDS: {
    CI_FIXER: "ci-fixer",
    CI_FIXER_CONFLICT: "ci-fixer:conflict",
    CI_FIXER_PROBLEMATIC: "ci-fixer:problematic",
    REVIEW_ADDRESSER: "review-addresser",
    PR_REVIEWER: "pr-reviewer",
  },
}));

import {
  parseDependabotBumps,
  compareVersions,
  parseBlockedMajors,
  parseLockVersions,
  findTrackingIssue,
  sweepSupersededDependabotPRs,
  SUPERSEDED_MARKER,
} from "./superseded-dependabot-sweep.js";

// ── Fixtures from the case study: St-John-Software/bstjohn-blog#561 / #562 ──

const PR_561_BODY = `Bumps the all-dependencies group with 9 updates:

| Package | From | To |
| --- | --- | --- |
| [@astrojs/markdown-remark](https://github.com/withastro/astro) | \`7.2.1\` | \`7.2.2\` |
| [astro](https://github.com/withastro/astro) | \`7.1.3\` | \`7.1.6\` |
| [@astrojs/check](https://github.com/withastro/astro) | \`0.9.9\` | \`0.9.10\` |
| [@typescript-eslint/parser](https://github.com/typescript-eslint/typescript-eslint) | \`8.65.0\` | \`8.66.0\` |
| [eslint-plugin-astro](https://github.com/ota-meshi/eslint-plugin-astro) | \`3.0.1\` | \`3.1.0\` |
| [html-validate](https://gitlab.com/html-validate/html-validate) | \`11.5.6\` | \`11.6.2\` |
| [markdownlint-cli2](https://github.com/DavidAnson/markdownlint-cli2) | \`0.23.1\` | \`0.23.2\` |
| [typescript](https://github.com/microsoft/TypeScript) | \`6.0.3\` | \`7.0.2\` |
| [typescript-eslint](https://github.com/typescript-eslint/typescript-eslint) | \`8.65.0\` | \`8.66.0\` |

Updates \`astro\` from 7.1.3 to 7.1.6
`;

const ISSUE_562_BODY = `A Dependabot pull request that bumps one or more dependencies across a major version has repeatedly failed CI and could not be auto-fixed by Claws.

**Source PR:** St-John-Software/bstjohn-blog#561 — build(deps): Bump the all-dependencies group with 9 updates
**Branch:** \`dependabot/npm_and_yarn/all-dependencies-a2a25cfce8\`

**Major bump(s):**
- \`eslint-plugin-unicorn\`: 71.x → 72.x
- \`typescript\`: 6.x → 7.x

See the failing CI checks on the PR for the specific error.`;

function lockWith(overrides: Record<string, string> = {}): string {
  const versions: Record<string, string> = {
    "@astrojs/markdown-remark": "7.2.2",
    astro: "7.2.0",
    "@astrojs/check": "0.9.10",
    "@typescript-eslint/parser": "8.66.0",
    "eslint-plugin-astro": "3.1.0",
    "html-validate": "11.6.2",
    "markdownlint-cli2": "0.23.2",
    typescript: "6.0.3",
    "typescript-eslint": "8.66.0",
    ...overrides,
  };
  const packages: Record<string, { version?: string }> = { "": { version: "1.0.0" } };
  for (const [name, version] of Object.entries(versions)) {
    packages[`node_modules/${name}`] = { version };
  }
  return JSON.stringify({ lockfileVersion: 3, packages });
}

describe("parseDependabotBumps", () => {
  it("parses a 9-row group table", () => {
    const bumps = parseDependabotBumps("build(deps): Bump the all-dependencies group with 9 updates", PR_561_BODY);
    expect(bumps).toHaveLength(9);
    expect(bumps[1]).toEqual({ pkg: "astro", from: "7.1.3", to: "7.1.6" });
    expect(bumps[7]).toEqual({ pkg: "typescript", from: "6.0.3", to: "7.0.2" });
  });

  it("falls back to the single-package title form", () => {
    const bumps = parseDependabotBumps("build(deps): Bump astro from 7.1.3 to 7.1.6", "");
    expect(bumps).toEqual([{ pkg: "astro", from: "7.1.3", to: "7.1.6" }]);
  });

  it("returns [] when nothing parses", () => {
    expect(parseDependabotBumps("chore: unrelated", "no table, no bump phrasing here")).toEqual([]);
  });

  it("drops rows whose package name contains a space or backtick", () => {
    const body = [
      "| Package | From | To |",
      "| --- | --- | --- |",
      "| [astro bad name](https://x) | `1.0.0` | `1.0.1` |",
      "| [ast`ro](https://x) | `1.0.0` | `1.0.1` |",
      "| [good-pkg](https://x) | `1.0.0` | `1.0.1` |",
    ].join("\n");
    expect(parseDependabotBumps("", body)).toEqual([{ pkg: "good-pkg", from: "1.0.0", to: "1.0.1" }]);
  });
});

describe("compareVersions", () => {
  it("compares numerically, not lexically", () => {
    expect(compareVersions("7.2.0", "7.1.6")).toBe(1);
    expect(compareVersions("0.9.10", "0.9.9")).toBe(1);
    expect(compareVersions("6.0.3", "7.0.2")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("ignores prerelease and build suffixes", () => {
    expect(compareVersions("8.0.0-rc.1", "8.0.0")).toBe(0);
    expect(compareVersions("8.0.0+build.5", "8.0.0")).toBe(0);
  });

  it("throws on a non-numeric segment", () => {
    expect(() => compareVersions("latest", "1.0.0")).toThrow();
  });
});

describe("parseBlockedMajors", () => {
  it("reads the major-bump bullets from a tracking issue", () => {
    expect(parseBlockedMajors(ISSUE_562_BODY)).toEqual(new Set(["eslint-plugin-unicorn", "typescript"]));
  });

  it("returns an empty set when nothing is documented", () => {
    expect(parseBlockedMajors("no bullets here").size).toBe(0);
  });
});

describe("parseLockVersions", () => {
  it("reads lockfileVersion 3 packages and ignores nested node_modules keys", () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { version: "1.0.0" },
        "node_modules/typescript": { version: "6.0.3" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/a/node_modules/typescript": { version: "4.0.0" },
      },
    });
    const versions = parseLockVersions(lock);
    expect(versions.get("typescript")).toBe("6.0.3");
    expect(versions.get("a")).toBe("1.0.0");
    expect(versions.size).toBe(2);
  });

  it("reads lockfileVersion 1 dependencies", () => {
    const lock = JSON.stringify({
      lockfileVersion: 1,
      dependencies: { astro: { version: "7.2.0" } },
    });
    expect(parseLockVersions(lock).get("astro")).toBe("7.2.0");
  });

  it("returns an empty map for garbage", () => {
    expect(parseLockVersions("not json").size).toBe(0);
    expect(parseLockVersions("").size).toBe(0);
    expect(parseLockVersions(JSON.stringify({ lockfileVersion: 3 })).size).toBe(0);
  });
});

describe("findTrackingIssue", () => {
  const issues = [{ number: 562, body: ISSUE_562_BODY }];

  it("matches the Source PR line", () => {
    expect(findTrackingIssue("St-John-Software/bstjohn-blog", 561, issues)).toBe(562);
  });

  it("does not match a longer PR number with the same prefix", () => {
    expect(findTrackingIssue("St-John-Software/bstjohn-blog", 56, issues)).toBeNull();
    const other = [{ number: 900, body: "**Source PR:** St-John-Software/bstjohn-blog#5610 — x" }];
    expect(findTrackingIssue("St-John-Software/bstjohn-blog", 561, other)).toBeNull();
  });

  it("returns null when no issue references the PR", () => {
    expect(findTrackingIssue("St-John-Software/bstjohn-blog", 999, issues)).toBeNull();
  });
});

describe("sweepSupersededDependabotPRs", () => {
  const repo = mockRepo({ owner: "St-John-Software", name: "bstjohn-blog", fullName: "St-John-Software/bstjohn-blog" });

  function candidatePR(overrides = {}) {
    return mockPR({
      number: 561,
      title: "build(deps): Bump the all-dependencies group with 9 updates",
      headRefName: "dependabot/npm_and_yarn/all-dependencies-a2a25cfce8",
      baseRefName: "main",
      labels: [{ name: "Claws Problematic" }],
      author: { login: "dependabot[bot]" },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.isDependabotPR.mockImplementation((pr: { author: { login: string } }) => pr.author.login === "dependabot[bot]");
    mockGh.isForkPR.mockReturnValue(false);
    mockGh.isDispatchSkippable.mockReturnValue(false);
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.listRecentlyClosedIssues.mockResolvedValue([{ number: 562, body: ISSUE_562_BODY }]);
    mockGh.getPRBody.mockResolvedValue(PR_561_BODY);
    mockGh.fetchRepoFileWithSha.mockResolvedValue({ content: lockWith(), sha: "abc" });
    mockGh.getIssueComments.mockResolvedValue([]);
    mockDb.hasActiveWorkForPR.mockReturnValue(false);
  });

  it("closes the superseded PR with a comment listing landed and held-back bumps", async () => {
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR()]);

    expect(closed).toEqual(new Set([561]));
    expect(mockGh.closePR).toHaveBeenCalledWith("St-John-Software/bstjohn-blog", 561);
    const msg = mockGh.commentOnIssue.mock.calls[0][2] as string;
    expect(msg).toContain(SUPERSEDED_MARKER);
    expect(msg).toContain("Tracking issue #562 is closed");
    expect(msg).toContain("**Held back (documented as blocked in #562):**");
    expect(msg).toContain("- `typescript`: 6.0.3 → 7.0.2");
    expect(msg).toContain("- `astro`: 7.1.6 requested → 7.2.0 on base");
  });

  it("leaves the PR alone when the tracking issue is still open", async () => {
    mockGh.listOpenIssues.mockResolvedValue([{ number: 562, body: ISSUE_562_BODY }]);
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR()]);
    expect(closed.size).toBe(0);
    expect(mockGh.closePR).not.toHaveBeenCalled();
  });

  it("leaves the PR alone when a non-blocked package is still behind on base", async () => {
    mockGh.fetchRepoFileWithSha.mockResolvedValue({ content: lockWith({ astro: "7.1.3" }), sha: "abc" });
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR()]);
    expect(closed.size).toBe(0);
    expect(mockGh.closePR).not.toHaveBeenCalled();
  });

  it("leaves the PR alone when a bumped package is absent from the base lockfile", async () => {
    const lock = JSON.parse(lockWith()) as { packages: Record<string, unknown> };
    delete lock.packages["node_modules/html-validate"];
    mockGh.fetchRepoFileWithSha.mockResolvedValue({ content: JSON.stringify(lock), sha: "abc" });
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR()]);
    expect(closed.size).toBe(0);
    expect(mockGh.closePR).not.toHaveBeenCalled();
  });

  it("leaves the PR alone when the lockfile is missing", async () => {
    mockGh.fetchRepoFileWithSha.mockResolvedValue(null);
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR()]);
    expect(closed.size).toBe(0);
    expect(mockGh.closePR).not.toHaveBeenCalled();
  });

  it("leaves the PR alone when the body has no parseable bumps", async () => {
    mockGh.getPRBody.mockResolvedValue("no table here");
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR({ title: "chore: something" })]);
    expect(closed.size).toBe(0);
    expect(mockGh.closePR).not.toHaveBeenCalled();
  });

  it("ignores non-dependabot authors", async () => {
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR({ author: { login: "someone" } })]);
    expect(closed.size).toBe(0);
    expect(mockGh.listRecentlyClosedIssues).not.toHaveBeenCalled();
  });

  it("ignores PRs without the Problematic label", async () => {
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR({ labels: [] })]);
    expect(closed.size).toBe(0);
    expect(mockGh.listRecentlyClosedIssues).not.toHaveBeenCalled();
  });

  it("ignores non-npm and nested-manifest dependabot branches", async () => {
    const closed = await sweepSupersededDependabotPRs(repo, [
      candidatePR({ number: 570, headRefName: "dependabot/github_actions/actions/checkout-5" }),
      candidatePR({ number: 571, headRefName: "dependabot/npm_and_yarn/apps/web/astro-7.1.6" }),
    ]);
    expect(closed.size).toBe(0);
    expect(mockGh.listRecentlyClosedIssues).not.toHaveBeenCalled();
  });

  it("ignores PRs with active agent work", async () => {
    mockDb.hasActiveWorkForPR.mockReturnValue(true);
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR()]);
    expect(closed.size).toBe(0);
    expect(mockGh.listRecentlyClosedIssues).not.toHaveBeenCalled();
  });

  it("skips the comment but still closes when the marker is already present", async () => {
    mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: `### Closing as superseded\n${SUPERSEDED_MARKER}` }]);
    const closed = await sweepSupersededDependabotPRs(repo, [candidatePR()]);
    expect(closed).toEqual(new Set([561]));
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.closePR).toHaveBeenCalledWith("St-John-Software/bstjohn-blog", 561);
  });
});

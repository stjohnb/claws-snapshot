import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  SELF_REPO: "test-org/claws",
  LABELS: { ready: "Ready", blocked: "Blocked", clawsIgnore: "Claws Ignore" },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../error-reporter.js", () => ({
  reportError: vi.fn(),
}));

const { mockGh, mockDb, mockOccurrence } = vi.hoisted(() => ({
  mockGh: {
    listRepoDirectory: vi.fn(),
    fetchRepoFileContent: vi.fn(),
    getUpstreamPRStatus: vi.fn(),
    getIssueState: vi.fn(),
    listReleases: vi.fn(),
    removeLabel: vi.fn(),
    addLabel: vi.fn(),
    commentOnIssue: vi.fn(),
  },
  mockDb: {
    hasUpstreamWatchFired: vi.fn(),
    recordUpstreamWatchFired: vi.fn(),
  },
  mockOccurrence: {
    upsertAlertIssue: vi.fn(),
    closeAlertIssueIfResolved: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGh);
vi.mock("../db.js", () => mockDb);
vi.mock("../occurrence-tracking.js", () => mockOccurrence);

import { parseWatchFile, evaluateCondition, buildUnblockComment, run, type Watch } from "./upstream-watcher.js";
import { reportError } from "../error-reporter.js";

const VALID_YAML = `
target:
  repo: test-org/fleet-infra
  issue: 913
conditions:
  - kind: pr_merged
    repo: upstream/thing
    number: 2715
`;

/** Puts one watch file in docs/upstream-watches/ with the given content. */
function stageWatchFile(name: string, content: string): void {
  mockGh.listRepoDirectory.mockResolvedValue([
    { name, path: `docs/upstream-watches/${name}`, sha: "abc", type: "file" },
  ]);
  mockGh.fetchRepoFileContent.mockResolvedValue(content);
}

describe("parseWatchFile", () => {
  it("parses a valid file and applies defaults", () => {
    const result = parseWatchFile("seerr-oidc-stable.yaml", VALID_YAML);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.watch.id).toBe("seerr-oidc-stable");
    expect(result.watch.require).toBe("all");
    expect(result.watch.target).toEqual({ repo: "test-org/fleet-infra", issue: 913 });
    expect(result.watch.conditions).toHaveLength(1);
  });

  it("honours an explicit id over the filename", () => {
    const result = parseWatchFile("whatever.yml", `id: custom\n${VALID_YAML}`);
    expect(result.ok && result.watch.id).toBe("custom");
  });

  it("rejects a malformed repo slug", () => {
    const result = parseWatchFile("bad.yaml", VALID_YAML.replace("upstream/thing", "notaslug"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/repo/);
  });

  it("rejects an unknown condition kind", () => {
    const result = parseWatchFile("bad.yaml", VALID_YAML.replace("pr_merged", "pr_reviewed"));
    expect(result.ok).toBe(false);
  });

  it("rejects a tag_matches that will not compile", () => {
    const yaml = `
target:
  repo: test-org/fleet-infra
  issue: 913
conditions:
  - kind: release
    repo: upstream/thing
    tag_matches: "([unclosed"
`;
    const result = parseWatchFile("bad.yaml", yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/tag_matches/);
  });

  it("rejects invalid YAML", () => {
    const result = parseWatchFile("bad.yaml", "target: [unclosed\n");
    expect(result.ok).toBe(false);
  });

  it("rejects a published_after date that rolls over to a different day", () => {
    const yaml = `
target:
  repo: test-org/fleet-infra
  issue: 913
conditions:
  - kind: release
    repo: upstream/thing
    published_after: "2026-02-30"
`;
    const result = parseWatchFile("bad.yaml", yaml);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/published_after/);
  });
});

describe("evaluateCondition — pr_merged", () => {
  beforeEach(() => vi.clearAllMocks());

  const cond = { kind: "pr_merged", repo: "upstream/thing", number: 2715 } as const;

  it("is met when the PR is merged", async () => {
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: true, mergedAt: "2026-09-01T10:00:00Z",
      title: "feat: OIDC", url: "https://github.com/upstream/thing/pull/2715",
      updatedAt: "2026-09-01T10:00:00Z",
    });
    const result = await evaluateCondition(cond);
    expect(result.met).toBe(true);
    expect(result.dead).toBeUndefined();
    expect(result.summary).toContain("merged 2026-09-01");
  });

  it("is unmet while the PR is still open", async () => {
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "open", merged: false, mergedAt: null,
      title: "feat: OIDC", url: "https://github.com/upstream/thing/pull/2715",
      updatedAt: "2026-08-20T10:00:00Z",
    });
    const result = await evaluateCondition(cond);
    expect(result.met).toBe(false);
    expect(result.dead).toBeUndefined();
    expect(result.summary).toContain("still open");
  });

  it("is dead when the PR was closed unmerged", async () => {
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: false, mergedAt: null,
      title: "feat: OIDC", url: "https://github.com/upstream/thing/pull/2715",
      updatedAt: "2026-08-20T10:00:00Z",
    });
    const result = await evaluateCondition(cond);
    expect(result.met).toBe(false);
    expect(result.dead).toBe(true);
  });

  it("is unmet (not dead) when the PR does not exist", async () => {
    mockGh.getUpstreamPRStatus.mockResolvedValue(null);
    const result = await evaluateCondition(cond);
    expect(result.met).toBe(false);
    expect(result.dead).toBeUndefined();
    expect(result.summary).toContain("not found");
  });
});

describe("evaluateCondition — issue_closed", () => {
  beforeEach(() => vi.clearAllMocks());

  const cond = { kind: "issue_closed", repo: "upstream/thing", number: 42 } as const;

  it("is met when the issue is closed", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "completed" });
    const result = await evaluateCondition(cond);
    expect(result.met).toBe(true);
    expect(result.summary).toContain("closed");
  });

  it("is unmet while the issue is open", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null });
    const result = await evaluateCondition(cond);
    expect(result.met).toBe(false);
    expect(result.dead).toBeUndefined();
  });

  it("degrades to unmet (not dead) instead of throwing when the upstream issue is missing", async () => {
    mockGh.getIssueState.mockRejectedValue(new Error("gh: Could not resolve to an Issue (HTTP 404)"));
    const result = await evaluateCondition(cond);
    expect(result.met).toBe(false);
    expect(result.dead).toBeUndefined();
    expect(result.summary).toContain("not found");
  });

  it("rethrows a non-404 failure", async () => {
    mockGh.getIssueState.mockRejectedValue(new Error("network error"));
    await expect(evaluateCondition(cond)).rejects.toThrow("network error");
  });
});

describe("evaluateCondition — release", () => {
  beforeEach(() => vi.clearAllMocks());

  const release = (over: Record<string, unknown> = {}) => ({
    tag: "v2.1.0", name: "v2.1.0", publishedAt: "2026-09-10T00:00:00Z",
    prerelease: false, draft: false, url: "https://github.com/upstream/thing/releases/v2.1.0",
    ...over,
  });

  it("ignores prereleases unless include_prereleases is set", async () => {
    mockGh.listReleases.mockResolvedValue([release({ prerelease: true })]);
    const unmet = await evaluateCondition({ kind: "release", repo: "upstream/thing" });
    expect(unmet.met).toBe(false);

    const met = await evaluateCondition({ kind: "release", repo: "upstream/thing", include_prereleases: true });
    expect(met.met).toBe(true);
  });

  it("ignores drafts even with include_prereleases", async () => {
    mockGh.listReleases.mockResolvedValue([release({ draft: true })]);
    const result = await evaluateCondition({ kind: "release", repo: "upstream/thing", include_prereleases: true });
    expect(result.met).toBe(false);
  });

  it("requires publication strictly after published_after", async () => {
    mockGh.listReleases.mockResolvedValue([release({ publishedAt: "2026-08-25T00:00:00Z" })]);
    const onBoundary = await evaluateCondition({
      kind: "release", repo: "upstream/thing", published_after: "2026-08-25",
    });
    expect(onBoundary.met).toBe(false);

    mockGh.listReleases.mockResolvedValue([release({ publishedAt: "2026-08-26T00:00:00Z" })]);
    const after = await evaluateCondition({
      kind: "release", repo: "upstream/thing", published_after: "2026-08-25",
    });
    expect(after.met).toBe(true);
    expect(after.summary).toContain("**v2.1.0**");
  });

  it("applies tag_matches", async () => {
    mockGh.listReleases.mockResolvedValue([release({ tag: "nightly-2026-09-10" })]);
    const result = await evaluateCondition({ kind: "release", repo: "upstream/thing", tag_matches: "^v\\d" });
    expect(result.met).toBe(false);
  });
});

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.hasUpstreamWatchFired.mockReturnValue(false);
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null });
    mockGh.removeLabel.mockResolvedValue(true);
    mockGh.addLabel.mockResolvedValue(undefined);
    mockGh.commentOnIssue.mockResolvedValue(undefined);
    mockGh.listReleases.mockResolvedValue([]);
  });

  it("makes no GitHub calls for a watch already recorded as fired", async () => {
    mockDb.hasUpstreamWatchFired.mockReturnValue(true);
    stageWatchFile("seerr.yaml", VALID_YAML);

    await run();

    expect(mockGh.getIssueState).not.toHaveBeenCalled();
    expect(mockGh.getUpstreamPRStatus).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it("skips a watch whose target issue is closed without recording a fire", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: "completed" });
    stageWatchFile("seerr.yaml", VALID_YAML);

    await run();

    expect(mockGh.getUpstreamPRStatus).not.toHaveBeenCalled();
    expect(mockDb.recordUpstreamWatchFired).not.toHaveBeenCalled();
  });

  it("posts nothing while conditions are unmet", async () => {
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "open", merged: false, mergedAt: null, title: "feat: OIDC",
      url: "u", updatedAt: "2026-08-20T00:00:00Z",
    });
    stageWatchFile("seerr.yaml", VALID_YAML);

    await run();

    expect(mockGh.removeLabel).not.toHaveBeenCalled();
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockDb.recordUpstreamWatchFired).not.toHaveBeenCalled();
  });

  it("unblocks the issue when every condition is met", async () => {
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: true, mergedAt: "2026-09-01T00:00:00Z",
      title: "feat: OIDC", url: "https://github.com/upstream/thing/pull/2715",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    stageWatchFile("seerr.yaml", VALID_YAML);

    await run();

    expect(mockGh.removeLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Blocked");
    expect(mockGh.removeLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Claws Ignore");
    expect(mockGh.addLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Ready");
    expect(mockGh.commentOnIssue).toHaveBeenCalledWith(
      "test-org/fleet-infra", 913, expect.stringContaining("Blocked"),
      { agentName: "upstream-watcher" },
    );
    expect(mockDb.recordUpstreamWatchFired).toHaveBeenCalledWith("seerr", "test-org/fleet-infra", 913);

    // Ordering: labels first, comment next, record last.
    const removeOrder = mockGh.removeLabel.mock.invocationCallOrder[0]!;
    const addOrder = mockGh.addLabel.mock.invocationCallOrder[0]!;
    const commentOrder = mockGh.commentOnIssue.mock.invocationCallOrder[0]!;
    const recordOrder = mockDb.recordUpstreamWatchFired.mock.invocationCallOrder[0]!;
    expect(removeOrder).toBeLessThan(addOrder);
    expect(addOrder).toBeLessThan(commentOrder);
    expect(commentOrder).toBeLessThan(recordOrder);
  });

  it("does not add Ready, comment, or record a fire when label removal cannot be confirmed", async () => {
    mockGh.removeLabel.mockResolvedValue(false);
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: true, mergedAt: "2026-09-01T00:00:00Z",
      title: "feat: OIDC", url: "https://github.com/upstream/thing/pull/2715",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    stageWatchFile("seerr.yaml", VALID_YAML);

    await run();

    expect(mockGh.removeLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Blocked");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockDb.recordUpstreamWatchFired).not.toHaveBeenCalled();
  });

  it("does not add Ready, comment, or record a fire when only the second (legacy) label removal fails", async () => {
    mockGh.removeLabel.mockImplementation(async (_repo: string, _issue: number, label: string) => label !== "Claws Ignore");
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: true, mergedAt: "2026-09-01T00:00:00Z",
      title: "feat: OIDC", url: "https://github.com/upstream/thing/pull/2715",
      updatedAt: "2026-09-01T00:00:00Z",
    });
    stageWatchFile("seerr.yaml", VALID_YAML);

    await run();

    expect(mockGh.removeLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Blocked");
    expect(mockGh.removeLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Claws Ignore");
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockDb.recordUpstreamWatchFired).not.toHaveBeenCalled();
  });

  it("fires on one of two conditions when require is any", async () => {
    const yaml = `
require: any
target:
  repo: test-org/fleet-infra
  issue: 913
conditions:
  - kind: pr_merged
    repo: upstream/thing
    number: 2715
  - kind: issue_closed
    repo: upstream/thing
    number: 42
`;
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "open", merged: false, mergedAt: null, title: "feat: OIDC",
      url: "u", updatedAt: "2026-08-20T00:00:00Z",
    });
    mockGh.getIssueState.mockImplementation(async (repo: string) =>
      repo === "upstream/thing" ? { state: "CLOSED", stateReason: "completed" } : { state: "OPEN", stateReason: null },
    );
    stageWatchFile("seerr.yaml", yaml);

    await run();

    expect(mockGh.addLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Ready");
    expect(mockDb.recordUpstreamWatchFired).toHaveBeenCalled();
  });

  it("fires on require: any when one condition is dead but another is already met", async () => {
    const yaml = `
require: any
target:
  repo: test-org/fleet-infra
  issue: 913
conditions:
  - kind: pr_merged
    repo: upstream/thing
    number: 2715
  - kind: issue_closed
    repo: upstream/thing
    number: 42
`;
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: false, mergedAt: null, title: "feat: OIDC",
      url: "u", updatedAt: "2026-08-20T00:00:00Z",
    });
    mockGh.getIssueState.mockImplementation(async (repo: string) =>
      repo === "upstream/thing" ? { state: "CLOSED", stateReason: "completed" } : { state: "OPEN", stateReason: null },
    );
    stageWatchFile("seerr.yaml", yaml);

    await run();

    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
    expect(mockGh.addLabel).toHaveBeenCalledWith("test-org/fleet-infra", 913, "Ready");
    expect(mockDb.recordUpstreamWatchFired).toHaveBeenCalled();
  });

  it("raises a dead-watch alert on require: any only when every condition is dead", async () => {
    const yaml = `
require: any
target:
  repo: test-org/fleet-infra
  issue: 913
conditions:
  - kind: pr_merged
    repo: upstream/thing
    number: 2715
  - kind: pr_merged
    repo: upstream/other
    number: 7
`;
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: false, mergedAt: null, title: "feat: OIDC",
      url: "u", updatedAt: "2026-08-20T00:00:00Z",
    });
    stageWatchFile("seerr.yaml", yaml);

    await run();

    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({ title: '[upstream-watcher] Watch "seerr" can never fire' }),
    );
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockDb.recordUpstreamWatchFired).not.toHaveBeenCalled();
  });

  it("raises a dead-watch alert instead of firing when a PR was closed unmerged", async () => {
    mockGh.getUpstreamPRStatus.mockResolvedValue({
      state: "closed", merged: false, mergedAt: null, title: "feat: OIDC",
      url: "u", updatedAt: "2026-08-20T00:00:00Z",
    });
    stageWatchFile("seerr.yaml", VALID_YAML);

    await run();

    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "test-org/claws",
        title: '[upstream-watcher] Watch "seerr" can never fire',
      }),
    );
    expect(mockGh.addLabel).not.toHaveBeenCalled();
    expect(mockDb.recordUpstreamWatchFired).not.toHaveBeenCalled();
  });

  it("raises the malformed-file alert and skips the bad file", async () => {
    stageWatchFile("bad.yaml", "target: {}\n");

    await run();

    expect(mockOccurrence.upsertAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "[upstream-watcher] Malformed files in docs/upstream-watches/",
        body: expect.stringContaining("`bad.yaml`"),
      }),
    );
    expect(mockOccurrence.closeAlertIssueIfResolved).not.toHaveBeenCalled();
  });

  it("closes the malformed-file alert when every file parses", async () => {
    stageWatchFile("seerr.yaml", VALID_YAML);
    mockGh.getUpstreamPRStatus.mockResolvedValue(null);

    await run();

    expect(mockOccurrence.closeAlertIssueIfResolved).toHaveBeenCalledWith(
      expect.objectContaining({ title: "[upstream-watcher] Malformed files in docs/upstream-watches/" }),
    );
  });

  it("ignores non-YAML entries such as README.md", async () => {
    mockGh.listRepoDirectory.mockResolvedValue([
      { name: "README.md", path: "docs/upstream-watches/README.md", sha: "a", type: "file" },
    ]);

    await run();

    expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalled();
    expect(mockOccurrence.upsertAlertIssue).not.toHaveBeenCalled();
  });

  it("reports a per-watch failure without aborting the sweep", async () => {
    mockGh.listRepoDirectory.mockResolvedValue([
      { name: "a.yaml", path: "docs/upstream-watches/a.yaml", sha: "a", type: "file" },
      { name: "b.yaml", path: "docs/upstream-watches/b.yaml", sha: "b", type: "file" },
    ]);
    mockGh.fetchRepoFileContent.mockResolvedValue(VALID_YAML);
    mockGh.getUpstreamPRStatus
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(null);

    await run();

    expect(reportError).toHaveBeenCalledWith("upstream-watcher:process-watch", "test-org/claws", expect.any(Error));
    expect(mockGh.getUpstreamPRStatus).toHaveBeenCalledTimes(2);
  });
});

describe("buildUnblockComment", () => {
  const watch: Watch = {
    id: "seerr-oidc-stable",
    target: { repo: "test-org/fleet-infra", issue: 913 },
    require: "all",
    conditions: [{ kind: "pr_merged", repo: "upstream/thing", number: 2715 }],
    note: "Check the release actually contains the OIDC work.",
  };

  it("lists every condition summary, the note, and the manifest path", () => {
    const body = buildUnblockComment(watch, [{ met: true, summary: "`upstream/thing#2715` merged" }], "seerr-oidc-stable.yaml");
    expect(body).toContain("removed `Blocked` and added `Ready`");
    expect(body).toContain("`upstream/thing#2715` merged");
    expect(body).toContain("Check the release actually contains the OIDC work.");
    expect(body).toContain("docs/upstream-watches/seerr-oidc-stable.yaml");
  });

  it("names the actual watch filename, not the id, when they diverge", () => {
    const body = buildUnblockComment(
      { ...watch, id: "custom-id" },
      [{ met: true, summary: "`upstream/thing#2715` merged" }],
      "renamed-file.yaml",
    );
    expect(body).toContain("docs/upstream-watches/renamed-file.yaml");
    expect(body).not.toContain("docs/upstream-watches/custom-id.yaml");
  });
});

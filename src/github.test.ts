import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockRegisterDiscoveredForgejoRepos, mockIsRepoMonitored, mockGetRepoConfig, mockForgejoRepos, mockForgejo, mockClawsIssues, mockIsActive, mockIsStagingPipelineEnabled, mockShouldRunWorkPipeline, mockIsJobDisabledForRepo } = vi.hoisted(() => ({
  mockRegisterDiscoveredForgejoRepos: vi.fn((_names: readonly string[]) => {}),
  mockIsActive: vi.fn(() => true),
  mockIsStagingPipelineEnabled: vi.fn(() => false),
  mockShouldRunWorkPipeline: vi.fn(() => true),
  mockIsJobDisabledForRepo: vi.fn((_job: string, _repo: string) => false),
  mockIsRepoMonitored: vi.fn((_fullName: string) => true),
  mockGetRepoConfig: vi.fn((_fullName: string): { mergeWithoutChecks: boolean } | null => null),
  // FORGEJO_REPOS is imported as a live binding, so tests mutate this array
  // in place rather than reassigning it.
  mockForgejoRepos: [] as string[],
  // Native issues are the third backend behind the façade; these tests exist to
  // prove a `clw_…` ref never reaches Forgejo.
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    toIso: (s: string) => s,
    listOpenIssues: vi.fn(async () => [] as any[]),
    listIssuesByLabel: vi.fn(async () => [] as any[]),
    listClosedIssuesSince: vi.fn(async () => [] as any[]),
    listDuplicateIssuesOf: vi.fn(async () => [] as any[]),
    getIssue: vi.fn(async () => undefined as any),
    getIssueTitleBody: vi.fn(async () => ({ title: "native", body: "native body" })),
    getIssueBody: vi.fn(async () => "native body"),
    getIssueBodyHtml: vi.fn(async () => "<p>native body</p>"),
    getIssueState: vi.fn(async () => ({ state: "OPEN", stateReason: null, labels: [] as string[] })),
    getIssueComments: vi.fn(async () => [] as any[]),
    listAttachments: vi.fn(async () => [{ name: "shot.png", url: "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/attachments/cla_01JBQ7X4M2K8NV3TYRW9GZ5PDD/shot.png" }]),
    getCommentReactions: vi.fn(async () => [] as any[]),
    addLabel: vi.fn(async () => {}),
    blockIssue: vi.fn(async (_repo: string, _ref: string, _reason: string) => {}),
    removeLabel: vi.fn(async () => true),
    commentOnIssue: vi.fn(async (_repo: string, _ref: string, _body: string, _login: string) => "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC"),
    editIssue: vi.fn(async () => {}),
    editIssueTitle: vi.fn(async () => {}),
    editIssueComment: vi.fn(async (_ref: string, _body: string) => {}),
    closeIssue: vi.fn(async () => {}),
    addReaction: vi.fn(async () => {}),
    createIssue: vi.fn(async () => "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC"),
  },
  mockForgejo: {
    listRepoDirectory: vi.fn(),
    carriedForwardCheckStatus: vi.fn(),
    getRepo: vi.fn(),
    listActionRunsForSha: vi.fn(),
    rerunFailedJobsByIndex: vi.fn(),
    listOpenIssues: vi.fn(),
    createPR: vi.fn(),
    mergePR: vi.fn(),
    invalidatePRList: vi.fn(),
    listPRs: vi.fn(),
    getPRChecksSummary: vi.fn(),
    getPRMergeableState: vi.fn(),
    getPRChangedFiles: vi.fn(),
    getPRDiff: vi.fn(async (_repo: string, _n: number) => ""),
    listPRChecks: vi.fn(async (_repo: string, _n: number) => [] as any[]),
    getCommitCommittedAt: vi.fn(async (_repo: string, _sha: string) => null as string | null),
    listPRsCrossReferencingIssue: vi.fn(),
    listDuplicateIssuesOf: vi.fn(),
    listRecentlyMergedPRs: vi.fn(),
    searchClosedPulls: vi.fn(async (_repo: string, _query: string) => [] as any[]),
    listRecentlyClosedUnmergedPRs: vi.fn(),
    getUpstreamPRStatus: vi.fn(),
    listReleases: vi.fn(),
    listBranchesByPrefix: vi.fn(),
    createBranchRef: vi.fn(),
    forgejoSelfLogin: vi.fn(),
    forgejoReadSelfLogin: vi.fn(),
    listAccessibleRepos: vi.fn(),
    isConfigured: vi.fn(() => true),
    isMissing: vi.fn((err: any) => err?.status === 404 || err?.status === 403),
    listWaitingRunJobRows: vi.fn(),
    listWaitingRunJobLabels: vi.fn(),
    listActionRunners: vi.fn(),
    listIssuesByLabel: vi.fn(),
    getIssueTitleBody: vi.fn(),
    getIssueBody: vi.fn(),
    getIssueBodyHtml: vi.fn(),
    getIssueState: vi.fn(),
    getPRMergeGate: vi.fn(),
    getIssueComments: vi.fn(),
    getIssueAttachments: vi.fn(),
    listRecentlyClosedIssues: vi.fn(),
    addLabel: vi.fn(),
    removeLabel: vi.fn(),
    editIssue: vi.fn(),
    editIssueTitle: vi.fn(),
    closeIssue: vi.fn(),
    commentOnIssue: vi.fn(),
    editIssueComment: vi.fn(),
    addReaction: vi.fn(),
    getCommentReactions: vi.fn(),
    downloadReleaseAssets: vi.fn(),
    getOpenPRForIssue: vi.fn(),
    listMergedPRsForIssue: vi.fn(),
  },
}));

vi.mock("./forgejo.js", () => mockForgejo);
vi.mock("./claws-issues.js", () => mockClawsIssues);

// Only what `imported-refs.ts` needs: `github.ts` itself imports `db.js` for a
// type alone, so this keeps the real (heavy) module out of the graph while the
// alias index underneath stays real.
//
// Behind a Proxy, so the day something in the graph reaches for another `db`
// export the failure names the missing stub instead of surfacing as
// "x is not a function" from an unrelated test in a 7k-line suite.
vi.mock("./db.js", () => {
  const stubs: Record<string, unknown> = {
    // Resolves true: the linkage row names the id the caller passed, which
    // is what `recordImport` needs before it indexes the pair.
    recordImportedIssue: vi.fn(async () => true),
    listImportedIssues: vi.fn(async () => []),
    // The PR state store (src/pr-state.ts): no row, so the label hook is a no-op.
    getClawsPr: vi.fn(async () => null),
    upsertClawsPr: vi.fn(async () => undefined),
    listClawsPrs: vi.fn(async () => []),
    // blockIssue's forge path: the shadow that holds the reason.
    getLinkedNativeId: vi.fn(async () => undefined),
    setShadowLifecycle: vi.fn(async () => true),
    setIssueBlockedReason: vi.fn(async () => undefined),
    BlockedReasonRequiredError: class extends Error {
      constructor() { super("A reason is required to mark an issue Blocked"); }
    },
  };
  return new Proxy(stubs, {
    get(target, prop) {
      if (typeof prop !== "string" || prop in target) return target[prop as string];
      // Vitest and the ESM interop probe for these on every module namespace.
      if (prop === "then" || prop === "default" || prop === "__esModule") return undefined;
      throw new Error(`db.${prop} is not stubbed in github.test.ts — add it to the vi.mock("./db.js") factory`);
    },
  });
});

vi.mock("./config.js", () => {
  return {
    issueUrl: (repo: string, n: unknown) => `https://github.com/${repo}/issues/${String(n)}`,
    LABELS: {
      refined: "Refined",
      ready: "Ready",
      priority: "Priority",
      blocked: "Blocked",
      backlog: "Backlog",
      clawsIgnore: "Claws Ignore",
      clawsStaging: "Claws Staging",
      problematic: "Claws Problematic",
      needsLgtm: "Needs LGTM",
      billing: "Billing",
      automerge: "Automerge",
    },
    LABEL_SPECS: {
      "Refined": { color: "0075ca", description: "Issue is ready for claws to implement" },
      "Ready": { color: "0e8a16", description: "Claws has finished — needs human attention" },
      "Priority": { color: "006b75", description: "High-priority — processed first in all Claws queues" },
    },
    SELF_REPO: "test-org/test-repo",
    ALLOWED_ACTORS: ["stjohnb"],
    SKIPPED_ITEMS: [],
    PRIORITIZED_ITEMS: [],
    // The identity predicates are pure leaf functions; the real ones are what
    // the routing under test is written against.
    isClawsIssueId,
    isClawsCommentId,
    DASHBOARD_URL: "https://claws.example.invalid",
    FORGEJO_REPOS: mockForgejoRepos,
    registerDiscoveredForgejoRepos: mockRegisterDiscoveredForgejoRepos,
    writeConfig: vi.fn(),
    isActive: mockIsActive,
    isStagingPipelineEnabled: mockIsStagingPipelineEnabled,
    shouldRunWorkPipeline: mockShouldRunWorkPipeline,
    isJobDisabledForRepo: mockIsJobDisabledForRepo,
    getIncidentLabels: () => ["grafana-alert", "sev1"],
  };
});

vi.mock("./repo-config.js", () => ({
  refreshRepoConfigs: vi.fn(),
  isRepoMonitored: mockIsRepoMonitored,
  getRepoConfig: mockGetRepoConfig,
  getRepoConfigState: vi.fn(() => "present"),
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("./error-reporter.js", () => ({
  reportError: vi.fn(),
}));

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
}));

import { isClawsIssueId, isClawsCommentId } from "./issue-id.js";
import { reportError } from "./error-reporter.js";

import {
  downloadReleaseAssets,
  listRepos,
  isRepoListDegraded,
  clearRepoCache,
  listOpenIssues,
  findIssueByExactTitle,
  createIssue,
  createPR,
  PRLabelError,
  listIssuesByLabel,
  listPRChecks,
  findLatestFailedRun,
  isRunOnCommit,
  rerunFailedJobsForSession,
  commentOnIssue,
  getIssueComments,
  editIssueComment,
  addLabel,
  isRefAlreadyGone,
  CLAWS_VISIBLE_HEADER,
  isClawsComment,
  stripClawsMarker,
  clearApiCache,
  listPRs,
  listPRStatuses,
  getOpenPRForIssue,
  listOpenPRsForIssue,
  populateQueueCache,
  populateQueueCacheFor,
  getQueueSnapshot,
  clearQueueCache,
  setMergeBlockReason,
  getMergeBlockReason,
  isItemSkipped,
  isItemPrioritized,
  hasPriorityLabel,
  hasBlockedLabel,
  hasBacklogLabel,
  hasStagingLabel,
  isParked,
  isDispatchSkippable,
  dispatchSkipReason,
  issueDispatchSkipReason,
  isIssueDispatchSkippable,
  awaitingImportReason,
  freshDispatchNote,
  removeQueueItem,
  reconcileQueueCache,
  skipItem,
  addReaction,
  getCommentReactions,
  isForkPR,
  listMergedPRsForIssue,
  listRecentlyClosedIssues,
  listRecentlyMergedPRs,
  listRecentlyClosedUnmergedPRs,
  getPRMergeableState,
  getPRMergeGate,
  mergePR,
  isAllowedActor,
  isAllowedHumanActor,
  isCiAlertBotAuthor,
  isDependencyBotAuthor,
  listStableReleaseTags,
  fetchQueuedWorkflowRuns,
  fetchQueuedJobsForRun,
  isInfraPath,
  infraPathsIn,
  getTofuPlanEvidence,
  isInfrastructureOutage,
  describeSteplessJobs,
  isPreRepoStepFailure,
  removeLabel,
  blockIssue,
  getUpstreamPRStatus,
  listReleases,
  listPRsCrossReferencingIssue,
  listDuplicateIssuesOf,
  createBranchRef,
  getLatestStableReleaseTag,
  fetchSelfHostedRunners,
  listBranchesByPrefix,
  carriedForwardCheckStatus,
  repoExpectsCi,
  clearRepoExpectsCiCache,
  CLAWS_STAGING_PR_MARKER,
  getIssueTitleBody,
  getIssueBody,
  getIssueBodyHtml,
  getIssueState,
  getIssueAttachments,
  editIssue,
  editIssueTitle,
  closeIssue,
  getSelfLoginForIssue,
} from "./github.js";
import { recordImport, resetImportedRefsForTest } from "./imported-refs.js";
import type { RunJobSummary } from "./github.js";
import * as db from "./db.js";

describe("listRepos", () => {
  const accessible = (name: string, defaultBranch = "main") => ({
    owner: "test-owner",
    name,
    fullName: `test-owner/${name}`,
    defaultBranch,
    isPrivate: true,
  });

  beforeEach(() => {
    mockForgejoRepos.length = 0;
    mockForgejo.getRepo.mockReset();
    mockForgejo.listAccessibleRepos.mockReset();
    mockForgejo.listAccessibleRepos.mockResolvedValue([]);
    mockForgejo.isConfigured.mockReturnValue(true);
    mockRegisterDiscoveredForgejoRepos.mockReset();
    mockIsRepoMonitored.mockReset();
    mockIsRepoMonitored.mockReturnValue(true);
    clearRepoCache();
  });

  it("returns only Forgejo repos and never enumerates GitHub installations", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("repo1"), accessible("repo2", "trunk")]);

    const repos = await listRepos();
    expect(repos).toEqual([
      { owner: "test-owner", name: "repo1", fullName: "test-owner/repo1", defaultBranch: "main", forge: "forgejo" },
      { owner: "test-owner", name: "repo2", fullName: "test-owner/repo2", defaultBranch: "trunk", forge: "forgejo" },
    ]);
    expect(isRepoListDegraded()).toBe(false);
  });

  it("appends CLAWS_FORGEJO_REPOS entries, flagged with forge: forgejo (#2650)", async () => {
    mockForgejoRepos.push("test-owner/migrated");
    mockForgejo.getRepo.mockResolvedValue({
      owner: "test-owner",
      name: "migrated",
      fullName: "test-owner/migrated",
      defaultBranch: "trunk",
    });

    const repos = await listRepos();
    expect(repos).toEqual([
      { owner: "test-owner", name: "migrated", fullName: "test-owner/migrated", defaultBranch: "trunk", forge: "forgejo" },
    ]);
  });

  it("skips a Forgejo repo whose metadata fetch fails and no cache entry exists (#2650)", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("found")]);
    mockForgejoRepos.push("test-owner/migrated");
    mockForgejo.getRepo.mockRejectedValue(new Error("HTTP 401"));

    const repos = await listRepos();
    expect(repos.map((r) => r.fullName)).toEqual(["test-owner/found"]);
    expect(isRepoListDegraded()).toBe(true);
  });

  it("reuses the previous cache entry when a Forgejo repo's metadata fetch fails (#2650)", async () => {
    mockForgejoRepos.push("test-owner/migrated");
    mockForgejo.getRepo.mockResolvedValue({
      owner: "test-owner",
      name: "migrated",
      fullName: "test-owner/migrated",
      defaultBranch: "trunk",
    });
    await listRepos();

    // Expire the 5-minute repo cache, then fail the Forgejo fetch.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      mockForgejo.getRepo.mockRejectedValue(new Error("ECONNREFUSED"));
      const repos = await listRepos();
      expect(repos).toContainEqual({
        owner: "test-owner",
        name: "migrated",
        fullName: "test-owner/migrated",
        defaultBranch: "trunk",
        forge: "forgejo",
      });
    } finally {
      Date.now = realNow;
    }
  });

  it("discovers Forgejo repos from the bot's accessible repos and registers them (#2885)", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("found", "forgejo")]);

    const repos = await listRepos();
    expect(repos).toEqual([
      { owner: "test-owner", name: "found", fullName: "test-owner/found", defaultBranch: "forgejo", forge: "forgejo" },
    ]);
    expect(mockRegisterDiscoveredForgejoRepos).toHaveBeenCalledWith(["test-owner/found"]);
    expect(mockForgejo.getRepo).not.toHaveBeenCalled();
  });

  it("lists a repo once when it is both discovered and in forgejoRepos (#2885)", async () => {
    mockForgejoRepos.push("test-owner/Migrated");
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("migrated")]);

    const repos = await listRepos();
    expect(repos.map((r) => r.fullName)).toEqual(["test-owner/migrated"]);
    expect(mockForgejo.getRepo).not.toHaveBeenCalled();
  });

  it("falls back to the cached Forgejo repos when enumeration fails (#2885)", async () => {
    vi.mocked(reportError).mockClear();
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("found", "forgejo")]);
    await listRepos();

    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      mockRegisterDiscoveredForgejoRepos.mockClear();
      mockForgejo.listAccessibleRepos.mockRejectedValue(new Error("ECONNREFUSED"));

      const repos = await listRepos();
      expect(vi.mocked(reportError)).toHaveBeenCalledWith("github:list-repos-forgejo", "discovery", expect.any(Error));
      expect(repos).toContainEqual({
        owner: "test-owner",
        name: "found",
        fullName: "test-owner/found",
        defaultBranch: "forgejo",
        forge: "forgejo",
      });
      expect(isRepoListDegraded()).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  it("marks the list degraded only when Forgejo enumeration fails, and clears it on recovery", async () => {
    mockForgejoRepos.push("test-owner/migrated");
    mockForgejo.getRepo.mockResolvedValue({
      owner: "test-owner",
      name: "migrated",
      fullName: "test-owner/migrated",
      defaultBranch: "main",
    });
    mockForgejo.listAccessibleRepos.mockRejectedValue(new Error("503"));
    const repos = await listRepos();
    expect(repos.map((r) => r.fullName)).toEqual(["test-owner/migrated"]);
    expect(isRepoListDegraded()).toBe(true);

    const realNow = Date.now;
    Date.now = () => realNow() + 61 * 1000;
    try {
      mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("found", "forgejo")]);
      await listRepos();
      expect(isRepoListDegraded()).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });

  it("does not register an empty set when enumeration fails with no cache (#2885)", async () => {
    mockForgejo.listAccessibleRepos.mockRejectedValue(new Error("ECONNREFUSED"));

    await listRepos();
    expect(mockRegisterDiscoveredForgejoRepos).not.toHaveBeenCalled();
  });

  it("drops a repo with no claws.json but keeps its siblings (#2885)", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("opted-in"), accessible("no-file")]);
    mockIsRepoMonitored.mockImplementation((fullName: string) => fullName !== "test-owner/no-file");

    const repos = await listRepos();
    expect(repos.map((r) => r.fullName)).toEqual(["test-owner/opted-in"]);
  });

  it("returns no repos without reporting an error when no Forgejo token is configured (#2670)", async () => {
    vi.mocked(reportError).mockClear();
    mockForgejoRepos.push("test-owner/migrated");
    mockForgejo.isConfigured.mockReturnValue(false);

    const repos = await listRepos();
    expect(repos).toEqual([]);
    expect(mockForgejo.getRepo).not.toHaveBeenCalled();
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
    expect(isRepoListDegraded()).toBe(false);
  });

  it("does not report an error for a listed Forgejo repo the bot cannot see (#2921)", async () => {
    vi.mocked(reportError).mockClear();
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("found")]);
    mockForgejoRepos.push("test-owner/exclusion-only");
    mockForgejo.getRepo.mockRejectedValue(
      Object.assign(new Error("forgejo GET /repos/test-owner/exclusion-only failed: HTTP 404"), { status: 404 }),
    );

    const repos = await listRepos();
    expect(repos.map((r) => r.fullName)).toEqual(["test-owner/found"]);
    expect(vi.mocked(reportError)).not.toHaveBeenCalled();
    expect(isRepoListDegraded()).toBe(false);
  });

  it("does not resurrect a stale cache entry for a Forgejo repo that became invisible (#2921)", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([accessible("found")]);
    mockForgejoRepos.push("test-owner/exclusion-only");
    mockForgejo.getRepo.mockResolvedValue({
      owner: "test-owner",
      name: "exclusion-only",
      fullName: "test-owner/exclusion-only",
      defaultBranch: "trunk",
    });
    await listRepos();

    vi.mocked(reportError).mockClear();

    // Expire the 5-minute repo cache, then make the repo invisible to the bot.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      mockForgejo.getRepo.mockRejectedValue(
        Object.assign(new Error("forgejo GET /repos/test-owner/exclusion-only failed: HTTP 404"), { status: 404 }),
      );
      const repos = await listRepos();
      expect(repos.map((r) => r.fullName)).not.toContain("test-owner/exclusion-only");
      expect(vi.mocked(reportError)).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });
});

describe("Forgejo routing", () => {
  beforeEach(() => {
    mockForgejo.listOpenIssues.mockReset();
    mockForgejo.createPR.mockReset();
    mockForgejo.mergePR.mockReset();
    mockForgejo.listPRs.mockReset();
    mockForgejo.getPRChecksSummary.mockReset();
    mockForgejo.getPRMergeableState.mockReset();
    mockForgejo.getPRChangedFiles.mockReset();
    mockForgejo.listPRsCrossReferencingIssue.mockReset();
    mockForgejo.listDuplicateIssuesOf.mockReset();
    mockForgejo.listRecentlyMergedPRs.mockReset();
    mockForgejo.searchClosedPulls.mockReset();
    mockForgejo.searchClosedPulls.mockResolvedValue([]);
    mockForgejo.listRecentlyClosedUnmergedPRs.mockReset();
    mockForgejo.getUpstreamPRStatus.mockReset();
    mockForgejo.listReleases.mockReset();
    mockForgejo.createBranchRef.mockReset();
    mockForgejo.forgejoSelfLogin.mockReset();
    mockForgejo.listWaitingRunJobRows.mockReset();
    mockForgejo.listWaitingRunJobLabels.mockReset();
    mockForgejo.listActionRunners.mockReset();
    clearApiCache();
  });


  it("delegates listOpenIssues/createPR/mergePR to the Forgejo client", async () => {
    mockForgejo.listOpenIssues.mockResolvedValue([]);
    mockForgejo.createPR.mockResolvedValue(7);
    mockForgejo.mergePR.mockResolvedValue(undefined);

    await listOpenIssues("org/forge");
    expect(await createPR("org/forge", "branch", "title", "body")).toBe(7);
    await mergePR("org/forge", 7, "abc123");

    expect(mockForgejo.listOpenIssues).toHaveBeenCalledWith("org/forge", undefined);
    expect(mockForgejo.createPR).toHaveBeenCalledWith("org/forge", "branch", "title", "body", []);
    expect(mockForgejo.mergePR).toHaveBeenCalledWith("org/forge", 7, "abc123");
  });

  it("forwards a dashboard page's staleOk to the Forgejo client", async () => {
    mockForgejo.listOpenIssues.mockResolvedValue([]);
    mockForgejo.listPRs.mockResolvedValue([]);

    await listOpenIssues("org/forge", { staleOk: true });
    await listPRs("org/forge", { staleOk: true });

    expect(mockForgejo.listOpenIssues).toHaveBeenCalledWith("org/forge", { staleOk: true });
    expect(mockForgejo.listPRs).toHaveBeenCalledWith("org/forge", { staleOk: true });
  });

  it("builds listPRStatuses from Forgejo calls", async () => {
    mockForgejo.listPRs.mockResolvedValue([{ number: 4 }, { number: 9 }]);
    mockForgejo.getPRChecksSummary.mockImplementation(async (_r: string, n: number) =>
      n === 4 ? { status: "passing", passed: 2, total: 2 } : { status: "failing", passed: 0, total: 1 },
    );
    mockForgejo.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockForgejo.getPRChangedFiles.mockResolvedValue(["src/index.ts"]);

    const statuses = await listPRStatuses("org/forge");

    expect(statuses.get(4)).toMatchObject({ checkStatus: "passing", checksPassed: 2, checksTotal: 2, mergeableState: "MERGEABLE" });
    expect(statuses.get(9)).toMatchObject({ checkStatus: "failing", checksTotal: 1 });
    expect(statuses.get(4)?.infraPaths).toBeUndefined();
  });

  it("reports infra paths in listPRStatuses for a Forgejo PR, and the head its plan evidence was read for", async () => {
    mockForgejo.listPRs.mockResolvedValue([{ number: 4, headRefOid: "abc1234def" }]);
    mockForgejo.getPRChecksSummary.mockResolvedValue({ status: "pending", passed: 0, total: 1 });
    mockForgejo.getPRMergeableState.mockResolvedValue("UNKNOWN");
    mockForgejo.getPRChangedFiles.mockResolvedValue(["tofu/main.tf", "README.md"]);

    const status = (await listPRStatuses("org/forge")).get(4);
    expect(status?.infraPaths).toEqual(["tofu/main.tf"]);
    expect(status?.tofuPlanHeadSha).toBe("abc1234def");
  });

  it("says whether a Forgejo infra PR's diff is a provider bump", async () => {
    mockForgejo.listPRs.mockResolvedValue([{ number: 4 }, { number: 5 }]);
    mockForgejo.getPRChecksSummary.mockResolvedValue({ status: "passing", passed: 1, total: 1 });
    mockForgejo.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockForgejo.getPRChangedFiles.mockImplementation(async (_r: string, n: number) =>
      n === 4 ? ["tofu/versions.tf"] : ["tofu/main.tf"]);
    mockForgejo.getPRDiff.mockImplementation(async (_r: string, n: number) => n === 4
      ? "diff --git a/tofu/versions.tf b/tofu/versions.tf\n@@ -1 +1 @@\n-  version = \"1.69.0\"\n+  version = \"1.70.0\"\n"
      : "diff --git a/tofu/main.tf b/tofu/main.tf\n@@ -1 +1 @@\n-  size = 1\n+  size = 2\n");
    mockForgejo.getIssueComments.mockResolvedValue([]);

    const statuses = await listPRStatuses("org/forge");
    expect(statuses.get(4)).toMatchObject({ infraBumpEligible: true });
    expect(statuses.get(4)?.infraBumpHoldReason).toBeUndefined();
    expect(statuses.get(5)).toMatchObject({ infraBumpEligible: false, infraBumpHoldReason: "non-comment change in tofu/main.tf" });
  });

  it("keeps one failing PR from dropping the rest out of listPRStatuses", async () => {
    mockForgejo.listPRs.mockResolvedValue([{ number: 4 }, { number: 9 }]);
    mockForgejo.getPRChecksSummary.mockImplementation(async (_r: string, n: number) => {
      if (n === 4) throw new Error("HTTP 500");
      return { status: "passing", passed: 1, total: 1 };
    });
    mockForgejo.getPRMergeableState.mockResolvedValue("MERGEABLE");
    mockForgejo.getPRChangedFiles.mockResolvedValue([]);

    const statuses = await listPRStatuses("org/forge");

    expect(statuses.has(4)).toBe(false);
    expect(statuses.get(9)).toMatchObject({ checkStatus: "passing" });
  });

  it("routes listPRsCrossReferencingIssue away from the GitHub issue timeline", async () => {
    mockForgejo.listPRsCrossReferencingIssue.mockResolvedValue([]);

    expect(await listPRsCrossReferencingIssue("org/forge", 12)).toEqual([]);
    expect(mockForgejo.listPRsCrossReferencingIssue).toHaveBeenCalledWith("org/forge", 12);
  });

  // forgejo.getOpenPRForIssue is `prs.find(...)` and returns at most one PR, so
  // routing through it hid a sibling parallel-phase PR (review of #3374).
  // listOpenPRsForIssue must filter the full open-PR list by branch prefix
  // instead, matching the GitHub path.
  it("returns every open branch PR on Forgejo, not just the first match", async () => {
    mockForgejo.listPRs.mockResolvedValue([
      { number: 4, title: "PR 1 (1/2)", headRefName: "claws/issue-12-aaaa", baseRefName: "main", labels: [], author: { login: "bot" } },
      { number: 9, title: "PR 2 (2/2)", headRefName: "claws/issue-12-bbbb", baseRefName: "main", labels: [], author: { login: "bot" } },
      { number: 15, title: "Unrelated", headRefName: "claws/issue-99-cccc", baseRefName: "main", labels: [], author: { login: "bot" } },
    ]);

    const prs = await listOpenPRsForIssue("org/forge", 12);

    expect(prs.map((p) => p.number).sort()).toEqual([4, 9]);
  });

  it("routes listDuplicateIssuesOf to the Forgejo client", async () => {
    mockForgejo.listDuplicateIssuesOf.mockResolvedValue([{ number: 3, title: "dupe", body: "", labels: [], author: { login: "someone" } }]);

    expect(await listDuplicateIssuesOf("org/forge", 2)).toHaveLength(1);
    expect(mockForgejo.listDuplicateIssuesOf).toHaveBeenCalledWith("org/forge", 2);
  });

  // doc-maintainer reads closed issues AND merged/rejected PRs for every repo it processes.
  it("delegates the doc-maintainer PR history reads to Forgejo", async () => {
    mockForgejo.listRecentlyMergedPRs.mockResolvedValue([]);
    mockForgejo.listRecentlyClosedUnmergedPRs.mockResolvedValue([]);

    expect(await listRecentlyMergedPRs("org/forge", null, 20)).toEqual([]);
    expect(await listRecentlyClosedUnmergedPRs("org/forge", null, 20)).toEqual([]);
    expect(mockForgejo.listRecentlyMergedPRs).toHaveBeenCalledWith("org/forge", null, 20);
    expect(mockForgejo.listRecentlyClosedUnmergedPRs).toHaveBeenCalledWith("org/forge", null, 20);
  });

  it("routes getUpstreamPRStatus, listReleases and createBranchRef to Forgejo", async () => {
    mockForgejo.getUpstreamPRStatus.mockResolvedValue(null);
    mockForgejo.listReleases.mockResolvedValue([]);
    mockForgejo.createBranchRef.mockResolvedValue(undefined);

    expect(await getUpstreamPRStatus("org/forge", 3)).toBeNull();
    expect(await listReleases("org/forge")).toEqual([]);
    await createBranchRef("org/forge", "new", "main");

    expect(mockForgejo.createBranchRef).toHaveBeenCalledWith("org/forge", "new", "main");
  });

  it("derives the stable release helpers from forgejo.listReleases", async () => {
    mockForgejo.listReleases.mockResolvedValue([
      { tag: "v2.0.0-rc1", name: "", publishedAt: null, prerelease: true, draft: false, url: "" },
      { tag: "v1.9.0", name: "", publishedAt: null, prerelease: false, draft: false, url: "" },
      { tag: "v1.8.0", name: "", publishedAt: null, prerelease: false, draft: false, url: "" },
    ]);

    expect(await getLatestStableReleaseTag("org/forge")).toBe("v1.9.0");
    expect(await listStableReleaseTags("org/forge")).toEqual(["v1.9.0", "v1.8.0"]);
  });

  it("routes listBranchesByPrefix to Forgejo for a Forgejo repo", async () => {
    mockForgejo.listBranchesByPrefix.mockResolvedValue([{ name: "claws/preview-issue-17", sha: "abc" }]);
    expect(await listBranchesByPrefix("org/forge", "claws/preview-issue-")).toEqual([{ name: "claws/preview-issue-17", sha: "abc" }]);
    expect(mockForgejo.listBranchesByPrefix).toHaveBeenCalledWith("org/forge", "claws/preview-issue-");
  });

  // mac-runner-waker's queued-run/job/runner reads are the one exception to
  // "run history is GitHub-only": for a Forgejo repo they delegate to forgejo.ts,
  // which uses the org-owner admin token read-only rather than `gh api` (#3099).
  it("routes fetchQueuedWorkflowRuns, fetchQueuedJobsForRun and fetchSelfHostedRunners to Forgejo instead of asserting GitHub-only", async () => {
    const row = {
      run_id: 5,
      repo: "org/forge",
      workflow_name: "ios-build",
      status: "waiting",
      conclusion: null,
      event: "",
      head_branch: null,
      created_at: "2026-01-01T00:00:00.000Z",
      run_started_at: null,
      updated_at: "2026-01-01T00:00:00.000Z",
      head_sha: null,
      html_url: null,
      run_attempt: null,
    };
    mockForgejo.listWaitingRunJobRows.mockResolvedValue([row]);
    mockForgejo.listWaitingRunJobLabels.mockResolvedValue([{ name: "ios-build", labels: ["self-hosted", "macos"] }]);
    mockForgejo.listActionRunners.mockResolvedValue([{ name: "MPB3", status: "online", labels: ["macos"] }]);

    expect(await fetchQueuedWorkflowRuns("org/forge")).toEqual([row]);
    expect(await fetchQueuedJobsForRun("org/forge", 5)).toEqual([{ name: "ios-build", labels: ["self-hosted", "macos"] }]);
    expect(await fetchSelfHostedRunners("org/forge")).toEqual([{ name: "MPB3", status: "online", labels: ["macos"] }]);

    expect(mockForgejo.listWaitingRunJobRows).toHaveBeenCalledWith("org/forge");
    expect(mockForgejo.listWaitingRunJobLabels).toHaveBeenCalledWith("org/forge", 5);
    expect(mockForgejo.listActionRunners).toHaveBeenCalledWith("org/forge");
  });

  it("resolves isAllowedActor against the Forgejo self-login when a repo is given", async () => {
    mockForgejo.forgejoSelfLogin.mockResolvedValue("claws-forgejo");

    expect(await isAllowedActor("claws-forgejo", "org/forge")).toBe(true);
  });

});

describe("downloadReleaseAssets Forgejo routing", () => {
  beforeEach(() => {
    mockForgejo.downloadReleaseAssets.mockReset();
    mockForgejo.downloadReleaseAssets.mockResolvedValue(undefined);
  });

  it("delegates to forgejo.downloadReleaseAssets for the \"*\" pattern", async () => {
    await downloadReleaseAssets("org/forge", "v1", "*", "/tmp/dest");
    expect(mockForgejo.downloadReleaseAssets).toHaveBeenCalledWith("org/forge", "v1", "/tmp/dest");
  });

  it("rejects any other pattern for a Forgejo repo", async () => {
    await expect(downloadReleaseAssets("org/forge", "v1", "*.dmg", "/tmp/dest")).rejects.toThrow(/unsupported for Forgejo/);
    expect(mockForgejo.downloadReleaseAssets).not.toHaveBeenCalled();
  });
});

describe("blockIssue", () => {
  const SHADOW = "clw_01JBQ7X4M2K8NV3TYRW9GZ5SHD";

  beforeEach(() => {
    vi.clearAllMocks();
  });


  it("moves a native issue with its reason in one write", async () => {
    await blockIssue("org/repo", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "Waiting on the vendor");

    expect(mockClawsIssues.blockIssue).toHaveBeenCalledWith("org/repo", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", "Waiting on the vendor");
    expect(mockForgejo.addLabel).not.toHaveBeenCalled();
  });

  it("labels a forge issue, then records the stage and trimmed reason on its shadow", async () => {
    vi.mocked(db.getLinkedNativeId).mockResolvedValueOnce(SHADOW);

    await blockIssue("forgejo-org/repo", 7, " Waiting on the vendor ");

    expect(mockForgejo.addLabel).toHaveBeenCalledWith("forgejo-org/repo", 7, "Blocked");
    expect(db.setShadowLifecycle).toHaveBeenCalledWith(SHADOW, "blocked");
    expect(db.setIssueBlockedReason).toHaveBeenCalledWith(SHADOW, "Waiting on the vendor");
  });

  it("refuses a forge issue with a blank reason before labelling it", async () => {
    await expect(blockIssue("forgejo-org/repo", 7, "  ")).rejects.toThrow("A reason is required");
    expect(mockForgejo.addLabel).not.toHaveBeenCalled();
  });
});

describe("createIssue", () => {

  afterEach(() => {
    // Reset here, not at the end of the test body: an assertion that fails
    // mid-test would otherwise leave a later test believing the repo is a
    // Forgejo one.
  });

  it("files natively, as claws, associated with exactly the named repo", async () => {
    const ref = await createIssue("org/repo", "title", "body", ["bug"]);

    expect(ref).toBe("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith({
      title: "title",
      body: "body",
      authorLogin: "claws",
      repos: ["org/repo"],
      labels: ["bug"],
      source: "automation",
    });
  });

  it("passes a caller's source through", async () => {
    await createIssue("org/repo", "title", "body", [], { source: "whatsapp" });
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ source: "whatsapp" }));
  });

  it("passes a Blocked reason through", async () => {
    await createIssue("org/repo", "title", "body", ["Blocked"], { blockedReason: "A person must look" });
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ labels: ["Blocked"], blockedReason: "A person must look" }));
  });

  it("files natively without asking the forge for the repo", async () => {
    const ref = await createIssue("forgejo-org/repo", "title", "body", []);

    expect(ref).toBe("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC");
    expect(mockClawsIssues.createIssue).toHaveBeenCalled();
    expect(mockForgejo.getRepo).not.toHaveBeenCalled();
  });
});

describe("session re-runs of failed CI (#clw_01M4DQW4N7DJT8WHTCSV3NBZSD)", () => {
  beforeEach(() => {
    clearApiCache();
  });

  it("delegates to the Forgejo run number", async () => {
    mockForgejo.listActionRunsForSha.mockResolvedValue([
      { id: 11, index: 5, workflowId: "ci.yml", status: "success", created: "2026-10-08T11:00:00Z" },
      { id: 10, index: 4, workflowId: "ci.yml", status: "failure", created: "2026-10-08T10:00:00Z" },
    ]);
    mockForgejo.rerunFailedJobsByIndex.mockResolvedValue({ run: { index: 4, status: "waiting" }, jobs: [{ index: 1, name: "publish" }] });
    expect(await findLatestFailedRun("o/r", "abc")).toBe(4);
    expect(await isRunOnCommit("o/r", 4, "abc")).toBe(true);
    expect(await isRunOnCommit("o/r", 9, "abc")).toBe(false);
    expect(await rerunFailedJobsForSession("o/r", 4)).toEqual({ run: 4, jobs: ["publish"] });
    expect(mockForgejo.rerunFailedJobsByIndex).toHaveBeenCalledWith("o/r", 4);
  });
});

describe("repoExpectsCi", () => {
  const entry = (path: string) => ({ name: path.split("/").pop()!, path, sha: "s", type: "file" });

  beforeEach(() => {
    clearRepoExpectsCiCache();
    mockGetRepoConfig.mockReset();
    mockGetRepoConfig.mockReturnValue(null);
    mockForgejo.listRepoDirectory.mockReset();
  });


  it("is true when .forgejo/workflows holds a .yml file", async () => {
    mockForgejo.listRepoDirectory.mockImplementation(async (_repo: string, dir: string) =>
      dir === ".forgejo/workflows" ? [entry(".forgejo/workflows/ci.yml")] : []);
    expect(await repoExpectsCi("org/repo")).toBe(true);
  });

  it("is false when both workflow directories are empty or hold no YAML", async () => {
    mockForgejo.listRepoDirectory.mockImplementation(async (_repo: string, dir: string) =>
      dir === ".github/workflows" ? [entry(".github/workflows/README.md")] : []);
    expect(await repoExpectsCi("org/repo")).toBe(false);
  });

  it("is false when claws.json sets mergeWithoutChecks, without listing workflows", async () => {
    mockGetRepoConfig.mockReturnValue({ mergeWithoutChecks: true });
    expect(await repoExpectsCi("org/repo")).toBe(false);
    expect(mockForgejo.listRepoDirectory).not.toHaveBeenCalled();
  });

  it("fails closed to true when the listing throws, and does not cache that answer", async () => {
    mockForgejo.listRepoDirectory.mockRejectedValueOnce(new Error("boom"));
    expect(await repoExpectsCi("org/repo")).toBe(true);
    mockForgejo.listRepoDirectory.mockResolvedValue([]);
    expect(await repoExpectsCi("org/repo")).toBe(false);
  });

  it("caches a successful answer", async () => {
    mockForgejo.listRepoDirectory.mockResolvedValue([entry(".forgejo/workflows/ci.yaml")]);
    expect(await repoExpectsCi("org/repo")).toBe(true);
    mockForgejo.listRepoDirectory.mockResolvedValue([]);
    expect(await repoExpectsCi("org/repo")).toBe(true);
  });
});

describe("describeSteplessJobs", () => {
  const job = (overrides: Partial<RunJobSummary>): RunJobSummary =>
    ({ id: 1, name: "build", status: "completed", conclusion: "failure", stepCount: 0, failedSteps: [], ...overrides });

  it("returns an empty string when no failed job is stepless", () => {
    expect(describeSteplessJobs([])).toBe("");
    expect(describeSteplessJobs([job({ stepCount: 6 }), job({ conclusion: "success" })])).toBe("");
  });

  it("names the job, duration, runner and labels", () => {
    expect(describeSteplessJobs([
      job({ name: "image-consistency", stepCount: 6 }),
      job({
        name: "migration-exec-secrets",
        runnerName: "nas",
        labels: ["self-hosted", "linux"],
        startedAt: "2026-10-03T00:50:00Z",
        completedAt: "2026-10-03T01:00:00Z",
      }),
    ])).toBe('job "migration-exec-secrets" produced no logs: 0 steps, failure after 10 min on self-hosted runner "nas" [self-hosted, linux]');
  });

  it("calls container and host family jobs self-hosted", () => {
    expect(describeSteplessJobs([job({ runnerName: "nas", labels: ["container", "linux"] })]))
      .toBe('job "build" produced no logs: 0 steps, failure on self-hosted runner "nas" [container, linux]');
    expect(describeSteplessJobs([job({ runnerName: "tempo", labels: ["host", "macos", "tempo"] })]))
      .toBe('job "build" produced no logs: 0 steps, failure on self-hosted runner "tempo" [host, macos, tempo]');
    expect(describeSteplessJobs([job({ runnerName: "x", labels: ["linux"] })]))
      .toBe('job "build" produced no logs: 0 steps, failure on runner "x" [linux]');
  });

  it("omits the runner clause when no runner was assigned", () => {
    expect(describeSteplessJobs([
      job({ name: "deploy", conclusion: "cancelled", runnerName: null }),
      job({ name: "smoke", runnerName: "" }),
    ])).toBe('job "deploy" produced no logs: 0 steps, cancelled; job "smoke" produced no logs: 0 steps, failure');
  });
});

describe("findIssueByExactTitle", () => {
  beforeEach(() => {
    clearApiCache();
  });

  it("matches a retitled native issue by its filed title, lowest id first", async () => {
    mockForgejo.listOpenIssues.mockResolvedValue([]);
    const native = (number: string, title: string, filedTitle?: string) => ({ number, title, body: "", labels: [], author: { login: "claws" }, filedTitle });
    mockClawsIssues.listOpenIssues.mockResolvedValue([
      native("clw_B", "Speed up Renovate", "Build failure: Renovate"),
      native("clw_A", "Fix Renovate token", "Build failure: Renovate"),
    ]);

    const result = await findIssueByExactTitle("org/retitled-repo", "Build failure: Renovate");
    expect(result).toEqual({ number: "clw_A", title: "Fix Renovate token", labels: [] });
    mockClawsIssues.listOpenIssues.mockResolvedValue([]);
  });

});

describe("repo cache", () => {
  const repoEntry = {
    owner: "test-owner",
    name: "repo1",
    fullName: "test-owner/repo1",
    defaultBranch: "main",
    isPrivate: true,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mockIsRepoMonitored.mockReturnValue(true);
    mockForgejoRepos.length = 0;
    mockForgejo.isConfigured.mockReturnValue(true);
    mockForgejo.listAccessibleRepos.mockReset();
    mockForgejo.listAccessibleRepos.mockResolvedValue([]);
    mockRegisterDiscoveredForgejoRepos.mockReset();
    clearRepoCache();
  });

  afterEach(() => {
    // Unconditional: a mid-test assertion failure must not leak an open
    // breaker into the describes that follow.
    vi.useRealTimers();
  });

  it("returns cached repos within TTL without a second discovery call", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([repoEntry]);

    const first = await listRepos();
    expect(first).toHaveLength(1);
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(1);

    const second = await listRepos();
    expect(second).toHaveLength(1);
    // Still only 1 call — served from cache
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after TTL expires", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([repoEntry]);

    await listRepos();
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(1);

    // Advance past the 5-minute TTL
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    await listRepos();
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent listRepos calls", async () => {
    mockForgejo.listAccessibleRepos.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([repoEntry]), 100)),
    );

    // Fire two concurrent calls
    const p1 = listRepos();
    const p2 = listRepos();

    await vi.advanceTimersByTimeAsync(100);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
    // Only one fetch despite two concurrent calls
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(1);
  });

  it("returns stale cache when fetch returns empty", async () => {
    // First call succeeds
    mockForgejo.listAccessibleRepos.mockResolvedValueOnce([repoEntry]);
    const first = await listRepos();
    expect(first).toHaveLength(1);

    // Expire the cache
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    mockForgejo.listAccessibleRepos.mockResolvedValueOnce([]);

    const second = await listRepos();
    // Returns stale cache instead of empty
    expect(second).toHaveLength(1);
    expect(second[0].fullName).toBe("test-owner/repo1");
  });

  it("clearRepoCache forces a fresh fetch", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValue([repoEntry]);

    await listRepos();
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(1);

    clearRepoCache();

    await listRepos();
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(2);
  });

  it("retries after the short degraded TTL when Forgejo enumeration fails", async () => {
    mockForgejo.listAccessibleRepos.mockResolvedValueOnce([repoEntry]);
    await listRepos();

    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    mockForgejo.listAccessibleRepos.mockRejectedValueOnce(new Error("HTTP 503"));
    const degraded = await listRepos();
    expect(degraded.map((r) => r.fullName)).toEqual(["test-owner/repo1"]);
    expect(isRepoListDegraded()).toBe(true);
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(60 * 1000 + 1);

    mockForgejo.listAccessibleRepos.mockResolvedValueOnce([repoEntry]);
    await listRepos();
    expect(mockForgejo.listAccessibleRepos).toHaveBeenCalledTimes(3);
    expect(isRepoListDegraded()).toBe(false);
  });
});

describe("getPRMergeGate", () => {
  beforeEach(() => {
    clearApiCache();
  });

  it("reads the PR's live merge gate from Forgejo", async () => {
    const forgejoGate = { state: "OPEN", headSha: "f00d", labels: [], mergeable: "MERGEABLE", checkStatus: "passing", checksTotal: 1 };
    mockForgejo.getPRMergeGate.mockResolvedValueOnce(forgejoGate);
    try {
      expect(await getPRMergeGate("org/forgejo-repo", 27)).toEqual(forgejoGate);
      expect(mockForgejo.getPRMergeGate).toHaveBeenCalledWith("org/forgejo-repo", 27);
    } finally {
    }
  });
});

describe("isInfraPath / infraPathsIn", () => {
  it("matches tofu/terraform paths", () => {
    for (const p of [
      "tofu/main.tf",
      "infrastructure/tofu/vpc.tf",
      "terraform/x.tf",
      "a/b.tfvars",
      "a/b.tf.json",
      ".terraform.lock.hcl",
      ".github/workflows/tofu-apply.yml",
      ".github/actions/tofu-plan-with-retry/action.yml",
      ".forgejo/workflows/tofu-apply.yml",
      ".forgejo/workflows/tofu-plan-on-pr.yml",
      ".forgejo/actions/tofu-plan-with-retry/action.yml",
      ".forgejo/workflows/Terraform-Drift.yml",
    ]) {
      expect(isInfraPath(p)).toBe(true);
    }
  });

  it("does not match non-infra paths", () => {
    for (const p of [
      "apps/namey/deployment.yaml",
      "docs/OVERVIEW.md",
      "src/tofu-helper.ts",
      "scripts/kind-helm-render.sh",
      ".forgejo/workflows/ci.yml",
      ".forgejo/workflows/image-cve-scan.yml",
    ]) {
      expect(isInfraPath(p)).toBe(false);
    }
  });

  it("filters a changed-file list down to the infra subset", () => {
    expect(infraPathsIn(["tofu/main.tf", "docs/OVERVIEW.md", "terraform/x.tf"])).toEqual([
      "tofu/main.tf",
      "terraform/x.tf",
    ]);
  });
});

describe("getTofuPlanEvidence", () => {
  const HEAD = "abc1234def5678";

  beforeEach(() => {
    clearApiCache();
  });

  describe("from Forgejo plan evidence", () => {
    const COUNTS_NOOP = "<!-- tofu-plan -->\n**0 to add, 0 to change, 0 to replace, 0 to destroy.**";
    const forgeComment = (over: Record<string, unknown> = {}) => ({
      id: 1, body: COUNTS_NOOP, body_html: "", login: "brendan", updatedAt: "2026-10-19T09:10:00Z", ...over,
    });
    const planCheck = (state = "SUCCESS", outcome = "passing") => ({ name: "Tofu Plan / plan (pull_request)", state, outcome, link: "" });

    beforeEach(() => {
      mockForgejo.getIssueComments.mockReset();
      mockForgejo.getIssueComments.mockResolvedValue([forgeComment()]);
      mockForgejo.getCommitCommittedAt.mockReset();
      mockForgejo.getCommitCommittedAt.mockResolvedValue("2026-10-19T09:00:00Z");
      mockForgejo.listPRChecks.mockReset();
      mockForgejo.listPRChecks.mockResolvedValue([{ name: "CI / test (pull_request)", state: "SUCCESS", outcome: "passing", link: "" }, planCheck()]);
    });


    it("accepts a user-token plan comment newer than the head commit with a passing Tofu Plan check", async () => {
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toEqual({
        plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "noop", detail: "no-op plan",
      });
      expect(mockForgejo.getCommitCommittedAt).toHaveBeenCalledWith("org/forge", HEAD);
    });

    it("reads the comment with the newest updatedAt", async () => {
      mockForgejo.getIssueComments.mockResolvedValue([
        forgeComment({ updatedAt: "2026-10-19T09:30:00Z" }),
        forgeComment({ id: 2, body: "<!-- tofu-plan -->\n**1 to add, 0 to change, 0 to replace, 0 to destroy.**", updatedAt: "2026-10-19T08:00:00Z" }),
      ]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toMatchObject({ state: "noop" });
    });

    it("is unavailable when the plan comment predates the head commit, keeping the counts", async () => {
      mockForgejo.getIssueComments.mockResolvedValue([forgeComment({ updatedAt: "2026-10-19T08:59:59Z" })]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toEqual({
        plan: { add: 0, change: 0, replace: 0, destroy: 0 }, state: "unavailable", detail: "plan comment predates the head commit",
      });
    });

    it("is unavailable when the Tofu Plan check failed", async () => {
      mockForgejo.listPRChecks.mockResolvedValue([planCheck("FAILURE", "failing")]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toMatchObject({ state: "unavailable", detail: "Tofu Plan check is failure" });
    });

    it("is unavailable when any Tofu Plan check is still pending", async () => {
      mockForgejo.listPRChecks.mockResolvedValue([planCheck(), { ...planCheck("PENDING", "pending"), name: "Tofu Plan / plan-bootstrap (pull_request)" }]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toMatchObject({ state: "unavailable", detail: "Tofu Plan check is pending" });
    });

    it("is unavailable when the head has no Tofu Plan check", async () => {
      mockForgejo.listPRChecks.mockResolvedValue([{ name: "CI / test (pull_request)", state: "SUCCESS", outcome: "passing", link: "" }]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toMatchObject({ state: "unavailable", detail: "no Tofu Plan check on this head" });
    });

    it("is unavailable with no plan comment or an unparseable one", async () => {
      mockForgejo.getIssueComments.mockResolvedValue([forgeComment({ body: "LGTM" })]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toMatchObject({ state: "unavailable", detail: "no plan comment" });
      clearApiCache();
      mockForgejo.getIssueComments.mockResolvedValue([forgeComment({ body: "<!-- tofu-plan -->\nplan failed" })]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toMatchObject({ state: "unavailable", detail: "plan comment is not parseable" });
    });

    it("is unavailable when the head commit date is unknown", async () => {
      mockForgejo.getCommitCommittedAt.mockResolvedValue(null);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toMatchObject({ state: "unavailable", detail: "head commit date unknown" });
    });

    it("reports changes for a plan with a replace", async () => {
      mockForgejo.getIssueComments.mockResolvedValue([forgeComment({ body: "<!-- tofu-plan -->\n**0 to add, 0 to change, 1 to replace, 0 to destroy.**" })]);
      expect(await getTofuPlanEvidence("org/forge", 121, HEAD)).toEqual({
        plan: { add: 0, change: 0, replace: 1, destroy: 0 }, state: "changes", detail: "plan shows 1 change",
      });
    });
  });
});

describe("isClawsComment", () => {
  it("returns true when body contains the visible header", () => {
    expect(isClawsComment(`${CLAWS_VISIBLE_HEADER}\n\nSome response`)).toBe(true);
  });

  it("returns true when body contains the agent-name visible header", () => {
    expect(isClawsComment("*— Automated by Claws · Planner —*\n\nSome response")).toBe(true);
  });

  it("returns true for legacy HTML marker (backward compat)", () => {
    expect(isClawsComment("Some response\n<!-- claws-automated -->")).toBe(true);
  });

  it("returns false when body does not contain the marker", () => {
    expect(isClawsComment("A normal comment")).toBe(false);
  });
});

describe("stripClawsMarker", () => {
  it("strips visible header", () => {
    const body = `${CLAWS_VISIBLE_HEADER}\n\nPlan content`;
    expect(stripClawsMarker(body)).toBe("Plan content");
  });

  it("strips legacy HTML comment marker", () => {
    const body = `Plan content\n<!-- claws-automated -->`;
    expect(stripClawsMarker(body)).toBe("Plan content");
  });

  it("returns body unchanged when no markers present", () => {
    expect(stripClawsMarker("Just text")).toBe("Just text");
  });

  it("strips agent-aware visible header", () => {
    const body = `*— Automated by Claws · Planner —*\n\nPlan content`;
    expect(stripClawsMarker(body)).toBe("Plan content");
  });

  it("strips agent-aware visible header with multi-word agent name", () => {
    const body = `*— Automated by Claws · Review Addresser —*\n\nContent`;
    expect(stripClawsMarker(body)).toBe("Content");
  });
});

describe("isItemSkipped / isItemPrioritized", () => {
  it("isItemSkipped returns false when SKIPPED_ITEMS is empty", () => {
    expect(isItemSkipped("org/repo", 1)).toBe(false);
  });

  it("isItemSkipped returns true when item is in SKIPPED_ITEMS", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [{ repo: "org/repo", number: 42 }];
    try {
      expect(isItemSkipped("org/repo", 42)).toBe(true);
      expect(isItemSkipped("org/repo", 43)).toBe(false);
      expect(isItemSkipped("org/other", 42)).toBe(false);
    } finally {
      (configMod as Record<string, unknown>).SKIPPED_ITEMS = [];
    }
  });

  it("isItemPrioritized returns false when PRIORITIZED_ITEMS is empty", () => {
    expect(isItemPrioritized("org/repo", 1)).toBe(false);
  });

  it("isItemPrioritized returns true when item is in PRIORITIZED_ITEMS", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [{ repo: "org/repo", number: 7 }];
    try {
      expect(isItemPrioritized("org/repo", 7)).toBe(true);
      expect(isItemPrioritized("org/repo", 8)).toBe(false);
    } finally {
      (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [];
    }
  });
});

describe("populateQueueCache skip/priority integration", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("skips items in the skip list", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [{ repo: "org/repo", number: 5 }];
    try {
      populateQueueCache("refined", "org/repo", { number: 5, title: "Skipped", type: "issue" });
      const snap = getQueueSnapshot(["refined"]);
      expect(snap.items).toHaveLength(0);
    } finally {
      (configMod as Record<string, unknown>).SKIPPED_ITEMS = [];
    }
  });

  it("marks prioritized items", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [{ repo: "org/repo", number: 3 }];
    try {
      populateQueueCache("refined", "org/repo", { number: 3, title: "Prioritized", type: "issue" });
      populateQueueCache("refined", "org/repo", { number: 4, title: "Normal", type: "issue" });
      const snap = getQueueSnapshot(["refined"]);
      expect(snap.items).toHaveLength(2);
      expect(snap.items[0].number).toBe(3);
      expect(snap.items[0].prioritized).toBe(true);
      expect(snap.items[1].prioritized).toBeFalsy();
    } finally {
      (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [];
    }
  });
});

describe("merge-block reasons (#2971)", () => {
  beforeEach(() => {
    clearQueueCache();
    setMergeBlockReason("org/repo", 7, null);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores, clears and expires a reason", () => {
    vi.useFakeTimers();
    setMergeBlockReason("org/repo", 7, "CI is failing.");
    expect(getMergeBlockReason("org/repo", 7)).toBe("CI is failing.");
    setMergeBlockReason("org/repo", 7, null);
    expect(getMergeBlockReason("org/repo", 7)).toBeUndefined();

    setMergeBlockReason("org/repo", 7, "CI is failing.");
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    expect(getMergeBlockReason("org/repo", 7)).toBeUndefined();
  });

  it("stamps the reason onto PR queue items only", () => {
    setMergeBlockReason("org/repo", 7, "CI is failing.");
    populateQueueCache("ready", "org/repo", { number: 7, title: "PR", type: "pr" });
    populateQueueCache("ready", "org/other", { number: 7, title: "Issue", type: "issue" });
    const snap = getQueueSnapshot(["ready"]);
    expect(snap.items.find((i) => i.repo === "org/repo")?.mergeBlockReason).toBe("CI is failing.");
    expect(snap.items.find((i) => i.repo === "org/other")?.mergeBlockReason).toBeUndefined();
  });
});

describe("populateQueueCacheFor", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("derives priority and label names from a raw item", () => {
    populateQueueCacheFor("refined", "org/repo", {
      number: 42,
      title: "X",
      updatedAt: "2026-06-22T00:00:00Z",
      labels: [{ name: "Priority" }, { name: "bug" }],
    }, "issue");
    const snap = getQueueSnapshot(["refined"]);
    const item = snap.items.find((i) => i.number === 42);
    expect(item?.type).toBe("issue");
    expect(item?.labels).toEqual(["Priority", "bug"]);
    expect(item?.prioritized).toBe(true);
  });

  it("sets prioritized false when no priority label", () => {
    populateQueueCacheFor("refined", "org/repo", {
      number: 43,
      title: "Y",
      updatedAt: "2026-06-22T00:00:00Z",
      labels: [{ name: "bug" }],
    }, "pr");
    const snap = getQueueSnapshot(["refined"]);
    const item = snap.items.find((i) => i.number === 43);
    expect(item?.type).toBe("pr");
    expect(item?.prioritized).toBeFalsy();
  });
});

describe("removeQueueItem", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("removes all cache entries for a given repo:number", () => {
    populateQueueCache("refined", "org/repo", { number: 10, title: "A", type: "issue" });
    populateQueueCache("needs-refinement", "org/repo", { number: 10, title: "A", type: "issue" });
    populateQueueCache("refined", "org/repo", { number: 11, title: "B", type: "issue" });

    removeQueueItem("org/repo", 10);

    const snap = getQueueSnapshot(["refined", "needs-refinement"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].number).toBe(11);
  });
});

describe("reconcileQueueCache", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("evicts items not in keep set", () => {
    populateQueueCache("needs-refinement", "org/repo", { number: 5, title: "A", type: "issue" });
    populateQueueCache("ready", "org/repo", { number: 6, title: "B", type: "issue" });

    reconcileQueueCache("org/repo", ["needs-refinement", "ready"], new Set([6]), "issue");

    const snap = getQueueSnapshot(["needs-refinement", "ready"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].number).toBe(6);
  });

  it("scopes eviction by type, leaving pr entries untouched", () => {
    populateQueueCache("ready", "org/repo", { number: 7, title: "Issue", type: "issue" });
    populateQueueCache("ready", "org/repo", { number: 8, title: "PR", type: "pr" });

    reconcileQueueCache("org/repo", ["ready"], new Set(), "issue");

    const snap = getQueueSnapshot(["ready"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].number).toBe(8);
  });

  it("scopes eviction by category, leaving other categories untouched", () => {
    populateQueueCache("refined", "org/repo", { number: 9, title: "A", type: "issue" });
    populateQueueCache("needs-triage", "org/repo", { number: 10, title: "B", type: "issue" });

    reconcileQueueCache("org/repo", ["refined"], new Set(), "issue");

    const snap = getQueueSnapshot(["needs-triage"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].number).toBe(10);
  });

  it("is a no-op when all numbers are in keep", () => {
    populateQueueCache("refined", "org/repo", { number: 1, title: "A", type: "issue" });
    populateQueueCache("refined", "org/repo", { number: 2, title: "B", type: "issue" });

    reconcileQueueCache("org/repo", ["refined"], new Set([1, 2]), "issue");

    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items).toHaveLength(2);
  });
});

describe("populateQueueCache category transitions", () => {
  beforeEach(() => { clearQueueCache(); });

  it("replaces the old-category entry when an item transitions category", () => {
    populateQueueCache("needs-refinement", "org/repo", { number: 42, title: "T", type: "issue", updatedAt: "2025-01-01T00:00:00Z" });
    populateQueueCache("refined", "org/repo", { number: 42, title: "T", type: "issue", updatedAt: "2025-01-02T00:00:00Z" });

    const snap = getQueueSnapshot(["needs-refinement", "refined"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].category).toBe("refined");
  });

  it("leaves entries for other (repo, number) pairs untouched", () => {
    populateQueueCache("needs-refinement", "org/repo", { number: 1, title: "A", type: "issue" });
    populateQueueCache("refined", "org/repo", { number: 2, title: "B", type: "issue" });
    populateQueueCache("refined", "org/repo", { number: 1, title: "A", type: "issue" });

    const snap = getQueueSnapshot(["needs-refinement", "refined"]);
    expect(snap.items).toHaveLength(2);
    expect(snap.items.find(i => i.number === 1)?.category).toBe("refined");
    expect(snap.items.find(i => i.number === 2)?.category).toBe("refined");
  });

  it("persists labels in the snapshot", () => {
    populateQueueCache("needs-refinement", "org/repo", { number: 5, title: "T", type: "issue", labels: ["Refined", "Priority"] });
    const snap = getQueueSnapshot(["needs-refinement"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].labels).toEqual(["Refined", "Priority"]);
  });
});

describe("getQueueSnapshot TTL eviction", () => {
  beforeEach(() => { clearQueueCache(); });

  it("drops entries older than QUEUE_ENTRY_TTL_MS", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      populateQueueCache("refined", "org/repo", { number: 1, title: "Stale", type: "issue" });
      vi.setSystemTime(new Date("2025-01-01T00:21:00Z")); // 21 min later — past 20 min TTL
      populateQueueCache("refined", "org/repo", { number: 2, title: "Fresh", type: "issue" });
      const snap = getQueueSnapshot(["refined"]);
      expect(snap.items).toHaveLength(1);
      expect(snap.items[0].number).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("oldestFetchAt reflects only returned items, not stale ones under other categories", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
      populateQueueCache("refined", "org/repo", { number: 1, title: "A", type: "issue" });
      vi.setSystemTime(new Date("2025-01-01T00:10:00Z"));
      populateQueueCache("needs-triage", "org/repo", { number: 2, title: "B", type: "issue" });
      const snap = getQueueSnapshot(["needs-triage"]);
      expect(snap.oldestFetchAt).toBe(new Date("2025-01-01T00:10:00Z").getTime());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("skipItem", () => {
  beforeEach(async () => {
    clearQueueCache();
    const configMod = await import("./config.js");
    vi.mocked(configMod.writeConfig).mockClear();
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [];
  });

  it("adds item to skippedItems via writeConfig and removes from queue cache", async () => {
    const configMod = await import("./config.js");
    populateQueueCache("refined", "org/repo", { number: 10, title: "A", type: "issue" });

    await skipItem("org/repo", 10);

    expect(configMod.writeConfig).toHaveBeenCalledWith({
      skippedItems: [{ repo: "org/repo", number: 10 }],
    });
    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items).toHaveLength(0);
  });

  it("does not duplicate if item is already skipped", async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [{ repo: "org/repo", number: 10 }];

    await skipItem("org/repo", 10);

    expect(configMod.writeConfig).not.toHaveBeenCalled();
  });

  it("does not duplicate when the existing entry names the pre-import forge number", async () => {
    const NATIVE_ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    // `isItemSkipped` matches either spelling, so a second entry would mean the
    // same thing while forcing the operator to unskip twice (#3245).
    const configMod = await import("./config.js");
    const { recordImport, resetImportedRefsForTest } = await import("./imported-refs.js");
    resetImportedRefsForTest();
    await recordImport("org/repo", 10, NATIVE_ISSUE);
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [{ repo: "org/repo", number: 10 }];
    try {
      await skipItem("org/repo", NATIVE_ISSUE);
      expect(configMod.writeConfig).not.toHaveBeenCalled();
    } finally {
      resetImportedRefsForTest();
    }
  });
});

describe("getQueueSnapshot prioritized sorting", () => {
  beforeEach(async () => {
    clearQueueCache();
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [{ repo: "org/repo", number: 2 }];
  });

  afterEach(async () => {
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [];
  });

  it("sorts prioritized items before non-prioritized", () => {
    populateQueueCache("refined", "org/repo", { number: 1, title: "Normal", type: "issue", updatedAt: "2025-01-02T00:00:00Z" });
    populateQueueCache("refined", "org/repo", { number: 2, title: "Priority", type: "issue", updatedAt: "2025-01-01T00:00:00Z" });

    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items[0].number).toBe(2);
    expect(snap.items[0].prioritized).toBe(true);
    expect(snap.items[1].number).toBe(1);
  });
});

describe("hasPriorityLabel", () => {
  it("returns true when Priority label is present", () => {
    expect(hasPriorityLabel([{ name: "Priority" }, { name: "bug" }])).toBe(true);
  });

  it("returns false when Priority label is absent", () => {
    expect(hasPriorityLabel([{ name: "bug" }, { name: "enhancement" }])).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(hasPriorityLabel([])).toBe(false);
  });

  it("returns true for the built-in grafana-alert incident label", () => {
    expect(hasPriorityLabel([{ name: "grafana-alert" }])).toBe(true);
  });

  it("returns true for a repo-declared incident label, matched case-sensitively", () => {
    expect(hasPriorityLabel([{ name: "sev1" }])).toBe(true);
    expect(hasPriorityLabel([{ name: "Sev1" }])).toBe(false);
    expect(hasPriorityLabel([{ name: "bug" }])).toBe(false);
  });
});

describe("hasBlockedLabel", () => {
  it("returns true when Blocked label is present", () => {
    expect(hasBlockedLabel([{ name: "Blocked" }, { name: "bug" }])).toBe(true);
  });

  it("returns false when Blocked label is absent", () => {
    expect(hasBlockedLabel([{ name: "bug" }, { name: "enhancement" }])).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(hasBlockedLabel([])).toBe(false);
  });
});

describe("hasBacklogLabel", () => {
  it("returns true only when the Backlog label is present", () => {
    expect(hasBacklogLabel([{ name: "Backlog" }, { name: "bug" }])).toBe(true);
    expect(hasBacklogLabel([{ name: "Blocked" }])).toBe(false);
    expect(hasBacklogLabel([])).toBe(false);
  });
});

describe("hasStagingLabel", () => {
  it("returns true when Claws Staging label is present", () => {
    expect(hasStagingLabel([{ name: "Claws Staging" }])).toBe(true);
  });

  it("returns false when Claws Staging label is absent", () => {
    expect(hasStagingLabel([{ name: "bug" }])).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(hasStagingLabel([])).toBe(false);
  });
});

describe("isParked", () => {
  beforeEach(() => {
    mockIsActive.mockReturnValue(true);
    mockIsStagingPipelineEnabled.mockReturnValue(false);
  });

  it("does not park on the retired Claws Ignore label", () => {
    expect(isParked([{ name: "Claws Ignore" }])).toBe(false);
  });

  it("returns true when Blocked label is present", () => {
    expect(isParked([{ name: "Blocked" }])).toBe(true);
  });

  it("returns true when Backlog label is present, in every activation state", () => {
    expect(isParked([{ name: "Backlog" }])).toBe(true);
    mockIsActive.mockReturnValue(false);
    expect(isParked([{ name: "Backlog" }])).toBe(true);
  });

  it("returns true when Claws Staging label is present and isActive is true", () => {
    mockIsActive.mockReturnValue(true);
    expect(isParked([{ name: "Claws Staging" }])).toBe(true);
  });

  it("returns false when Claws Staging label is present but isActive is false", () => {
    mockIsActive.mockReturnValue(false);
    expect(isParked([{ name: "Claws Staging" }])).toBe(false);
  });

  it("returns false when neither label is present", () => {
    expect(isParked([{ name: "bug" }])).toBe(false);
  });

  it("returns false for empty labels", () => {
    expect(isParked([])).toBe(false);
  });
});

describe("isDispatchSkippable", () => {
  beforeEach(() => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(false);
    mockShouldRunWorkPipeline.mockReturnValue(true);
  });

  it("returns true for an issue preview PR, recognised by its head branch", () => {
    expect(isDispatchSkippable("o/r", { number: 1, labels: [], headRefName: "claws/preview-issue-42" })).toBe(true);
    expect(isDispatchSkippable("o/r", { number: 1, labels: [], headRefName: "claws/issue-42-abcd" })).toBe(false);
  });

  it("returns true for a native issue whose import is still in progress", () => {
    expect(isDispatchSkippable("o/r", { number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", labels: [], importPending: true })).toBe(true);
    expect(isDispatchSkippable("o/r", { number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", labels: [], importPending: false })).toBe(false);
  });

  it("returns true for an item carrying the Blocked label", () => {
    expect(isDispatchSkippable("o/r", { number: 1, labels: [{ name: "Blocked" }] })).toBe(true);
  });

  it("returns true for an item carrying the Backlog label", () => {
    expect(isDispatchSkippable("o/r", { number: 1, labels: [{ name: "Backlog" }] })).toBe(true);
  });

  it("returns true for an item with Claws Staging when isActive is true", () => {
    mockIsActive.mockReturnValue(true);
    expect(isDispatchSkippable("o/r", { number: 1, labels: [{ name: "Claws Staging" }] })).toBe(true);
  });

  it("returns false for an item with Claws Staging in staging mode", () => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(true);
    expect(isDispatchSkippable("o/r", { number: 1, labels: [{ name: "Claws Staging" }] })).toBe(false);
  });

  it("returns true for an item with the staging ownership marker when isActive is true", () => {
    mockIsActive.mockReturnValue(true);
    expect(isDispatchSkippable("o/r", { number: 1, labels: [], body: CLAWS_STAGING_PR_MARKER })).toBe(true);
  });

  it("returns false for an item with the staging ownership marker in staging mode", () => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(true);
    expect(isDispatchSkippable("o/r", { number: 1, labels: [], body: CLAWS_STAGING_PR_MARKER })).toBe(false);
  });

  it("returns true for an item without Claws Staging in staging mode", () => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(true);
    expect(isDispatchSkippable("o/r", { number: 1, labels: [] })).toBe(true);
  });

  it("returns false for an item without Claws Staging in verify-only helper semantics", () => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(false);
    expect(isDispatchSkippable("o/r", { number: 1, labels: [] })).toBe(false);
  });

  it("returns true for unlabelled work when the live work pipeline is disabled", () => {
    mockShouldRunWorkPipeline.mockReturnValue(false);
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(false);

    expect(isDispatchSkippable("o/r", { number: 1, labels: [] })).toBe(true);
  });

  it("keeps active-to-staging filtering live for unlabelled work", () => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(true);

    expect(isDispatchSkippable("o/r", { number: 1, labels: [] })).toBe(true);
    expect(isDispatchSkippable("o/r", { number: 2, labels: [{ name: "Claws Staging" }] })).toBe(false);
  });
});

describe("dispatchSkipReason", () => {
  beforeEach(() => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(false);
    mockShouldRunWorkPipeline.mockReturnValue(true);
  });

  it("is null when the item may be dispatched", () => {
    expect(dispatchSkipReason("o/r", { number: 1, labels: [] })).toBeNull();
  });

  it("names a paused pipeline rather than staging", () => {
    mockShouldRunWorkPipeline.mockReturnValue(false);
    expect(dispatchSkipReason("o/r", { number: 1, labels: [] })).toBe("work pipeline paused");
  });

  it("names the parking label", () => {
    expect(dispatchSkipReason("o/r", { number: 1, labels: [{ name: "Blocked" }] })).toBe("parked by label Blocked");
  });

  it("names an issue preview PR and an import in progress", () => {
    expect(dispatchSkipReason("o/r", { number: 1, labels: [], headRefName: "claws/preview-issue-42" })).toBe("issue preview PR");
    expect(dispatchSkipReason("o/r", { number: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", labels: [], importPending: true })).toBe("import in progress");
  });

  it("does not blame the opt-in Claws Staging label in staging mode", () => {
    mockIsStagingPipelineEnabled.mockReturnValue(true);
    expect(dispatchSkipReason("o/r", { number: 1, labels: [{ name: "Claws Staging" }, { name: "Backlog" }] })).toBe("parked by label Backlog");
    expect(dispatchSkipReason("o/r", { number: 2, labels: [] })).toBe("not opted in to staging");
  });

  it("reports staging ownership on the active instance", () => {
    mockIsActive.mockReturnValue(true);
    expect(dispatchSkipReason("o/r", { number: 1, labels: [{ name: "Claws Staging" }] })).toBe("staging-owned");
  });
});

describe("issueDispatchSkipReason (#clw_01M52GPG0E9DP8RQKW6ABH0X7R)", () => {
  const NATIVE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

  beforeEach(() => {
    mockIsActive.mockReturnValue(false);
    mockIsStagingPipelineEnabled.mockReturnValue(false);
    mockShouldRunWorkPipeline.mockReturnValue(true);
    mockIsJobDisabledForRepo.mockReturnValue(false);
  });

  it("holds a forge issue in a repo with the importer enabled", () => {
    expect(issueDispatchSkipReason("o/r", { number: 33, labels: [] })).toBe("awaiting import into the native tracker");
    expect(isIssueDispatchSkippable("o/r", { number: 33, labels: [] })).toBe(true);
    expect(mockIsJobDisabledForRepo).toHaveBeenCalledWith("issue-importer", "o/r");
  });

  it("never holds a native issue", () => {
    expect(awaitingImportReason("o/r", { number: NATIVE })).toBeNull();
    expect(issueDispatchSkipReason("o/r", { number: NATIVE, labels: [] })).toBeNull();
  });

  it("does not hold a forge issue in a repo with the importer disabled", () => {
    mockIsJobDisabledForRepo.mockImplementation((job) => job === "issue-importer");
    expect(issueDispatchSkipReason("o/r", { number: 33, labels: [] })).toBeNull();
  });

  it("names a parking reason first, and leaves dispatchSkipReason unchanged for PRs", () => {
    expect(issueDispatchSkipReason("o/r", { number: 33, labels: [{ name: "Blocked" }] })).toBe("parked by label Blocked");
    expect(dispatchSkipReason("o/r", { number: 33, labels: [] })).toBeNull();
    expect(isDispatchSkippable("o/r", { number: 33, labels: [] })).toBe(false);
  });
});

describe("freshDispatchNote", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");

  it("returns a note recorded within the last hour", () => {
    expect(freshDispatchNote({ dispatchNote: "n", dispatchNoteAt: "2026-09-01T11:30:00Z" }, now)).toBe("n");
  });

  it("drops a note older than an hour, or none at all", () => {
    expect(freshDispatchNote({ dispatchNote: "n", dispatchNoteAt: "2026-09-01T10:30:00Z" }, now)).toBeUndefined();
    expect(freshDispatchNote({ dispatchNote: null, dispatchNoteAt: null }, now)).toBeUndefined();
    expect(freshDispatchNote(undefined, now)).toBeUndefined();
  });
});

describe("populateQueueCache label-based priority", () => {
  beforeEach(() => {
    clearQueueCache();
  });

  it("marks items as prioritized when priority flag is true", () => {
    populateQueueCache("refined", "org/repo", { number: 7, title: "Priority Issue", type: "issue", priority: true });
    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].prioritized).toBe(true);
  });

  it("does not mark items as prioritized when priority flag is false", () => {
    populateQueueCache("refined", "org/repo", { number: 8, title: "Normal Issue", type: "issue", priority: false });
    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items).toHaveLength(1);
    expect(snap.items[0].prioritized).toBeFalsy();
  });

  it("sorts label-priority items before non-priority items", () => {
    populateQueueCache("refined", "org/repo", { number: 1, title: "Normal", type: "issue", updatedAt: "2025-01-02T00:00:00Z" });
    populateQueueCache("refined", "org/repo", { number: 2, title: "Priority", type: "issue", updatedAt: "2025-01-01T00:00:00Z", priority: true });

    const snap = getQueueSnapshot(["refined"]);
    expect(snap.items[0].number).toBe(2);
    expect(snap.items[0].prioritized).toBe(true);
    expect(snap.items[1].number).toBe(1);
  });
});

describe("isForkPR", () => {
  it("returns true for cross-repository PRs", () => {
    expect(isForkPR({ isCrossRepository: true } as any)).toBe(true);
  });

  it("returns false for same-repository PRs", () => {
    expect(isForkPR({ isCrossRepository: false } as any)).toBe(false);
  });
});

describe("isAllowedActor", () => {
  beforeEach(() => {
    mockForgejo.forgejoSelfLogin.mockReset();
    mockForgejo.forgejoSelfLogin.mockResolvedValue("test-bot");
    mockForgejo.forgejoReadSelfLogin.mockReset();
    mockForgejo.forgejoReadSelfLogin.mockResolvedValue(null);
  });

  it("returns true for a login in ALLOWED_ACTORS", async () => {
    expect(await isAllowedActor("stjohnb")).toBe(true);
  });

  it("returns true when login matches self-login exactly", async () => {
    expect(await isAllowedActor("test-bot")).toBe(true);
  });

  it("returns true for gh-CLI 'app/<slug>' form matching '<slug>[bot]' self-login", async () => {
    mockForgejo.forgejoSelfLogin.mockResolvedValueOnce("clawsstjohn[bot]");
    expect(await isAllowedActor("app/clawsstjohn")).toBe(true);
  });

  it("returns true when ALLOWED_ACTORS contains '[bot]' form and login is 'app/<slug>'", async () => {
    const config = await import("./config.js");
    (config as Record<string, unknown>).ALLOWED_ACTORS = ["dependabot[bot]"];
    try {
      expect(await isAllowedActor("app/dependabot")).toBe(true);
    } finally {
      (config as Record<string, unknown>).ALLOWED_ACTORS = ["stjohnb"];
    }
  });

  it("returns false for an unrelated login", async () => {
    expect(await isAllowedActor("attacker")).toBe(false);
  });

  it("trusts the native login only on a native issue", async () => {
    // `github.com/claws` is a real account this org does not control, and so is
    // any self-registered `claws` on the Forgejo instance. Trusting the login
    // alone would hand either of them the untrusted-actor gate — which decides
    // whose issues get implemented and whose comments become owner feedback in
    // an agent prompt — on every monitored repo.
    expect(await isAllowedActor("claws", "org/repo", "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC")).toBe(true);
    expect(await isAllowedActor("claws", "org/repo", "clw_01jbq7x4m2k8nv3tyrw9gz5pdc")).toBe(true);
    expect(await isAllowedActor("claws", "org/repo", 42)).toBe(false);
    expect(await isAllowedActor("claws", "org/repo")).toBe(false);
    expect(await isAllowedActor("claws")).toBe(false);
  });

  it("trusts the Forgejo read/issue account's login as Claws' own on a Forgejo repo (#3152)", async () => {
    mockForgejo.forgejoSelfLogin.mockResolvedValue("claws-forgejo");
    mockForgejo.forgejoReadSelfLogin.mockResolvedValue("claws-reader");

    expect(await isAllowedActor("claws-reader", "org/forge")).toBe(true);
  });

  it("does not trust the read login with no repo", async () => {
    mockForgejo.forgejoReadSelfLogin.mockResolvedValue("claws-reader");

    expect(await isAllowedActor("claws-reader")).toBe(false);
    expect(mockForgejo.forgejoReadSelfLogin).not.toHaveBeenCalled();
  });

  it("stays false for an unrelated login on a Forgejo repo when the read login resolves to null", async () => {
    mockForgejo.forgejoSelfLogin.mockResolvedValue("claws-forgejo");
    mockForgejo.forgejoReadSelfLogin.mockResolvedValue(null);

    expect(await isAllowedActor("someone-else", "org/forge")).toBe(false);
  });
});

describe("isAllowedHumanActor", () => {
  beforeEach(() => {
    mockForgejo.forgejoSelfLogin.mockReset();
    mockForgejo.forgejoSelfLogin.mockResolvedValue("claws-forgejo");
    mockForgejo.forgejoReadSelfLogin.mockReset();
    mockForgejo.forgejoReadSelfLogin.mockResolvedValue(null);
  });

  it("rejects the read login on a Forgejo repo even when it is also in allowedActors (#3152)", async () => {
    mockForgejo.forgejoReadSelfLogin.mockResolvedValue("claws-reader");
    const config = await import("./config.js");
    const previous = (config as Record<string, unknown>).ALLOWED_ACTORS;
    (config as Record<string, unknown>).ALLOWED_ACTORS = ["stjohnb", "claws-reader"];
    try {
      expect(await isAllowedHumanActor("claws-reader", "org/forge")).toBe(false);
    } finally {
      (config as Record<string, unknown>).ALLOWED_ACTORS = previous;
    }
  });

  it("rejects forgejo-actions even when it is listed in allowedActors", async () => {
    const config = await import("./config.js");
    const previous = (config as Record<string, unknown>).ALLOWED_ACTORS;
    (config as Record<string, unknown>).ALLOWED_ACTORS = ["stjohnb", "forgejo-actions"];
    try {
      expect(await isAllowedHumanActor("forgejo-actions", "org/forge")).toBe(false);
    } finally {
      (config as Record<string, unknown>).ALLOWED_ACTORS = previous;
    }
  });

  it("still accepts a configured human actor on a Forgejo repo", async () => {
    mockForgejo.forgejoReadSelfLogin.mockResolvedValue("claws-reader");
    const config = await import("./config.js");
    const previous = (config as Record<string, unknown>).ALLOWED_ACTORS;
    (config as Record<string, unknown>).ALLOWED_ACTORS = ["stjohnb"];
    try {
      expect(await isAllowedHumanActor("stjohnb", "org/forge")).toBe(true);
    } finally {
      (config as Record<string, unknown>).ALLOWED_ACTORS = previous;
    }
  });
});

describe("isCiAlertBotAuthor", () => {
  it("returns true for app/github-actions regardless of title (regression: #1217 dispatches)", () => {
    expect(isCiAlertBotAuthor({
      title: "Production database migration failure",
      author: { login: "app/github-actions" },
    })).toBe(true);
  });

  it("returns true for github-actions[bot] with an arbitrary title", () => {
    expect(isCiAlertBotAuthor({
      author: { login: "github-actions[bot]" },
    })).toBe(true);
  });

  it("returns true for app/github-actions with the legacy '[main] … failed on main' title", () => {
    expect(isCiAlertBotAuthor({
      title: "[main] Deploy failed on main",
      author: { login: "app/github-actions" },
    })).toBe(true);
  });

  it("returns true for forgejo-actions only when a repo is given", () => {
    const issue = { author: { login: "forgejo-actions" } };
    expect(isCiAlertBotAuthor(issue, "org/forge")).toBe(true);
    expect(isCiAlertBotAuthor(issue)).toBe(false);
  });

  it("returns false for a human author", () => {
    expect(isCiAlertBotAuthor({
      author: { login: "stjohnb" },
    })).toBe(false);
  });
});

describe("isDependencyBotAuthor", () => {
  it.each(["renovate", "renovate[bot]", "app/renovate", "dependabot[bot]"])(
    "returns true for %s",
    (login) => {
      expect(isDependencyBotAuthor({ author: { login } })).toBe(true);
    },
  );

  it.each(["stjohnb", "github-actions[bot]", "renovate-fan"])(
    "returns false for %s",
    (login) => {
      expect(isDependencyBotAuthor({ author: { login } })).toBe(false);
    },
  );
});

describe("isInfrastructureOutage", () => {
  const job = (conclusion: string | null, stepCount: number, name = "build") =>
    ({ id: 1, name, status: "completed", conclusion, stepCount, failedSteps: [] });

  it("is false for a run with no jobs at all", () => {
    expect(isInfrastructureOutage([])).toBe(false);
  });

  it("is false when every job succeeded", () => {
    expect(isInfrastructureOutage([job("success", 12)])).toBe(false);
  });

  it("is true when the only failure recorded zero steps", () => {
    expect(isInfrastructureOutage([job("failure", 0, "image-scan")])).toBe(true);
  });

  it("is true for a stepless cancellation", () => {
    expect(isInfrastructureOutage([job("cancelled", 0)])).toBe(true);
  });

  it("is true when a stepless failure sits alongside successful jobs", () => {
    expect(isInfrastructureOutage([job("success", 9), job("failure", 0)])).toBe(true);
  });

  it("is false when a genuine failure with steps is in the run", () => {
    expect(isInfrastructureOutage([job("failure", 23)])).toBe(false);
  });

  // The load-bearing case: one job died with the runner, another failed for real.
  // That run still needs a code fix, so it must not be classified as an outage.
  it("is false when a stepless failure is mixed with a stepped failure", () => {
    expect(isInfrastructureOutage([job("failure", 0), job("failure", 23)])).toBe(false);
  });
});

describe("isPreRepoStepFailure", () => {
  const job = (conclusion: string | null, stepCount: number, failedSteps: string[], name = "build") =>
    ({ id: 1, name, status: "completed", conclusion, stepCount, failedSteps });

  it("is false for a run with no jobs at all", () => {
    expect(isPreRepoStepFailure([])).toBe(false);
  });

  it("is false when every job succeeded", () => {
    expect(isPreRepoStepFailure([job("success", 12, [])])).toBe(false);
  });

  it("is true when the only failed step is GitHub's own job setup", () => {
    expect(isPreRepoStepFailure([job("failure", 1, ["Set up job"])])).toBe(true);
  });

  it("is true when the failure is in the checkout action", () => {
    expect(isPreRepoStepFailure([job("failure", 2, ["Run actions/checkout@v4"])])).toBe(true);
  });

  it("is true when the failure is in Forgejo's checkout step, named after the action URL", () => {
    expect(isPreRepoStepFailure([job("failure", 3, ["https://github.com/actions/checkout@v4", "Complete job"])])).toBe(true);
  });

  it("is false for the run-57 shape: a repo-owned step failed alongside cleanup and Complete job", () => {
    expect(isPreRepoStepFailure([job("failure", 7, ["Check Home Assistant configuration", "Clean up", "Complete job"])])).toBe(false);
  });

  it("is true for a job that recorded zero steps", () => {
    expect(isPreRepoStepFailure([job("failure", 0, [])])).toBe(true);
  });

  it("is false when a repo-owned step failed", () => {
    expect(isPreRepoStepFailure([job("failure", 8, ["Run npm test"])])).toBe(false);
  });

  // Conservative: steps ran but none is recorded as failed, so we can't prove the diff
  // was never exercised.
  it("is false when a stepped job failed with no recorded failed step", () => {
    expect(isPreRepoStepFailure([job("failure", 8, [])])).toBe(false);
  });

  it("is false when a pre-repo failure sits alongside a real failure", () => {
    expect(isPreRepoStepFailure([job("failure", 1, ["Set up job"]), job("failure", 8, ["Run npm test"])])).toBe(false);
  });
});

describe("isRefAlreadyGone", () => {
  const ghError = (branch: string, stderr: string) =>
    Object.assign(new Error(`gh api --method DELETE repos/o/r/git/refs/heads/${branch} failed: ${stderr}`), { stderr });

  it("matches gh 404/422 responses", () => {
    expect(isRefAlreadyGone(ghError("claws/x", "gh: Not Found (HTTP 404)"))).toBe(true);
    expect(isRefAlreadyGone(ghError("claws/x", "gh: Reference does not exist (HTTP 422)"))).toBe(true);
  });

  it("ignores 404/422 digits in the echoed branch name", () => {
    expect(isRefAlreadyGone(ghError("claws/preview-issue-404", "gh: Forbidden (HTTP 403)"))).toBe(false);
    expect(isRefAlreadyGone(ghError("claws/preview-issue-1422", "connection reset"))).toBe(false);
  });

  it("matches Forgejo's HTTP status message", () => {
    expect(isRefAlreadyGone(new Error("forgejo DELETE /repos/o/r/branches/claws/preview-issue-404 failed: HTTP 404: not found"))).toBe(true);
    expect(isRefAlreadyGone(new Error("forgejo DELETE /repos/o/r/branches/claws/preview-issue-404 failed: HTTP 500: boom"))).toBe(false);
  });
});

describe("Claws-native issue routing", () => {
  const NATIVE_ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
  const NATIVE_COMMENT = "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

  /** A closed native record as `claws-issues.listClosedIssuesSince` hands it over. */
  function closedNative(id: string, title: string, closedAt: string) {
    return {
      id, title, body: "", author_login: "claws", repos: ["org/repo"], labels: [],
      closed_at: closedAt, updated_at: closedAt, created_at: closedAt,
      state: "closed", state_reason: "completed",
    };
  }

  beforeEach(() => {
    for (const fn of Object.values(mockForgejo)) (fn as any).mockReset?.();
    mockForgejo.isConfigured.mockReturnValue(true);
    for (const fn of Object.values(mockClawsIssues)) (fn as any).mockClear?.();
    clearApiCache();
  });

  afterEach(() => {
    // Restore the module-level defaults: other suites assume the native store
    // contributes nothing to a forge repo's issue lists.
    mockClawsIssues.listOpenIssues.mockResolvedValue([]);
    mockClawsIssues.listIssuesByLabel.mockResolvedValue([]);
    mockClawsIssues.listDuplicateIssuesOf.mockResolvedValue([]);
    mockClawsIssues.listClosedIssuesSince.mockResolvedValue([]);
  });

  for (const repo of ["org/repo", "org/forge"]) {
    it(`reads a native issue from the store, not the forge (${repo})`, async () => {
      expect(await getIssueTitleBody(repo, NATIVE_ISSUE)).toEqual({ title: "native", body: "native body" });
      expect(await getIssueBody(repo, NATIVE_ISSUE)).toBe("native body");
      expect(await getIssueBodyHtml(repo, NATIVE_ISSUE)).toBe("<p>native body</p>");
      expect(await getIssueState(repo, NATIVE_ISSUE)).toEqual({ state: "OPEN", stateReason: null, labels: [] });
      expect(await getIssueComments(repo, NATIVE_ISSUE)).toEqual([]);
      // Native files come from Claws' own store, never a forge assets API.
      expect(await getIssueAttachments(repo, NATIVE_ISSUE)).toEqual([
        { name: "shot.png", url: "/issues/clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC/attachments/cla_01JBQ7X4M2K8NV3TYRW9GZ5PDD/shot.png" },
      ]);
      expect(mockClawsIssues.listAttachments).toHaveBeenCalledWith(NATIVE_ISSUE);
      expect(mockForgejo.getIssueAttachments).not.toHaveBeenCalled();
      expect(mockForgejo.getIssueTitleBody).not.toHaveBeenCalled();
      expect(mockForgejo.getIssueComments).not.toHaveBeenCalled();
    });

    it(`writes a native issue to the store, not the forge (${repo})`, async () => {
      await addLabel(repo, NATIVE_ISSUE, "Ready");
      expect(await removeLabel(repo, NATIVE_ISSUE, "Ready")).toBe(true);
      await editIssue(repo, NATIVE_ISSUE, "new body");
      await editIssueTitle(repo, NATIVE_ISSUE, "new title");
      await closeIssue(repo, NATIVE_ISSUE, "completed");

      expect(mockClawsIssues.addLabel).toHaveBeenCalledWith(repo, NATIVE_ISSUE, "Ready");
      expect(mockClawsIssues.removeLabel).toHaveBeenCalledWith(repo, NATIVE_ISSUE, "Ready");
      expect(mockClawsIssues.editIssue).toHaveBeenCalledWith(NATIVE_ISSUE, "new body");
      expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith(NATIVE_ISSUE, "new title");
      expect(mockClawsIssues.closeIssue).toHaveBeenCalledWith(repo, NATIVE_ISSUE, "completed");
      expect(mockForgejo.addLabel).not.toHaveBeenCalled();
      expect(mockForgejo.closeIssue).not.toHaveBeenCalled();
    });

    it(`stores a native comment with the Claws marker and the native login (${repo})`, async () => {
      mockForgejo.forgejoSelfLogin.mockResolvedValue("claws-forgejo");

      await commentOnIssue(repo, NATIVE_ISSUE, "hello", { agentName: "planner" });

      const [eventRepo, ref, body, login] = mockClawsIssues.commentOnIssue.mock.calls[0]!;
      expect(eventRepo).toBe(repo);
      expect(ref).toBe(NATIVE_ISSUE);
      expect(body).toContain("Automated by Claws · planner");
      expect(body).toContain("hello");
      // Never the forge bot: a native write must not need a forge round trip.
      expect(login).toBe("claws");
      expect(mockForgejo.commentOnIssue).not.toHaveBeenCalled();
      expect(mockForgejo.forgejoSelfLogin).not.toHaveBeenCalled();
    });

    it(`routes native comment ids on reactions and edits (${repo})`, async () => {
      mockForgejo.forgejoSelfLogin.mockResolvedValue("claws-forgejo");

      await addReaction(repo, NATIVE_COMMENT, "+1");
      await editIssueComment(repo, NATIVE_COMMENT, "edited");
      expect(await getCommentReactions(repo, NATIVE_COMMENT)).toEqual([]);

      expect(mockClawsIssues.addReaction).toHaveBeenCalledWith(NATIVE_COMMENT, "claws", "+1");
      expect(mockClawsIssues.editIssueComment.mock.calls[0]![0]).toBe(NATIVE_COMMENT);
      expect(mockClawsIssues.editIssueComment.mock.calls[0]![1]).toContain("edited");
      expect(mockClawsIssues.getCommentReactions).toHaveBeenCalledWith(NATIVE_COMMENT);
      expect(mockForgejo.addReaction).not.toHaveBeenCalled();
      expect(mockForgejo.editIssueComment).not.toHaveBeenCalled();
    });

    it(`answers getSelfLoginForIssue with the native login (${repo})`, async () => {
      mockForgejo.forgejoSelfLogin.mockResolvedValue("claws-forgejo");

      expect(await getSelfLoginForIssue(repo, NATIVE_ISSUE)).toBe("claws");
    });
  }

  // The backends do not promise one casing for the state, so the façade
  // normalises once and returns the union
  // every guard compares against. Without a non-uppercase input here, deleting
  // the normalisation leaves the suite green, which is how a `=== "closed"`
  // comparison once shipped dead.
  it("upper-cases a forge issue's state", async () => {
    mockForgejo.getIssueState.mockResolvedValue({ state: "closed", stateReason: "completed", labels: [] });

    expect(await getIssueState("org/repo", 42)).toEqual({ state: "CLOSED", stateReason: "completed", labels: [] });
  });

  it("upper-cases a native issue's state", async () => {
    mockClawsIssues.getIssueState.mockResolvedValueOnce({ state: "open", stateReason: null, labels: [] });

    expect(await getIssueState("org/repo", NATIVE_ISSUE)).toEqual({ state: "OPEN", stateReason: null, labels: [] });
  });

  it("accepts a lower-cased native id at the façade", async () => {
    await addLabel("org/repo", NATIVE_ISSUE.toLowerCase(), "Ready");

    expect(mockClawsIssues.addLabel).toHaveBeenCalledWith("org/repo", NATIVE_ISSUE.toLowerCase(), "Ready");
  });

  it("leaves a forge issue number on the forge path", async () => {
    mockForgejo.getIssueTitleBody.mockResolvedValue({ title: "forge", body: "forge body" });

    expect(await getIssueTitleBody("org/forge", 42)).toEqual({ title: "forge", body: "forge body" });

    expect(mockClawsIssues.getIssueTitleBody).not.toHaveBeenCalled();
  });

  it("appends single-repo native issues to the forge open-issue list", async () => {
    mockForgejo.listOpenIssues.mockResolvedValue([{ number: 5, title: "forge", body: "", labels: [], author: { login: "stjohnb" } }]);
    mockClawsIssues.listOpenIssues.mockResolvedValue([
      { number: NATIVE_ISSUE, title: "native", body: "", labels: [], author: { login: "stjohnb" } },
    ]);

    const issues = await listOpenIssues("org/repo");

    expect(issues.map((i) => i.number)).toEqual([5, NATIVE_ISSUE]);
    expect(mockClawsIssues.listOpenIssues).toHaveBeenCalledWith("org/repo");
  });

  it("appends native issues to a Forgejo repo's open-issue list too", async () => {
    mockForgejo.listOpenIssues.mockResolvedValue([
      { number: 5, title: "forge", body: "", labels: [], author: { login: "stjohnb" } },
    ]);
    mockClawsIssues.listOpenIssues.mockResolvedValue([
      { number: NATIVE_ISSUE, title: "native", body: "", labels: [], author: { login: "stjohnb" } },
    ]);

    expect((await listOpenIssues("org/forge")).map((i) => i.number)).toEqual([5, NATIVE_ISSUE]);
  });

  it("appends native issues to the label-filtered list", async () => {
    mockForgejo.listIssuesByLabel.mockResolvedValue([]);
    mockClawsIssues.listIssuesByLabel.mockResolvedValue([
      { number: NATIVE_ISSUE, title: "native", body: "", labels: [{ name: "Ready" }], author: { login: "stjohnb" } },
    ]);

    expect((await listIssuesByLabel("org/repo", "Ready")).map((i) => i.number)).toEqual([NATIVE_ISSUE]);
    expect(mockClawsIssues.listIssuesByLabel).toHaveBeenCalledWith("org/repo", "Ready");
  });

  it("pushes repo and limit into the native recently-closed query", async () => {
    mockForgejo.listRecentlyClosedIssues.mockResolvedValue([]);
    mockClawsIssues.listClosedIssuesSince.mockResolvedValue([
      closedNative(NATIVE_ISSUE, "mine", "2026-01-01 00:00:00"),
    ]);

    const closed = await listRecentlyClosedIssues("org/repo", null, 25);

    expect(closed.map((i) => i.number)).toEqual([NATIVE_ISSUE]);
    // The repo filter and the cap are the store's job, not a post-filter here:
    // the closed set only ever grows, and this runs per repo per poll.
    expect(mockClawsIssues.listClosedIssuesSince).toHaveBeenCalledWith("org/repo", expect.any(Date), 25);
  });

  it("merges native and forge closed issues by closedAt and honours the limit", async () => {
    mockForgejo.listRecentlyClosedIssues.mockResolvedValue([
      { number: 1, title: "old forge", body: "", closedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", author: "stjohnb" },
      { number: 2, title: "new forge", body: "", closedAt: "2026-01-03T00:00:00Z", updatedAt: "2026-01-03T00:00:00Z", author: "stjohnb" },
    ]);
    mockClawsIssues.listClosedIssuesSince.mockResolvedValue([
      closedNative(NATIVE_ISSUE, "native", "2026-01-02 00:00:00"),
    ]);

    // Merged by closedAt, not concatenated: a caller that walks the list and
    // stops early (doc-maintainer breaks at ten plans) must still reach a
    // native issue that closed inside the window.
    expect((await listRecentlyClosedIssues("org/repo", null)).map((i) => i.number))
      .toEqual([2, NATIVE_ISSUE, 1]);
    // …and the cut is applied after the merge, so `limit` is not silently
    // exceeded by the native half.
    expect((await listRecentlyClosedIssues("org/repo", null, 2)).map((i) => i.number))
      .toEqual([2, NATIVE_ISSUE]);
  });

  it("keeps the forge's closed issues when the native store throws", async () => {
    mockForgejo.listRecentlyClosedIssues.mockResolvedValue([
      { number: 5, title: "forge", body: "", closedAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", author: "stjohnb" },
    ]);
    mockClawsIssues.listClosedIssuesSince.mockRejectedValue(new Error("database is locked"));

    expect((await listRecentlyClosedIssues("org/repo", null)).map((i) => i.number)).toEqual([5]);
  });

  it("keeps the forge's open issues when the native store throws", async () => {
    mockForgejo.listOpenIssues.mockResolvedValue([
      { number: 9, title: "forge", body: "", labels: [], author: { login: "stjohnb" }, updatedAt: "2026-01-01T00:00:00Z" },
    ]);
    mockClawsIssues.listOpenIssues.mockRejectedValue(new Error("database is locked"));

    expect((await listOpenIssues("org/repo")).map((i) => i.number)).toEqual([9]);
  });

  it("does not consult the native store when the issue number is a forge one", async () => {
    mockClawsIssues.listOpenIssues.mockResolvedValue([]);
    mockForgejo.listOpenIssues.mockResolvedValue([]);
    mockForgejo.addLabel.mockResolvedValue(undefined);

    await listOpenIssues("org/repo");
    await addLabel("org/repo", 7, "Ready");

    expect(mockClawsIssues.addLabel).not.toHaveBeenCalled();
  });

  it("unions forge and native duplicates whichever kind the canonical issue is", async () => {
    // Both kinds of issue live in one repo, so a native issue can be a
    // duplicate of a forge one and vice versa. Routing on the target's kind
    // would hide half the duplicates from the merger, silently.
    const dup = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";
    mockClawsIssues.listDuplicateIssuesOf.mockResolvedValue([
      { number: dup, title: "native dup", body: "", labels: [], author: { login: "stjohnb" } },
    ]);
    mockForgejo.listDuplicateIssuesOf.mockResolvedValue([
      { number: 77, title: "forge dup", body: "", labels: [], author: { login: "stjohnb" }, updatedAt: "2026-01-01T00:00:00Z" },
    ]);

    expect((await listDuplicateIssuesOf("org/repo", NATIVE_ISSUE)).map((i) => i.number)).toEqual([77, dup]);
    expect((await listDuplicateIssuesOf("org/repo", 42)).map((i) => i.number)).toEqual([77, dup]);
  });

  it("cross-references a native issue by scanning PR bodies, with no timeline call", async () => {
    mockForgejo.listPRs.mockResolvedValue([
      { number: 11, title: "mine", headRefName: `claws/issue-${NATIVE_ISSUE}-x`, baseRefName: "main", labels: [], author: { login: "claws" }, body: `Closes #${NATIVE_ISSUE.toLowerCase()}` },
      { number: 12, title: "other", headRefName: "other", baseRefName: "main", labels: [], author: { login: "stjohnb" }, body: "unrelated" },
    ]);
    mockForgejo.searchClosedPulls.mockResolvedValue([]);

    const refs = await listPRsCrossReferencingIssue("org/repo", NATIVE_ISSUE);

    expect(refs.map((p) => p.number)).toEqual([11]);
    expect(mockForgejo.listPRsCrossReferencingIssue).not.toHaveBeenCalled();
  });

  it("drops an open preview PR, by its branch, whose body names the native id", async () => {
    mockForgejo.listPRs.mockResolvedValue([
      { number: 11, title: "mine", headRefName: `claws/issue-${NATIVE_ISSUE}-x`, baseRefName: "main", labels: [], author: { login: "claws" }, body: `Closes #${NATIVE_ISSUE}` },
      { number: 546, title: "[do not merge] preview", headRefName: `claws/preview-issue-${NATIVE_ISSUE}`, baseRefName: "main", labels: [], author: { login: "claws" }, body: `Preview for ${NATIVE_ISSUE}` },
    ]);
    mockForgejo.searchClosedPulls.mockResolvedValue([]);

    const refs = await listPRsCrossReferencingIssue("org/repo", NATIVE_ISSUE);

    expect(refs.map((p) => p.number)).toEqual([11]);
  });

  it("reports a merged PR that closes a native issue as merged, not open", async () => {
    // `computePhaseCoverage` only counts a phase as landed on `state ===
    // "merged"`, so an open-only scan would leave a finished native
    // multi-phase issue reporting lastMergedPhase = 0 and re-dispatching.
    mockForgejo.listPRs.mockResolvedValue([]);
    mockForgejo.searchClosedPulls.mockResolvedValue([
      { number: 21, title: "landed (1/2)", body: `Part of #${NATIVE_ISSUE}`, user: { login: "claws" }, pull_request: { merged: true, merged_at: "2026-01-02T00:00:00Z" } },
      // Closed without merging: not a landed phase.
      { number: 22, title: "abandoned", body: `Part of #${NATIVE_ISSUE}`, user: { login: "claws" }, pull_request: { merged: false } },
      // The search is fuzzy: a hit whose body never names the id is dropped.
      { number: 23, title: "near miss", body: "Part of #clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD", user: { login: "claws" }, pull_request: { merged: true } },
    ]);

    const refs = await listPRsCrossReferencingIssue("org/repo", NATIVE_ISSUE);

    expect(refs).toEqual([expect.objectContaining({ number: 21, state: "merged", login: "claws" })]);
    expect(mockForgejo.searchClosedPulls).toHaveBeenCalledWith("org/repo", NATIVE_ISSUE);
    expect(mockForgejo.listRecentlyMergedPRs).not.toHaveBeenCalled();
  });
});

describe("imported forge refs keep resolving", () => {
  const NATIVE_ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";

  beforeEach(() => {
    clearApiCache();
    resetImportedRefsForTest();
    mockClawsIssues.listDuplicateIssuesOf.mockResolvedValue([]);
  });

  afterEach(() => {
    resetImportedRefsForTest();
  });

  function forgeListing(numbers: number[]): void {
    const issues = numbers.map((number) => (
      { number, title: `Issue ${number}`, body: "", labels: [], author: { login: "bot" }, updatedAt: "2026-09-25T08:45:02Z" }
    ));
    mockForgejo.listOpenIssues.mockReset();
    mockForgejo.listOpenIssues.mockResolvedValue(issues);
    mockForgejo.listIssuesByLabel.mockReset();
    mockForgejo.listIssuesByLabel.mockResolvedValue(issues);
  }

  it("drops an imported forge copy from listOpenIssues but keeps the rest", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    forgeListing([7, 8]);
    mockClawsIssues.listOpenIssues.mockResolvedValueOnce([
      { number: NATIVE_ISSUE, title: "Issue 7", body: "", labels: [], author: { login: "claws" } },
    ]);

    const issues = await listOpenIssues("org/repo");

    expect(issues.map((i) => i.number)).toEqual([8, NATIVE_ISSUE]);
  });

  it("keeps an imported forge copy in listOpenIssues with includeImported", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    forgeListing([7, 8]);

    // One cache entry serves both variants: the filter runs after the read.
    expect((await listOpenIssues("org/repo")).map((i) => i.number)).toEqual([8]);
    expect((await listOpenIssues("org/repo", { includeImported: true })).map((i) => i.number)).toEqual([7, 8]);
  });

  it("drops an imported forge copy from listIssuesByLabel unless includeImported", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    forgeListing([7, 8]);

    expect((await listIssuesByLabel("org/repo", "Ready")).map((i) => i.number)).toEqual([8]);
    expect((await listIssuesByLabel("org/repo", "Ready", { includeImported: true })).map((i) => i.number)).toEqual([7, 8]);
  });

  it("keeps a forge issue imported only in another repository", async () => {
    await recordImport("org/other", 7, NATIVE_ISSUE);
    forgeListing([7]);

    expect((await listOpenIssues("org/repo")).map((i) => i.number)).toEqual([7]);
  });

  it("matches an operator's forge-numbered skip entry against the native id", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).SKIPPED_ITEMS = [{ repo: "org/repo", number: 7 }];
    try {
      expect(isItemSkipped("org/repo", NATIVE_ISSUE)).toBe(true);
      expect(isItemSkipped("org/repo", NATIVE_ISSUE.toLowerCase())).toBe(true);
      // The alias belongs to `org/repo`; forge numbers collide across repos.
      expect(isItemSkipped("org/other", NATIVE_ISSUE)).toBe(false);
    } finally {
      (configMod as Record<string, unknown>).SKIPPED_ITEMS = [];
    }
  });

  it("matches an operator's forge-numbered priority entry against the native id", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    const configMod = await import("./config.js");
    (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [{ repo: "org/repo", number: 7 }];
    try {
      expect(isItemPrioritized("org/repo", NATIVE_ISSUE)).toBe(true);
      expect(isItemPrioritized("org/other", NATIVE_ISSUE)).toBe(false);
    } finally {
      (configMod as Record<string, unknown>).PRIORITIZED_ITEMS = [];
    }
  });

  it("finds the open PR still cut from the pre-import branch", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    mockForgejo.getOpenPRForIssue.mockReset();
    mockForgejo.getOpenPRForIssue.mockImplementation(async (_repo: string, ref: unknown) => ref === 7
      ? { number: 5, title: "fix", headRefName: "claws/issue-7-abc1", baseRefName: "main", labels: [], author: { login: "bot" } }
      : null);

    expect((await getOpenPRForIssue("org/repo", NATIVE_ISSUE))?.number).toBe(5);
  });

  it("queries merged PRs once per alias and de-duplicates by number", async () => {
    await recordImport("org/repo", 752, NATIVE_ISSUE);
    mockForgejo.listMergedPRsForIssue.mockReset();
    mockForgejo.listMergedPRsForIssue.mockImplementation(async (_repo: string, ref: unknown) => [
      { number: 10, title: "Phase 1", headRefName: `claws/issue-${String(ref)}-aaaa`, baseRefName: "main", labels: [], author: { login: "bot" }, body: "" },
    ]);

    const prs = await listMergedPRsForIssue("org/repo", NATIVE_ISSUE);

    expect(mockForgejo.listMergedPRsForIssue).toHaveBeenCalledTimes(2);
    const searched = mockForgejo.listMergedPRsForIssue.mock.calls.map((c: any[]) => c[1]);
    expect(searched).toEqual([NATIVE_ISSUE, 752]);
    // Both aliases answered PR 10; the caller sees it once.
    expect(prs.map((p: any) => p.number)).toEqual([10]);
  });

  it("queries merged PRs exactly once for a ref that was never imported", async () => {
    mockForgejo.listMergedPRsForIssue.mockReset();
    mockForgejo.listMergedPRsForIssue.mockResolvedValue([]);

    await listMergedPRsForIssue("org/repo", 752);

    expect(mockForgejo.listMergedPRsForIssue).toHaveBeenCalledTimes(1);
  });

  it("finds duplicate markers written against the pre-import number", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    mockForgejo.listDuplicateIssuesOf.mockReset();
    mockForgejo.listDuplicateIssuesOf.mockImplementation(async (_repo: string, ref: unknown) => ref === 7
      ? [{ number: 77, title: "forge dup", body: "", labels: [], author: { login: "stjohnb" }, updatedAt: "2026-01-01T00:00:00Z" }]
      : []);

    expect((await listDuplicateIssuesOf("org/repo", NATIVE_ISSUE)).map((i) => i.number)).toEqual([77]);
    expect(mockForgejo.listDuplicateIssuesOf).toHaveBeenCalledTimes(2);
  });

  it("looks for duplicate markers exactly once for a ref that was never imported", async () => {
    mockForgejo.listDuplicateIssuesOf.mockReset();
    mockForgejo.listDuplicateIssuesOf.mockResolvedValue([]);

    await listDuplicateIssuesOf("org/repo", 7);

    expect(mockForgejo.listDuplicateIssuesOf).toHaveBeenCalledTimes(1);
  });

  it("cross-references a `Part of #7` body from the native id", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    mockForgejo.listPRs.mockReset();
    mockForgejo.listPRs.mockResolvedValue([
      { number: 11, title: "phase 2", headRefName: "claws/issue-7-x", baseRefName: "main", labels: [], author: { login: "claws" }, body: "Part of #7" },
      // `#70` is a different issue, and a bare-number match would claim it.
      { number: 12, title: "other", headRefName: "other", baseRefName: "main", labels: [], author: { login: "stjohnb" }, body: "Part of #70" },
    ]);
    mockForgejo.searchClosedPulls.mockReset();
    mockForgejo.searchClosedPulls.mockResolvedValue([]);

    const refs = await listPRsCrossReferencingIssue("org/repo", NATIVE_ISSUE);

    expect(refs.map((p) => p.number)).toEqual([11]);
  });

  it("searches merged PRs under every alias, keeping only a `#7` that is not `#70`", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    mockForgejo.listPRs.mockReset();
    mockForgejo.listPRs.mockResolvedValue([]);
    mockForgejo.searchClosedPulls.mockReset();
    mockForgejo.searchClosedPulls.mockImplementation(async (_repo: string, q: string) => q === "7"
      ? [
        { number: 31, title: "phase 1", body: "Part of #7", user: { login: "claws" }, pull_request: { merged: true } },
        { number: 32, title: "other", body: "Part of #70", user: { login: "claws" }, pull_request: { merged: true } },
      ]
      : []);

    const refs = await listPRsCrossReferencingIssue("org/repo", NATIVE_ISSUE);

    expect(refs.map((p) => [p.number, p.state])).toEqual([[31, "merged"]]);
    expect(mockForgejo.searchClosedPulls.mock.calls.map((c) => c[1]).sort()).toEqual(["7", NATIVE_ISSUE].sort());
  });

  it("does not read another repo's `other/repo#7` as this repo's #7", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    mockForgejo.listPRs.mockReset();
    mockForgejo.listPRs.mockResolvedValue([
      { number: 13, title: "unrelated", headRefName: "other", baseRefName: "main", labels: [], author: { login: "stjohnb" }, body: "Part of St-John-Software/other-repo#7" },
    ]);
    mockForgejo.searchClosedPulls.mockReset();
    mockForgejo.searchClosedPulls.mockResolvedValue([]);

    expect(await listPRsCrossReferencingIssue("org/repo", NATIVE_ISSUE)).toEqual([]);
  });

  it("prefers the canonical ref's PR when both a pre- and post-import branch are open", async () => {
    await recordImport("org/repo", 7, NATIVE_ISSUE);
    // Both aliases have an open PR: alias order decides, canonical ref first.
    mockForgejo.getOpenPRForIssue.mockReset();
    mockForgejo.getOpenPRForIssue.mockImplementation(async (_repo: string, ref: unknown) => ref === 7
      ? { number: 5, title: "old", headRefName: "claws/issue-7-abc1", baseRefName: "main", labels: [], author: { login: "bot" } }
      : { number: 6, title: "new", headRefName: `claws/issue-${NATIVE_ISSUE}-abc2`, baseRefName: "main", labels: [], author: { login: "bot" } });

    expect((await getOpenPRForIssue("org/repo", NATIVE_ISSUE))?.number).toBe(6);
  });
});

describe("PR state store hook (src/pr-state.ts)", () => {
  beforeEach(async () => {
    clearApiCache();
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.getClawsPr).mockClear();
    vi.mocked(dbMod.upsertClawsPr).mockClear();
    vi.mocked(dbMod.listClawsPrs).mockClear();
    vi.mocked(dbMod.getClawsPr).mockResolvedValue(null);
    vi.mocked(dbMod.listClawsPrs).mockResolvedValue([]);
    mockForgejo.addLabel.mockReset();
    mockForgejo.addLabel.mockResolvedValue(undefined);
    mockForgejo.removeLabel.mockReset();
    mockForgejo.removeLabel.mockResolvedValue(true);
    mockForgejo.createPR.mockReset();
    mockForgejo.createPR.mockResolvedValue(321);
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    repo: "org/repo", prNumber: 7, issueId: null, phase: null, headSha: null, observedAt: null,
    stage: "awaiting-review", ciStatus: null, mergeableState: null, reviewVerdict: null, reviewedSha: null,
    mergeApprovedBy: null, mergeApprovedAt: null, manualActionReason: null, needsHumanReview: false,
    ciBlockedReason: null, createdAt: "", updatedAt: "", ...overrides,
  });

  it("addLabel mirrors a PR state label into an existing row", async () => {
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.getClawsPr).mockResolvedValue(row() as never);
    await addLabel("org/repo", 7, "Claws Problematic");
    expect(dbMod.getClawsPr).toHaveBeenCalledWith("org/repo", 7);
    expect(dbMod.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, { stage: "problematic" });
  });

  it("addLabel writes no row when none exists (the ref is an issue)", async () => {
    const dbMod = await import("./db.js");
    await addLabel("org/repo", 7, "Needs LGTM");
    expect(dbMod.getClawsPr).toHaveBeenCalledWith("org/repo", 7);
    expect(dbMod.upsertClawsPr).not.toHaveBeenCalled();
  });

  it("addLabel does not touch the store for a routing label, nor for Ready or Automerge (#clw_01M5VW14RKAAGS6VZ5PCKQXB9F)", async () => {
    const dbMod = await import("./db.js");
    for (const label of ["Priority", "Ready", "Automerge"]) await addLabel("org/repo", 7, label);
    expect(dbMod.getClawsPr).not.toHaveBeenCalled();
  });

  it("removeLabel mirrors the removal, including the already-absent exit", async () => {
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.getClawsPr).mockResolvedValue(row({ stage: "problematic" }) as never);
    expect(await removeLabel("org/repo", 7, "Claws Problematic")).toBe(true);
    expect(dbMod.upsertClawsPr).toHaveBeenCalledWith("org/repo", 7, { stage: "awaiting-review" });
  });

  it("removeLabel does not mirror a removal it could not confirm", async () => {
    const dbMod = await import("./db.js");
    mockForgejo.removeLabel.mockResolvedValue(false);
    expect(await removeLabel("org/repo", 7, "Ready")).toBe(false);
    expect(dbMod.getClawsPr).not.toHaveBeenCalled();
  });

  it("a failing row write never fails the label write for a non-gating label", async () => {
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.getClawsPr).mockRejectedValue(new Error("db down"));
    await expect(addLabel("org/repo", 7, "Ready")).resolves.toBeUndefined();
  });

  it("a failing row write fails addLabel for a gating label", async () => {
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.getClawsPr).mockResolvedValue(row() as never);
    vi.mocked(dbMod.upsertClawsPr).mockRejectedValueOnce(new Error("db down"));
    await expect(addLabel("org/repo", 7, "Needs LGTM")).rejects.toThrow("db down");
  });

  it("createPR inserts the row, then mirrors the state labels it was created with", async () => {
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.getClawsPr).mockResolvedValue(row({ prNumber: 321, stage: "opened" }) as never);
    const n = await createPR("org/repo", "feature", "t", "b", { labels: ["Needs LGTM", "Priority"] });
    expect(n).toBe(321);
    expect(dbMod.upsertClawsPr).toHaveBeenNthCalledWith(1, "org/repo", 321, { stage: "opened", title: expect.any(String) });
    expect(dbMod.upsertClawsPr).toHaveBeenNthCalledWith(2, "org/repo", 321, { needsHumanReview: true });
    expect(dbMod.upsertClawsPr).toHaveBeenCalledTimes(2);
  });

  // A lost row insert must not silently leave a docs PR (or any
  // gating-labelled PR) approval-exempt: the row is the only place
  // `needsHumanReview` lives, and the dispatcher's seed never sets it.
  it("createPR fails when the row insert fails and a gating label was requested", async () => {
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.upsertClawsPr).mockRejectedValueOnce(new Error("db down"));
    await expect(createPR("org/repo", "feature", "t", "b", { labels: ["Needs LGTM"] }))
      .rejects.toThrow(PRLabelError);
  });

  it("createPR does not fail when the row insert fails and no gating label was requested", async () => {
    const dbMod = await import("./db.js");
    vi.mocked(dbMod.upsertClawsPr).mockRejectedValueOnce(new Error("db down"));
    await expect(createPR("org/repo", "feature", "t", "b", { labels: ["Ready"] })).resolves.toBe(321);
  });

  it("listPRs returns the parsed forge list untouched, with no store read", async () => {
    const dbMod = await import("./db.js");
    const listed = [
      { number: 5, title: "t", headRefName: "h", baseRefName: "main", labels: [{ name: "Ready" }], author: { login: "bot" }, headRefOid: "abc" },
    ];
    mockForgejo.listPRs.mockReset();
    mockForgejo.listPRs.mockResolvedValue(listed);
    vi.mocked(dbMod.listClawsPrs).mockResolvedValue([row({ prNumber: 5, stage: "problematic" })] as never);
    expect(await listPRs("org/list-untouched")).toEqual(listed);
    expect(dbMod.listClawsPrs).not.toHaveBeenCalled();
  });

  it("getPRMergeGate serves the forge labels, with no store read", async () => {
    const dbMod = await import("./db.js");
    mockForgejo.getPRMergeGate.mockReset();
    mockForgejo.getPRMergeGate.mockResolvedValue({
      state: "OPEN", headSha: "abc", labels: ["Automerge"], mergeable: "MERGEABLE", checkStatus: "none", checksTotal: 0, checksHeld: 0,
    });
    const gate = await getPRMergeGate("org/repo", 7);
    expect(gate.labels).toEqual(["Automerge"]);
    expect(dbMod.getClawsPr).not.toHaveBeenCalled();
  });
});

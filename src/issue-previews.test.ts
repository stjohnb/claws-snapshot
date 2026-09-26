import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockGetIssuePreviewSummaryUrl, mockIsForgejoRepo } = vi.hoisted(() => ({
  mockGetIssuePreviewSummaryUrl: vi.fn(() => null as string | null),
  mockIsForgejoRepo: vi.fn(() => false),
}));
vi.mock("./config.js", () => ({
  LABELS: { refined: "Refined", backlog: "Backlog", clawsIgnore: "Claws Ignore" },
  prUrl: (repo: string, n: number) => `https://github.com/${repo}/pull/${n}`,
  getIssuePreviewSummaryUrl: mockGetIssuePreviewSummaryUrl,
  isForgejoRepo: mockIsForgejoRepo,
}));

const { mockGh } = vi.hoisted(() => ({
  mockGh: {
    listPRs: vi.fn(),
    isForkPR: (pr: { isCrossRepository?: boolean }) => pr.isCrossRepository === true,
    isClawsComment: (body: string) => /\*— Automated by Claws(?:\s*·\s*[\w\s-]+)?\s*—\*/.test(body),
    getIssueState: vi.fn(),
    getIssueComments: vi.fn(),
    getPRHeadSHA: vi.fn(),
    getSelfLoginForRepo: vi.fn(),
    closePR: vi.fn(),
    commentOnIssue: vi.fn(),
    editIssueComment: vi.fn(),
    listBranchesByPrefix: vi.fn(),
    deleteRemoteBranch: vi.fn(),
    isRefAlreadyGone: vi.fn(),
  },
}));
vi.mock("./github.js", () => mockGh);

const { mockDb, mockResolveTrackerId } = vi.hoisted(() => ({
  mockDb: { listOpenClawsPrsForIssue: vi.fn() },
  mockResolveTrackerId: vi.fn(),
}));
vi.mock("./db.js", () => mockDb);
vi.mock("./planned-prs.js", () => ({ resolveTrackerId: mockResolveTrackerId }));

import {
  issueRefFromPreviewBranch,
  findIssuePreviewPR,
  findIssuePreview,
  previewSummaryUrl,
  fetchPreviewSummary,
  formatPreviewMarker,
  parsePreviewMarker,
  selectResultsComment,
  buildPreviewBody,
  syncIssuePreview,
  syncPreviewsForIssue,
  buildPreviewPromptSection,
  MAX_RESULTS_CHARS,
  PREVIEW_HEADER,
  type PreviewMarker,
  type IssuePreview,
} from "./issue-previews.js";
import { resetImportedRefsForTest, setImportedRef } from "./imported-refs-index.js";

const REPO = "St-John-Software/3d-models";
const ID = "clw_01M3855REJ979V90Q4VY77NPNE";
const HEAD = "b7639207aaaabbbbccccddddeeeeffff00001111";
const CLAWS = "*— Automated by Claws · Planner —*";
const BRANCH = `claws/preview-issue-${ID}`;

function pr(overrides: Partial<{ number: number; headRefName: string; isCrossRepository: boolean }> = {}) {
  return {
    number: overrides.number ?? 546,
    title: "[do not merge] preview",
    headRefName: overrides.headRefName ?? `claws/preview-issue-${ID}`,
    baseRefName: "main",
    labels: [{ name: "Claws Ignore" }],
    author: { login: "clawsstjohn[bot]" },
    isCrossRepository: overrides.isCrossRepository ?? false,
  };
}

function prPreview(overrides: Parameters<typeof pr>[0] = {}): IssuePreview {
  return { kind: "pr", pr: pr(overrides) as never };
}

function branchPreview(overrides: Partial<{ branch: string; headSha: string }> = {}): IssuePreview {
  return { kind: "branch", branch: overrides.branch ?? BRANCH, headSha: overrides.headSha ?? HEAD };
}

const RESULTS = `## 🔍 Model Preview\n\nRendered at ${HEAD.slice(0, 7)}\n\n[viewer](https://example.test/v)`;

function previewComment(id: string, marker: PreviewMarker) {
  return { id, login: "claws", body_html: "", body: `${CLAWS}\n\n${PREVIEW_HEADER}\n\nstuff\n\n${formatPreviewMarker(marker)}` };
}

describe("issueRefFromPreviewBranch", () => {
  it("parses numeric and native ids, case-insensitively", () => {
    expect(issueRefFromPreviewBranch("claws/preview-issue-42")).toBe(42);
    expect(issueRefFromPreviewBranch(`claws/preview-issue-${ID.toLowerCase()}`)).toBe(ID);
    expect(issueRefFromPreviewBranch(`Claws/Preview-Issue-${ID}`)).toBe(ID);
  });

  it("rejects other branches", () => {
    expect(issueRefFromPreviewBranch("claws/issue-42-abcd")).toBeNull();
    expect(issueRefFromPreviewBranch("claws/preview-issue-")).toBeNull();
    expect(issueRefFromPreviewBranch("claws/preview-issue-42-extra")).toBeNull();
    expect(issueRefFromPreviewBranch("feature/claws/preview-issue-42")).toBeNull();
  });
});

describe("findIssuePreviewPR", () => {
  beforeEach(() => resetImportedRefsForTest());

  it("finds the PR by branch, ignoring forks and other issues", async () => {
    mockGh.listPRs.mockResolvedValue([
      pr({ number: 1, headRefName: "claws/preview-issue-7" }),
      pr({ number: 2, isCrossRepository: true }),
      pr({ number: 3 }),
    ]);
    expect((await findIssuePreviewPR(REPO, ID))?.number).toBe(3);
    expect(await findIssuePreviewPR(REPO, 8)).toBeNull();
  });

  it("matches the forge number an imported issue came from", async () => {
    setImportedRef(REPO, 12, ID);
    mockGh.listPRs.mockResolvedValue([pr({ number: 5, headRefName: "claws/preview-issue-12" })]);
    expect((await findIssuePreviewPR(REPO, ID))?.number).toBe(5);
  });
});

describe("findIssuePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetImportedRefsForTest();
    mockGetIssuePreviewSummaryUrl.mockReturnValue(null);
    mockIsForgejoRepo.mockReturnValue(false);
    mockGh.listPRs.mockResolvedValue([]);
  });

  it("prefers an open PR over a bare branch", async () => {
    mockGetIssuePreviewSummaryUrl.mockReturnValue("https://example.test/{issue}/{sha8}/preview-summary.json");
    mockGh.listPRs.mockResolvedValue([pr()]);
    mockGh.listBranchesByPrefix.mockResolvedValue([{ name: BRANCH, sha: HEAD }]);
    const found = await findIssuePreview(REPO, ID);
    expect(found).toEqual({ kind: "pr", pr: pr() });
    expect(mockGh.listBranchesByPrefix).not.toHaveBeenCalled();
  });

  it("falls back to a bare branch when the repo sets the template and no PR is open, matching aliases case-insensitively", async () => {
    mockGetIssuePreviewSummaryUrl.mockReturnValue("https://example.test/{issue}/{sha8}/preview-summary.json");
    setImportedRef(REPO, 12, ID);
    mockGh.listBranchesByPrefix.mockResolvedValue([{ name: `claws/preview-issue-12`, sha: HEAD }]);
    expect(await findIssuePreview(REPO, ID)).toEqual({ kind: "branch", branch: "claws/preview-issue-12", headSha: HEAD });
  });

  it("returns null and never lists branches when the repo has no template", async () => {
    const found = await findIssuePreview(REPO, ID);
    expect(found).toBeNull();
    expect(mockGh.listBranchesByPrefix).not.toHaveBeenCalled();
  });

  it("warns and returns null for a Forgejo repo that sets the template", async () => {
    mockGetIssuePreviewSummaryUrl.mockReturnValue("https://example.test/{issue}/{sha8}/preview-summary.json");
    mockIsForgejoRepo.mockReturnValue(true);
    expect(await findIssuePreview(REPO, ID)).toBeNull();
    expect(mockGh.listBranchesByPrefix).not.toHaveBeenCalled();
  });
});

describe("previewSummaryUrl", () => {
  it("substitutes the branch suffix verbatim and the head's first 8 characters", () => {
    const url = previewSummaryUrl("https://example.test/{issue}/{sha8}/preview-summary.json", BRANCH, HEAD);
    expect(url).toBe(`https://example.test/${ID}/${HEAD.slice(0, 8)}/preview-summary.json`);
  });
});

describe("fetchPreviewSummary", () => {
  const URL = "https://example.test/preview-summary.json";

  it("returns the parsed summary on 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ markdown: "# hi", viewer_url: "https://example.test/v" }) }));
    expect(await fetchPreviewSummary(URL)).toEqual({ markdown: "# hi", viewerUrl: "https://example.test/v" });
    vi.unstubAllGlobals();
  });

  it("returns null on 404", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    expect(await fetchPreviewSummary(URL)).toBeNull();
    vi.unstubAllGlobals();
  });

  it("throws on another non-2xx status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 500, ok: false }));
    await expect(fetchPreviewSummary(URL)).rejects.toThrow("HTTP 500");
    vi.unstubAllGlobals();
  });

  it("throws on an unparsable body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ no_markdown: true }) }));
    await expect(fetchPreviewSummary(URL)).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("marker", () => {
  it("round-trips a numbered PR", () => {
    const m: PreviewMarker = { repo: REPO, pr: 546, head: HEAD, results: "0123456789ab", status: "current" };
    expect(parsePreviewMarker(`x\n${formatPreviewMarker(m)}\n`)).toEqual(m);
    expect(parsePreviewMarker(formatPreviewMarker({ ...m, results: "none", status: "retired" }))).toEqual({ ...m, results: "none", status: "retired" });
    expect(parsePreviewMarker("no marker")).toBeNull();
  });

  it("round-trips a PR-less branch preview as pr=none", () => {
    const m: PreviewMarker = { repo: REPO, pr: null, head: HEAD, results: "none", status: "current" };
    const formatted = formatPreviewMarker(m);
    expect(formatted).toContain("pr=none");
    expect(parsePreviewMarker(formatted)).toEqual(m);
  });
});

describe("selectResultsComment", () => {
  it("picks the newest bot comment that is not Claws' own or a human's", () => {
    const comments = [
      { id: 1, login: "github-actions[bot]", body: "old results", body_html: "" },
      { id: 2, login: "github-actions", body: "newer results", body_html: "" },
      { id: 3, login: "clawsstjohn[bot]", body: `${CLAWS}\n\nreview`, body_html: "" },
      { id: 4, login: "stjohnb", body: "looks good", body_html: "" },
      { id: 5, login: "self[bot]", body: "self", body_html: "" },
    ];
    expect(selectResultsComment(comments, "self[bot]")?.id).toBe(2);
    expect(selectResultsComment(comments.slice(2, 4), "self[bot]")).toBeNull();
  });
});

describe("buildPreviewBody", () => {
  const base = { repo: REPO, pr: 546, headSha: HEAD, branch: `claws/preview-issue-${ID}` };

  it("says the results are current when they name the head", () => {
    const body = buildPreviewBody({ ...base, results: RESULTS });
    expect(body.startsWith(PREVIEW_HEADER)).toBe(true);
    expect(body).toContain("Results below are for head `b763920`");
    expect(body).toContain(RESULTS);
    expect(body).not.toContain("## Implementation Plan");
    expect(parsePreviewMarker(body)?.status).toBe("current");
  });

  it("says pending when the results predate the head", () => {
    expect(buildPreviewBody({ ...base, results: "Rendered at 1234567" })).toContain("predate head `b763920`; its render is pending");
    expect(buildPreviewBody({ ...base, results: null })).toContain("No results have been posted on the PR yet");
  });

  it("truncates long results with a link to the PR", () => {
    const body = buildPreviewBody({ ...base, results: "x".repeat(MAX_RESULTS_CHARS + 500) });
    expect(body).not.toContain("x".repeat(MAX_RESULTS_CHARS + 1));
    expect(body).toContain("truncated; see the full results on [the PR](https://github.com/St-John-Software/3d-models/pull/546)");
  });

  it("builds a retirement record", () => {
    const body = buildPreviewBody({ ...base, results: null, retired: { reason: "refined", at: new Date("2026-09-24T00:00:00Z"), resultsHash: "none" } });
    expect(body).toContain("Retired on 2026-09-24T00:00:00.000Z");
    expect(body).toContain("approved (Refined)");
    expect(parsePreviewMarker(body)?.status).toBe("retired");
  });

  describe("branch variant (pr: null)", () => {
    const branchBase = { repo: REPO, pr: null, headSha: HEAD, branch: BRANCH };

    it("says the results are current and links the viewer", () => {
      const body = buildPreviewBody({ ...branchBase, results: "# Render\n\nlooks good", viewerUrl: "https://example.test/v" });
      expect(body).toContain("no PR is open for it");
      expect(body).toContain("Results below are for head `b763920`");
      expect(body).toContain("[View the render](https://example.test/v)");
      expect(body).toContain("looks good");
      expect(parsePreviewMarker(body)).toMatchObject({ pr: null, status: "current" });
    });

    it("says pending when no summary exists yet", () => {
      const body = buildPreviewBody({ ...branchBase, results: null });
      expect(body).toContain("No results found for head `b763920` yet");
      expect(body).toContain("check the branch's workflow runs");
    });

    it("builds a branch retirement record", () => {
      const body = buildPreviewBody({
        ...branchBase, results: null,
        retired: { reason: "closed", at: new Date("2026-09-24T00:00:00Z"), resultsHash: "none" },
      });
      expect(body).toContain(`preview branch \`${BRANCH}\` was deleted because the issue was closed`);
      expect(parsePreviewMarker(body)).toMatchObject({ pr: null, status: "retired" });
    });
  });
});

describe("buildPreviewPromptSection", () => {
  it("names the PR, branch, head and refresh rule", () => {
    const text = buildPreviewPromptSection(REPO, prPreview(), HEAD, ID);
    expect(text).toContain("## Issue preview");
    expect(text).toContain(`PR ${REPO}#546 on branch \`claws/preview-issue-${ID}\` at head \`${HEAD}\``);
    expect(text).toContain(`scripts/request-issue-preview.sh ${ID} <files>`);
    expect(text).toContain("A change to plan prose alone never re-runs it.");
  });

  it("names the branch, head and no-PR text for a branch preview", () => {
    const text = buildPreviewPromptSection(REPO, branchPreview(), HEAD, ID);
    expect(text).toContain("## Issue preview");
    expect(text).toContain(`branch \`${BRANCH}\` at head \`${HEAD}\`, with no PR open for it`);
    expect(text).toContain("do not run the repository's `--cleanup` step");
    expect(text).toContain("do not delete the branch");
    expect(text).toContain(`scripts/request-issue-preview.sh ${ID} <files>`);
  });
});

describe("syncIssuePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetImportedRefsForTest();
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });
    mockGh.getPRHeadSHA.mockResolvedValue(HEAD);
    mockGh.getSelfLoginForRepo.mockResolvedValue("clawsstjohn[bot]");
    mockResolveTrackerId.mockImplementation(async (_repo: string, ref: unknown) => String(ref));
    mockDb.listOpenClawsPrsForIssue.mockResolvedValue([]);
    mockGetIssuePreviewSummaryUrl.mockReturnValue(null);
    mockIsForgejoRepo.mockReturnValue(false);
    mockGh.getIssueComments.mockImplementation(async (_repo: string, ref: unknown) =>
      ref === 546 ? [{ id: 9, login: "github-actions[bot]", body: RESULTS, body_html: "" }] : []);
  });

  it("posts a preview comment when none exists", async () => {
    await syncIssuePreview(REPO, ID, prPreview());
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    const [repo, ref, body, opts] = mockGh.commentOnIssue.mock.calls[0]!;
    expect([repo, ref, opts]).toEqual([REPO, ID, { agentName: "Planner" }]);
    expect(body).toContain(RESULTS);
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockGh.closePR).not.toHaveBeenCalled();
  });

  it("writes nothing when the marker tuple is unchanged", async () => {
    await syncIssuePreview(REPO, ID, prPreview());
    const posted = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    const marker = parsePreviewMarker(posted)!;
    mockGh.commentOnIssue.mockClear();
    mockGh.getIssueComments.mockImplementation(async (_repo: string, ref: unknown) =>
      ref === 546 ? [{ id: 9, login: "github-actions[bot]", body: RESULTS, body_html: "" }] : [previewComment("clwc_1", marker)]);
    await syncIssuePreview(REPO, ID, prPreview());
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("edits the existing comment when the head changes", async () => {
    const stale: PreviewMarker = { repo: REPO, pr: 546, head: "0000000aaaa", results: "none", status: "current" };
    mockGh.getIssueComments.mockImplementation(async (_repo: string, ref: unknown) =>
      ref === 546 ? [] : [previewComment("clwc_1", stale)]);
    await syncIssuePreview(REPO, ID, prPreview());
    expect(mockGh.editIssueComment).toHaveBeenCalledWith(REPO, "clwc_1", expect.stringContaining(`head=${HEAD}`), { agentName: "Planner" });
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["Refined", { state: "OPEN", labels: ["Refined"] }, [], "approved (Refined)"],
    ["an open PR", { state: "OPEN", labels: [] }, [{ repo: REPO, prNumber: 600 }], "approved (Refined)"],
    ["closed", { state: "CLOSED", labels: [] }, [], "the issue was closed"],
  ])("closes the PR and records the retirement on %s", async (_name, state, openPrs, why) => {
    const current: PreviewMarker = { repo: REPO, pr: 546, head: HEAD, results: "0123456789ab", status: "current" };
    mockGh.getIssueState.mockResolvedValue({ stateReason: null, ...state });
    mockDb.listOpenClawsPrsForIssue.mockResolvedValue(openPrs);
    mockGh.getIssueComments.mockResolvedValue([previewComment("clwc_1", current)]);
    await syncIssuePreview(REPO, ID, prPreview());
    expect(mockGh.closePR).toHaveBeenCalledWith(REPO, 546);
    const body = mockGh.editIssueComment.mock.calls[0]![2] as string;
    expect(body).toContain("Retired on");
    expect(body).toContain(why);
    expect(parsePreviewMarker(body)).toMatchObject({ status: "retired", results: "0123456789ab" });
  });

  it("writes the retirement record before closing the PR", async () => {
    const current: PreviewMarker = { repo: REPO, pr: 546, head: HEAD, results: "0123456789ab", status: "current" };
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
    mockGh.getIssueComments.mockResolvedValue([previewComment("clwc_1", current)]);
    const calls: string[] = [];
    mockGh.editIssueComment.mockImplementation(async () => { calls.push("write"); });
    mockGh.closePR.mockImplementation(async () => { calls.push("close"); });
    await syncIssuePreview(REPO, ID, prPreview());
    expect(calls).toEqual(["write", "close"]);
  });

  it("retries only the close, without writing again, once the record is already retired", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
    mockGh.closePR.mockRejectedValueOnce(new Error("network error"));
    mockGh.getIssueComments.mockResolvedValue([]);

    await expect(syncIssuePreview(REPO, ID, prPreview())).rejects.toThrow("network error");
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    const retired = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(parsePreviewMarker(retired)?.status).toBe("retired");

    mockGh.commentOnIssue.mockClear();
    mockGh.getIssueComments.mockResolvedValue([previewComment("clwc_1", parsePreviewMarker(retired)!)]);
    await syncIssuePreview(REPO, ID, prPreview());
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockGh.closePR).toHaveBeenCalledTimes(2);
  });

  it.each(["Backlog", "Claws Ignore"])("leaves a %s issue untouched", async (label) => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: null, labels: [label, "Refined"] });
    await syncIssuePreview(REPO, ID, prPreview());
    expect(mockGh.closePR).not.toHaveBeenCalled();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
  });

  it("follows an imported forge number to the native issue", async () => {
    setImportedRef(REPO, 12, ID);
    await syncIssuePreview(REPO, 12, prPreview({ headRefName: "claws/preview-issue-12" }));
    expect(mockGh.getIssueState).toHaveBeenCalledWith(REPO, ID);
    expect(mockGh.commentOnIssue.mock.calls[0]![1]).toBe(ID);
  });

  it("does nothing when the issue cannot be read", async () => {
    mockGh.getIssueState.mockRejectedValue(new Error("404"));
    await expect(syncIssuePreview(REPO, ID, prPreview())).resolves.toBeUndefined();
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
  });
});

describe("syncIssuePreview (branch previews)", () => {
  const TEMPLATE = "https://example.test/{issue}/{sha8}/preview-summary.json";

  beforeEach(() => {
    vi.clearAllMocks();
    resetImportedRefsForTest();
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Ready"] });
    mockResolveTrackerId.mockImplementation(async (_repo: string, ref: unknown) => String(ref));
    mockDb.listOpenClawsPrsForIssue.mockResolvedValue([]);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGetIssuePreviewSummaryUrl.mockReturnValue(TEMPLATE);
    mockIsForgejoRepo.mockReturnValue(false);
  });

  it("mirrors the fetched markdown and links the viewer on HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200, ok: true, json: async () => ({ markdown: RESULTS, viewer_url: "https://example.test/v" }) }));
    await syncIssuePreview(REPO, ID, branchPreview());
    expect(mockGh.commentOnIssue).toHaveBeenCalledTimes(1);
    const body = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(body).toContain(RESULTS);
    expect(body).toContain("[View the render](https://example.test/v)");
    expect(mockGh.deleteRemoteBranch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("says pending when the summary 404s", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 404, ok: false }));
    await syncIssuePreview(REPO, ID, branchPreview());
    const body = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(body).toContain("No results found");
    vi.unstubAllGlobals();
  });

  it("writes the retirement record, then deletes the branch, once the plan is decided", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
    const calls: string[] = [];
    mockGh.commentOnIssue.mockImplementation(async () => { calls.push("write"); });
    mockGh.deleteRemoteBranch.mockImplementation(async () => { calls.push("delete"); });
    await syncIssuePreview(REPO, ID, branchPreview());
    expect(calls).toEqual(["write", "delete"]);
    const body = mockGh.commentOnIssue.mock.calls[0]![2] as string;
    expect(body).toContain("was deleted because the issue was approved");
  });

  it("skips the write when already retired for the same head", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "OPEN", stateReason: null, labels: ["Refined"] });
    const retired: PreviewMarker = { repo: REPO, pr: null, head: HEAD, results: "none", status: "retired" };
    mockGh.getIssueComments.mockResolvedValue([previewComment("clwc_1", retired)]);
    await syncIssuePreview(REPO, ID, branchPreview());
    expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
    expect(mockGh.editIssueComment).not.toHaveBeenCalled();
    expect(mockGh.deleteRemoteBranch).toHaveBeenCalledWith(REPO, BRANCH);
  });

  it("treats a delete 404 as done", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: null, labels: [] });
    mockGh.deleteRemoteBranch.mockRejectedValue(new Error("HTTP 404: Reference does not exist"));
    mockGh.isRefAlreadyGone.mockReturnValueOnce(true);
    await expect(syncIssuePreview(REPO, ID, branchPreview())).resolves.toBeUndefined();
  });

  it("rethrows a delete failure that is not already-gone", async () => {
    mockGh.getIssueState.mockResolvedValue({ state: "CLOSED", stateReason: null, labels: [] });
    mockGh.deleteRemoteBranch.mockRejectedValue(new Error("HTTP 403: forbidden"));
    mockGh.isRefAlreadyGone.mockReturnValueOnce(false);
    await expect(syncIssuePreview(REPO, ID, branchPreview())).rejects.toThrow(/403/);
  });
});

describe("syncPreviewsForIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetImportedRefsForTest();
    mockGetIssuePreviewSummaryUrl.mockReturnValue(null);
    mockIsForgejoRepo.mockReturnValue(false);
  });

  it("checks each repo once and keeps going past a failure", async () => {
    mockGh.listPRs.mockImplementation(async (repo: string) => {
      if (repo === "o/broken") throw new Error("boom");
      return [];
    });
    await expect(syncPreviewsForIssue("o/a", ID, ["o/broken", "O/A", "o/b"])).resolves.toBeUndefined();
    expect(mockGh.listPRs.mock.calls.map((c) => c[0])).toEqual(["o/a", "o/broken", "o/b"]);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    ALLOWED_ACTORS: ["stjohnb"] as readonly string[],
  },
}));

vi.mock("../config.js", () => ({
  LABELS: { clawsIgnore: "Claws Ignore" },
  SELF_REPO: "o/claws",
  forgeIssueUrl: (repo: string, number: number | string) => `https://github.com/${repo}/issues/${number}`,
  get ALLOWED_ACTORS() { return mockConfig.ALLOWED_ACTORS; },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

const { mockReportError } = vi.hoisted(() => ({ mockReportError: vi.fn() }));
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));

const { mockGh, mockClawsIssues, mockDb } = vi.hoisted(() => ({
  mockGh: {
    listOpenIssues: vi.fn(),
    listPRs: vi.fn(),
    openIssuesMayBeTruncated: vi.fn(),
    getOpenPRForIssue: vi.fn(),
    listOpenPRsForIssue: vi.fn(),
    getIssueComments: vi.fn(),
    getCommentReactions: vi.fn(),
    getSelfLoginForRepo: vi.fn(),
    commentOnIssue: vi.fn(),
    closeIssue: vi.fn(),
    listMergedPRsForIssue: vi.fn(),
    listPRsCrossReferencingIssue: vi.fn(),
    listDuplicateIssuesOf: vi.fn(),
    invalidatePRList: vi.fn(),
    getIssueAttachments: vi.fn(),
    isAllowedActor: vi.fn(),
    // The real predicate: `clw_` plus a 26-character Crockford ULID. A looser
    // `startsWith("clw_")` would pass ids that fall through to a 404-ing `gh`
    // call in production.
    isNativeIssue: (ref: unknown) => typeof ref === "string" && /^clw_[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/.test(ref),
    normalizeBotLogin: (login: string) => (login.startsWith("app/") ? `${login.slice(4)}[bot]` : login),
  },
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    createIssue: vi.fn(),
    commentOnIssue: vi.fn(),
    editIssueComment: vi.fn(),
    addReaction: vi.fn(),
    removeLabel: vi.fn(),
    dashboardIssueUrl: (id: string) => `https://claws.example/issues/${id}`,
  },
  // `imported-refs.ts` is the real module here, not a mock: it is the whole
  // point of the change, and stubbing it would test the importer against an
  // index that never records anything.
  mockDb: {
    listQueuedWork: vi.fn(),
    recordImportedIssue: vi.fn(),
    listImportedIssues: vi.fn(),
    createShadowIssue: vi.fn(),
    promoteShadowIssue: vi.fn(),
    listClawsIssueAttachments: vi.fn(),
  },
}));

// `isClawsComment` comes from the real leaf module, not a hand-rolled copy:
// `restampPlan`, `plan-parser.findPlanComment` and `phase-coverage`
// .parsePhaseClaims all read it off this façade, and a copy that misses the
// `· <agent name> —*` form every plan comment actually carries would test the
// whole plan path against a header no agent emits.
vi.mock("../github.js", async () => {
  const markerText = await vi.importActual<typeof import("../marker-text.js")>("../marker-text.js");
  return { ...mockGh, isClawsComment: markerText.isClawsComment, stripClawsMarker: markerText.stripClawsMarker };
});
vi.mock("../claws-issues.js", () => mockClawsIssues);
vi.mock("../db.js", () => mockDb);

// The file copy (#3289): the extractors are the real ones the prompt pipeline
// uses, the download and the store are stubbed.
const { mockFetchIssueFile, mockAttachments } = vi.hoisted(() => ({
  mockFetchIssueFile: vi.fn(),
  mockAttachments: {
    storeIssueAttachment: vi.fn(),
    deleteIssueAttachment: vi.fn(),
    attachmentUrl: (row: { id: string; issue_id: string | null; filename: string }) =>
      `/issues/${row.issue_id ?? "new"}/attachments/${row.id}/${row.filename}`,
    MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
  },
}));
vi.mock("../images.js", async () => {
  const actual = await vi.importActual<typeof import("../images.js")>("../images.js");
  return {
    extractImageUrls: actual.extractImageUrls,
    extractAttachmentUrls: actual.extractAttachmentUrls,
    fetchIssueFile: mockFetchIssueFile,
  };
});
vi.mock("../issue-attachments.js", () => mockAttachments);

const mockLoadApprovedRequirements = vi.hoisted(() => vi.fn().mockResolvedValue({ status: "none" }));
vi.mock("../approved-requirements.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../approved-requirements.js")>(),
  loadApprovedRequirements: mockLoadApprovedRequirements,
}));

/** An approved requirements record as `loadApprovedRequirements` returns it. */
const approvedRecord = (over: Partial<{ version: number; requirement: string }> = {}) => ({
  version: 2,
  title: "Record title",
  kind: "feature" as const,
  context: "Record context.",
  requirement: "Record requirement.",
  acceptanceCriteria: ["Criterion one"],
  outOfScope: ["Not this"],
  commentId: null,
  createdAt: "2026-09-24T00:00:00.000Z",
  approvedBy: "claws",
  approvedAt: "2026-09-24T01:00:00.000Z",
  ...over,
});

import * as log from "../log.js";
import { hasStepBackReconsiderMarker, issueContentHash, parsePlanBodyHash, parsePlanLastCommentId } from "../agents/issue-refiner.js";
import { AGENT_KINDS } from "../worker.js";
import { recordImport, resetImportedRefsForTest } from "../imported-refs.js";
import { run, importableIssues, importRepo, importedBody } from "./issue-importer.js";

const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const PLAN_COMMENT_ID = "clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD2";

const multiPhasePlan = [
  "*— Automated by Claws · Planner —*",
  "",
  "## Implementation Plan",
  "",
  "### PR 1: First",
  "Do one.",
  "",
  "### PR 2: Second",
  "Do two.",
  "",
  "### PR 3: Third",
  "Do three.",
].join("\n");

function forgeIssue(over: Partial<{ number: number; title: string; body: string; labels: string[]; login: string }> = {}) {
  return {
    number: over.number ?? 7,
    title: over.title ?? "Fix the thing",
    body: over.body ?? "It is broken.",
    labels: (over.labels ?? ["Priority"]).map((name) => ({ name })),
    author: { login: over.login ?? "stjohnb" },
  };
}

describe("issue-importer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listOpenIssues.mockResolvedValue([]);
    mockGh.listPRs.mockResolvedValue([]);
    mockGh.openIssuesMayBeTruncated.mockReturnValue(false);
    mockGh.getOpenPRForIssue.mockResolvedValue(null);
    mockGh.listOpenPRsForIssue.mockResolvedValue([]);
    mockDb.listQueuedWork.mockResolvedValue([]);
    mockDb.createShadowIssue.mockResolvedValue({ id: NATIVE_ID, created: false });
    mockDb.promoteShadowIssue.mockResolvedValue(true);
    mockDb.listClawsIssueAttachments.mockResolvedValue([]);
    mockDb.recordImportedIssue.mockResolvedValue(true);
    mockGh.getIssueComments.mockResolvedValue([]);
    mockGh.getCommentReactions.mockResolvedValue([]);
    mockGh.getSelfLoginForRepo.mockResolvedValue("clawsstjohn[bot]");
    mockGh.listMergedPRsForIssue.mockResolvedValue([]);
    mockGh.listPRsCrossReferencingIssue.mockResolvedValue([]);
    mockGh.listDuplicateIssuesOf.mockResolvedValue([]);
    mockGh.isAllowedActor.mockResolvedValue(true);
    mockGh.getIssueAttachments.mockResolvedValue([]);
    mockFetchIssueFile.mockResolvedValue({ error: "unexpected download" });
    let attachmentSeq = 0;
    mockAttachments.storeIssueAttachment.mockImplementation(async (issueId: string, name: string, _data: Buffer, contentType: string, uploader: string) => ({
      ok: true,
      row: { id: `cla_${String(++attachmentSeq).padStart(26, "0")}`, issue_id: issueId, filename: name, content_type: contentType, uploader_login: uploader },
    }));
    mockClawsIssues.createIssue.mockResolvedValue(NATIVE_ID);
    mockClawsIssues.commentOnIssue.mockResolvedValue("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDD");
    // `clearAllMocks` keeps implementations, so anything a test stubs with
    // `mockImplementation` and beforeEach does not re-stub has to be reset.
    mockClawsIssues.editIssueComment.mockReset();
    mockClawsIssues.removeLabel.mockReset();
    mockConfig.ALLOWED_ACTORS = ["stjohnb"];
    resetImportedRefsForTest();
  });

  describe("importableIssues", () => {
    it("skips native issues already in the tracker", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 }), { ...forgeIssue(), number: NATIVE_ID }]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([7]);
    });

    it("imports Claws Ignore issues like any other", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7, labels: ["Claws Ignore"] }), forgeIssue({ number: 8 })]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([7, 8]);
    });

    it("skips an issue with an open Claws PR", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 }), forgeIssue({ number: 8 })]);
      mockGh.getOpenPRForIssue.mockImplementation(async (_repo: string, n: number) => (n === 7 ? { number: 99 } : null));
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([8]);
    });

    it("skips an issue a human PR closes from its own branch", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 }), forgeIssue({ number: 8 })]);
      mockGh.listPRs.mockResolvedValue([{ number: 99, body: "Closes #7", headRefName: "stjohnb/fix" }]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([8]);
    });

    it("skips an issue with a queued or running work-queue row", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 }), forgeIssue({ number: 8 }), forgeIssue({ number: 9 })]);
      mockDb.listQueuedWork.mockResolvedValue([
        { kind: AGENT_KINDS.ISSUE_WORKER, repo: "o/r", item_number: 7, status: "running" },
        { kind: AGENT_KINDS.ISSUE_REFINER_PLAN, repo: "o/r", item_number: 8, status: "queued" },
        { kind: AGENT_KINDS.ISSUE_WORKER, repo: "o/other", item_number: 9, status: "queued" },
      ]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([9]);
    });

    it("does not confuse a queued PR work item with an issue of the same number", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
      mockDb.listQueuedWork.mockResolvedValue([
        { kind: AGENT_KINDS.PR_REVIEWER, repo: "o/r", item_number: 7, status: "running" },
      ]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([7]);
    });

    it("skips an issue already recorded in imported_issues", async () => {
      await recordImport("o/r", 7, NATIVE_ID);
      mockGh.listOpenIssues.mockResolvedValue([
        forgeIssue({ number: 7 }),
        forgeIssue({ number: 8 }),
        { ...forgeIssue(), number: NATIVE_ID, body: importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken.") },
      ]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([8]);
    });

    it("skips an issue whose native issue has since been closed", async () => {
      // The `open` listing no longer names it, which is "finished", not
      // "never happened" — the row is the key, not the listing.
      await recordImport("o/r", 7, NATIVE_ID);
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);

      expect((await importableIssues("o/r")).issues).toEqual([]);
      expect(vi.mocked(log.info).mock.calls.flat().join("\n")).toContain("already imported");
    });

    it("keys the import record on (repo, number), so #70's row does not skip #7", async () => {
      await recordImport("o/r", 70, NATIVE_ID);
      await recordImport("o/other", 7, "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE");
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([7]);
    });

    it("imports an issue an upstream watch targets, now that its number keeps resolving", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 }), forgeIssue({ number: 8 })]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([7, 8]);
    });

    it("reads the work queue past its default page so a low-priority row still guards", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
      await importableIssues("o/r");
      expect(mockDb.listQueuedWork).toHaveBeenCalledWith(expect.any(Number));
      expect(mockDb.listQueuedWork.mock.calls[0][0]).toBeGreaterThan(200);
    });

    it("reports a truncated forge listing", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
      mockGh.openIssuesMayBeTruncated.mockReturnValue(true);
      expect((await importableIssues("o/r")).truncated).toBe(true);
    });

    it("skips an issue a multi-phase PR only says it is part of", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 }), forgeIssue({ number: 8 })]);
      mockGh.listPRs.mockResolvedValue([
        { number: 99, title: "feat(#7): second (2/3)", body: "Part of #7", headRefName: "stjohnb/phase-2" },
      ]);
      expect((await importableIssues("o/r")).issues.map((i) => i.number)).toEqual([8]);
    });

    it("costs nothing beyond the listing for a repository with no candidates", async () => {
      mockGh.listOpenIssues.mockResolvedValue([{ ...forgeIssue(), number: NATIVE_ID }]);

      expect((await importableIssues("o/r")).issues).toEqual([]);
      expect(mockGh.listPRs).not.toHaveBeenCalled();
      expect(mockDb.listQueuedWork).not.toHaveBeenCalled();
    });
  });

  describe("importedBody", () => {
    it("prefixes the forge URL and the original author", () => {
      expect(importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."))
        .toBe("Imported from https://github.com/o/r/issues/7 (opened by @stjohnb)\n\nIt is broken.");
    });

    it("tolerates an empty body", () => {
      expect(importedBody("https://f/1", "a", "")).toBe("Imported from https://f/1 (opened by @a)");
    });
  });

  describe("importRepo", () => {
    it("creates a native issue with the same title, labels and exactly one repo", async () => {
      mockDb.createShadowIssue.mockResolvedValue({ id: NATIVE_ID, created: true });

      await importRepo("o/r", [forgeIssue({ number: 7, labels: ["Priority", "Refined"] })]);

      expect(mockDb.createShadowIssue).toHaveBeenCalledWith("o/r", 7, {
        title: "Fix the thing",
        body: "It is broken.",
        authorLogin: "stjohnb",
        labels: ["Priority", "Refined"],
      });
      expect(mockDb.promoteShadowIssue).toHaveBeenCalledWith(NATIVE_ID, {
        title: "Fix the thing",
        body: "Imported from https://github.com/o/r/issues/7 (opened by @stjohnb)\n\nIt is broken.",
        // Created ignored, un-ignored last: an import that dies partway leaves
        // an issue no dispatcher picks up.
        labels: ["Priority", "Refined", "Claws Ignore"],
      });
      expect(mockClawsIssues.removeLabel).toHaveBeenCalledWith("o/r", NATIVE_ID, "Claws Ignore");
    });

    // `issue-shadow-sync` (#3246) gives every open forge issue a shadow, so
    // `createShadowIssue` normally just resolves the existing one (`created:
    // false`) rather than minting a second native issue beside it.
    it("promotes an existing shadow in place rather than creating a second native issue", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "first", body_html: "", login: "stjohnb" }]);

      const result = await importRepo("o/r", [forgeIssue({ number: 7, labels: ["Priority", "Refined"] })]);

      expect(result).toEqual({ repo: "o/r", imported: 1, failed: 0, skipped: 0 });
      expect(mockDb.createShadowIssue).toHaveBeenCalledWith("o/r", 7, {
        // The forge's title, not whatever the shadow last held: the plan
        // re-stamp below hashes it, so a title edited since the last sync
        // would otherwise stale the plan the moment it is imported.
        title: "Fix the thing",
        body: "It is broken.",
        authorLogin: "stjohnb",
        labels: ["Priority", "Refined"],
      });
      expect(mockDb.promoteShadowIssue).toHaveBeenCalledWith(NATIVE_ID, {
        title: "Fix the thing",
        body: "Imported from https://github.com/o/r/issues/7 (opened by @stjohnb)\n\nIt is broken.",
        // Promoted ignored and un-ignored last, exactly as a fresh import is:
        // `promoteShadowIssue` commits the label and the `kind` flip together.
        labels: ["Priority", "Refined", "Claws Ignore"],
      });
      // The id is reused, so everything already hanging off it carries over —
      // the thread lands on it and the forge issue is closed against it.
      expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith("o/r", NATIVE_ID, "first", "stjohnb", { emitEvent: false, attachmentIds: [] });
      expect(mockClawsIssues.removeLabel).toHaveBeenCalledWith("o/r", NATIVE_ID, "Claws Ignore");
      expect(mockGh.commentOnIssue).toHaveBeenCalledWith("o/r", 7, `Moved to https://claws.example/issues/${NATIVE_ID}`);
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/r", 7, "not_planned");
    });

    it("creates a native issue for a forge issue with no shadow of its own", async () => {
      mockDb.createShadowIssue.mockResolvedValue({ id: NATIVE_ID, created: true });

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockDb.createShadowIssue).toHaveBeenCalledWith("o/r", 7, expect.objectContaining({ title: "Fix the thing" }));
      expect(mockDb.promoteShadowIssue).toHaveBeenCalledWith(NATIVE_ID, expect.objectContaining({
        body: "Imported from https://github.com/o/r/issues/7 (opened by @stjohnb)\n\nIt is broken.",
        labels: expect.arrayContaining(["Claws Ignore"]),
      }));
    });

    it("resolves the shadow per issue, so one created mid-run is still promoted", async () => {
      // `issue-shadow-sync` runs on its own timer while this walks a backlog
      // one slow issue at a time. A run-level snapshot would miss a shadow
      // created since it was taken — and miss it silently, because
      // `promoteShadowIssue`'s guard never runs at all in that direction.
      mockDb.createShadowIssue
        .mockResolvedValueOnce({ id: NATIVE_ID, created: true })
        .mockResolvedValueOnce({ id: "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDF", created: false });

      const result = await importRepo("o/r", [forgeIssue({ number: 7 }), forgeIssue({ number: 8 })]);

      expect(result).toEqual({ repo: "o/r", imported: 2, failed: 0, skipped: 0 });
      expect(mockDb.createShadowIssue.mock.calls.map((c) => [c[0], c[1]])).toEqual([["o/r", 7], ["o/r", 8]]);
      expect(mockDb.promoteShadowIssue).toHaveBeenCalledTimes(2);
    });

    it("skips the issue when its shadow was promoted by a concurrent run", async () => {
      // `promoteShadowIssue`'s `kind = 'shadow'` guard is what catches the
      // race; carrying on would copy the whole thread onto the other run's
      // import a second time.
      mockDb.promoteShadowIssue.mockResolvedValue(false);

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result).toEqual({ repo: "o/r", imported: 0, failed: 0, skipped: 1 });
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    // The linkage row was taken by a shadow (or a concurrent import) between
    // the shadow lookup and the create — the race #3262 exists to close. The
    // loser must leave nothing behind: no native issue, no forge write.
    it("skips the issue when its linkage row already names an imported native issue", async () => {
      mockDb.createShadowIssue.mockResolvedValue(undefined);

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result).toEqual({ repo: "o/r", imported: 0, failed: 0, skipped: 1 });
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("fails the issue when its linkage row already names another native issue", async () => {
      // `createShadowIssue` returning an id already means the linkage row
      // names it, so `recordImportedIssue` returning false here is not a
      // reachable race — this pins the defensive assertion's behaviour if it
      // ever fires: forge issue left open and un-commented, counted failed.
      mockDb.recordImportedIssue.mockResolvedValue(false);

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result).toEqual({ repo: "o/r", imported: 0, failed: 1, skipped: 0 });
      expect(mockGh.commentOnIssue).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("leaves a half-imported issue inert and the forge issue open when a comment copy fails", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "first", body_html: "", login: "stjohnb" }]);
      mockClawsIssues.commentOnIssue.mockRejectedValue(new Error("db down"));

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result).toEqual({ repo: "o/r", imported: 0, failed: 1, skipped: 0 });
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      // Still labelled `Claws Ignore`, so the dispatcher cannot pick up an
      // issue whose plan was never re-stamped.
      expect(mockClawsIssues.removeLabel).not.toHaveBeenCalled();
    });

    it("warns rather than saying 'already imported' when a previous import did not finish", async () => {
      await recordImport("o/r", 7, NATIVE_ID);
      mockGh.listOpenIssues.mockResolvedValue([
        forgeIssue({ number: 7 }),
        {
          ...forgeIssue(),
          number: NATIVE_ID,
          body: importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."),
          labels: [{ name: "Claws Ignore" }],
        },
      ]);

      expect((await importableIssues("o/r")).issues).toEqual([]);
      expect(vi.mocked(log.warn).mock.calls.flat().join("\n")).toContain("that import did not finish");
    });

    it("does not tell the operator to remove the label when the forge issue carried it too", async () => {
      await recordImport("o/r", 7, NATIVE_ID);
      mockGh.listOpenIssues.mockResolvedValue([
        forgeIssue({ number: 7, labels: ["Claws Ignore"] }),
        { ...forgeIssue(), number: NATIVE_ID, labels: [{ name: "Claws Ignore" }] },
      ]);

      expect((await importableIssues("o/r")).issues).toEqual([]);
      const warned = vi.mocked(log.warn).mock.calls.flat().join("\n");
      expect(warned).toContain("that import did not finish");
      expect(warned).not.toContain("remove the label");
    });

    it("keeps Claws Ignore on the native copy of an issue that carried it on the forge", async () => {
      await importRepo("o/r", [forgeIssue({ number: 7, labels: ["Priority", "Claws Ignore"] })]);

      // Not duplicated by the import's own guard label.
      expect(mockDb.promoteShadowIssue).toHaveBeenCalledWith(NATIVE_ID, expect.objectContaining({
        labels: ["Priority", "Claws Ignore"],
      }));
      expect(mockClawsIssues.removeLabel).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/r", 7, "not_planned");
    });

    it("still removes the guard label from an issue the forge did not ignore", async () => {
      await importRepo("o/r", [forgeIssue({ number: 7, labels: ["Priority"] })]);
      expect(mockClawsIssues.removeLabel).toHaveBeenCalledWith("o/r", NATIVE_ID, "Claws Ignore");
    });

    it("copies comments in order with their own author logins", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "first", body_html: "", login: "stjohnb" },
        { id: 2, body: "*— Automated by Claws —*\n\n## Implementation Plan", body_html: "", login: "clawsstjohn[bot]" },
      ]);

      await importRepo("o/r", [forgeIssue()]);

      expect(mockClawsIssues.commentOnIssue.mock.calls.map((c) => [c[2], c[3]])).toEqual([
        ["first", "stjohnb"],
        ["*— Automated by Claws —*\n\n## Implementation Plan", "clawsstjohn[bot]"],
      ]);
    });

    it("emits no comment events, leaving the guard label's removal as the import's one event", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "first", body_html: "", login: "stjohnb" },
        { id: 2, body: "second", body_html: "", login: "stjohnb" },
        { id: 3, body: "third", body_html: "", login: "stjohnb" },
      ]);

      await importRepo("o/r", [forgeIssue()]);

      expect(mockClawsIssues.commentOnIssue.mock.calls.map((c) => c[4]?.emitEvent)).toEqual([false, false, false]);
      expect(mockClawsIssues.removeLabel).toHaveBeenCalledTimes(1);
    });

    it("still announces an issue whose thread is empty", async () => {
      mockGh.getIssueComments.mockResolvedValue([]);

      await importRepo("o/r", [forgeIssue()]);

      // Nothing to hang "the import finished" on but the label removal, which
      // `clawsIssues.removeLabel` emits — a comment-less import used to be
      // silent, so every waiter on the repo missed it.
      expect(mockClawsIssues.commentOnIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.removeLabel).toHaveBeenCalledWith("o/r", NATIVE_ID, "Claws Ignore");
    });

    it("announces only after the plan is re-stamped", async () => {
      const order: string[] = [];
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: "*— Automated by Claws · Planner —*\n\n## Implementation Plan\n\nDo it.", body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockClawsIssues.commentOnIssue.mockResolvedValue(PLAN_COMMENT_ID);
      mockClawsIssues.editIssueComment.mockImplementation(async () => { order.push("restamp"); });
      mockClawsIssues.removeLabel.mockImplementation(async () => { order.push("announce"); });

      await importRepo("o/r", [forgeIssue()]);

      expect(order).toEqual(["restamp", "announce"]);
    });

    it("re-stamps the imported plan against the native issue and its copied comments", async () => {
      const planBody = [
        // The header the planner actually writes — `commentOnIssue` is called
        // with `{ agentName: "Planner" }`, so a plan comment never carries the
        // bare form.
        "*— Automated by Claws · Planner —*",
        "",
        "## Implementation Plan",
        "",
        "Do the thing.",
        "",
        `CLAWS_PLAN_BODY_HASH: ${"a".repeat(64)}`,
        "CLAWS_PLAN_LAST_COMMENT: 41",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([
        { id: 41, body: "some pre-plan discussion", body_html: "", login: "stjohnb" },
        { id: 42, body: planBody, body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockClawsIssues.commentOnIssue
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD1")
        .mockResolvedValueOnce(PLAN_COMMENT_ID);

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockClawsIssues.editIssueComment).toHaveBeenCalledTimes(1);
      const [ref, body] = mockClawsIssues.editIssueComment.mock.calls[0] as [string, string];
      expect(ref).toBe(PLAN_COMMENT_ID);
      expect(body).toContain("## Implementation Plan");
      expect(parsePlanBodyHash(body)).toBe(issueContentHash(
        "Fix the thing",
        importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."),
      ));
      expect(parsePlanLastCommentId(body)).toBe(PLAN_COMMENT_ID);
    });

    it("skips the re-stamp when the approved-requirements read fails, but still finishes the import (#3388 finding 2)", async () => {
      const planBody = [
        "*— Automated by Claws · Planner —*",
        "",
        "## Implementation Plan",
        "",
        "Do the thing.",
        "",
        `CLAWS_PLAN_BODY_HASH: ${"a".repeat(64)}`,
        "CLAWS_PLAN_LAST_COMMENT: 41",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([
        { id: 41, body: "some pre-plan discussion", body_html: "", login: "stjohnb" },
        { id: 42, body: planBody, body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockClawsIssues.commentOnIssue
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD1")
        .mockResolvedValueOnce(PLAN_COMMENT_ID);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "error" });

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockClawsIssues.editIssueComment).not.toHaveBeenCalled();
      // The rest of the import (closing the forge issue, removing the guard
      // label) still runs — a stale plan re-plans once on the next tick,
      // which is far better than the import silently stalling forever.
      expect(mockClawsIssues.removeLabel).toHaveBeenCalledTimes(1);
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/r", 7, "not_planned");
    });

    it("keeps a plan stamped body-only against the record when it was written before the approved record existed (#3388 finding 3)", async () => {
      const forgeBodyOnlyHash = issueContentHash("Fix the thing", "It is broken.");
      const planBody = [
        "*— Automated by Claws · Planner —*",
        "",
        "## Implementation Plan",
        "",
        "### Requirement",
        "",
        "Old restated requirement.",
        "",
        `CLAWS_PLAN_BODY_HASH: ${forgeBodyOnlyHash}`,
        "CLAWS_PLAN_LAST_COMMENT: 41",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([
        { id: 41, body: "some pre-plan discussion", body_html: "", login: "stjohnb" },
        { id: 42, body: planBody, body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockClawsIssues.commentOnIssue
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD1")
        .mockResolvedValueOnce(PLAN_COMMENT_ID);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      const [, body] = mockClawsIssues.editIssueComment.mock.calls[0] as [string, string];
      expect(parsePlanBodyHash(body)).toBe(issueContentHash(
        "Fix the thing",
        importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."),
      ));
      expect(parsePlanBodyHash(body)).not.toBe(issueContentHash(
        "Fix the thing",
        importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."),
        approvedRecord(),
      ));
    });

    it("stamps a plan already rewritten against the record with the record's hash", async () => {
      // The stamped hash must be exactly the current record's hash against the
      // forge body — a plan is only known to be "already rewritten" against the
      // record when its stamp says so precisely (#3388 finding 3); anything
      // else (including an arbitrary placeholder) is indistinguishable from an
      // un-rewritten plan and must stay body-only instead.
      const currentRecordHash = issueContentHash("Fix the thing", "It is broken.", approvedRecord());
      const planBody = [
        "*— Automated by Claws · Planner —*",
        "",
        "## Implementation Plan",
        "",
        "### Decisions",
        "",
        "1. Planned against requirements v2.",
        "",
        `CLAWS_PLAN_BODY_HASH: ${currentRecordHash}`,
        "CLAWS_PLAN_LAST_COMMENT: 41",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([
        { id: 41, body: "some pre-plan discussion", body_html: "", login: "stjohnb" },
        { id: 42, body: planBody, body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockClawsIssues.commentOnIssue
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD1")
        .mockResolvedValueOnce(PLAN_COMMENT_ID);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord() });

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      const [, body] = mockClawsIssues.editIssueComment.mock.calls[0] as [string, string];
      expect(parsePlanBodyHash(body)).toBe(issueContentHash(
        "Fix the thing",
        importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."),
        approvedRecord(),
      ));
    });

    it("keeps a plan body-only when its stamp matches an older record version rather than the current one (#3388 finding 3)", async () => {
      const planBody = [
        "*— Automated by Claws · Planner —*",
        "",
        "## Implementation Plan",
        "",
        "### Decisions",
        "",
        "1. Planned against requirements v1.",
        "",
        `CLAWS_PLAN_BODY_HASH: ${issueContentHash("Fix the thing", "It is broken.", approvedRecord({ version: 1 }))}`,
        "CLAWS_PLAN_LAST_COMMENT: 41",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([
        { id: 41, body: "some pre-plan discussion", body_html: "", login: "stjohnb" },
        { id: 42, body: planBody, body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockClawsIssues.commentOnIssue
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD1")
        .mockResolvedValueOnce(PLAN_COMMENT_ID);
      mockLoadApprovedRequirements.mockResolvedValueOnce({ status: "approved", record: approvedRecord({ version: 2 }) });

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      const [, body] = mockClawsIssues.editIssueComment.mock.calls[0] as [string, string];
      // Neither the body-only hash nor the current (v2) record's hash — there is
      // no way to tell whether this plan's text was ever rewritten against v2,
      // so it must be re-stamped body-only rather than assumed current.
      expect(parsePlanBodyHash(body)).toBe(issueContentHash(
        "Fix the thing",
        importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."),
      ));
      expect(parsePlanBodyHash(body)).not.toBe(issueContentHash(
        "Fix the thing",
        importedBody("https://github.com/o/r/issues/7", "stjohnb", "It is broken."),
        approvedRecord({ version: 2 }),
      ));
    });

    it("keeps the step-back reconsider marker on the imported plan", async () => {
      const planBody = [
        "*— Automated by Claws —*",
        "",
        "## Implementation Plan",
        "",
        "Do the thing.",
        "",
        `CLAWS_PLAN_BODY_HASH: ${"a".repeat(64)}`,
        "CLAWS_PLAN_LAST_COMMENT: 41",
        "CLAWS_PLAN_STEP_BACK: reconsider",
      ].join("\n");
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: planBody, body_html: "", login: "clawsstjohn[bot]" }]);
      mockClawsIssues.commentOnIssue.mockResolvedValue(PLAN_COMMENT_ID);

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      const [, body] = mockClawsIssues.editIssueComment.mock.calls[0] as [string, string];
      expect(hasStepBackReconsiderMarker(body)).toBe(true);
    });

    it("does not invent a step-back marker for a plan that never had one", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nDo it.", body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockClawsIssues.commentOnIssue.mockResolvedValue(PLAN_COMMENT_ID);

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      const [, body] = mockClawsIssues.editIssueComment.mock.calls[0] as [string, string];
      expect(hasStepBackReconsiderMarker(body)).toBe(false);
    });

    it("leaves an issue with no plan comment alone", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "just feedback", body_html: "", login: "stjohnb" }]);

      await importRepo("o/r", [forgeIssue()]);

      expect(mockClawsIssues.editIssueComment).not.toHaveBeenCalled();
    });

    it("copies only Claws' own reactions, as claws reactions", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "feedback", body_html: "", login: "stjohnb" }]);
      mockGh.getCommentReactions.mockResolvedValue([
        { id: 1, user: { login: "clawsstjohn[bot]" }, content: "rocket" },
        { id: 2, user: { login: "stjohnb" }, content: "+1" },
      ]);

      await importRepo("o/r", [forgeIssue()]);

      expect(mockClawsIssues.addReaction).toHaveBeenCalledTimes(1);
      expect(mockClawsIssues.addReaction).toHaveBeenCalledWith("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDD", "claws", "rocket");
    });

    it("attaches each comment's reactions to that comment's native id", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "first", body_html: "", login: "stjohnb" },
        { id: 2, body: "second", body_html: "", login: "stjohnb" },
      ]);
      mockGh.getCommentReactions.mockImplementation(async (_repo: string, id: number) =>
        [{ id, user: { login: "clawsstjohn[bot]" }, content: id === 1 ? "rocket" : "eyes" }]);
      mockClawsIssues.commentOnIssue
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD1")
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD2");

      await importRepo("o/r", [forgeIssue()]);

      expect(mockClawsIssues.addReaction.mock.calls).toEqual([
        ["clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD1", "claws", "rocket"],
        ["clwc_01JBQ7X4M2K8NV3TYRW9GZ5PD2", "claws", "eyes"],
      ]);
    });

    it("imports the thread anyway when one comment's reactions cannot be read", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 1, body: "first", body_html: "", login: "stjohnb" },
        { id: 2, body: "second", body_html: "", login: "stjohnb" },
      ]);
      mockGh.getCommentReactions.mockImplementation(async (_repo: string, id: number) => {
        if (id === 1) throw new Error("HTTP 403");
        return [{ id, user: { login: "clawsstjohn[bot]" }, content: "eyes" }];
      });

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result).toEqual({ repo: "o/r", imported: 1, failed: 0, skipped: 0 });
      expect(mockClawsIssues.addReaction).toHaveBeenCalledTimes(1);
      expect(mockClawsIssues.addReaction).toHaveBeenCalledWith(expect.any(String), "claws", "eyes");
    });

    it("matches the app/ form of Claws' own login", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "feedback", body_html: "", login: "stjohnb" }]);
      mockGh.getCommentReactions.mockResolvedValue([{ id: 1, user: { login: "app/clawsstjohn" }, content: "rocket" }]);

      await importRepo("o/r", [forgeIssue()]);

      expect(mockClawsIssues.addReaction).toHaveBeenCalledWith(expect.any(String), "claws", "rocket");
    });

    it("points the forge issue at the dashboard and closes it not_planned", async () => {
      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockGh.commentOnIssue).toHaveBeenCalledWith("o/r", 7, `Moved to https://claws.example/issues/${NATIVE_ID}`);
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/r", 7, "not_planned");
      expect(result).toEqual({ repo: "o/r", imported: 1, failed: 0, skipped: 0 });
    });

    it("never closes the forge issue when the native create failed", async () => {
      mockDb.createShadowIssue.mockRejectedValue(new Error("db down"));

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockGh.closeIssue).not.toHaveBeenCalled();
      expect(result).toEqual({ repo: "o/r", imported: 0, failed: 1, skipped: 0 });
      expect(mockReportError).toHaveBeenCalled();
    });

    it("re-checks the work queue immediately before the first write", async () => {
      // The candidate filter ran minutes ago; the dispatcher has queued a
      // worker since. Nothing native may be written and the forge issue must
      // stay open.
      mockDb.listQueuedWork.mockResolvedValue([
        { kind: AGENT_KINDS.ISSUE_WORKER, repo: "o/r", item_number: 7, status: "queued" },
      ]);

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result).toEqual({ repo: "o/r", imported: 0, failed: 0, skipped: 1 });
      expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
      expect(mockGh.closeIssue).not.toHaveBeenCalled();
    });

    it("re-reads the PR list past its cache before the first write", async () => {
      mockGh.getOpenPRForIssue.mockResolvedValue({ number: 99 });

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockGh.invalidatePRList).toHaveBeenCalledWith("o/r");
      expect(result.skipped).toBe(1);
      expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
    });

    it("imports an issue other issues are marked duplicate of", async () => {
      // `gh.listDuplicateIssuesOf` finds those markers under the native id
      // through the alias, so there is nothing left for this job to refuse.
      mockGh.listDuplicateIssuesOf.mockResolvedValue([{ number: 12 }, { number: 13 }]);

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result).toEqual({ repo: "o/r", imported: 1, failed: 0, skipped: 0 });
      expect(mockDb.createShadowIssue).toHaveBeenCalled();
    });

    it("records the import before any write that a crash could lose", async () => {
      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockDb.recordImportedIssue).toHaveBeenCalledWith("o/r", 7, NATIVE_ID);
      const recordedAt = mockDb.recordImportedIssue.mock.invocationCallOrder[0]!;
      expect(recordedAt).toBeLessThan(mockGh.commentOnIssue.mock.invocationCallOrder[0]!);
      expect(recordedAt).toBeLessThan(mockGh.closeIssue.mock.invocationCallOrder[0]!);
      expect(recordedAt).toBeLessThan(mockClawsIssues.removeLabel.mock.invocationCallOrder[0]!);
    });

    it("leaves the import recorded when a later step fails, so a re-run does not duplicate", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: "first", body_html: "", login: "stjohnb" }]);
      mockClawsIssues.commentOnIssue.mockRejectedValue(new Error("db down"));

      const result = await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(result.failed).toBe(1);
      expect(mockDb.recordImportedIssue).toHaveBeenCalledWith("o/r", 7, NATIVE_ID);
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
      expect((await importableIssues("o/r")).issues).toEqual([]);
    });

    it("carries a mid-sequence issue's landed phases across as a claim", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPhasePlan, body_html: "", login: "clawsstjohn[bot]" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 100, title: "feat(#7): first (1/3)", body: "Part of #7" },
        { number: 101, title: "feat(#7): second (2/3)", body: "Part of #7" },
      ]);
      mockClawsIssues.commentOnIssue
        .mockResolvedValueOnce(PLAN_COMMENT_ID)
        .mockResolvedValueOnce("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDE");

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockClawsIssues.commentOnIssue).toHaveBeenLastCalledWith(
        "o/r", NATIVE_ID, "claws-phase-done: 1, 2", "stjohnb", { emitEvent: false },
      );
      // The claim must sort below the plan's fence, or every copied comment
      // reads as unaddressed post-plan feedback.
      const [, body] = mockClawsIssues.editIssueComment.mock.calls[0] as [string, string];
      expect(parsePlanLastCommentId(body)).toBe("clwc_01JBQ7X4M2K8NV3TYRW9GZ5PDE");
    });

    it("warns about a phase covered only by an open PR, and does not claim it", async () => {
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPhasePlan, body_html: "", login: "clawsstjohn[bot]" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 100, title: "feat(#7): first (1/3)", body: "Part of #7" },
        { number: 101, title: "feat(#7): second (2/3)", body: "Part of #7" },
      ]);
      mockGh.listPRsCrossReferencingIssue.mockResolvedValue([
        { number: 102, title: "feat(#7): third (3/3)", body: "Part of #7", state: "open", login: "stjohnb" },
      ]);

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(vi.mocked(log.warn).mock.calls.flat().join("\n")).toContain("phase(s) 3");
      expect(mockClawsIssues.commentOnIssue).toHaveBeenLastCalledWith(
        "o/r", NATIVE_ID, "claws-phase-done: 1, 2", "stjohnb", { emitEvent: false },
      );
    });

    it("warns and carries nothing when no trusted login can post the claim", async () => {
      mockConfig.ALLOWED_ACTORS = [];
      mockGh.getIssueComments.mockResolvedValue([{ id: 42, body: multiPhasePlan, body_html: "", login: "clawsstjohn[bot]" }]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([
        { number: 100, title: "feat(#7): first (1/3)", body: "Part of #7" },
      ]);

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockClawsIssues.commentOnIssue.mock.calls.map((c) => c[2]).join("\n")).not.toContain("claws-phase-done");
      expect(vi.mocked(log.warn).mock.calls.flat().join("\n")).toContain("o/r#7");
    });

    it("claims nothing for a single-phase plan", async () => {
      mockGh.getIssueComments.mockResolvedValue([
        { id: 42, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nJust do it.", body_html: "", login: "clawsstjohn[bot]" },
      ]);
      mockGh.listMergedPRsForIssue.mockResolvedValue([{ number: 100, title: "fix(#7): it", body: "Closes #7" }]);

      await importRepo("o/r", [forgeIssue({ number: 7 })]);

      expect(mockClawsIssues.commentOnIssue.mock.calls.map((c) => c[2]).join("\n")).not.toContain("claws-phase-done");
    });

    describe("file copy", () => {
      const IMAGE_URL = "https://github.com/user-attachments/assets/0f1e2d3c-aaaa-bbbb-cccc-123456789abc";
      const ZIP_URL = "https://github.com/user-attachments/files/123/logs.zip";

      it("copies a body image and a comment zip into the native store and rewrites both texts", async () => {
        mockGh.getIssueComments.mockResolvedValue([
          { id: 1, body: `Logs: [logs.zip](${ZIP_URL})`, body_html: "", login: "alice" },
        ]);
        mockFetchIssueFile.mockImplementation(async (url: string) => url === IMAGE_URL
          ? { buffer: Buffer.from("png"), contentType: "image/png" }
          : { buffer: Buffer.from("PK\x03\x04"), contentType: "application/zip" });

        await importRepo("o/r", [forgeIssue({ body: `See ![shot](${IMAGE_URL})` })]);

        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledTimes(2);
        // The stored image name gains an extension so the prompt pipeline
        // routes it to .claws-images/.
        expect(mockAttachments.storeIssueAttachment).toHaveBeenNthCalledWith(
          1, NATIVE_ID, "0f1e2d3c-aaaa-bbbb-cccc-123456789abc.png", expect.any(Buffer), "image/png", "stjohnb",
        );
        expect(mockAttachments.storeIssueAttachment).toHaveBeenNthCalledWith(
          2, NATIVE_ID, "logs.zip", expect.any(Buffer), "application/zip", "alice",
        );
        const body = mockDb.promoteShadowIssue.mock.calls[0]![1].body as string;
        expect(body).toContain(`![shot](/issues/${NATIVE_ID}/attachments/cla_${"1".padStart(26, "0")}/0f1e2d3c-aaaa-bbbb-cccc-123456789abc.png)`);
        expect(body).not.toContain(IMAGE_URL);
        expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith(
          "o/r", NATIVE_ID, `Logs: [logs.zip](/issues/${NATIVE_ID}/attachments/cla_${"2".padStart(26, "0")}/logs.zip)`, "alice", { emitEvent: false, attachmentIds: [`cla_${"2".padStart(26, "0")}`] },
        );
      });

      it("leaves the original URL in place when a download fails, and still imports", async () => {
        mockFetchIssueFile.mockResolvedValue({ error: "HTTP 404" });

        const result = await importRepo("o/r", [forgeIssue({ body: `See ![shot](${IMAGE_URL})` })]);

        expect(result.imported).toBe(1);
        expect(mockAttachments.storeIssueAttachment).not.toHaveBeenCalled();
        expect(mockDb.promoteShadowIssue.mock.calls[0]![1].body).toContain(`![shot](${IMAGE_URL})`);
        expect(vi.mocked(log.warn).mock.calls.flat().join("\n")).toContain(`could not copy ${IMAGE_URL}`);
      });

      it("leaves an image link in place when it answers with something other than an image", async () => {
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("<html>Sign in</html>"), contentType: "text/html; charset=utf-8" });

        const result = await importRepo("o/r", [forgeIssue({ body: `See ![shot](${IMAGE_URL})` })]);

        expect(result.imported).toBe(1);
        expect(mockAttachments.storeIssueAttachment).not.toHaveBeenCalled();
        expect(mockDb.promoteShadowIssue.mock.calls[0]![1].body).toContain(`![shot](${IMAGE_URL})`);
        expect(vi.mocked(log.warn).mock.calls.flat().join("\n")).toContain("not an image");
      });

      it("clears copies a dead import left on the shadow before copying again", async () => {
        const stale = `cla_${"9".padStart(26, "0")}`;
        mockDb.listClawsIssueAttachments.mockResolvedValue([{ id: stale, issue_id: NATIVE_ID }]);
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        await importRepo("o/r", [forgeIssue({ body: `![shot](${IMAGE_URL})` })]);

        expect(mockDb.listClawsIssueAttachments).toHaveBeenCalledWith(NATIVE_ID);
        expect(mockAttachments.deleteIssueAttachment).toHaveBeenCalledTimes(1);
        expect(mockAttachments.deleteIssueAttachment).toHaveBeenCalledWith(stale);
        expect(mockAttachments.deleteIssueAttachment.mock.invocationCallOrder[0]).toBeLessThan(mockFetchIssueFile.mock.invocationCallOrder[0]!);
        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledTimes(1);
        expect(mockDb.promoteShadowIssue.mock.calls[0]![1].body).toContain(`/attachments/cla_${"1".padStart(26, "0")}/`);
      });

      it("attributes a Forgejo asset no comment links to the body", async () => {
        mockGh.getIssueAttachments.mockResolvedValue([{ name: "trace.txt", url: "https://forgejo.example/attachments/abc" }]);
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("trace"), contentType: "text/plain" });

        await importRepo("o/r", [forgeIssue()]);

        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledWith(NATIVE_ID, "trace.txt", expect.any(Buffer), "text/plain", "stjohnb");
      });

      it("takes the copied files back when the promotion loses its race", async () => {
        mockDb.promoteShadowIssue.mockResolvedValue(false);
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        await importRepo("o/r", [forgeIssue({ body: `![shot](${IMAGE_URL})` })]);

        expect(mockAttachments.deleteIssueAttachment).toHaveBeenCalledWith(`cla_${"1".padStart(26, "0")}`);
      });

      it("takes the copied files back when the promotion throws", async () => {
        mockDb.promoteShadowIssue.mockRejectedValue(new Error("lock timeout"));
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        const result = await importRepo("o/r", [forgeIssue({ body: `![shot](${IMAGE_URL})` })]);

        expect(result.failed).toBe(1);
        expect(mockAttachments.deleteIssueAttachment).toHaveBeenCalledWith(`cla_${"1".padStart(26, "0")}`);
      });

      it("rewrites a relative Forgejo attachment link and copies it with the comment that links it", async () => {
        const uuid = "ea2a83bc-1703-4ecb-a3a3-591d9f6126b4";
        mockGh.getIssueAttachments.mockResolvedValue([{ name: "shot.png", url: `https://forgejo.example/attachments/${uuid}` }]);
        mockGh.getIssueComments.mockResolvedValue([
          { id: 1, body: `Here: ![shot](/attachments/${uuid}) and [again](/o/r/attachments/${uuid})`, body_html: "", login: "alice" },
        ]);
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        await importRepo("o/r", [forgeIssue()]);

        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledTimes(1);
        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledWith(NATIVE_ID, "shot.png", expect.any(Buffer), "image/png", "alice");
        const nativeUrl = `/issues/${NATIVE_ID}/attachments/cla_${"1".padStart(26, "0")}/shot.png`;
        expect(mockClawsIssues.commentOnIssue).toHaveBeenCalledWith(
          "o/r", NATIVE_ID, `Here: ![shot](${nativeUrl}) and [again](${nativeUrl})`, "alice", { emitEvent: false, attachmentIds: [`cla_${"1".padStart(26, "0")}`] },
        );
      });

      it("copies a file the body and a reply both link only once", async () => {
        mockGh.getIssueComments.mockResolvedValue([
          { id: 1, body: `Quoting: ![shot](${IMAGE_URL})`, body_html: "", login: "alice" },
        ]);
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        await importRepo("o/r", [forgeIssue({ body: `![shot](${IMAGE_URL})` })]);

        expect(mockFetchIssueFile).toHaveBeenCalledTimes(1);
        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledTimes(1);
        expect(mockClawsIssues.commentOnIssue.mock.calls[0]![2]).not.toContain(IMAGE_URL);
        // The body's copy stays the body's: the reply claims none of it.
        expect(mockClawsIssues.commentOnIssue.mock.calls[0]![4]).toEqual({ emitEvent: false, attachmentIds: [] });
      });

      it("skips the issue and takes the copies back when work is queued during the downloads", async () => {
        mockDb.listQueuedWork
          .mockResolvedValueOnce([])
          .mockResolvedValue([{ kind: AGENT_KINDS.ISSUE_WORKER, repo: "o/r", item_number: 7, status: "queued" }]);
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        const result = await importRepo("o/r", [forgeIssue({ number: 7, body: `![shot](${IMAGE_URL})` })]);

        expect(result).toEqual({ repo: "o/r", imported: 0, failed: 0, skipped: 1 });
        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledTimes(1);
        expect(mockAttachments.deleteIssueAttachment).toHaveBeenCalledWith(`cla_${"1".padStart(26, "0")}`);
        expect(mockDb.promoteShadowIssue).not.toHaveBeenCalled();
        expect(mockGh.closeIssue).not.toHaveBeenCalled();
      });

      it("leaves a longer URL alone when only the shorter one it extends was copied", async () => {
        const raw = `${IMAGE_URL}?raw=true`;
        mockFetchIssueFile.mockImplementation(async (url: string) => url === raw
          ? { error: "HTTP 404" }
          : { buffer: Buffer.from("png"), contentType: "image/png" });

        await importRepo("o/r", [forgeIssue({ body: `![a](${IMAGE_URL}) ![b](${raw})` })]);

        const body = mockDb.promoteShadowIssue.mock.calls[0]![1].body as string;
        expect(body).toContain(`![a](/issues/${NATIVE_ID}/attachments/cla_${"1".padStart(26, "0")}/`);
        expect(body).toContain(`![b](${raw})`);
      });

      it("does not let a shorter URL rewrite the head of a longer one", async () => {
        const raw = `${IMAGE_URL}?raw=true`;
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        await importRepo("o/r", [forgeIssue({ body: `![a](${IMAGE_URL}) ![b](${raw})` })]);

        const body = mockDb.promoteShadowIssue.mock.calls[0]![1].body as string;
        expect(body).toContain(`![b](/issues/${NATIVE_ID}/attachments/cla_${"2".padStart(26, "0")}/`);
        expect(body).not.toContain("?raw=true");
      });

      it("stops at the file copy limit, shared by the body and every comment", async () => {
        const url = (i: number) => `https://example.com/shot-${i}.png`;
        const links = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => `![s](${url(from + k)})`).join("\n");
        mockGh.getIssueComments.mockResolvedValue([{ id: 1, body: links(30, 51), body_html: "", login: "alice" }]);
        mockFetchIssueFile.mockResolvedValue({ buffer: Buffer.from("png"), contentType: "image/png" });

        await importRepo("o/r", [forgeIssue({ body: links(0, 30) })]);

        expect(mockAttachments.storeIssueAttachment).toHaveBeenCalledTimes(50);
        const warnings = vi.mocked(log.warn).mock.calls.flat().join("\n");
        expect(warnings).toContain("file copy limit");
        expect(warnings).toContain(url(50));
      });
    });

    it("keeps importing after one issue fails", async () => {
      mockDb.createShadowIssue
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce({ id: NATIVE_ID, created: false });

      const result = await importRepo("o/r", [forgeIssue({ number: 7 }), forgeIssue({ number: 8 })]);

      expect(result).toEqual({ repo: "o/r", imported: 1, failed: 1, skipped: 0 });
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/r", 8, "not_planned");
    });
  });

  describe("run", () => {
    it("imports every repo with importable issues in one run", async () => {
      mockGh.listOpenIssues.mockImplementation(async (repo: string) =>
        repo === "o/b" || repo === "o/c" ? [forgeIssue({ number: 7 })] : []);

      await run([mockRepo({ fullName: "o/a" }), mockRepo({ fullName: "o/b" }), mockRepo({ fullName: "o/c" })]);

      expect(mockDb.createShadowIssue).toHaveBeenCalledTimes(2);
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/b", 7, "not_planned");
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/c", 7, "not_planned");
      expect(vi.mocked(log.info).mock.calls.flat().join("\n")).toContain("2 repo(s): imported 2, failed 0, skipped 0");
    });

    it("does nothing when no repo has importable issues", async () => {
      await run([mockRepo({ fullName: "o/a" }), mockRepo({ fullName: "o/b" })]);
      expect(mockDb.createShadowIssue).not.toHaveBeenCalled();
      expect(vi.mocked(log.info).mock.calls.flat().join("\n")).toContain("No repository has open forge issues left to import");
    });

    it("lists a truncated repository again and imports the next page", async () => {
      // One issue per "page": the forge only returns the first still-open one.
      const open = [7, 8];
      mockGh.listOpenIssues.mockImplementation(async () => open.slice(0, 1).map((number) => forgeIssue({ number })));
      mockGh.closeIssue.mockImplementation(async (_repo: string, n: number) => { open.splice(open.indexOf(n), 1); });
      mockGh.openIssuesMayBeTruncated.mockReturnValue(true);

      await run([mockRepo({ fullName: "o/a" })]);

      expect(mockGh.closeIssue.mock.calls.map((c) => c[1])).toEqual([7, 8]);
      expect(mockGh.listOpenIssues).toHaveBeenCalledTimes(3);
      expect(vi.mocked(log.info).mock.calls.flat().join("\n")).toContain("o/a: imported 2, failed 0, skipped 0 — the remaining issues will be picked up on a later run");
    });

    it("stops listing a truncated repository once a pass imports nothing", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
      mockGh.openIssuesMayBeTruncated.mockReturnValue(true);
      mockDb.createShadowIssue.mockResolvedValue(undefined);

      await run([mockRepo({ fullName: "o/a" })]);

      expect(mockGh.listOpenIssues).toHaveBeenCalledTimes(1);
    });

    it("reports a repo-wide import failure and moves on to the next repo", async () => {
      mockGh.listOpenIssues.mockResolvedValue([forgeIssue({ number: 7 })]);
      mockGh.getSelfLoginForRepo.mockImplementation(async (repo: string) => {
        if (repo === "o/a") throw new Error("rate limited");
        return "clawsstjohn[bot]";
      });

      await expect(run([mockRepo({ fullName: "o/a" }), mockRepo({ fullName: "o/b" })])).resolves.toBeUndefined();

      expect(mockReportError).toHaveBeenCalledWith("issue-importer:import-repo", "o/a", expect.any(Error), { repo: "o/a" });
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/b", 7, "not_planned");
    });

    it("moves on to the next repo when a list fails", async () => {
      mockGh.listOpenIssues.mockImplementation(async (repo: string) => {
        if (repo === "o/a") throw new Error("rate limited");
        return [forgeIssue({ number: 7 })];
      });

      await run([mockRepo({ fullName: "o/a" }), mockRepo({ fullName: "o/b" })]);

      expect(mockReportError).toHaveBeenCalled();
      expect(mockGh.closeIssue).toHaveBeenCalledWith("o/b", 7, "not_planned");
    });
  });
});

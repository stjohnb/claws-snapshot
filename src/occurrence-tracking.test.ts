import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
const mockCloseIssue = vi.hoisted(() => vi.fn());
const mockListOpenIssues = vi.hoisted(() => vi.fn());
const mockEditIssueTitle = vi.hoisted(() => vi.fn());
const mockCommentOnIssue = vi.hoisted(() => vi.fn());
vi.mock("./github.js", () => ({
  openIssuesMayBeTruncated: () => false,
  createIssue: mockCreateIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
  closeIssue: mockCloseIssue,
  listOpenIssues: mockListOpenIssues,
  editIssueTitle: mockEditIssueTitle,
  commentOnIssue: mockCommentOnIssue,
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { appendOccurrenceTracking, updateOccurrenceTracking, applyOccurrenceTracking, ensureAlertIssue, upsertAlertIssue, closeAlertIssueIfResolved, resolveAlertIssue, parseOccurrenceCount, parseFirstSeen, rebuildOccurrenceTracking, __resetOccurrenceTrackingForTests } from "./occurrence-tracking.js";

const TS1 = "2024-01-01T00:00:00.000Z";
const TS2 = "2024-01-02T00:00:00.000Z";

beforeEach(() => {
  __resetOccurrenceTrackingForTests();
});

describe("appendOccurrenceTracking", () => {
  it("appends tracking block to a body with content", () => {
    const result = appendOccurrenceTracking("Some body text.", TS1);
    expect(result).toBe(
      `Some body text.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`,
    );
  });

  it("creates tracking block when body is empty", () => {
    const result = appendOccurrenceTracking("", TS1);
    expect(result).toBe(`---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`);
  });

  it("uses custom initialCount", () => {
    const result = appendOccurrenceTracking("Body.", TS1, 2);
    expect(result).toContain("**Occurrences:** 2");
  });
});

describe("updateOccurrenceTracking", () => {
  it("increments count and updates Last seen", () => {
    const body = `Some body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`;
    const result = updateOccurrenceTracking(body, TS2);
    expect(result).toBe(
      `Some body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS2}\n**Occurrences:** 2`,
    );
  });

  it("increments from N to N+1", () => {
    const body = `Body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 5`;
    const result = updateOccurrenceTracking(body, TS2);
    expect(result).toContain("**Occurrences:** 6");
  });

  it("preserves First seen timestamp", () => {
    const body = `Body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 3`;
    const result = updateOccurrenceTracking(body, TS2);
    expect(result).toContain(`**First seen:** ${TS1}`);
  });

  it("returns body unchanged when tracking block is not at end of body", () => {
    const body = `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1\n\nUser added a note here.`;
    const result = updateOccurrenceTracking(body, TS2);
    expect(result).toBe(body);
  });
});

describe("applyOccurrenceTracking", () => {
  it("appends tracking retroactively with count=2 when body has no tracking block", () => {
    const { updatedBody, matched } = applyOccurrenceTracking("Old body without tracking.", TS2);
    expect(matched).toBe(true);
    expect(updatedBody).toContain("**First seen:**");
    expect(updatedBody).toContain("**Occurrences:** 2");
  });

  it("increments existing tracking block", () => {
    const body = `Body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 2`;
    const { updatedBody, matched } = applyOccurrenceTracking(body, TS2);
    expect(matched).toBe(true);
    expect(updatedBody).toContain("**Occurrences:** 3");
    expect(updatedBody).toContain(`**Last seen:** ${TS2}`);
  });

  it("returns matched=false when tracking block exists but is not at end of body", () => {
    const body = `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1\n\nUser added text after tracking block.`;
    const { matched } = applyOccurrenceTracking(body, TS2);
    expect(matched).toBe(false);
  });
});

describe("parseOccurrenceCount", () => {
  it("returns the integer from a body with occurrence tracking", () => {
    const body = `Some body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS2}\n**Occurrences:** 5`;
    expect(parseOccurrenceCount(body)).toBe(5);
  });

  it("returns null when occurrence tracking is absent", () => {
    expect(parseOccurrenceCount("Just a plain body with no tracking.")).toBeNull();
  });

  it("returns 1 for Occurrences: 1", () => {
    const body = `Body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`;
    expect(parseOccurrenceCount(body)).toBe(1);
  });
});

describe("parseFirstSeen", () => {
  it("returns the timestamp from a body with occurrence tracking", () => {
    const body = `Body.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS2}\n**Occurrences:** 5`;
    expect(parseFirstSeen(body)).toBe(TS1);
  });

  it("returns null when occurrence tracking is absent", () => {
    expect(parseFirstSeen("Plain body.")).toBeNull();
  });
});

describe("rebuildOccurrenceTracking", () => {
  it("replaces the body, preserves First seen, and increments Occurrences", () => {
    const current = `**Reason:** CrashLoopBackOff\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 4`;
    const result = rebuildOccurrenceTracking("**Reason:** OOMKilled", current, TS2);
    expect(result).toBe(
      `**Reason:** OOMKilled\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS2}\n**Occurrences:** 5`,
    );
    expect(result).not.toContain("CrashLoopBackOff");
  });

  it("uses the timestamp as First seen and count 2 when the current body has no tracking", () => {
    const result = rebuildOccurrenceTracking("New body.", "Old body.", TS2);
    expect(result).toBe(
      `New body.\n\n---\n**First seen:** ${TS2}\n**Last seen:** ${TS2}\n**Occurrences:** 2`,
    );
  });

  it("rebuilds even when the tracking block is not at the end of the current body", () => {
    const current = `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 3\n\nA hand-written note.`;
    const result = rebuildOccurrenceTracking("New body.", current, TS2);
    expect(result).toContain(`**First seen:** ${TS1}`);
    expect(result).toContain("**Occurrences:** 4");
    expect(result).not.toContain("hand-written note");
  });
});

describe("ensureAlertIssue", () => {
  const OPTS = {
    repo: "org/repo",
    title: "Alert: something broke",
    body: "Details about the alert.",
    labels: ["bug"],
    timestamp: TS1,
    logPrefix: "test",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates issue with occurrence tracking body when no existing issue found", async () => {
    mockListOpenIssues.mockResolvedValue([]);
    mockCreateIssue.mockResolvedValue(42);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "created", issueNumber: 42 });
    expect(mockCreateIssue).toHaveBeenCalledWith(
      OPTS.repo,
      OPTS.title,
      appendOccurrenceTracking(OPTS.body, TS1),
      OPTS.labels,
    );
    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("edits existing issue when tracking block is at end of body", async () => {
    const existingBody = `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`;
    mockListOpenIssues.mockResolvedValue([{ title: OPTS.title, number: 7, labels: [] }]);
    mockGetIssueBody.mockResolvedValue(existingBody);
    mockEditIssue.mockResolvedValue(undefined);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
    expect(mockEditIssue).toHaveBeenCalledWith(OPTS.repo, 7, expect.stringContaining("**Occurrences:** 2"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("returns tracking-not-updated when tracking block is not at end of body", async () => {
    const bodyWithTrailingNote = `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1\n\nSomeone added a note after the tracking block.`;
    mockListOpenIssues.mockResolvedValue([{ title: OPTS.title, number: 99, labels: [] }]);
    mockGetIssueBody.mockResolvedValue(bodyWithTrailingNote);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "tracking-not-updated", issueNumber: 99 });
    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  describe("with legacyTitles", () => {
    const LEGACY_OPTS = { ...OPTS, legacyTitles: ["Old alert A", "Old alert B"] };

    it("renames a legacy-titled issue instead of creating a new one", async () => {
      mockListOpenIssues.mockResolvedValue([
        { number: 5, title: "Unrelated", labels: [] },
        { number: 7, title: "Old alert B", labels: [] },
      ]);
      mockGetIssueBody.mockResolvedValue(
        `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`,
      );

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
      expect(mockEditIssueTitle).toHaveBeenCalledWith(OPTS.repo, 7, OPTS.title);
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });

    it("does not rename when an issue with the new title is already open", async () => {
      mockListOpenIssues.mockResolvedValue([
        { number: 7, title: "Old alert A", labels: [] },
        { number: 9, title: OPTS.title, labels: [] },
      ]);
      mockGetIssueBody.mockResolvedValue(
        `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`,
      );

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "updated", issueNumber: 9 });
      expect(mockEditIssueTitle).not.toHaveBeenCalled();
    });

    it("creates an issue when neither the new nor a legacy title is open", async () => {
      mockListOpenIssues.mockResolvedValue([{ number: 5, title: "Unrelated", labels: [] }]);
      mockCreateIssue.mockResolvedValue(42);

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "created", issueNumber: 42 });
      expect(mockEditIssueTitle).not.toHaveBeenCalled();
    });

    it("keeps the lowest-numbered legacy match and closes the others as superseded", async () => {
      mockListOpenIssues.mockResolvedValue([
        { number: 31, title: "Old alert B", labels: [] },
        { number: 14, title: "Old alert A", labels: [] },
      ]);
      mockGetIssueBody.mockResolvedValue("Details.");

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result.issueNumber).toBe(14);
      expect(mockEditIssueTitle).toHaveBeenCalledWith(OPTS.repo, 14, OPTS.title);
      expect(mockCommentOnIssue).toHaveBeenCalledWith(
        OPTS.repo,
        31,
        expect.stringContaining("Superseded by #14"),
      );
      expect(mockCloseIssue).toHaveBeenCalledWith(OPTS.repo, 31, "not_planned");
    });

    it("still raises the alert when closing a superseded duplicate fails", async () => {
      mockListOpenIssues.mockResolvedValue([
        { number: 14, title: "Old alert A", labels: [] },
        { number: 31, title: "Old alert B", labels: [] },
      ]);
      mockCommentOnIssue.mockRejectedValue(new Error("boom"));
      mockGetIssueBody.mockResolvedValue("Details.");

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "updated", issueNumber: 14 });
      expect(mockEditIssue).toHaveBeenCalled();
    });

    it("replaces the body when refreshBody is set, preserving First seen", async () => {
      mockListOpenIssues.mockResolvedValue([{ number: 7, title: OPTS.title, labels: [] }]);
      mockGetIssueBody.mockResolvedValue(
        `**Reason:** CrashLoopBackOff\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 3`,
      );

      const result = await ensureAlertIssue({ ...LEGACY_OPTS, refreshBody: true, timestamp: TS2 });

      expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
      expect(mockEditIssue).toHaveBeenCalledWith(
        OPTS.repo,
        7,
        `${OPTS.body}\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS2}\n**Occurrences:** 4`,
      );
    });

    it("never returns tracking-not-updated under refreshBody", async () => {
      mockListOpenIssues.mockResolvedValue([{ number: 7, title: OPTS.title, labels: [] }]);
      mockGetIssueBody.mockResolvedValue(
        `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1\n\nA hand-written note.`,
      );

      const result = await ensureAlertIssue({ ...LEGACY_OPTS, refreshBody: true });

      expect(result.outcome).toBe("updated");
    });
  });

  describe("concurrency", () => {
    it("serializes two concurrent calls for the same repo+title so only one issue is created", async () => {
      mockListOpenIssues.mockResolvedValue([]);
      mockCreateIssue.mockResolvedValue(101);
      mockGetIssueBody.mockResolvedValue(
        `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`,
      );
      mockEditIssue.mockResolvedValue(undefined);

      const [r1, r2] = await Promise.all([ensureAlertIssue(OPTS), ensureAlertIssue(OPTS)]);

      expect(mockCreateIssue).toHaveBeenCalledTimes(1);
      expect([r1.outcome, r2.outcome].sort()).toEqual(["created", "updated"]);
      expect(r1.issueNumber).toBe(101);
      expect(r2.issueNumber).toBe(101);
    });
  });

  describe("coveredBy", () => {
    it("returns covered without creating or editing when coveredBy matches an open issue", async () => {
      mockListOpenIssues.mockResolvedValue([]);
      mockListOpenIssues.mockResolvedValue([
        { number: 55, title: "Unrelated", body: "mentions the workload", labels: [{ name: "external" }] },
      ]);

      const result = await ensureAlertIssue({
        ...OPTS,
        coveredBy: (issue) => issue.number === 55,
      });

      expect(result).toEqual({ outcome: "covered", issueNumber: 55 });
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockEditIssue).not.toHaveBeenCalled();
    });

    it("is ignored when an issue with a matching title exists", async () => {
      mockListOpenIssues.mockResolvedValue([{ number: 9, title: OPTS.title, labels: [] }]);
      mockGetIssueBody.mockResolvedValue(
        `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`,
      );
      const coveredBy = vi.fn().mockReturnValue(true);

      const result = await ensureAlertIssue({ ...OPTS, coveredBy });

      expect(result.outcome).toBe("updated");
      expect(result.issueNumber).toBe(9);
      expect(coveredBy).not.toHaveBeenCalled();
    });
  });
});

describe("upsertAlertIssue concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("serializes two concurrent calls for the same repo+title so only one issue is created", async () => {
    const opts = { repo: "org/repo", title: "Alert: upsert race", body: "Current body.", labels: ["bug"], logPrefix: "test" };
    mockListOpenIssues.mockResolvedValue([]);
    mockCreateIssue.mockResolvedValue(202);
    mockGetIssueBody.mockResolvedValue("Current body.");

    const [r1, r2] = await Promise.all([upsertAlertIssue(opts), upsertAlertIssue(opts)]);

    expect(mockCreateIssue).toHaveBeenCalledTimes(1);
    expect([r1, r2].sort()).toEqual(["created", "unchanged"]);
  });
});

describe("closeAlertIssueIfResolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null and does not close when no matching open issue exists", async () => {
    mockListOpenIssues.mockResolvedValue([]);

    const result = await closeAlertIssueIfResolved({
      repo: "owner/repo",
      title: "T",
      logPrefix: "test",
    });

    expect(result).toBeNull();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("closes the matching issue and returns its number", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "T", labels: [] }]);
    mockCloseIssue.mockResolvedValue(undefined);

    const result = await closeAlertIssueIfResolved({
      repo: "owner/repo",
      title: "T",
      logPrefix: "test",
    });

    expect(result).toBe(42);
    expect(mockCloseIssue).toHaveBeenCalledWith("owner/repo", 42, "completed");
  });

  it("propagates errors from closeIssue", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "T", labels: [] }]);
    mockCloseIssue.mockRejectedValue(new Error("boom"));

    await expect(
      closeAlertIssueIfResolved({ repo: "owner/repo", title: "T", logPrefix: "test" }),
    ).rejects.toThrow("boom");
  });
});

describe("retitled automation issues (filed title)", () => {
  const OPTS = { repo: "org/repo", title: "Build failure: X", body: "Details.", labels: ["bug"], timestamp: TS1, logPrefix: "test" };
  const TRACKED = `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIssueBody.mockResolvedValue(TRACKED);
    mockCloseIssue.mockResolvedValue(undefined);
    mockCommentOnIssue.mockResolvedValue(undefined);
  });

  it("ensureAlertIssue updates an issue retitled by the writer without renaming it", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 7, title: "Renamed by writer", filedTitle: OPTS.title, labels: [] }]);

    const result = await ensureAlertIssue({ ...OPTS, legacyTitles: ["Old"] });

    expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
    expect(mockEditIssue).toHaveBeenCalledWith(OPTS.repo, 7, expect.stringContaining("**Occurrences:** 2"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
    expect(mockEditIssueTitle).not.toHaveBeenCalled();
  });

  it("keeps the lowest id among N duplicates and closes the rest as superseded", async () => {
    mockListOpenIssues.mockResolvedValue([
      { number: "clw_C", title: "Renamed 3", filedTitle: OPTS.title, labels: [] },
      { number: "clw_A", title: "Renamed 1", filedTitle: OPTS.title, labels: [] },
      { number: "clw_B", title: OPTS.title, labels: [] },
    ]);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "updated", issueNumber: "clw_A" });
    expect(mockCommentOnIssue).toHaveBeenCalledWith(OPTS.repo, "clw_B", "Superseded by #clw_A.");
    expect(mockCommentOnIssue).toHaveBeenCalledWith(OPTS.repo, "clw_C", "Superseded by #clw_A.");
    expect(mockCloseIssue).toHaveBeenCalledWith(OPTS.repo, "clw_B", "not_planned");
    expect(mockCloseIssue).toHaveBeenCalledWith(OPTS.repo, "clw_C", "not_planned");
    expect(mockCloseIssue).toHaveBeenCalledTimes(2);
  });

  it("closeAlertIssueIfResolved closes the retitled issue as completed", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 7, title: "Renamed", filedTitle: "T", labels: [] }]);
    const result = await closeAlertIssueIfResolved({ repo: "o/r", title: "T", logPrefix: "test" });
    expect(result).toBe(7);
    expect(mockCloseIssue).toHaveBeenCalledWith("o/r", 7, "completed");
  });

  it("upsertAlertIssue updates rather than creates for a retitled issue", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 7, title: "Renamed", filedTitle: "T", labels: [] }]);
    mockGetIssueBody.mockResolvedValue("old");
    const result = await upsertAlertIssue({ repo: "o/r", title: "T", body: "new", labels: [], logPrefix: "test" });
    expect(result).not.toBe("created");
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("resolveAlertIssue returns labels and null when nothing matches", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 7, title: "Renamed", filedTitle: "T", labels: [{ name: "Refined" }] }]);
    expect(await resolveAlertIssue({ repo: "o/r", title: "T", logPrefix: "t" })).toEqual({ number: 7, title: "Renamed", labels: ["Refined"] });
    expect(await resolveAlertIssue({ repo: "o/r", title: "Other", logPrefix: "t" })).toBeNull();
  });
});

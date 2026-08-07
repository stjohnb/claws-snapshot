import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFindIssueByExactTitle = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
const mockCloseIssue = vi.hoisted(() => vi.fn());
const mockListOpenIssues = vi.hoisted(() => vi.fn());
const mockEditIssueTitle = vi.hoisted(() => vi.fn());
const mockCommentOnIssue = vi.hoisted(() => vi.fn());
vi.mock("./github.js", () => ({
  findIssueByExactTitle: mockFindIssueByExactTitle,
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
}));

import { appendOccurrenceTracking, updateOccurrenceTracking, applyOccurrenceTracking, ensureAlertIssue, closeAlertIssueIfResolved, parseOccurrenceCount, parseFirstSeen, rebuildOccurrenceTracking } from "./occurrence-tracking.js";

const TS1 = "2024-01-01T00:00:00.000Z";
const TS2 = "2024-01-02T00:00:00.000Z";

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
    mockFindIssueByExactTitle.mockResolvedValue(null);
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
    mockFindIssueByExactTitle.mockResolvedValue({ title: OPTS.title, number: 7 });
    mockGetIssueBody.mockResolvedValue(existingBody);
    mockEditIssue.mockResolvedValue(undefined);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
    expect(mockEditIssue).toHaveBeenCalledWith(OPTS.repo, 7, expect.stringContaining("**Occurrences:** 2"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("returns tracking-not-updated when tracking block is not at end of body", async () => {
    const bodyWithTrailingNote = `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1\n\nSomeone added a note after the tracking block.`;
    mockFindIssueByExactTitle.mockResolvedValue({ title: OPTS.title, number: 99 });
    mockGetIssueBody.mockResolvedValue(bodyWithTrailingNote);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "tracking-not-updated", issueNumber: 99 });
    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("does not consult listOpenIssues when legacyTitles is absent", async () => {
    mockFindIssueByExactTitle.mockResolvedValue(null);
    mockCreateIssue.mockResolvedValue(1);

    await ensureAlertIssue(OPTS);

    expect(mockListOpenIssues).not.toHaveBeenCalled();
    expect(mockFindIssueByExactTitle).toHaveBeenCalledWith(OPTS.repo, OPTS.title);
  });

  describe("with legacyTitles", () => {
    const LEGACY_OPTS = { ...OPTS, legacyTitles: ["Old alert A", "Old alert B"] };

    it("renames a legacy-titled issue instead of creating a new one", async () => {
      mockListOpenIssues.mockResolvedValue([
        { number: 5, title: "Unrelated" },
        { number: 7, title: "Old alert B" },
      ]);
      mockGetIssueBody.mockResolvedValue(
        `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`,
      );

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
      expect(mockEditIssueTitle).toHaveBeenCalledWith(OPTS.repo, 7, OPTS.title);
      expect(mockCreateIssue).not.toHaveBeenCalled();
      expect(mockFindIssueByExactTitle).not.toHaveBeenCalled();
    });

    it("does not rename when an issue with the new title is already open", async () => {
      mockListOpenIssues.mockResolvedValue([
        { number: 7, title: "Old alert A" },
        { number: 9, title: OPTS.title },
      ]);
      mockGetIssueBody.mockResolvedValue(
        `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`,
      );

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "updated", issueNumber: 9 });
      expect(mockEditIssueTitle).not.toHaveBeenCalled();
    });

    it("creates an issue when neither the new nor a legacy title is open", async () => {
      mockListOpenIssues.mockResolvedValue([{ number: 5, title: "Unrelated" }]);
      mockCreateIssue.mockResolvedValue(42);

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "created", issueNumber: 42 });
      expect(mockEditIssueTitle).not.toHaveBeenCalled();
    });

    it("keeps the lowest-numbered legacy match and closes the others as superseded", async () => {
      mockListOpenIssues.mockResolvedValue([
        { number: 31, title: "Old alert B" },
        { number: 14, title: "Old alert A" },
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
        { number: 14, title: "Old alert A" },
        { number: 31, title: "Old alert B" },
      ]);
      mockCommentOnIssue.mockRejectedValue(new Error("boom"));
      mockGetIssueBody.mockResolvedValue("Details.");

      const result = await ensureAlertIssue(LEGACY_OPTS);

      expect(result).toEqual({ outcome: "updated", issueNumber: 14 });
      expect(mockEditIssue).toHaveBeenCalled();
    });

    it("replaces the body when refreshBody is set, preserving First seen", async () => {
      mockListOpenIssues.mockResolvedValue([{ number: 7, title: OPTS.title }]);
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
      mockListOpenIssues.mockResolvedValue([{ number: 7, title: OPTS.title }]);
      mockGetIssueBody.mockResolvedValue(
        `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1\n\nA hand-written note.`,
      );

      const result = await ensureAlertIssue({ ...LEGACY_OPTS, refreshBody: true });

      expect(result.outcome).toBe("updated");
    });
  });
});

describe("closeAlertIssueIfResolved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null and does not close when no matching open issue exists", async () => {
    mockFindIssueByExactTitle.mockResolvedValue(null);

    const result = await closeAlertIssueIfResolved({
      repo: "owner/repo",
      title: "T",
      logPrefix: "test",
    });

    expect(result).toBeNull();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("closes the matching issue and returns its number", async () => {
    mockFindIssueByExactTitle.mockResolvedValue({ number: 42, title: "T" });
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
    mockFindIssueByExactTitle.mockResolvedValue({ number: 42, title: "T" });
    mockCloseIssue.mockRejectedValue(new Error("boom"));

    await expect(
      closeAlertIssueIfResolved({ repo: "owner/repo", title: "T", logPrefix: "test" }),
    ).rejects.toThrow("boom");
  });
});

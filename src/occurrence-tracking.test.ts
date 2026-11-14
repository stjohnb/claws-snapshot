import { describe, it, expect, vi, beforeEach } from "vitest";

const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
const mockCloseIssue = vi.hoisted(() => vi.fn());
const mockListOpenIssues = vi.hoisted(() => vi.fn());
const mockEditIssueTitle = vi.hoisted(() => vi.fn());
const mockCommentOnIssue = vi.hoisted(() => vi.fn());
vi.mock("./github.js", () => ({
  createIssue: mockCreateIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
  closeIssue: mockCloseIssue,
  listOpenIssues: mockListOpenIssues,
  editIssueTitle: mockEditIssueTitle,
  commentOnIssue: mockCommentOnIssue,
}));

const mockSetAlertKind = vi.hoisted(() => vi.fn());
const mockGetClawsIssue = vi.hoisted(() => vi.fn());
const mockListPlans = vi.hoisted(() => vi.fn());
const mockListOpenPrs = vi.hoisted(() => vi.fn());
const mockGetLinkedNativeId = vi.hoisted(() => vi.fn());
vi.mock("./db.js", () => ({
  setClawsIssueAlertKind: mockSetAlertKind,
  getClawsIssue: mockGetClawsIssue,
  listClawsIssuePlans: mockListPlans,
  listOpenClawsPrsForIssue: mockListOpenPrs,
  getLinkedNativeId: mockGetLinkedNativeId,
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import { appendOccurrenceTracking, updateOccurrenceTracking, applyOccurrenceTracking, ensureAlertIssue, upsertAlertIssue, closeAlertIssueIfResolved, resolveAlertIssue, parseOccurrenceCount, parseFirstSeen, rebuildOccurrenceTracking, stripOccurrenceTracking, stripResolvedNote, withResolvedNote, RESOLVED_NOTE_PREFIX, __resetOccurrenceTrackingForTests, recordAlertOnOccurrenceBlock, parseOccurrenceAlerts, MAX_OCCURRENCE_ALERTS, mergeOccurrenceTracking } from "./occurrence-tracking.js";

const TS1 = "2024-01-01T00:00:00.000Z";
const TS2 = "2024-01-02T00:00:00.000Z";

beforeEach(() => {
  __resetOccurrenceTrackingForTests();
  mockGetClawsIssue.mockResolvedValue(undefined);
  mockListPlans.mockResolvedValue([]);
  mockListOpenPrs.mockResolvedValue([]);
  mockGetLinkedNativeId.mockResolvedValue(undefined);
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

describe("mergeOccurrenceTracking", () => {
  const block = (prose: string, first: string, last: string, count: number, alerts?: string[]) =>
    [prose, "", "---", ...(alerts ? [`**Alerts:** ${alerts.join(", ")}`] : []), `**First seen:** ${first}`, `**Last seen:** ${last}`, `**Occurrences:** ${count}`].join("\n");

  it("unions the alert names and keeps the earliest first seen, the latest last seen and the summed count", () => {
    const target = block("Target prose.", "2026-11-02T00:00:00Z", "2026-11-05T00:00:00Z", 4, ["DiskFull", "PodCrash"]);
    const source = block("Source prose.", "2026-11-01T00:00:00Z", "2026-11-03T00:00:00Z", 3, ["OOMKilled", "PodCrash"]);
    expect(mergeOccurrenceTracking(target, source)).toBe(
      block("Target prose.", "2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z", 7, ["DiskFull", "OOMKilled", "PodCrash"]),
    );
  });

  it("takes the source's last seen when it is later, and adds an Alerts line the target lacked", () => {
    const target = block("T", "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z", 1);
    const source = block("S", "2026-11-04T00:00:00Z", "2026-11-06T00:00:00Z", 2, ["Down"]);
    expect(mergeOccurrenceTracking(target, source)).toBe(block("T", "2026-11-02T00:00:00Z", "2026-11-06T00:00:00Z", 3, ["Down"]));
  });

  it("caps the Alerts line, keeping the target's names", () => {
    const own = Array.from({ length: MAX_OCCURRENCE_ALERTS - 1 }, (_, i) => `A${String(i).padStart(2, "0")}`);
    const target = block("T", TS1, TS2, 1, own);
    const source = block("S", TS1, TS2, 1, ["Z1", "Z2", "Z3"]);
    const merged = parseOccurrenceAlerts(mergeOccurrenceTracking(target, source));
    expect(merged).toHaveLength(MAX_OCCURRENCE_ALERTS);
    expect(merged).toEqual([...own, "Z1"]);
  });

  it("appends the source's block to a target that has none", () => {
    const source = block("S", TS1, TS2, 5, ["Down"]);
    expect(mergeOccurrenceTracking("Target prose.\n", source)).toBe(block("Target prose.", TS1, TS2, 5, ["Down"]));
    expect(mergeOccurrenceTracking("", block("S", TS1, TS2, 2))).toBe(["---", `**First seen:** ${TS1}`, `**Last seen:** ${TS2}`, "**Occurrences:** 2"].join("\n"));
  });

  it("leaves the target unchanged when the source has no block", () => {
    const target = block("T", TS1, TS2, 2);
    expect(mergeOccurrenceTracking(target, "Just prose.")).toBe(target);
    expect(mergeOccurrenceTracking("No block either.", "")).toBe("No block either.");
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
      { alertKind: "test" },
    );
    expect(mockEditIssue).not.toHaveBeenCalled();
  });

  it("files a Blocked alert with its reason", async () => {
    mockListOpenIssues.mockResolvedValue([]);
    mockCreateIssue.mockResolvedValue(43);

    await ensureAlertIssue({ ...OPTS, title: "Alert: blocked", labels: ["Blocked"], blockedReason: "A person must look" });

    expect(mockCreateIssue).toHaveBeenCalledWith(OPTS.repo, "Alert: blocked", expect.any(String), ["Blocked"], { blockedReason: "A person must look", alertKind: "test" });
  });

  it("marks an existing native alert issue as an alert on update", async () => {
    mockListOpenIssues.mockResolvedValue([{ title: OPTS.title, number: "clw_01M5YPSK289NXAK8E6K6RNTFS5", labels: [] }]);
    mockGetIssueBody.mockResolvedValue(`Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1`);

    const result = await ensureAlertIssue({ ...OPTS, timestamp: TS2 });

    expect(result).toEqual({ outcome: "updated", issueNumber: "clw_01M5YPSK289NXAK8E6K6RNTFS5" });
    expect(mockSetAlertKind).toHaveBeenCalledWith("clw_01M5YPSK289NXAK8E6K6RNTFS5", "test");
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

    it("applies updateBody to the stripped current body and rebuilds tracking", async () => {
      mockListOpenIssues.mockResolvedValue([{ number: 7, title: OPTS.title, labels: [] }]);
      mockGetIssueBody.mockResolvedValue(
        `Entry A\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 3`,
      );
      const updateBody = vi.fn((cur: string) => `${cur}\n\nEntry B`);

      const result = await ensureAlertIssue({ ...LEGACY_OPTS, updateBody, timestamp: TS2 });

      expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
      expect(updateBody).toHaveBeenCalledWith("Entry A");
      expect(mockEditIssue).toHaveBeenCalledWith(
        OPTS.repo,
        7,
        `Entry A\n\nEntry B\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS2}\n**Occurrences:** 4`,
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

describe("upsertAlertIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("files a Blocked alert with its reason", async () => {
    mockListOpenIssues.mockResolvedValue([]);
    mockCreateIssue.mockResolvedValue(44);

    await upsertAlertIssue({ repo: "org/repo", title: "Alert: upsert blocked", body: "B", labels: ["Blocked"], blockedReason: "A person must look", logPrefix: "test" });

    expect(mockCreateIssue).toHaveBeenCalledWith("org/repo", "Alert: upsert blocked", "B", ["Blocked"], { blockedReason: "A person must look", alertKind: "test" });
  });

  it("marks an existing native alert issue as an alert even when its body is unchanged", async () => {
    mockListOpenIssues.mockResolvedValue([{ title: "Alert: upsert same", number: "clw_01M5YPSK289NXAK8E6K6RNTFS6", labels: [] }]);
    mockGetIssueBody.mockResolvedValue("B");

    expect(await upsertAlertIssue({ repo: "org/repo", title: "Alert: upsert same", body: "B", labels: [], logPrefix: "runner-monitor" })).toBe("unchanged");
    expect(mockSetAlertKind).toHaveBeenCalledWith("clw_01M5YPSK289NXAK8E6K6RNTFS6", "runner-monitor");
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

describe("closeAlertIssueIfResolved with a pending plan", () => {
  const NATIVE = "clw_01M6KJP18TGA8DX826JFMAAZ4N";
  const TRACKED = `Details.\n\n---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 3`;
  const OPTS = { repo: "owner/repo", title: "T", logPrefix: "test", timestamp: TS2 };

  beforeEach(() => {
    vi.clearAllMocks();
    mockListOpenIssues.mockResolvedValue([{ number: NATIVE, title: "T", labels: [] }]);
    mockGetIssueBody.mockResolvedValue(TRACKED);
    mockEditIssue.mockResolvedValue(undefined);
    mockCloseIssue.mockResolvedValue(undefined);
  });

  it("holds an issue with a plan open and notes it once", async () => {
    mockListPlans.mockResolvedValue([{ version: 1 }]);

    expect(await closeAlertIssueIfResolved(OPTS)).toBeNull();
    expect(mockCloseIssue).not.toHaveBeenCalled();
    expect(mockEditIssue).toHaveBeenCalledTimes(1);
    const edited = mockEditIssue.mock.calls[0][2] as string;
    expect(edited.indexOf(RESOLVED_NOTE_PREFIX)).toBeLessThan(edited.indexOf("---"));
    expect(parseOccurrenceCount(edited)).toBe(3);
    expect(parseFirstSeen(edited)).toBe(TS1);

    mockGetIssueBody.mockResolvedValue(edited);
    expect(await closeAlertIssueIfResolved(OPTS)).toBeNull();
    expect(mockEditIssue).toHaveBeenCalledTimes(1);
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("holds an issue approved through Plan", async () => {
    mockGetClawsIssue.mockResolvedValue({ approved_through: "plan" });
    expect(await closeAlertIssueIfResolved(OPTS)).toBeNull();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("holds an issue with an open Claws PR", async () => {
    mockListOpenPrs.mockResolvedValue([{ number: 1 }]);
    expect(await closeAlertIssueIfResolved(OPTS)).toBeNull();
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("closes a native issue with no plan, approval or PR", async () => {
    expect(await closeAlertIssueIfResolved(OPTS)).toBe(NATIVE);
    expect(mockCloseIssue).toHaveBeenCalledWith("owner/repo", NATIVE, "completed");
  });

  it("closes a forge-numbered issue with no linked native id", async () => {
    mockListOpenIssues.mockResolvedValue([{ number: 42, title: "T", labels: [] }]);
    mockListPlans.mockResolvedValue([{ version: 1 }]);
    expect(await closeAlertIssueIfResolved(OPTS)).toBe(42);
  });

  it("flap: clear adds the note, re-fire drops it and counts, next clear re-adds it", async () => {
    mockListPlans.mockResolvedValue([{ version: 1 }]);
    await closeAlertIssueIfResolved(OPTS);
    const held = mockEditIssue.mock.calls[0][2] as string;

    mockGetIssueBody.mockResolvedValue(held);
    await ensureAlertIssue({ repo: "owner/repo", title: "T", body: "Details.", timestamp: TS2, logPrefix: "test" });
    const refired = mockEditIssue.mock.calls[1][2] as string;
    expect(refired).not.toContain(RESOLVED_NOTE_PREFIX);
    expect(parseOccurrenceCount(refired)).toBe(4);

    mockGetIssueBody.mockResolvedValue(refired);
    await closeAlertIssueIfResolved(OPTS);
    const reheld = mockEditIssue.mock.calls[2][2] as string;
    expect(reheld).toContain(RESOLVED_NOTE_PREFIX);
    expect(parseOccurrenceCount(reheld)).toBe(4);
    expect(mockCloseIssue).not.toHaveBeenCalled();
  });

  it("refreshBody re-fire strips the note and increments", async () => {
    const held = withResolvedNote(TRACKED, TS2);
    mockGetIssueBody.mockResolvedValue(held);
    await ensureAlertIssue({ repo: "owner/repo", title: "T", body: "New.", refreshBody: true, timestamp: TS2, logPrefix: "test" });
    const out = mockEditIssue.mock.calls[0][2] as string;
    expect(out).not.toContain(RESOLVED_NOTE_PREFIX);
    expect(parseOccurrenceCount(out)).toBe(4);
    expect(stripResolvedNote(held)).toBe(TRACKED);
  });

  it("notes a body without a tracking block and round-trips it", () => {
    const plain = "Plain upsert body.";
    const noted = withResolvedNote(plain, TS2);
    expect(noted).toContain(RESOLVED_NOTE_PREFIX);
    expect(stripResolvedNote(noted)).toBe(plain);
  });

  it("stripResolvedNote leaves no leading blank lines when the note is the whole prose", () => {
    const noted = withResolvedNote(`---\n**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 2`, TS2);
    const bare = withResolvedNote("", TS2);
    expect(stripResolvedNote(bare)).toBe("");
    expect(stripResolvedNote(noted).startsWith("\n")).toBe(false);
  });

  it("holds an upsert-filed issue (no occurrence block) and notes it", async () => {
    mockListPlans.mockResolvedValue([{ version: 1 }]);
    mockGetIssueBody.mockResolvedValue("Plain upsert body.");
    expect(await closeAlertIssueIfResolved(OPTS)).toBeNull();
    const edited = mockEditIssue.mock.calls[0][2] as string;
    expect(edited).toContain(RESOLVED_NOTE_PREFIX);
    expect(stripResolvedNote(edited)).toBe("Plain upsert body.");
  });

  it("force closes even with a plan", async () => {
    mockListPlans.mockResolvedValue([{ version: 1 }]);
    expect(await closeAlertIssueIfResolved({ ...OPTS, force: true })).toBe(NATIVE);
    expect(mockCloseIssue).toHaveBeenCalled();
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

describe("appendOccurrenceTracking firstSeen", () => {
  it("uses the given first-seen time with the new firing as last seen", () => {
    expect(appendOccurrenceTracking("b", "2026-10-02T00:00:00Z", 2, "2026-10-01T00:00:00Z"))
      .toBe("b\n\n---\n**First seen:** 2026-10-01T00:00:00Z\n**Last seen:** 2026-10-02T00:00:00Z\n**Occurrences:** 2");
  });
  it("defaults first seen to the timestamp", () => {
    expect(appendOccurrenceTracking("b", "T")).toBe("b\n\n---\n**First seen:** T\n**Last seen:** T\n**Occurrences:** 1");
  });
});

describe("stripOccurrenceTracking", () => {
  it("removes the trailing tracking block", () => {
    const body = appendOccurrenceTracking("Prose.", TS1);
    expect(stripOccurrenceTracking(body)).toBe("Prose.");
  });

  it("returns a body without tracking unchanged", () => {
    expect(stripOccurrenceTracking("Prose only.")).toBe("Prose only.");
  });
});

describe("recordAlertOnOccurrenceBlock", () => {
  const BLOCK = "Body.\n\n---\n**First seen:** 2026-10-10T00:00:00Z\n**Last seen:** 2026-10-12T00:00:00Z\n**Occurrences:** 4";

  it("adds an Alerts line between the --- and First seen", () => {
    const out = recordAlertOnOccurrenceBlock(BLOCK, "Latency");
    expect(out).toBe("Body.\n\n---\n**Alerts:** Latency\n**First seen:** 2026-10-10T00:00:00Z\n**Last seen:** 2026-10-12T00:00:00Z\n**Occurrences:** 4");
    expect(parseOccurrenceAlerts(out)).toEqual(["Latency"]);
  });

  it("keeps the list sorted and unique", () => {
    const once = recordAlertOnOccurrenceBlock(recordAlertOnOccurrenceBlock(BLOCK, "Latency"), "Error logged");
    expect(parseOccurrenceAlerts(once)).toEqual(["Error logged", "Latency"]);
    expect(recordAlertOnOccurrenceBlock(once, "Latency")).toBe(once);
    expect(once.match(/\*\*Alerts:\*\*/g)).toHaveLength(1);
  });

  it("lists at most the maximum number of names", () => {
    let body = BLOCK;
    for (let i = 0; i < MAX_OCCURRENCE_ALERTS + 5; i++) body = recordAlertOnOccurrenceBlock(body, `A${String(i).padStart(2, "0")}`);
    const names = parseOccurrenceAlerts(body);
    expect(names).toHaveLength(MAX_OCCURRENCE_ALERTS);
    expect(names).toContain("A00");
    expect(names).not.toContain(`A${MAX_OCCURRENCE_ALERTS}`);
  });

  it("leaves a body with no trailing block, or an empty name, alone", () => {
    expect(recordAlertOnOccurrenceBlock("Body.", "Latency")).toBe("Body.");
    expect(recordAlertOnOccurrenceBlock(BLOCK, "  ")).toBe(BLOCK);
    expect(parseOccurrenceAlerts(BLOCK)).toEqual([]);
  });

  it("keeps updateOccurrenceTracking working with the line present", () => {
    const withLine = recordAlertOnOccurrenceBlock(BLOCK, "Latency");
    expect(updateOccurrenceTracking(withLine, "2026-10-16T00:00:00Z"))
      .toBe("Body.\n\n---\n**Alerts:** Latency\n**First seen:** 2026-10-10T00:00:00Z\n**Last seen:** 2026-10-16T00:00:00Z\n**Occurrences:** 5");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSearchIssues = vi.hoisted(() => vi.fn());
const mockCreateIssue = vi.hoisted(() => vi.fn());
const mockGetIssueBody = vi.hoisted(() => vi.fn());
const mockEditIssue = vi.hoisted(() => vi.fn());
vi.mock("./github.js", () => ({
  searchIssues: mockSearchIssues,
  createIssue: mockCreateIssue,
  getIssueBody: mockGetIssueBody,
  editIssue: mockEditIssue,
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { appendOccurrenceTracking, updateOccurrenceTracking, applyOccurrenceTracking, ensureAlertIssue } from "./occurrence-tracking.js";

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
    mockSearchIssues.mockResolvedValue([]);
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
    mockSearchIssues.mockResolvedValue([{ title: OPTS.title, number: 7 }]);
    mockGetIssueBody.mockResolvedValue(existingBody);
    mockEditIssue.mockResolvedValue(undefined);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "updated", issueNumber: 7 });
    expect(mockEditIssue).toHaveBeenCalledWith(OPTS.repo, 7, expect.stringContaining("**Occurrences:** 2"));
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });

  it("returns tracking-not-updated when tracking block is not at end of body", async () => {
    const bodyWithTrailingNote = `**First seen:** ${TS1}\n**Last seen:** ${TS1}\n**Occurrences:** 1\n\nSomeone added a note after the tracking block.`;
    mockSearchIssues.mockResolvedValue([{ title: OPTS.title, number: 99 }]);
    mockGetIssueBody.mockResolvedValue(bodyWithTrailingNote);

    const result = await ensureAlertIssue(OPTS);

    expect(result).toEqual({ outcome: "tracking-not-updated", issueNumber: 99 });
    expect(mockEditIssue).not.toHaveBeenCalled();
    expect(mockCreateIssue).not.toHaveBeenCalled();
  });
});

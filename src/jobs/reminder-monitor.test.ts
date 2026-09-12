import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  LABELS: { priority: "Priority" },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockReportError } = vi.hoisted(() => ({
  mockReportError: vi.fn(),
}));
vi.mock("../error-reporter.js", () => ({
  reportError: mockReportError,
}));

const { mockDb, mockGh, mockOccurrenceTracking } = vi.hoisted(() => ({
  mockDb: {
    hasReminderFired: vi.fn(),
    recordReminderFired: vi.fn(),
  },
  mockGh: {
    listRepoDirectory: vi.fn(),
    fetchRepoFileContent: vi.fn(),
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
  },
  mockOccurrenceTracking: {
    ensureAlertIssue: vi.fn(),
    closeAlertIssueIfResolved: vi.fn(),
  },
}));

vi.mock("../db.js", () => mockDb);
vi.mock("../github.js", () => mockGh);
vi.mock("../occurrence-tracking.js", () => mockOccurrenceTracking);

import { run, parseReminderFile, isDue, todayLocalDate, type Reminder } from "./reminder-monitor.js";

const VALID_FILE = `---
id: aws-key-rotation
title: Rotate the AWS deploy key
notify_on: 2026-09-01
expires_on: 2026-10-01
owner: stjohnb
priority: true
---

1. Do the thing.
2. Do the other thing.
`;

describe("reminder-monitor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGh.listRepoDirectory.mockResolvedValue([]);
    mockGh.fetchRepoFileContent.mockResolvedValue(null);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(42);
    mockDb.hasReminderFired.mockReturnValue(false);
    mockOccurrenceTracking.ensureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });
    mockOccurrenceTracking.closeAlertIssueIfResolved.mockResolvedValue(null);
  });

  describe("parseReminderFile", () => {
    it("parses a valid file", () => {
      const result = parseReminderFile("aws-key-rotation.md", VALID_FILE);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.reminder.id).toBe("aws-key-rotation");
      expect(result.reminder.title).toBe("Rotate the AWS deploy key");
      expect(result.reminder.notify_on).toBe("2026-09-01");
      expect(result.reminder.expires_on).toBe("2026-10-01");
      expect(result.reminder.body).toContain("Do the thing.");
    });

    it("rejects a file with missing frontmatter", () => {
      const result = parseReminderFile("f.md", "no frontmatter here\n");
      expect(result.ok).toBe(false);
    });

    it("rejects invalid YAML", () => {
      const result = parseReminderFile("f.md", "---\ntitle: [unterminated\n---\nbody\n");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/invalid YAML/);
    });

    it("rejects a file missing title", () => {
      const result = parseReminderFile("f.md", "---\nnotify_on: 2026-09-01\n---\nbody\n");
      expect(result.ok).toBe(false);
    });

    it("rejects a malformed notify_on date format", () => {
      const result = parseReminderFile("f.md", "---\ntitle: X\nnotify_on: 2026-9-1\n---\nbody\n");
      expect(result.ok).toBe(false);
    });

    it("rejects an out-of-range calendar date", () => {
      const result = parseReminderFile("f.md", "---\ntitle: X\nnotify_on: 2026-13-45\n---\nbody\n");
      expect(result.ok).toBe(false);
    });

    it("rejects a body beginning with a reserved Claws control marker", () => {
      const content = "---\ntitle: X\nnotify_on: 2026-09-01\n---\nCLAWS_TRANSFER_TO: owner/repo\n";
      const result = parseReminderFile("f.md", content);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error).toMatch(/reserved/);
    });

    it("defaults id from the filename when frontmatter omits it", () => {
      const content = "---\ntitle: X\nnotify_on: 2026-09-01\n---\nsteps\n";
      const result = parseReminderFile("my-reminder.md", content);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.reminder.id).toBe("my-reminder");
    });
  });

  describe("isDue", () => {
    const reminder: Reminder = { id: "x", title: "X", notify_on: "2026-09-01", body: "" };

    it("is true when today equals notify_on", () => {
      expect(isDue(reminder, "2026-09-01")).toBe(true);
    });

    it("is true when today is after notify_on", () => {
      expect(isDue(reminder, "2026-09-05")).toBe(true);
    });

    it("is false when today is before notify_on", () => {
      expect(isDue(reminder, "2026-08-31")).toBe(false);
    });
  });

  describe("todayLocalDate", () => {
    it("formats using local getters", () => {
      expect(todayLocalDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    });
  });

  describe("run", () => {
    const repo = mockRepo();

    it("files an issue for a due reminder and records it", async () => {
      mockGh.listRepoDirectory.mockResolvedValue([
        { name: "aws-key-rotation.md", path: "docs/scheduled-reminders/aws-key-rotation.md", sha: "abc", type: "file" },
      ]);
      mockGh.fetchRepoFileContent.mockResolvedValue(VALID_FILE);

      await run([repo], new Date(2026, 8, 1));

      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
      expect(mockDb.recordReminderFired).toHaveBeenCalledWith(
        repo.fullName,
        "aws-key-rotation",
        "2026-09-01",
        42,
      );
    });

    it("does not create an issue when hasReminderFired returns true", async () => {
      mockGh.listRepoDirectory.mockResolvedValue([
        { name: "aws-key-rotation.md", path: "docs/scheduled-reminders/aws-key-rotation.md", sha: "abc", type: "file" },
      ]);
      mockGh.fetchRepoFileContent.mockResolvedValue(VALID_FILE);
      mockDb.hasReminderFired.mockReturnValue(true);

      await run([repo], new Date(2026, 8, 1));

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("records without creating when an issue with the exact title already exists", async () => {
      mockGh.listRepoDirectory.mockResolvedValue([
        { name: "aws-key-rotation.md", path: "docs/scheduled-reminders/aws-key-rotation.md", sha: "abc", type: "file" },
      ]);
      mockGh.fetchRepoFileContent.mockResolvedValue(VALID_FILE);
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 99, title: "existing" });

      await run([repo], new Date(2026, 8, 1));

      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(mockDb.recordReminderFired).toHaveBeenCalledWith(
        repo.fullName,
        "aws-key-rotation",
        "2026-09-01",
        99,
      );
    });

    it("skips README.md and non-.md entries", async () => {
      mockGh.listRepoDirectory.mockResolvedValue([
        { name: "README.md", path: "docs/scheduled-reminders/README.md", sha: "a", type: "file" },
        { name: "notes.txt", path: "docs/scheduled-reminders/notes.txt", sha: "b", type: "file" },
      ]);

      await run([repo], new Date(2026, 8, 1));

      expect(mockGh.fetchRepoFileContent).not.toHaveBeenCalled();
      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });

    it("raises an alert issue for malformed files and closes it when the repo is clean", async () => {
      mockGh.listRepoDirectory.mockResolvedValue([
        { name: "bad.md", path: "docs/scheduled-reminders/bad.md", sha: "a", type: "file" },
      ]);
      mockGh.fetchRepoFileContent.mockResolvedValue("not frontmatter at all\n");

      await run([repo], new Date(2026, 8, 1));

      expect(mockOccurrenceTracking.ensureAlertIssue).toHaveBeenCalledTimes(1);
      expect(mockOccurrenceTracking.ensureAlertIssue.mock.calls[0]![0]).toMatchObject({
        repo: repo.fullName,
        title: "[reminder-monitor] Malformed files in docs/scheduled-reminders/",
      });
      expect(mockOccurrenceTracking.closeAlertIssueIfResolved).not.toHaveBeenCalled();

      vi.clearAllMocks();
      mockGh.listRepoDirectory.mockResolvedValue([]);

      await run([repo], new Date(2026, 8, 1));

      expect(mockOccurrenceTracking.closeAlertIssueIfResolved).toHaveBeenCalledTimes(1);
      expect(mockOccurrenceTracking.ensureAlertIssue).not.toHaveBeenCalled();
    });

    it("reports an error for a repo whose file fetch throws, without blocking other repos", async () => {
      const repoA = mockRepo({ fullName: "org/a" });
      const repoB = mockRepo({ fullName: "org/b" });
      mockGh.listRepoDirectory.mockImplementation(async (fullName: string) => {
        if (fullName === "org/a") {
          return [{ name: "x.md", path: "docs/scheduled-reminders/x.md", sha: "a", type: "file" }];
        }
        return [{ name: "y.md", path: "docs/scheduled-reminders/y.md", sha: "b", type: "file" }];
      });
      mockGh.fetchRepoFileContent.mockImplementation(async (fullName: string) => {
        if (fullName === "org/a") throw new Error("boom");
        return VALID_FILE;
      });

      await run([repoA, repoB], new Date(2026, 8, 1));

      expect(mockReportError).toHaveBeenCalledTimes(1);
      expect(mockReportError.mock.calls[0]![1]).toBe("org/a");
      expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
    });
  });
});

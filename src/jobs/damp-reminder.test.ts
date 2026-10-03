import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  SELF_REPO: "St-John-Software/claws",
  LABELS: { priority: "Priority" },
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const { mockGithub, mockDb } = vi.hoisted(() => ({
  mockGithub: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
    closeIssue: vi.fn(),
    commentOnIssue: vi.fn(),
  },
  mockDb: {
    hasDampReadingLoggedSince: vi.fn(),
  },
}));

vi.mock("../github.js", () => mockGithub);
vi.mock("../db.js", () => mockDb);

import { isReminderDay, run, weekStartMonday } from "./damp-reminder.js";

describe("damp-reminder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGithub.createIssue.mockResolvedValue(42);
    mockDb.hasDampReadingLoggedSince.mockReturnValue(false);
    mockGithub.findIssueByExactTitle.mockResolvedValue(null);
  });

  describe("isReminderDay", () => {
    it("returns true for a Monday", () => {
      expect(isReminderDay(new Date("2026-06-29T12:00:00"))).toBe(true);
    });

    it("returns false for a Tuesday", () => {
      expect(isReminderDay(new Date("2026-06-30T12:00:00"))).toBe(false);
    });
  });

  describe("weekStartMonday", () => {
    it("resolves to the current week's Monday at local midnight", () => {
      const result = weekStartMonday(new Date("2026-07-01T15:00:00"));
      expect(result.getDay()).toBe(1);
      expect(result.getHours()).toBe(0);
    });
  });

  describe("run", () => {
    it("files a reminder issue on Monday 09:00 when no readings are logged", async () => {
      await run(new Date("2026-06-29T09:00:00"));

      expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);
      const [repo, title] = mockGithub.createIssue.mock.calls[0];
      expect(repo).toBe("St-John-Software/claws");
      expect(title).toBe("[damp-reminder] Log this week's damp meter readings");
    });

    it("does not file a reminder issue on Monday before 09:00", async () => {
      await run(new Date("2026-06-29T08:00:00"));

      expect(mockGithub.createIssue).not.toHaveBeenCalled();
    });

    it("does not file a reminder issue on Tuesday", async () => {
      await run(new Date("2026-06-30T09:00:00"));

      expect(mockGithub.createIssue).not.toHaveBeenCalled();
      expect(mockGithub.closeIssue).not.toHaveBeenCalled();
    });

    it("closes the open reminder once readings are logged", async () => {
      mockDb.hasDampReadingLoggedSince.mockReturnValue(true);
      mockGithub.findIssueByExactTitle.mockResolvedValue({
        number: 7,
        title: "[damp-reminder] Log this week's damp meter readings",
      });

      await run(new Date("2026-06-30T09:00:00"));

      expect(mockGithub.commentOnIssue).toHaveBeenCalledTimes(1);
      expect(mockGithub.closeIssue).toHaveBeenCalledWith("St-John-Software/claws", 7, "completed");
      expect(mockGithub.createIssue).not.toHaveBeenCalled();
    });

    it("does not throw or close when readings are logged but no reminder issue is open", async () => {
      mockDb.hasDampReadingLoggedSince.mockReturnValue(true);
      mockGithub.findIssueByExactTitle.mockResolvedValue(null);

      await expect(run(new Date("2026-07-07T09:00:00"))).resolves.not.toThrow();
      expect(mockGithub.closeIssue).not.toHaveBeenCalled();
    });

    it("only checks GitHub once per week once the close has been handled", async () => {
      mockDb.hasDampReadingLoggedSince.mockReturnValue(true);
      mockGithub.findIssueByExactTitle.mockResolvedValue({
        number: 9,
        title: "[damp-reminder] Log this week's damp meter readings",
      });

      await run(new Date("2026-07-13T09:00:00")); // Monday
      await run(new Date("2026-07-13T09:15:00")); // same week, 15 minutes later

      expect(mockGithub.findIssueByExactTitle).toHaveBeenCalledTimes(1);
      expect(mockGithub.closeIssue).toHaveBeenCalledTimes(1);
      expect(mockGithub.commentOnIssue).toHaveBeenCalledTimes(1);
    });

    it("does not re-create or update an already-open reminder", async () => {
      mockGithub.findIssueByExactTitle.mockResolvedValue({
        number: 5,
        title: "[damp-reminder] Log this week's damp meter readings",
      });
      await run(new Date("2026-07-20T09:00:00")); // Monday
      await run(new Date("2026-07-20T09:15:00")); // same week, 15 min later
      expect(mockGithub.createIssue).not.toHaveBeenCalled();
      expect(mockGithub.findIssueByExactTitle).toHaveBeenCalledTimes(1); // per-week guard
    });
  });
});

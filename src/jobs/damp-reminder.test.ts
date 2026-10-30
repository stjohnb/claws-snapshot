import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  SELF_REPO: "St-John-Software/claws",
  LABELS: { priority: "Priority", backlog: "Backlog", blocked: "Blocked" },
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

import { isReminderDay, isReminderWeek, periodStartMonday, run, weekStartMonday } from "./damp-reminder.js";

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

  describe("reminder weeks", () => {
    it("alternates fortnightly from the 2026-10-26 anchor", () => {
      expect(isReminderWeek(new Date("2026-10-26T12:00:00"))).toBe(true);
      expect(isReminderWeek(new Date("2026-11-02T12:00:00"))).toBe(false);
      expect(isReminderWeek(new Date("2026-11-09T12:00:00"))).toBe(true);
      expect(isReminderWeek(new Date("2026-10-19T12:00:00"))).toBe(false);
      expect(isReminderWeek(new Date("2026-10-12T12:00:00"))).toBe(true);
    });

    it("resolves the period start to the reminder Monday", () => {
      expect(periodStartMonday(new Date("2026-11-04T10:00:00")).getTime()).toBe(new Date(2026, 9, 26).getTime());
      expect(periodStartMonday(new Date("2026-11-09T10:00:00")).getTime()).toBe(new Date(2026, 10, 9).getTime());
    });
  });

  describe("run", () => {
    it("creates nothing on a non-reminder Monday even with no readings", async () => {
      await run(new Date("2026-11-02T09:00:00"));
      expect(mockGithub.createIssue).not.toHaveBeenCalled();
    });

    it("closes the open reminder when readings are logged in the second week", async () => {
      mockDb.hasDampReadingLoggedSince.mockReturnValue(true);
      mockGithub.findIssueByExactTitle.mockResolvedValue({ number: 11, title: "x" });
      await run(new Date("2026-12-15T09:00:00")); // second week of the period starting 2026-12-07
      expect(mockDb.hasDampReadingLoggedSince).toHaveBeenCalledWith(new Date(2026, 11, 7).toISOString());
      expect(mockGithub.closeIssue).toHaveBeenCalledWith("St-John-Software/claws", 11, "completed");
    });

    it("recognises a legacy-titled reminder: not duplicated, and auto-closed", async () => {
      mockGithub.findIssueByExactTitle.mockImplementation(async (_r: string, t: string) =>
        t === "[damp-reminder] Log this week's damp meter readings" ? { number: 13, title: t } : null,
      );
      await run(new Date("2027-01-04T09:00:00")); // reminder Monday, legacy issue open
      expect(mockGithub.createIssue).not.toHaveBeenCalled();
      mockDb.hasDampReadingLoggedSince.mockReturnValue(true);
      await run(new Date("2027-01-05T09:00:00"));
      expect(mockGithub.closeIssue).toHaveBeenCalledWith("St-John-Software/claws", 13, "completed");
    });

    it("files a reminder issue on Monday 09:00 when no readings are logged", async () => {
      await run(new Date("2026-07-06T09:00:00"));

      expect(mockGithub.createIssue).toHaveBeenCalledTimes(1);
      const [repo, title, , labels, opts] = mockGithub.createIssue.mock.calls[0];
      expect(repo).toBe("St-John-Software/claws");
      expect(title).toBe("[damp-reminder] Log this fortnight's damp meter readings");
      // Held in Blocked so it is on the board but never refined or planned.
      expect(labels).toEqual(["Blocked"]);
      expect(opts.blockedReason).toBeTruthy();
    });

    it("does not file a reminder issue on Monday before 09:00", async () => {
      await run(new Date("2026-07-06T08:00:00"));

      expect(mockGithub.createIssue).not.toHaveBeenCalled();
    });

    it("does not file a reminder issue on Tuesday", async () => {
      await run(new Date("2026-07-07T09:00:00"));

      expect(mockGithub.createIssue).not.toHaveBeenCalled();
      expect(mockGithub.closeIssue).not.toHaveBeenCalled();
    });

    it("closes the open reminder once readings are logged", async () => {
      mockDb.hasDampReadingLoggedSince.mockReturnValue(true);
      mockGithub.findIssueByExactTitle.mockResolvedValue({
        number: 7,
        title: "[damp-reminder] Log this fortnight's damp meter readings",
      });

      await run(new Date("2026-08-04T09:00:00"));

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

    it("only checks GitHub once per period once the close has been handled", async () => {
      mockDb.hasDampReadingLoggedSince.mockReturnValue(true);
      mockGithub.findIssueByExactTitle.mockResolvedValue({
        number: 9,
        title: "[damp-reminder] Log this fortnight's damp meter readings",
      });

      await run(new Date("2026-08-17T09:00:00")); // Monday
      await run(new Date("2026-08-17T09:15:00")); // same period, 15 minutes later

      expect(mockGithub.findIssueByExactTitle).toHaveBeenCalledTimes(1);
      expect(mockGithub.closeIssue).toHaveBeenCalledTimes(1);
      expect(mockGithub.commentOnIssue).toHaveBeenCalledTimes(1);
    });

    it("does not re-create or update an already-open reminder", async () => {
      mockGithub.findIssueByExactTitle.mockResolvedValue({
        number: 5,
        title: "[damp-reminder] Log this fortnight's damp meter readings",
      });
      await run(new Date("2026-09-14T09:00:00")); // Monday
      await run(new Date("2026-09-14T09:15:00")); // same period, 15 min later
      expect(mockGithub.createIssue).not.toHaveBeenCalled();
      expect(mockGithub.findIssueByExactTitle).toHaveBeenCalledTimes(1); // per-period guard
    });
  });
});

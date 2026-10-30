import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FrictionNoteRow, Task } from "../db.js";
import type { Repo } from "../config.js";

vi.mock("../log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const reportError = vi.fn();
vi.mock("../error-reporter.js", () => ({ reportError: (...args: unknown[]) => reportError(...args) }));

const mockDb = {
  listUntriagedFrictionNotes: vi.fn(),
  lastFrictionRetrospectiveAt: vi.fn(),
  getTasksByIds: vi.fn(),
  markFrictionNotesTriaged: vi.fn(),
  withTaskRecording: vi.fn(async (_job: string, _repo: string, _item: unknown, _trigger: unknown, fn: (id: number) => Promise<unknown>) => fn(42)),
  trackTaskTokens: vi.fn(() => () => {}),
  recordTaskComplete: vi.fn(),
};
vi.mock("../db.js", () => mockDb);

const runClaude = vi.fn();
vi.mock("../claude.js", () => ({ runClaude: (...args: unknown[]) => runClaude(...args) }));

const mockIssues = {
  CLAWS_NATIVE_LOGIN: "claws",
  createIssue: vi.fn(),
  findOpenIssueByDedupeKey: vi.fn(),
};
vi.mock("../claws-issues.js", () => mockIssues);

const {
  retrospectiveDue, nextTimeBasedDue, buildRetrospectiveBody, retrospectiveTitle, retrospectiveRepos, run, localDate,
  draftFollowUps, validateProposals, MAX_PROPOSALS, RETRO_BLOCKED_REASON,
} = await import("./friction-retrospective.js");

// 2026-10-22 is a Thursday, 2026-10-23 a Friday, 2026-10-26 a Monday (local clock).
const THURSDAY = new Date(2026, 9, 22, 12);
const FRIDAY = new Date(2026, 9, 23, 12);
const MONDAY = new Date(2026, 9, 26, 12);
const daysBefore = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n, 12);

function note(overrides: Partial<FrictionNoteRow> = {}): FrictionNoteRow {
  return {
    id: 1, repo: "org/repo", category: "tests", text: "vitest is slow", reference: null,
    task_id: null, session_id: null, origin: null, created_at: "2026-10-20 10:00:00",
    triaged_at: null, retrospective_issue_id: null, ...overrides,
  };
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 7, job_name: "issue-worker", repo: "org/repo", item_number: 1, trigger_label: null,
    worktree_path: null, branch_name: null, run_id: null, status: "failed", error: null,
    outcome: JSON.stringify({ failureCategory: "timeout" }), model_used: null, provider_used: null,
    tokens_used: null, cost_usd: null, started_at: "2026-10-20 09:00:00", completed_at: null, ...overrides,
  };
}

const repo = { owner: "org", name: "repo", fullName: "org/repo" } as Repo;
const other = { owner: "org", name: "other", fullName: "org/other" } as Repo;
const CLAWS = "St-John-Software/claws";
const FLEET = "St-John-Software/fleet-infra";
const BLOG = "St-John-Software/bstjohn-blog";
const fleetRepos = [CLAWS, FLEET, BLOG].map((fullName) => ({ owner: "St-John-Software", name: fullName.split("/")[1], fullName }) as Repo);

describe("retrospectiveDue", () => {
  it("is not due on a Thursday even with a 15-day-old retrospective", () => {
    expect(retrospectiveDue({ now: THURSDAY, lastRetroAt: daysBefore(THURSDAY, 15), untriagedCount: 3 })).toBeNull();
  });

  it("is time-due on a Friday once 14 days have passed", () => {
    expect(retrospectiveDue({ now: FRIDAY, lastRetroAt: daysBefore(FRIDAY, 15), untriagedCount: 3 })).toBe("time");
    expect(retrospectiveDue({ now: FRIDAY, lastRetroAt: daysBefore(FRIDAY, 14), untriagedCount: 1 })).toBe("time");
  });

  it("is not time-due on a Friday under 14 days", () => {
    expect(retrospectiveDue({ now: FRIDAY, lastRetroAt: daysBefore(FRIDAY, 7), untriagedCount: 3 })).toBeNull();
  });

  it("is time-due on the first Friday for a repo that never had one", () => {
    expect(retrospectiveDue({ now: FRIDAY, lastRetroAt: null, untriagedCount: 1 })).toBe("time");
    expect(retrospectiveDue({ now: MONDAY, lastRetroAt: null, untriagedCount: 1 })).toBeNull();
  });

  it("is count-due at 50 notes on any weekday", () => {
    expect(retrospectiveDue({ now: MONDAY, lastRetroAt: daysBefore(MONDAY, 1), untriagedCount: 50 })).toBe("count");
    expect(retrospectiveDue({ now: MONDAY, lastRetroAt: daysBefore(MONDAY, 1), untriagedCount: 49 })).toBeNull();
  });

  it("is never due with zero notes", () => {
    expect(retrospectiveDue({ now: FRIDAY, lastRetroAt: null, untriagedCount: 0 })).toBeNull();
    expect(retrospectiveDue({ now: FRIDAY, lastRetroAt: daysBefore(FRIDAY, 30), untriagedCount: 0 })).toBeNull();
  });
});

describe("nextTimeBasedDue", () => {
  it("is the next Friday when there has been no retrospective", () => {
    expect(localDate(nextTimeBasedDue(null, MONDAY))).toBe("2026-10-30");
    expect(localDate(nextTimeBasedDue(null, FRIDAY))).toBe("2026-10-23");
  });

  it("is the first Friday at least 14 days after the last retrospective", () => {
    // Last on Friday 2026-10-23 → Friday 2026-11-06.
    expect(localDate(nextTimeBasedDue(FRIDAY, MONDAY))).toBe("2026-11-06");
    // Last on Monday 2026-10-26 → earliest 2026-11-09 → Friday 2026-11-13.
    expect(localDate(nextTimeBasedDue(MONDAY, MONDAY))).toBe("2026-11-13");
  });

  it("is today's or the next Friday once the fortnight has long passed", () => {
    expect(localDate(nextTimeBasedDue(daysBefore(MONDAY, 60), MONDAY))).toBe("2026-10-30");
  });
});

describe("buildRetrospectiveBody", () => {
  it("groups notes by category and reference and cites each note with its task outcome", () => {
    const notes = [
      note({ id: 1, category: "tests", text: "slow suite", reference: "npm test", task_id: 7, origin: "org/repo#clw_01ABC" }),
      note({ id: 2, category: "tests", text: "slow again", reference: "npm test", session_id: "sess1" }),
      note({ id: 3, category: "docs", text: "stale overview", task_id: 99 }),
    ];
    notes.push(note({ id: 4, repo: "org/other", category: "tests", text: "other doc" }));
    const body = buildRetrospectiveBody(notes, [task()], "time");
    expect(body).toContain("across 2 repos");
    expect(body).toContain("| Repo | Total | tests | docs |");
    expect(body).toContain("| `org/repo` | 3 | 2 | 1 |");
    expect(body).toContain("| `org/other` | 1 | 1 | 0 |");
    expect(body).toContain("| All repos | 4 | 3 | 1 |");
    expect(body).toContain("· `org/other` · note 4: other doc");
    expect(body.indexOf("## tests (3)")).toBeLessThan(body.indexOf("## docs (1)"));
    expect(body).toContain("### `npm test` (2)");
    expect(body).toContain("note 1: slow suite (task 7 (issue-worker) — failed, failure category timeout, working on org/repo#clw_01ABC)");
    expect(body).toContain("note 2: slow again (session sess1)");
    expect(body).toContain("note 3: stale overview (task 99 — task record no longer kept)");
    expect(body).toContain("## Task outcomes");
    expect(body).toContain("| issue-worker | 1 | failed 1 | timeout 1 |");
    expect(body).toContain("## How to triage");
    expect(body).not.toContain("requirements writer");
    expect(body).toContain("14 days have passed");
  });

  it("leads with the proposed follow-ups, each naming its theme, outcome, notes and repos", () => {
    const body = buildRetrospectiveBody([note({ id: 1 }), note({ id: 2 })], [], "time", {
      ok: true,
      proposals: [{ theme: "Slow tests", title: "Speed up vitest", outcome: "The suite runs in under a minute", noteIds: [1, 2], repos: ["org/repo"] }],
    });
    expect(body.indexOf("## Proposed follow-ups")).toBeLessThan(body.indexOf("## Summary"));
    expect(body).toContain("1. **Slow tests** — Speed up vitest");
    expect(body).toContain("   - Outcome: The suite runs in under a minute");
    expect(body).toContain("   - Notes: 1, 2");
    expect(body).toContain("   - Repos: `org/repo`");
  });

  it("falls back to triaging from the notes when the draft failed", () => {
    const body = buildRetrospectiveBody([note()], [], "time", { ok: false, reason: "AgentTimeoutError" });
    expect(body).toContain("Proposed follow-ups could not be drafted (AgentTimeoutError); triage from the notes below.");
  });

  it("names the count trigger", () => {
    expect(buildRetrospectiveBody([note()], [], "count")).toContain("50-note threshold");
  });

  it("titles the issue with the note count and date range", () => {
    expect(retrospectiveTitle([note({ created_at: "2026-10-01 00:00:00" }), note({ created_at: "2026-10-20 00:00:00" })]))
      .toBe("Fortnightly retrospective: 2 friction notes across 1 repo (2026-10-01 to 2026-10-20)");
  });
});

describe("retrospectiveRepos", () => {
  it("is claws plus the distinct note repos, sorted", () => {
    expect(retrospectiveRepos([note({ repo: FLEET }), note({ repo: BLOG }), note({ repo: FLEET })])).toEqual([BLOG, CLAWS, FLEET]);
    expect(retrospectiveRepos([])).toEqual([CLAWS]);
  });
});

describe("validateProposals", () => {
  const notes = [note({ id: 1, repo: FLEET }), note({ id: 2, repo: BLOG })];
  const raw = (overrides: Partial<{ theme: string; title: string; outcome: string; noteIds: number[]; repos: string[] }> = {}) => ({
    theme: "T", title: "Do it", outcome: "Done", noteIds: [1], repos: [FLEET], ...overrides,
  });

  it("drops note ids outside the batch and repos the retrospective does not name", () => {
    expect(validateProposals([raw({ noteIds: [1, 99], repos: [FLEET, "evil/repo", CLAWS] })], notes))
      .toEqual([{ theme: "T", title: "Do it", outcome: "Done", noteIds: [1], repos: [CLAWS, FLEET] }]);
  });

  it("drops a proposal left with no notes, and falls back to its notes' repos when none are valid", () => {
    expect(validateProposals([raw({ noteIds: [99] }), raw({ noteIds: [2], repos: ["evil/repo"] })], notes))
      .toEqual([expect.objectContaining({ noteIds: [2], repos: [BLOG] })]);
  });

  it("truncates theme and outcome and caps the list", () => {
    const [p] = validateProposals([raw({ theme: "x".repeat(200), outcome: "y".repeat(500) })], notes);
    expect(p!.theme.length).toBe(80);
    expect(p!.outcome.length).toBe(200);
    expect(validateProposals(Array.from({ length: 12 }, () => raw()), notes)).toHaveLength(MAX_PROPOSALS);
  });
});

describe("draftFollowUps", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs one isolated sonnet call, recorded as a task, and validates its reply", async () => {
    runClaude.mockResolvedValue(JSON.stringify({ proposals: [{ theme: "T", title: "Fix", outcome: "Fixed", noteIds: [1, 7], repos: ["org/repo"] }] }));
    const draft = await draftFollowUps([note({ id: 1 })]);
    expect(draft).toEqual({ ok: true, proposals: [{ theme: "T", title: "Fix", outcome: "Fixed", noteIds: [1], repos: ["org/repo"] }] });
    expect(runClaude).toHaveBeenCalledTimes(1);
    expect(runClaude.mock.calls[0]![2]).toMatchObject({ tier: "sonnet", isolatedCompletion: {} });
    expect(mockDb.withTaskRecording).toHaveBeenCalledWith("friction-retrospective", CLAWS, 0, null, expect.any(Function));
    expect(mockDb.recordTaskComplete).toHaveBeenCalledWith(42, { commits: 0 });
  });

  it("reports a failed call or an unparseable reply instead of throwing", async () => {
    runClaude.mockRejectedValueOnce(new Error("boom"));
    expect(await draftFollowUps([note()])).toEqual({ ok: false, reason: "boom" });
    runClaude.mockResolvedValueOnce("not json");
    expect(await draftFollowUps([note()])).toMatchObject({ ok: false });
  });
});

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runClaude.mockResolvedValue(JSON.stringify({ proposals: [] }));
    mockDb.getTasksByIds.mockResolvedValue([]);
    mockDb.lastFrictionRetrospectiveAt.mockResolvedValue(null);
    mockIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
    mockIssues.createIssue.mockResolvedValue("clw_new");
  });

  it("files a Blocked triage list with no requirements stage and marks its notes triaged when due", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 4 }), note({ id: 5, task_id: 7 })]);
    runClaude.mockResolvedValue(JSON.stringify({ proposals: [{ theme: "Slow", title: "Speed up", outcome: "Fast", noteIds: [4, 5], repos: ["org/repo"] }] }));
    await run([repo], FRIDAY);
    expect(mockDb.listUntriagedFrictionNotes).toHaveBeenCalledWith();
    expect(mockDb.getTasksByIds).toHaveBeenCalledWith([7]);
    expect(mockIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({
      repos: ["St-John-Software/claws", "org/repo"], primaryRepo: "St-John-Software/claws",
      source: "automation", autoPromote: false, requirementsStage: false, authorLogin: "claws",
      labels: ["Blocked"], blockedReason: RETRO_BLOCKED_REASON,
      dedupeKey: "friction-retro-n4-5",
      title: expect.stringMatching(/^Fortnightly retrospective: 2 friction notes/),
    }));
    expect(mockIssues.createIssue.mock.calls[0]![0].body).toContain("1. **Slow** — Speed up");
    expect(mockDb.markFrictionNotesTriaged).toHaveBeenCalledWith([4, 5], "clw_new");
  });

  it("still files the issue when the draft fails", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 4 })]);
    runClaude.mockRejectedValue(new Error("down"));
    await run([repo], FRIDAY);
    expect(mockIssues.createIssue.mock.calls[0]![0].body).toContain("Proposed follow-ups could not be drafted");
    expect(reportError).not.toHaveBeenCalled();
  });

  it("files one issue covering notes from several repos on a Friday", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 1 }), note({ id: 2, repo: "org/other" })]);
    await run([repo, other], FRIDAY);
    expect(mockIssues.createIssue).toHaveBeenCalledTimes(1);
    expect(mockIssues.createIssue.mock.calls[0]![0].title).toContain("across 2 repos");
    expect(mockDb.markFrictionNotesTriaged).toHaveBeenCalledWith([1, 2], "clw_new");
  });

  it("names claws and every contributing repo, pinning claws as primary", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([
      note({ id: 1, repo: CLAWS }), note({ id: 2, repo: FLEET }), note({ id: 3, repo: BLOG }), note({ id: 4, repo: FLEET }),
    ]);
    await run(fleetRepos, FRIDAY);
    expect(mockIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ repos: [BLOG, CLAWS, FLEET], primaryRepo: CLAWS }));
  });

  it("names only claws when every note came from claws", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 1, repo: CLAWS }), note({ id: 2, repo: CLAWS })]);
    await run(fleetRepos, FRIDAY);
    expect(mockIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ repos: [CLAWS], primaryRepo: CLAWS }));
  });

  it("names claws even when no note came from claws", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 1, repo: BLOG })]);
    await run(fleetRepos, FRIDAY);
    expect(mockIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ repos: [BLOG, CLAWS], primaryRepo: CLAWS }));
  });

  it("does not name a repo that is disabled for the job or recorded no notes", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 1, repo: CLAWS }), note({ id: 2, repo: BLOG })]);
    // fleet-infra is enabled but has no notes; bstjohn-blog has a note but is disabled.
    await run(fleetRepos.filter((r) => r.fullName !== BLOG), FRIDAY);
    expect(mockIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ repos: [CLAWS] }));
  });

  it("files on the count trigger when 50 notes are split across repos", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue(Array.from({ length: 50 }, (_, i) => note({ id: i + 1, repo: i % 2 ? "org/other" : "org/repo" })));
    mockDb.lastFrictionRetrospectiveAt.mockResolvedValue("2026-10-25 08:00:00");
    await run([repo, other], MONDAY);
    expect(mockIssues.createIssue).toHaveBeenCalledTimes(1);
    expect(mockIssues.createIssue.mock.calls[0]![0].body).toContain("50-note threshold");
  });

  it("leaves notes for a repo that is not enabled out of the count, body and triage", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 1 }), note({ id: 2, repo: "org/off" })]);
    await run([repo], FRIDAY);
    expect(mockIssues.createIssue.mock.calls[0]![0].body).not.toContain("org/off");
    expect(mockDb.markFrictionNotesTriaged).toHaveBeenCalledWith([1], "clw_new");
  });

  it("files nothing with zero notes", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([]);
    await run([repo], FRIDAY);
    expect(mockIssues.createIssue).not.toHaveBeenCalled();
    expect(mockDb.markFrictionNotesTriaged).not.toHaveBeenCalled();
  });

  it("files nothing when neither trigger is due", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note()]);
    await run([repo], MONDAY);
    expect(mockIssues.createIssue).not.toHaveBeenCalled();
  });

  it("reuses an open issue with the same dedupe key instead of filing again", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 4 })]);
    mockIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_kept" });
    await run([repo], FRIDAY);
    expect(mockIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith("St-John-Software/claws", "friction-retro-n4-4");
    expect(mockIssues.createIssue).not.toHaveBeenCalled();
    expect(runClaude).not.toHaveBeenCalled();
    expect(mockDb.markFrictionNotesTriaged).toHaveBeenCalledWith([4], "clw_kept");
  });

  it("looks a multi-repo retrospective up under claws on a retry", async () => {
    mockDb.listUntriagedFrictionNotes.mockResolvedValue([note({ id: 4, repo: BLOG }), note({ id: 6, repo: FLEET })]);
    mockIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_kept", repos: [BLOG, CLAWS, FLEET], primary_repo: CLAWS });
    await run(fleetRepos, FRIDAY);
    expect(mockIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(CLAWS, "friction-retro-n4-6");
    expect(mockIssues.createIssue).not.toHaveBeenCalled();
    expect(mockDb.markFrictionNotesTriaged).toHaveBeenCalledWith([4, 6], "clw_kept");
  });

  it("reports a failure once", async () => {
    mockDb.listUntriagedFrictionNotes.mockRejectedValue(new Error("boom"));
    await run([repo], FRIDAY);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith("friction-retrospective", expect.any(String), expect.any(Error));
  });
});

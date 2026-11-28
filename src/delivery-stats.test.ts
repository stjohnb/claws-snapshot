import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DeliveryStatsRows } from "./db.js";

const loadRows = vi.fn();
vi.mock("./db.js", () => ({ loadDeliveryStatsRows: (...args: unknown[]) => loadRows(...args) }));
vi.mock("./github.js", () => ({
  listRepos: vi.fn(async () => [{ owner: "org", name: "a", fullName: "org/a" }, { owner: "org", name: "b", fullName: "org/b" }]),
}));

import { buildDeliveryStats, loadDeliveryStats, parseUtc, periodStart, phaseOfJob, resolveSince } from "./delivery-stats.js";

const ISSUE = "clw_01M8AAAAAAAAAAAAAAAAAAAAAA";
const MULTI = "clw_01M8BBBBBBBBBBBBBBBBBBBBBB";

function emptyRows(): DeliveryStatsRows {
  return { issues: [], prs: [], tasks: [], reviewRounds: [], candidates: [], links: [] };
}

const NOW = Date.parse("2026-11-25T12:00:00Z");
const SINCE = Date.parse("2026-11-09T00:00:00Z"); // a Monday

function seeded(): DeliveryStatsRows {
  const rows = emptyRows();
  rows.issues.push(
    { id: ISSUE, title: "Fix the thing", repo: "org/a", closed_at: "2026-11-12 10:00:00" },
    { id: MULTI, title: "Span repos", repo: "org/a", closed_at: "2026-11-19T08:00:00Z" },
  );
  rows.prs.push(
    { repo: "org/a", pr_number: 10, issue_id: ISSUE, stage: "merged", merged_at: "2026-11-12 09:00:00", problematic_at: "2026-11-11 00:00:00" },
    { repo: "org/a", pr_number: 11, issue_id: ISSUE, stage: "closed", merged_at: null, problematic_at: null },
    { repo: "org/a", pr_number: 12, issue_id: null, stage: "merged", merged_at: "2026-11-13 00:00:00", problematic_at: null },
    { repo: "org/a", pr_number: 20, issue_id: MULTI, stage: "merged", merged_at: "2026-11-18 00:00:00", problematic_at: null },
    { repo: "org/b", pr_number: 21, issue_id: MULTI, stage: "merged", merged_at: "2026-11-19 00:00:00", problematic_at: null },
  );
  rows.tasks.push(
    { job_name: "issue-refiner", repo: "org/a", item_number: ISSUE, tokens_used: 100, cost_usd: 0.1, started_at: "2026-11-10 00:00:00" },
    { job_name: "issue-worker", repo: "org/a", item_number: ISSUE, tokens_used: 1000, cost_usd: 1, started_at: "2026-11-11 00:00:00" },
    { job_name: "ci-fixer", repo: "org/a", item_number: "10", tokens_used: 200, cost_usd: null, started_at: "2026-11-11 01:00:00" },
    { job_name: "ci-fixer:merge-conflict", repo: "org/a", item_number: "11", tokens_used: null, cost_usd: null, started_at: "2026-11-11 02:00:00" },
    { job_name: "ci-fixer:problematic", repo: "org/a", item_number: "10", tokens_used: 50, cost_usd: null, started_at: "2026-11-11 03:00:00" },
    { job_name: "pr-reviewer", repo: "org/a", item_number: "12", tokens_used: 70, cost_usd: null, started_at: "2026-11-12 03:00:00" },
    { job_name: "ci-fixer", repo: "org/a", item_number: "12", tokens_used: 5, cost_usd: null, started_at: "2026-11-12 04:00:00" },
    { job_name: "issue-worker", repo: "org/a", item_number: MULTI, tokens_used: 300, cost_usd: null, started_at: "2026-11-17 00:00:00" },
    { job_name: "review-addresser", repo: "org/b", item_number: "21", tokens_used: 40, cost_usd: null, started_at: "2026-11-18 00:00:00" },
  );
  rows.reviewRounds.push({ repo: "org/a", pr_number: 10, rounds: 3 }, { repo: "org/a", pr_number: 12, rounds: 1 }, { repo: "org/b", pr_number: 21, rounds: 2 });
  rows.candidates.push(
    { id: "clw_01M8LINKED00000000000000000", title: "x", body: "", created_at: "2026-11-13 00:00:00" },
    { id: "clw_01M8BYID000000000000000000", title: `Follow up ${ISSUE.toLowerCase()}`, body: "", created_at: "2026-11-14 00:00:00" },
    { id: "clw_01M8BYPR000000000000000000", title: "Regression", body: "Broke after org/a#10 landed", created_at: "2026-11-15 00:00:00" },
    { id: "clw_01M8NOTPR00000000000000000", title: "Regression", body: "Broke after org/a#100 landed", created_at: "2026-11-15 00:00:00" },
    { id: "clw_01M8TOOLATE0000000000000000", title: ISSUE, body: "", created_at: "2026-11-27 00:00:00" },
    { id: "clw_01M8BEFORE00000000000000000", title: ISSUE, body: "", created_at: "2026-11-12 09:00:00" },
  );
  rows.links.push({ source_id: ISSUE, target_id: "clw_01M8LINKED00000000000000000" });
  return rows;
}

describe("phaseOfJob", () => {
  it("maps job names to phases", () => {
    expect(phaseOfJob("requirements-writer")).toBe("requirements");
    expect(phaseOfJob("issue-refiner")).toBe("plan");
    expect(phaseOfJob("issue-worker")).toBe("implement");
    expect(phaseOfJob("ci-fixer")).toBe("ci_fix");
    expect(phaseOfJob("ci-fixer:merge-conflict")).toBe("ci_fix");
    expect(phaseOfJob("ci-fixer:problematic")).toBe("other");
    expect(phaseOfJob("pr-reviewer")).toBe("review");
    expect(phaseOfJob("escalation-reviewer")).toBe("review");
    expect(phaseOfJob("review-addresser")).toBe("review_address");
    expect(phaseOfJob("doc-maintainer")).toBe("other");
  });
});

describe("timestamps and periods", () => {
  it("parses SQLite and ISO timestamps as UTC", () => {
    expect(parseUtc("2026-11-12 10:00:00")).toBe(Date.parse("2026-11-12T10:00:00Z"));
    expect(parseUtc("2026-11-12T10:00:00Z")).toBe(Date.parse("2026-11-12T10:00:00Z"));
    expect(parseUtc("2026-11-12T10:00:00")).toBe(Date.parse("2026-11-12T10:00:00Z"));
    expect(parseUtc(null)).toBeNaN();
  });

  it("starts weeks on Monday 00:00 UTC, months on the 1st", () => {
    const sunday = Date.parse("2026-11-15T23:00:00Z");
    expect(new Date(periodStart(sunday, "week")).toISOString()).toBe("2026-11-09T00:00:00.000Z");
    expect(new Date(periodStart(sunday, "day")).toISOString()).toBe("2026-11-15T00:00:00.000Z");
    expect(new Date(periodStart(sunday, "month")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  it("defaults since to 90 days back and clamps it to 365", () => {
    expect(resolveSince(undefined, NOW)).toBe(NOW - 90 * 86_400_000);
    expect(resolveSince(0, NOW)).toBe(NOW - 365 * 86_400_000);
  });
});

describe("buildDeliveryStats", () => {
  it("buckets issues by close and PRs by merge, splitting tokens by phase", () => {
    const stats = buildDeliveryStats(seeded(), { since: SINCE, until: NOW, period: "week", detail: true });
    expect(stats.window).toEqual({ since: "2026-11-09T00:00:00.000Z", until: "2026-11-25T12:00:00.000Z", period: "week", task_retention_days: 90 });
    expect(stats.repos.map((r) => r.repo)).toEqual(["org/a", "org/b"]);
    const [w1, w2, w3] = stats.repos[0]!.periods;
    expect(stats.repos[0]!.periods.map((p) => p.start)).toEqual(["2026-11-09", "2026-11-16", "2026-11-23"]);

    expect(w1).toMatchObject({
      tokens_partial: false,
      issues_implemented: 1,
      prs_merged: 2,
      tokens: {
        total: 1350, cost_usd: 1.1, per_issue_mean: 1350, per_issue_median: 1350,
        by_phase: { requirements: null, plan: 100, implement: 1000, ci_fix: 200, review: null, review_address: null, other: 50 },
      },
      tasks: 5,
      tasks_without_tokens: 1,
      // PR 10's ci-fixer plus PR 12's (with no issue); not ci-fixer:problematic.
      ci_fix_runs: 2,
      ci_fix_runs_per_pr: 1,
      review_rounds: 4,
      review_rounds_per_pr: 2,
      prs_problematic: 1,
      follow_up_issues: 3,
    });
    expect(w1!.issues).toEqual([{
      issue_id: ISSUE,
      title: "Fix the thing",
      closed_at: "2026-11-12T10:00:00.000Z",
      prs: ["org/a#10", "org/a#11"],
      tokens_by_phase: { requirements: null, plan: 100, implement: 1000, ci_fix: 200, review: null, review_address: null, other: 50 },
      ci_fix_runs: 2,
      review_rounds: 3,
      problematic: true,
      follow_up_issue_ids: ["clw_01M8BYID000000000000000000", "clw_01M8BYPR000000000000000000", "clw_01M8LINKED00000000000000000"],
    }]);

    // The multi-repo issue counts under its primary repo with every repo's PR tasks.
    expect(w2).toMatchObject({ issues_implemented: 1, prs_merged: 1, tokens: { total: 340, cost_usd: null, by_phase: { implement: 300, review_address: 40 } } });
    expect(w3).toMatchObject({ issues_implemented: 0, prs_merged: 0, tokens: { total: null, per_issue_mean: null, by_phase: { implement: null } }, ci_fix_runs_per_pr: null, issues: [] });
    expect(stats.repos[1]!.periods[1]).toMatchObject({ issues_implemented: 0, prs_merged: 1, review_rounds: 2 });
  });

  it("marks periods before the task horizon tokens_partial", () => {
    const since = NOW - 120 * 86_400_000;
    const stats = buildDeliveryStats(emptyRows(), { since, until: NOW, period: "month", repo: "org/a" });
    expect(stats.repos).toHaveLength(1);
    const partial = stats.repos[0]!.periods.map((p) => [p.start, p.tokens_partial]);
    expect(partial[0]).toEqual(["2026-07-01", true]);
    expect(partial.at(-1)).toEqual(["2026-11-01", false]);
  });

  it("keeps a repo filter to that repo's merged PRs", () => {
    const stats = buildDeliveryStats(seeded(), { since: SINCE, until: NOW, period: "week", repo: "org/a" });
    expect(stats.repos.map((r) => r.repo)).toEqual(["org/a"]);
  });
});

describe("loadDeliveryStats", () => {
  beforeEach(() => loadRows.mockReset());

  it("answers null for an unmanaged repo and canonicalises a managed one", async () => {
    expect(await loadDeliveryStats({ repo: "org/nope" })).toBeNull();
    expect(loadRows).not.toHaveBeenCalled();
    loadRows.mockResolvedValueOnce(emptyRows());
    const stats = await loadDeliveryStats({ repo: "ORG/A", since: SINCE, now: NOW });
    expect(loadRows).toHaveBeenCalledWith("2026-11-09 00:00:00", "org/a");
    expect(stats!.repos.map((r) => r.repo)).toEqual(["org/a"]);
  });

  it("never returns task error or outcome text", async () => {
    const rows = seeded();
    (rows.tasks[0] as unknown as Record<string, unknown>).error = "Bearer secret-token";
    (rows.tasks[0] as unknown as Record<string, unknown>).outcome = "{\"secret\":\"pw\"}";
    loadRows.mockResolvedValueOnce(rows);
    const stats = await loadDeliveryStats({ since: SINCE, now: NOW, detail: true });
    const text = JSON.stringify(stats);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("pw");
  });
});

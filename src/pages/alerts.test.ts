import { describe, it, expect } from "vitest";
import { buildAlertsPage, orderAlerts, type AlertRow } from "./alerts.js";

function row(overrides: Partial<AlertRow> = {}): AlertRow {
  return {
    id: "clw_01M5YPSK289NXAK8E6K6RNTFS5",
    title: "[claws-error] issue-worker:run",
    repo: "org/repo",
    repos: ["org/repo"],
    createdAt: "2026-10-27T10:00:00.000Z",
    updatedAt: "2026-10-27T11:00:00.000Z",
    occurrences: 3,
    column: "in-progress",
    needsOperator: false,
    blockedReason: null,
    ...overrides,
  };
}

describe("buildAlertsPage", () => {
  it("renders at the wide tier with the Alerts nav link current", () => {
    const html = buildAlertsPage([row()], "dark");
    expect(html).toContain('data-width="wide"');
    expect(html).toMatch(/<a[^>]*href="\/alerts"[^>]*aria-current="page"/);
    expect(html).toContain("<title>claws — Alerts</title>");
  });

  it("shows the empty state when no alert is open", () => {
    const html = buildAlertsPage([], "dark");
    expect(html).toContain("No open alerts");
    expect(html).not.toContain("data-label=\"Alert\"");
  });

  it("renders labelled cards that stay cards through the tablet band", () => {
    const html = buildAlertsPage([row()], "dark");
    expect(html).toContain('<table class="data-cards data-cards-wide">');
    for (const label of ["Alert", "Repo", "Opened", "Occurrences", "Last seen", "Status"]) {
      expect(html).toContain(`data-label="${label}"`);
    }
    expect(html).toContain('href="/issues/clw_01M5YPSK289NXAK8E6K6RNTFS5"');
    expect(html).toContain(">3</td>");
  });

  it("marks an automatically handled alert and one that needs the operator, with the Blocked reason", () => {
    const html = buildAlertsPage([
      row({ id: "clw_01M5YPSK289NXAK8E6K6RNTFS1" }),
      row({ id: "clw_01M5YPSK289NXAK8E6K6RNTFS2", column: "blocked", needsOperator: true, blockedReason: "\nThe fix failed CI.\nMore." }),
    ], "dark");
    expect(html).toContain('<span class="alert-status">Automatic · In progress</span>');
    expect(html).toContain('<span class="alert-status needs-you">Needs you · Blocked</span>');
    expect(html).toContain('<div class="alert-reason">The fix failed CI.</div>');
    expect(html).not.toContain("More.");
  });

  it("escapes titles", () => {
    const html = buildAlertsPage([row({ title: "<script>x</script>" })], "dark");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });
});

describe("orderAlerts", () => {
  it("puts alerts needing the operator first, then the newest", () => {
    const ordered = orderAlerts([
      row({ id: "a", createdAt: "2026-10-27T09:00:00.000Z" }),
      row({ id: "b", createdAt: "2026-10-27T12:00:00.000Z" }),
      row({ id: "c", createdAt: "2026-10-01T00:00:00.000Z", needsOperator: true }),
    ]);
    expect(ordered.map((r) => r.id)).toEqual(["c", "b", "a"]);
  });
});

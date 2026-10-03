import { describe, it, expect, afterEach } from "vitest";
import { buildIssueLogsPage, buildLogDetailPage } from "./logs.js";
import { setImportedRef, resetImportedRefsForTest } from "../imported-refs-index.js";
import { DASHBOARD_URL } from "../config.js";

describe("logs pages width tier (both /logs detail pages are wide)", () => {
  it("buildIssueLogsPage renders the wide width tier", () => {
    const html = buildIssueLogsPage("org/repo", 1, [], new Map(), new Map(), "light");
    expect(html).toContain('data-width="wide"');
  });

  it("buildLogDetailPage renders the wide width tier", () => {
    const run = { run_id: "r1", job_name: "issue-dispatcher", status: "completed", started_at: "2026-01-01T00:00:00", completed_at: "2026-01-01T00:01:00" };
    const html = buildLogDetailPage(run, [], "light");
    expect(html).toContain('data-width="wide"');
  });
});

describe("buildIssueLogsPage repo escaping", () => {
  it("escapes & in the repo param so HTML attribute parsing is safe", () => {
    const withAmpersand = `org/repo&injected=x`;
    const html = buildIssueLogsPage(withAmpersand, 1, [], new Map(), new Map(), "light");
    // encodeURI does NOT encode &, but escapeHtml must convert it to &amp;
    expect(html).toContain("&amp;injected");
    expect(html).not.toContain("&injected=");
  });
});

describe("buildIssueLogsPage header link (clw_01M35GAV079FW4VJ1GN5J19ABM)", () => {
  afterEach(() => {
    resetImportedRefsForTest();
  });

  it("links an un-imported forge number to the forge, labelled View on GitHub", () => {
    const html = buildIssueLogsPage("org/repo", 7, [], new Map(), new Map(), "light");
    expect(html).toContain('href="https://github.com/org/repo/issues/7">View on GitHub');
  });

  it("links a seeded imported forge number to the Claws issue page, labelled View issue", () => {
    const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    setImportedRef("org/repo", 7, NATIVE_ID);

    const html = buildIssueLogsPage("org/repo", 7, [], new Map(), new Map(), "light");
    const dashboardIssueUrl = `${DASHBOARD_URL?.replace(/\/+$/, "") ?? ""}/issues/${NATIVE_ID}`;
    expect(html).toContain(`href="${dashboardIssueUrl}">View issue`);
  });

  it("shows a native item's short id in the heading and page title, not the full id", () => {
    const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
    const html = buildIssueLogsPage("org/repo", NATIVE_ID, [], new Map(), new Map(), "light");
    expect(html).toContain(`<span title="${NATIVE_ID}">#clw_GZ5PDC</span></h2>`);
    expect(html).toContain("repo#clw_GZ5PDC logs</title>");
    expect(html).not.toContain(`#${NATIVE_ID}<`);
  });
});

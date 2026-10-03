import { describe, it, expect } from "vitest";
import { buildBacklogPage, type BacklogPageView, type BacklogRow } from "./backlog.js";

function makeRow(overrides: Partial<BacklogRow> = {}): BacklogRow {
  return {
    repo: "org/repo",
    ref: 42,
    title: "Some day",
    labels: ["Backlog"],
    url: "https://github.com/org/repo/issues/42",
    updatedAt: "2026-09-20T10:00:00Z",
    ...overrides,
  };
}

function makeView(rows: BacklogRow[], overrides: Partial<BacklogPageView> = {}): BacklogPageView {
  return { rows, repoOptions: ["org/a", "org/repo"], repoFilter: "", labelFilter: "", incompleteSources: 0, ...overrides };
}

describe("buildBacklogPage", () => {
  it("groups rows by repository, newest first within a group", () => {
    const html = buildBacklogPage(makeView([
      makeRow({ ref: 1, title: "Older", updatedAt: "2026-09-01T00:00:00Z" }),
      makeRow({ ref: 2, title: "Newer", updatedAt: "2026-09-10T00:00:00Z" }),
      makeRow({ repo: "org/a", ref: 3, title: "Other repo" }),
    ]), "dark");

    expect(html.indexOf(`class="backlog-repo" title="org/a">a`)).toBeLessThan(html.indexOf(`class="backlog-repo" title="org/repo">repo`));
    expect(html.indexOf("Newer")).toBeLessThan(html.indexOf("Older"));
  });

  it("shows the repository filter select's option text short while its value stays full", () => {
    const html = buildBacklogPage(makeView([makeRow()]), "dark");
    expect(html).toContain(`<option value="org/a">a</option>`);
    expect(html).toContain(`<option value="org/repo">repo</option>`);
  });

  it("posts a per-row Promote and a bulk Promote selected through one form", () => {
    const html = buildBacklogPage(makeView([makeRow()], { repoFilter: "org/repo" }), "dark");

    expect(html).toContain(`<form method="POST" action="/backlog/promote">`);
    expect(html).toContain(`name="only" value="org/repo#42">Promote</button>`);
    expect(html).toContain(`name="item" value="org/repo#42"`);
    expect(html).toContain(`id="backlog-promote-selected">Promote selected</button>`);
    // The filter rides along so the redirect lands back on the same list.
    expect(html).toContain(`<input type="hidden" name="repo" value="org/repo">`);
  });

  it("filters by repo and label, and does not chip the Backlog label", () => {
    const rows = [
      makeRow({ ref: 1, title: "Bug later", labels: ["Backlog", "bug"] }),
      makeRow({ repo: "org/a", ref: 2, title: "Other repo" }),
    ];
    const byRepo = buildBacklogPage(makeView(rows, { repoFilter: "org/a" }), "dark");
    expect(byRepo).toContain("Other repo");
    expect(byRepo).not.toContain("Bug later");

    const byLabel = buildBacklogPage(makeView(rows, { labelFilter: "bug" }), "dark");
    expect(byLabel).toContain("Bug later");
    expect(byLabel).not.toContain("Other repo");
    expect(byLabel).not.toMatch(/label-chip[^>]*>Backlog</);
  });

  it("says so when the backlog is empty", () => {
    const html = buildBacklogPage(makeView([]), "dark");
    expect(html).toContain("No backlog issues");
    expect(html).not.toContain(`action="/backlog/promote"`);
  });

  it("escapes a hostile title", () => {
    const html = buildBacklogPage(makeView([makeRow({ title: "<script>x</script>" })]), "dark");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

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
  it("gives a native row a Returns cell bound to its own form outside the promote form, and a forge row none", () => {
    const html = buildBacklogPage(makeView([
      makeRow({ ref: "clw_01M50PNMSF527SGNX165K1Q5WH", title: "Parked", until: "2026-10-23", url: "/issues/clw_01M50PNMSF527SGNX165K1Q5WH" }),
      makeRow({ ref: "clw_01M50PNMSF527SGNX165K1Q5WJ", title: "Undated", url: "/issues/clw_01M50PNMSF527SGNX165K1Q5WJ" }),
      makeRow({ ref: 42, title: "Forge" }),
    ], { repoFilter: "org/repo" }), "dark");
    expect(html).toContain(`<th>Returns</th>`);
    expect(html).toContain(`class="data-cards data-cards-wide"`);
    expect(html).toContain(`data-width="wide"`);
    expect(html).toContain(`name="until" form="backlog-until-clw_01M50PNMSF527SGNX165K1Q5WH" value="2026-10-23"`);
    expect(html).toContain(`form="backlog-until-clear-clw_01M50PNMSF527SGNX165K1Q5WH"`);
    expect(html).not.toContain(`backlog-until-clear-clw_01M50PNMSF527SGNX165K1Q5WJ`);
    const promoteEnd = html.indexOf("</form>", html.indexOf(`action="/backlog/promote"`));
    const ownForm = html.indexOf(`<form id="backlog-until-clw_01M50PNMSF527SGNX165K1Q5WH" method="POST" action="/issues/clw_01M50PNMSF527SGNX165K1Q5WH/backlog-until">`);
    expect(ownForm).toBeGreaterThan(promoteEnd);
    expect(html).toContain(`name="return_to" value="/backlog?repo=org%2Frepo"`);
    expect(html).not.toContain(`backlog-until-42`);
  });

  it("lists a multi-repo row under a non-primary filter, with the other repo's chip", () => {
    const html = buildBacklogPage(makeView([makeRow({ repo: "org/a", repos: ["org/a", "org/b"], title: "Multi" })], { repoFilter: "org/b" }), "dark");
    expect(html).toContain("Multi");
    expect(html).toContain(`<span class="backlog-also" title="Also names org/b">b</span>`);
  });

  it("groups rows by repository, newest first within a group", () => {
    const html = buildBacklogPage(makeView([
      makeRow({ ref: 1, title: "Older", updatedAt: "2026-09-01T00:00:00Z" }),
      makeRow({ ref: 2, title: "Newer", updatedAt: "2026-09-10T00:00:00Z" }),
      makeRow({ repo: "org/a", ref: 3, title: "Other repo" }),
    ]), "dark");

    expect(html.indexOf(`class="backlog-repo" title="org/a"><span class="repo-avatar" aria-hidden="true">a</span>a`)).toBeLessThan(html.indexOf(`class="backlog-repo" title="org/repo"><span class="repo-avatar" aria-hidden="true">r</span>repo`));
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

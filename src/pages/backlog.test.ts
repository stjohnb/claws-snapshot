import { describe, it, expect } from "vitest";
import { buildBacklogPage, backlogHref, parseBacklogQuery, type BacklogPageView, type BacklogQuery, type BacklogRow } from "./backlog.js";

function makeRow(overrides: Partial<BacklogRow> = {}): BacklogRow {
  return {
    repo: "org/repo",
    ref: 42,
    title: "Some day",
    labels: ["Backlog"],
    url: "https://github.com/org/repo/issues/42",
    updatedAt: "2026-09-20T10:00:00Z",
    createdAt: "2026-09-01T10:00:00Z",
    author: "alice",
    ...overrides,
  };
}

function makeQuery(overrides: Partial<BacklogQuery> = {}): BacklogQuery {
  return { repo: "", label: "", author: "", q: "", sort: "updated", dir: "desc", ...overrides };
}

function makeView(rows: BacklogRow[], query: Partial<BacklogQuery> = {}): BacklogPageView {
  return { rows, repoOptions: ["org/a", "org/repo"], query: makeQuery(query), incompleteSources: 0 };
}

/** The order the titles appear in the rendered page. */
function order(html: string, titles: string[]): string[] {
  return titles.filter((t) => html.includes(`>${t}</a>`)).sort((a, b) => html.indexOf(`>${a}</a>`) - html.indexOf(`>${b}</a>`));
}

describe("buildBacklogPage", () => {
  it("gives a native row a Returns cell bound to its own form outside the promote form, and a forge row none", () => {
    const html = buildBacklogPage(makeView([
      makeRow({ ref: "clw_01M50PNMSF527SGNX165K1Q5WH", title: "Parked", until: "2026-10-23", url: "/issues/clw_01M50PNMSF527SGNX165K1Q5WH" }),
      makeRow({ ref: "clw_01M50PNMSF527SGNX165K1Q5WJ", title: "Undated", url: "/issues/clw_01M50PNMSF527SGNX165K1Q5WJ" }),
      makeRow({ ref: 42, title: "Forge" }),
    ], { repo: "org/repo" }), "dark");
    expect(html).toContain(`Returns</a></th>`);
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
    const html = buildBacklogPage(makeView([makeRow({ repo: "org/a", repos: ["org/a", "org/b"], title: "Multi" })], { repo: "org/b" }), "dark");
    expect(html).toContain("Multi");
    expect(html).toContain(`<span class="backlog-also" title="Also names org/b">b</span>`);
  });

  it("lists one flat table, newest updated first, interleaving repositories", () => {
    const html = buildBacklogPage(makeView([
      makeRow({ ref: 1, title: "Oldest", updatedAt: "2026-09-01T00:00:00Z" }),
      makeRow({ repo: "org/a", ref: 2, title: "Middle", updatedAt: "2026-09-05T00:00:00Z" }),
      makeRow({ ref: 3, title: "Newest", updatedAt: "2026-09-10T00:00:00Z" }),
    ]), "dark");
    expect(html.match(/<table class="data-cards data-cards-wide">/g)).toHaveLength(1);
    expect(html).not.toContain("backlog-repo");
    expect(order(html, ["Oldest", "Middle", "Newest"])).toEqual(["Newest", "Middle", "Oldest"]);
  });

  it("sorts by every field in both directions, missing values last", () => {
    const rows = [
      makeRow({ ref: 1, repo: "org/b", title: "bravo", author: "Zed", createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-03-01T00:00:00Z" }),
      makeRow({ ref: 2, repo: "org/a", title: "Alpha", author: "amy", createdAt: "2026-01-03T00:00:00Z", updatedAt: "2026-03-03T00:00:00Z" }),
      makeRow({ ref: 3, repo: "org/c", title: "charlie", author: "Bob", createdAt: "", updatedAt: "2026-03-02T00:00:00Z" }),
    ];
    const titles = ["bravo", "Alpha", "charlie"];
    const sorted = (sort: BacklogQuery["sort"], dir: BacklogQuery["dir"]) => order(buildBacklogPage(makeView(rows, { sort, dir }), "dark"), titles);
    expect(sorted("created", "asc")).toEqual(["bravo", "Alpha", "charlie"]);
    expect(sorted("created", "desc")).toEqual(["Alpha", "bravo", "charlie"]);
    expect(sorted("updated", "asc")).toEqual(["bravo", "charlie", "Alpha"]);
    expect(sorted("updated", "desc")).toEqual(["Alpha", "charlie", "bravo"]);
    expect(sorted("repo", "asc")).toEqual(["Alpha", "bravo", "charlie"]);
    expect(sorted("repo", "desc")).toEqual(["charlie", "bravo", "Alpha"]);
    expect(sorted("title", "asc")).toEqual(["Alpha", "bravo", "charlie"]);
    expect(sorted("title", "desc")).toEqual(["charlie", "bravo", "Alpha"]);
    expect(sorted("author", "asc")).toEqual(["Alpha", "charlie", "bravo"]);
  });

  it("combines filters, and says so when nothing matches while keeping the form", () => {
    const rows = [
      makeRow({ ref: 1, title: "Fix login", labels: ["Backlog", "bug"], author: "alice" }),
      makeRow({ ref: 2, title: "Fix logout", labels: ["Backlog", "bug"], author: "bob" }),
      makeRow({ ref: 3, title: "Other", labels: ["Backlog"], author: "alice" }),
    ];
    const html = buildBacklogPage(makeView(rows, { repo: "org/repo", label: "bug", author: "alice", q: "FIX" }), "dark");
    expect(html).toContain(">Fix login</a>");
    expect(html).not.toContain(">Fix logout</a>");
    expect(html).not.toContain(">Other</a>");

    const none = buildBacklogPage(makeView(rows, { author: "alice", q: "logout" }), "dark");
    expect(none).toContain("No backlog issues match these filters");
    expect(none).toContain(`<form class="list-filters"`);
  });

  it("carries every non-default parameter in return_to, encoded", () => {
    const query = makeQuery({ repo: "org/a", label: "bug", author: "al", q: "a&b #1", sort: "created", dir: "asc" });
    const href = backlogHref(query);
    expect(parseBacklogQuery((k) => new URL(href, "http://x").searchParams.get(k) ?? undefined)).toEqual(query);
    const html = buildBacklogPage(makeView([makeRow({ repo: "org/a", title: "a&b #1", author: "al", labels: ["Backlog", "bug"] })], query), "dark");
    expect(html).toContain(`name="return_to" value="${href.replace(/&/g, "&amp;")}"`);
  });

  it("links sortable headers, flipping the active direction", () => {
    const html = buildBacklogPage(makeView([makeRow()], { sort: "created", dir: "asc" }), "dark");
    expect(html).toContain(`<a href="/backlog?sort=created">Created ▲</a>`);
    expect(html).toContain(`<a href="/backlog?dir=asc">Updated</a>`);
    expect(html).toContain("<td data-label=\"Created\" title=\"2026-09-01T10:00:00Z\">");
  });

  it("falls back to the defaults for unknown sort values", () => {
    expect(parseBacklogQuery((k) => ({ sort: "nope", dir: "sideways" } as Record<string, string>)[k])).toEqual(makeQuery());
  });

  it("shows the repository filter select's option text short while its value stays full", () => {
    const html = buildBacklogPage(makeView([makeRow()]), "dark");
    expect(html).toContain(`<option value="org/a">a</option>`);
    expect(html).toContain(`<option value="org/repo">repo</option>`);
  });

  it("posts a per-row Promote and a bulk Promote selected through one form", () => {
    const html = buildBacklogPage(makeView([makeRow()], { repo: "org/repo" }), "dark");

    expect(html).toContain(`<form method="POST" action="/backlog/promote">`);
    expect(html).toContain(`name="only" value="org/repo#42">Promote</button>`);
    expect(html).toContain(`name="item" value="org/repo#42"`);
    expect(html).toContain(`id="backlog-promote-selected">Promote selected</button>`);
    // The whole view rides along so the redirect lands back on the same list.
    expect(html).toContain(`<input type="hidden" name="return_to" value="/backlog?repo=org%2Frepo">`);
  });

  it("filters by repo and label, and does not chip the Backlog label", () => {
    const rows = [
      makeRow({ ref: 1, title: "Bug later", labels: ["Backlog", "bug"] }),
      makeRow({ repo: "org/a", ref: 2, title: "Other repo" }),
    ];
    const byRepo = buildBacklogPage(makeView(rows, { repo: "org/a" }), "dark");
    expect(byRepo).toContain("Other repo");
    expect(byRepo).not.toContain("Bug later");

    const byLabel = buildBacklogPage(makeView(rows, { label: "bug" }), "dark");
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

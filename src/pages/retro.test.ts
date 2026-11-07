import { describe, it, expect } from "vitest";
import { buildRetroPage, type RetroPageView, type RetroRepoView } from "./retro.js";
import type { FrictionNoteRow } from "../db.js";

function note(overrides: Partial<FrictionNoteRow> = {}): FrictionNoteRow {
  return {
    id: 1, repo: "org/repo", category: "tests", text: "vitest is slow", reference: "npm test",
    task_id: null, session_id: null, origin: null, created_at: "2026-10-20 10:00:00",
    triaged_at: null, retrospective_issue_id: null, ...overrides,
  };
}

function view(overrides: Partial<RetroRepoView> = {}): RetroRepoView {
  return {
    repo: "org/repo",
    counts: new Map(),
    notes: [],
    ...overrides,
  };
}

function page(repos: RetroRepoView[], overrides: Partial<RetroPageView> = {}): RetroPageView {
  return {
    nextDue: new Date(2026, 9, 30),
    totalUntriaged: repos.reduce((n, r) => n + r.notes.length, 0),
    retrospectives: [],
    repos,
    ...overrides,
  };
}

describe("buildRetroPage", () => {
  it("renders at the wide tier with the Retro nav link current", () => {
    const html = buildRetroPage(page([view()]), "dark");
    expect(html).toContain('data-width="wide"');
    expect(html).toMatch(/<a[^>]*href="\/retro"[^>]*aria-current="page"/);
    expect(html).toContain("<title>claws — Retro</title>");
  });

  it("shows counts by category, the notes, the next due date and past retrospectives", () => {
    const html = buildRetroPage(page([view({
      counts: new Map([["tests", 2], ["docs", 1]]),
      notes: [
        note({ id: 1, task_id: 7, origin: "org/repo#clw_01M5SKZK2FXT9BFKZBPZ4QBDE4" }),
        note({ id: 2, text: "<b>flaky</b>", session_id: "sess1", reference: null }),
        note({ id: 3, category: "docs", text: "stale doc" }),
      ],
    })], {
      taskJobs: new Map([[7, "issue-worker"]]),
      retrospectives: [{ issueId: "clw_01M5AAAAAAAAAAAAAAAAAAAAAA", triagedAt: "2026-10-09 12:00:00", noteCount: 4 }],
    }), "dark");
    expect(html.match(/3\/50/g)).toHaveLength(1);
    expect(html.match(/2026-10-30 \(Friday\)/g)).toHaveLength(1);
    expect(html.match(/href="\/issues\/clw_01M5AAAAAAAAAAAAAAAAAAAAAA"/g)).toHaveLength(1);
    expect(html).toContain('class="retro-chip">tests <strong>2</strong>');
    expect(html).toContain('class="retro-chip">docs <strong>1</strong>');
    expect(html).toContain("3/50");
    expect(html).toContain("2026-10-30 (Friday)");
    expect(html).toContain('href="/issues/clw_01M5AAAAAAAAAAAAAAAAAAAAAA"');
    expect(html).toContain('<table class="data-cards">');
    expect(html).toContain('data-label="Note"');
    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain("task 7 (issue-worker)");
    expect(html).toContain('href="/issues/clw_01M5SKZK2FXT9BFKZBPZ4QBDE4"');
    expect(html).toContain("session sess1");
    expect(html).toContain("&lt;b&gt;flaky&lt;/b&gt;");
    expect(html).not.toContain("<b>flaky</b>");
  });

  it("lists every repo, those with notes first, and shows No notes for an empty one", () => {
    const html = buildRetroPage(page([
      view({ repo: "org/aaa" }),
      view({ repo: "org/zzz", notes: [note({ repo: "org/zzz" })], counts: new Map([["tests", 1]]) }),
      view({ repo: "org/off", disabled: true }),
    ]), "dark");
    expect(html).toContain("Disabled in /jobs");
    expect(html.indexOf(">org/zzz</a>")).toBeLessThan(html.indexOf(">org/aaa</a>"));
    expect(html).toContain("No notes");
    expect(html).toContain("None yet");
  });
});

import { describe, it, expect } from "vitest";
import { buildContractsPage, buildContractDetailPage, buildContractsReviewPage } from "./contracts.js";
import { buildReviewItems, gapKey } from "../contract-gap-review.js";
import { buildContractRows, contractWaivers, type ContractStatusSnapshot } from "../contract-status.js";

const snap = (over: Partial<ContractStatusSnapshot> = {}): ContractStatusSnapshot => ({
  policy: { status: "complete", path: "docs/observability.md", missingRules: [] },
  gaps: [],
  drift: [],
  driftUnavailable: [],
  audit: null,
  ...over,
});

const rows = buildContractRows({
  repos: ["o/coach", "o/vr-rooms", "o/new"],
  statuses: [
    {
      contract: "observability", repo: "o/coach", scannedAt: "2026-11-09T00:00:00.000Z",
      snapshot: snap({
        gaps: [{ text: "Accepted: no metrics endpoint, `single` process <b>", state: "accepted" }, { text: "No dashboard yet", state: "unaccepted" }, { text: "Deferred until 2026-12-01: no traces yet", state: "deferred" }],
        drift: [{ rule: "console-bypass", key: "src/a.ts", file: "src/a.ts", line: 3, message: "says X, shows Y" }],
        audit: { findings: [{ rule: "observability-audit", key: "src/b.ts", file: "src/b.ts", message: "audit says" }], auditedAt: "2026-11-08T00:00:00.000Z", sha: "abc" },
      }),
    },
    { contract: "observability", repo: "o/vr-rooms", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ gaps: [{ text: "x", state: "unaccepted" }] }) },
  ],
  auditTimes: [{ contract: "observability", repo: "o/coach", auditedAt: "2026-11-08T00:00:00.000Z" }],
  followUps: [{ contract: "observability", repo: "o/coach", id: "clw_01M72KMRHWPXRV2GRN18ESA6S5", title: "chore: close gaps", stopsAt: "plan review" }],
  exclusions: [{ repo: "o/vr-rooms", job: "logging-conventions-scanner", hostDisabled: false, repositoryDisabled: true }],
});

describe("buildContractsPage", () => {
  const html = buildContractsPage(rows, contractWaivers(rows), "dark");

  it("renders the wide tier with a card table and the nav current", () => {
    expect(html).toContain('<html lang="en" data-theme="dark" data-width="wide">');
    expect(html).toContain('class="data-cards data-cards-wide contracts-table"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('<th class="hide-sm">Last scan</th>');
  });

  it("puts a plain Deferred count between Unaccepted and Accepted", () => {
    expect(html).toContain("<th>Unaccepted</th><th>Deferred</th><th>Accepted</th>");
    const coach = html.slice(html.indexOf('href="/contracts/o/coach"'));
    const row = coach.slice(0, coach.indexOf("</tr>"));
    expect(row).toContain('<td data-label="Deferred">1</td>');
    expect(row.indexOf('data-label="Unaccepted"')).toBeLessThan(row.indexOf('data-label="Deferred"'));
    expect(row.indexOf('data-label="Deferred"')).toBeLessThan(row.indexOf('data-label="Accepted"'));
  });

  it("names the opt-out alias and hides its stale counts", () => {
    expect(html).toContain("Opted out");
    expect(html).toContain("logging-conventions-scanner disabled in repo config");
    const vrRow = html.slice(html.indexOf('href="/contracts/o/vr-rooms"'));
    expect(vrRow.slice(0, vrRow.indexOf("</tr>"))).not.toContain("contract-count-warn");
  });

  it("lists the accepted no-metrics gap in the waiver table", () => {
    const waivers = html.slice(html.indexOf("contracts-waivers"));
    expect(waivers).toContain("Metrics endpoint");
    expect(waivers).toContain('href="/contracts/o/coach"');
  });

  it("shows the follow-up with its Stops at line, and Not scanned yet", () => {
    expect(html).toContain('href="/issues/clw_01M72KMRHWPXRV2GRN18ESA6S5"');
    expect(html).toContain("Stops at plan review");
    expect(html).toContain("Not scanned yet");
  });

  it("puts rows needing attention before opted-out rows", () => {
    expect(html.indexOf('href="/contracts/o/coach"')).toBeLessThan(html.indexOf('href="/contracts/o/vr-rooms"'));
  });
});

describe("buildContractDetailPage", () => {
  const html = buildContractDetailPage("o/coach", rows.filter((r) => r.repo === "o/coach"), "dark");

  it("escapes gap text, renders code spans and highlights waivers", () => {
    expect(html).toContain("<code>single</code>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>");
    expect(html).toContain('class="contract-item waives"');
    expect(html).toContain("Waives: Metrics endpoint");
    expect(html).toContain("Unaccepted");
  });

  it("gives a deferred gap a neutral Deferred chip", () => {
    const item = html.slice(html.indexOf("no traces yet") - 400, html.indexOf("no traces yet"));
    expect(item).toContain(">Deferred<");
    expect(item.slice(item.lastIndexOf("<li"))).not.toContain("warn");
  });

  it("shows drift and audit findings with their locations", () => {
    expect(html).toContain("src/a.ts:3");
    expect(html).toContain("says X, shows Y");
    expect(html).toContain("audit says");
    expect(html).toContain("Audit findings");
  });

  it("uses the default width tier", () => {
    expect(html).toContain('<html lang="en" data-theme="dark">');
  });
});

describe("buildContractsPage review link", () => {
  it("links the review page with the changed count", () => {
    const html = buildContractsPage(rows, contractWaivers(rows), "dark", undefined, 3);
    expect(html).toContain('<a href="/contracts/review">Review accepted gaps</a> (3 new or reworded)');
  });
});

describe("buildContractsReviewPage", () => {
  const reviewRows = buildContractRows({
    repos: ["o/coach", "o/blog", "o/sec"],
    statuses: [
      { contract: "observability", repo: "o/coach", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ gaps: [{ text: "Accepted: no metrics endpoint", state: "accepted" }, { text: "Accepted: `tiny` & local", state: "accepted" }] }) },
      { contract: "observability", repo: "o/blog", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ gaps: [{ text: "Accepted: unchanged one", state: "accepted" }] }) },
      { contract: "security", repo: "o/sec", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ policy: { status: "complete", path: "docs/security.md", missingRules: [] }, gaps: [{ text: "Accepted: security only gap", state: "accepted" }] }) },
    ],
    auditTimes: [],
    followUps: [],
    exclusions: [],
  });
  const recs = [{ contract: "observability", repo: "o/blog", reconfirmedAt: "2026-11-01T00:00:00.000Z", gapKeys: [gapKey("Accepted: unchanged one")] }];
  const items = buildReviewItems(reviewRows, recs);
  const html = buildContractsReviewPage(items, reviewRows, { id: "clw_01M753CRBTEEXJM0QMWEZQBWN4" }, new Date("2026-11-11T12:00:00.000Z"), "dark");

  it("uses the default width tier and links the open digest", () => {
    expect(html).toContain('<html lang="en" data-theme="dark">');
    expect(html).toContain('href="/issues/clw_01M753CRBTEEXJM0QMWEZQBWN4"');
    expect(html).toContain("3 accepted observability Known gaps across 2 repos, 2 new or reworded");
  });

  it("lists no security gaps and links sentinel's page for them", () => {
    expect(html).not.toContain("security only gap");
    expect(html).toContain(`<a href="https://pages.home.bstjohn.net/sentinel/docs/cve-exceptions/">sentinel's CVE exception page</a>`);
  });

  it("posts Reconfirm all with the rendered gap keys", () => {
    expect(html).toContain('<form class="review-reconfirm" method="POST" action="/contracts/review/reconfirm">');
    expect(html).toContain('name="seen" value="[[');
    expect(html).toContain(">Reconfirm all</button>");
  });

  it("lists changed gaps waivers first and collapses unchanged ones", () => {
    const changed = html.slice(html.indexOf("New or reworded since last reconfirmation (2)"), html.indexOf('<details class="review-unchanged">'));
    expect(changed.indexOf("Waive a contract-level requirement (1)")).toBeLessThan(changed.indexOf("Other accepted gaps (1)"));
    expect(changed).toContain("Waives: Metrics endpoint");
    expect(changed).toContain("<code>tiny</code> &amp; local");
    expect(changed).toContain("Last reconfirmed never");
    const unchanged = html.slice(html.indexOf('<details class="review-unchanged">'));
    expect(unchanged).toContain("<summary>Unchanged (1)</summary>");
    expect(unchanged).toContain("unchanged one");
    expect(unchanged).toContain("Last reconfirmed <span");
  });

  it("offers prefilled Defer and Stop accepting links", () => {
    const defer = decodeURIComponent(html.match(/href="(\/issues\/new\?[^"]*)">Defer</)![1]!.replace(/&amp;/g, "&"));
    expect(defer).toContain("repo=o/coach");
    expect(defer).toContain("title=chore: defer an accepted observability gap in coach");
    expect(defer).toContain("> Accepted: no metrics endpoint");
    expect(defer).toContain("`docs/observability.md`");
    expect(defer).toContain("Deferred until YYYY-MM-DD:");
    const stop = decodeURIComponent(html.match(/href="(\/issues\/new\?[^"]*)">Stop accepting</)![1]!.replace(/&amp;/g, "&"));
    expect(stop).toContain("title=chore: stop accepting an observability gap in coach");
    expect(stop).toContain("Remove its `Accepted:` prefix");
  });

  it("truncates a long quoted gap", () => {
    const long = buildContractRows({
      repos: ["o/x"],
      statuses: [{ contract: "observability", repo: "o/x", scannedAt: "2026-11-09T00:00:00.000Z", snapshot: snap({ gaps: [{ text: `Accepted: ${"y".repeat(1900)}`, state: "accepted" }] }) }],
      auditTimes: [], followUps: [], exclusions: [],
    });
    const page = buildContractsReviewPage(buildReviewItems(long, []), long, null, new Date(), "dark");
    const defer = decodeURIComponent(page.match(/href="(\/issues\/new\?[^"]*)">Defer</)![1]!.replace(/&amp;/g, "&"));
    expect(defer).toContain("y…");
    expect(defer).not.toContain("y".repeat(1500));
  });

  it("says nothing changed when every gap is reconfirmed", () => {
    const quiet = buildContractsReviewPage(items.map((i) => ({ ...i, changed: false })), reviewRows, null, new Date(), "dark");
    expect(quiet).toContain("Nothing changed since the last reconfirmation");
  });
});

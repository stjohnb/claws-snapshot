import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLog, mockDb } = vi.hoisted(() => ({
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockDb: { saveContractGapReconfirmation: vi.fn(async () => {}) },
}));

vi.mock("./config.js", () => ({ LABELS: { blocked: "Blocked" }, DASHBOARD_URL: "https://claws.example/" }));
vi.mock("./log.js", () => mockLog);
vi.mock("./db.js", () => mockDb);
vi.mock("./claws-issues.js", () => ({}));
vi.mock("./claude.js", () => ({}));

import {
  DIGEST_ITEM_CAP,
  acceptedReviewDedupeKey,
  buildReviewItems,
  formatFleetReviewBody,
  gapKey,
  parseStoredTime,
  reconfirmRows,
  reviewSeenKey,
  reviewPageUrl,
  reviewableRows,
  SECURITY_GAP_REVIEW_URL,
  type ReviewItem,
} from "./contract-gap-review.js";
import { buildContractRows, type GapState } from "./contract-status.js";

type Status = { contract: string; repo: string; scannedAt: string; gaps: { text: string; state: GapState }[] };

function rowsOf(statuses: Status[], exclusions: { repo: string; job: string }[] = []) {
  return buildContractRows({
    repos: [...new Set(statuses.map((s) => s.repo))],
    statuses: statuses.map((s) => ({
      contract: s.contract,
      repo: s.repo,
      scannedAt: s.scannedAt,
      snapshot: { policy: { status: "complete", path: "docs/x.md", missingRules: [] }, gaps: s.gaps, drift: [], driftUnavailable: [], audit: null },
    })),
    auditTimes: [],
    followUps: [],
    exclusions: exclusions.map((e) => ({ ...e, hostDisabled: false, repositoryDisabled: true })),
  });
}

const accepted = (text: string) => ({ text, state: "accepted" as const });

beforeEach(() => vi.clearAllMocks());

describe("gapKey", () => {
  it("is 16 hex chars and ignores whitespace differences only", () => {
    expect(gapKey("Accepted: no traces")).toMatch(/^[0-9a-f]{16}$/);
    expect(gapKey("Accepted:  no\n traces ")).toBe(gapKey("Accepted: no traces"));
    expect(gapKey("Accepted: no tracing")).not.toBe(gapKey("Accepted: no traces"));
  });

  it("keeps the legacy per-repo key", () => {
    expect(acceptedReviewDedupeKey("security")).toBe("security-accepted-gaps-review");
  });
});

describe("buildReviewItems", () => {
  const rows = rowsOf([
    { contract: "observability", repo: "o/c", scannedAt: "2026-11-01T00:00:00.000Z", gaps: [accepted("Accepted: second local nicety"), accepted("Accepted: first local nicety"), { text: "unaccepted", state: "unaccepted" }] },
    { contract: "security", repo: "o/b", scannedAt: "2026-11-01T00:00:00.000Z", gaps: [accepted("Accepted: trivy DB fail-open")] },
    { contract: "observability", repo: "o/b", scannedAt: "2026-11-01T00:00:00.000Z", gaps: [accepted("Accepted: no metrics endpoint")] },
    { contract: "observability", repo: "o/a", scannedAt: "2026-11-01T00:00:00.000Z", gaps: [accepted("Accepted: local nicety"), { text: "Deferred until 2027-01-01: x", state: "deferred" }] },
    { contract: "observability", repo: "o/off", scannedAt: "2026-11-01T00:00:00.000Z", gaps: [accepted("Accepted: no dashboard")] },
  ], [{ repo: "o/off", job: "observability-contract-scanner" }]);

  it("lists accepted observability gaps only, waivers first, then by repo, policy order within a row, opt-outs and security excluded", () => {
    const items = buildReviewItems(rows, []);
    expect(items.map((i) => `${i.repo}:${i.contract}:${i.text}`)).toEqual([
      "o/b:observability:Accepted: no metrics endpoint",
      "o/a:observability:Accepted: local nicety",
      "o/c:observability:Accepted: second local nicety",
      "o/c:observability:Accepted: first local nicety",
    ]);
    expect(items[0]!.waives).toEqual(["Metrics endpoint"]);
    expect(items.every((i) => i.changed && i.reconfirmedAt === null)).toBe(true);
  });

  it("marks a gap unchanged once reconfirmed and changed again after a reword", () => {
    const rec = [{ contract: "observability", repo: "o/c", reconfirmedAt: "2026-11-02T00:00:00.000Z", gapKeys: [gapKey("Accepted: second   local nicety"), gapKey("Accepted: first local nicety (old)")] }];
    const items = buildReviewItems(rows, rec).filter((i) => i.repo === "o/c");
    expect(items.map((i) => [i.text, i.changed, i.reconfirmedAt])).toEqual([
      ["Accepted: second local nicety", false, "2026-11-02T00:00:00.000Z"],
      ["Accepted: first local nicety", true, "2026-11-02T00:00:00.000Z"],
    ]);
  });
});

describe("formatFleetReviewBody", () => {
  const item = (n: number, waives: string[] = [], changed = true): ReviewItem =>
    ({ repo: `o/r${n}`, contract: "observability", text: `Accepted: gap ${n}`, waives, changed, reconfirmedAt: null });

  it("summarises, links the page, and lists changed waivers first", () => {
    const body = formatFleetReviewBody([item(1, ["Dashboard"]), item(2), item(3, [], false)], "https://claws.example/contracts/review");
    expect(body).toContain("The fleet accepts 3 observability Known gaps across 3 repos: 2 new or reworded since they were last reconfirmed, 1 waiver of a contract-level requirement.");
    expect(body).toContain("https://claws.example/contracts/review");
    expect(body).toContain(`Accepted security gaps are reviewed on sentinel's page instead: ${SECURITY_GAP_REVIEW_URL}`);
    expect(body).toContain("- o/r1 (observability): Accepted: gap 1 — waives: Dashboard");
    expect(body.indexOf("**Waive a contract-level requirement:**")).toBeLessThan(body.indexOf("**Other accepted gaps:**"));
    expect(body).not.toContain("gap 3");
    expect(body).toContain("Close this issue as completed");
    expect(body).toContain("closing it as not planned reconfirms nothing");
    expect(body).toContain("about 91 days after this one closes");
  });

  it("caps the list with a pointer to the page", () => {
    const items = Array.from({ length: DIGEST_ITEM_CAP + 5 }, (_, i) => item(i));
    const body = formatFleetReviewBody(items, "/contracts/review");
    expect(body).toContain(`gap ${DIGEST_ITEM_CAP - 1}\n`);
    expect(body).not.toContain(`gap ${DIGEST_ITEM_CAP}\n`);
    expect(body).toContain("…and 5 more on the review page.");
  });

  it("says when nothing changed", () => {
    expect(formatFleetReviewBody([item(1, [], false)], "/contracts/review")).toContain("Nothing changed since the last reconfirmation.");
  });
});

describe("reviewPageUrl and parseStoredTime", () => {
  it("builds the page URL from DASHBOARD_URL", () => {
    expect(reviewPageUrl()).toBe("https://claws.example/contracts/review");
  });

  it("parses a stored SQL timestamp as UTC", () => {
    expect(parseStoredTime("2026-11-11 09:45:45")?.toISOString()).toBe("2026-11-11T09:45:45.000Z");
    expect(parseStoredTime(null)).toBeNull();
    expect(parseStoredTime("garbage")).toBeNull();
  });
});

describe("reconfirmRows", () => {
  it("saves every accepted observability gap's key per row without `seen`, never a security row", async () => {
    const rows = rowsOf([
      { contract: "observability", repo: "o/a", scannedAt: "2026-11-05T00:00:00.000Z", gaps: [accepted("Accepted: a")] },
      { contract: "security", repo: "o/b", scannedAt: "2026-11-05T00:00:00.000Z", gaps: [accepted("Accepted: b")] },
    ]);
    expect(reviewableRows(rows).map((r) => r.repo)).toEqual(["o/a"]);
    expect(await reconfirmRows(rows, new Date(), "test")).toEqual({ repos: 1, gaps: 1, skipped: 0 });
    expect(mockDb.saveContractGapReconfirmation).toHaveBeenCalledTimes(1);
    expect(mockDb.saveContractGapReconfirmation).toHaveBeenCalledWith("observability", "o/a", expect.any(String), [gapKey("Accepted: a")]);
  });

  it("saves only the seen keys and skips rows with none seen", async () => {
    const rows = rowsOf([
      { contract: "observability", repo: "o/a", scannedAt: "2026-11-01T00:00:00.000Z", gaps: [accepted("Accepted: a1"), accepted("Accepted: a2"), { text: "u", state: "unaccepted" }] },
      { contract: "observability", repo: "o/b", scannedAt: "2026-11-05T00:00:00.000Z", gaps: [accepted("Accepted: b")] },
    ]);
    const at = new Date("2026-11-06T00:00:00.000Z");
    const seen = new Map([[reviewSeenKey("observability", "o/a"), new Set([gapKey("Accepted: a1")])]]);
    expect(await reconfirmRows(rows, at, "test", seen)).toEqual({ repos: 1, gaps: 1, skipped: 1 });
    expect(mockDb.saveContractGapReconfirmation).toHaveBeenCalledTimes(1);
    expect(mockDb.saveContractGapReconfirmation).toHaveBeenCalledWith("observability", "o/a", at.toISOString(), [gapKey("Accepted: a1")]);
  });
});

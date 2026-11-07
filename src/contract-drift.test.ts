import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

const { mockClawsIssues } = vi.hoisted(() => ({
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    findOpenIssueByDedupeKey: vi.fn(),
    findRecentlyClosedIssueByDedupeKey: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
  },
}));
vi.mock("./claws-issues.js", () => mockClawsIssues);

import {
  CONTRACT_AUDITS,
  formatFollowUpBody,
  refreshFollowUpIssue,
  runDriftRules,
  suppressListed,
  toDriftFindings,
  type DriftFinding,
  type DriftRule,
  type FollowUpIssueOptions,
} from "./contract-drift.js";

const REPO = "test-org/test-repo";
const KEY = "observability-known-gaps";
const TITLE = "chore: close this repo's known observability gaps";

const DRIFT: DriftFinding = {
  rule: "console-bypass",
  key: "src/server.ts",
  file: "src/server.ts",
  line: 12,
  message: "The policy says X, but the code shows Y.",
};

function opts(overrides: Partial<FollowUpIssueOptions> = {}): FollowUpIssueOptions {
  return {
    job: "observability-contract-scanner",
    repo: REPO,
    title: TITLE,
    dedupeKey: KEY,
    contract: "observability",
    policyPath: "AGENTS.md",
    gaps: [{ text: "No DB query durations.", accepted: false }],
    drift: [],
    audit: null,
    contractDocUrl: "https://example.test/contract.md",
    ...overrides,
  };
}

describe("runDriftRules", () => {
  it("collects findings and unavailable rules", () => {
    const rules: DriftRule<number>[] = [
      { id: "a", check: (n) => [{ ...DRIFT, rule: "a", message: `n=${n}` }] },
      { id: "b", check: () => ({ unavailable: "clone absent" }) },
      { id: "c", check: () => [] },
    ];
    expect(runDriftRules(rules, 3)).toEqual({
      findings: [{ ...DRIFT, rule: "a", message: "n=3" }],
      unavailable: [{ rule: "b", reason: "clone absent" }],
    });
  });
});

describe("suppressListed", () => {
  it("drops findings whose key a Known gaps item mentions, accepted or not", () => {
    const other: DriftFinding = { rule: "named-path-missing", key: "src/metrics.ts", message: "m" };
    const third: DriftFinding = { rule: "alert-reference-missing", key: "x-error-logs", message: "m" };
    const gaps = [
      { text: "`src/server.ts` still uses console.", accepted: false },
      { text: "Accepted: the rule uid `x-error-logs` moves next quarter.", accepted: true },
    ];
    expect(suppressListed([DRIFT, other, third], gaps)).toEqual([other]);
  });
  it("does not suppress on a bare substring that is not backticked", () => {
    const f: DriftFinding = { rule: "no-telemetry-service", key: "Dockerfile", message: "m" };
    expect(suppressListed([f], [{ text: "Dockerfile healthcheck has no log line.", accepted: false }])).toEqual([f]);
  });
});

describe("toDriftFindings", () => {
  it("keeps well-formed stored findings and drops malformed ones", () => {
    expect(toDriftFindings([DRIFT, { rule: "r", key: "k", message: "m", line: "x" }, { rule: "r" }, null, "s"])).toEqual([
      DRIFT,
      { rule: "r", key: "k", message: "m" },
    ]);
  });
});

describe("CONTRACT_AUDITS", () => {
  it("registers the observability audit against its scanner and follow-up issue", () => {
    expect(CONTRACT_AUDITS.map((s) => [s.contract, s.scannerJob, s.followUp.dedupeKey])).toEqual([
      ["observability", "observability-contract-scanner", KEY],
    ]);
    expect(CONTRACT_AUDITS[0]!.followUp.title).toBe(TITLE);
  });
});

describe("formatFollowUpBody", () => {
  it("keeps the gaps text when only gaps are listed", () => {
    const body = formatFollowUpBody(opts());
    expect(body).toContain("`AGENTS.md` lists 1 known observability gap(s) under `### Known gaps`");
    expect(body).toContain("**Unaccepted gaps:**\n\n- No DB query durations.");
    expect(body).not.toContain("**Drift");
    expect(body).not.toContain("**Audit findings**");
    expect(body).not.toContain("For each drift or audit finding");
    expect(body).toContain("never re-files it after a close as not planned");
  });

  it("adds drift and audit sections with file:line and the fix-or-list ask", () => {
    const body = formatFollowUpBody(
      opts({
        gaps: [],
        drift: [DRIFT, { rule: "named-path-missing", key: "src/m.ts", message: "Missing `src/m.ts`." }],
        audit: {
          findings: [{ rule: "audit", key: "src/db.ts", file: "src/db.ts", line: 40, message: "New query has no duration." }],
          auditedAt: "2026-11-01T03:00:00.000Z",
          sha: "0123456789abcdef0123",
        },
      }),
    );
    expect(body).toContain("`AGENTS.md` declares this repo's observability policy");
    expect(body).not.toContain("**Unaccepted gaps:**");
    expect(body).toContain(
      "**Drift: the policy says X, the code shows Y:**\n\n- `src/server.ts:12`: The policy says X, but the code shows Y.\n- Missing `src/m.ts`.",
    );
    expect(body).toContain("**Audit findings** (agent audit of 2026-11-01 at `0123456789ab`):\n\n- `src/db.ts:40`: New query has no duration.");
    expect(body).toContain("fix the code, or correct the policy and list the shortfall under `### Known gaps`");
    expect(body).not.toContain("Close each gap by fixing the code");
  });
});

describe("refreshFollowUpIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.createIssue.mockResolvedValue("clw_new");
  });

  it("files nothing when gaps, drift and audit are all empty", async () => {
    expect(await refreshFollowUpIssue(opts({ gaps: [] }))).toBe("none");
    expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("files a native keyed issue when only drift is found", async () => {
    expect(await refreshFollowUpIssue(opts({ gaps: [], drift: [DRIFT] }))).toBe("filed");
    expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(REPO, KEY);
    expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        title: TITLE,
        authorLogin: "claws",
        repos: [REPO],
        source: "automation",
        dedupeKey: KEY,
        body: expect.stringContaining("`src/server.ts:12`"),
      }),
    );
  });

  it("rewrites the open issue in place when its body differs", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: "old body" });

    expect(await refreshFollowUpIssue(opts())).toBe("updated");

    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.editIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.editIssue.mock.calls[0]![0]).toBe("clw_open");
    expect(mockClawsIssues.editIssue.mock.calls[0]![1]).toContain("- No DB query durations.");
  });

  it("leaves an open issue whose body already matches", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: formatFollowUpBody(opts()) });

    expect(await refreshFollowUpIssue(opts())).toBe("unchanged");

    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("never re-files after a close as not planned", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({ id: "clw_closed", state_reason: "not_planned" });

    expect(await refreshFollowUpIssue(opts({ drift: [DRIFT] }))).toBe("skipped-not-planned");

    expect(mockClawsIssues.findRecentlyClosedIssueByDedupeKey).toHaveBeenCalledWith(REPO, KEY, new Date(0));
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("re-files after a close as completed while items remain", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({ id: "clw_closed", state_reason: "completed" });

    expect(await refreshFollowUpIssue(opts())).toBe("filed");

    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
  });
});

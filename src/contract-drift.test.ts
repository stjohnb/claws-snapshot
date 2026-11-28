import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLog } = vi.hoisted(() => ({ mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("./log.js", () => mockLog);

const { mockClawsIssues } = vi.hoisted(() => ({
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    findOpenIssueByDedupeKey: vi.fn(),
    findRecentlyClosedIssueByDedupeKey: vi.fn(),
    listNotPlannedIssuesByDedupeKey: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
    editIssueTitle: vi.fn(),
    getIssue: vi.fn(),
  },
}));
vi.mock("./claws-issues.js", () => mockClawsIssues);

const { mockRetitle } = vi.hoisted(() => ({ mockRetitle: { retitleKeepingPlanCurrent: vi.fn() } }));
vi.mock("./issue-retitle.js", () => mockRetitle);

import {
  auditSupersededByClose,
  backfillSettled,
  CONTRACT_AUDITS,
  dismissedItems,
  exceptionProblemFindings,
  findingFingerprint,
  FOLLOW_UP_TITLE_MAX,
  followUpTitle,
  isBackfillOnly,
  logBackfillSummary,
  RULE_SETTLE_DAYS,
  formatFollowUpBody,
  refreshFollowUpIssue,
  resolveGapStates,
  runDriftRules,
  suppressFindings,
  toDriftFindings,
  type DriftFinding,
  type BackfillRule,
  type DriftRule,
  type FollowUpIssueOptions,
} from "./contract-drift.js";
import type { ContractException } from "./contract-exceptions.js";

const REPO = "test-org/test-repo";
const KEY = "observability-known-gaps";

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

describe("findingFingerprint", () => {
  it("is the first 8 hex chars of sha256 over rule, key and message", async () => {
    const crypto = await import("node:crypto");
    const expected = crypto.createHash("sha256").update("console-bypass\nsrc/server.ts\nThe policy says X, but the code shows Y.").digest("hex").slice(0, 8);
    expect(findingFingerprint(DRIFT)).toBe(expected);
    expect(findingFingerprint(DRIFT)).toMatch(/^[0-9a-f]{8}$/);
  });
  it("changes with the message and ignores file and line", () => {
    expect(findingFingerprint({ ...DRIFT, message: "other" })).not.toBe(findingFingerprint(DRIFT));
    const moved: DriftFinding = { ...DRIFT, line: 99 };
    expect(findingFingerprint(moved)).toBe(findingFingerprint(DRIFT));
  });
});

describe("suppressFindings", () => {
  const none = { gaps: [], exceptions: [] };
  const exception = (e: Partial<ContractException> = {}): ContractException => ({
    contract: "observability",
    rule: "console-bypass",
    keys: ["src/server.ts"],
    reason: "Browser code, exempt here.",
    ...e,
  });

  it("drops a finding a Known gaps item names by key and rule id, accepted or not", () => {
    const other: DriftFinding = { rule: "named-path-missing", key: "src/metrics.ts", message: "m" };
    const third: DriftFinding = { rule: "alert-reference-missing", key: "x-error-logs", message: "m" };
    const gaps = [
      { text: "`src/server.ts` still uses console (drift rule `console-bypass`).", accepted: false },
      { text: "Accepted: the rule uid `x-error-logs` moves next quarter (`alert-reference-missing`).", accepted: true },
    ];
    expect(suppressFindings([DRIFT, other, third], { gaps, exceptions: [] })).toEqual({
      kept: [other],
      byGap: 2,
      byException: 0,
    });
  });

  it("drops a finding a Known gaps item names by key and fingerprint", () => {
    const gaps = [{ text: `\`src/server.ts\` finding \`${findingFingerprint(DRIFT)}\`.`, accepted: false }];
    expect(suppressFindings([DRIFT], { gaps, exceptions: [] })).toMatchObject({ kept: [], byGap: 1 });
  });

  it("still reports a different rule's finding on a file a rule-scoped gap names", () => {
    const sameFile: DriftFinding = { rule: "info-dropped", key: "src/server.ts", message: "m" };
    const gaps = [{ text: "`src/server.ts` still uses console (`console-bypass`).", accepted: false }];
    expect(suppressFindings([DRIFT, sameFile], { gaps: [], exceptions: [exception()] }).kept).toEqual([sameFile]);
    expect(suppressFindings([DRIFT, sameFile], { gaps, exceptions: [] })).toEqual({
      kept: [sameFile],
      byGap: 1,
      byException: 0,
    });
  });

  it("does not suppress on a Known gaps item naming only the key", () => {
    const gaps = [{ text: "`src/server.ts` still uses console.", accepted: false }];
    expect(suppressFindings([DRIFT], { gaps, exceptions: [] })).toEqual({ kept: [DRIFT], byGap: 0, byException: 0 });
  });

  it("does not suppress on a bare substring that is not backticked", () => {
    const f: DriftFinding = { rule: "no-telemetry-service", key: "Dockerfile", message: "m" };
    const gaps = [{ text: "Dockerfile healthcheck has no log line (no-telemetry-service).", accepted: false }];
    expect(suppressFindings([f], { gaps, exceptions: [] }).kept).toEqual([f]);
  });

  it("drops a finding an exception covers by rule and key, before any gap", () => {
    const gaps = [{ text: "`src/server.ts` (`console-bypass`).", accepted: false }];
    expect(suppressFindings([DRIFT], { gaps, exceptions: [exception()] })).toEqual({ kept: [], byGap: 0, byException: 1 });
  });

  it("needs the rule equal, the key listed, and the pinned fingerprint equal", () => {
    expect(suppressFindings([DRIFT], { ...none, exceptions: [exception({ rule: "info-dropped" })] }).kept).toEqual([DRIFT]);
    expect(suppressFindings([DRIFT], { ...none, exceptions: [exception({ keys: ["src/other.ts"] })] }).kept).toEqual([DRIFT]);
    expect(suppressFindings([DRIFT], { ...none, exceptions: [exception({ finding: "00000000" })] }).kept).toEqual([DRIFT]);
    expect(suppressFindings([DRIFT], { ...none, exceptions: [exception({ finding: findingFingerprint(DRIFT) })] }).byException).toBe(1);
  });

  it("matches audit findings only by fingerprint", () => {
    const audit: DriftFinding = { rule: "observability-audit", key: "src/db.ts", file: "src/db.ts", message: "No duration." };
    const fp = findingFingerprint(audit);
    const byRule = { gaps: [{ text: "`src/db.ts` (`observability-audit`).", accepted: false }], exceptions: [] };
    expect(suppressFindings([audit], { ...byRule, audit: true })).toMatchObject({ kept: [audit], byGap: 0 });
    const unpinned = [exception({ rule: "observability-audit", keys: ["src/db.ts"] })];
    expect(suppressFindings([audit], { gaps: [], exceptions: unpinned, audit: true }).kept).toEqual([audit]);
    const pinned = [exception({ rule: "observability-audit", keys: ["src/db.ts"], finding: fp })];
    expect(suppressFindings([audit], { gaps: [], exceptions: pinned, audit: true }).byException).toBe(1);
    const gapFp = [{ text: `\`src/db.ts\` finding \`${fp}\`.`, accepted: false }];
    expect(suppressFindings([audit], { gaps: gapFp, exceptions: [], audit: true }).byGap).toBe(1);
  });
});

describe("exceptionProblemFindings", () => {
  it("reports one contract-exceptions finding per problem", () => {
    expect(exceptionProblemFindings(["entry 1 has no `keys`"])).toEqual([
      {
        rule: "contract-exceptions",
        key: ".claws/contract-exceptions.yaml",
        file: ".claws/contract-exceptions.yaml",
        message: "An invalid scanner exceptions file or entry suppresses nothing: entry 1 has no `keys`.",
      },
    ]);
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
  it("registers the observability and security audits against their scanners and follow-up issues", () => {
    expect(CONTRACT_AUDITS.map((s) => [s.contract, s.scannerJob, s.followUp.dedupeKey])).toEqual([
      ["observability", "observability-contract-scanner", KEY],
      ["security", "security-contract-scanner", "security-known-gaps"],
    ]);
    for (const spec of CONTRACT_AUDITS) expect(spec.followUp).not.toHaveProperty("title");
  });
});

describe("followUpTitle", () => {
  const audit = (findings: DriftFinding[]) => ({ findings, auditedAt: "2026-11-01T00:00:00Z", sha: "a".repeat(40) });

  it("names a single gap by its first clause, without markdown or an Unaccepted label", () => {
    const gap = { text: "**Unaccepted:** No request-duration metrics on the `bonkus` API; the handlers only log.", accepted: false };
    expect(followUpTitle(opts({ gaps: [gap] }))).toBe("observability: No request-duration metrics on the bonkus API");
  });

  it("drops a lapsed deferral label from a gap's title phrase", () => {
    for (const text of ["Deferred (#clw_01M72ABC): No uptime probe for the API.", "Deferred until 2026-10-01: No uptime probe for the API.", "**Deferred (#clw_01M72ABC)**: No uptime probe for the API.", "**Deferred until 2026-10-01**: No uptime probe for the API."]) {
      expect(followUpTitle(opts({ gaps: [{ text, accepted: false }] }))).toBe("observability: No uptime probe for the API");
    }
  });

  it("cuts a gap at an em dash, `, so ` or a parenthesis", () => {
    for (const text of ["No uptime probe \u2014 nothing pages", "No uptime probe, so nothing pages", "No uptime probe (see #12)"]) {
      expect(followUpTitle(opts({ gaps: [{ text, accepted: false }] }))).toBe("observability: No uptime probe");
    }
  });

  it("counts several gaps and lists them", () => {
    const gaps = [
      { text: "No uptime probe.", accepted: false },
      { text: "Unpinned base image.", accepted: false, lapsed: true },
    ];
    expect(followUpTitle(opts({ gaps }))).toBe("observability: 2 gaps \u2014 No uptime probe, Unpinned base image");
  });

  it("names a drift finding by what the code shows and the file's basename", () => {
    const f: DriftFinding = {
      rule: "named-path-missing",
      key: "src/metrics.ts",
      file: "src/metrics.ts",
      message: "The policy names `src/metrics.ts`; the code shows no such file. It was removed.",
    };
    expect(followUpTitle(opts({ gaps: [], drift: [f] }))).toBe("observability: metrics.ts: no such file");
  });

  it("names the production-infra ICMP audit finding by file", () => {
    const f: DriftFinding = {
      rule: "audit",
      key: "tofu/modules/hcloud-cluster/main.tf",
      file: "tofu/modules/hcloud-cluster/main.tf",
      line: 52,
      message:
        "The policy says only 80 and 443 are open to the internet, but `tofu/modules/hcloud-cluster/main.tf`: both Hetzner firewalls allow ICMP from 0.0.0.0/0 and ::/0, which the security policy does not document. Document it.",
    };
    const title = followUpTitle(opts({ contract: "security", gaps: [], audit: audit([f]) }));
    expect(title.startsWith("security: main.tf: ")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(FOLLOW_UP_TITLE_MAX);
    expect(title).toContain("ICMP");
  });

  it("names an audit finding with no file by its message", () => {
    const f: DriftFinding = { rule: "audit", key: "fleet-infra:apps/x.yaml", message: "No alert rule watches error logs." };
    expect(followUpTitle(opts({ gaps: [], audit: audit([f]) }))).toBe("observability: No alert rule watches error logs");
  });

  it("names new contract rules alone", () => {
    const newRules: BackfillRule[] = [
      { id: "uptime-probe", label: "Uptime probe", added: "2026-01-01" },
      { id: "error-alert", label: "Error alert", added: "2026-01-01" },
    ];
    expect(followUpTitle(opts({ gaps: [], newRules }))).toBe(
      "observability: 2 findings \u2014 policy lacks the uptime-probe rule, policy lacks the error-alert rule",
    );
  });

  it("calls a mixed set items, in body order", () => {
    const title = followUpTitle(opts({ drift: [DRIFT] }));
    expect(title).toBe("observability: 2 items \u2014 No DB query durations, server.ts: the code shows Y");
  });

  it("stops at 100 characters, ending with an ellipsis for the items left out", () => {
    const gaps = ["First gap about tracing", "Second gap about the metrics endpoint", "Third gap about dashboards", "Fourth gap about alerts"].map(
      (text) => ({ text, accepted: false }),
    );
    const title = followUpTitle(opts({ gaps }));
    expect(title.length).toBeLessThanOrEqual(FOLLOW_UP_TITLE_MAX);
    expect(title).toBe("observability: 4 gaps \u2014 First gap about tracing, Second gap about the metrics endpoint, \u2026");
  });

  it("clips a single long phrase at a word boundary", () => {
    const text = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ");
    const one = followUpTitle(opts({ gaps: [{ text, accepted: false }] }));
    expect(one.length).toBeLessThanOrEqual(FOLLOW_UP_TITLE_MAX);
    expect(one).toMatch(/^observability: word0 .* word\d+\u2026$/);
    const several = followUpTitle(opts({ gaps: [{ text, accepted: false }, { text: "short", accepted: false }] }));
    expect(several.length).toBeLessThanOrEqual(FOLLOW_UP_TITLE_MAX);
    expect(several).toMatch(/^observability: 2 gaps \u2014 word0 .*\u2026, \u2026$/);
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
    expect(body).toContain("A close as not planned dismisses only the gaps and findings listed here");
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
    const missing: DriftFinding = { rule: "named-path-missing", key: "src/m.ts", message: "Missing `src/m.ts`." };
    const audited: DriftFinding = { rule: "audit", key: "src/db.ts", file: "src/db.ts", line: 40, message: "New query has no duration." };
    expect(body).toContain(
      `**Drift: the policy says X, the code shows Y:**\n\n- \`src/server.ts:12\`: The policy says X, but the code shows Y. (rule \`console-bypass\`, finding \`${findingFingerprint(DRIFT)}\`)\n- Missing \`src/m.ts\`. (rule \`named-path-missing\`, finding \`${findingFingerprint(missing)}\`)`,
    );
    expect(body).toContain(
      `**Audit findings** (agent audit of 2026-11-01 at \`0123456789ab\`):\n\n- \`src/db.ts:40\`: New query has no duration. (rule \`audit\`, finding \`${findingFingerprint(audited)}\`)`,
    );
    expect(body).toContain("- [ ] For each drift or audit finding, pick one:\n  - Fix the code, or correct the policy so it matches the code.");
    expect(body).toContain("under `### Known gaps` in an item that names, in backticks, the finding's key");
    expect(body).toContain(
      "add an entry to `.claws/contract-exceptions.yaml` with `contract`, `rule`, `keys` (the finding's exact keys) and `reason`, plus `finding` (the finding id, as a quoted string such as `finding: \"1a2b3c4d\"`) for an audit finding; never an `Accepted:` gap.",
    );
    expect(body).not.toContain("Close each gap by fixing the code");
  });
});

describe("formatFollowUpBody deferrals", () => {
  it("marks a lapsed deferral and offers both Accepted and Deferred", () => {
    const body = formatFollowUpBody(opts({
      gaps: [{ text: "Deferred until 2026-11-01: no metrics yet.", accepted: false, lapsed: true }, { text: "plain", accepted: false }],
    }));
    expect(body).toContain("that are neither accepted nor deferred");
    expect(body).toContain("**Unaccepted gaps:**\n\n- Deferred until 2026-11-01: no metrics yet. (deferral lapsed)\n- plain");
    expect(body).toContain("- [ ] For a gap the repo does not fix now, pick one:\n  - Start its item `Accepted: <reason>` to live with it.\n  - Start its item `Deferred until YYYY-MM-DD: <reason>`");
    expect(body).toContain("`Deferred (#clw_…): <reason>` when it cannot be fixed yet");
  });
});

describe("resolveGapStates", () => {
  const NOW = new Date("2026-11-10T15:00:00.000Z");
  const ISSUE = "clw_01M72KKZBZVJ5QAM7FAAR1MHD0";
  const dated = (until: string) => ({ text: `Deferred until ${until}: x`, accepted: false, deferral: { until } });
  const byIssue = { text: `Deferred (#${ISSUE}): x`, accepted: false, deferral: { issue: ISSUE } };

  beforeEach(() => {
    mockClawsIssues.getIssue.mockReset();
    mockLog.warn.mockReset();
  });

  it("keeps accepted and plain items as they are", async () => {
    const out = await resolveGapStates([{ text: "Accepted: x", accepted: true }, { text: "y", accepted: false }], NOW);
    expect(out.map((g) => [g.state, g.lapsed])).toEqual([["accepted", false], ["unaccepted", false]]);
  });

  it("holds a dated deferral through its UTC date and lapses it the next day", async () => {
    const out = await resolveGapStates([dated("2026-11-10"), dated("2026-11-09"), dated("2026-11-11")], NOW);
    expect(out.map((g) => [g.state, g.lapsed])).toEqual([["deferred", false], ["unaccepted", true], ["deferred", false]]);
  });

  it("treats a date more than 366 days ahead as unaccepted", async () => {
    // 2026-11-10 + 366 days = 2027-11-11; + 367 days = 2027-11-12.
    const out = await resolveGapStates([dated("2027-11-11"), dated("2027-11-12")], NOW);
    expect(out.map((g) => [g.state, g.lapsed])).toEqual([["deferred", false], ["unaccepted", false]]);
  });

  it("holds an issue deferral only while the issue is open", async () => {
    mockClawsIssues.getIssue.mockResolvedValueOnce({ id: ISSUE, state: "open" });
    mockClawsIssues.getIssue.mockResolvedValueOnce({ id: ISSUE, state: "closed", state_reason: "not_planned" });
    mockClawsIssues.getIssue.mockResolvedValueOnce(undefined);
    const out = await resolveGapStates([byIssue, byIssue, byIssue], NOW);
    expect(out.map((g) => [g.state, g.lapsed])).toEqual([["deferred", false], ["unaccepted", true], ["unaccepted", false]]);
    expect(mockClawsIssues.getIssue).toHaveBeenCalledWith(ISSUE);
  });

  it("counts a failed issue lookup as deferred and logs warn", async () => {
    mockClawsIssues.getIssue.mockRejectedValueOnce(new Error("db down"));
    const out = await resolveGapStates([byIssue], NOW, { component: "c", repo: REPO });
    expect(out[0]!.state).toBe("deferred");
    expect(mockLog.warn).toHaveBeenCalledWith("deferral issue lookup failed", expect.objectContaining({ component: "c", repo: REPO, issue: ISSUE, error: "db down" }));
  });
});

describe("refreshFollowUpIssue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([]);
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
        title: "observability: server.ts: the code shows Y",
        authorLogin: "claws",
        repos: [REPO],
        source: "automation",
        dedupeKey: KEY,
        body: expect.stringContaining("`src/server.ts:12`"),
      }),
    );
  });

  it("rewrites the open issue's body and title in place when its items change", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", title: "old title", body: "old body" });

    expect(await refreshFollowUpIssue(opts())).toBe("updated");

    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.editIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.editIssue.mock.calls[0]![0]).toBe("clw_open");
    expect(mockClawsIssues.editIssue.mock.calls[0]![1]).toContain("- No DB query durations.");
    expect(mockClawsIssues.editIssueTitle).toHaveBeenCalledWith("clw_open", "observability: No DB query durations");
    expect(mockRetitle.retitleKeepingPlanCurrent).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith("follow-up issue updated", expect.objectContaining({ issue: "clw_open", retitled: true }));
  });

  it("rewrites only the body when the title already matches", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", title: followUpTitle(opts()), body: "old body" });

    expect(await refreshFollowUpIssue(opts())).toBe("updated");

    expect(mockClawsIssues.editIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.editIssueTitle).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith("follow-up issue updated", expect.not.objectContaining({ retitled: true }));
  });

  it("renames an open issue whose body matches through the plan-keeping helper", async () => {
    const body = formatFollowUpBody(opts());
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", title: "chore: close this repo's known observability gaps", body });
    mockRetitle.retitleKeepingPlanCurrent.mockResolvedValue(true);

    expect(await refreshFollowUpIssue(opts())).toBe("updated");

    expect(mockRetitle.retitleKeepingPlanCurrent).toHaveBeenCalledWith(
      REPO,
      "clw_open",
      "chore: close this repo's known observability gaps",
      body,
      "observability: No DB query durations",
    );
    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.editIssueTitle).not.toHaveBeenCalled();
    expect(mockLog.info).toHaveBeenCalledWith("follow-up issue retitled", expect.objectContaining({ issue: "clw_open" }));
  });

  it("reports unchanged when the plan-keeping rename wrote nothing", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", title: "old", body: formatFollowUpBody(opts()) });
    mockRetitle.retitleKeepingPlanCurrent.mockResolvedValue(false);

    expect(await refreshFollowUpIssue(opts())).toBe("unchanged");
    expect(mockLog.info).not.toHaveBeenCalledWith("follow-up issue retitled", expect.anything());
  });

  it("leaves an open issue whose body and title already match", async () => {
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", title: followUpTitle(opts()), body: formatFollowUpBody(opts()) });

    expect(await refreshFollowUpIssue(opts())).toBe("unchanged");

    expect(mockClawsIssues.editIssue).not.toHaveBeenCalled();
    expect(mockClawsIssues.editIssueTitle).not.toHaveBeenCalled();
    expect(mockRetitle.retitleKeepingPlanCurrent).not.toHaveBeenCalled();
    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  describe("after a close as not planned", () => {
    const notPlanned = (o: Partial<FollowUpIssueOptions>, id = "clw_np") => ({
      id,
      state_reason: "not_planned",
      body: formatFollowUpBody(opts(o)),
    });
    const NEW_DRIFT: DriftFinding = { ...DRIFT, line: 30, message: "Another mismatch." };
    const AUDIT_F: DriftFinding = { rule: "observability-audit", key: "a.sh", file: "a.sh", line: 5, message: "skips silently" };
    const AUDIT_G: DriftFinding = { rule: "observability-audit", key: "b.sh", file: "b.sh", line: 7, message: "other" };
    const audit = (findings: DriftFinding[]) => ({ findings, auditedAt: "2026-11-05T00:00:00.000Z", sha: "aaa111" });

    it("skips when every gap and finding was listed", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([notPlanned({ drift: [DRIFT], audit: audit([AUDIT_F]) })]);

      expect(await refreshFollowUpIssue(opts({ drift: [DRIFT], audit: audit([AUDIT_F]) }))).toBe("skipped-not-planned");

      expect(mockClawsIssues.listNotPlannedIssuesByDedupeKey).toHaveBeenCalledWith(REPO, KEY);
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        "follow-up issue skipped",
        expect.objectContaining({ reason: "closed_not_planned", dismissed: 3 }),
      );
    });

    it("matches a lapsed gap and whitespace differences", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([
        { id: "clw_np", state_reason: "not_planned", body: "**Unaccepted gaps:**\n\n- No  DB query durations. (deferral lapsed)\n" },
      ]);

      expect(await refreshFollowUpIssue(opts())).toBe("skipped-not-planned");
    });

    it("files only a new gap", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([notPlanned({ drift: [DRIFT] })]);
      const gaps = [{ text: "No DB query durations.", accepted: false }, { text: "No traces.", accepted: false }];

      expect(await refreshFollowUpIssue(opts({ gaps, drift: [DRIFT] }))).toBe("filed");

      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("- No traces.");
      expect(body).not.toContain("No DB query durations.");
      expect(body).not.toContain("**Drift");
    });

    it("files only a new drift finding", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([notPlanned({ drift: [DRIFT] })]);

      expect(await refreshFollowUpIssue(opts({ drift: [DRIFT, NEW_DRIFT] }))).toBe("filed");

      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain(findingFingerprint(NEW_DRIFT));
      expect(body).not.toContain(findingFingerprint(DRIFT));
      expect(body).not.toContain("**Unaccepted gaps:**");
    });

    it("files only a new audit finding", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([notPlanned({ audit: audit([AUDIT_F]) })]);

      expect(await refreshFollowUpIssue(opts({ audit: audit([AUDIT_F, AUDIT_G]) }))).toBe("filed");

      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("`b.sh:7`");
      expect(body).not.toContain("`a.sh:5`");
    });

    it("unions every not-planned issue", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([
        notPlanned({ gaps: [], drift: [NEW_DRIFT] }, "clw_np2"),
        notPlanned({ drift: [DRIFT] }, "clw_np1"),
      ]);

      expect(await refreshFollowUpIssue(opts({ drift: [DRIFT, NEW_DRIFT] }))).toBe("skipped-not-planned");
      expect(mockLog.info).toHaveBeenCalledWith("follow-up issue skipped", expect.objectContaining({ dismissed: 3 }));
    });

    it("still dismisses after a newer completed close", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([notPlanned({ drift: [DRIFT] })]);
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({
        id: "clw_done",
        state_reason: "completed",
        closed_at: "2026-11-08 00:00:00",
        body: "",
      });

      expect(await refreshFollowUpIssue(opts({ drift: [DRIFT] }))).toBe("skipped-not-planned");

      const gaps = [{ text: "No DB query durations.", accepted: false }, { text: "No traces.", accepted: false }];
      expect(await refreshFollowUpIssue(opts({ gaps, drift: [DRIFT] }))).toBe("filed");
      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("- No traces.");
      expect(body).not.toContain("No DB query durations.");
    });

    it("rewrites an open issue without the dismissed items", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([notPlanned({ gaps: [], drift: [DRIFT] })]);
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: "old" });

      expect(await refreshFollowUpIssue(opts({ drift: [DRIFT] }))).toBe("updated");

      expect(mockClawsIssues.editIssue.mock.calls[0]![1]).not.toContain(findingFingerprint(DRIFT));
    });
  });

  it("re-files after a close as completed while items remain", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({
      id: "clw_closed",
      state_reason: "completed",
      closed_at: "2026-11-01 00:00:00",
    });

    expect(await refreshFollowUpIssue(opts())).toBe("filed");

    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
  });

  describe("stored audit findings after a completed close", () => {
    const F1: DriftFinding = { rule: "observability-audit", key: "a.sh", file: "a.sh", line: 5, message: "skips silently" };
    const F2: DriftFinding = { rule: "observability-audit", key: "b.sh", file: "b.sh", line: 7, message: "other" };
    const audit = (findings: DriftFinding[]) => ({ findings, auditedAt: "2026-11-05T00:00:00.000Z", sha: "aaa111" });
    const completed = { id: "clw_closed", state_reason: "completed", body: "- `a.sh:5`: skips silently" };

    it("drops the listed finding and files nothing when none remain", async () => {
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(completed);

      expect(await refreshFollowUpIssue(opts({ gaps: [], audit: audit([F1]), headSha: "bbb222" }))).toBe("none");

      expect(mockClawsIssues.findRecentlyClosedIssueByDedupeKey).toHaveBeenCalledWith(REPO, KEY, new Date("2026-11-05T00:00:00.000Z"));
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("still files a finding the closed issue did not list", async () => {
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(completed);

      expect(await refreshFollowUpIssue(opts({ gaps: [], audit: audit([F1, F2]), headSha: "bbb222" }))).toBe("filed");

      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("`b.sh:7`");
      expect(body).not.toContain("`a.sh:5`");
    });

    it("re-files as before when the head has not moved", async () => {
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(completed);

      expect(await refreshFollowUpIssue(opts({ gaps: [], audit: audit([F1]), headSha: "aaa111" }))).toBe("filed");
    });

    it("re-files as before when the head is unknown", async () => {
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(completed);

      expect(await refreshFollowUpIssue(opts({ gaps: [], audit: audit([F1]), headSha: null }))).toBe("filed");
    });

    it("still skips a finding a not-planned close listed", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([
        { id: "c", state_reason: "not_planned", body: formatFollowUpBody(opts({ gaps: [], audit: audit([F1]) })) },
      ]);

      expect(await refreshFollowUpIssue(opts({ gaps: [], audit: audit([F1]), headSha: "bbb222" }))).toBe("skipped-not-planned");
    });

    it("does not rewrite an open issue to re-add a dropped finding", async () => {
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(completed);
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: "x" });

      await refreshFollowUpIssue(opts({ audit: audit([F1]), headSha: "bbb222" }));

      expect(mockClawsIssues.editIssue.mock.calls[0]![1]).not.toContain("a.sh:5");
    });
  });

  const AUDIT = {
    findings: [{ rule: "audit", key: "src/db.ts", file: "src/db.ts", line: 40, message: "No duration." }],
    auditedAt: "2026-11-05T03:00:00.000Z",
    sha: "0123456789abcdef0123",
  };

  it("skips when a completed close is newer than the audit and only audit findings remain", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({
      id: "clw_closed",
      state_reason: "completed",
      closed_at: "2026-11-07 10:00:00",
    });

    expect(await refreshFollowUpIssue(opts({ gaps: [], audit: AUDIT }))).toBe("skipped-audit-superseded");

    expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
  });

  it("files without the audit section when drift remains after a superseding close", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({
      id: "clw_closed",
      state_reason: "completed",
      closed_at: "2026-11-07 10:00:00",
    });

    expect(await refreshFollowUpIssue(opts({ gaps: [], drift: [DRIFT], audit: AUDIT }))).toBe("filed");

    expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
    expect(mockClawsIssues.createIssue.mock.calls[0]![0].body).not.toContain("**Audit findings**");
  });

  it("keeps the audit section when the completed close predates the audit", async () => {
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({
      id: "clw_closed",
      state_reason: "completed",
      closed_at: "2026-11-04 10:00:00",
    });

    expect(await refreshFollowUpIssue(opts({ gaps: [], audit: AUDIT }))).toBe("filed");

    expect(mockClawsIssues.createIssue.mock.calls[0]![0].body).toContain("**Audit findings**");
  });
});

describe("dismissedItems", () => {
  it("reads gap texts and finding ids from every body", () => {
    const a = "**Unaccepted gaps:**\n\n- First  gap.\n- Second gap. (deferral lapsed)\n\n**Drift:**\n\n- x (rule `r`, finding `1a2b3c4d`)";
    const b = "Intro\n\n- Not a gap.\n\n- `a.sh:5`: y (rule `r`, finding `deadbeef`)";
    const d = dismissedItems([a, b]);
    expect([...d.gaps]).toEqual(["First gap.", "Second gap."]);
    expect([...d.findings].sort()).toEqual(["1a2b3c4d", "deadbeef"]);
  });

  it("is empty for an empty body", () => {
    const d = dismissedItems([""]);
    expect(d.gaps.size + d.findings.size).toBe(0);
  });
});

describe("auditSupersededByClose", () => {
  const audit = { findings: [], auditedAt: "2026-11-05T03:00:00.000Z", sha: "abc" };

  it("parses the zone-less space-separated timestamp as UTC", () => {
    expect(auditSupersededByClose({ state_reason: "completed", closed_at: "2026-11-05 03:00:00" }, audit)).toBe(true);
    expect(auditSupersededByClose({ state_reason: "completed", closed_at: "2026-11-05 02:59:59" }, audit)).toBe(false);
  });

  it("is false for not_planned, null or unparseable closes", () => {
    expect(auditSupersededByClose({ state_reason: "not_planned", closed_at: "2026-11-07 00:00:00" }, audit)).toBe(false);
    expect(auditSupersededByClose({ state_reason: "completed", closed_at: null }, audit)).toBe(false);
    expect(auditSupersededByClose({ state_reason: "completed", closed_at: "garbage" }, audit)).toBe(false);
  });
});

describe("dated contract rules", () => {
  const NOW = new Date("2026-11-10T12:00:00.000Z");
  const FRESH: BackfillRule = { id: "fresh-rule", label: "Fresh rule", added: "2026-11-08" };
  const OLD: BackfillRule = { id: "old-rule", label: "Old rule", added: "2026-11-03" };

  describe("isBackfillOnly", () => {
    it("is true only for a non-empty list of dated rules", () => {
      expect(isBackfillOnly([])).toBe(false);
      expect(isBackfillOnly([FRESH, OLD])).toBe(true);
      const undated: { id: string; label: string; added?: string } = { id: "undated", label: "u" };
      expect(isBackfillOnly([FRESH, undated])).toBe(false);
    });
  });

  describe("backfillSettled", () => {
    it("needs every rule at least RULE_SETTLE_DAYS UTC days old", () => {
      expect(RULE_SETTLE_DAYS).toBe(7);
      expect(backfillSettled([OLD], NOW)).toBe(true);
      expect(backfillSettled([{ ...OLD, added: "2026-11-04" }], NOW)).toBe(false);
      expect(backfillSettled([OLD, FRESH], NOW)).toBe(false);
      expect(backfillSettled([OLD], new Date("2026-11-10T00:00:00.000Z"))).toBe(true);
    });
  });

  describe("formatFollowUpBody", () => {
    it("lists new rules in their own section with an edit ask", () => {
      const body = formatFollowUpBody(opts({ gaps: [], newRules: [FRESH] }));
      expect(body).toContain("`AGENTS.md` declares this repo's observability policy, but it does not yet meet 1");
      expect(body).toContain("**Contract rules added since this policy was declared:**\n\n- Fresh rule (`fresh-rule`, added 2026-11-08)");
      expect(body).toContain("Add each contract rule above to `AGENTS.md` as an edit, not a rewrite, and check what you write against the code");
      expect(body).not.toContain("**Unaccepted gaps:**");
    });

    it("omits the section when there are no new rules", () => {
      expect(formatFollowUpBody(opts())).not.toContain("Contract rules added since");
    });
  });

  describe("refreshFollowUpIssue", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([]);
      mockClawsIssues.createIssue.mockResolvedValue("clw_new");
    });

    it("adds unsettled rules to an open issue straight away", async () => {
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: "old" });

      expect(await refreshFollowUpIssue(opts({ gaps: [], newRules: [FRESH], now: NOW }))).toBe("updated");

      expect(mockClawsIssues.editIssue.mock.calls[0]![1]).toContain("- Fresh rule (`fresh-rule`, added 2026-11-08)");
    });

    it("holds a follow-up for unsettled rules alone", async () => {
      expect(await refreshFollowUpIssue(opts({ gaps: [], newRules: [FRESH, OLD], now: NOW }))).toBe("held-new-rules");

      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        "follow-up issue held",
        expect.objectContaining({ reason: "new_rules_settling", rules: ["fresh-rule", "old-rule"], new_rules: 2 }),
      );
    });

    it("files for settled rules alone", async () => {
      expect(await refreshFollowUpIssue(opts({ gaps: [], newRules: [OLD], now: NOW }))).toBe("filed");

      expect(mockClawsIssues.createIssue.mock.calls[0]![0].body).toContain("- Old rule (`old-rule`, added 2026-11-03)");
      expect(mockLog.info).toHaveBeenCalledWith("follow-up issue filed", expect.objectContaining({ new_rules: 1 }));
    });

    it("files with gaps while rules are unsettled, listing the rules too", async () => {
      expect(await refreshFollowUpIssue(opts({ newRules: [FRESH], now: NOW }))).toBe("filed");

      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("- No DB query durations.");
      expect(body).toContain("- Fresh rule (`fresh-rule`, added 2026-11-08)");
    });

    const notPlanned = () => [
      { id: "clw_closed", state_reason: "not_planned", body: formatFollowUpBody(opts({ drift: [DRIFT] })) },
    ];

    it("skips after a not-planned close while rules are unsettled", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue(notPlanned());

      expect(await refreshFollowUpIssue(opts({ newRules: [FRESH], now: NOW }))).toBe("skipped-not-planned");

      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("files the settled rules alongside dismissed items, listing only the rules", async () => {
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue(notPlanned());

      expect(await refreshFollowUpIssue(opts({ drift: [DRIFT], newRules: [OLD], now: NOW }))).toBe("filed");

      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("- Old rule (`old-rule`, added 2026-11-03)");
      expect(body).not.toContain("No DB query durations.");
      expect(body).not.toContain("**Drift");
    });
  });

  describe("logBackfillSummary", () => {
    it("logs one line per dated rule with the failing repos", () => {
      vi.clearAllMocks();
      logBackfillSummary(
        "security-contract-scanner",
        "security",
        new Map([
          ["o/b", [FRESH, OLD]],
          ["o/a", [FRESH]],
        ]),
        NOW,
      );

      expect(mockLog.info).toHaveBeenCalledTimes(2);
      expect(mockLog.info).toHaveBeenCalledWith("contract rule backfill", {
        component: "security-contract-scanner",
        contract: "security",
        rule: "fresh-rule",
        added: "2026-11-08",
        settled: false,
        failing: 2,
        repos: ["o/a", "o/b"],
      });
      expect(mockLog.info).toHaveBeenCalledWith("contract rule backfill", expect.objectContaining({ rule: "old-rule", settled: true, failing: 1 }));
    });
  });
});

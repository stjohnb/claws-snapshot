import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockRepo } from "../test-helpers.js";

const { mockConfig, mockLog, mockReportError, mockFs, mockClaude, mockDb } = vi.hoisted(() => ({
  mockConfig: { isJobDisabledForRepo: vi.fn() },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockReportError: vi.fn(),
  mockFs: { existsSync: vi.fn(), readFileSync: vi.fn() },
  mockClaude: {
    repoDir: vi.fn(() => "/repos/test-org/test-repo"),
    git: vi.fn(),
    getHeadSha: vi.fn(),
    randomSuffix: vi.fn(() => "abc"),
    withNewWorktree: vi.fn(),
    runClaude: vi.fn(),
  },
  mockDb: {
    getContractAudit: vi.fn(),
    saveContractAudit: vi.fn(),
    withTaskRecording: vi.fn(),
    updateTaskWorktree: vi.fn(),
    recordTaskComplete: vi.fn(),
    trackTaskTokens: vi.fn(() => () => {}),
    markRepoProcessedDaily: vi.fn(),
  },
}));

vi.mock("../config.js", () => mockConfig);
vi.mock("../log.js", () => mockLog);
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));
vi.mock("node:fs", () => ({ default: mockFs }));
vi.mock("../claude.js", () => mockClaude);
vi.mock("../db.js", () => mockDb);
vi.mock("../smart-schedule.js", () => ({
  withDailyRepoMarking: async (_job: string, _repo: string, fn: () => Promise<unknown>, onError?: (err: unknown) => unknown) => {
    try {
      return await fn();
    } catch (err) {
      if (!onError) throw err;
      return onError(err);
    }
  },
}));

import { AUDIT_INTERVAL_MS, firstAuditWeekday, isAuditDue, processRepo } from "./contract-audit.js";
import { KNOWN_GAPS_HEADING, NO_TELEMETRY_SENTENCE } from "../observability-contract.js";

const POLICY = [
  "# Observability",
  "",
  "### What every change adds",
  "",
  "- a new HTTP route: its access log line.",
  "",
  KNOWN_GAPS_HEADING,
  "",
  "- Accepted: `src/legacy.ts` predates the logger.",
  "",
].join("\n");

const repo = mockRepo();
const DAY = 24 * 60 * 60 * 1000;

function withPolicy(text: string | null): void {
  mockFs.existsSync.mockImplementation((p: string) => p === "/repos/test-org/test-repo" || (text !== null && p.endsWith("/docs/observability.md")));
  mockFs.readFileSync.mockImplementation((p: string) => {
    if (text !== null && p.endsWith("/docs/observability.md")) return text;
    throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
  });
}

function stored(daysAgo: number, headSha = "oldsha", findings: unknown[] = [{ rule: "observability-audit", key: "a.ts", message: "old" }]) {
  return {
    contract: "observability",
    repo: repo.fullName,
    headSha,
    auditedAt: new Date(Date.now() - daysAgo * DAY).toISOString(),
    findings,
  };
}

/** A local noon on the given weekday (1 = Monday) in the week of 2026-11-02, a Monday. */
function weekday(day: number): Date {
  return new Date(2026, 10, 1 + day, 12, 0, 0);
}

function finishedLog(contract = "observability"): Record<string, unknown> | undefined {
  const call = mockLog.info.mock.calls.find((c) => c[0] === "contract audit finished" && (c[1] as { contract: string }).contract === contract);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe("contract-audit", () => {
  let ancestor: boolean;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(weekday(3));
    ancestor = true;
    mockConfig.isJobDisabledForRepo.mockReturnValue(false);
    withPolicy(POLICY);
    mockDb.getContractAudit.mockResolvedValue(stored(8));
    mockDb.withTaskRecording.mockImplementation((_j: string, _r: string, _i: number, _t: null, fn: (id: number) => unknown) => fn(7));
    mockClaude.withNewWorktree.mockImplementation((_r: unknown, _b: string, _n: string, fn: (wt: string) => unknown) => fn("/wt"));
    mockClaude.getHeadSha.mockResolvedValue("newsha");
    mockClaude.git.mockImplementation(async (args: string[]) => {
      if (args[0] === "rev-parse") return "newsha";
      if (args[0] === "merge-base") {
        if (!ancestor) throw new Error("not an ancestor");
        return "";
      }
      if (args[0] === "log") return "commit newsha\n src/server.ts | 4 ++++";
      return "";
    });
    mockClaude.runClaude.mockResolvedValue(
      'Done.\n```json\n{"findings":[{"file":"./src/server.ts","line":42,"claim":"every route logs an access line","evidence":"GET /x logs nothing"}]}\n```',
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes the worktree's valid scanner exceptions to the prompt", async () => {
    const exceptions = [
      "exceptions:",
      "  - contract: observability",
      "    rule: named-path-missing",
      "    keys: [dist/main.js]",
      "    reason: Gitignored build output, untracked.",
      "  - contract: observability",
      "    rule: observability-audit",
      "    keys: [src/a.ts]",
      "    reason: Missing its finding id here.",
    ].join("\n");
    mockFs.readFileSync.mockImplementation((p: string) => {
      if (p.endsWith("/docs/observability.md")) return POLICY;
      if (p === "/wt/.claws/contract-exceptions.yaml") return exceptions;
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    });

    await processRepo(repo);

    const prompt = mockClaude.runClaude.mock.calls[0]![0] as string;
    expect(prompt).toContain("<exceptions>\n- rule `named-path-missing`, keys `dist/main.js`: Gitignored build output, untracked.\n</exceptions>");
  });

  it("audits a due repo whose HEAD moved and saves the findings shape", async () => {
    await processRepo(repo);

    expect(mockClaude.git).toHaveBeenCalledWith(["log", "--stat", "oldsha..HEAD"], "/wt");
    const [prompt, cwd, opts] = mockClaude.runClaude.mock.calls[0]!;
    expect(cwd).toBe("/wt");
    expect(opts).toMatchObject({ tier: "sonnet", agent: "plan" });
    expect(prompt).toContain("`git log --stat oldsha..HEAD`");
    expect(prompt).toContain("Accepted: `src/legacy.ts` predates the logger.");
    expect(prompt).toContain("What every change adds");
    expect(prompt).toContain("$CLAWS_FORGEJO_READ_TOKEN");
    expect(mockDb.withTaskRecording).toHaveBeenCalledWith("contract-audit", repo.fullName, 0, null, expect.any(Function));
    expect(mockDb.trackTaskTokens).toHaveBeenCalledWith(7);
    expect(mockDb.saveContractAudit).toHaveBeenCalledWith("observability", repo.fullName, "newsha", expect.any(String), [
      {
        rule: "observability-audit",
        key: "src/server.ts",
        file: "src/server.ts",
        line: 42,
        message: "The policy says every route logs an access line; the code shows GET /x logs nothing.",
      },
    ]);
    expect(finishedLog()).toMatchObject({ repo: repo.fullName, contract: "observability", outcome: "audited", findings: 1 });
  });

  it("skips a repo audited less than 7 days ago", async () => {
    mockDb.getContractAudit.mockResolvedValue(stored(6));

    await processRepo(repo);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(mockDb.saveContractAudit).not.toHaveBeenCalled();
    expect(finishedLog()).toMatchObject({ outcome: "skipped-not-due" });
  });

  it("skips a due repo whose HEAD has not moved", async () => {
    mockDb.getContractAudit.mockResolvedValue(stored(9, "newsha"));

    await processRepo(repo);

    expect(mockClaude.git).toHaveBeenCalledWith(["rev-parse", `origin/${repo.defaultBranch}`], "/repos/test-org/test-repo");
    expect(mockClaude.withNewWorktree).not.toHaveBeenCalled();
    expect(finishedLog()).toMatchObject({ outcome: "skipped-unchanged" });
  });

  it("staggers a first audit onto the repo's own weekday and reads the last 50 commits", async () => {
    mockDb.getContractAudit.mockResolvedValue(null);
    const bucket = firstAuditWeekday(repo.fullName);
    vi.setSystemTime(weekday(bucket === 1 ? 2 : 1));

    await processRepo(repo);
    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(finishedLog()).toMatchObject({ outcome: "skipped-not-due" });

    vi.setSystemTime(weekday(bucket));
    await processRepo(repo);
    expect(mockClaude.git).toHaveBeenCalledWith(["log", "--stat", "-50"], "/wt");
    expect(mockClaude.runClaude.mock.calls[0]![0]).toContain("this is the repo's first audit");
    expect(mockDb.saveContractAudit).toHaveBeenCalledTimes(1);
  });

  it("falls back to the last 50 commits when the stored SHA left the history", async () => {
    ancestor = false;

    await processRepo(repo);

    expect(mockClaude.git).toHaveBeenCalledWith(["log", "--stat", "-50"], "/wt");
  });

  it("skips a repo whose contract scanner is disabled", async () => {
    mockConfig.isJobDisabledForRepo.mockImplementation((job: string) => job === "observability-contract-scanner");

    await processRepo(repo);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    expect(finishedLog()).toMatchObject({ outcome: "skipped-disabled" });
  });

  it("skips a repo with no policy or a no-telemetry policy", async () => {
    withPolicy(null);
    await processRepo(repo);
    withPolicy(`# Observability\n\n${NO_TELEMETRY_SENTENCE}\n`);
    await processRepo(repo);

    expect(mockClaude.runClaude).not.toHaveBeenCalled();
    const outcomes = mockLog.info.mock.calls.filter((c) => c[0] === "contract audit finished" && (c[1] as { contract: string }).contract === "observability").map((c) => (c[1] as { outcome: string }).outcome);
    expect(outcomes).toEqual(["skipped-no-policy", "skipped-no-policy"]);
  });

  it("reports a parse failure and keeps the previous findings", async () => {
    mockClaude.runClaude.mockResolvedValue("I looked around and everything seems fine.");

    await processRepo(repo);

    expect(mockDb.saveContractAudit).not.toHaveBeenCalled();
    expect(mockDb.recordTaskComplete).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith("contract-audit:process-repo", repo.fullName, expect.any(Error), { repo: repo.fullName });
    expect(finishedLog()).toMatchObject({ outcome: "error", findings: 0 });
  });

  describe("security audit", () => {
    const SECURITY_POLICY = "## Security\n\n### Secrets\n\nSecrets come from SOPS.\n\n### Known gaps\n\nNone.\n";

    function withBothPolicies(): void {
      mockFs.existsSync.mockImplementation(
        (p: string) => p === "/repos/test-org/test-repo" || p.endsWith("/docs/observability.md") || p.endsWith("/docs/security.md"),
      );
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (p.endsWith("/docs/observability.md")) return POLICY;
        if (p.endsWith("/docs/security.md")) return SECURITY_POLICY;
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
      });
    }

    function storedByContract(obsDaysAgo: number | null, secDaysAgo: number | null): void {
      mockDb.getContractAudit.mockImplementation(async (contract: string) => {
        const days = contract === "observability" ? obsDaysAgo : secDaysAgo;
        return days === null ? null : { ...stored(days), contract };
      });
    }

    it("offsets a never-audited security audit two weekdays after the observability one", () => {
      for (const r of ["o/a", "o/b", "o/c", "o/d"]) {
        const obs = firstAuditWeekday(r);
        const sec = firstAuditWeekday(r, 2);
        expect(sec).toBe(1 + ((obs - 1 + 2) % 5));
        expect(sec).not.toBe(obs);
        expect(isAuditDue(r, null, weekday(sec), 2)).toBe(true);
      }
    });

    it("runs one agent audit per call, the contract audited longest ago first, and defers the other", async () => {
      withBothPolicies();
      storedByContract(8, 12);

      await processRepo(repo);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(1);
      expect(mockClaude.runClaude.mock.calls[0]![0]).toContain("declared security policy");
      expect(mockDb.saveContractAudit).toHaveBeenCalledTimes(1);
      expect(mockDb.saveContractAudit.mock.calls[0]![0]).toBe("security");
      expect(finishedLog("security")).toMatchObject({ outcome: "audited" });
      expect(finishedLog("observability")).toMatchObject({ outcome: "skipped-deferred" });
    });

    it("still audits the other contract when the first one fails", async () => {
      withBothPolicies();
      storedByContract(8, 12);
      mockClaude.runClaude.mockResolvedValueOnce("no findings here");

      await processRepo(repo);

      expect(mockClaude.runClaude).toHaveBeenCalledTimes(2);
      expect(finishedLog("security")).toMatchObject({ outcome: "error" });
      expect(finishedLog("observability")).toMatchObject({ outcome: "audited" });
    });

    it("runs a never-audited contract before an audited one", async () => {
      withBothPolicies();
      storedByContract(8, null);
      vi.setSystemTime(weekday(firstAuditWeekday(repo.fullName, 2)));

      await processRepo(repo);

      expect(mockDb.saveContractAudit.mock.calls[0]![0]).toBe("security");
      expect(finishedLog("observability")).toMatchObject({ outcome: "skipped-deferred" });
    });

    it("does not audit a security policy that still has a placeholder", async () => {
      withBothPolicies();
      mockFs.readFileSync.mockImplementation((p: string) => {
        if (p.endsWith("/docs/observability.md")) return POLICY;
        if (p.endsWith("/docs/security.md")) return `${SECURITY_POLICY}\nTODO(security): fill in\n`;
        throw new Error("ENOENT");
      });
      storedByContract(8, 8);

      await processRepo(repo);

      expect(finishedLog("security")).toMatchObject({ outcome: "skipped-no-policy" });
      expect(finishedLog("observability")).toMatchObject({ outcome: "audited" });
    });
  });

  it("isAuditDue: due after 7 days, and on a first audit only on the repo's weekday", () => {
    const now = weekday(3);
    expect(isAuditDue("o/r", new Date(now.getTime() - AUDIT_INTERVAL_MS).toISOString(), now)).toBe(true);
    expect(isAuditDue("o/r", new Date(now.getTime() - AUDIT_INTERVAL_MS + 60_000).toISOString(), now)).toBe(false);
    const bucket = firstAuditWeekday("o/r");
    expect(bucket).toBeGreaterThanOrEqual(1);
    expect(bucket).toBeLessThanOrEqual(5);
    expect(isAuditDue("o/r", null, weekday(bucket))).toBe(true);
    expect(isAuditDue("o/r", null, weekday(bucket === 5 ? 4 : bucket + 1))).toBe(false);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  SELF_REPO: "St-John-Software/claws",
}));

const { mockLog, mockReportError, mockGh, mockClaude, mockClawsIssues, mockDb } = vi.hoisted(() => ({
  mockDb: { saveContractStatus: vi.fn(), getContractAudit: vi.fn() },
  mockLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockReportError: vi.fn(),
  mockGh: {
    findIssueByExactTitle: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
    editIssueTitle: vi.fn(),
    addLabel: vi.fn(),
  },
  mockClaude: {
    ensureClone: vi.fn(),
    repoDir: vi.fn(),
    git: vi.fn(),
  },
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    findOpenIssueByDedupeKey: vi.fn(),
    findRecentlyClosedIssueByDedupeKey: vi.fn(),
    listNotPlannedIssuesByDedupeKey: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
  },
}));

vi.mock("../log.js", () => mockLog);
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../claws-issues.js", () => mockClawsIssues);
vi.mock("../db.js", () => mockDb);

import { ISSUE_TITLE, KNOWN_GAPS_DEDUPE_KEY, run, scan } from "./security-contract-scanner.js";
import { SECURITY_CONTRACT_MARKDOWN, SECURITY_GUIDANCE, SECURITY_RULES, type SecurityRule } from "../security-contract.js";
import { findingFingerprint } from "../contract-drift.js";

const label = (id: string): string => SECURITY_RULES.find((r) => r.id === id)!.label;

const SECTIONS: Record<string, string> = {
  Scope: "This repo ships configuration only; nothing runs or is exposed.",
  "Dependency and image vulnerabilities": "Renovate opens dependency PRs. This repo publishes no container image.",
  "Accepted findings": "None: there is no scanned artefact, so there are no findings to accept.",
  Secrets: "No secret, token or credential is committed or needed.",
  "Supply chain": "Versions are pinned and Renovate keeps them fresh.",
  "Exposure and authentication": "Nothing is reachable from a public network.",
  "Known gaps": "None.",
};

function policy(overrides: Record<string, string | null> = {}): string {
  const parts = ["## Security", ""];
  for (const [heading, body] of Object.entries({ ...SECTIONS, ...overrides })) {
    if (body === null) continue;
    parts.push(`### ${heading}`, "", body, "");
  }
  return parts.join("\n");
}

let repoDir: string;

function writeRepo(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repoDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, rel), content);
  }
}

function filedBody(): string {
  expect(mockGh.createIssue).toHaveBeenCalledTimes(1);
  expect(mockGh.createIssue.mock.calls[0]![1]).toBe(ISSUE_TITLE);
  return mockGh.createIssue.mock.calls[0]![2] as string;
}

describe("security-contract-scanner", () => {
  const repo = mockRepo();

  beforeEach(() => {
    vi.clearAllMocks();
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "security-scanner-"));
    mockClaude.repoDir.mockReturnValue(repoDir);
    mockClaude.ensureClone.mockResolvedValue(repoDir);
    mockClaude.git.mockResolvedValue("");
    mockDb.getContractAudit.mockResolvedValue(null);
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([]);
    mockClawsIssues.createIssue.mockResolvedValue("clw_new");
    mockDb.saveContractStatus.mockResolvedValue(undefined);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  describe("declare pass", () => {
    it("flags a repo with no policy and embeds the starter template", async () => {
      writeRepo({ "README.md": "# Repo\n" });

      await run([repo]);

      const body = filedBody();
      expect(body).toContain("- No `docs/security.md` and no `AGENTS.md`");
      for (const rule of SECURITY_RULES) expect(body).toContain(`- ${rule.label}`);
      expect(body).toContain(`\`\`\`\`markdown\n${SECURITY_CONTRACT_MARKDOWN}\n\`\`\`\``);
      expect(body).toContain("docs/security-contract.md");
      expect(body).toContain("`security-contract-scanner` job-disable config");
      expect(body).toContain(SECURITY_GUIDANCE["config-only"][0]);
    });

    it("names an AGENTS.md with no Security section", async () => {
      writeRepo({ "AGENTS.md": "# Repo\n\n## Build\n\nnpm test\n" });

      await run([repo]);

      expect(filedBody()).toContain("- `AGENTS.md` exists but has no `## Security` section");
    });

    it("names only the Supply chain subsection when it alone is missing", async () => {
      writeRepo({ "AGENTS.md": `# Repo\n\n${policy({ "Supply chain": null })}` });

      await run([repo]);

      const body = filedBody();
      expect(body).toContain("- `AGENTS.md` has a security policy, but it is incomplete");
      expect(body).toContain(`- ${label("supply-chain")}`);
      for (const rule of SECURITY_RULES.filter((r) => r.id !== "supply-chain")) {
        expect(body).not.toContain(`- ${rule.label}`);
      }
      expect(body).toContain("**Check the policy against the code.**");
    });

    it("flags a policy missing Known gaps", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": null }) });

      await run([repo]);

      const body = filedBody();
      expect(body).toContain(`- ${label("known-gaps")}`);
      expect(body).not.toContain(`- ${label("scope")}`);
    });

    it("passes a complete config-only policy", async () => {
      writeRepo({ "docs/security.md": policy() });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(scan(repoDir)).toBeNull();
    });

    it("gives a Dockerfile repo the container guidance", async () => {
      writeRepo({ Dockerfile: "FROM node:22\n" });

      await run([repo]);

      const body = filedBody();
      expect(body).toContain("container service");
      for (const g of SECURITY_GUIDANCE["container-service"]) expect(body).toContain(`- ${g}`);
    });

    it("flags a leftover placeholder", async () => {
      writeRepo({ "docs/security.md": `${policy()}\nTODO(security): finish this.\n` });

      await run([repo]);

      expect(filedBody()).toContain(`- ${label("no-placeholders")}`);
    });

    it("does not file a second issue while one is open", async () => {
      mockGh.findIssueByExactTitle.mockResolvedValue({ number: 7, labels: [] });

      await run([repo]);

      expect(mockGh.createIssue).not.toHaveBeenCalled();
    });
  });

  describe("known-gaps follow-up", () => {
    const BAD_VEX = JSON.stringify({ "@context": "https://openvex.dev/ns/v0.2.0", statements: [{ status: "affected" }] });

    it("files one native issue listing the unaccepted gaps", async () => {
      writeRepo({
        "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag, not digest.\n- Accepted: no CSP, internal only." }),
      });

      await run([repo]);

      expect(mockClawsIssues.findOpenIssueByDedupeKey).toHaveBeenCalledWith(repo.fullName, KNOWN_GAPS_DEDUPE_KEY);
      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
      const input = mockClawsIssues.createIssue.mock.calls[0]![0];
      expect(input).toMatchObject({
        title: expect.stringMatching(/^security: /),
        repos: [repo.fullName],
        source: "automation",
        dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
      });
      expect(input.body).toContain("`docs/security.md` lists 1 known security gap(s)");
      expect(input.body).toContain("- Base images are pinned by tag, not digest.");
      expect(input.body).not.toContain("no CSP");
      expect(mockLog.info).toHaveBeenCalledWith("drift check finished", expect.objectContaining({ repo: repo.fullName, gaps: 1, drift: 0 }));
    });

    describe("stored audit findings", () => {
      const storedAudit = (findings: unknown[]) => ({
        contract: "security",
        repo: repo.fullName,
        headSha: "0123456789abcdef0123",
        auditedAt: "2026-11-02T09:30:00.000Z",
        findings,
      });
      const finding = { rule: "security-audit", key: ".forgejo/workflows/ci.yml", file: ".forgejo/workflows/ci.yml", line: 9, message: "The policy says CI installs from the lockfile; the code shows npm install." };

      it("adds them to the follow-up body", async () => {
        writeRepo({ "docs/security.md": policy() });
        mockDb.getContractAudit.mockResolvedValue(storedAudit([finding]));

        await run([repo]);

        expect(mockDb.getContractAudit).toHaveBeenCalledWith("security", repo.fullName);
        const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
        expect(body).toContain("**Audit findings** (agent audit of 2026-11-02 at `0123456789ab`):");
        expect(body).toContain("- `.forgejo/workflows/ci.yml:9`: The policy says CI installs from the lockfile");
        expect(mockLog.info).toHaveBeenCalledWith("drift check finished", expect.objectContaining({ audit: 1, audit_stale: 0 }));
      });

      it("drops a finding whose file changed since the audited SHA", async () => {
        writeRepo({ "docs/security.md": policy() });
        mockDb.getContractAudit.mockResolvedValue(storedAudit([finding]));
        mockClaude.git.mockResolvedValue(".forgejo/workflows/ci.yml\n");

        await run([repo]);

        expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
        expect(mockLog.info).toHaveBeenCalledWith("drift check finished", expect.objectContaining({ audit: 0, audit_stale: 1 }));
      });

      it("drops a finding a Known gaps item lists by file and finding id, not by file alone", async () => {
        writeRepo({ "docs/security.md": policy({ "Known gaps": "- Accepted: `.forgejo/workflows/ci.yml` installs without a lockfile." }) });
        mockDb.getContractAudit.mockResolvedValue(storedAudit([finding]));
        await run([repo]);
        expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
        mockClawsIssues.createIssue.mockClear();

        const gap = `- Accepted: \`.forgejo/workflows/ci.yml\` installs without a lockfile (finding \`${findingFingerprint(finding)}\`).`;
        writeRepo({ "docs/security.md": policy({ "Known gaps": gap }) });
        mockDb.getContractAudit.mockResolvedValue(storedAudit([finding]));

        await run([repo]);

        expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      });
    });

    it("files the issue on drift alone", async () => {
      writeRepo({ "docs/security.md": policy(), ".vex/CVE-1.json": BAD_VEX });

      await run([repo]);

      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("**Drift: the policy says X, the code shows Y:**");
      expect(body).toMatch(/- `\.vex\/CVE-1\.json`: .* \(rule `vex`, finding `[0-9a-f]{8}`\)\n/);
      expect(body).not.toContain("**Unaccepted gaps:**");
      expect(body).toContain("  - Fix the code, or correct the policy so it matches the code.");
      expect(body).toContain("add an entry to `.claws/contract-exceptions.yaml`");
      expect(mockLog.info).toHaveBeenCalledWith(
        "drift check finished",
        expect.objectContaining({ repo: repo.fullName, drift: 1, suppressed: 0, excepted: 0 }),
      );
    });

    it("files nothing when every gap is accepted and there is no drift", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Accepted: no CSP, internal only." }) });

      await run([repo]);

      expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalled();
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("saves the contract status snapshot for each policy state", async () => {
      const snapshot = () => {
        const call = mockDb.saveContractStatus.mock.calls.at(-1)!;
        expect(call[0]).toBe("security");
        expect(call[1]).toBe(repo.fullName);
        return call[3];
      };
      await run([repo]);
      expect(snapshot()).toMatchObject({ policy: { status: "missing", path: null }, gaps: [], drift: [], driftUnavailable: [], audit: null });

      writeRepo({ "docs/security.md": policy({ "Supply chain": null }) });
      await run([repo]);
      expect(snapshot().policy).toEqual({ status: "incomplete", path: "docs/security.md", missingRules: [label("supply-chain")] });

      writeRepo({
        "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag.\n- Accepted: no CSP, internal only." }),
        ".vex/CVE-1.json": BAD_VEX,
      });
      await run([repo]);
      const s = snapshot();
      expect(s.policy).toEqual({ status: "complete", path: "docs/security.md", missingRules: [] });
      expect(s.gaps).toEqual([
        { text: "Base images are pinned by tag.", state: "unaccepted" },
        { text: "Accepted: no CSP, internal only.", state: "accepted" },
      ]);
      expect(s.drift).toHaveLength(1);
      expect(s.audit).toBeNull();
      expect(mockLog.info).toHaveBeenCalledWith("contract status saved", expect.objectContaining({ contract: "security", policy: "complete", unaccepted: 1, accepted: 1, drift: 1 }));
    });

    it("rewrites the open issue's body in place", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag." }) });
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: "old body" });

      await run([repo]);

      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_open", expect.stringContaining("- Base images are pinned by tag."));
    });

    it("skips gaps a keyed issue closed as not planned listed", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag." }) });
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([
        { id: "clw_closed", state_reason: "not_planned", body: "**Unaccepted gaps:**\n\n- Base images are pinned by tag.\n" },
      ]);

      await run([repo]);

      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith("follow-up issue skipped", expect.objectContaining({ reason: "closed_not_planned", dismissed: 1 }));
    });

    it("files a gap that appeared after a not-planned close", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag.\n- No SBOM." }) });
      mockClawsIssues.listNotPlannedIssuesByDedupeKey.mockResolvedValue([
        { id: "clw_closed", state_reason: "not_planned", body: "**Unaccepted gaps:**\n\n- Base images are pinned by tag.\n" },
      ]);

      await run([repo]);

      expect(mockClawsIssues.createIssue).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining("- No SBOM.") }));
      expect(mockClawsIssues.createIssue.mock.calls[0]![0].body).not.toContain("Base images are pinned by tag.");
    });

    it("re-files after a completed close while gaps remain", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag." }) });
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({ id: "clw_closed", state_reason: "completed" });

      await run([repo]);

      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
    });

    it("reports a follow-up failure as security-contract-scanner:known-gaps", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag." }) });
      mockClawsIssues.findOpenIssueByDedupeKey.mockRejectedValue(new Error("db down"));

      await run([repo]);

      expect(mockReportError).toHaveBeenCalledWith(
        "security-contract-scanner:known-gaps",
        repo.fullName,
        expect.any(Error),
        { repo: repo.fullName },
      );
    });
  });

  describe("dated contract rules", () => {
    const DATED: SecurityRule = {
      id: "test-dated-rule",
      label: "Test dated rule",
      heading: null,
      detect: /zz-dated-marker/,
      added: "2000-01-01",
    };
    const rules = SECURITY_RULES as SecurityRule[];
    beforeEach(() => {
      rules.push(DATED);
    });
    afterEach(() => {
      rules.splice(rules.indexOf(DATED), 1);
    });

    it("lists a dated rule an existing policy fails in the follow-up, not a declare issue", async () => {
      writeRepo({ "docs/security.md": policy() });

      await run([repo]);

      expect(scan(repoDir)).toBeNull();
      expect(mockGh.createIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
      const input = mockClawsIssues.createIssue.mock.calls[0]![0];
      expect(input).toMatchObject({ title: "security: policy lacks the test-dated-rule rule", dedupeKey: KNOWN_GAPS_DEDUPE_KEY });
      expect(input.body).toContain("- Test dated rule (`test-dated-rule`, added 2000-01-01)");
      expect(mockLog.info).toHaveBeenCalledWith(
        "contract rule backfill",
        expect.objectContaining({
          component: "security-contract-scanner",
          contract: "security",
          rule: "test-dated-rule",
          settled: true,
          failing: 1,
          repos: [repo.fullName],
        }),
      );
    });

    it("still files the declare issue for a repo with no policy", async () => {
      writeRepo({ "README.md": "# Repo\n" });

      await run([repo]);

      expect(filedBody()).toContain("- Test dated rule");
    });

    it("still files the declare issue when an undated rule fails too", async () => {
      writeRepo({ "docs/security.md": policy({ "Supply chain": null }) });

      await run([repo]);

      const body = filedBody();
      expect(body).toContain(`- ${label("supply-chain")}`);
      expect(body).toContain("- Test dated rule");
    });
  });

  it("keeps the declare title and follow-up dedupe key frozen", () => {
    expect(ISSUE_TITLE).toBe("chore: declare this repo's security policy");
    expect(KNOWN_GAPS_DEDUPE_KEY).toBe("security-known-gaps");
  });

  it("passes Claws' own policy", () => {
    expect(scan(process.cwd())).toBeNull();
  });
});

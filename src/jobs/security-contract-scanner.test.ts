import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockRepo } from "../test-helpers.js";

vi.mock("../config.js", () => ({
  WORK_DIR: "/home/testuser/.claws",
  SELF_REPO: "St-John-Software/claws",
}));

const { mockLog, mockReportError, mockGh, mockClaude, mockClawsIssues } = vi.hoisted(() => ({
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
  },
  mockClawsIssues: {
    CLAWS_NATIVE_LOGIN: "claws",
    findOpenIssueByDedupeKey: vi.fn(),
    findRecentlyClosedIssueByDedupeKey: vi.fn(),
    createIssue: vi.fn(),
    editIssue: vi.fn(),
  },
}));

vi.mock("../log.js", () => mockLog);
vi.mock("../error-reporter.js", () => ({ reportError: mockReportError }));
vi.mock("../github.js", () => mockGh);
vi.mock("../claude.js", () => mockClaude);
vi.mock("../claws-issues.js", () => mockClawsIssues);

import { ISSUE_TITLE, KNOWN_GAPS_DEDUPE_KEY, KNOWN_GAPS_ISSUE_TITLE, run, scan } from "./security-contract-scanner.js";
import { SECURITY_CONTRACT_MARKDOWN, SECURITY_GUIDANCE, SECURITY_RULES } from "../security-contract.js";

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
    mockGh.findIssueByExactTitle.mockResolvedValue(null);
    mockGh.createIssue.mockResolvedValue(1);
    mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue(undefined);
    mockClawsIssues.createIssue.mockResolvedValue("clw_new");
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
        title: KNOWN_GAPS_ISSUE_TITLE,
        repos: [repo.fullName],
        source: "automation",
        dedupeKey: KNOWN_GAPS_DEDUPE_KEY,
      });
      expect(input.body).toContain("`docs/security.md` lists 1 known security gap(s)");
      expect(input.body).toContain("- Base images are pinned by tag, not digest.");
      expect(input.body).not.toContain("no CSP");
      expect(mockLog.info).toHaveBeenCalledWith("drift check finished", expect.objectContaining({ repo: repo.fullName, gaps: 1, drift: 0 }));
    });

    it("files the issue on drift alone", async () => {
      writeRepo({ "docs/security.md": policy(), ".vex/CVE-1.json": BAD_VEX });

      await run([repo]);

      expect(mockClawsIssues.createIssue).toHaveBeenCalledTimes(1);
      const body = mockClawsIssues.createIssue.mock.calls[0]![0].body as string;
      expect(body).toContain("**Drift: the policy says X, the code shows Y:**");
      expect(body).toContain("- `.vex/CVE-1.json`: ");
      expect(body).not.toContain("**Unaccepted gaps:**");
      expect(body).toContain("fix the code, or correct the policy and list the shortfall under `### Known gaps`");
    });

    it("files nothing when every gap is accepted and there is no drift", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Accepted: no CSP, internal only." }) });

      await run([repo]);

      expect(mockClawsIssues.findOpenIssueByDedupeKey).not.toHaveBeenCalled();
      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
    });

    it("rewrites the open issue's body in place", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag." }) });
      mockClawsIssues.findOpenIssueByDedupeKey.mockResolvedValue({ id: "clw_open", body: "old body" });

      await run([repo]);

      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      expect(mockClawsIssues.editIssue).toHaveBeenCalledWith("clw_open", expect.stringContaining("- Base images are pinned by tag."));
    });

    it("skips after the newest keyed issue closed as not planned", async () => {
      writeRepo({ "docs/security.md": policy({ "Known gaps": "- Base images are pinned by tag." }) });
      mockClawsIssues.findRecentlyClosedIssueByDedupeKey.mockResolvedValue({ id: "clw_closed", state_reason: "not_planned" });

      await run([repo]);

      expect(mockClawsIssues.createIssue).not.toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith("follow-up issue skipped", expect.objectContaining({ issue: "clw_closed" }));
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

  it("passes Claws' own policy", () => {
    expect(scan(process.cwd())).toBeNull();
  });
});

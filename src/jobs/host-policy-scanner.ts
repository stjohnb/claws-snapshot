import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import {
  HOST_POLICY_MARKDOWN,
  findHostPolicySection,
  missingHostPolicyRules,
  type HostPolicyRule,
} from "../host-policy.js";
import { renderViolationTable, runRepoScanner, type ScannerSpec } from "./scanner-runner.js";

const NAME = "host-policy-scanner";
const ISSUE_TITLE = "chore: document the automation-host policy for agents";

const CANDIDATE_FILES = ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"];
const RULES_DIR = ".claude/rules";

function listCandidateFiles(repoDir: string): string[] {
  const candidates = [...CANDIDATE_FILES];
  try {
    const rulesDir = path.join(repoDir, RULES_DIR);
    for (const entry of fs.readdirSync(rulesDir)) {
      if (entry.endsWith(".md")) candidates.push(`${RULES_DIR}/${entry}`);
    }
  } catch {
    // No .claude/rules directory — not a scanner failure.
  }
  return candidates;
}

function formatIssueBody(
  inspectedPath: string,
  missing: readonly HostPolicyRule[],
  hasSection: boolean,
): string {
  const intro = [
    "Claws agents run in a git worktree on the shared automation host, which also runs the Claws " +
      "service itself. On 2026-08-26 an agent working on `St-John-Software/perudo#277` freed \"its\" " +
      "port with `lsof -ti:3000 -sTCP:LISTEN | xargs -r kill` and SIGTERM'd the Claws service, which " +
      "stayed down for ~20 minutes. The same agent then ran `sudo apt-get install` for Playwright " +
      "system deps and pulled ~660 MB of browser binaries onto a host already at 80% disk.",
    "",
    hasSection
      ? `Inspected \`${inspectedPath}\` — it is missing the following automation-host policy rules:\n`
      : `No host-policy section found in \`${inspectedPath}\` — all of the following automation-host policy rules are missing:\n`,
  ].join("\n");

  return renderViolationTable({
    intro,
    columns: ["Rule", "Status"],
    rows: [...missing],
    cells: (r) => [r.label, "missing"],
    footer: [
      "Add the following to `CLAUDE.md`:",
      "",
      "```markdown",
      HOST_POLICY_MARKDOWN,
      "```",
      "",
      `If this repo genuinely needs a different policy, turn this check off via the \`${NAME}\` ` +
        "job-disable config for this repo rather than closing the issue — an open issue with the " +
        "exact title above will otherwise be re-filed on the next scan.",
    ],
  });
}

function scan(repoDir: string, _repo: Repo): { body: string; summary?: string } | null {
  const claudeMdPath = path.join(repoDir, "CLAUDE.md");
  if (!fs.existsSync(claudeMdPath)) return null;

  let bestPath: string | null = null;
  let bestMissing: readonly HostPolicyRule[] | null = null;
  let bestHasSection = false;

  for (const relPath of listCandidateFiles(repoDir)) {
    const absPath = path.join(repoDir, relPath);
    if (!fs.existsSync(absPath)) continue;
    const content = fs.readFileSync(absPath, "utf-8");
    const missing = missingHostPolicyRules(content);
    if (missing.length === 0) return null;
    if (bestMissing === null || missing.length < bestMissing.length) {
      bestPath = relPath;
      bestMissing = missing;
      bestHasSection = findHostPolicySection(content) !== null;
    }
  }

  // CLAUDE.md is always a candidate and was confirmed to exist above, so the loop
  // always processes at least one file and bestPath/bestMissing are always set here.
  return {
    body: formatIssueBody(bestPath!, bestMissing!, bestHasSection),
    summary: `${bestMissing!.length} host-policy rule(s) missing`,
  };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  enforcedLabels: [LABELS.automerge],
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}

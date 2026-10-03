import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import * as log from "../log.js";
import { renderViolationTable, runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { hostedRunnerExemptionReason, isGitHubHostedLabel, listWorkflowFiles } from "./workflow-parser.js";

interface Violation {
  file: string;
  line: number;
  value: string;
}

const NAME = "ubuntu-latest-scanner";
const ISSUE_TITLE = "Alert: workflows using GitHub-hosted runners";

// This scanner is file-based (`.github/workflows/*.yml`) and so cannot see *dynamic*
// workflows (Dependabot's updater, CodeQL default setup, etc.) — GitHub generates those from
// a repository/org setting, not a file in the tree, so there is no `runs-on:` line here to
// match. See dynamic-workflow-runner-scanner.ts for that coverage (#2322).
//
// A file carrying a `# claws-allow-github-hosted-runner: <reason>` comment line is skipped
// entirely — an owner-approved exemption for a workflow whose whole purpose requires GitHub's
// own infrastructure (#2845).

function isNonSelfHostedRunner(runsOnValue: string): boolean {
  const trimmed = runsOnValue.trim();
  // Array form: [ubuntu-latest, ...] or [ windows-2022, ... ]
  if (trimmed.startsWith("[")) {
    const inner = trimmed.slice(1).replace(/]$/, "").trim();
    const first = inner.split(",")[0]?.trim();
    return first !== undefined && isGitHubHostedLabel(first);
  }
  // Direct value
  return isGitHubHostedLabel(trimmed);
}

function scanWorkflowFile(content: string, fileName: string): Violation[] {
  const lines = content.split("\n");
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // Skip commented lines
    const stripped = line.trimStart();
    if (stripped.startsWith("#")) continue;

    const match = stripped.match(/^runs-on:\s*(.+)$/);
    if (!match) continue;

    const value = match[1]!.trim();
    if (isNonSelfHostedRunner(value)) {
      violations.push({ file: fileName, line: i + 1, value });
    }
  }

  return violations;
}

function formatIssueBody(violations: Violation[]): string {
  return renderViolationTable({
    intro:
      "The following workflow files use GitHub-hosted runners. All GitHub Actions workflows should use `self-hosted` runners.\n",
    columns: ["File", "Line", "`runs-on` value"],
    rows: violations,
    cells: (v) => [`\`${v.file}\``, String(v.line), `\`${v.value}\``],
    footer: [
      "Please update these workflows to use `runs-on: [self-hosted, linux]` (or `[self-hosted, macos]` for jobs that genuinely require macOS). A bare `runs-on: self-hosted` is not acceptable — always include the OS label.",
      "",
      "If a workflow genuinely must run on GitHub's infrastructure — the rare case where a `[self-hosted, linux]` job could not run at all, such as provisioning a runner while the self-hosted pool is down — add a comment line `# claws-allow-github-hosted-runner: <reason>` anywhere in that workflow file. Claws then skips the whole file. The reason text is required; a bare marker is ignored.",
    ],
  });
}

function scan(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  const wf = listWorkflowFiles(repoDir);
  if (!wf) return null;

  const allViolations: Violation[] = [];
  for (const file of wf.files) {
    const content = fs.readFileSync(path.join(wf.dir, file), "utf-8");
    const exemption = hostedRunnerExemptionReason(content);
    if (exemption !== null) {
      log.info(`[ubuntu-latest-scanner] ${repo.fullName}: ${file} exempt from the GitHub-hosted runner rule — ${exemption}`);
      continue;
    }
    allViolations.push(...scanWorkflowFile(content, file));
  }

  if (allViolations.length === 0) return null;

  return { body: formatIssueBody(allViolations), summary: `Found ${allViolations.length} GitHub-hosted runner violation(s)` };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  label: LABELS.priority,
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}

import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { renderViolationTable, runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { listWorkflowFiles } from "./workflow-parser.js";

interface Violation {
  file: string;
  line: number;
  value: string;
}

const NAME = "ubuntu-latest-scanner";
const ISSUE_TITLE = "Alert: workflows using GitHub-hosted runners";

function isNonSelfHostedRunner(runsOnValue: string): boolean {
  const trimmed = runsOnValue.trim();
  // Array form: [ubuntu-latest, ...] or [ windows-2022, ... ]
  if (trimmed.startsWith("[")) {
    const inner = trimmed.slice(1).replace(/]$/, "").trim();
    const first = inner.split(",")[0]?.trim();
    return (
      first?.startsWith("ubuntu-") === true ||
      first?.startsWith("windows-") === true ||
      first?.startsWith("macos-") === true
    );
  }
  // Direct value
  return (
    trimmed.startsWith("ubuntu-") || trimmed.startsWith("windows-") || trimmed.startsWith("macos-")
  );
}

function scanWorkflowFile(filePath: string): Violation[] {
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const violations: Violation[] = [];
  const fileName = path.basename(filePath);

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
      "Please update these workflows to use `runs-on: self-hosted` (or `runs-on: [self-hosted, ...]`).",
    ],
  });
}

function scan(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  const wf = listWorkflowFiles(repoDir);
  if (!wf) return null;

  const allViolations: Violation[] = [];
  for (const file of wf.files) {
    const violations = scanWorkflowFile(path.join(wf.dir, file));
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) return null;

  return { body: formatIssueBody(allViolations), summary: `Found ${allViolations.length} GitHub-hosted runner violation(s)` };
}

const SPEC: ScannerSpec = {
  name: NAME,
  issueTitle: ISSUE_TITLE,
  searchQuery: ISSUE_TITLE,
  label: LABELS.priority,
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}

import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, RECURRENCE_TRACKING_SNIPPET_LINES, type ScannerSpec } from "./scanner-runner.js";
import { listWorkflowFiles } from "./workflow-parser.js";

interface Violation {
  file: string;
}

const NAME = "issue-comment-spam-scanner";
const ISSUE_TITLE =
  "Alert: workflow comments on recurring failures instead of editing the issue body";

const FIXED_MARKERS = ["**Occurrences:**", "**First seen:**", "gh issue edit"];

function formatIssueBody(violations: Violation[]): string {
  const lines: string[] = [
    "Several workflows in this repo create a new comment on every recurrence of a failure issue, which spams the issue thread. They should instead edit the issue body to bump an Occurrences/Last seen block — see https://github.com/St-John-Software/claws/pull/1246 for context.",
    "",
    "| File |",
    "|------|",
  ];

  for (const v of violations) {
    lines.push(`| \`${v.file}\` |`);
  }

  lines.push(
    "",
    "**Recommended fix:**",
    "",
    "```bash",
    ...RECURRENCE_TRACKING_SNIPPET_LINES,
    "```",
    "",
    'If a recovery/close path uses `gh issue close --comment "..."`, that is fine — only standalone `gh issue comment` on recurrence is the problem.',
  );

  return lines.join("\n");
}

function scan(repoDir: string, _repo: Repo): { body: string; summary?: string } | null {
  const wf = listWorkflowFiles(repoDir);
  if (!wf) return null;

  const violations: Violation[] = [];

  for (const file of wf.files) {
    const content = fs.readFileSync(path.join(wf.dir, file), "utf-8");
    if (FIXED_MARKERS.some((marker) => content.includes(marker))) continue;
    if (content.includes("gh issue create") && content.includes("gh issue comment")) {
      violations.push({ file });
    }
  }

  if (violations.length === 0) return null;

  return {
    body: formatIssueBody(violations),
    summary: `Found ${violations.length} workflow(s) with comment-spam pattern`,
  };
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

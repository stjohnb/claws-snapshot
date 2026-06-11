import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
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
    "          # On recurrence: edit issue body to bump Occurrences/Last seen instead of commenting.",
    "          set -euo pipefail",
    "          TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    '          TITLE="Build failure: ${WORKFLOW_NAME}"',
    "          existing=$(gh issue list --repo \"$REPO\" --state open \\",
    "            --search \"\\\"${TITLE}\\\" in:title\" --json number --jq '.[0].number // empty')",
    "          if [ -n \"$existing\" ]; then",
    "            body=$(gh issue view \"$existing\" --repo \"$REPO\" --json body --jq .body)",
    "            if printf '%s' \"$body\" | grep -q '^\\*\\*First seen:\\*\\*'; then",
    "              new_body=$(printf '%s' \"$body\" | awk -v ts=\"$TS\" '",
    "                /^\\*\\*Last seen:\\*\\*/ { print \"**Last seen:** \" ts; next }",
    "                /^\\*\\*Occurrences:\\*\\* / { print \"**Occurrences:** \" ($2 + 1); next }",
    "                { print }')",
    "            else",
    "              new_body=\"${body}\"$'\\n\\n---\\n**First seen:** '\"${TS}\"$'\\n**Last seen:** '\"${TS}\"$'\\n**Occurrences:** 2'",
    "            fi",
    "            gh issue edit \"$existing\" --repo \"$REPO\" --body \"$new_body\"",
    "          else",
    "            body=$'Workflow **'\"${WORKFLOW_NAME}\"$'** failed on `main`: '\"${RUN_URL}\"$'\\n\\n---\\n**First seen:** '\"${TS}\"$'\\n**Last seen:** '\"${TS}\"$'\\n**Occurrences:** 1'",
    "            gh issue create --repo \"$REPO\" --title \"$TITLE\" --body \"$body\" --label bug",
    "          fi",
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

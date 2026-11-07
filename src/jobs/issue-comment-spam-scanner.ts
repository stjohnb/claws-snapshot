import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import {
  renderViolationTable,
  runRepoScanner,
  type ScannerSpec,
} from "./scanner-runner.js";
import { listWorkflowFiles } from "./workflow-parser.js";

interface Violation {
  file: string;
}

const NAME = "issue-comment-spam-scanner";
const ISSUE_TITLE =
  "Alert: workflow comments on recurring failures instead of editing the issue body";

const FIXED_MARKERS = ["**Occurrences:**", "**First seen:**", "gh issue edit"];

function formatIssueBody(violations: Violation[]): string {
  return renderViolationTable({
    intro:
      "Several workflows in this repo create a new comment on every recurrence of a failure issue, which spams the issue thread. They should instead edit the issue body to bump an Occurrences/Last seen block — see https://github.com/St-John-Software/claws/pull/1246 for context.\n",
    columns: ["File"],
    rows: violations,
    cells: (v) => [`\`${v.file}\``],
    footer: [
      "**Recommended fix:** delete the repo's failure-notification workflow entirely.",
      "",
      "Claws' central `main-build-monitor` job now files, bumps and closes `Build failure: <workflow>` issues for every default-branch `push`/`schedule` run across the fleet, so a per-repo notification workflow is redundant duplication.",
      "",
      "If the workflow must stay, it should edit the issue body's `**Occurrences:**` block on recurrence instead of posting a new comment.",
      "",
      'If a recovery/close path uses `gh issue close --comment "..."`, that is fine — only standalone `gh issue comment` on recurrence is the problem.',
    ],
  });
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
  label: LABELS.priority,
  scan,
};

export function run(repos: Repo[]): Promise<void> {
  return runRepoScanner(SPEC, repos);
}

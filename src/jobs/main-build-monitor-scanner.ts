import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { listWorkflowFiles, parseWorkflow, type ParsedWorkflow } from "./workflow-parser.js";

interface MainBuildWorkflow {
  filename: string;
  name: string;
}

const NAME = "main-build-monitor-scanner";
const ISSUE_TITLE = "Alert: main-branch builds not monitored for failure";

const MAIN_BRANCH_PATTERNS = new Set(["main", "*", "**"]);

function triggersOnMainPush(workflow: ParsedWorkflow): boolean {
  const push = workflow.getPushConfig();
  if (!push) return false;

  if (push.branchesIgnore?.includes("main")) return false;

  if (push.branches !== null) {
    return push.branches.some((b) => MAIN_BRANCH_PATTERNS.has(b));
  }

  // No `branches:` filter. If only `tags:` is set (and no branches-ignore),
  // push fires only on tags — not on main.
  if (push.tags !== null && push.branchesIgnore === null) return false;

  return true;
}

function triggersOnSchedule(workflow: ParsedWorkflow): boolean {
  return workflow.getTriggers().includes("schedule");
}

function hasFailureIssueCreation(content: string): boolean {
  return content.includes("gh issue create") && content.toLowerCase().includes("failure");
}

interface ScanResult {
  mainBuildWorkflows: MainBuildWorkflow[];
  hasMonitorWorkflow: boolean;
  monitoredWorkflowNames: Set<string>;
}

function scanRepo(workflowsDir: string, files: string[]): ScanResult {
  const parsed = files.map((filename) => {
    const filePath = path.join(workflowsDir, filename);
    const content = fs.readFileSync(filePath, "utf-8");
    return { filename, content, workflow: parseWorkflow(content) };
  });

  const mainBuildWorkflows: MainBuildWorkflow[] = [];
  for (const { filename, workflow } of parsed) {
    if (triggersOnMainPush(workflow) || triggersOnSchedule(workflow)) {
      mainBuildWorkflows.push({ filename, name: workflow.getName() ?? filename });
    }
  }

  const monitoredWorkflowNames = new Set<string>();
  let hasMonitorWorkflow = false;
  for (const { content, workflow } of parsed) {
    const targets = workflow.getWorkflowRunTargets();
    if (targets !== null && hasFailureIssueCreation(content)) {
      hasMonitorWorkflow = true;
      for (const t of targets) monitoredWorkflowNames.add(t);
    }
  }

  return { mainBuildWorkflows, hasMonitorWorkflow, monitoredWorkflowNames };
}

function formatIssueBody(
  unmonitored: MainBuildWorkflow[],
  hasMonitorWorkflow: boolean,
  mainBuildWorkflows: MainBuildWorkflow[],
): string {
  const lines = [
    "Workflows that run automatically against `main` (push-to-main builds and scheduled jobs) should automatically file a tracking issue when they fail, so failures don't get lost.\n",
    "The following workflows are not covered by a failure-monitoring workflow:\n",
    "| Workflow | File |",
    "|----------|------|",
  ];

  for (const w of unmonitored) {
    lines.push(`| ${w.name} | \`${w.filename}\` |`);
  }

  lines.push("");

  if (!hasMonitorWorkflow) {
    const workflowList = mainBuildWorkflows.map((w) => `"${w.name}"`).join(", ");
    lines.push(
      "**No failure-monitoring workflow was found.** Add a dedicated `notify-failures.yml` workflow following the [production-infra pattern](https://github.com/St-John-Software/production-infra/blob/main/.github/workflows/notify-failures.yml):\n",
      "```yaml",
      "name: Notify on main build failure",
      "",
      "on:",
      "  workflow_run:",
      `    workflows: [${workflowList}]`,
      "    types: [completed]",
      "",
      "permissions:",
      "  contents: read",
      "  issues: write",
      "  actions: read",
      "",
      "jobs:",
      "  notify:",
      "    runs-on: self-hosted",
      "    if: github.event.workflow_run.conclusion == 'failure' && github.event.workflow_run.head_branch == 'main'",
      "    steps:",
      "      - name: Create failure issue",
      "        env:",
      "          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      "          WORKFLOW_NAME: ${{ github.event.workflow_run.name }}",
      "          RUN_URL: ${{ github.event.workflow_run.html_url }}",
      "          REPO: ${{ github.repository }}",
      "        run: |",
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
      "> Keep `notify-failures.yml` itself out of the `workflows:` list to avoid it triggering on its own runs.",
    );
  } else {
    lines.push(
      "A failure-monitoring workflow exists but does not cover all main-branch builds.",
      "Extend its `on.workflow_run.workflows` list to include the missing workflows listed above.",
    );
  }

  return lines.join("\n");
}

function scan(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  const wf = listWorkflowFiles(repoDir);
  if (!wf) return null;

  const { mainBuildWorkflows, hasMonitorWorkflow, monitoredWorkflowNames } = scanRepo(wf.dir, wf.files);

  if (mainBuildWorkflows.length === 0) return null;

  const unmonitored = hasMonitorWorkflow
    ? mainBuildWorkflows.filter((w) => !monitoredWorkflowNames.has(w.name))
    : mainBuildWorkflows;

  if (unmonitored.length === 0) return null;

  return {
    body: formatIssueBody(unmonitored, hasMonitorWorkflow, mainBuildWorkflows),
    summary: `Found ${unmonitored.length} unmonitored main-build workflow(s)`,
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

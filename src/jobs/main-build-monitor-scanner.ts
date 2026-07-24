import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, RECURRENCE_TRACKING_SNIPPET_LINES, type ScannerSpec } from "./scanner-runner.js";
import { listParsedWorkflows, type ParsedWorkflow, type ParsedWorkflowFile } from "./workflow-parser.js";

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

function scanRepo(parsed: ParsedWorkflowFile[]): ScanResult {
  const mainBuildWorkflows: MainBuildWorkflow[] = [];
  for (const { file, workflow } of parsed) {
    if (triggersOnMainPush(workflow) || triggersOnSchedule(workflow)) {
      mainBuildWorkflows.push({ filename: file, name: workflow.getName() ?? file });
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
      ...RECURRENCE_TRACKING_SNIPPET_LINES,
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
  const parsed = listParsedWorkflows(repoDir);
  if (!parsed) return null;

  const { mainBuildWorkflows, hasMonitorWorkflow, monitoredWorkflowNames } = scanRepo(parsed);

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

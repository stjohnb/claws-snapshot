import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { listWorkflowFiles, parseWorkflow, type ParsedWorkflow } from "./workflow-parser.js";

interface Violation {
  file: string;
  problem: "missing-workflow-concurrency" | "shared-global-group" | "deployment-status-github-ref";
  details: string;
}

const DEFAULT_BRANCHES = new Set(["main", "master"]);
const PR_RELEVANT_TRIGGERS = new Set(["pull_request", "pull_request_target", "merge_group"]);

const NAME = "concurrency-scanner";
const ISSUE_TITLE = "Alert: workflow concurrency misconfiguration";

function isWorkflowDispatchOnly(workflow: ParsedWorkflow): boolean {
  const triggers = workflow.getTriggers();
  return triggers.length === 1 && triggers[0] === "workflow_dispatch";
}

/**
 * Returns true if the workflow's triggers benefit from per-branch concurrency
 * cancellation (i.e. the same ref can be updated rapidly in quick succession).
 */
function workflowBenefitsFromConcurrency(workflow: ParsedWorkflow): boolean {
  const triggers = workflow.getTriggers();
  if (triggers.some((t) => PR_RELEVANT_TRIGGERS.has(t))) return true;
  if (!triggers.includes("push")) return false;

  const push = workflow.getPushConfig();
  if (!push) return false;
  // Bare push (no branches or tags filter) → fires on all branches → benefits
  if (push.branches === null && push.tags === null) return true;
  // Tags-only push (no branches filter) → not PR-relevant
  if (push.branches === null && push.tags !== null) return false;
  // Branches filter present → PR-relevant unless all entries are default branches
  if (push.branches !== null) {
    return !push.branches.every((b) => DEFAULT_BRANCHES.has(b));
  }
  return false;
}

/**
 * Check if a concurrency group value uses `github.ref` without
 * `github.event.deployment` — meaning it will resolve to the default
 * branch for deployment_status events instead of the PR branch.
 */
function groupUsesBarGithubRef(groupValue: string): boolean {
  return groupValue.includes("github.ref") && !groupValue.includes("github.event.deployment");
}

function scanWorkflowFile(filePath: string, workflow: ParsedWorkflow): Violation[] {
  const violations: Violation[] = [];
  const fileName = path.basename(filePath);

  const triggers = workflow.getTriggers();
  const hasDeploymentStatus = triggers.includes("deployment_status");

  const topConcurrency = workflow.getTopLevelConcurrency();
  const hasTopLevelConcurrency = topConcurrency !== null;
  const topLevelGroupValue = topConcurrency?.group ?? null;

  const jobGroupValues: { job: string; groupValue: string }[] = [];
  let hasJobLevelDynamicConcurrency = false;

  for (const job of workflow.getJobs()) {
    if (!job.concurrency || !job.concurrency.group) continue;
    const groupValue = job.concurrency.group;
    jobGroupValues.push({ job: job.name, groupValue });

    if (groupValue.includes("${{")) {
      hasJobLevelDynamicConcurrency = true;
      continue;
    }
    // Static group with cancel-in-progress: true is a shared mutex that
    // actively cancels other branches. cancel-in-progress: false (the
    // default) is intentional serialization and not flagged.
    if (job.concurrency.cancelInProgress) {
      violations.push({
        file: fileName,
        problem: "shared-global-group",
        details: `Job \`${job.name}\` uses static concurrency group \`${groupValue}\` — add \`\${{ github.ref }}\` to scope per-branch`,
      });
    }
  }

  if (
    !hasTopLevelConcurrency &&
    !hasJobLevelDynamicConcurrency &&
    workflowBenefitsFromConcurrency(workflow)
  ) {
    violations.push({
      file: fileName,
      problem: "missing-workflow-concurrency",
      details: "No top-level `concurrency:` key — add `concurrency: { group: <workflow>-${{ github.ref }}, cancel-in-progress: true }`",
    });
  }

  if (hasDeploymentStatus) {
    if (topLevelGroupValue && groupUsesBarGithubRef(topLevelGroupValue)) {
      violations.push({
        file: fileName,
        problem: "deployment-status-github-ref",
        details: `Top-level concurrency group uses \`github.ref\` which resolves to the default branch for \`deployment_status\` events — use \`\${{ github.event.deployment.ref }}\` instead`,
      });
    }
    for (const { job, groupValue } of jobGroupValues) {
      if (groupUsesBarGithubRef(groupValue)) {
        violations.push({
          file: fileName,
          problem: "deployment-status-github-ref",
          details: `Job \`${job}\` concurrency group uses \`github.ref\` which resolves to the default branch for \`deployment_status\` events — use \`\${{ github.event.deployment.ref }}\` instead`,
        });
      }
    }
  }

  return violations;
}

function formatIssueBody(violations: Violation[]): string {
  const lines = [
    "The following workflow concurrency issues were detected. Misconfigured concurrency groups can cause systemic CI cancellations across branches.\n",
    "| File | Problem | Details |",
    "|------|---------|---------|",
  ];

  const problemLabels: Record<Violation["problem"], string> = {
    "missing-workflow-concurrency": "Missing concurrency group",
    "shared-global-group": "Shared global group",
    "deployment-status-github-ref": "deployment_status uses github.ref",
  };

  for (const v of violations) {
    lines.push(`| \`${v.file}\` | ${problemLabels[v.problem]} | ${v.details} |`);
  }

  lines.push(
    "",
    "**Why this matters:** Without per-branch concurrency groups, GitHub Actions creates a global mutex — only one job runs at a time across all branches. With multiple open PRs, jobs queue up and get cancelled by newer pushes, producing the \"higher priority waiting request\" error.",
    "",
    "**Recommended fix:** Add a top-level concurrency group scoped per-branch:",
    "```yaml",
    "concurrency:",
    "  group: <workflow-name>-${{ github.ref }}",
    "  cancel-in-progress: true",
    "```",
  );

  return lines.join("\n");
}

function scan(repoDir: string, repo: Repo): { body: string; summary?: string } | null {
  const wf = listWorkflowFiles(repoDir);
  if (!wf) return null;

  const allViolations: Violation[] = [];
  for (const file of wf.files) {
    const filePath = path.join(wf.dir, file);
    const content = fs.readFileSync(filePath, "utf-8");
    const workflow = parseWorkflow(content);

    if (isWorkflowDispatchOnly(workflow)) continue;

    const violations = scanWorkflowFile(filePath, workflow);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) return null;

  return { body: formatIssueBody(allViolations), summary: `Found ${allViolations.length} concurrency issue(s)` };
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

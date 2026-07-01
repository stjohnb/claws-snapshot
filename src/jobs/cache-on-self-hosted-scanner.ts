import { LABELS, type Repo } from "../config.js";
import { renderViolationTable, runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { listParsedWorkflows, type StepInfo } from "./workflow-parser.js";

interface Violation {
  file: string;
  job: string;
  uses: string;
  issue: string;
}

const NAME = "cache-on-self-hosted-scanner";
const ISSUE_TITLE = "Alert: unnecessary caching on self-hosted runners";

const GITHUB_HOSTED_PREFIXES = ["ubuntu-", "windows-", "macos-"];
const CACHE_ACTION_RE = /^actions\/cache(\/(?:save|restore))?@/;
const SETUP_ACTION_RE = /^actions\/setup-(node|python|go|java|ruby|dotnet|php|elixir|rust)@/;

function isGitHubHostedLabel(label: string): boolean {
  return GITHUB_HOSTED_PREFIXES.some((p) => label.startsWith(p));
}

function isSelfHostedRunner(runsOn: string | string[] | null): boolean {
  if (runsOn === null) return false;

  if (typeof runsOn === "string") {
    if (runsOn.includes("${{")) return false;
    if (runsOn === "self-hosted") return true;
    return !isGitHubHostedLabel(runsOn);
  }

  // Array form
  if (runsOn.some((el) => el.includes("${{"))) return false;
  if (runsOn.includes("self-hosted")) return true;
  const first = runsOn[0];
  if (!first) return false;
  return !isGitHubHostedLabel(first);
}

function getCacheIssue(step: StepInfo): string | null {
  if (!step.uses) return null;

  if (CACHE_ACTION_RE.test(step.uses)) {
    return "Explicit cache step on self-hosted runner";
  }

  if (SETUP_ACTION_RE.test(step.uses) && step.with !== null && "cache" in step.with) {
    const cacheVal = step.with.cache;
    if (cacheVal !== null && cacheVal !== false && cacheVal !== "false") {
      return `\`with.cache: ${String(cacheVal)}\` on self-hosted runner`;
    }
  }

  return null;
}

function formatIssueBody(violations: Violation[]): string {
  return renderViolationTable({
    columns: ["File", "Job", "Step (`uses`)", "Issue"],
    rows: violations,
    cells: (v) => [`\`${v.file}\``, `\`${v.job}\``, `\`${v.uses}\``, v.issue],
    footer: [
      "**Why this matters:** Self-hosted runners in this org persist their workspace and tool caches across runs, so `actions/cache` and `setup-*` `cache:` options add round-trips to GitHub's cache service without benefit and can actually slow runs.",
      "",
      "**Fix:** Remove the `- uses: actions/cache@...` step entirely, or delete the `cache:` key from the `with:` block of any `setup-*` action.",
    ],
  });
}

function scan(repoDir: string, _repo: Repo): { body: string; summary?: string } | null {
  const violations: Violation[] = [];

  for (const { file, workflow } of listParsedWorkflows(repoDir) ?? []) {
    for (const job of workflow.getJobs()) {
      if (!isSelfHostedRunner(job.runsOn)) continue;

      for (const step of job.steps) {
        const issue = getCacheIssue(step);
        if (issue !== null) {
          violations.push({ file, job: job.name, uses: step.uses!, issue });
        }
      }
    }
  }

  if (violations.length === 0) return null;

  return {
    body: formatIssueBody(violations),
    summary: `Found ${violations.length} unnecessary cache step(s)`,
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

import fs from "node:fs";
import path from "node:path";
import { LABELS, type Repo } from "../config.js";
import { runRepoScanner, type ScannerSpec } from "./scanner-runner.js";
import { listWorkflowFiles, parseWorkflow } from "./workflow-parser.js";

interface Violation {
  file: string;
  job: string;
  runsOn: string | string[];
}

const NAME = "runner-os-scanner";
const ISSUE_TITLE = "Alert: self-hosted runner jobs missing OS label";

function formatRunsOn(v: string | string[]): string {
  return Array.isArray(v) ? `[${v.join(", ")}]` : v;
}

export function needsOsLabel(runsOn: string | string[] | null): boolean {
  if (runsOn === null) return false;

  const labels = Array.isArray(runsOn) ? runsOn : [runsOn];

  if (labels.some((l) => l.includes("${{"))) return false;
  if (!labels.includes("self-hosted")) return false;
  if (labels.some((l) => l.toLowerCase() === "linux" || l.toLowerCase() === "macos")) return false;

  return true;
}

function formatIssueBody(violations: Violation[]): string {
  const lines = [
    "| File | Job | `runs-on` |",
    "|------|-----|-----------|",
  ];

  for (const v of violations) {
    lines.push(`| \`${v.file}\` | \`${v.job}\` | \`${formatRunsOn(v.runsOn)}\` |`);
  }

  lines.push(
    "",
    "**Why this matters:** When a new self-hosted runner (e.g. macOS) joins the pool, jobs that only request `self-hosted` will be scheduled onto it indiscriminately, even when they require Linux.",
    "",
    "**Fix:** Replace `runs-on: self-hosted` with `runs-on: [self-hosted, linux]` (or `[self-hosted, macos]` for jobs that genuinely require macOS).",
  );

  return lines.join("\n");
}

function scan(repoDir: string, _repo: Repo): { body: string; summary?: string } | null {
  const wf = listWorkflowFiles(repoDir);
  if (!wf) return null;

  const violations: Violation[] = [];

  for (const file of wf.files) {
    const content = fs.readFileSync(path.join(wf.dir, file), "utf-8");
    const workflow = parseWorkflow(content);

    for (const job of workflow.getJobs()) {
      if (needsOsLabel(job.runsOn)) {
        violations.push({ file, job: job.name, runsOn: job.runsOn! });
      }
    }
  }

  if (violations.length === 0) return null;

  return {
    body: formatIssueBody(violations),
    summary: `Found ${violations.length} self-hosted job(s) missing OS label`,
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

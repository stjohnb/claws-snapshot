import fs from "node:fs";
import path from "node:path";
import { WORK_DIR, type Repo } from "../config.js";
import * as claude from "../claude.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

interface Violation {
  file: string;
  line: number;
  value: string;
}

const ISSUE_TITLE = "Alert: workflows using non-self-hosted runners";
const SEARCH_QUERY = "Alert: workflows using non-self-hosted runners";

function isSelfHosted(runsOnValue: string): boolean {
  const trimmed = runsOnValue.trim();
  // Array form: [self-hosted, ...] or [ self-hosted, ... ]
  if (trimmed.startsWith("[")) {
    const inner = trimmed.slice(1).replace(/]$/, "").trim();
    const first = inner.split(",")[0]?.trim();
    return first === "self-hosted";
  }
  // Direct value
  return trimmed === "self-hosted";
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
    if (!isSelfHosted(value)) {
      violations.push({ file: fileName, line: i + 1, value });
    }
  }

  return violations;
}

function formatIssueBody(violations: Violation[]): string {
  const lines = [
    "The following workflow files use non-self-hosted runners. All GitHub Actions workflows should use `self-hosted` runners.\n",
    "| File | Line | `runs-on` value |",
    "|------|------|-----------------|",
  ];

  for (const v of violations) {
    lines.push(`| \`${v.file}\` | ${v.line} | \`${v.value}\` |`);
  }

  lines.push(
    "",
    "Please update these workflows to use `runs-on: self-hosted` (or `runs-on: [self-hosted, ...]`).",
  );

  return lines.join("\n");
}

async function processRepo(repo: Repo): Promise<void> {
  const repoDir = path.join(WORK_DIR, "repos", repo.owner, repo.name);
  if (!fs.existsSync(repoDir)) return;

  await claude.ensureClone(repo);

  const workflowsDir = path.join(repoDir, ".github", "workflows");
  if (!fs.existsSync(workflowsDir)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(workflowsDir);
  } catch {
    return;
  }

  const workflowFiles = entries.filter(
    (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
  );

  const allViolations: Violation[] = [];
  for (const file of workflowFiles) {
    const violations = scanWorkflowFile(path.join(workflowsDir, file));
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) return;

  // Dedup: skip if an open issue already exists
  const existing = await gh.searchIssues(repo.fullName, SEARCH_QUERY);
  if (existing.length > 0) {
    log.info(
      `[ubuntu-latest-scanner] Skipping ${repo.fullName} — open issue #${existing[0]!.number} already exists`,
    );
    return;
  }

  log.info(
    `[ubuntu-latest-scanner] Found ${allViolations.length} non-self-hosted runner(s) in ${repo.fullName}`,
  );

  const body = formatIssueBody(allViolations);
  await gh.createIssue(repo.fullName, ISSUE_TITLE, body, []);
}

export async function run(repos: Repo[]): Promise<void> {
  for (const repo of repos) {
    try {
      await processRepo(repo);
    } catch (err) {
      reportError("ubuntu-latest-scanner:process-repo", repo.fullName, err);
    }
  }
}

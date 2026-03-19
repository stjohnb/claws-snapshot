import { SELF_REPO, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";

export const REPORT_HEADER = "## Claws Error Investigation Report";

export interface ClawsErrorDetails {
  fingerprint: string;
  context: string;
  timestamp: string;
  errorText: string;
}

export function parseClawsError(body: string): ClawsErrorDetails {
  const fingerprint = body.match(/\*\*Fingerprint:\*\*\s*`([^`]+)`/)?.[1] ?? "";
  const context = body.match(/\*\*Context:\*\*\s*(.+)/)?.[1] ?? "";
  const timestamp = body.match(/\*\*Timestamp:\*\*\s*(.+)/)?.[1] ?? "";
  const errorText = body.match(/```\n([\s\S]*?)```/)?.[1]?.trim() ?? "";
  return { fingerprint, context, timestamp, errorText };
}

export function extractFingerprint(title: string): string | null {
  const match = title.match(/^\[claws-error\]\s*(.+)$/);
  return match ? match[1].trim() : null;
}

export async function getKnownFingerprints(
  repo: string,
  issueNumber: number,
): Promise<Set<string>> {
  const fingerprints = new Set<string>();

  const comments = await gh.getIssueComments(repo, issueNumber);
  for (const comment of comments) {
    if (comment.body.includes("### Known Fingerprints")) {
      const matches = comment.body.matchAll(/`([^`]+)`/g);
      for (const m of matches) {
        fingerprints.add(m[1]);
      }
    }
  }

  return fingerprints;
}

export async function updateKnownFingerprints(
  repo: string,
  issueNumber: number,
  fingerprints: string[],
): Promise<void> {
  const comments = await gh.getIssueComments(repo, issueNumber);
  const existing = comments.find((c) => c.body.includes("### Known Fingerprints"));

  const lines = ["### Known Fingerprints"];
  for (const fp of fingerprints) {
    lines.push(`- \`${fp}\``);
  }
  const body = lines.join("\n");

  if (existing) {
    await gh.editIssueComment(repo, existing.id, body);
  } else {
    await gh.commentOnIssue(repo, issueNumber, body);
  }
}

export async function deduplicateByFingerprint(
  repo: string,
  issues: gh.Issue[],
): Promise<gh.Issue[]> {
  // Build a map of fingerprint → existing open [claws-error] issues
  const allOpenIssues = (await gh.listOpenIssues(repo)).filter(
    (i) => extractFingerprint(i.title) !== null,
  );

  // Group incoming issues by fingerprint
  const byFingerprint = new Map<string, gh.Issue[]>();
  for (const issue of issues) {
    const fp = extractFingerprint(issue.title);
    if (!fp) continue;
    const group = byFingerprint.get(fp) ?? [];
    group.push(issue);
    byFingerprint.set(fp, group);
  }

  const issueNumbers = new Set(issues.map((i) => i.number));
  const canonical: gh.Issue[] = [];
  const closed = new Set<number>();

  // Check each fingerprint group
  for (const [fp, group] of byFingerprint) {
    let existingCanonical: gh.Issue | null = null;

    for (const existing of allOpenIssues) {
      if (issueNumbers.has(existing.number)) continue;
      const existingFp = extractFingerprint(existing.title);
      if (existingFp === fp) {
        existingCanonical = existing;
        break;
      }
      const known = await getKnownFingerprints(repo, existing.number);
      if (known.has(fp)) {
        existingCanonical = existing;
        break;
      }
    }

    if (existingCanonical) {
      for (const issue of group) {
        await gh.commentOnIssue(repo, issue.number,
          `Duplicate of #${existingCanonical.number}. Closing in favour of the original report.`);
        await gh.closeIssue(repo, issue.number, "not_planned");
        closed.add(issue.number);
      }
    } else {
      const sorted = [...group].sort((a, b) => a.number - b.number);
      canonical.push(sorted[0]);
      for (let i = 1; i < sorted.length; i++) {
        await gh.commentOnIssue(repo, sorted[i].number,
          `Duplicate of #${sorted[0].number}. Closing in favour of the original report.`);
        await gh.closeIssue(repo, sorted[i].number, "not_planned");
        closed.add(sorted[i].number);
      }
    }
  }

  for (const issue of issues) {
    if (!closed.has(issue.number) && !canonical.includes(issue)) {
      canonical.push(issue);
    }
  }

  return canonical;
}

export async function deduplicateByInvestigation(
  repo: string,
  canonicalIssue: gh.Issue,
  relatedNumbers: number[],
): Promise<void> {
  if (relatedNumbers.length === 0) return;

  const canonicalFp = extractFingerprint(canonicalIssue.title);
  const allFingerprints: string[] = canonicalFp ? [canonicalFp] : [];

  const existing = await getKnownFingerprints(repo, canonicalIssue.number);
  for (const fp of existing) {
    if (!allFingerprints.includes(fp)) allFingerprints.push(fp);
  }

  const issues = (await gh.listOpenIssues(repo)).filter(
    (i) => extractFingerprint(i.title) !== null,
  );

  for (const num of relatedNumbers) {
    try {
      const related = issues.find((i) => i.number === num);
      if (!related) {
        log.warn(`[triage-claws-errors] Related issue #${num} not found, skipping`);
        continue;
      }

      const relatedFp = extractFingerprint(related.title);
      if (relatedFp && !allFingerprints.includes(relatedFp)) {
        allFingerprints.push(relatedFp);
      }

      await gh.commentOnIssue(repo, num,
        `Root cause identified as same as #${canonicalIssue.number} during investigation. Closing as duplicate.`);
      await gh.closeIssue(repo, num, "not_planned");
    } catch (err) {
      log.warn(`[triage-claws-errors] Failed to close related issue #${num}: ${err}`);
    }
  }

  if (allFingerprints.length > 1) {
    await updateKnownFingerprints(repo, canonicalIssue.number, allFingerprints);
  }
}

function mapFingerprintToFile(fingerprint: string): string | null {
  const jobName = fingerprint.split(":")[0];
  if (!jobName) return null;

  const jobFile = `src/jobs/${jobName}.ts`;
  const srcFile = `src/${jobName}.ts`;

  return jobFile + "` or `" + srcFile;
}

export function buildInvestigationPrompt(
  issue: gh.Issue,
  errorDetails: ClawsErrorDetails,
  otherIssues: gh.Issue[],
): string {
  const sections: string[] = [
    `You are investigating an internal Claws error.`,
    ``,
    `## Error Details`,
    ``,
    `**Issue #${issue.number}: ${issue.title}**`,
    `**Fingerprint:** \`${errorDetails.fingerprint}\``,
    `**Context:** ${errorDetails.context}`,
    `**Timestamp:** ${errorDetails.timestamp}`,
    ``,
    `### Stack Trace / Error`,
    `\`\`\``,
    errorDetails.errorText,
    `\`\`\``,
    ``,
    `### Full Issue Body`,
    ``,
    issue.body,
    ``,
    `## Instructions`,
    ``,
    `1. **Read \`docs/OVERVIEW.md\` first** for architectural context about the Claws codebase, then follow and read any linked documents relevant to this error.`,
  ];

  const fileHint = mapFingerprintToFile(errorDetails.fingerprint);
  if (fileHint) {
    sections.push(
      `2. **Read the source file** — the fingerprint \`${errorDetails.fingerprint}\` suggests the relevant source is \`${fileHint}\`. Read it and any related files.`,
    );
  } else {
    sections.push(
      `2. **Find and read the relevant source code** for the error.`,
    );
  }

  sections.push(
    `3. **Run verification commands** — reproduce the failing scenario where possible, check configuration, test edge cases. Use the codebase to understand the error path.`,
    `4. **Determine the root cause** — explain what went wrong and why, with evidence from the code.`,
    `5. **Recommend a fix** — describe what changes would resolve the issue.`,
    ``,
  );

  if (otherIssues.length > 0) {
    sections.push(`## Other Open Error Issues`);
    sections.push(``);
    for (const other of otherIssues) {
      const truncBody = other.body.length > 500 ? other.body.slice(0, 500) + "..." : other.body;
      sections.push(`### #${other.number}: ${other.title}`);
      sections.push(truncBody);
      sections.push(``);
    }
    sections.push(
      `Review the issues above. If any share the same root cause as this error, include them in the RELATED_ISSUES line below.`,
      ``,
    );
  }

  sections.push(
    `## Output Format`,
    ``,
    `Produce an investigation report with:`,
    `- Verified root cause`,
    `- Evidence from code reading and diagnostic commands`,
    `- Recommended fix`,
    ``,
    `At the very end of your output, include exactly one line:`,
    `RELATED_ISSUES: <comma-separated issue numbers, or "none">`,
    ``,
    `Example: \`RELATED_ISSUES: 45, 67\` or \`RELATED_ISSUES: none\``,
    ``,
    `Do NOT make any code changes or commits. Only produce the investigation report as text output.`,
  );

  return sections.join("\n");
}

export function parseRelatedIssues(output: string): number[] {
  const match = output.match(/RELATED_ISSUES:\s*(.+)/);
  if (!match) return [];
  const value = match[1].trim();
  if (value.toLowerCase() === "none") return [];
  return value
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n));
}

async function processIssue(
  repo: string,
  selfRepo: Repo,
  issue: gh.Issue,
  otherIssues: gh.Issue[],
): Promise<void> {
  log.info(`[triage-claws-errors] Investigating ${repo}#${issue.number}: ${issue.title}`);

  const taskId = db.recordTaskStart("triage-claws-errors", repo, issue.number, null);
  let wtPath: string | undefined;

  try {
    const branchName = `claws/investigate-error-${issue.number}-${claude.randomSuffix()}`;
    wtPath = await claude.createWorktree(selfRepo, branchName, "triage-claws-errors");
    db.updateTaskWorktree(taskId, wtPath, branchName);

    const errorDetails = parseClawsError(issue.body);
    const prompt = buildInvestigationPrompt(issue, errorDetails, otherIssues);
    const output = await claude.enqueue(() => claude.runClaude(prompt, wtPath!), gh.hasPriorityLabel(issue.labels));

    if (output.trim()) {
      const relatedNumbers = parseRelatedIssues(output);

      const reportBody = output.replace(/\nRELATED_ISSUES:.*$/m, "").trim();
      await gh.commentOnIssue(repo, issue.number, `${REPORT_HEADER}\n\n${reportBody}`);
      log.info(`[triage-claws-errors] Posted investigation report for ${repo}#${issue.number}`);

      if (relatedNumbers.length > 0) {
        await deduplicateByInvestigation(repo, issue, relatedNumbers);
        log.info(`[triage-claws-errors] Phase 2 dedup closed ${relatedNumbers.length} related issue(s)`);
      }
    } else {
      log.warn(`[triage-claws-errors] Empty investigation output for ${repo}#${issue.number}`);
    }

    db.recordTaskComplete(taskId);
  } catch (err) {
    db.recordTaskFailed(taskId, String(err));
    throw err;
  } finally {
    if (wtPath) {
      await claude.removeWorktree(selfRepo, wtPath);
    }
  }
}

export async function run(repos: Repo[]): Promise<void> {
  const selfRepo = repos.find((r) => r.fullName === SELF_REPO);
  if (!selfRepo) return;

  const repo = selfRepo.fullName;

  try {
    const allIssues = await gh.listOpenIssues(repo);
    const clawsErrorIssues = allIssues.filter((i) => extractFingerprint(i.title) !== null);

    // Filter to only issues without an investigation report
    const uninvestigated: gh.Issue[] = [];
    for (const issue of clawsErrorIssues) {
      if (gh.isItemSkipped(repo, issue.number)) continue;
      const comments = await gh.getIssueComments(repo, issue.number);
      const hasReport = comments.some((c) => c.body.includes(REPORT_HEADER));
      if (!hasReport) {
        gh.populateQueueCache("needs-triage", repo, { number: issue.number, title: issue.title, type: "issue", updatedAt: issue.updatedAt, priority: gh.hasPriorityLabel(issue.labels) });
        uninvestigated.push(issue);
      }
    }

    if (uninvestigated.length === 0) return;

    log.info(`[triage-claws-errors] Found ${uninvestigated.length} issue(s) needing investigation`);

    // Phase 1: deduplicate by fingerprint
    const canonical = await deduplicateByFingerprint(repo, uninvestigated);
    log.info(`[triage-claws-errors] After Phase 1 dedup: ${canonical.length} canonical issue(s)`);

    const tasks = canonical.map((issue, i) => {
      const others = canonical.filter((_, j) => j !== i);
      return processIssue(repo, selfRepo, issue, others).catch((err) => {
        reportError("triage-claws-errors:process-issue", `${repo}#${issue.number}`, err);
      });
    });
    await Promise.allSettled(tasks);
  } catch (err) {
    reportError("triage-claws-errors:list-issues", repo, err);
  }
}

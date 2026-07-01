import { SELF_REPO, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as claude from "../claude.js";
import * as log from "../log.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { getItemTimeoutMs, handleTimeoutIfApplicable } from "../timeout-handler.js";
import { guardContent } from "../prompt-guard.js";
import { getModel } from "../model-selector.js";
import { classifyComplexity } from "../classify-complexity.js";

export const REPORT_HEADER = "## Claws Error Investigation Report";

// Map over items with a bounded number of concurrent in-flight calls,
// preserving input order in the returned array.
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const settled = await Promise.all(batch.map((item) => fn(item)));
    for (let j = 0; j < settled.length; j++) {
      results[i + j] = settled[j];
    }
  }
  return results;
}

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

  // Precompute fingerprint → canonical existing issue once (O(E) instead of
  // O(G×E)). First issue in listOpenIssues order wins for a given fingerprint,
  // matching the original break-on-first-match loop.
  const fingerprintToCanonical = new Map<string, gh.Issue>();

  // Eligible existing issues, preserving listOpenIssues order (which determines
  // first-wins). Skip issues that are part of the incoming batch.
  const eligible = allOpenIssues.filter((e) => !issueNumbers.has(e.number));

  // Fetch each issue's known fingerprints concurrently (bounded) to avoid the
  // serial getIssueComments round-trips. Results stay aligned to `eligible` by
  // index, so map assembly below remains deterministic and order-preserving.
  const knownPerIssue = await mapWithConcurrency(
    eligible,
    5,
    (existing) => getKnownFingerprints(repo, existing.number),
  );

  for (let i = 0; i < eligible.length; i++) {
    const existing = eligible[i];
    const existingFp = extractFingerprint(existing.title);
    if (existingFp && !fingerprintToCanonical.has(existingFp)) {
      fingerprintToCanonical.set(existingFp, existing);
    }
    for (const fp of knownPerIssue[i]) {
      if (!fingerprintToCanonical.has(fp)) {
        fingerprintToCanonical.set(fp, existing);
      }
    }
  }

  // Check each fingerprint group
  for (const [fp, group] of byFingerprint) {
    const existingCanonical = fingerprintToCanonical.get(fp) ?? null;

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
  repo: string,
): string {
  const guardCtx = (source: string, itemNumber: number) => ({ repo, source, itemNumber });
  const sections: string[] = [
    `You are investigating an internal Claws error.`,
    ``,
    `## Error Details`,
    ``,
    `**Issue #${issue.number}: ${guardContent(issue.title, guardCtx("issue-title", issue.number))}**`,
    // Guard parsed errorDetails fields individually (belt-and-suspenders): these are
    // substrings of issue.body, which is also guarded below. Guarding both catches
    // injection that might survive parser extraction and covers the full body too.
    `**Fingerprint:** \`${guardContent(errorDetails.fingerprint, guardCtx("error-fingerprint", issue.number))}\``,
    `**Context:** ${guardContent(errorDetails.context, guardCtx("error-context", issue.number))}`,
    `**Timestamp:** ${guardContent(errorDetails.timestamp, guardCtx("error-timestamp", issue.number))}`,
    ``,
    `### Stack Trace / Error`,
    `\`\`\``,
    guardContent(errorDetails.errorText, guardCtx("error-text", issue.number)),
    `\`\`\``,
    ``,
    `### Full Issue Body`,
    ``,
    guardContent(issue.body, guardCtx("issue-body", issue.number)),
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
      const guardedBody = guardContent(other.body, guardCtx("issue-body", other.number));
      const truncBody = guardedBody.length > 500 ? guardedBody.slice(0, 500) + "..." : guardedBody;
      sections.push(`### #${other.number}: ${guardContent(other.title, guardCtx("issue-title", other.number))}`);
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

export function isReportTruncated(output: string): boolean {
  return !/RELATED_ISSUES:\s*\S+/.test(output);
}

async function processIssue(
  repo: string,
  selfRepo: Repo,
  issue: gh.Issue,
  otherIssues: gh.Issue[],
): Promise<void> {
  log.info(`[triage-claws-errors] Investigating ${repo}#${issue.number}: ${issue.title}`);

  const branchName = `claws/investigate-error-${issue.number}-${claude.randomSuffix()}`;

  await db.withTaskRecording("triage-claws-errors", repo, issue.number, null, async (taskId) => {
    await claude.withNewWorktree(selfRepo, branchName, "triage-claws-errors", async (wtPath) => {
      db.updateTaskWorktree(taskId, wtPath, branchName);

      const errorDetails = parseClawsError(issue.body);
      const prompt = buildInvestigationPrompt(issue, errorDetails, otherIssues, repo);
      const mcpConfigPath = claude.writeClawsMcpConfig(wtPath);
      const timeoutMs = getItemTimeoutMs(repo, issue.number);
      const tier = await classifyComplexity(
        [
          `Claws internal error investigation for issue #${issue.number}.`,
          `Error title: ${issue.title}`,
          `Fingerprint: ${errorDetails.fingerprint}`,
          `Error (first 2000 chars):`,
          errorDetails.errorText.slice(0, 2000),
        ].join("\n"),
        wtPath,
      );
      const model = getModel(tier, "tool-use", "claude");
      db.updateTaskModel(taskId, model);
      log.info(`[triage-claws-errors] Using model "${model}" for ${repo}#${issue.number}`);
      // Two possible runClaude calls (retry on truncation) — shared callback accumulates across both.
      const trackTokens = db.trackTaskTokens(taskId);
      let output = await claude.runClaude(prompt, wtPath, { capability: "tool-use", mcpConfig: mcpConfigPath, timeoutMs, tier, model, agent: "plan", onTokensUsed: trackTokens });

      if (output.trim() && isReportTruncated(output)) {
        log.warn(`[triage-claws-errors] Investigation output appears truncated for ${repo}#${issue.number} (missing RELATED_ISSUES marker, ${output.length} chars) — retrying once`);
        output = await claude.runClaude(prompt, wtPath, { capability: "tool-use", mcpConfig: mcpConfigPath, timeoutMs, tier, model, agent: "plan", onTokensUsed: trackTokens });
      }

      if (output.trim() && isReportTruncated(output)) {
        log.warn(`[triage-claws-errors] Investigation output still truncated after retry for ${repo}#${issue.number} (${output.length} chars) — skipping report; will retry next cycle`);
        db.recordTaskComplete(taskId, { commits: 0 });
        return;
      }

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

      db.recordTaskComplete(taskId, { commits: 0 });
    });
  });
}

export async function run(repos: Repo[]): Promise<void> {
  const selfRepo = repos.find((r) => r.fullName === SELF_REPO);
  if (!selfRepo) return;

  const repo = selfRepo.fullName;

  try {
    const allIssues = await gh.listOpenIssues(repo);
    const clawsErrorIssues = allIssues.filter((i) => extractFingerprint(i.title) !== null);

    // Phase A: filter (isAllowedActor stays sequential — it logs on skip).
    const candidates: gh.Issue[] = [];
    for (const issue of clawsErrorIssues) {
      if (gh.isItemSkipped(repo, issue.number)) continue;
      if (gh.hasIgnoreLabel(issue.labels)) continue;
      if (!await gh.isAllowedActor(issue.author.login)) {
        log.info(`[triage-claws-errors] Skipping issue #${issue.number} from non-allowed actor @${issue.author.login}`);
        continue;
      }
      candidates.push(issue);
    }

    // Phase B: independent comment fetches in parallel.
    const commentsPerCandidate = await Promise.all(
      candidates.map((issue) => gh.getIssueComments(repo, issue.number)),
    );

    // Phase C: classify + populate cache in deterministic input order.
    const uninvestigated: gh.Issue[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const issue = candidates[i];
      const hasReport = commentsPerCandidate[i].some((c) => c.body.includes(REPORT_HEADER));
      if (!hasReport) {
        gh.populateQueueCacheFor("needs-triage", repo, issue, "issue");
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
      return processIssue(repo, selfRepo, issue, others).catch(async (err) => {
        await handleTimeoutIfApplicable("triage-claws-errors", repo, issue.number, err);
        await reportError("triage-claws-errors:process-issue", `${repo}#${issue.number}`, err);
      });
    });
    await Promise.allSettled(tasks);
  } catch (err) {
    reportError("triage-claws-errors:list-issues", repo, err);
  }
}

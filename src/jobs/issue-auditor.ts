import { LABELS, SELF_REPO, isAgentDisabled, isClawsIssueId, isJobDisabledForRepo, type Repo } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as log from "../log.js";
import * as smartSchedule from "../smart-schedule.js";
import { reportError } from "../error-reporter.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import { findPlanComment, parsePlan } from "../plan-parser.js";
import { selectFeedbackCandidates } from "../agents/issue-refiner.js";
import { closesIssue } from "../phase-coverage.js";
import { loadIssuePhaseState, loadStoredPlannedPRs, type IssuePhaseState, type StoredPlannedPRs } from "../planned-prs.js";
import * as db from "../db.js";
import { comparePrRowWithLabels, type PrStateDisagreement } from "../pr-state.js";
import { closeAlertIssueIfResolved, upsertAlertIssue } from "../occurrence-tracking.js";

const PLAN_HEADER = "## Implementation Plan";

/**
 * Identify which plan phase a merged PR implements, using title and body patterns.
 * Title: "fix: Title (phaseNum/total)" → check for "(phaseNum/total)"
 * Body: "## PR phaseNum of total: Title" → check for this header
 * The issue ref lives in the PR body/branch, not the title.
 * Returns the phase number, or null if no match.
 */
function getPRPhaseNumber(pr: gh.PR, totalPhases: number): number | null {
  const titleMatch = pr.title?.match(/\((\d+)\/(\d+)\)/);
  if (titleMatch && parseInt(titleMatch[2], 10) === totalPhases) {
    return parseInt(titleMatch[1], 10);
  }
  const bodyMatch = pr.body?.match(/##\s+PR\s+(\d+)\s+of\s+(\d+)\s*:/);
  if (bodyMatch && parseInt(bodyMatch[2], 10) === totalPhases) {
    return parseInt(bodyMatch[1], 10);
  }
  return null;
}

type IssueState =
  | "refined"
  | "in-progress"
  | "needs-triage"
  | "needs-refinement"
  | "ready"
  | "stuck-multi-phase"
  | "done"
  /** A Claws-native issue whose single `claws/issue-<id>-` PR merged saying it closes it. */
  | "done-native";

/**
 * A stored PR list (claws_issue_prs) reads each linked PR in its own repo, so
 * it sees a multi-repo plan's PR in another repo that the branch-prefix
 * lookups — the issue repo's only — miss. Phase state is loaded only for a
 * list naming another repo: coverage reads every linked PR's state, and a
 * same-repo list is covered by those cheaper lookups.
 */
async function loadCrossRepoPhaseState(
  fullName: string,
  issueNumber: gh.Issue["number"],
  comments: { body: string; login: string }[] | (() => Promise<{ body: string; login: string }[]>),
): Promise<{ stored: StoredPlannedPRs | null; storedState: IssuePhaseState | null }> {
  const stored = await loadStoredPlannedPRs(fullName, issueNumber);
  const crossRepo = stored?.entries.some((e) => e.repo.toLowerCase() !== fullName.toLowerCase()) ?? false;
  if (!stored || !crossRepo) return { stored, storedState: null };
  const list = typeof comments === "function" ? await comments() : comments;
  return { stored, storedState: await loadIssuePhaseState(fullName, issueNumber, list, { stored }) };
}

/**
 * Whether the auditor must leave the issue alone: skipped, parked, or authored
 * by a disallowed actor. `auditIssue` returns `[]` for these.
 */
async function isAuditExempt(repo: Repo, issue: gh.Issue): Promise<boolean> {
  if (gh.isItemSkipped(repo.fullName, issue.number)) return true;
  if (gh.isParked(issue.labels)) return true;
  return !await gh.isAllowedActor(issue.author.login, repo.fullName, issue.number);
}

export async function classifyIssue(
  repo: Repo,
  issue: gh.Issue,
): Promise<IssueState> {
  const fullName = repo.fullName;

  // Has "Refined" label → issue-worker handles
  if (issue.labels.some((l) => l.name === LABELS.refined)) return "refined";

  // Has open Claws PR → ci-fixer/review-addresser handle
  const openPR = await gh.getOpenPRForIssue(fullName, issue.number);
  if (openPR) return "in-progress";

  // Fetch comments once — reused for the [claws-error] report check and plan scanning below
  const comments = await gh.getIssueComments(fullName, issue.number);

  const { stored, storedState } = await loadCrossRepoPhaseState(fullName, issue.number, comments);
  if (storedState && storedState.coverage.openPhases.length > 0) return "in-progress";

  // [claws-error] without investigation report → triage handles
  if (extractFingerprint(issue.title) !== null) {
    const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
    if (!hasReport) return "needs-triage";
  }

  // Find the last Claws plan comment (matching refiner's stricter check)
  const lastPlanIdx = comments.findLastIndex(
    (c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body),
  );

  // No plan → needs-refinement (refiner handles)
  if (lastPlanIdx === -1) return "needs-refinement";

  // Check for unreacted human feedback after the plan
  const selfLogin = await gh.getSelfLoginForIssue(repo.fullName, issue.number);
  const commentsAfterPlan = selectFeedbackCandidates(comments, lastPlanIdx);

  for (const comment of commentsAfterPlan) {
    if (gh.isClawsComment(comment.body)) continue;
    if (comment.login.endsWith("[bot]")) continue;

    try {
      const reactions = await gh.getCommentReactions(fullName, comment.id);
      const hasReaction = reactions.some(
        (r) => r.user.login === selfLogin && r.content === "+1",
      );
      if (!hasReaction) return "needs-refinement";
    } catch {
      // Treat as unreacted to be safe
      return "needs-refinement";
    }
  }

  // A stored multi-PR list, read wherever its steps merged: every step landed
  // is done; some landed with none in flight is stuck between steps. Only
  // after the triage and feedback checks — unanswered feedback on a finished
  // plan still needs the planner. A single-PR plan keeps the `done-native`
  // check below, which also requires the merged PR to say it closes the issue.
  if (storedState && storedState.totalPhases > 1) {
    if (storedState.coverage.done.size >= storedState.totalPhases) return "done";
    if (storedState.coverage.done.size > 0) return "stuck-multi-phase";
  }

  // Check for stuck or completed multi-phase issues
  const mergedPRs = await gh.listMergedPRsForIssue(fullName, issue.number);
  if (mergedPRs.length > 0) {
    const planText = findPlanComment(comments.map((c) => ({ body: c.body })));
    const parsedPlan = planText ? parsePlan(planText) : null;
    // A stored PR list is authoritative for the step count.
    const totalPhases = stored ? stored.entries.length : (parsedPlan?.totalPhases ?? 1);

    // Single-PR completion for a native issue. GitHub closes its own issues on
    // `Closes #N`; a `clw_…` id means nothing to either forge, so a merged
    // `claws/issue-<id>-` PR claiming to close this issue is the only signal
    // there is. Multi-phase plans keep their own accounting below.
    if (totalPhases <= 1
        && isClawsIssueId(issue.number)
        && mergedPRs.some((pr) => closesIssue(pr.body ?? "", issue.number))) {
      return "done-native";
    }

    if (stored && !storedState && totalPhases > 1) {
      const { coverage } = await loadIssuePhaseState(fullName, issue.number, comments, { planText, mergedPRs, stored });
      if (coverage.done.size >= totalPhases) return "done";
      if (!issue.labels.some((l) => l.name === LABELS.refined)) return "stuck-multi-phase";
    } else if (!stored && parsedPlan) {
      const parsed = parsedPlan;
      if (parsed.totalPhases > 1) {
        // Match each merged PR to a plan phase by content (title/body patterns)
        const matchedPhases = new Set(
          mergedPRs
            .map((pr) => getPRPhaseNumber(pr, parsed.totalPhases))
            .filter((n): n is number => n !== null),
        );
        const allPhaseNumbers = Array.from({ length: parsed.totalPhases }, (_, i) => i + 1);

        // Primary: content matching; fallback to counting when no patterns found
        const allDone =
          matchedPhases.size > 0
            ? allPhaseNumbers.every((n) => matchedPhases.has(n))
            : mergedPRs.length >= parsed.totalPhases;

        if (allDone) {
          return "done";
        }

        if (!issue.labels.some((l) => l.name === LABELS.refined)) {
          return "stuck-multi-phase";
        }
      }
    }
  }

  // Plan exists, all feedback addressed → should be ready
  return "ready";
}

/**
 * Classify one open issue and apply the label/close fixes its state calls for.
 * Returns a description of each fix applied; an issue the auditor must not
 * touch (skipped, parked, disallowed author) or one whose classification
 * throws returns `[]`.
 */
export async function auditIssue(repo: Repo, issue: gh.Issue): Promise<string[]> {
  const fixes: string[] = [];
  if (await isAuditExempt(repo, issue)) return fixes;

  try {
    const state = await classifyIssue(repo, issue);

    if (state === "done-native") {
      await gh.closeIssue(repo.fullName, issue.number, "completed");
      fixes.push(`closed native ${repo.fullName}#${issue.number} after its PR merged`);
      return fixes;
    }

    if (state === "ready") {
      const hasReady = issue.labels.some((l) => l.name === LABELS.ready);
      if (!hasReady) {
        await gh.addLabel(repo.fullName, issue.number, LABELS.ready);
        fixes.push(`added Ready to ${repo.fullName}#${issue.number}`);
      }
    } else if (state === "stuck-multi-phase") {
      const hasReady = issue.labels.some((l) => l.name === LABELS.ready);
      if (!hasReady) {
        await gh.addLabel(repo.fullName, issue.number, LABELS.ready);
        fixes.push(`added Ready to stuck multi-phase ${repo.fullName}#${issue.number}`);
      }
    } else if (state === "done") {
      await gh.closeIssue(repo.fullName, issue.number, "completed");
      fixes.push(`closed completed multi-phase ${repo.fullName}#${issue.number}`);
    }
  } catch (err) {
    reportError("issue-auditor:classify-issue", `${repo.fullName}#${issue.number}`, err, { repo: repo.fullName });
  }
  return fixes;
}

/** Title of the per-repo alert issue in SELF_REPO listing claws_prs disagreements. */
export function prStoreAlertTitle(repoFullName: string): string {
  return `[pr-store] claws_prs disagrees with PR labels in ${repoFullName}`;
}

function buildPrStoreAlertBody(repoFullName: string, rows: { pr: number; d: PrStateDisagreement }[]): string {
  return [
    `The issue auditor compared each open PR's \`claws_prs\` row with its labels in ${repoFullName} and found ${rows.length} disagreement(s).`,
    ``,
    `A disagreement is a bug in a writer (docs/refinements/issue-flow.md, "The façade and the mirror"). Keep \`CLAWS_PR_STORE_FACADE\` off until the auditor sweeps clean for a sustained run. This issue closes itself on the next clean sweep.`,
    ``,
    `| PR | Field | Row | Labels |`,
    `|---|---|---|---|`,
    ...rows.map(({ pr, d }) => `| ${repoFullName}#${pr} | ${d.field} | ${d.expected} | ${d.actual} |`),
  ].join("\n");
}

/**
 * Compare every open PR's `claws_prs` row with its labels (phase 1 of the
 * issue-flow design). Reports only — never edits the row or the labels. Each
 * disagreement is a warn line and a returned fix string naming the PR and
 * field; the set is kept in one alert issue in SELF_REPO, closed on a clean sweep.
 */
export async function auditPrStore(repo: Repo): Promise<string[]> {
  // Raw forge labels: with the façade on, gh.listPRs would serve the row itself.
  // Fresh too: a cached list predates the label hook's latest writes.
  gh.invalidatePRList(repo.fullName);
  const [prs, rows] = await Promise.all([gh.listPRs(repo.fullName, { raw: true }), db.listClawsPrs(repo.fullName)]);
  const byNumber = new Map(rows.map((r) => [r.prNumber, r]));
  const found: { pr: number; d: PrStateDisagreement }[] = [];
  for (const pr of prs) {
    const labels = pr.labels.map((l) => l.name);
    for (const d of comparePrRowWithLabels(byNumber.get(pr.number) ?? null, labels)) {
      found.push({ pr: pr.number, d });
    }
  }
  const fixes = found.map(({ pr, d }) =>
    `pr-store: ${repo.fullName}#${pr} field=${d.field} row=${d.expected} labels=${d.actual}`);
  for (const line of fixes) log.warn(`[issue-auditor] ${line}`);

  const title = prStoreAlertTitle(repo.fullName);
  if (found.length === 0) {
    log.info(`[issue-auditor] pr-store: ${repo.fullName} clean (${prs.length} PRs compared)`);
    await closeAlertIssueIfResolved({ repo: SELF_REPO, title, logPrefix: "issue-auditor", reason: "claws_prs agrees with PR labels" });
  } else {
    await upsertAlertIssue({
      repo: SELF_REPO,
      title,
      body: buildPrStoreAlertBody(repo.fullName, found),
      labels: [],
      logPrefix: "issue-auditor",
      createdDetail: `${found.length} disagreement(s)`,
    });
  }
  return fixes;
}

export async function processRepo(repo: Repo): Promise<string[]> {
  const fixes: string[] = [];
  await smartSchedule.withDailyRepoMarking(
    "issue-auditor",
    repo.fullName,
    async () => {
      if (isRateLimited()) return;

      const issues = await gh.listOpenIssues(repo.fullName);
      let repoFixes = 0;

      for (const issue of issues) {
        if (isRateLimited()) break;
        const issueFixes = await auditIssue(repo, issue);
        fixes.push(...issueFixes);
        repoFixes += issueFixes.length;
      }

      if (repoFixes > 0) {
        log.info(`[issue-auditor] Fixed ${repoFixes} issue(s) in ${repo.fullName}`);
      }

      if (!isRateLimited()) {
        try {
          // Only the PR dispatcher seeds claws_prs rows; where it does not run,
          // every PR would read as a missing row.
          if (isAgentDisabled("pr-dispatcher") || isJobDisabledForRepo("pr-dispatcher", repo.fullName)) {
            await closeAlertIssueIfResolved({
              repo: SELF_REPO,
              title: prStoreAlertTitle(repo.fullName),
              logPrefix: "issue-auditor",
              reason: "pr-dispatcher is disabled for the repo, so claws_prs is not kept",
            });
          } else {
            fixes.push(...await auditPrStore(repo));
          }
        } catch (err) {
          reportError("issue-auditor:pr-store", repo.fullName, err, { repo: repo.fullName });
        }
      }
    },
    (err) => {
      reportError("issue-auditor:audit-repo", repo.fullName, err, { repo: repo.fullName });
    },
  );

  if (fixes.length > 0) {
    const summary = `Issue auditor (${repo.fullName}): fixed ${fixes.length} issue(s) \u2014 ${fixes.join(", ")}`;
    log.info(`[issue-auditor] ${summary}`);
  }

  return fixes;
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(repos.map((repo) => processRepo(repo)));
}

import { LABELS, SELF_REPO, type Repo, isAgentDisabled } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import * as planParser from "../plan-parser.js";
import * as issueRefiner from "../agents/issue-refiner.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import * as slack from "../slack.js";
import * as db from "../db.js";
import { ensureAlertIssue, parseOccurrenceCount } from "../occurrence-tracking.js";

// Re-plan once the live occurrence count has at least doubled vs. what the plan
// was based on. With a default of 1, this fires on the first recurrence (1 -> 2),
// then backs off geometrically (2 -> 4, 4 -> 8) so we don't re-plan every bump.
const REPLAN_OCCURRENCE_FACTOR = 2;

async function notifyUntrustedActorSkip(repoFullName: string, issue: gh.Issue): Promise<void> {
  // DB-backed dedup: returns false if we already notified about this repo#issue
  // in a prior run (survives restarts). Gates BOTH the Slack ping and the
  // occurrence-tracking bump, so each distinct blocked item counts once.
  if (!db.markUntrustedActorNotified(repoFullName, issue.number)) return;

  const login = issue.author.login;
  // Untrusted author controls the title — collapse whitespace and truncate.
  const safeTitle = issue.title.replace(/\s+/g, " ").slice(0, 100);
  slack.notify(
    `:no_entry: Claws ignored ${repoFullName}#${issue.number} "${safeTitle}" — author @${login} is not a trusted actor`,
  );

  // File/update a tracked GitHub issue in the Claws self-repo so the operator
  // can grant an allowlist exception. One issue per actor; occurrence count
  // reflects how many items that actor has had blocked. Title MUST stay stable
  // for ensureAlertIssue's title-match dedup.
  const alertTitle = `[disallowed-actor] @${login} is blocked from Claws automation`;
  const alertBody = [
    `Claws skipped a dispatch because issue author **@${login}** is not in the \`allowedActors\` allowlist.`,
    ``,
    `This is usually a missing exception rather than an attack. To allow this`,
    `actor, add \`${login}\` to \`allowedActors\` in the Claws config.`,
    ``,
    `First blocked item: ${repoFullName}#${issue.number}`,
  ].join("\n");

  try {
    await ensureAlertIssue({
      repo: SELF_REPO,
      title: alertTitle,
      body: alertBody,
      logPrefix: "issue-dispatcher",
    });
  } catch (err) {
    // Never let alert-issue filing break the dispatch loop.
    log.warn(`[issue-dispatcher] Failed to file disallowed-actor alert for @${login}: ${String(err)}`);
  }
}

export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(
    repos.map(async (repo) => {
      // Note: all repo callbacks start concurrently, so this check does not prevent
      // other repos from being dispatched — it only short-circuits the current repo's
      // work if rate limiting is already detected when its callback begins executing.
      if (isRateLimited()) return;
      try {
        const allIssues = await gh.listOpenIssues(repo.fullName);
        const selfLogin = await gh.getSelfLogin(repo.owner);
        const processedByWorker = new Set<number>();
        const populated = new Set<number>();

        // ── Phase 1: Refined issues → implementer ──
        if (!isAgentDisabled("implementer")) {
          const refinedIssues = allIssues.filter((i) =>
            i.labels.some((l) => l.name === LABELS.refined),
          );
          for (const issue of refinedIssues) {
            if (isRateLimited()) break;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (!await gh.isAllowedActor(issue.author.login) && !gh.isCiAlertBotAuthor(issue)) {
              log.info(`[issue-dispatcher] Skipping refined issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }
            processedByWorker.add(issue.number);
            populated.add(issue.number);
            gh.populateQueueCacheFor("refined", repo.fullName, issue, "issue");
            worker.enqueue(AGENT_KINDS.ISSUE_WORKER, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        // ── Phase 2: Plan/refine → planner ──
        if (!isAgentDisabled("planner")) {
          for (const issue of allIssues) {
            if (isRateLimited()) break;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (!await gh.isAllowedActor(issue.author.login) && !gh.isCiAlertBotAuthor(issue)) {
              log.info(`[issue-dispatcher] Skipping planner dispatch for issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }
            if (issue.labels.some((l) => l.name === LABELS.refined)) continue;
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) continue;

            // Check for follow-up comments on issues with an open PR
            const openPR = await gh.getOpenPRForIssue(repo.fullName, issue.number);
            if (openPR) {
              const { hasPlan, unreacted } = await issueRefiner.findUnreactedFeedbackAfterPlan(
                repo.fullName, issue.number, selfLogin,
              );
              if (hasPlan && unreacted.length > 0) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                worker.enqueue(AGENT_KINDS.ISSUE_REFINER_FOLLOWUP, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              }
              continue;
            }

            // Triage-before-refinement: skip [claws-error] issues without triage report
            if (extractFingerprint(issue.title) !== null) {
              const comments = await gh.getIssueComments(repo.fullName, issue.number);
              const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
              if (!hasReport) continue;
            }

            // Fetch comments to determine state
            const { hasPlan, unreacted: unreactedComments, plannedOccurrences } = await issueRefiner.findUnreactedFeedbackAfterPlan(
              repo.fullName, issue.number, selfLogin,
            );

            if (!hasPlan) {
              // No plan comment exists — produce a new plan
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              worker.enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else if (unreactedComments.length > 0) {
              // Human feedback needs addressing
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
              worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REFINE, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else {
              // All feedback addressed. Before parking it as "ready", check whether the
              // issue has recurred enough since the plan was written to warrant a re-plan.
              const currentOcc = parseOccurrenceCount(issue.body);
              // Legacy plans (posted before the marker existed) default to 1 — the count
              // every pre-marker plan implicitly assumed. This backfills existing stale
              // alert issues with one re-plan that then stamps the marker.
              const planned = plannedOccurrences ?? 1;
              if (currentOcc !== null && currentOcc >= planned * REPLAN_OCCURRENCE_FACTOR && currentOcc > planned) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                log.info(`[issue-dispatcher] Re-planning ${repo.fullName}#${issue.number}: occurrences ${currentOcc} >= planned ${planned} * ${REPLAN_OCCURRENCE_FACTOR}`);
                worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              } else {
                populated.add(issue.number);
                gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                if (issueRefiner.isCiUnrelatedIssue(issue) && !issue.labels.some((l) => l.name === LABELS.refined)) {
                  await gh.addLabel(repo.fullName, issue.number, LABELS.refined);
                  log.info(`[issue-dispatcher] Auto-refined ci-unrelated issue ${repo.fullName}#${issue.number}`);
                }
              }
            }
          }
        }

        // ── Phase 3: Multi-PR continuations → implementer ──
        if (!isAgentDisabled("implementer")) {
          for (const issue of allIssues) {
            if (processedByWorker.has(issue.number)) continue;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) continue;

            const mergedPRs = await gh.listMergedPRsForIssue(repo.fullName, issue.number);
            if (mergedPRs.length === 0) continue;

            const comments = await gh.getIssueComments(repo.fullName, issue.number);
            const planText = planParser.findPlanComment(comments);
            const plan = planText ? planParser.parsePlan(planText) : null;
            const totalPhases = plan?.totalPhases ?? 1;
            if (totalPhases <= 1) continue;
            if (mergedPRs.length >= totalPhases) continue;

            worker.enqueue(AGENT_KINDS.ISSUE_WORKER_CONTINUE, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        if (!isRateLimited()) {
          const reconcileCategories: gh.QueueCategory[] = [];
          if (!isAgentDisabled("implementer")) reconcileCategories.push("refined");
          if (!isAgentDisabled("planner")) reconcileCategories.push("needs-refinement", "ready");
          if (reconcileCategories.length > 0) {
            gh.reconcileQueueCache(repo.fullName, reconcileCategories, populated, "issue");
          }
        }
      } catch (err) {
        reportError("issue-dispatcher:list-issues", repo.fullName, err);
      }
  }),
  );
}

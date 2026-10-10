import { canonicalIssueRef, isClawsIssueId, type IssueRef } from "../issue-id.js";
import type { IssueLifecycle } from "../issue-lifecycle.js";
import { LABELS, SELF_REPO, type Repo, isAgentDisabled } from "../config.js";
import * as gh from "../github.js";
import { isRateLimited, isRepoRateLimited, describeRateLimit } from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import * as planParser from "../plan-parser.js";
import { isPhaseClaimOnly } from "../phase-coverage.js";
import { closeIssueIfPlanComplete, issueHasShippedWork, listOpenPhasePRs, loadIssuePhaseState, peekTotalPhases, resolveTrackerId } from "../planned-prs.js";
import * as issueRefiner from "../agents/issue-refiner.js";
import { approvedRequirementsFromBatch, loadApprovedRequirementsForOpenIssues, type ApprovedRequirements, type ApprovedRequirementsResult } from "../approved-requirements.js";
import * as escalationReviewer from "../agents/escalation-reviewer.js";
import * as requirementsWriter from "../agents/requirements-writer.js";
import * as clawsIssues from "../claws-issues.js";
import * as reapproval from "../reapproval.js";
import { extractFingerprint, REPORT_HEADER as CLAWS_ERROR_REPORT_HEADER } from "./triage-claws-errors.js";
import * as worker from "../worker.js";
import { AGENT_KINDS } from "../worker.js";
import * as slack from "../slack.js";
import * as db from "../db.js";
import * as issueLinks from "../issue-links.js";
import { isDuplicateToSettle, parkForHuman, returnToPlanReview, settleDuplicate, settleMergedSingleStep } from "../issue-handback.js";
import { ensureAlertIssue, parseOccurrenceCount } from "../occurrence-tracking.js";

// Re-plan once the live occurrence count has at least doubled vs. what the plan
// was based on. With a default of 1, this fires on the first recurrence (1 -> 2),
// then backs off geometrically (2 -> 4, 4 -> 8) so we don't re-plan every bump.
const REPLAN_OCCURRENCE_FACTOR = 2;

async function notifyUntrustedActorSkip(repoFullName: string, issue: gh.Issue): Promise<void> {
  // DB-backed dedup: returns false if we already notified about this repo#issue
  // in a prior run (survives restarts). Gates BOTH the Slack ping and the
  // occurrence-tracking bump, so each distinct blocked item counts once.
  if (!await db.markUntrustedActorNotified(repoFullName, issue.number)) return;

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
    `\`allowedActors\` is the human trust boundary: a login listed there can also`,
    `👍-approve Claws suggestions and plans. Add \`${login}\` only if it is a person.`,
    `If it is a bot or service account, never add it: extend the trusted-automation`,
    `logins in \`src/github.ts\` instead (\`CI_FAILURE_ALERT_BOT_LOGINS\` for GitHub`,
    `Actions, \`FORGEJO_CI_ALERT_BOT_LOGINS\` for Forgejo Actions), or skip the item`,
    `via \`skippedItems\`.`,
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

/**
 * The implementer gate: true (and logged) when the issue depends on a tracker
 * issue that is still open. Planning is not gated — only implementation.
 */
async function hasOpenDependencies(repoFullName: string, ref: IssueRef): Promise<boolean> {
  const open = await issueLinks.listOpenDependencies(repoFullName, ref);
  if (open.length === 0) return false;
  log.info(`[issue-dispatcher] Not implementing ${repoFullName}#${ref}: depends on open ${open.map((d) => `#${d.id}`).join(", ")}`);
  return true;
}

/**
 * Enqueue the requirements writer for a plan-less issue: a write when it has
 * no record yet, a refine when a human has commented on the record since.
 * `latest` is this tick's batch read, keyed by tracker id; a forge issue with
 * no shadow yet has no record, and the writer mints the shadow. An issue in
 * Ideas gets only this; the planner waits for its promotion (see
 * {@link issueLifecycle}).
 */
async function dispatchRequirementsWriter(
  repoFullName: string,
  issue: gh.Issue,
  latest: Map<string, db.ClawsIssueRequirementsRow>,
): Promise<void> {
  const trackerId = await resolveTrackerId(repoFullName, issue.number);
  const record = trackerId ? latest.get(trackerId) : undefined;
  const priority = gh.hasPriorityLabel(issue.labels);
  if (!record) {
    await worker.enqueue(AGENT_KINDS.REQUIREMENTS_WRITE, repoFullName, issue.number, { priority });
    return;
  }
  const unreacted = await requirementsWriter.unreactedAfterRequirements(
    repoFullName, issue.number, await gh.getSelfLoginForIssue(repoFullName, issue.number),
  );
  if (unreacted && unreacted.length > 0) {
    await worker.enqueue(AGENT_KINDS.REQUIREMENTS_REFINE, repoFullName, issue.number, { priority });
  }
}

/**
 * The issue's tracker id and stored lifecycle — the only way to tell Ideas
 * from Planning, which carry no label. A native issue's comes with the
 * listing; a forge issue's lives on its shadow, minted here when it has none,
 * so a new forge issue starts in Ideas like a native one. Undefined when the
 * read fails, which the caller treats as "not in Ideas": the planner runs as
 * it always did rather than stalling behind a database hiccup.
 */
async function issueLifecycle(repoFullName: string, issue: gh.Issue): Promise<{ trackerId: string; lifecycle: IssueLifecycle } | undefined> {
  const nativeId = canonicalIssueRef(issue.number) ?? issue.number;
  if (isClawsIssueId(nativeId)) return issue.lifecycle !== undefined ? { trackerId: String(nativeId), lifecycle: issue.lifecycle } : undefined;
  try {
    const trackerId = await resolveTrackerId(repoFullName, issue.number, {
      title: issue.title,
      body: issue.body,
      authorLogin: issue.author.login,
      labels: issue.labels.map((l) => l.name),
    });
    if (!trackerId) return undefined;
    const lifecycle = (await db.getClawsIssue(trackerId))?.lifecycle;
    return lifecycle ? { trackerId, lifecycle } : undefined;
  } catch (err) {
    log.warn(`[issue-dispatcher] Could not read the stage of ${repoFullName}#${issue.number}: ${err}`);
    return undefined;
  }
}

/**
 * Enforce the Planning invariant for a planned issue with neither `Ready` nor
 * `Refined` (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ): it is in Planning only while a
 * planner run is queued or running for it. Otherwise the first that applies:
 *
 * 1. A multi-step plan with any step covered is left to Phase 3's
 *    continuation, which reads the same coverage.
 * 2. A single-step plan with shipped work is settled — closed when its merged
 *    PR closes the issue, parked for a human otherwise.
 * 3. A plan stamped with a body hash — still current, since the stale check
 *    above re-plans one that is not — goes back to Awaiting plan review.
 * 4. Anything else is re-planned.
 *
 * The backstop for any writer that strips `Refined` or `Ready` without saying
 * where the issue goes next. Exported for tests.
 */
export async function settlePlanningIssue(
  repoFullName: string,
  issue: gh.Issue,
  comments: gh.IssueComment[],
  plannedBodyHash: string | null,
  planText: string | null = planParser.findPlanComment(comments),
): Promise<"pending" | "implementing" | "settled" | "continuing" | "review" | "replan"> {
  if (await db.hasPendingIssueRefinerWork(repoFullName, issue.number)) {
    log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: in Planning awaiting its re-plan`);
    return "pending";
  }
  if (await db.hasRunningTask("issue-worker", repoFullName, issue.number)) return "implementing";
  const peek = await peekTotalPhases(repoFullName, issue.number, planText);
  if (peek.totalPhases > 1) {
    const { coverage } = await loadIssuePhaseState(repoFullName, issue.number, comments, { planText, stored: peek.stored });
    if (coverage.covered.size > 0) return "continuing";
  } else if (await issueHasShippedWork(repoFullName, issue.number, comments)) {
    const merged = await gh.listMergedPRsForIssue(repoFullName, issue.number);
    if (merged.length > 0) {
      await settleMergedSingleStep(repoFullName, issue.number, merged);
    } else {
      // Shipped through a stored link in another repo, which the branch list
      // cannot see: there is no PR body to read, so a person decides.
      await parkForHuman(repoFullName, issue.number,
        `The plan's only step has landed but this issue is still open — close it if the work is done, or re-plan the remainder.`,
        "Planner", { slug: "single-step-landed", comments });
    }
    return "settled";
  }
  if (plannedBodyHash !== null) {
    log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: in Planning with a current plan and no planner queued — returning it to plan review`);
    await returnToPlanReview(repoFullName, issue.number);
    return "review";
  }
  log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: in Planning with no planner queued — re-planning`);
  await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repoFullName, issue.number, {
    priority: gh.hasPriorityLabel(issue.labels),
  });
  return "replan";
}

/**
 * The issues of `issues` whose design change is still pending re-approval
 * after this tick's level-triggered approval check (`reapproval.ts`): a
 * pending change is approved here when its issue carries `Refined` or its
 * approved requirements version has reached the pending one. Runs before
 * Phase 1 so a `Refined` applied as the approval approves the change before
 * anything reads it as "implement the plan". One batched read; with nothing
 * pending fleet-wide it resolves no tracker ids. An issue whose check fails is
 * reported as pending, so the implementer waits a tick instead.
 */
async function settlePendingReapprovals(repoFullName: string, issues: readonly gh.Issue[]): Promise<Set<IssueRef>> {
  const pending = new Set<IssueRef>();
  let all: Set<string>;
  try {
    all = await db.listPendingReapprovalIssueIds();
  } catch (err) {
    log.warn(`[issue-dispatcher] Could not read pending re-approvals for ${repoFullName} — holding every issue's implementer this tick: ${err}`);
    for (const issue of issues) pending.add(issue.number);
    return pending;
  }
  if (all.size === 0) return pending;
  for (const issue of issues) {
    try {
      const trackerId = await resolveTrackerId(repoFullName, issue.number);
      if (!trackerId || !all.has(trackerId)) continue;
      if (await reapproval.settlePendingReapproval(trackerId, issue.labels.map((l) => l.name))) {
        log.info(`[issue-dispatcher] ${repoFullName}#${issue.number}: design change pending re-approval — not implementing`);
        pending.add(issue.number);
      }
    } catch (err) {
      log.warn(`[issue-dispatcher] Re-approval check failed for ${repoFullName}#${issue.number}: ${err}`);
      pending.add(issue.number);
    }
  }
  return pending;
}

export async function run(repos: Repo[]): Promise<void> {
  // The breaker is GitHub-only, so skip GitHub repos and let Forgejo ones
  // dispatch normally — their reads never touch GitHub's budget (#3221).
  let active = repos;
  if (isRateLimited()) {
    active = repos.filter((r) => !isRepoRateLimited(r.fullName));
    const skipped = repos.length - active.length;
    if (skipped > 0) {
      log.warn(`[issue-dispatcher] Skipping ${skipped} GitHub repo(s) — API rate limited ${describeRateLimit()}`);
    }
    if (active.length === 0) return;
  }
  // One read per tick for every repo's writer dispatch. A failure skips the
  // writer this tick rather than the planner.
  let latestRequirements: Promise<Map<string, db.ClawsIssueRequirementsRow> | null> | null = null;
  const loadLatestRequirements = () => latestRequirements ??= clawsIssues.getLatestRequirementsForOpenIssues().catch((err) => {
    log.warn(`[issue-dispatcher] Could not read requirements versions — skipping the requirements writer this tick: ${err}`);
    return null;
  });
  // One read per tick for every repo's re-plan check below, instead of a
  // `getClawsIssue` + `listClawsIssueRequirements` per issue on every tick. A
  // failed batch read reports every issue's lookup as "error" this tick (see
  // `approvedRequirementsForIssue`) rather than falling back to per-issue reads.
  let approvedRequirementsBatch: Promise<Map<string, ApprovedRequirements> | null> | null = null;
  const loadApprovedRequirementsBatch = () => approvedRequirementsBatch ??= loadApprovedRequirementsForOpenIssues().catch((err) => {
    log.warn(`[issue-dispatcher] Could not batch-read approved requirements — skipping the re-plan check this tick: ${err}`);
    return null;
  });
  const approvedRequirementsForIssue = async (repoFullName: string, issueNumber: IssueRef): Promise<ApprovedRequirementsResult> => {
    const batch = await loadApprovedRequirementsBatch();
    return batch ? approvedRequirementsFromBatch(repoFullName, issueNumber, batch) : { status: "error" };
  };
  await Promise.allSettled(
    active.map(async (repo) => {
      // Note: all repo callbacks start concurrently, so this check does not prevent
      // other repos from being dispatched — it only short-circuits the current repo's
      // work if rate limiting is already detected when its callback begins executing.
      if (isRepoRateLimited(repo.fullName)) return;
      try {
        const processedByWorker = new Set<IssueRef>();
        const populated = new Set<IssueRef>();

        // ── Unpark issues whose last open dependency has closed (docs/issue-tracker.md#links) ──
        // Before the listing, and never fatal: a sweep failure must not cost
        // the repo its dispatch cycle. Released issues skip Phases 2 and 3 this
        // tick: the sweep already re-planned the ones that need it, and the
        // native listing reads their new lifecycle.
        try {
          for (const id of await issueLinks.releaseDependencyParkedIssues(repo.fullName)) processedByWorker.add(id);
        } catch (err) {
          reportError("issue-dispatcher:release-dependencies", repo.fullName, err, { repo: repo.fullName });
        }

        const allIssues = await gh.listOpenIssues(repo.fullName);

        // ── Design changes pending re-approval: approve, or hold the implementer ──
        const reapprovalPending = await settlePendingReapprovals(repo.fullName, allIssues);

        // ── Phase 1: Refined issues → implementer ──
        if (!isAgentDisabled("implementer")) {
          const refinedIssues = allIssues.filter((i) =>
            i.labels.some((l) => l.name === LABELS.refined),
          );
          for (const issue of refinedIssues) {
            if (isRepoRateLimited(repo.fullName)) break;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (reapprovalPending.has(issue.number)) continue;
            if (await hasOpenDependencies(repo.fullName, issue.number)) continue;
            if (!await gh.isAllowedActor(issue.author.login, repo.fullName, issue.number) && !gh.isCiAlertBotAuthor(issue, repo.fullName)) {
              if (gh.isDependencyBotAuthor(issue)) {
                log.info(`[issue-dispatcher] Skipping issue #${issue.number} from dependency bot @${issue.author.login}`);
                continue;
              }
              log.info(`[issue-dispatcher] Skipping refined issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }

            // A human applied `Refined` while their own comment after the plan is
            // still unaddressed. Implementing now would build the old plan while the
            // issue text says something else (#2763). Strip `Refined`, hand the issue
            // to the planner, and let the human re-apply it against the updated plan.
            const { hasPlan, unreacted } = await issueRefiner.findUnreactedFeedbackAfterPlan(
              repo.fullName, issue.number, await gh.getSelfLoginForIssue(repo.fullName, issue.number),
            );
            // A `claws-phase-done:` claim is coverage information for the implementer,
            // not feedback on the plan — exclude it so multi-PR continuations aren't
            // blocked by their own progress-tracking comments.
            const pendingFeedback = unreacted.filter((c) => !isPhaseClaimOnly(c.body));
            if (hasPlan && pendingFeedback.length > 0) {
              await issueRefiner.stripRefinedForPendingFeedback(repo.fullName, issue.number, pendingFeedback, "Planner");
              // Phase 3 must not pick this issue up as a multi-PR continuation this tick.
              processedByWorker.add(issue.number);
              if (!isAgentDisabled("planner")) {
                await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, {
                  ...issue,
                  labels: issue.labels.filter((l) => l.name !== LABELS.refined && l.name !== LABELS.ready),
                }, "issue");
                // Any open step PR, in any of the issue's repos, makes this a
                // follow-up rather than a re-plan.
                const openPRs = await listOpenPhasePRs(repo.fullName, issue.number);
                // Each enqueue is a candidate, not a decision: workers claim by
                // Priority, then stage rank, then age, and re-enqueueing every
                // tick refreshes a queued row's Priority flag from the live label.
                await worker.enqueue(
                  openPRs.length > 0 ? AGENT_KINDS.ISSUE_REFINER_FOLLOWUP : AGENT_KINDS.ISSUE_REFINER_REFINE,
                  repo.fullName, issue.number,
                  { priority: gh.hasPriorityLabel(issue.labels) },
                );
              }
              continue;
            }

            processedByWorker.add(issue.number);
            populated.add(issue.number);
            gh.populateQueueCacheFor("refined", repo.fullName, issue, "issue");
            await worker.enqueue(AGENT_KINDS.ISSUE_WORKER, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        // ── Phase 2: Plan/refine → planner ──
        if (!isAgentDisabled("planner")) {
          for (const issue of allIssues) {
            if (isRepoRateLimited(repo.fullName)) break;
            // Handed on already this tick — including an issue the sweep above
            // just unparked, which it re-planned itself when that was needed.
            if (processedByWorker.has(issue.number)) continue;
            if (gh.isDispatchSkippable(repo.fullName, issue)) continue;
            if (!await gh.isAllowedActor(issue.author.login, repo.fullName, issue.number) && !gh.isCiAlertBotAuthor(issue, repo.fullName)) {
              if (gh.isDependencyBotAuthor(issue)) {
                log.info(`[issue-dispatcher] Skipping issue #${issue.number} from dependency bot @${issue.author.login}`);
                continue;
              }
              log.info(`[issue-dispatcher] Skipping planner dispatch for issue #${issue.number} from non-allowed actor @${issue.author.login}`);
              await notifyUntrustedActorSkip(repo.fullName, issue);
              continue;
            }
            if (issue.labels.some((l) => l.name === LABELS.refined)) continue;
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) {
              // A duplicate is closed, not left open in a column that reads as
              // work to do (#clw_01M4EPRM9SYVGFG2BTZTMQEKDJ).
              try {
                await settleDuplicate(repo.fullName, issue);
              } catch (err) {
                log.warn(`[issue-dispatcher] Could not close duplicate ${repo.fullName}#${issue.number}: ${err}`);
              }
              continue;
            }

            // Check for follow-up comments on issues with an open PR — any step's,
            // in any of the issue's repos.
            const openPRs = await listOpenPhasePRs(repo.fullName, issue.number);
            if (openPRs.length > 0) {
              // A duplicate verdict is settled whether or not a PR is open.
              const dupComments = await gh.getIssueComments(repo.fullName, issue.number);
              if (isDuplicateToSettle(issue.labels, dupComments)) {
                try {
                  await settleDuplicate(repo.fullName, issue, dupComments);
                } catch (err) {
                  log.warn(`[issue-dispatcher] Could not close duplicate ${repo.fullName}#${issue.number}: ${err}`);
                }
                continue;
              }
              const { hasPlan, unreacted } = await issueRefiner.findUnreactedFeedbackAfterPlan(
                repo.fullName, issue.number, await gh.getSelfLoginForIssue(repo.fullName, issue.number),
              );
              if (hasPlan && unreacted.length > 0) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_FOLLOWUP, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              }
              continue;
            }

            // A pending design change's plan is stamped against requirements
            // nobody has approved yet, so it reads as stale: no re-plan, no
            // refine and no auto-Refined until the operator decides. Follow-ups
            // above still run, and a second design change replaces this one.
            if (reapprovalPending.has(issue.number)) continue;

            // Triage-before-refinement: skip [claws-error] issues without triage report
            if (extractFingerprint(issue.title) !== null) {
              const comments = await gh.getIssueComments(repo.fullName, issue.number);
              const hasReport = comments.some((c) => c.body.includes(CLAWS_ERROR_REPORT_HEADER));
              if (!hasReport) continue;
            }

            // Fetch comments to determine state
            const { hasPlan, unreacted: unreactedComments, plannedOccurrences, hasEscalationReview, plannedBodyHash } = await issueRefiner.findUnreactedFeedbackAfterPlan(
              repo.fullName, issue.number, await gh.getSelfLoginForIssue(repo.fullName, issue.number),
            );

            // The promotion gate (docs/refinements/issue-flow.md "Promotion"):
            // an issue in Ideas gets the requirements writer and never the
            // planner. A forge issue that already has a plan is past Ideas
            // whatever its shadow says — shadows predate the requirements
            // stage, and the boot migration could not see forge plan comments.
            const native = isClawsIssueId(canonicalIssueRef(issue.number) ?? issue.number);
            const stage = (native || !hasPlan) ? await issueLifecycle(repo.fullName, issue) : undefined;
            const inIdeas = stage?.lifecycle === "ideas";
            const writerDisabled = isAgentDisabled("requirements-writer");

            if ((!hasPlan || inIdeas) && !writerDisabled) {
              const latest = await loadLatestRequirements();
              if (latest) {
                try {
                  await dispatchRequirementsWriter(repo.fullName, issue, latest);
                } catch (err) {
                  log.warn(`[issue-dispatcher] Requirements writer dispatch failed for ${repo.fullName}#${issue.number}: ${err}`);
                }
              }
            }
            if (stage?.lifecycle === "ideas") {
              // Level-triggered promotion: an issue can sit here with an
              // unpromoted requirements version already on record — written
              // before an auto-promote listener existed, or by a writer run
              // that predates this deploy — so promoting only on the version
              // write leaves it stuck. With the writer disabled outright no
              // version will ever land, so this checks every tick instead,
              // and treats "no version, and none is coming" as ready too.
              try {
                const requirementsReady = writerDisabled || !!(await loadLatestRequirements())?.get(stage.trackerId);
                await clawsIssues.autoPromoteIfDue(stage.trackerId, requirementsReady);
              } catch (err) {
                log.warn(`[issue-dispatcher] Auto-promotion check failed for ${repo.fullName}#${issue.number}: ${err}`);
              }
              continue;
            }

            if (!hasPlan) {
              // No plan comment exists — produce a new plan
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_PLAN, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else if (unreactedComments.length > 0) {
              // Human feedback needs addressing
              populated.add(issue.number);
              gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
              await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
              await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REFINE, repo.fullName, issue.number, {
                priority: gh.hasPriorityLabel(issue.labels),
              });
            } else {
              // A plan that is a `CLAWS_DUPLICATE_OF:` verdict, without the
              // label (removed by hand, or never applied): close it rather than
              // offer the pointer for approval.
              const planComments = await gh.getIssueComments(repo.fullName, issue.number);
              const planText = planParser.findPlanComment(planComments);
              if (isDuplicateToSettle(issue.labels, planComments, planText)) {
                try {
                  await settleDuplicate(repo.fullName, issue, planComments);
                } catch (err) {
                  log.warn(`[issue-dispatcher] Could not close duplicate ${repo.fullName}#${issue.number}: ${err}`);
                }
                continue;
              }

              // A Priority monitor alert now has a plan and no outstanding feedback —
              // hand it to the escalation reviewer, which decides whether to auto-apply
              // `Refined` or escalate to a human.
              //
              // This MUST run before the re-plan check below: these alert issues bump
              // their occurrence count on every monitor tick, so the re-plan trigger
              // fires almost immediately and would starve the escalation review forever.
              // Checking here and `continue`ing yields exactly one review per posted plan.
              if (!isAgentDisabled("escalation-reviewer")
                  && !hasEscalationReview
                  && escalationReviewer.isEscalationCandidate(issue, await gh.getSelfLoginForIssue(repo.fullName, issue.number))) {
                populated.add(issue.number);
                gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                await worker.enqueue(AGENT_KINDS.ESCALATION_REVIEW, repo.fullName, issue.number, { priority: true });
                continue;
              }

              // The issue, or its approved requirements record, changed after its plan
              // was written — the plan no longer describes the issue, so re-plan rather
              // than parking it as "ready" (#2524).
              const syntheticPlanBody = plannedBodyHash !== null
                ? `${issueRefiner.PLAN_BODY_HASH_MARKER} ${plannedBodyHash}`
                : null;
              const approvedRequirementsResult = syntheticPlanBody !== null
                ? await approvedRequirementsForIssue(repo.fullName, issue.number)
                : null;
              // A failed read is reported as "error", never folded into "no record" —
              // treating it as such would compare against a body-only hash and could
              // find a record-stamped plan falsely stale, stripping `Ready` for no
              // reason. Skip the whole re-plan check for this tick instead.
              const approvedRequirements = approvedRequirementsResult?.status === "approved" ? approvedRequirementsResult.record : null;
              const requirementsReadFailed = approvedRequirementsResult?.status === "error";
              if (!requirementsReadFailed && syntheticPlanBody !== null && issueRefiner.isPlanStaleForIssue(syntheticPlanBody, issue.title, issue.body, approvedRequirements)) {
                // allIssues is 60 s cached — confirm uncached before spending a planner run.
                const live = await gh.getIssueTitleBody(repo.fullName, issue.number).catch(() => null);
                if (live && issueRefiner.isPlanStaleForIssue(syntheticPlanBody, live.title, live.body, approvedRequirements)) {
                  // Multi-PR continuations are deliberately not gated, mirroring the
                  // implementer's guard in `issue-worker.processIssue`: phase 2+ follows
                  // a plan that was already agreed and partly shipped, so re-planning
                  // mid-way would strand the merged phases — and would race Phase 3
                  // below, which re-applies `Refined` to continue the very same plan.
                  if (await issueHasShippedWork(repo.fullName, issue.number)) {
                    log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number} has a stale plan but merged PR(s) — leaving the agreed plan in place`);
                  } else {
                    populated.add(issue.number);
                    gh.populateQueueCacheFor("needs-refinement", repo.fullName, issue, "issue");
                    await gh.removeLabel(repo.fullName, issue.number, LABELS.ready);
                    log.info(`[issue-dispatcher] Re-planning ${repo.fullName}#${issue.number}: issue or approved requirements changed since the plan was written`);
                    await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, issue.number, {
                      priority: gh.hasPriorityLabel(issue.labels),
                    });
                    continue;
                  }
                }
              }

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
                await worker.enqueue(AGENT_KINDS.ISSUE_REFINER_REPLAN, repo.fullName, issue.number, {
                  priority: gh.hasPriorityLabel(issue.labels),
                });
              } else if (!issue.labels.some((l) => l.name === LABELS.ready) && !issue.labels.some((l) => l.name === LABELS.refined)) {
                // Planned, in Planning, with neither label. Planning means "the
                // planner is queued or running", so make that true or move the
                // issue on — never park it here silently.
                populated.add(issue.number);
                if (requirementsReadFailed) {
                  gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                  log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: in Planning, approved requirements unreadable this tick — leaving it`);
                } else {
                  try {
                    const outcome = await settlePlanningIssue(repo.fullName, issue, planComments, plannedBodyHash, planText);
                    gh.populateQueueCacheFor(outcome === "replan" || outcome === "pending" ? "needs-refinement" : "ready", repo.fullName, issue, "issue");
                  } catch (err) {
                    log.warn(`[issue-dispatcher] Could not settle Planning issue ${repo.fullName}#${issue.number}: ${err}`);
                  }
                }
              } else {
                populated.add(issue.number);
                gh.populateQueueCacheFor("ready", repo.fullName, issue, "issue");
                if (issueRefiner.isAutoRefineIssue(issue) && !issue.labels.some((l) => l.name === LABELS.refined)) {
                  // Don't hand the implementer an issue whose every plan phase is already
                  // covered: its all-covered guard strips `Refined` in seconds and we re-apply
                  // it on the next tick, relabelling forever (#2821). Same predicate Phase 3
                  // uses below; Phase 3 misses this case because it only runs for
                  // `totalPhases > 1`, and a re-plan that drops `### PR N:` headers is exactly
                  // what collapses the count to 1.
                  if (planText && issueRefiner.hasStepBackReconsiderMarker(planText)) {
                    log.info(`[issue-dispatcher] Not auto-refining ${repo.fullName}#${issue.number}: planner step-back verdict was "reconsider" — awaiting human Refined`);
                  } else {
                    const { totalPhases, coverage } = await loadIssuePhaseState(repo.fullName, issue.number, planComments, { planText });
                    if (coverage.nextPhase === null) {
                      log.info(`[issue-dispatcher] Not auto-refining ${repo.fullName}#${issue.number}: all ${totalPhases} plan phase(s) already covered`);
                    } else if (coverage.readyPhases.length === 0 && coverage.awaitingOperator.length > 0) {
                      log.info(`[issue-dispatcher] Not auto-refining ${repo.fullName}#${issue.number}: only the operator step ${coverage.awaitingOperator.join(", ")} remains`);
                    } else if (coverage.readyPhases.length === 0) {
                      log.info(`[issue-dispatcher] Not auto-refining ${repo.fullName}#${issue.number}: no plan phase is ready — open: ${coverage.openPhases.join(", ") || "none"}, blocked: ${coverage.blockedPhases.join(", ") || "none"}`);
                    } else {
                      await gh.addLabel(repo.fullName, issue.number, LABELS.refined);
                      log.info(`[issue-dispatcher] Auto-refined issue ${repo.fullName}#${issue.number}`);
                    }
                  }
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
            if (reapprovalPending.has(issue.number)) continue;
            if (await hasOpenDependencies(repo.fullName, issue.number)) continue;
            if (issue.labels.some((l) => l.name === LABELS.duplicate)) continue;

            const comments = await gh.getIssueComments(repo.fullName, issue.number);
            const planText = planParser.findPlanComment(comments);
            const peek = await peekTotalPhases(repo.fullName, issue.number, planText);
            if (peek.totalPhases <= 1) continue;

            // The stored PR list when there is one, the plan's `### PR N:` headers
            // otherwise. Steps shipped out-of-band (a human PR, an interactive session, an
            // explicit claim) count as covered — otherwise the dispatcher keeps
            // re-dispatching the implementer to redo them (#2594). Coverage, not
            // Claws' own merged-PR count, is also what decides whether this issue
            // is mid-flight at all: gating on `listMergedPRsForIssue` stranded any
            // multi-PR plan whose steps had all been shipped from outside Claws.
            const phaseState = await loadIssuePhaseState(repo.fullName, issue.number, comments, { planText, stored: peek.stored });
            const { totalPhases, coverage } = phaseState;
            if (coverage.covered.size === 0) continue;
            if (coverage.nextPhase === null) {
              // Every step has landed — typically an operator's
              // `claws-phase-done:` on the plan's manual step, which no merge
              // follows to close the issue.
              if (coverage.done.size >= totalPhases) {
                await closeIssueIfPlanComplete(repo.fullName, issue.number, phaseState, { source: "issue-dispatcher" });
              } else {
                log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: all ${totalPhases} plan phases covered — not continuing`);
              }
              continue;
            }
            if (coverage.readyPhases.length === 0 && coverage.awaitingOperator.length > 0) {
              log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: awaiting the operator on step ${coverage.awaitingOperator.join(", ")} — not continuing`);
              continue;
            }
            // A step whose dependencies have all landed can start while sibling
            // steps' PRs are still open; a plan that declares nothing waits for
            // the previous step, as before.
            if (coverage.readyPhases.length === 0) {
              log.info(`[issue-dispatcher] ${repo.fullName}#${issue.number}: no plan phase is ready — open: ${coverage.openPhases.join(", ") || "none"}, blocked: ${coverage.blockedPhases.join(", ") || "none"}`);
              continue;
            }

            await worker.enqueue(AGENT_KINDS.ISSUE_WORKER_CONTINUE, repo.fullName, issue.number, {
              priority: gh.hasPriorityLabel(issue.labels),
            });
          }
        }

        if (!isRepoRateLimited(repo.fullName)) {
          const reconcileCategories: gh.QueueCategory[] = [];
          if (!isAgentDisabled("implementer")) reconcileCategories.push("refined");
          if (!isAgentDisabled("planner")) reconcileCategories.push("needs-refinement", "ready");
          if (reconcileCategories.length > 0) {
            gh.reconcileQueueCache(repo.fullName, reconcileCategories, populated, "issue");
          }
        }
      } catch (err) {
        reportError("issue-dispatcher:list-issues", repo.fullName, err, { repo: repo.fullName });
      }
  }),
  );
}

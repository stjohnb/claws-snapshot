import { LABELS, isJobDisabledForRepo, type Repo } from "../config.js";
import * as gh from "../github.js";
import { findPlanComment } from "../plan-parser.js";
import { prioritiseIssues, type RankedIssue } from "../agents/issue-refiner.js";
import * as slack from "../slack.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

// #2103: "process all issues" mode for incident-heavy repos. Opt-in per repo via
// the /jobs matrix. Works incident-related, non-controversial issues ONE AT A TIME
// in an LLM-assessed priority order: it auto-refines the top issue when its plan is
// a safe mechanical fix (which launches the existing implement→PR→review→merge
// pipeline), and waits for that issue's PR to merge (which closes the issue and
// removes its `Refined` label from the open set) before advancing. Controversial or
// out-of-scope issues are deferred to a human via the `Manual Action` label.
//
// #2356 extends this into "auto-process mode": the ranking pass also marks
// duplicates and closes obsolete issues, and an issue awaiting human input no longer
// halts the whole repo. The mode is toggled per repo from the per-repo dashboard page
// (`/repos/:owner/:name`) as well as the /jobs matrix — both write `enabledJobsByRepo`.
//
// LIMITATION: cross-repo grouping (app + deployment processed as one unit) is not
// implemented — each opted-in repo is processed independently. A follow-up can add
// group-management UI plus a group-aware processor.

// Per-repo backlog signature of the last tick that reached the (expensive, opus)
// ranking call. Load-bearing, not an optimisation: without the plan gate the ranking
// would otherwise fire on every tick for an unchanged backlog.
const lastSignature = new Map<string, string>();

export function resetTriageCacheForTests(): void {
  lastSignature.clear();
}

export async function run(): Promise<void> {
  const repos = (await gh.listRepos()).filter((r) => !isJobDisabledForRepo("sequential-issue-processor", r.fullName));
  if (repos.length === 0) return;
  for (const repo of repos) {
    if (gh.isRateLimited()) return;
    try {
      await processRepo(repo);
    } catch (err) {
      await reportError("sequential-issue-processor:process-repo", repo.fullName, err);
    }
  }
}

async function processRepo(repo: Repo): Promise<void> {
  // 1. Gather candidates.
  const issues = await gh.listOpenIssues(repo.fullName);
  const open = issues.filter(
    (issue) =>
      !gh.isDispatchSkippable(repo.fullName, issue) &&
      !issue.labels.some((l) => l.name === LABELS.duplicate || l.name === LABELS.clawsIgnore),
  );
  // #2356 supersedes #2103's repo-wide halt: an issue awaiting human input no longer
  // blocks the rest of the backlog. Manual Action issues are excluded from candidates
  // and surfaced on the per-repo page instead.
  const candidates = open.filter((issue) => !issue.labels.some((l) => l.name === LABELS.manualAction));

  const signature = [...candidates]
    .sort((a, b) => a.number - b.number)
    .map((i) => `${i.number}:${i.updatedAt}`)
    .join(",");

  // 2. In-flight gate (serialize). An issue carrying `Refined` is being
  // implemented/reviewed/merged; wait for its PR to merge (closing the issue and
  // dropping it from the open set) before advancing. Evaluated over the full open set
  // so a Manual Action issue mid-implementation still serialises.
  if (open.some((issue) => issue.labels.some((l) => l.name === LABELS.refined))) return;

  // 3. Cooldown. The backlog is unchanged since the last tick that ran the ranking —
  // do not pay for another opus call (or the per-issue comment fetches) to reach the
  // same answer.
  if (lastSignature.get(repo.fullName) === signature) return;

  // 4. Author filter — only trusted actors / CI alert bot.
  const allowed: gh.Issue[] = [];
  for (const issue of candidates) {
    if ((await gh.isAllowedActor(issue.author.login)) || gh.isCiAlertBotAuthor(issue)) allowed.push(issue);
  }
  if (allowed.length === 0) return;

  // 5. Plan gather. Plans are context for the ranking pass; an unplanned backlog is
  // still triaged (duplicates/obsolete), it just cannot be auto-refined yet.
  const withPlans: { issue: gh.Issue; planText: string | null }[] = [];
  for (const issue of allowed) {
    const comments = await gh.getIssueComments(repo.fullName, issue.number);
    withPlans.push({ issue, planText: findPlanComment(comments) });
  }

  // 6. Prioritise (LLM). Ordering + per-issue classification over the full set.
  const ranking = await prioritiseIssues(repo.fullName, withPlans);
  if (ranking === null) return;
  lastSignature.set(repo.fullName, signature);

  const candidateNumbers = new Set(withPlans.map((c) => c.issue.number));

  // 7. Triage. Mark duplicates and close obsolete issues before selecting the next
  // issue to work. Each mutation is isolated — one 404/permission failure must not
  // abort the whole pass.
  let dupCount = 0;
  let closedCount = 0;
  for (const entry of ranking) {
    if (entry.classification !== "duplicate") continue;
    const dup = entry.duplicateOf;
    // The model can hallucinate numbers; only act on a target in this tick's set.
    if (typeof dup !== "number" || dup === entry.number || !candidateNumbers.has(dup)) continue;
    if (!candidateNumbers.has(entry.number)) continue;
    try {
      await gh.ensureLabel(repo.fullName, LABELS.duplicate);
      await gh.addLabel(repo.fullName, entry.number, LABELS.duplicate);
      const body = [
        `This issue appears to share a root cause with #${dup}. See that issue for the full implementation plan.`,
        `CLAWS_DUPLICATE_OF: #${dup}`,
        ``,
        `If you believe this is NOT a duplicate, remove the \`${LABELS.duplicate}\` label — Claws will re-triage it.`,
      ].join("\n");
      await gh.commentOnIssue(repo.fullName, entry.number, body, { agentName: "Auto-Process" });
      dupCount++;
      log.info(`[auto-process] Marked ${repo.fullName}#${entry.number} as duplicate of #${dup}`);
    } catch (err) {
      log.warn(`[auto-process] Failed to mark ${repo.fullName}#${entry.number} duplicate: ${String(err)}`);
    }
  }

  for (const entry of ranking) {
    if (entry.classification !== "obsolete") continue;
    const match = withPlans.find((c) => c.issue.number === entry.number);
    if (!match) continue;
    // Never auto-close prioritised work, or an issue whose fix is already in flight.
    if (match.issue.labels.some((l) => l.name === LABELS.priority)) continue;
    try {
      if ((await gh.getOpenPRForIssue(repo.fullName, entry.number)) !== null) continue;
      const body = [
        `Claws auto-process mode closed this issue as no longer applicable:`,
        ``,
        `> ${entry.reason}`,
        ``,
        `Reopen it if this is wrong.`,
      ].join("\n");
      await gh.commentOnIssue(repo.fullName, entry.number, body, { agentName: "Auto-Process" });
      await gh.closeIssue(repo.fullName, entry.number, "not_planned");
      closedCount++;
      log.info(`[auto-process] Closed ${repo.fullName}#${entry.number} as obsolete — ${entry.reason}`);
    } catch (err) {
      log.warn(`[auto-process] Failed to close ${repo.fullName}#${entry.number} as obsolete: ${String(err)}`);
    }
  }

  // 8. Select. Walk in priority order; drop triaged/out-of-scope entries and any
  // number the model may have hallucinated. First survivor is `next`.
  let next: { entry: RankedIssue; issue: gh.Issue; planText: string | null } | null = null;
  for (const entry of ranking) {
    if (entry.classification === "out_of_scope" || entry.classification === "duplicate" || entry.classification === "obsolete") continue;
    const match = withPlans.find((c) => c.issue.number === entry.number);
    if (!match) continue;
    next = { entry, issue: match.issue, planText: match.planText };
    break;
  }
  if (next === null) {
    notifyTriage(repo.fullName, dupCount, closedCount, null);
    return;
  }

  // 9. Act.
  if (next.entry.classification === "needs_human") {
    await gh.addLabel(repo.fullName, next.issue.number, LABELS.manualAction);
    const followUp = next.planText === null
      ? `Claws has not posted an implementation plan for this issue yet; please assess it directly, then`
      : `Please review the proposed plan, then`;
    const body = [
      `Claws paused autonomous processing on this issue: it is in scope for incident`,
      `handling but needs human judgement before proceeding.`,
      ``,
      `> ${next.entry.reason}`,
      ``,
      `${followUp} remove the **${LABELS.manualAction}** label`,
      `(or apply **${LABELS.refined}** manually) to continue sequential processing.`,
    ].join("\n");
    await gh.commentOnIssue(repo.fullName, next.issue.number, body, { agentName: "Sequential Processor" });
    log.info(`[sequential] ${repo.fullName}#${next.issue.number} needs human review — ${next.entry.reason}`);
    notifyTriage(repo.fullName, dupCount, closedCount, next.entry.number, "needs_human");
    return;
  }

  // next.entry.classification === "auto"
  // The top-priority issue may not be planned yet — the backlog is triaged whether or
  // not anything is planned. Wait for the planner; do not skip ahead.
  if (next.planText === null) {
    notifyTriage(repo.fullName, dupCount, closedCount, null);
    return;
  }
  // Defensive in-flight guard.
  if ((await gh.getOpenPRForIssue(repo.fullName, next.issue.number)) !== null) {
    notifyTriage(repo.fullName, dupCount, closedCount, null);
    return;
  }

  await gh.addLabel(repo.fullName, next.issue.number, LABELS.refined);
  log.info(`[sequential] Auto-refined ${repo.fullName}#${next.issue.number} — ${next.issue.title}`);
  notifyTriage(repo.fullName, dupCount, closedCount, next.issue.number, "auto");
}

/** At most one Slack line per repo per tick, and only when something actually changed. */
function notifyTriage(
  repoFullName: string,
  dupCount: number,
  closedCount: number,
  nextNumber: number | null,
  classification?: string,
): void {
  if (dupCount === 0 && closedCount === 0 && nextNumber === null) return;
  const parts = [`${dupCount} duplicate(s)`, `${closedCount} closed as obsolete`];
  if (nextNumber !== null) parts.push(`next #${nextNumber} (${classification})`);
  slack.notify(`:broom: [auto-process] ${repoFullName}: ${parts.join(", ")}`);
}

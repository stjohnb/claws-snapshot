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
// LIMITATION: cross-repo grouping (app + deployment processed as one unit) is not
// implemented — each opted-in repo is processed independently. A follow-up can add
// group-management UI plus a group-aware processor.

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
  const candidates = issues.filter(
    (issue) =>
      !gh.isDispatchSkippable(repo.fullName, issue) &&
      !issue.labels.some((l) => l.name === LABELS.duplicate || l.name === LABELS.clawsIgnore),
  );

  // 2. In-flight gate (serialize). An issue carrying `Refined` is being
  // implemented/reviewed/merged; wait for its PR to merge (closing the issue and
  // dropping it from the open set) before advancing.
  if (candidates.some((issue) => issue.labels.some((l) => l.name === LABELS.refined))) return;

  // 3. Blocked gate. Any `Manual Action` issue in the repo holds this job until a
  // human clears the label — intended conservative behaviour for incident
  // sequencing; we do not skip ahead to a lower-priority issue.
  if (candidates.some((issue) => issue.labels.some((l) => l.name === LABELS.manualAction))) return;

  // 4. Author filter — only trusted actors / CI alert bot.
  const allowed: gh.Issue[] = [];
  for (const issue of candidates) {
    if ((await gh.isAllowedActor(issue.author.login)) || gh.isCiAlertBotAuthor(issue)) allowed.push(issue);
  }
  if (allowed.length === 0) return;

  // 5. Plan gather + cheap guard. Skip the opus call entirely until something is
  // planned.
  const withPlans: { issue: gh.Issue; planText: string | null }[] = [];
  for (const issue of allowed) {
    const comments = await gh.getIssueComments(repo.fullName, issue.number);
    withPlans.push({ issue, planText: findPlanComment(comments) });
  }
  if (!withPlans.some((c) => c.planText !== null)) return;

  // 6. Prioritise (LLM). Ordering + per-issue classification over the full set.
  const ranking = await prioritiseIssues(repo.fullName, withPlans);
  if (ranking === null) return;

  // 7. Select. Walk in priority order; drop out-of-scope entries and any number the
  // model may have hallucinated. First survivor is `next`.
  let next: { entry: RankedIssue; issue: gh.Issue; planText: string | null } | null = null;
  for (const entry of ranking) {
    if (entry.classification === "out_of_scope") continue;
    const match = withPlans.find((c) => c.issue.number === entry.number);
    if (!match) continue;
    next = { entry, issue: match.issue, planText: match.planText };
    break;
  }
  if (next === null) return;

  // 8. Act.
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
    slack.notify(`:raised_hand: [sequential] ${repo.fullName}#${next.issue.number} needs human review — ${next.entry.reason}`);
    return;
  }

  // next.entry.classification === "auto"
  // The top-priority issue may not be planned yet (step 5 only requires SOME
  // candidate to have a plan). Wait for the planner — do not skip ahead.
  if (next.planText === null) return;
  // Defensive in-flight guard.
  if ((await gh.getOpenPRForIssue(repo.fullName, next.issue.number)) !== null) return;

  await gh.addLabel(repo.fullName, next.issue.number, LABELS.refined);
  log.info(`[sequential] Auto-refined ${repo.fullName}#${next.issue.number} — ${next.issue.title}`);
  slack.notify(`:white_check_mark: [sequential] Auto-refined ${repo.fullName}#${next.issue.number} — ${next.issue.title}`);
}

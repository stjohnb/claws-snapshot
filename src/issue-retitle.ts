/**
 * Renaming an issue whose body has not changed without staling its plan. The
 * issue title is part of the plan's `CLAWS_PLAN_BODY_HASH`, so a bare rename
 * would re-plan the issue and withdraw its approval; this re-stamps the plan
 * comment's hash for the new title when the plan was current before the
 * rename. Used by the contract scanners' follow-up issues
 * (`refreshFollowUpIssue` in `contract-drift.ts`).
 */
import * as gh from "./github.js";
import * as clawsIssues from "./claws-issues.js";
import * as log from "./log.js";
import { loadApprovedRequirements } from "./approved-requirements.js";
import { issueContentHash, PLAN_BODY_HASH_MARKER, PLAN_HEADER } from "./agents/issue-refiner.js";
import { parsePlanBodyHash } from "./marker-text.js";

/**
 * Sets issue `id`'s title to `newTitle`, keeping its plan current: when the
 * latest Claws plan comment's hash equals `issueContentHash(oldTitle, body,
 * requirements)`, it is replaced by the hash for `newTitle`. A stale plan, or
 * no plan, is left alone. Returns false, having written nothing, when the
 * approved requirements cannot be read (the next scan retries). A failed
 * re-stamp after the rename logs `warn` and is not thrown; the cost is one
 * re-plan of the issue.
 */
export async function retitleKeepingPlanCurrent(
  repo: string,
  id: string,
  oldTitle: string,
  body: string,
  newTitle: string,
): Promise<boolean> {
  const requirements = await loadApprovedRequirements(repo, id);
  if (requirements.status === "error") return false;
  const record = requirements.status === "approved" ? requirements.record : null;
  const plan = (await gh.getIssueComments(repo, id)).findLast((c) => c.body.includes(PLAN_HEADER) && gh.isClawsComment(c.body));
  const stamp = plan ? parsePlanBodyHash(plan.body) : null;
  await clawsIssues.editIssueTitle(id, newTitle);
  if (!plan || !stamp || stamp !== issueContentHash(oldTitle, body, record)) return true;
  try {
    const hash = issueContentHash(newTitle, body, record);
    const hashRe = new RegExp(`${PLAN_BODY_HASH_MARKER}\\s*[0-9a-f]{64}`, "g");
    const restamped = gh.stripClawsMarker(plan.body).replace(hashRe, `${PLAN_BODY_HASH_MARKER} ${hash}`);
    await gh.editIssueComment(repo, plan.id, restamped, { agentName: "Planner" });
    log.info("plan hash re-stamped after retitle", { component: "issue-retitle", repo, issue: id, comment: String(plan.id) });
  } catch (err) {
    log.warn("plan hash re-stamp after retitle failed", {
      component: "issue-retitle",
      repo,
      issue: id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

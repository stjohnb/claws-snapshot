/**
 * Which issues are awaiting the operator, for the board, the nav counts and
 * `issue-stage.ts`. Service-side only: kept out of `planned-prs.ts` because that
 * module is in the agent-pod graph and no pod reads this.
 */

import * as gh from "./github.js";
import * as db from "./db.js";
import * as log from "./log.js";
import * as clawsIssues from "./claws-issues.js";
import { parsePhaseClaims } from "./phase-coverage.js";
import { mapWithConcurrency } from "./util.js";

const CONCURRENCY = 4;

/**
 * The subset of `issueIds` (tracker ids) awaiting the operator, mapped to the
 * lowest manual step not yet claimed done: {@link db.getIssueIdsAwaitingOperator}'s
 * candidates, less any whose every manual step is claimed by an allowed actor's
 * `claws-phase-done:` comment. A plan whose every step is done is not awaiting
 * anyone, so it is not shown in Awaiting merge (#clw_01M4ZN75K7GK0G7AFZEHBNCWD5).
 * A manual step's "done" depends only on those claims, so this makes no PR
 * reads. A candidate whose read fails is kept (as the SQL reported it) and logged.
 */
export async function issuesAwaitingOperator(issueIds: readonly string[]): Promise<Map<string, { position: number; title: string }>> {
  const candidates = await db.getIssueIdsAwaitingOperator(issueIds);
  if (candidates.size === 0) return candidates;
  const resolved = await mapWithConcurrency([...candidates], CONCURRENCY, async ([id, step]) => {
    try {
      const planned = await db.getIssuePlannedPRs(id);
      const manual = planned.filter((e) => e.kind === "manual");
      const record = await clawsIssues.getIssue(id);
      const repo = clawsIssues.primaryRepo(record?.repos ?? []);
      const comments = await gh.getIssueComments(repo, id);
      const claims = await parsePhaseClaims(comments, (login) => gh.isAllowedActor(login, repo, id), planned.length);
      const open = manual.find((e) => !claims.has(e.position));
      if (!open) return null;
      return [id, { position: open.position, title: open.title }] as const;
    } catch (err) {
      log.warn(`[awaiting-operator] Could not read the manual step claims of ${id}: ${err}`);
      return [id, step] as const;
    }
  });
  const out: Map<string, { position: number; title: string }> = new Map();
  for (const r of resolved) if (r) out.set(r[0], r[1]);
  return out;
}

import { canonicalIssueRef, type IssueRef } from "../issue-id.js";
import type { Repo } from "../config.js";
import * as gh from "../github.js";
import * as db from "../db.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";

const NAME = "issue-shadow-sync";

/**
 * Direct `gh.getIssueState` reads per repository per run.
 *
 * Only shadows *missing* from the open listing need one, which today is a
 * handful per repository — the listing caps at 100 and the largest managed
 * repo has 17 open issues, so a shadow is normally absent because its forge
 * issue really was closed. The cap is what keeps the cost bounded anyway if a
 * repo ever does grow past the listing cap: `listShadowIssues` hands the
 * shadows over least-recently-checked first, so a capped run works through the
 * whole set across runs rather than re-reading the same few forever.
 */
export const CLOSE_CHECK_CAP = 25;

/** Map key for a forge number, so `7` and `"7"` land on the same shadow. */
function refKey(ref: IssueRef): string {
  return String(canonicalIssueRef(ref) ?? ref);
}

/**
 * The forge's close reason, narrowed to what `claws_issues.state_reason` holds.
 *
 * GitHub answers the GraphQL enum (`COMPLETED`, `NOT_PLANNED`, `REOPENED`) and
 * the other backends a lower-case column, so anything unrecognised — including
 * `REOPENED` on an issue the listing no longer carries — records no reason
 * rather than a value no other reader of the column would understand.
 */
function toStateReason(raw: string | null): "completed" | "not_planned" | null {
  const value = (raw ?? "").toLowerCase();
  return value === "completed" || value === "not_planned" ? value : null;
}

/** True when the forge issue says something the shadow does not already say. */
function differs(
  shadow: db.ShadowIssueRecord,
  next: { title: string; body: string; labels: string[] },
): boolean {
  if (shadow.state !== "open" || shadow.title !== next.title || shadow.body !== next.body) return true;
  const current = new Set(shadow.labels);
  const wanted = new Set(next.labels);
  return current.size !== wanted.size || [...wanted].some((l) => !current.has(l));
}

async function syncRepo(repo: string): Promise<void> {
  // Native issues are already `claws_issues` rows; only a forge-filed issue
  // needs a shadow standing in for it.
  const forgeIssues = (await gh.listOpenIssues(repo)).filter((i) => !gh.isNativeIssue(i.number));
  const shadows = await db.listShadowIssues(repo);

  const byNumber = new Map(shadows.map((s) => [refKey(s.forgeNumber), s]));
  const seen = new Set<string>();
  // Every shadow this run looked at, whatever the look found — the fairness
  // marker `listShadowIssues` orders on.
  const examined = new Set<string>();

  for (const issue of forgeIssues) {
    const next = {
      title: issue.title,
      body: issue.body,
      labels: issue.labels.map((l) => l.name),
    };
    const shadow = byNumber.get(refKey(issue.number));

    if (!shadow) {
      // Unconditionally: `createShadowIssue`'s own linkage check answers
      // `undefined` when the row already there names an *imported* issue — a
      // human reopening one puts it back in this listing forever — so the job
      // never has to inspect the linkage row's `kind` itself.
      const created = await db.createShadowIssue(repo, issue.number, {
        title: next.title,
        body: next.body,
        authorLogin: issue.author.login,
        labels: next.labels,
      });
      if (!created) continue;
      if (!created.created) {
        // A shadow that existed but was not in this run's listing — the
        // importer promoted and something re-shadowed it, or the two listings
        // raced. Bring it in line and treat it as examined.
        seen.add(created.id);
        examined.add(created.id);
        await db.updateShadowIssue(created.id, { ...next, state: "open", stateReason: null });
      }
      continue;
    }

    seen.add(shadow.id);
    examined.add(shadow.id);
    if (!differs(shadow, next)) continue;
    const result = await db.updateShadowIssue(shadow.id, { ...next, state: "open", stateReason: null });
    // The importer promoted it between the listing and this write. It is no
    // longer this job's row, so drop it from the run's working set rather than
    // stamping `shadow_checked_at` on an issue. It stays in `seen`: the close
    // check below is for shadows the forge listing did not account for, and
    // this one was accounted for.
    if (result === "not-a-shadow") examined.delete(shadow.id);
  }

  // A shadow that is open here but absent from the open listing is *probably*
  // closed on the forge — but a truncated listing or a transferred issue looks
  // identical, so nothing closes without a direct read saying so.
  const missing = shadows.filter((s) => s.state === "open" && !seen.has(s.id));
  const checks = missing.slice(0, CLOSE_CHECK_CAP);
  if (missing.length > checks.length) {
    log.info(`[${NAME}] ${repo}: ${missing.length} shadow(s) missing from the open listing, checking ${checks.length} this run (cap ${CLOSE_CHECK_CAP})`);
  }

  for (const shadow of checks) {
    // Per shadow, so one unreadable issue — deleted, transferred, or a forge
    // hiccup — costs its own check rather than the repository's whole run. It
    // stays in `examined` either way: a check that keeps failing must still
    // rotate to the back of the queue, or it holds the cap against every
    // shadow behind it forever.
    examined.add(shadow.id);
    try {
      const state = await gh.getIssueState(repo, shadow.forgeNumber);
      if (state.state !== "CLOSED") continue;
      const result = await db.updateShadowIssue(shadow.id, {
        title: shadow.title,
        body: shadow.body,
        labels: state.labels,
        state: "closed",
        stateReason: toStateReason(state.stateReason),
      });
      if (result === "not-a-shadow") examined.delete(shadow.id);
    } catch (err) {
      log.warn(`[${NAME}] ${repo}#${shadow.forgeNumber}: could not confirm the state of shadow ${shadow.id} (${err})`);
    }
  }

  await db.markShadowsChecked([...examined]);
}

/**
 * Keep every open forge issue's shadow in step with the forge (#3246).
 *
 * Its own timer rather than a step inside `issue-dispatcher`: that job is the
 * most critical one on the fleet and should not gain database writes. Nothing
 * here writes to a forge — no label, no comment, no close — and every write it
 * does make goes through `db.ts`'s shadow helpers, which refuse any row that
 * is not a shadow.
 */
export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(
    repos.map(async (repo) => {
      // The breaker is GitHub-only, so Forgejo repos keep syncing — their
      // reads never touch GitHub's budget.
      if (gh.isRepoRateLimited(repo.fullName)) return;
      try {
        await syncRepo(repo.fullName);
      } catch (err) {
        await reportError(`${NAME}:repo`, repo.fullName, err, { repo: repo.fullName });
      }
    }),
  );
}

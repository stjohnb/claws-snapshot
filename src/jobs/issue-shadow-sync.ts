import { canonicalIssueRef, type IssueRef } from "../issue-id.js";
import { forgeIssueUrl, type Repo } from "../config.js";
import * as gh from "../github.js";
import * as db from "../db.js";
import * as clawsIssues from "../claws-issues.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { resolveImportedRef } from "../imported-refs.js";
import { importedBody } from "./issue-importer.js";
import { isAlertBridgeOwned } from "../alert-issue.js";
import { requeueReopenedIssue } from "../alert-bridge.js";
import { replaceLegacyLabels } from "../issue-lifecycle.js";

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
  // `includeImported`: an imported forge issue that is back in the listing is
  // forwarded to its native issue below, so this job must still see it.
  const forgeIssues = (await gh.listOpenIssues(repo, { includeImported: true })).filter((i) => !gh.isNativeIssue(i.number));
  const shadows = await db.listShadowIssues(repo);

  const byNumber = new Map(shadows.map((s) => [refKey(s.forgeNumber), s]));
  const seen = new Set<string>();
  // Every shadow this run looked at, whatever the look found — the fairness
  // marker `listShadowIssues` orders on.
  const examined = new Set<string>();

  for (const issue of forgeIssues) {
    // A retired `Claws Ignore` a human put on the forge issue mirrors as
    // `Backlog`, so the shadow stays parked (#clw_01M55F0ACDZP8ND1BNRZ8TNGPD).
    const next = {
      title: issue.title,
      body: issue.body,
      labels: replaceLegacyLabels(issue.labels.map((l) => l.name)),
    };
    const shadow = byNumber.get(refKey(issue.number));

    if (!shadow) {
      // Unconditionally: `createShadowIssue`'s own linkage check answers
      // `undefined` when the row already there names an *imported* issue — a
      // human reopening one puts it back in this listing forever — so the job
      // never has to inspect the linkage row's `kind` itself. That reopen, or
      // any edit after it, is forwarded to the native issue instead. Per
      // issue, so one failure does not cost the repository's run.
      const created = await db.createShadowIssue(repo, issue.number, {
        title: next.title,
        body: next.body,
        authorLogin: issue.author.login,
        labels: next.labels,
      });
      if (!created) {
        try {
          await forwardImportedUpdate(repo, issue);
        } catch (err) {
          log.warn(`[${NAME}] ${repo}#${issue.number}: could not forward the forge update to its native issue (${err})`);
        }
        continue;
      }
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
        labels: replaceLegacyLabels(state.labels),
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
 * Forward a reopened or edited imported forge issue to its native issue.
 *
 * Once imported, the forge copy is never live work — `gh.listOpenIssues` hides
 * it from everything else — but a human can still reopen or edit it. That is
 * new input to the native issue, so its title and body are brought across, a
 * closed native issue is reopened, and a change sends the native issue back to
 * planning with a re-plan queued ({@link requeueReopenedIssue}). The
 * dispatcher's own stale-plan check would not re-plan an issue that already
 * shipped a fix, which is exactly the state a re-fired alert finds its native
 * issue in.
 *
 * The exception is an edit to an open alert-bridge issue (`isAlertBridgeOwned`
 * on the native labels and new body): the bridge rewrites that body on every
 * alert transition, and the edit cannot be told apart from a human's, so it is
 * forwarded without a re-plan. A reopen of a closed one still re-plans. This
 * alert-bridge case is legacy: the bridges now write their native issue
 * directly through `alert-bridge.ts`, which closes any forge copy left open,
 * so they no longer write forge copies.
 *
 * `imported_issues.forge_synced_at` holds the forge `updatedAt` last
 * processed, and nothing happens until the forge moves past it: without it a
 * native issue closed after its fix would be reopened every run while the
 * forge copy stayed open. `issue-importer` stamps this baseline itself right
 * after it closes the forge copy, so a NULL marker means only a legacy row
 * that predates the column, or an import whose forge close failed partway —
 * never a fresh, fully-finished import. Either way that is a half-finished
 * import for the operator to reconcile, so on an open native issue a NULL
 * marker only records the baseline rather than forwarding anything; on a
 * closed native issue it still counts as a change, since a reopen is the
 * signal worth acting on regardless of how the marker got left NULL.
 *
 * No comment is posted: the bridge rewrites its body on every alert
 * transition, and a comment each time would be comment spam. The reopen and
 * edit events are the record.
 */
async function forwardImportedUpdate(repo: string, issue: gh.Issue): Promise<void> {
  const nativeId = resolveImportedRef(repo, issue.number);
  const ref = `${repo}#${issue.number}`;
  if (!gh.isNativeIssue(nativeId) || !issue.updatedAt) {
    log.debug(`[${NAME}] ${ref}: imported, but ${gh.isNativeIssue(nativeId) ? "the listing carries no updatedAt" : "the index names no native issue"} — nothing to forward`);
    return;
  }
  const native = await clawsIssues.getIssue(nativeId);
  if (!native) {
    log.debug(`[${NAME}] ${ref}: native issue ${nativeId} not found — nothing to forward`);
    return;
  }
  // The importer promotes the native issue flagged `importPending` and
  // clears the flag last, so this is an import still in progress or a
  // half-finished one the importer settles itself — not an update to forward.
  if (native.importPending) return;

  const syncedAt = await db.getImportedForgeSyncedAt(repo, issue.number);
  const closed = native.state !== "open";
  const act = syncedAt === null ? closed : Date.parse(issue.updatedAt) > Date.parse(syncedAt);

  if (act) {
    const body = importedBody(forgeIssueUrl(repo, issue.number), issue.author.login, issue.body);
    const titleChanged = native.title !== issue.title;
    const bodyChanged = native.body !== body;
    if (titleChanged) await clawsIssues.editIssueTitle(nativeId, issue.title);
    if (bodyChanged) await clawsIssues.editIssue(nativeId, body);
    if (closed) await clawsIssues.reopenIssue(nativeId);

    const changed = titleChanged || bodyChanged || closed;
    // The bridge rewrites its issue's body on every alert transition; that is
    // not new work, and re-planning on it re-plans the issue every tick.
    const bridgeEdit = !closed && isAlertBridgeOwned({ labels: native.labels, body });
    // The planning repo is the native issue's primary one, which is not
    // necessarily the forge repository the imported copy lives in.
    const replan = changed && !bridgeEdit && await requeueReopenedIssue(native, repo);
    if (changed) {
      const what = [titleChanged && "title", bodyChanged && "body", closed && "reopened"].filter(Boolean).join(", ");
      log.info(`[${NAME}] ${ref}: forwarded to ${nativeId} (${what})${replan ? ", re-plan queued" : bridgeEdit ? ", alert-bridge edit — no re-plan" : ""}`);
    }
  }

  await db.setImportedForgeSyncedAt(repo, issue.number, issue.updatedAt);
}

/**
 * Keep every open forge issue's shadow in step with the forge (#3246).
 *
 * Its own timer rather than a step inside `issue-dispatcher`: that job is the
 * most critical one on the fleet and should not gain database writes. Nothing
 * here writes to a forge — no label, no comment, no close. Every shadow write
 * goes through `db.ts`'s shadow helpers, which refuse any row that is not a
 * shadow; the one exception is {@link forwardImportedUpdate}, which writes an
 * imported forge issue's reopen or edit to its native issue through
 * `claws-issues.ts`, so those writes do emit dashboard events.
 */
export async function run(repos: Repo[]): Promise<void> {
  await Promise.allSettled(
    repos.map(async (repo) => {
      try {
        await syncRepo(repo.fullName);
      } catch (err) {
        await reportError(`${NAME}:repo`, repo.fullName, err, { repo: repo.fullName });
      }
    }),
  );
}

/**
 * The fleet-wide accepted-gap review (docs/jobs/accepted-gaps-review.md,
 * #clw_01M753CRBTEEXJM0QMWEZQBWN4). Hourly, it keeps at most one digest issue
 * (`FLEET_REVIEW_DEDUPE_KEY`) in the claws repo, held in Blocked, linking to
 * `/contracts/review` and listing the accepted observability Known gaps new
 * or reworded since they were last reconfirmed (security gaps are reviewed on
 * sentinel's page, #clw_01M75KGK2BVJVVMX73Z03ZBV5B). Closing the digest as completed
 * reconfirms every accepted gap; the next one is filed `REVIEW_PERIOD_DAYS`
 * after the last one closed. It also closes the retired per-repo review
 * issues and seeds reconfirmations from those a person closed as completed,
 * and retitles an open digest filed under an older title.
 */
import { LABELS, type Repo } from "../config.js";
import * as config from "../config.js";
import * as clawsIssues from "../claws-issues.js";
import { buildContractRows, CONTRACTS, type ContractRow } from "../contract-status.js";
import {
  acceptedReviewDedupeKey,
  buildReviewItems,
  FLEET_REVIEW_DEDUPE_KEY,
  FLEET_REVIEW_REPO,
  FLEET_REVIEW_TITLE,
  formatFleetReviewBody,
  gapKey,
  parseStoredTime,
  reconfirmRows,
  REVIEW_PERIOD_DAYS,
  REVIEW_PAGE_PATH,
  reviewableRows,
  reviewPageUrl,
} from "../contract-gap-review.js";
import { normaliseGapText } from "../contract-drift.js";
import * as db from "../db.js";
import { reportError } from "../error-reporter.js";
import { serialiseIssueCreate } from "../issue-create-lock.js";
import * as log from "../log.js";

export const NAME = "accepted-gaps-review";

const DAY_MS = 24 * 60 * 60 * 1000;

const BLOCKED_REASON =
  "Quarterly review of the fleet's accepted observability Known gaps (security gaps are reviewed on sentinel's page) — a person reviews /contracts/review and closes it as completed to reconfirm them; Claws files the next one about 91 days after it closes";

const LEGACY_CLOSE_COMMENT =
  `The per-repo accepted-gaps review is retired. The fleet-wide review on the dashboard at \`${REVIEW_PAGE_PATH}\` (and its \`${FLEET_REVIEW_TITLE}\` digest issue) replaces it, so this issue is closed without reconfirming anything.`;

export type ReviewOutcome = "filed" | "updated" | "unchanged" | "reviewed" | "none";

/** One row per managed repo and contract, from the scanners' stored snapshots and the live job-disable config. */
async function loadRows(repos: readonly Repo[]): Promise<ContractRow[]> {
  const names = repos.map((r) => r.fullName);
  return buildContractRows({
    repos: names,
    statuses: await db.listContractStatuses(),
    auditTimes: [],
    followUps: [],
    exclusions: config.getRepoJobExclusions(names),
  });
}

/**
 * Closes every retired per-repo review issue still open as not planned, after
 * a comment naming the fleet review. Loops every contract, security included,
 * so no per-repo review survives.
 */
async function closeLegacyReviews(): Promise<number> {
  let closed = 0;
  for (const spec of CONTRACTS) {
    const key = acceptedReviewDedupeKey(spec.contract);
    for (const record of await db.listOpenClawsIssuesByDedupeKey(key)) {
      const repo = clawsIssues.primaryRepo(record);
      // Close first, then comment: a failed close is retried hourly and must not re-post the comment.
      try {
        await clawsIssues.closeIssue(repo, record.id, "not_planned");
        closed++;
        log.info("legacy accepted gaps review closed", { component: NAME, repo, contract: spec.contract, issue: record.id });
        await clawsIssues.commentOnIssue(repo, record.id, LEGACY_CLOSE_COMMENT, clawsIssues.CLAWS_NATIVE_LOGIN);
      } catch (err) {
        await reportError(`${NAME}:legacy-close`, `${NAME}:legacy-close`, err);
      }
    }
  }
  return closed;
}

/** The `controller_status` marker recording that the one-time legacy seeding ran. */
const LEGACY_SEEDED_KEY = "accepted_gaps_legacy_seeded";

/**
 * One-time migration: for each row with accepted gaps and no reconfirmation,
 * seeds one from its retired per-repo review when a person closed that as
 * completed, dated at the close. Only the gaps the old issue body listed are
 * seeded, so a gap the person never saw stays changed.
 */
async function seedFromLegacyReviews(rows: readonly ContractRow[]): Promise<number> {
  if ((await db.readControllerStatus<unknown>(LEGACY_SEEDED_KEY)) !== null) return 0;
  const stored = new Set((await db.listContractGapReconfirmations()).map((r) => `${r.contract}\u0000${r.repo}`));
  let seeded = 0;
  for (const row of reviewableRows(rows)) {
    if (stored.has(`${row.contract}\u0000${row.repo}`)) continue;
    const legacy = await clawsIssues.findRecentlyClosedIssueByDedupeKey(row.repo, acceptedReviewDedupeKey(row.contract), new Date(0));
    if (!legacy || legacy.state_reason !== "completed") continue;
    const closedAt = parseStoredTime(legacy.closed_at);
    if (!closedAt) continue;
    const body = normaliseGapText(legacy.body ?? "");
    const keys = row.snapshot!.gaps
      .filter((g) => g.state === "accepted" && body.includes(normaliseGapText(g.text)))
      .map((g) => gapKey(g.text));
    if (keys.length === 0) continue;
    await db.saveContractGapReconfirmation(row.contract, row.repo, closedAt.toISOString(), keys);
    log.info("accepted gaps reconfirmation seeded", {
      component: NAME, repo: row.repo, contract: row.contract, gaps: keys.length, issue: legacy.id,
    });
    seeded++;
  }
  await db.writeControllerStatus(LEGACY_SEEDED_KEY, new Date().toISOString());
  return seeded;
}

export async function run(repos: Repo[], now: Date = new Date()): Promise<void> {
  const started = Date.now();
  log.info("review started", { component: NAME, repos: repos.length });
  try {
    const rows = await loadRows(repos);
    await closeLegacyReviews();
    await seedFromLegacyReviews(rows);

    // A digest a person closed as completed reconfirms everything, once: the
    // reconfirmation is dated at the close, so the next run sees it applied.
    // The Reconfirm all button closes before it saves, so it never re-applies.
    const since = new Date(now.getTime() - REVIEW_PERIOD_DAYS * DAY_MS);
    const closed = await clawsIssues.findRecentlyClosedIssueByDedupeKey(FLEET_REVIEW_REPO, FLEET_REVIEW_DEDUPE_KEY, since);
    const closedAt = parseStoredTime(closed?.closed_at);
    if (closed && closedAt && closed.state_reason === "completed") {
      const latest = Math.max(0, ...(await db.listContractGapReconfirmations())
        .map((r) => Date.parse(r.reconfirmedAt)).filter((ms) => !Number.isNaN(ms)));
      if (closedAt.getTime() > latest) await reconfirmRows(rows, closedAt, NAME);
    }

    const items = buildReviewItems(rows, await db.listContractGapReconfirmations());
    const body = formatFleetReviewBody(items, reviewPageUrl());
    const outcome = await serialiseIssueCreate(async (): Promise<ReviewOutcome> => {
      const open = await clawsIssues.findOpenIssueByDedupeKey(FLEET_REVIEW_REPO, FLEET_REVIEW_DEDUPE_KEY);
      if (open) {
        let retitled = false;
        if (open.title !== FLEET_REVIEW_TITLE) {
          await clawsIssues.editIssueTitle(open.id, FLEET_REVIEW_TITLE);
          log.info("accepted gaps review retitled", { component: NAME, issue: open.id, title: FLEET_REVIEW_TITLE });
          retitled = true;
        }
        if (open.body === body) return retitled ? "updated" : "unchanged";
        await clawsIssues.editIssue(open.id, body);
        log.info("accepted gaps review updated", { component: NAME, issue: open.id });
        return "updated";
      }
      if (closed) return "reviewed";
      if (items.length === 0) return "none";
      // A reminder, never one unit of work: held Blocked for the operator,
      // with no requirements record and nothing to promote it once unblocked.
      const id = await clawsIssues.createIssue({
        title: FLEET_REVIEW_TITLE,
        body,
        authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
        repos: [FLEET_REVIEW_REPO],
        primaryRepo: FLEET_REVIEW_REPO,
        source: "automation",
        labels: [LABELS.blocked],
        blockedReason: BLOCKED_REASON,
        requirementsStage: false,
        autoPromote: false,
        dedupeKey: FLEET_REVIEW_DEDUPE_KEY,
      });
      log.info("accepted gaps review filed", { component: NAME, issue: id });
      return "filed";
    });
    log.info("review finished", {
      component: NAME,
      duration_ms: Date.now() - started,
      accepted: items.length,
      changed: items.filter((i) => i.changed).length,
      outcome,
    });
  } catch (err) {
    await reportError(NAME, NAME, err);
  }
}

/**
 * The fleet-wide accepted-gap review (#clw_01M753CRBTEEXJM0QMWEZQBWN4): once
 * every `REVIEW_PERIOD_DAYS` a person reconfirms every managed repo's
 * `Accepted:` observability Known gaps in one place, the dashboard's
 * `/contracts/review` page, prompted by one digest issue the
 * `accepted-gaps-review` job keeps in the claws repo. Gaps that waive a
 * contract-level requirement come first, and a gap is shown as changed when
 * its text has no stored reconfirmation for its repo and contract (the
 * `contract_gap_reconfirmations` table). It replaced one review issue per repo
 * and contract, whose dedupe key `acceptedReviewDedupeKey` now only finds the
 * leftovers to close. Accepted security gaps are reviewed on sentinel's CVE
 * exception page instead (`SECURITY_GAP_REVIEW_URL`,
 * #clw_01M75KGK2BVJVVMX73Z03ZBV5B), so only `REVIEW_CONTRACTS` are listed.
 */
import crypto from "node:crypto";
import * as config from "./config.js";
import { normaliseGapText } from "./contract-drift.js";
import { contractRequirementsWaived, type ContractName, type ContractRow } from "./contract-status.js";
import * as db from "./db.js";
import * as log from "./log.js";
import { ACCEPTED_GAP_PREFIX, DEFERRED_GAP_FORMS } from "./observability-contract.js";

/** Days between fleet-wide accepted-gap reviews: the next digest is filed this long after the last one closed. */
export const REVIEW_PERIOD_DAYS = 91;

/** The digest issue's dedupe key. */
export const FLEET_REVIEW_DEDUPE_KEY = "accepted-gaps-review";
/** The digest issue's title. */
export const FLEET_REVIEW_TITLE = "chore: review the fleet's accepted observability gaps";
/** The contracts whose accepted gaps this review lists; security gaps are reviewed on sentinel's page. */
export const REVIEW_CONTRACTS: readonly ContractName[] = ["observability"];
/** sentinel's private page that reviews every repo's accepted security gaps. */
export const SECURITY_GAP_REVIEW_URL = "https://pages.home.bstjohn.net/sentinel/docs/cve-exceptions/";
/** The digest issue's only (and primary) repo. */
export const FLEET_REVIEW_REPO = "St-John-Software/claws";
/** The dashboard review page's path. */
export const REVIEW_PAGE_PATH = "/contracts/review";
/** At most this many changed gaps are listed in the digest body. */
export const DIGEST_ITEM_CAP = 40;

/**
 * The retired per-repo review issue's dedupe key for `contract`, e.g.
 * `observability-accepted-gaps-review`; kept only so the job can close the
 * leftovers and seed reconfirmations from completed ones.
 */
export function acceptedReviewDedupeKey(contract: string): string {
  return `${contract}-accepted-gaps-review`;
}

/** A gap's stable key: the first 16 hex chars of sha256 of its whitespace-collapsed text. */
export function gapKey(text: string): string {
  return crypto.createHash("sha256").update(normaliseGapText(text)).digest("hex").slice(0, 16);
}

/** One accepted gap as the review lists it. */
export interface ReviewItem {
  repo: string;
  contract: ContractName;
  text: string;
  /** Contract-level requirements the gap waives (`contractRequirementsWaived`). */
  waives: string[];
  /** The gap's key is not in its repo and contract's stored reconfirmation: new or reworded since. */
  changed: boolean;
  /** When the repo's gaps for the contract were last reconfirmed, ISO 8601; null when never. */
  reconfirmedAt: string | null;
}

export type Reconfirmation = Pick<db.ContractGapReconfirmationRow, "contract" | "repo" | "reconfirmedAt" | "gapKeys">;

/** The texts of a row's accepted gaps; none for an opted-out or unscanned row, or a contract outside `REVIEW_CONTRACTS`. */
function acceptedTexts(row: ContractRow): string[] {
  if (!REVIEW_CONTRACTS.includes(row.contract) || row.optOut || !row.snapshot) return [];
  return row.snapshot.gaps.filter((g) => g.state === "accepted").map((g) => g.text);
}

/** The `REVIEW_CONTRACTS` rows with at least one accepted gap, opted-out and unscanned rows excluded. */
export function reviewableRows(rows: readonly ContractRow[]): ContractRow[] {
  return rows.filter((r) => acceptedTexts(r).length > 0);
}

/** The key the review form and `reconfirmRows` use for a (contract, repo) row. */
export const reviewSeenKey = (contract: string, repo: string): string => `${contract}\u0000${repo}`;
const reconfirmationKey = (contract: string, repo: string): string => `${contract}\u0000${repo}`;

/**
 * One item per accepted gap of every scanned, not opted-out `REVIEW_CONTRACTS` row, ordered
 * waiving-first, then by repo, then contract, keeping the policy's order
 * within a row.
 */
export function buildReviewItems(rows: readonly ContractRow[], reconfirmations: readonly Reconfirmation[]): ReviewItem[] {
  const stored = new Map(reconfirmations.map((r) => [reconfirmationKey(r.contract, r.repo), r]));
  const items: ReviewItem[] = [];
  for (const row of rows) {
    const rec = stored.get(reconfirmationKey(row.contract, row.repo));
    const keys = new Set(rec?.gapKeys ?? []);
    for (const text of acceptedTexts(row)) {
      items.push({
        repo: row.repo,
        contract: row.contract,
        text,
        waives: contractRequirementsWaived(row.contract, text),
        changed: !keys.has(gapKey(text)),
        reconfirmedAt: rec?.reconfirmedAt ?? null,
      });
    }
  }
  const order = new Map(items.map((item, i) => [item, i]));
  return items.sort((a, b) =>
    Number(b.waives.length > 0) - Number(a.waives.length > 0)
    || a.repo.localeCompare(b.repo)
    || a.contract.localeCompare(b.contract)
    || order.get(a)! - order.get(b)!);
}

/** The review page's absolute URL from `config.DASHBOARD_URL`, else its site-relative path. */
export function reviewPageUrl(): string {
  const base = config.DASHBOARD_URL?.replace(/\/+$/, "") ?? "";
  return `${base}${REVIEW_PAGE_PATH}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The digest issue body: a summary, the review page link, the changed gaps (waivers first, capped) and how to answer. */
export function formatFleetReviewBody(items: readonly ReviewItem[], reviewUrl: string): string {
  const repos = new Set(items.map((i) => i.repo)).size;
  const changed = items.filter((i) => i.changed);
  const waiving = items.filter((i) => i.waives.length > 0).length;
  const shown = changed.slice(0, DIGEST_ITEM_CAP);
  const line = (i: ReviewItem): string =>
    `- ${i.repo} (${i.contract}): ${normaliseGapText(i.text)}${i.waives.length > 0 ? ` — waives: ${i.waives.join(", ")}` : ""}`;
  const shownWaiving = shown.filter((i) => i.waives.length > 0);
  const shownOther = shown.filter((i) => i.waives.length === 0);
  const list: string[] = [];
  if (changed.length === 0) {
    list.push("Nothing changed since the last reconfirmation.");
  } else {
    if (shownWaiving.length > 0) list.push(`**Waive a contract-level requirement:**`, ``, ...shownWaiving.map(line), ``);
    if (shownOther.length > 0) list.push(`**Other accepted gaps:**`, ``, ...shownOther.map(line), ``);
    if (changed.length > shown.length) list.push(`…and ${changed.length - shown.length} more on the review page.`);
  }
  while (list.at(-1) === "") list.pop();
  return [
    `The fleet accepts ${plural(items.length, "observability Known gap", "observability Known gaps")} across ${plural(repos, "repo", "repos")}: ${changed.length} new or reworded since they were last reconfirmed, ${plural(waiving, "waiver", "waivers")} of a contract-level requirement.`,
    ``,
    `Review them on the dashboard: ${reviewUrl}`,
    ``,
    `Accepted security gaps are reviewed on sentinel's page instead: ${SECURITY_GAP_REVIEW_URL}`,
    ``,
    `**New or reworded since the last reconfirmation:**`,
    ``,
    ...list,
    ``,
    `**How to answer:**`,
    ``,
    `- Close this issue as completed (or press **Reconfirm all** on the review page) to reconfirm every accepted observability gap; closing it as not planned reconfirms nothing.`,
    `- The review page has per-gap links to file an issue that defers a gap (${DEFERRED_GAP_FORMS}) or stops accepting it (removes its \`${ACCEPTED_GAP_PREFIX}\` prefix).`,
    ``,
    `This is a reminder, not a work item: it is held in Blocked and never planned. The \`accepted-gaps-review\` job keeps this list current while it is open and files the next review about ${REVIEW_PERIOD_DAYS} days after this one closes.`,
  ].join("\n");
}

/** A stored `YYYY-MM-DD HH:MM:SS` UTC timestamp (or an ISO one) as a Date; null when unparseable. */
export function parseStoredTime(value: string | null | undefined): Date | null {
  if (!value) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * Saves one reconfirmation dated `at` per reviewable row. Without `seen` it
 * holds every accepted gap's key. With `seen` (the keys the review page
 * rendered, by `reviewSeenKey`) it holds only the current accepted gaps whose
 * key was seen, so a gap added or reworded after the page loaded stays
 * changed; a row with none seen is counted as skipped.
 */
export async function reconfirmRows(
  rows: readonly ContractRow[],
  at: Date,
  component: string,
  seen?: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<{ repos: number; gaps: number; skipped: number }> {
  const repos = new Set<string>();
  let gaps = 0;
  let skipped = 0;
  for (const row of reviewableRows(rows)) {
    let keys = acceptedTexts(row).map(gapKey);
    if (seen) {
      const shown = seen.get(reconfirmationKey(row.contract, row.repo));
      keys = keys.filter((k) => shown?.has(k));
      if (keys.length === 0) {
        skipped++;
        continue;
      }
    }
    await db.saveContractGapReconfirmation(row.contract, row.repo, at.toISOString(), keys);
    repos.add(row.repo);
    gaps += keys.length;
  }
  const result = { repos: repos.size, gaps, skipped };
  log.info("accepted gaps reconfirmed", { component, ...result, reconfirmed_at: at.toISOString() });
  return result;
}

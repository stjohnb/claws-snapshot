/**
 * PR review state read from Claws' own `pr_reviews` records — never from the
 * review comment's text. The comment (its `review-result:` line, `Reviewed
 * commit:` marker, stamps and `<details>` archive) is human-only output: a
 * finding that quotes a marker must not change what the review cycle does.
 */
import * as db from "./db.js";
import * as log from "./log.js";

export type ReviewStatus = "clean" | "issues" | "escalated" | "none";

export interface DerivedReviewStatus {
  status: ReviewStatus;
  /** Numbered findings in a blocking round — display only; no gate reads it. */
  issueCount: number;
  /** Full head SHA of the recorded round; null when there is none. */
  reviewedCommit: string | null;
}

/**
 * Map the latest recorded review round to a review status:
 * `clean`/`advisory`/`empty-diff` → `clean`, `blocking` → `issues`,
 * `escalated` → `escalated`, no row → `none`. A `blocking` or `advisory` row
 * with null `findings` (seeded by the one-shot backfill, which kept no text)
 * also reads `none`, so the PR is re-reviewed once and gets a full record.
 */
export function deriveReviewStatus(row: db.PRReviewRecord | null): DerivedReviewStatus {
  if (!row) return { status: "none", issueCount: 0, reviewedCommit: null };
  const reviewedCommit = row.headSha;
  if ((row.verdict === "blocking" || row.verdict === "advisory") && row.findings === null) {
    return { status: "none", issueCount: 0, reviewedCommit: null };
  }
  switch (row.verdict) {
    case "clean":
    case "advisory":
    case "empty-diff":
      return { status: "clean", issueCount: 0, reviewedCommit };
    case "escalated":
      return { status: "escalated", issueCount: 0, reviewedCommit };
    case "blocking":
      return { status: "issues", issueCount: (row.findings!.match(/^\s*\d+\.\s/gm) ?? []).length, reviewedCommit };
    default:
      return { status: "none", issueCount: 0, reviewedCommit: null };
  }
}

/**
 * The latest review round when it is one the review-addresser should take at
 * `headSha`: the round reviewed this head, recorded its findings, and has not
 * been addressed yet; and it is `blocking`, or (only with `includeAdvisory`)
 * `advisory` with no advisory fix round recorded. Null otherwise — clean,
 * escalated, stale-head, already-addressed and backfilled rounds all read null.
 *
 * `headSha` may be a getter, called only when the latest round is otherwise a
 * candidate, so a PR with nothing to address costs no head lookup.
 */
export async function pendingClawsReview(
  repo: string,
  prNumber: number,
  headSha: string | (() => Promise<string>),
  opts: { includeAdvisory?: boolean } = {},
): Promise<db.PRReviewRecord | null> {
  const latest = await db.getLatestPRReview(repo, prNumber);
  if (!latest || latest.findings === null || latest.addressedAt !== null) return null;
  const candidate =
    latest.verdict === "blocking" ||
    (latest.verdict === "advisory" && !!opts.includeAdvisory && latest.advisoryAddressedSha === null);
  if (!candidate) {
    log.debug(`review-state: ${repo}#${prNumber} latest review (${latest.verdict}) needs no addresser round`);
    return null;
  }
  const head = typeof headSha === "string" ? headSha : await headSha();
  return latest.headSha === head ? latest : null;
}

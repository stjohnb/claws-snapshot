# accepted-gaps-review

**Deep dive.** Read this when you're changing the fleet-wide quarterly review of
the `Accepted:` Known gaps in every repo's observability policy, its digest
issue, or the dashboard's `/contracts/review` page.

**Source**: `src/jobs/accepted-gaps-review.ts`, `src/contract-gap-review.ts`,
`src/pages/contracts.ts` (`buildContractsReviewPage`), `src/server.ts`
(`GET /contracts/review`, `POST /contracts/review/reconfirm`)
**Trigger**: Every hour (`intervalMs` 60 minutes)
**Targets**: Every managed repo, observability contract only
(`REVIEW_CONTRACTS`); no `/jobs` matrix toggle. A repo opted out of the
observability scanner (`disabledJobs`, an alias or `scanner-dispatcher`) is left
out of the review.

Accepted **security** gaps are not reviewed here: sentinel's private CVE
exception page (`SECURITY_GAP_REVIEW_URL`,
<https://pages.home.bstjohn.net/sentinel/docs/cve-exceptions/>) judges every
repo's accepted security gaps against the repo daily and files one issue per
repo whose gaps no longer match, so security risk is reviewed in one place
(#clw_01M75KGK2BVJVVMX73Z03ZBV5B). Security rows yield no review items and are
never reconfirmed; their stored reconfirmations stay in
`contract_gap_reconfirmations`, unread.

Accepted gaps come back to a person once a quarter, in one place rather than one
issue per repo and contract (#clw_01M753CRBTEEXJM0QMWEZQBWN4). Before this job,
each contract scanner filed its own quarterly review issue per repo; with 22 repos that was up to about 44 Blocked issues a quarter,
mostly confirmation clicks, several opening in the same second.

## What it reads

It builds the `/contracts` rows (`buildContractRows`) from the scanners' stored
snapshots (`contract_status`) and the live job-disable config, then
`buildReviewItems` turns every accepted gap of every scanned, not opted-out
observability row into a review item:

- `waives`: the contract-level requirements `contractRequirementsWaived` finds
  (an explicit `(waives: <requirement>)` marker, else keyword patterns).
- `changed`: the gap's key, `gapKey(text)` (first 16 hex chars of sha256 of the
  whitespace-collapsed text), is not in the repo and contract's stored
  reconfirmation (`contract_gap_reconfirmations`). New and reworded gaps are
  not told apart; both read "New or reworded".
- Ordered waivers first, then by repo, then contract, keeping the policy's
  order within a row. The page and the digest body share this order.

## Each run

1. **Legacy cleanup.** Every open issue keyed `observability-accepted-gaps-review`
   or `security-accepted-gaps-review` (the retired per-repo reviews) gets a
   Claws comment naming the fleet review at `/contracts/review` and is closed as
   not planned. One `legacy accepted gaps review closed` `info` line each. This
   still loops both contracts so no per-repo security review survives.
2. **Legacy seeding.** For each row with accepted gaps and no reconfirmation,
   the newest closed per-repo review for its repo and contract is looked up; when
   it closed as completed, the row's current accepted gaps are saved as
   reconfirmed at that close time (`accepted gaps reconfirmation seeded`), so a
   gap a person already reconfirmed there starts unchanged.
3. **Hand-close.** When the newest digest closed in the last 91 days closed as
   completed and its close time is later than every stored `reconfirmed_at`,
   `reconfirmRows` saves every accepted gap as reconfirmed at the close time.
   Being dated at the close, it applies once. Closing as not planned
   reconfirms nothing. `closed_at` is a second-precision UTC SQL timestamp,
   parsed by `parseStoredTime`.
4. **Digest.** Inside `serialiseIssueCreate`, an open digest whose title is not
   `FLEET_REVIEW_TITLE` (one filed under the old `chore: review the fleet's
   accepted contract gaps`) is retitled in place with `editIssueTitle` and logs
   `accepted gaps review retitled`; its body is rewritten with `editIssue` only
   when it changed. Otherwise one is filed only
   when no digest closed in the last 91 days and at least one accepted gap
   exists, so at most one issue opens per run and the first after deploy is
   filed straight away.

The digest is titled `chore: review the fleet's accepted observability gaps`, dedupe
key `accepted-gaps-review`, repo and pinned primary repo `St-John-Software/claws`,
source `automation`, filed Blocked with a blocked reason, no requirements stage
and `autoPromote: false`: a reminder, never planned. Its body
(`formatFleetReviewBody`) is a summary line (accepted observability gaps, repos,
changed count, waiver count), the review page link (`config.DASHBOARD_URL` +
`/contracts/review`, or the site-relative path), a line linking sentinel's page
for security gaps, the changed gaps as `- <repo> (<contract>): <text> —
waives: <labels>` with waivers under their own heading first, capped at 40 with
an "…and N more on the review page" line, and how to answer.

## The review page

`/contracts/review` (linked from the `/contracts` intro with its changed count)
lists every review item: an intro with counts, the open digest's link and a link
to sentinel's page for security gaps, a
**Reconfirm all** form, then "New or reworded since last reconfirmation" and a
collapsed "Unchanged" section, each split into "Waive a contract-level
requirement" and "Other accepted gaps". Each item shows its repo, contract,
waived requirements, text, when it was last reconfirmed (or "never"), and two
links to `/issues/new` with the repo, title and body prefilled:

- **Defer**: `chore: defer an accepted <contract> gap in <repo>`, quoting the
  gap (at most 1,500 characters) and the policy path, asking to replace
  `Accepted:` with `Deferred until YYYY-MM-DD:` or `Deferred (#clw_…):`.
- **Stop accepting**: `chore: stop accepting a(n) <contract> gap in <repo>`,
  asking to remove the `Accepted:` prefix so the scanner lists the gap in the
  repo's known-gaps follow-up.

There is no per-gap reconfirm; reconfirmation is all at once.

**Reconfirm all** posts the page's render time as `as_of` (a missing or invalid
value means now). The route closes the open digest as completed first, then
calls `reconfirmRows(rows, now, "contracts-page", asOf)`, which skips a row
whose snapshot was saved after `as_of` (its gaps were never on the page), and
redirects back. Closing first keeps the job's hand-close step from re-applying.
When every row was rescanned after the page rendered it changes nothing, leaves
the digest open and says so.

## Logs and errors

- `review started` and `review finished` (`duration_ms`, `accepted`, `changed`,
  `outcome`: `filed`, `updated`, `unchanged`, `reviewed` or `none`) at `info`,
  component `accepted-gaps-review`.
- `accepted gaps review filed` / `accepted gaps review updated` with the issue id;
  `accepted gaps review retitled` (`issue`, `title`) when an open digest is retitled.
- `accepted gaps reconfirmed` (`repos`, `gaps`, `skipped`) from `reconfirmRows`,
  with component `accepted-gaps-review` or `contracts-page`; the route also logs
  `accepted gaps review closed` when it closes the digest.
- A failure is caught for the whole run and reported with
  `reportError("accepted-gaps-review", …)`. No dashboard panel: the job is not
  worth watching beyond these lines.

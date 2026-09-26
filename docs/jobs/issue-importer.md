# issue-importer

**Deep dive.** Read this when you're moving a repository's existing forge
issues into the Claws-native tracker. For the tracker itself — ids, routing,
repositories and the primary repository — read [issue-tracker.md](../issue-tracker.md).

**Source**: `src/jobs/issue-importer.ts`
**Trigger**: Timer; the dashboard "Run" button or `POST /trigger/issue-importer` does the same walk
**Schedule**: Every 30 minutes (`intervals.issueImporterMs`).

New issues are always filed in the native tracker. This job carries the
existing backlog across, and keeps carrying across whatever is filed on a
forge after it.

## The whole fleet, every run

Each run walks every repository `gh.listRepos()` returns, in order, and imports
whatever is not mid-flight. An issue skipped for an open PR or a queued work
item is simply picked up by a later run once that work has landed — nobody has
to trigger anything.

The GitHub issue listing is a single 100-issue page (`gh.openIssuesMayBeTruncated`),
so within a run the job lists the *same* repository again after a pass that
imported something, for up to 10 passes. `gh.closeIssue` invalidates the
open-issues cache, so each such pass sees the next page; a pass that imported
nothing ends the loop, since it would only see the same page again. Forgejo
listings page to the end, so they never truncate and take one pass.

A repository whose listing or import throws is reported as a `[claws-error]`
and the walk carries on with the next one. Each repository that had something
to import gets its own summary line (imported, failed, skipped, and a note that
anything left will be picked up on a later run), and the run ends with a fleet
total.

After the cutover this means an issue a human files on a forge is moved into
the native tracker within about half an hour. A repository whose backlog should
stay on its forge is excluded in the jobs matrix (`issue-importer` is a
per-repo toggle like any other job).

## What is imported

Every open issue of the repository except:

- **Native issues.** `gh.listOpenIssues` unions both backends, so its result is
  not "all forge issues"; already-imported ones are skipped.
- **An issue already imported.** `importIssue` closes the forge issue last, so a
  failure after the native create leaves the forge issue open with the native one
  already written. The `imported_issues` row (see
  [database-schema.md](../database-schema.md)) is the durable idempotency key, and
  a forge issue it already names is skipped — every later run lists the same
  repository again, and would otherwise import it a second time. The key is `(repo, forge_number)`, so
  `#7` is never confused with `#70` and a forge number is never confused with the
  same number in another repository. If the native issue it names still carries
  `Claws Ignore`, the import did **not** finish (see below) and the skip is logged
  as a warning naming it, so a half-import is distinguishable from a completed
  one. (A forge issue that is still open with a row is unfinished either way,
  since the forge close is the last step; when the forge issue carried `Claws
  Ignore` itself the warning does not tell the operator to remove the label.) The `Imported from <forge url> (opened by @` prefix `importedBody` writes
  is still there, but as the human-readable pointer back to the forge, not as the
  key.
- **An issue an open PR references.** The forge issue keeps its number, so the PR's
  `Closes #<N>` still resolves — what breaks is the other side: the native issue
  it became has no PR linked to it, so nothing closes it when that PR merges.
  Both a `claws/issue-<N>-` branch (`gh.getOpenPRForIssue`) and any other open PR
  that `referencesIssue` counts; the branch prefix alone would miss a hand-rolled
  human PR, and `Closes #<N>` alone would miss a multi-phase PR, whose body says
  `Part of #<N>`. Let the PR merge first and import on a later run.
- **An issue with a `queued` or `running` work-queue row.** The widest
  mid-flight window, and the one no PR is visible for: an implementer that has
  not pushed a branch yet would open its PR against an issue this job had
  already closed, while the native issue sits there with no PR and never closes.
  One `db.listQueuedWork()` read per repository examined covers that
  repository's candidates, with an explicit high limit rather than the
  fleet-wide 200-row default — a low-priority `queued` row sorting past that
  window would silently disarm the guard. Only issue-scoped kinds count
  (`ISSUE_SCOPED_KINDS` in `worker.ts`, which a test asserts partitions
  `AGENT_KINDS` with the PR- and repo-scoped sets), so a PR review of the same
  number is not confused for one.

`Claws Ignore` is **not** an exclusion. It means automation must not plan or
implement the issue, not that the issue must stay on the forge, so an ignored
issue is imported like any other and the label travels with it: the native copy
keeps `Claws Ignore` and the dispatchers keep leaving it alone.

The last two are a **candidate filter only**. They are read once per repository,
and `importRepo` then walks the whole backlog one slow issue at a time while
`issue-dispatcher` keeps running on its own 5-minute timer — so by the last
issue of a big repository the snapshot is minutes old, and a batch-level check
cannot guard a per-issue irreversible write. `importIssue` therefore re-reads
both immediately before its first native write (`db.listQueuedWork` again, and
`gh.getOpenPRForIssue` after `gh.invalidatePRList`, since a just-opened PR hides
inside the 60 s `pr-list` cache). It reads them once more after the body's
file copies and just before `promoteShadowIssue`: up to 50 downloads can take
minutes, long enough for the dispatcher to enqueue work on the forge issue in
between, and a hit there deletes the copies it just made.

Either makes the issue **skipped** rather than imported or failed: nothing
native is written, the forge issue stays open, and the summary counts it and
says the rest will be picked up on a later run — which happens on its own once
the in-flight work has landed.

### What used to be refused, and is not any more

Three exclusions are gone, because `imported_issues` makes the old forge number
keep resolving (#3245) — see
[issue-tracker.md](../issue-tracker.md#imported-forge-refs-keep-resolving):

- **An issue an upstream watch targets.** `docs/upstream-watches/*.yaml` still
  names its target as `issue: <number>` and the schema still accepts nothing
  else, but `processWatch` now resolves that number, so it acts on the native
  issue. `listWatchTargets` and its fail-closed `{targets, ok}` result existed
  only for this refusal and are deleted with it.
- **An issue another issue is marked `claws-duplicate-of:` of.** Those markers
  live on issues this job does not rewrite; `gh.listDuplicateIssuesOf` now finds
  them under the native id through the alias.
- **Re-pointing `skippedItems` / `prioritizedItems` / `itemTimeoutOverrides`.**
  All three are matched through the alias instead, so there is nothing to
  rewrite and no `writeConfig` from this job at all.

**Still open.** The open-PR and work-queue refusals stay. They are transient and
self-clearing — a later run imports the issue once the PR merges — and dropping them
needs `src/agents/auto-merger.ts` to close a native issue from a numeric
`Closes #123`: `extractClosedIssueRefs` returns `123`, `isNativeIssue(123)` is
false, so nothing would close the `clw_…` issue. That is the remaining
follow-up.

## Promoting the shadow

Every open forge issue has a **shadow** — the hidden native record
[`issue-shadow-sync`](issue-shadow-sync.md) keeps in step with it, see
[issue-tracker.md](../issue-tracker.md#shadows) — and `db.createShadowIssue` is
the importer's **only** native-create path: it either resolves that existing
shadow (`created: false`) or, when the sync job has not reached this forge
issue yet, creates the linked row atomically — linkage row first, then the
`claws_issues` row, in the same transaction `issue-shadow-sync` itself uses —
and the import then *promotes* whichever id came back, in place, rather than
ever creating a second native issue beside it. `undefined` means the linkage
row already names an *imported* issue (a human reopening one puts it back in
the forge's open listing permanently), which the importer treats as a skip,
not a second import. Because the linkage row is always the first thing either
caller writes, its `(repo, forge_number)` primary key — not the order the
importer and the sync job happen to run in — is what arbitrates the race
between them, and neither side can end up with a native issue nothing links
to (#3262).

`db.promoteShadowIssue` writes the forge title, the imported body, the forge's
labels plus `Claws Ignore` and the `kind` flip from `shadow` to `issue` in a
single transaction, so no reader ever sees a half-promoted row — the issue
becomes visible to the dispatchers already ignored, exactly as a freshly
created import is. It is the atomicity that guarantees that and not the order
of the statements. It also writes every other column a create would have: the
author as `claws`, and an open state with `state_reason` and `closed_at`
cleared, so a forge title edited or a forge issue reopened inside the sync
job's window cannot leave the promoted issue holding what the shadow last saw.

The shadow is resolved **per issue**, by `db.createShadowIssue(repo, number, …)`
immediately after the other mid-flight guards, and *is* the first native
write, so a guard that fires costs nothing: a run walks a whole backlog one
slow issue at a time while the sync job keeps minting shadows on its own
timer, so a batch snapshot would miss a shadow created since.

Keeping the `clw_` id is the point: the `imported_issues` linkage row, any
work-queue row and any `Closes #clw_…` already naming it carry over instead of
being stranded on a shadow the import abandons. Everything after the
create-and-promote pair — the comment copy, the phase claim, the plan
re-stamp, the guard-label removal, the forge comment and the forge close — is
unchanged, and `recordImport` now finds its row already written by
`createShadowIssue`, so it no-ops in the table while still populating the
alias index. Its `false` branch — a row naming some *other* native issue — is
therefore a defensive assertion rather than a reachable race: `createShadowIssue`
having returned an id already means that id is what the linkage row names.

A forge issue whose linkage row points at a shadow is still a **candidate**:
`db.listImportedIssues` excludes shadows, so `resolveImportedRef` leaves its
forge number alone and the "already imported" skip above does not fire. If
`promoteShadowIssue` returns false the row is no longer a shadow — a concurrent
run imported it — and the issue is counted **skipped** rather than having its
thread copied onto that import a second time; `createShadowIssue` returning
`undefined` is the same outcome for the case where the race lands before the
shadow ever existed.

## What is carried across

Every **read** the import needs — the comment thread and its reactions — happens
before the first native write. A native issue that exists with nothing under it
is the one state no later run repairs, since the `imported_issues` row makes
every later run skip the forge issue, so a failing read must cost the import
and not the tracker. A *reaction* read that fails is weaker than that: it is caught
per comment (`mapSettledWithConcurrency`), logged, and costs that comment's
reactions only — one transient 403 out of N reads should not abandon a whole
issue.

Then, for each issue, in this order:

1. A native issue with the same **title**, the same **labels** *plus `Claws
   Ignore`*, and a single repository, the forge issue's own — which is
   therefore its primary repository, and what makes every dispatcher and
   auditor treat it as an ordinary issue of that repo. The guard label comes off as the last step (below): until then the
   issue has a thread that may be truncated and a plan that still points at the
   forge, and an `issue-dispatcher` tick landing in that window would read the
   forge fence, strip `Refined` and demand a re-plan.
2. Its body, prefixed `Imported from <forge url> (opened by @<login>)`. The
   native issue is authored as `claws`, so the prefix is the only record of who
   opened it; keep it — but only as a human-readable pointer back to the forge.
   The `imported_issues` row is the **only** idempotency key: `createShadowIssue`
   writes it in the same transaction as the native (or promoted) row, so there
   is no window between the two writes for the prefix to answer in, and
   `recordImport` below finds it already there.

   **Files** the body links are copied into the native attachment store first
   (see [issue-tracker.md](../issue-tracker.md#attachments)), so the body
   `promoteShadowIssue` writes already points at them: markdown and `<img>`
   images (`extractImageUrls`), GitHub `user-attachments` links
   (`extractAttachmentUrls`), and on Forgejo every listed asset
   (`gh.getIssueAttachments`, read after the mid-flight guards but before any
   write) that no comment links. A Forgejo asset is matched on its attachment
   UUID, so the site-relative `/attachments/<uuid>` and
   `/<owner>/<repo>/attachments/<uuid>` links the forge's editor inserts are
   found and rewritten, not just the absolute download URL. Each is downloaded with `images.fetchIssueFile` — the repo's
   token, the SSRF guard, a streamed cap — stored under the native id with the
   forge author as uploader, and its URL in the text replaced by the native
   site-relative one. An image stored without an image extension gains one,
   since the agent pipeline routes listed files by filename. At most 50 files
   per issue and 10 MB each; a failed or skipped download — or an image link
   that answers with something other than an `image/` type, such as a login
   page — leaves the original URL in place and logs a warning, and never fails the import. A URL is
   matched only where it ends, so a copied `…/x.png` never rewrites the head
   of an uncopied `…/x.png?raw=true`. A file several
   texts link is copied once and every link to it rewritten. If the promotion
   then loses its race to a concurrent import, or anything between the first
   copy and the promotion throws, the copies are deleted again — the shadow
   stays a shadow, and the next run would otherwise copy them a second time.
   A process that dies mid-download cannot take them back, so the copy first
   deletes any attachments already on the shadow: a shadow never owns one
   (its routes 404 and nothing uploads to it), so they can only be such
   leftovers.
3. Every **comment**, in order, with its own author login. Its files are
   copied the same way just before it is posted, uploaded as the comment's
   author and counted against the same per-issue cap, so `commentOnIssue`
   stamps their `comment_id` — only those: a reply linking a file the body
   already copied leaves it with the body. Claws' own comments
   keep the `*— Automated by Claws —*` marker, which is load-bearing:
   `issue-refiner` reads it to tell its own plans from the human feedback it has
   to address.
4. Claws' own **reactions** on those comments, re-added as `claws` reactions.
   The refiner marks feedback addressed with a reaction, so dropping them would
   make it re-address every comment on the imported issue. A human's reaction is
   not copied — it is decoration the native store has no UI for.
5. **A `claws-phase-done:` claim** for a multi-phase issue imported between
   steps. Every durable record of a landed phase is keyed to the *forge* ref —
   the merged PRs live on `claws/issue-<N>-` branches and their bodies say `Part
   of #<N>` — so the move would otherwise reset the issue to “phase 1 next” and
   Claws would re-implement work that already merged. The claim is the one record
   that is not ref-keyed, so coverage is recomputed against the forge issue and
   written onto the native one. Only *landed* phases (`coverage.done`: a merged
   PR or an existing claim) are carried; a phase covered only by a still-open PR
   is logged as a warning instead, since claiming it would tell the implementer
   to build the next phase on a base that lacks it. `parsePhaseClaims` ignores a
   Claws-authored comment and an untrusted login, so the claim is written as
   `allowedActors[0]` with no Claws footer, and it is posted *before* the plan is
   re-stamped so the plan’s fence names it — a comment newer than the fence reads
   as unaddressed post-plan feedback and would strip `Refined`.
6. **Re-stamped plan markers** on the last copied Claws plan. Copying the plan's
   text is not enough: a plan comment carries `CLAWS_PLAN_BODY_HASH` (the hash of
   the title+body it was written against) and `CLAWS_PLAN_LAST_COMMENT` (the
   newest comment the plan run had seen), and the import invalidates both. The
   body gains the `Imported from …` prefix, so the old hash no longer matches
   and `isPlanStaleForIssue` would demand a re-plan; and the old fence is a
   forge *number*, which `compareIssueRefs` orders below every `clwc_…` id, so
   every copied comment — including pre-plan discussion — would read as
   unaddressed post-plan feedback and strip `Refined`. `restampPlan` rewrites
   both against the native content and the last copied comment, which is what
   makes an accepted plan survive the move so the issue can be `Refined`
   straight away. `CLAWS_PLAN_STEP_BACK: reconsider` is re-emitted with them:
   `stripPlanMarkers` drops it along with the rest of the block, and the
   dispatcher reads it to *withhold* auto-refine until a human has looked at a
   plan the planner itself said to reconsider.
7. **Removing `Claws Ignore`**, which is what makes the issue live — unless the
   forge issue carried `Claws Ignore` itself, in which case it stays. For such
   an issue the import's single dashboard event is the forge `issue-closed`
   below rather than the label removal; an ignored issue is not work any waiter
   acts on.

Copying a comment emits no `issue-comment` event at all. The event ring holds
500 entries, so replaying a whole backlog's threads one event at a time would
evict the recent-activity feed and every `claws_wait_for_change` waiter's
backlog. The guard label's removal is the import's single event: unlike "the
last comment", it fires exactly once per issue whatever the thread contained —
a comment-less issue used to import completely silently — and it fires *after*
the phase claim and the plan re-stamp, so a waiter it wakes reads an issue that
is actually ready to be worked. Reaction reads are prefetched with
`mapSettledWithConcurrency` — the insert loop has to stay sequential to preserve
comment order, and a read inside it would make the import one serial round trip
per comment.

Then the forge issue gets a `Moved to <dashboard url>` comment and is closed
`not_planned`. Not `completed`: nothing was implemented, and `completed` is what
the merger and the auditor write when something was.

A failure before the per-issue loop even starts — listing the repository's
issues, or resolving Claws' own login for it — is reported as a `[claws-error]`
too, rather than aborting the job with no summary and no record.

An issue that fails partway is logged, reported as a `[claws-error]`, and the
run continues with the next one. The forge issue is closed **last**, so a
failure anywhere before that leaves it open and the run's summary counts it as
failed. Whatever the native side had already written stays — still carrying
`Claws Ignore`, so no dispatcher acts on a half-imported issue — and the
`imported_issues` row makes every later run skip that forge issue rather than
import it twice. Because that row is now always written atomically with the
native (or promoted) row, this is the *only* state a crash can leave behind:
there is no longer a window where a native issue exists with no row pointing
at it (#3262). A later run says so explicitly: a recorded import whose native
issue still carries the guard label is reported as one that did not finish, not
as one already done. Read the summary, finish the half-imported issue on
`/issues`, remove `Claws Ignore` (unless the forge issue carried it too, in
which case it belongs there), then close the forge issue by hand.

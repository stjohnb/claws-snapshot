# auto-merger

**Deep dive.** Read this when you're changing how often open PRs are evaluated
for merge, or how a blocked merge is reported. For the merge gates themselves
(the stored merge approval, CI, infra paths), read the Merger section of
[pr-dispatcher.md](pr-dispatcher.md#merger-auto-merger).

**Source**: `src/main.ts` (job) → `sweepRepo()` in `src/agents/auto-merger.ts`
**Trigger**: Every 3 minutes (`intervals.autoMergerMs`); disabled with the `merger` agent

## Why it runs on the scheduler (#2971)

The merge sweep is pure GitHub/Forgejo API: no worktree, no Claude. It used to
run only as an `auto-merger:sweep` work-queue row, which `claimNextWork`
orders behind multi-hour agent runs on a small worker pool, so an approval
could take 10–20+ minutes to act on. The job now runs inline on the scheduler,
sweeping every repo (4 at a time, skipping repos while GitHub is rate-limited),
so a PR merges within about three minutes of whatever last unblocked it —
a merge approval from the dashboard, CI going green, or a conflict being resolved.

pr-dispatcher no longer enqueues a periodic sweep. Agent handlers that mutate a
PR (ci-fixer, review-addresser, pr-reviewer) still chain an
`auto-merger:sweep` row when they finish; that handler calls the same
`sweepRepo()`.

## Sweep behaviour

- `sweepRepo(repo)` invalidates the cached PR list, lists open PRs, skips any
  rejected by `isDispatchSkippable`, and defers any PR with a **running**
  ci-fixer, conflict fixer, review-addresser or reviewer row
  (`db.hasActiveWorkForPR`) to the next sweep. Each PR's `tryMerge` runs in its
  own try/catch, so one failure does not stop the rest.
- Every PR the sweep leaves unmerged logs a `merge_skipped` diagnostic with
  context `{repo, pr, mergeSkip}`, and every sweep ends with one
  `merge_sweep_done` line carrying `{repo, openPrCount, mergedCount,
  skippedCount}` — so a sweep that merged nothing still leaves a trace. See
  [Skip reason codes](#skip-reason-codes).
- A module-level set of repos being swept makes a second concurrent
  `sweepRepo` for the same repo return immediately, so the scheduler job and a
  chained queue row never sweep one repo at once. The scheduler's
  `runningFlags` already stops the job overlapping itself, and `mergePR` is
  pinned to the evaluated head SHA.
- In staging mode (`CLAWS_ACTIVATION_STATE=staging`) the job is part of the
  staging lane (`STAGING_PIPELINE_JOB_NAMES`); `isDispatchSkippable` still
  limits it to `Claws Staging` PRs.

## Third-party update PRs

`tryMerge` evaluates third-party update PRs (Renovate, Dependabot, or a
`renovate/*`/`dependabot/*` branch) at any hour, like every other PR: a PR that
passes every gate merges whatever the time of day. Update tools are scheduled to
open PRs at 19:00 Europe/London instead
([pr-dispatcher.md](pr-dispatcher.md#third-party-update-prs-and-worker-protection)).
An approved PR whose review status is still `none` (not yet reviewed) is
blocked without a "Merge blocked" comment.

## No CI result on the head (`status=none`)

A head with no commit statuses or check runs reads `status=none`. That means "CI
has not reported", not "green", so it never merges on its own
(#clw_01M50MY5NZYBNSG5X0FZYXVVGS).

- **Unsettled head.** The head commit is under 5 minutes old by committer date
  (`haveChecksSettled`): the block is a quiet `checks-pending`, with the reason
  "CI has not reported on head `<sha7>` yet — waiting for it to register." and
  no "Merge blocked" comment.
- **Settled head, CI not expected.** `gh.repoExpectsCi(repo)` is false: the
  default branch has no `.yml`/`.yaml` file under `.forgejo/workflows/` or
  `.github/workflows/`, or `claws.json` sets `mergeWithoutChecks: true`
  ([repo-config.md](../repo-config.md)). `none` is accepted. The answer is
  cached per repo for 10 minutes; a listing error counts as "CI expected"
  (fail closed) and is not cached.
- **Settled head, CI expected.** The whole PR is judged, not the head commit
  alone:
  - **Case A — the whole diff is CI-exempt** (`docs/**`, `*.md`, `LICENSE`,
    `isCiExemptPath`): `none` is accepted. Doc PRs (`claws/docs-`) are
    all-docs, so this covers them. Ideas-collection PRs (`claws/ideas-collect-`)
    are accepted too.
  - **Case B — CI-exempt commits on top of a commit with a CI result:**
    `carriedForwardCheckStatus` walks the PR's commits newest-first (up to 10)
    and carries forward the status of the first commit that has any, as long as
    every commit above it changes only CI-exempt paths. This runs on GitHub and,
    since this change, Forgejo (`forgejo.carriedForwardCheckStatus`).
  - **Case C — no commit in the PR proves its code was tested:** the PR holds
    with `checks-missing`, reported on the PR like any other block of an
    approved PR, and counted on `/prs` as needing the operator.

  The `checks-missing` reason reads: "CI has not reported on head `<sha7>` — no
  commit statuses or check runs exist for it or for any earlier commit in this
  PR whose code it carries, and this repo's CI normally reports on pull
  requests. Claws will merge once CI reports green; push a new commit to start a
  run, or set `mergeWithoutChecks: true` in `claws.json` if this repo's CI never
  runs on pull requests." `claws_merge_pr` and `claws_approve_pr_merge` return
  the same reason, because they go through `attemptMerge`.

A merge approval (**Automerge**) or a Dependabot author is not a CI result:
neither is accepted on `status=none` by itself. A no-op infra plan PR is never
accepted on `none` either, since the plan run is itself a check.

### Why PR #105 merged with no CI

On 2026-10-15 claws PR #105 merged about 4 minutes after it opened, with no
statuses on head `cdce0bad`. Two things lined up:

- **No run started.** The branch arrived in one push: a `src/` commit with a
  docs-only tip on top. Forgejo evaluates `push` `paths-ignore` for a new-branch
  push against the tip commit's files only, so `ci.yml`'s
  `paths-ignore: docs/**, **/*.md, LICENSE` matched and no run was created.
  `.forgejo/workflows/ci.yml` no longer has `paths-ignore`, so every push runs CI.
- **The gate accepted the absence.** Automerge plus a settled head was treated
  as "genuinely no CI". The settle window counts from the committer date, not
  the push time, so an agent commit made more than 5 minutes before its push
  looks settled at once.

Any other managed repo whose CI uses `push` `paths-ignore` can still hit case C
on a new-branch push. That now shows up as a visible `checks-missing` hold
rather than a silent merge.

## Workflow runs held for approval

When the live `getPRMergeGate` read reports `checkStatus: "held"`, GitHub is
holding one or more of the head commit's workflow runs in `action_required`
(awaiting manual approval, zero jobs started) and no check has genuinely failed.
The PR is blocked, but not as failing CI: `tryMerge` logs
`skipped: N workflow runs held for approval` at info level (not the warn-level
`skipped: checks failed`). For an approved PR the block reason says the runs are
held for approval on GitHub rather than that CI is failing.

A held run starts no jobs, so it can be missing from `getPRMergeGate`'s check
rollup entirely — the rollup then reads `passing` or `none` on a head that
still has a run stuck in `action_required`. `tryMerge` does not trust the
rollup for this: on GitHub (never on Forgejo, which has no such hold), right
before deciding whether checks are ok, it calls `listHeldWorkflowRuns` directly
against the Actions API for the live head SHA. Any runs it finds override the
rollup's status to `held`, and `N` is taken from that live count rather than
the gate's `checksHeld`; the count is also recorded in memory
(`recordHeldRuns` in `src/workflow-hold.ts`), keyed on the head SHA, so `/prs`
can show the hold even when the rollup never lists the run at all
([pr-dispatcher.md](pr-dispatcher.md#held-workflow-runs-action_required)). A
listing error blocks the merge rather than risking a merge on an unverified
hold, but — being transient, like a rate-limit blip — does not post a "Merge
blocked" comment; see the list below. `pr-dispatcher` approves these runs itself for
trusted dependency-update PRs from a branch in the same repository. Anything
else waits for a human to approve the runs
([pr-dispatcher.md](pr-dispatcher.md#held-workflow-runs-action_required)). Once
the approved runs finish, the PR is evaluated like any other.

## Trusted Renovate updates

A Renovate PR merges without a dashboard approval when
`isRenovateExempt` (`src/agents/auto-merger.ts`, helpers in `src/renovate.ts`)
holds — it is one of `isApprovalExempt`'s categories, alongside Dependabot,
`claws/docs-`, `claws/ideas-collect-` and auto-bump. A merge approval on any of these never adds a review gate (Renovate's own review gate applies approved or not):

- **Trusted author.** Not a fork, head branch `renovate/…`, and authored by the
  Renovate app (`renovate[bot]` / `app/renovate`), by the Forgejo `renovate`
  account on a Forgejo repo only, or by a login `gh.isAllowedHumanActor`
  accepts (fleet-infra's Renovate runs under the operator's PAT). Claws' own
  accounts, other bots and unlisted logins never qualify, and Claws'
  installation token cannot open a PR as any of these, so the #3219 threat
  model holds.
- **Not a major update.** `classifyRenovateUpdate` counts a `major-update`
  label, a title ending `(major)`, a `renovate/major-` branch, Renovate's
  `to v<N>` title shape (no dots; Renovate titles the PR with its first
  commit's subject) and a `major` row in the Update column of *any*
  `| Package | Update | Change |` table in the body (the table may sit below
  text Claws prepended). The `Update` column is read first; when no table has
  one, each row's `Change` cell is compared by leading major version (range
  prefixes such as `^ ~ == >=` and a `v` are ignored, so a 0.x minor bump is
  non-major) and any row whose major differs makes the PR major. A PR is
  classed unknown only when neither column yields a reading or a `Change` row
  cannot be parsed. With no signal at all the PR fails closed and is
  treated as major: the skip is logged as
  `skipped: not approved — update type unknown (body has no Renovate table); approve the merge from the Claws dashboard`,
  and `/prs` shows the same text as the Awaiting approval badge title, so an
  operator can tell a classification failure from a real major. Other
  not-approved PRs keep the generic wording. Claws agents never replace a
  Renovate/Dependabot body (see [pr-dispatcher.md](pr-dispatcher.md)), so the
  table normally survives CI fixes.

The `Automerge` label Renovate adds is never read. An exempt Renovate PR then
runs the same review gate as an approved PR — a clean Claws review whose
reviewed commit prefixes the current head, logging
`skipped: trusted Renovate update but review status=…` or
`… but clean review is stale` otherwise — followed by the infra, CI and
conflict gates every PR runs. Like every PR it is accepted on `status=none`
only under the rules in [No CI result on the head](#no-ci-result-on-the-head-statusnone).
A row with `needsHumanReview` or a recorded merge hold
(`manual_action_reason`) still blocks it.

## Auto-bump PRs

An `auto-bump` PR (an `automation/bump-*` branch) is approval-exempt only while its
diff passes the structural gate `checkAutoBumpDiff`: every changed file a YAML
manifest outside `.github/` (plus, optionally, one anchored tag append to, or one
swap of the outgoing tag for the bumped-to tag in, or removal of only the outgoing tag(s) from, a registry allowlist file:
fleet-infra's `apps/registry/config.json` or production-infra's
`infrastructure/prod/registry/config.json`),
and every manifest hunk an image-pin rewrite — the same image re-pinned to a new tag
or digest, either an `image:`/`newTag:` line or an env-var `value:` re-pin (the
Claws statefulset's `CLAWS_SESSION_IMAGE`; its tag counts for the allowlist check,
any other `value:` change fails). A same-registry bump therefore merges on green CI
with no approval and no Claws review.

`isRegistryAllowlistBump` compares allowlist entries with their trailing comma
stripped. An entry removed and re-added identical apart from its comma is a comma
fix and pairs off; what is left must be exactly one added entry for a bumped-to
tag and, for a swap, one removed entry for an outgoing tag, with the same number
of comma-terminated lines on both sides (an append may add one). With no added
entry, a pure removal is accepted when every removed entry is an outgoing tag's
(the bumped-to tag is already listed because another app pins it, production-infra
#86, #clw_01M5359MZ63V20XB4T4BC3M1W2) and each takes exactly one comma line with it. This accepts a
swap that drops an old entry from the middle of a sorted list and moves the comma
onto the previous last entry (production-infra #36,
#clw_01M4TK4C1E6VHMC09T13HDCBHJ); two net additions, any other key, or a removed
entry that is not an outgoing tag fail.

A failing gate withdraws only the exemption, not the merge
(#clw_01M4RV5WKJT5XQN89BKMN7X8RH). `isApprovalExempt` reads the verdict, so the PR
takes the ordinary path:

- **With a stored merge approval** it merges like any other approved PR — a clean
  Claws review of the current head, then the infra, CI, held-run and conflict gates.
- **Without one** it is held with one of three reasons, logged at info as
  `skipped: not approved — <reason>; approve the merge from the Claws dashboard`:
  `auto-bump diff is not an image-pin-only bump` (for example a registry-host
  migration, where the image name and its `# renovate: depName=` comment change),
  `auto-bump PR touches non-bump files`, or
  `auto-bump PR has no readable changed files`. The first two are the one block
  reported on an unapproved PR: the `### Merge blocked` comment says the auto-bump
  exemption does not apply and that merging needs a merge approval (Automerge or
  Merge). The third is log-only: `getPRChangedFiles` returns `[]` on a read
  error, and the dispatcher's empty-PR closer handles genuinely empty PRs.

`/prs` shows the held PR as non-exempt: an Automerge button and an Awaiting approval
badge titled with the hold reason (`approvalHoldReason`).

The verdict is cached per PR head (`autoBumpGateVerdict`, 15-minute TTL, 500
entries) so `/prs`, the ci-fixer and the PR dispatcher share it; each sweep's
`tryMerge` recomputes it from the files it already read, so the merge never acts on
a stale verdict. A PR with no head SHA is never cached.

## Infra paths and the no-op plan exception

Any PR touching an infra path (`gh.isInfraPath`: `tofu/`/`terraform/`, `*.tf`,
`*.tfvars`, `.terraform.lock.hcl`, a workflow/action naming tofu or terraform)
is held for a human merge (#2275). A plan comment alone never gates a merge: it
is spoofable, absent whenever the plan job failed, and a workflow-only change
that never planned destroyed two prod servers (production-infra#841). The gate
outranks a merge approval and every exemption, with one narrow exception.

A PR merges without a human when all of these hold:

- It is a Dependabot PR or a trusted non-major Renovate PR (`isRenovateExempt`),
  on a GitHub repo — the plan evidence needs the Actions API, so a Forgejo infra
  PR always waits for a human.
- Every changed file is a provider pin: basename `versions.tf` or
  `.terraform.lock.hcl` (`isInfraPinOnly` in `src/tofu-plan.ts`). One other file
  of any kind — a `.tf` resource file, a workflow, a script — disqualifies it.
- `gh.getTofuPlanEvidence` verifies a no-op plan for the live head: the newest
  `Tofu Plan` workflow run on exactly that SHA is `completed`/`success`, and the
  newest `github-actions[bot]` plan comment (production-infra's
  `<!-- tofu-plan -->` marker or bstjohn-blog's `### Tofu plan (tofu/)` heading)
  was last edited inside that run's `created_at`..`updated_at` window. Both
  workflows post the comment mid-run, so a comment from an older head or an
  earlier run falls outside it. Comments by anyone else are ignored.
- The comment reads as zero changes: production-infra's
  `**0 to add, 0 to change, 0 to replace, 0 to destroy.**`, or OpenTofu's
  `No changes. Your infrastructure matches the configuration.` A raw
  `Plan: N to add, N to change, N to destroy.` line is read too, with `replace`
  counted from `# … must be replaced` lines and any other term (`to import`)
  counted as a change; a body with neither form is unparseable.
- A clean Claws review of the current head (Dependabot included), and CI
  `passing` — `status=none` is not accepted, since the plan run is itself a
  check — then the held-run, conflict and merge-window gates every PR runs.

Anything else fails closed. A plan with changes logs
`skipped: infrastructure plan shows N changes, human merge required (…)`; a
missing, unparseable, failed, cancelled, running or stale plan logs
`skipped: infrastructure plan not available for head <sha7> (<detail>)`
(log-only, no Merge blocked comment — it usually resolves on a later sweep); a
verified no-op logs
`no-op Tofu plan verified for head <sha7>; allowing a trusted dependency merge`.
`/prs` shows the same verdict as one line after the infra badge: `Plan shows N
changes — human merge required`, `Plan not available for this head: <detail>`,
or `No-op plan — merging on next cycle`. The dashboard's own **Merge infra**
button still needs its confirm dialog (`confirmInfra`).

## Merge-blocked status comment

Once `tryMerge` knows a PR is human-approved — its `claws_prs` row carries a merge
approval with a named approver — any
later gate that stops the merge is reported:

- A single Claws comment headed `### Merge blocked`, ending with the
  `claws-merge-status` marker, states the reason (a recorded manual action,
  review not clean, stale review, unreadable changed files, infra paths, CI
  failing or unfinished, N workflow runs held for approval, merge conflicts,
  or a doc/ideas content mismatch). A recorded manual action is
  checked first and reported whenever the row also carries a merge approval,
  before the review and CI gates run; the comment names the recorded reason
  and how to clear it once the step is done: the dashboard's **Clear manual
  action** button or a session's `claws_clear_pr_manual_action` tool; moving
  the linked issue out of `Blocked` does not lift it. No forge label carries it
  (#clw_01M4TABN7ZFQ3MG5KK85GFGWNK). A reviewer escalation records the reason as
  `review escalated: <summary>`, so the comment and badge say what the human
  must settle; approving the merge does not clear it, because the escalated review
  verdict still blocks the merge; the reason clears when a later review round
  is clean or advisory-only. It is edited in
  place when the reason changes, left untouched when the text is unchanged,
  and left in place after the PR merges.
- The same reason is kept in memory (`gh.setMergeBlockReason`, 1-hour TTL,
  cleared on merge) and shown as a `⚠ Merge blocked` badge on
  `/prs`. After a restart the badge is empty until the next sweep.

Apart from an auto-bump PR held because its diff fails the auto-bump gate (see
[Auto-bump PRs](#auto-bump-prs)), nothing is reported before approval is established — fork, no `claws_prs` row, a
recorded manual action on an unapproved PR, closed, dispatch guard, or no merge approval — or for five transient
states: no checks registered yet on a fresh head, mergeability still `UNKNOWN`
after retries, the head moving between evaluation and merge, an
approved PR whose Claws review status is still `none` — no review of the
current head has run yet (#3122) — and a listing error while verifying held
workflow runs live against the Actions API.

Approval-exempt PRs (Dependabot, `claws/docs-`, `claws/ideas-collect-`,
auto-bump, trusted non-major Renovate) are `approved` only when their row carries a
dashboard merge approval; in that case a later block is reported like any approved
PR's. An unapproved exempt PR's blocks stay log-only — failing CI, infra paths, a
docs PR containing non-doc changes — so the job log is the only place that reason
appears. An auto-bump PR whose diff fails the auto-bump gate is not exempt at all,
and its hold is reported (see [Auto-bump PRs](#auto-bump-prs)).

An approval never adds a review gate to an exempt PR: `isApprovalExempt` is evaluated
before the merge-approval branch, so an approved Dependabot PR merges on green, settled CI
with no Claws review (#clw_01M46YW6WPNPH0545G6KJB1AWD — bonkus #1956–#1958 waited 10–15
minutes for reviewer runs after Automerge was pressed on 2026-10-05, while unapproved
Dependabot PRs merged at once). A trusted Renovate PR keeps its review gate, approved or not.
`/prs` shows an **Approval-exempt** chip instead of an Automerge button on these rows.

## Post-merge cleanup for `claws/issue-…` PRs (#3338)

Merging a `claws/issue-<id>-…` PR runs two independent steps
(`finalizeMergedClawsPR` in `src/agents/auto-merger.ts`). This runs for every
merge route, not just this job's own:

- `tryMerge` calls it after a merge it performs itself.
- The dashboard's `POST /queue/merge` calls it after `mergePR` succeeds — a
  cleanup failure there is logged but does not fail the merge response.
- A PR a human merged directly on GitHub/Forgejo is caught by the PR
  dispatcher's `refreshPrStore`: when a `claws_prs` row linked to an issue
  moves to `merged`, it calls the same cleanup, tagged `hand-merge` in the
  logs (see [pr-dispatcher.md](pr-dispatcher.md)).

The cleanup is idempotent, so running it twice for one merge is harmless.

- **Multi-PR completion**: `loadMergedIssuePhases` reads the issue's phase
  state (its primary repo for a native id) and, once every step is merged or
  claimed and the issue is still open, `closeCompletedMultiPRIssue` posts one
  Implementer comment and closes it as `completed` — steps of a parallel plan
  can merge in any order, so the PR that completes the plan may carry no
  `Closes` line at all. A single-phase plan skips this read entirely, and a
  failed read only logs; the issue-auditor is the backstop.
- **`closeNativeIssuesClosedBy`** honours any `Closes #clw_…` line for
  Claws-native issues, re-reading the PR body rather than trusting a cached
  copy.

`sweepRepo` itself no longer reads issues at all: the `In Review` label and
the reconciling sweep that cleared it were retired
(#clw_01M39G3H99HV6ED4378ZXHER6K). An issue whose PR closed unmerged goes back
to Awaiting plan review on `issue-auditor`'s next daily run.

## Skip reason codes

`claws_recent_job_logs` redacts free-text log messages and returns only the
structured `diagnostic_reason` and `diagnostic_context`, so each skip carries a
`mergeSkip` code (`MergeSkipCode` in `src/agents/auto-merger.ts`) alongside
its human-readable line (#clw_01M4TK4C1E6VHMC09T13HDCBHJ):

| Code | Meaning |
|---|---|
| `fork` | Fork PR |
| `no-record` | No `claws_prs` row |
| `manual-action` | A manual action or reviewer escalation is recorded |
| `stacked` | A `claws/` PR targets a branch other than the default |
| `reapproval-hold` | Held by a design change on its issue |
| `closed` | Live state is not `OPEN` |
| `dispatch-guard` | `isDispatchSkippable` rejected it (from the PR list or live labels) |
| `other-work` | A ci-fixer, conflict fixer, review-addresser or reviewer is running on it |
| `review-not-clean` / `review-stale` | A required clean review of the current head is missing |
| `auto-bump-gate` | An auto-bump PR failed `checkAutoBumpDiff` and has no approval |
| `not-approved` | Not approval-exempt and no stored merge approval |
| `unreadable-files` | Changed files could not be read |
| `infra` / `infra-plan` | Infrastructure paths, or a Tofu plan with changes or none for the head |
| `doc-pr-mixed` / `ideas-pr-mixed` | A docs or ideas PR with other files |
| `checks-pending` / `checks-failed` / `checks-held` | CI not finished (or not yet registered on a fresh head), failing, or held for approval |
| `checks-missing` | A settled head has no CI result, nothing carries one forward, and the repo's CI normally reports on PRs |
| `held-runs-unverified` | Listing held workflow runs failed |
| `conflict` / `mergeable-unknown` | Merge conflicts, or mergeability still `UNKNOWN` |
| `head-moved` | The head moved or was unmergeable at merge time |
| `error` | `tryMerge` threw (logged at warn) |

Query them with `claws_recent_job_logs` and `job_name: "auto-merger:sweep"`:
that filter also matches the `auto-merger` scheduler job, which runs the
sweep for every repo, and the `work:auto-merger:sweep` queue runs. There is
one `merge_sweep_done` entry per repo per sweep, about every three minutes.
Queue rows exist only for sweeps chained after an agent run, so a repo with no
`auto-merger:sweep` rows in the work queue is still being swept.

## Restart durability

Chained `auto-merger:sweep` rows live in `work_queue` on both SQLite and
Postgres, so they survive a restart; `recoverWorkOnStartup` requeues any row
left `running`. The scheduler job needs no recovery — it simply runs again
after boot. The hand-merge close-out is driven by
the `claws_prs` rows, so a merge that happens across a restart is picked up on
the PR dispatcher's next tick.

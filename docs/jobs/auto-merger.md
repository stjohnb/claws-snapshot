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
- A module-level set of repos being swept makes a second concurrent
  `sweepRepo` for the same repo return immediately, so the scheduler job and a
  chained queue row never sweep one repo at once. The scheduler's
  `runningFlags` already stops the job overlapping itself, and `mergePR` is
  pinned to the evaluated head SHA.
- In staging mode (`CLAWS_ACTIVATION_STATE=staging`) the job is part of the
  staging lane (`STAGING_PIPELINE_JOB_NAMES`); `isDispatchSkippable` still
  limits it to `Claws Staging` PRs.

## Out-of-hours window

`tryMerge` does not merge a third-party update PR (Renovate, Dependabot, or a
`renovate/*`/`dependabot/*` branch) while the host's `thirdPartyUpdateWindow` is
closed. The check runs after the fork pre-filter and before the `claws_prs` row
read and the live `getPRMergeGate` read, and logs
`skipped: third-party update outside the out-of-hours window (22:00–07:00 Europe/London)`
with no "Merge blocked" comment, which would otherwise land on every such PR each
day. Own-app `automation/bump-*` PRs never match, so image bumps merge as usual.
A repo opts out with `"dependencyUpdateWindow": false` in its `claws.json`. The
same rule stops `pr-dispatcher` enqueuing work for these PRs
([pr-dispatcher.md](pr-dispatcher.md#out-of-hours-window-for-third-party-updates)).

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

Inside the window, a Renovate PR merges without a dashboard approval when
`isRenovateExempt` (`src/agents/auto-merger.ts`, helpers in `src/renovate.ts`)
holds — it is one of `isApprovalExempt`'s categories, alongside Dependabot,
`claws/docs-`, `claws/ideas-collect-` and auto-bump:

- **Trusted author.** Not a fork, head branch `renovate/…`, and authored by the
  Renovate app (`renovate[bot]` / `app/renovate`), by the Forgejo `renovate`
  account on a Forgejo repo only, or by a login `gh.isAllowedHumanActor`
  accepts (fleet-infra's Renovate runs under the operator's PAT). Claws' own
  accounts, other bots and unlisted logins never qualify, and Claws'
  installation token cannot open a PR as any of these, so the #3219 threat
  model holds.
- **Not a major update.** `isRenovateMajorUpdate` counts a `major-update`
  label, a `major` row in the Update column of Renovate's
  `| Package | Update | Change |` body table, a title ending `(major)` or a
  `renovate/major-` branch. A body with no parseable Update column fails
  closed and is treated as major.

The `Automerge` label Renovate adds is never read. An exempt Renovate PR then
runs the same review gate as an approved PR — a clean Claws review whose
reviewed commit prefixes the current head, logging
`skipped: trusted Renovate update but review status=…` or
`… but clean review is stale` otherwise — followed by the infra, CI and
conflict gates every PR runs. Unlike Dependabot it is not accepted on
`status=none`. A row with `needsHumanReview` or a Manual Action still blocks it.

## Merge-blocked status comment

Once `tryMerge` knows a PR is human-approved — its `claws_prs` row carries a merge
approval with a named approver — any
later gate that stops the merge is reported:

- A single Claws comment headed `### Merge blocked`, ending with the
  `claws-merge-status` marker, states the reason (a recorded manual action,
  review not clean, stale review, unreadable changed files, infra paths, CI
  failing or unfinished, N workflow runs held for approval, merge conflicts,
  or a doc/ideas/auto-bump content mismatch). A recorded manual action is
  checked first and reported whenever the row also carries a merge approval,
  before the review and CI gates run; the comment names the recorded reason
  and how to clear it (the dashboard's **Clear manual action** button or a
  session's `claws_clear_pr_manual_action` tool), since removing the forge
  label does not. It is edited in
  place when the reason changes, left untouched when the text is unchanged,
  and left in place after the PR merges.
- The same reason is kept in memory (`gh.setMergeBlockReason`, 1-hour TTL,
  cleared on merge) and shown as a `⚠ Merge blocked` badge on
  `/prs`. After a restart the badge is empty until the next sweep.

Nothing is reported before approval is established — fork, no `claws_prs` row, a
recorded manual action on an unapproved PR, closed, dispatch guard, or no merge approval — or for five transient
states: no checks registered yet on a fresh head, mergeability still `UNKNOWN`
after retries, the head moving between evaluation and merge, an
approved PR whose Claws review status is still `none` — no review of the
current head has run yet (#3122) — and a listing error while verifying held
workflow runs live against the Actions API.

Approval-exempt PRs (Dependabot, `claws/docs-`, `claws/ideas-collect-`,
auto-bump, trusted non-major Renovate) are never marked approved at all, because `approved` is only set on
the merge-approval branch. So *every* later block on them is log-only too —
failing CI, infra paths, a docs PR containing non-doc changes, an auto-bump PR
touching non-bump files. An operator whose docs PR is stuck on red CI gets no
"Merge blocked" comment and no dashboard badge; the job log is the only place
that reason appears.

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

## Restart durability

Chained `auto-merger:sweep` rows live in `work_queue` on both SQLite and
Postgres, so they survive a restart; `recoverWorkOnStartup` requeues any row
left `running`. The scheduler job needs no recovery — it simply runs again
after boot. The hand-merge close-out is driven by
the `claws_prs` rows, so a merge that happens across a restart is picked up on
the PR dispatcher's next tick.

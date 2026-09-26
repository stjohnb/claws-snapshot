# auto-merger

**Deep dive.** Read this when you're changing how often open PRs are evaluated
for merge, or how a blocked merge is reported. For the merge gates themselves
(**Automerge**, CI, infra paths), read the Merger section of
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
**Automerge** being applied, CI going green, or a conflict being resolved.

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
closed. The check runs after the cheap `Manual Action` pre-filter and before the
live `getPRMergeGate` read, and logs
`skipped: third-party update outside the out-of-hours window (22:00–07:00 Europe/London)`
with no "Merge blocked" comment, which would otherwise land on every such PR each
day. Own-app `automation/bump-*` PRs never match, so image bumps merge as usual.
A repo opts out with `"dependencyUpdateWindow": false` in its `claws.json`. The
same rule stops `pr-dispatcher` enqueuing work for these PRs
([pr-dispatcher.md](pr-dispatcher.md#out-of-hours-window-for-third-party-updates)).

## Merge-blocked status comment

Once `tryMerge` knows a PR is human-approved — it carries **Automerge** — any
later gate that stops the merge is reported:

- A single Claws comment headed `### Merge blocked`, ending with the
  `claws-merge-status` marker, states the reason (review not clean, stale
  review, unreadable changed files, infra paths, CI failing or unfinished,
  merge conflicts, or a doc/ideas/auto-bump content mismatch). It is edited in
  place when the reason changes, left untouched when the text is unchanged,
  and left in place after the PR merges.
- The same reason is kept in memory (`gh.setMergeBlockReason`, 1-hour TTL,
  cleared on merge) and shown as a `⚠ Merge blocked` badge on
  `/prs`. After a restart the badge is empty until the next sweep.

Nothing is reported before approval is established — fork, **Manual Action**,
closed, dispatch guard, or no **Automerge** label — or for four transient
states: no checks registered yet on a fresh head, mergeability still `UNKNOWN`
after retries, the head moving between evaluation and merge, and an
**Automerge** PR whose Claws review status is still `none` — no review of the
current head has run yet (#3122).

Approval-exempt PRs (Dependabot, `claws/docs-`, `claws/ideas-collect-`,
auto-bump) are never marked approved at all, because `approved` is only set on
the **Automerge** branch. So *every* later block on them is log-only too —
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

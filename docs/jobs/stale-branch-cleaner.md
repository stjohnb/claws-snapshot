# stale-branch-cleaner

**Source**: `src/jobs/stale-branch-cleaner.ts`
**Trigger**: Smart-scheduled (hourly during off-hours)
**Schedule**: Runs hourly during the configured quiet window (default 19:00–07:00 local time). Each tick processes all repos that haven't been processed today. Skips the tick entirely if Claws has active or pending Claude tasks, or running jobs.

Scans remote `claws/*` branches in all cloned repos and deletes stale ones
whose associated PRs have been merged or closed for more than 7 days. Cleans
up the hundreds of branches (issue-\*, plan-\*, improve-\*, docs-\*,
investigate-\*, ideas-\*) that accumulate after PRs merge.

- Only processes repos that Claws has previously cloned
- Lists remote branches via `git for-each-ref refs/remotes/origin/claws/`
- For each branch:
  - **Age guard**: Skips branches less than 7 days old
  - **Open PR check**: Skips branches with any open PR (never deletes active work)
  - **Merged/closed PR check**: Eligible if the associated PR was merged or
    closed more than 7 days ago
  - **Orphaned branches**: Branches with no associated PR are eligible if older
    than 7 days (likely failed attempts or abandoned work)
- Deletes via the GitHub REST API (`DELETE /git/refs/heads/<branch>`)
- Handles 422/404 gracefully (branch already deleted by GitHub auto-delete)
- Checks `isRateLimited()` before each repo and between branches

PR lookups are batched: `gh.listPRsForBranches()` fetches all candidate branches'
PRs for a repo in one `gh api graphql` call (aliased per-branch fields, chunked
at 50 branches), rather than the older one-`gh pr list`-per-branch design —
avoids both per-branch subprocess overhead and the truncation/ordering risk of
a single `gh pr list --repo X --state all` sweep (#2293). A branch whose name
fails the safe-branch-name check, or that GraphQL didn't return, is skipped
rather than deleted.

Does not create worktrees, PRs, or invoke Claude — purely git and `gh` CLI
calls.

# repo-standards

**Source**: `src/jobs/repo-standards.ts`
**Trigger**: Daily schedule (also runs once on startup)
**Schedule**: Runs at hour configured by `schedules.repoStandardsHour`
(default: 2 AM local time)

Only processes repos that Claws has previously cloned. For each repo:

- **Syncs label definitions** — calls `ensureAllLabels()` to create/update
  all labels defined in `LABEL_SPECS` (from `config.ts`) with correct colors
  and descriptions (`Refined`, `Ready`, `Priority`, `In Review`, `Claws Ignore`)
- **Cleans up legacy labels** — removes labels in the `LEGACY_LABELS` set
  (old labels from the previous label-driven system: `Needs Refinement`,
  `Plan Produced`, `Reviewed`, `prod-report`, `investigated`,
  `claws-mergeable`, `claws-error`)
- **Enforces `.gitignore` standards** — ensures `.mcp-claws.json` is present
  in `.gitignore` for every managed repo. Reads the main clone's `.gitignore`;
  if the entry is missing, creates a worktree on a `claws/gitignore-standards-{datestamp}-{suffix}`
  branch, appends the entry with a comment, commits, pushes, and opens a PR.
  Skips if an open `claws/gitignore-standards-*` PR already exists. Handles
  missing `.gitignore` by creating it. Does **not** create worktrees or PRs if
  the entry is already present.

Label management uses the `gh` CLI only. Gitignore enforcement creates worktrees
and PRs (following the same pattern as `doc-maintainer.ts`) but does not invoke Claude.

## Stale Repo Cleanup

After processing all active repos, `cleanupStaleRepos()` removes local directories
for repos that are no longer in the configured `GITHUB_OWNERS` set:

- Deletes the main clone under `~/.claws/repos/{owner}/{name}`
- Deletes the worktree directory under `~/.claws/worktrees/{owner}/{name}`
- Removes the pending-ideas file under `~/.claws/pending-ideas/{owner}-{name}.json`
- Removes empty owner-level directories after all their repos are removed

Cleanup is skipped if the active repo list is empty (transient fetch failure guard)
or if the GitHub API is currently rate-limited.

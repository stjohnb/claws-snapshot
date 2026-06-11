# doc-maintainer

**Source**: `src/jobs/doc-maintainer.ts`
**Trigger**: Smart-scheduled (hourly during off-hours)
**Schedule**: Runs hourly during the configured quiet window (default 19:00–07:00 local time). Each tick processes all repos that haven't been processed today. Skips the tick entirely if Claws has active or pending Claude tasks, or running jobs.

- Only processes repos that Claws has previously cloned (checks for
  `~/.claws/repos/<owner>/<repo>`)
- Skips if an open `claws/docs-*` PR already exists for the repo
- Skips if HEAD matches the last `[doc-maintainer]` commit (no new code
  changes to document)
- Creates a worktree on branch `claws/docs-<hex4>`
- Before running Claude, fetches recently-closed issues that had
  implementation plans and writes them to a temporary `.plans/` directory
  in the worktree (capped at 10 plans, each truncated to 5,000 characters)
- The time window for fetching closed issues is "since the last
  `[doc-maintainer]` commit", falling back to 7 days if no prior
  doc-maintainer commit exists
- Claude is instructed to extract valuable architectural context, design
  decisions, and patterns from these plans into the documentation
- The `.plans/` directory is cleaned up after Claude runs and is never
  committed
- Instructs Claude to create/update `docs/OVERVIEW.md` and supporting docs
- If commits were produced: pushes and creates a PR titled
  `docs: update documentation for <repo>` (auto-merged by the merger
  agent once checks pass, with a safety guard ensuring only doc files are
  changed)
- After all repos are processed, posts a single Slack summary via the
  webhook (if configured): counts PRs opened, lists each PR with the
  feature plan titles it incorporated, and lists repos that were skipped
  (open docs PR, no changes since last run) or errored. Silent on
  fully-quiet runs where nothing was created, failed, or produced empty
  commits.

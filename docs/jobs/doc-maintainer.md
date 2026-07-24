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

## Human-intent capture (#2090)

Alongside `.plans/`, the job gathers human-authored intent — the repo owner's
own issue/PR bodies and comments, filtered to exclude bot- and Claws-authored
content (`isHumanLogin()`: drops the self login, any `[bot]`-suffixed login,
and any `app/*` login; comments matching `gh.isClawsComment()` are dropped
too) — and asks Claude to fold it into `docs/intent-log.md`, a chronological,
append-oriented record. Newer entries may contradict older ones; the prompt
tells Claude to keep both rather than rewrite history.

- **First run per repo** (detected by the *absence* of `docs/intent-log.md`,
  not by `lastDocSha` — every repo the job has ever touched has a non-null
  `lastDocSha`, so that alone can't signal whether this feature has run
  before) does an **unbounded historical scan**: up to 500 closed issues and
  500 merged PRs, no `since` cutoff. This also exempts the "HEAD unchanged →
  skip" fast path, so a repo doc-maintainer has already processed still gets
  one full intent pass the first time this feature reaches it.
- **Subsequent runs** are windowed to items closed/merged since the last
  `[doc-maintainer]` commit (capped at 100 fetched, 25 written after
  newest-first sorting and truncation) — the same incremental cadence as
  `.plans/`.
- Each qualifying item is written to `.intent/<kind>-<number>.md` (e.g.
  `.intent/issue-1650.md`, `.intent/pr-1934.md`) containing the human-authored
  body (if any) and a bulleted list of human comments; item/comment bodies
  over 2,000 chars are truncated. All GitHub-supplied text (title, body,
  comments) is passed through `guardContent()` before being written, since it
  becomes input to the doc-writing Claude call.
- If intent items were captured but the agent didn't create/update
  `docs/intent-log.md`, the job logs a warning — the next run's first-run
  detection will re-trigger the full historical scan, since the file still
  won't exist.
- `.intent/` is cleaned up after Claude runs and is never committed;
  `docs/intent-log.md` itself is a real, permanent doc.

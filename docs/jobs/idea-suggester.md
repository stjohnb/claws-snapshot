# idea-suggester

**Source**: `src/jobs/idea-suggester.ts`
**Trigger**: Manual only — triggered from the dashboard "Run" button or `POST /trigger/idea-suggester`; there is no timer
**Schedule**: None. The job is registered with `manualOnly: true` (see `src/scheduler.ts`), so it is never scheduled automatically. When triggered it processes every non-disabled repo, 3 at a time.

Only processes repos that Claws has previously cloned (checks for
`~/.claws/repos/<owner>/<repo>`). Workspace presence = opt-in, matching
the pattern used by doc-maintainer, improvement-identifier, and
repo-standards.

- Loads all `.md` files from the repo's `ideas/` directory as dedup
  context (capped at ~50KB) — includes previously suggested, accepted,
  and rejected ideas
- Fetches open issue and PR titles for additional dedup
- Creates a worktree on branch `claws/ideas-<hex4>`
- Injects reference material via the `resources` prompt parameter — currently
  marketing strategy knowledge from `src/resources/marketing.ts`
- Instructs Claude to read `docs/OVERVIEW.md` (if it exists), analyze
  the repo, identify focus areas, and suggest ideas grouped by those areas
- Claude responds with structured JSON containing `focusAreas` (ordered
  list of area names) and `ideas` (a map of area name to idea arrays);
  empty results are acceptable
- Discards every idea scoring below 7 out of 10, then files at most the
  top 3 remaining ideas directly as GitHub issues on the repo
- Before each create, checks `findIssueByExactTitle` against the repo's
  open issues and skips the idea if a matching title is already open.
  Filing is sequential on purpose: `createIssue` invalidates the
  open-issues cache, so two near-identical ideas in the same run dedup
  against each other
- The issue body is the idea description plus a footer naming the focus
  area and the idea's score
- Issues are filed unlabelled, so `issue-dispatcher` picks them up and
  `issue-refiner` plans them — there is no human triage step before that
- A failed create is logged and the remaining ideas still file

## Focus areas and configuration

Repos configure idea generation through `ideas/overview.md`:

    # Ideas

    ## Focus Areas

    - Performance optimization
    - Developer onboarding
    - Security hardening

When focus areas are declared, Claude prioritizes the listed areas but may
suggest up to 2 additional areas if it identifies strong opportunities.
When no focus areas are declared, Claude identifies them dynamically for
that run.

## Disabling idea generation

To disable idea generation for a repository, indicate this in
`ideas/overview.md`. For example:

    # Ideas

    Idea generation is currently disabled for this repository.

    Do not suggest any new feature ideas or growth strategies at this time.

Claude reads `overview.md` and assesses whether the repository owner wants
idea generation disabled. When it determines ideas are unwanted, the repo
is skipped entirely — no worktree, no idea generation call, no issues filed.

To re-enable, update the file to indicate ideas are welcome again.

## History tracking

All files in the `ideas/` directory (including `rejected.md`) are read
and passed to Claude as context, so it avoids re-suggesting previously
triaged ideas. No database schema changes needed.

## Run summary

After every repo has been processed the job logs a summary line showing
how many repos had ideas filed (with issue and duplicate counts), how
many had no new suggestions, and which were skipped or errored. Repos
without local clones (not opted in) are excluded; if every repo is
excluded, nothing is logged.

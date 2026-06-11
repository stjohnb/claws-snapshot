# idea-suggester

**Source**: `src/jobs/idea-suggester.ts`
**Trigger**: Smart-scheduled (hourly during off-hours, weekdays only)
**Schedule**: Runs hourly during the configured quiet window (default 19:00–07:00 local time). Each tick processes all repos that haven't been processed today. Uses `skipWeekends: true`. Skips the tick entirely if Claws has active or pending Claude tasks, or running jobs.
**Requires**: `slackBotToken` and `slackIdeasChannel` configured

Only processes repos that Claws has previously cloned (checks for
`~/.claws/repos/<owner>/<repo>`). Workspace presence = opt-in, matching
the pattern used by doc-maintainer, improvement-identifier, and
repo-standards.

- Skips if Slack bot is not configured (both `slackBotToken` and
  `slackIdeasChannel` must be set)
- Skips if a pending ideas file already exists for this repo (previous
  batch still awaiting collection)
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
- If suggestions exist:
  - Posts a header message to the configured Slack channel
  - Posts each idea as a thread reply with title, description, focus area,
    and reaction instructions (✅ accept | 🤔 potential | ❌ reject)
  - Writes a pending ideas JSON file to `~/.claws/pending-ideas/<owner>-<repo>.json`
    containing thread metadata and message timestamps
  - A 1-second delay between posts respects Slack rate limits

## Focus areas and configuration

Repos configure idea generation through `ideas/overview.md`:

    # Ideas

    ## Focus Areas

    - Performance optimization
    - Developer onboarding
    - Security hardening

When focus areas are declared, Claude prioritizes the listed areas but may
suggest up to 2 additional areas if it identifies strong opportunities.
When no focus areas are declared, Claude identifies them dynamically — and
the [idea-collector](idea-collector.md) will populate `overview.md` with
the discovered areas in the next collection PR.

## Disabling idea generation

To disable idea generation for a repository, indicate this in
`ideas/overview.md`. For example:

    # Ideas

    Idea generation is currently disabled for this repository.

    Do not suggest any new feature ideas or growth strategies at this time.

Claude reads `overview.md` and assesses whether the repository owner wants
idea generation disabled. When it determines ideas are unwanted, the repo
is skipped entirely — no worktree, no idea generation call, no Slack posts.

To re-enable, update the file to indicate ideas are welcome again.

## History tracking

All files in the `ideas/` directory (including `rejected.md`) are read
and passed to Claude as context, so it avoids re-suggesting previously
triaged ideas. No database schema changes needed.

## Run summary

After processing all repos, the job posts a summary message to the ideas
channel showing how many repos received ideas, how many had no new
suggestions, and which were skipped or errored. Repos without local
clones (not opted in) are excluded from the summary.

## Reaction workflow

Ideas are reviewed via Slack emoji reactions on each thread reply:
- ✅ (`white_check_mark`) — Accept: create a GitHub issue, record in ideas directory
- 🤔 (`thinking_face`) — Potential: record in `ideas/potential.md`
- ❌ (`x`) — Reject: record in `ideas/rejected.md`

The [idea-collector](idea-collector.md) job polls for these reactions and processes the results.

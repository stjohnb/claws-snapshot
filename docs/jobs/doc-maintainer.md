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
- After each scheduler tick, posts a single Slack summary for the repos
  processed in that tick via the webhook (if configured): counts PRs opened, lists each PR with the
  feature plan titles it incorporated, and lists repos that were skipped
  (open docs PR, no changes since last run) or errored. Silent on
  fully-quiet runs where nothing was created, failed, or produced empty
  commits.

## Owner requirement: per-repo lifecycle docs

Every managed repo should surface how Claws handles its issues and PRs, so a manual
session doesn't need the lifecycle re-explained each time (#1657). At the owner's own
suggestion this was folded into this job — it syncs `docs/claws-automation.md` into
each repo — rather than built as a separate mechanism.

`docs/claws-automation.md` now also carries the PRs-only contribution convention
(#2569), for the same reason and by the same mechanism: an agent session pushed a
docs commit straight to `main` in a managed repo because nothing in that repo
documented the rule. A scanner filing per-repo issues was considered and rejected —
the deterministic sync already guarantees the text lands in every repo, and the
convention is documentation-only, so there's nothing to enforce: no branch
protection, rulesets, or push-blocking automation.

## Scope: no Mac-runner fleet docs in this repo

The claws repo's own docs must not carry Mac-runner *fleet* documentation —
host inventory, keep-awake/wake strategy, runner-mode configuration. That
source of truth lives in the `nixos-config` repo:
[`docs/macos-runners.md`](https://github.com/St-John-Software/nixos-config/blob/main/docs/macos-runners.md).
A `docs/macos-runners.md` redirect stub was deliberately removed from this
repo rather than kept as a pointer (pr-2030, companion to dot-files#248) —
do not re-add one. The fleet docs lived in `dot-files` until that repo was
retired into `nixos-config` and archived (dot-files#297, PR dot-files#305,
2026-08-12); the macOS scripts moved with them to `home/mac/` and are still
installed on the Macs' `$PATH` under the same names (`keep-awake`, …), so
macOS CI jobs that call them are unaffected. Only the claws-side mechanism —
the `mac-runner-waker` job itself (SSH wake + per-job caffeinate) — belongs
in `docs/`; see its entry in [modules.md](../modules.md) and the jobs table
in [OVERVIEW.md](../OVERVIEW.md).

## Human-intent capture (#2090, reshaped by #2227)

Alongside `.plans/`, the job gathers human-authored intent — the repo owner's
own issue/PR bodies and comments — into a temporary `.intent/` directory, and
asks Claude to **ensure every requirement it states is reflected in the
standard docs a future planning agent will read**. This is a coverage check,
not a journal.

The owner's stated goal (#2227) is *"a good capture of my requirements to be
available to future agents planning features"*, and the direction was explicit:
the scheduled job should ensure human comments *"if relevant, are reflected in
the standard feature docs"*. That retired the earlier `docs/intent-log.md`
chronological journal — a planner had to resolve it into current truth, and it
was one link among many in `OVERVIEW.md`, whereas subsystem docs are already
reliably in planning context. The prompt tells the agent to `git rm` the log if
it still exists in a repo and never recreate it.

### The "ensure reflected" contract

- A subsystem requirement goes into the doc that owns that subsystem
  (`docs/OVERVIEW.md`, `docs/jobs/*.md`, or another topic doc), recorded as a
  **constraint with its rationale** ("the owner explicitly does not want X
  automated because …"), not merely as a description of current behaviour.
- A cross-cutting or process requirement that belongs to no feature doc (e.g.
  "never un-archive public mirror repos automatically", "stop filing issues
  when nothing can be done about them") goes into
  [`docs/requirements.md`](../requirements.md). A requirement that matches no
  feature doc **must** land there — never be silently dropped.
- `docs/requirements.md` is **not a catch-all**. If a doc owns the subsystem, the
  requirement goes there instead; that file's "Where subsystem requirements live"
  table records which doc currently holds what. The prompt says this explicitly,
  because the first migration off `docs/intent-log.md` reorganised the journal into
  `docs/requirements.md` by theme instead of distributing it, which reproduced the
  exact problem the migration existed to fix.
- Already-reflected requirements are left alone. When a newer statement
  contradicts a doc, the doc moves to the newer position and notes the
  supersession — the docs record the *current* position, not a history of
  positions. `.intent/` can hold items from anywhere in the repo's history, so
  the prompt warns against resurrecting a later-reversed requirement.

### Who counts as human

`isHumanLogin()` drops the self login, any `[bot]`-suffixed login, and any
`app/*` login; comments matching `gh.isClawsComment()` are dropped too.

That alone is not enough for pre-App-migration history: Claws used to post
using the owner's PAT, so machine-filed alert issues and Claws-generated PRs
carry a human login. `isMachineAuthoredBody()` catches those structurally — an
`Issue` whose title starts with `[` (the `[claws-error] …` alert convention), a
body containing `**Auto-created by Claws` or `**Fingerprint:**`, a body that
`gh.isClawsComment()` matches, or a `PR` whose `headRefName` starts with
`claws/`, `claws-wt/`, `dependabot/`, `automation/`, or `codex/`.

It applies to the **body only**. Human comments on machine-filed alert issues
are kept, because that is exactly where several real requirements live ("stop
creating issues like this if nothing can be done about it"). An item whose body
is suppressed and which has no human comments produces no `.intent/` file.

### The two fetch windows

- **Forward window** (every run): items closed/merged since the last
  `[doc-maintainer]` commit — 100 fetched per category, 25 written after
  newest-first sorting — the same incremental cadence as `.plans/`.
- **Backward backfill chunk** (until the walk finishes): the history walk that
  the original implementation never completed. It fetches up to 3,000 closed
  issues and 3,000 merged PRs with no `since` cutoff, filters to items dated
  strictly older than the recorded watermark, and hands the newest 250 to that
  run's agent pass. Progress lives in the `doc_intent_backfill` table
  (`oldest_scanned`, `complete`, `window_exhausted`); an absent row means the
  walk never started, and the walk is marked complete once a chunk exhausts the
  remaining history. Bounding the chunk keeps a run at ≤275 per-item comment
  fetches instead of the thousands a single-shot backfill would need.
  - The watermark is written **only after `runClaude` returns**, so a crash or
    timeout re-does the chunk rather than skipping it. If the unbounded `gh`
    fetch fails, the job logs a warning and leaves the watermark untouched.
  - The date filter is strictly `<`, and the watermark is day-granular, so a
    chunk must never stop part-way through a date: the leftovers would be
    excluded forever on the next run. The 250-item cap is therefore soft — the
    chunk is extended to include every item sharing its oldest date, however
    many that is (a bulk-merge day can exceed the cap on its own).
  - The 3,000-per-category fetch is a fixed top-N window, not pagination. If a
    chunk consumes everything reachable while a fetch came back at the limit,
    the walk stops in the distinct `window_exhausted` state rather than claiming
    `complete`: history older than the window is unreachable via `gh list`, and
    re-fetching the same window every night would never surface it. The job logs
    a warning naming the repo; the fix is to raise the fetch limit (or paginate)
    and clear `window_exhausted` so the walk resumes. `claws` itself is well
    inside the window (~1,100 items per category).
  - A walk that has neither finished nor stopped also exempts the "HEAD
    unchanged → skip" fast path, so the history of a dormant repo still gets
    covered.
  - Why the original never finished: the old first-run pass capped at 500
    fetched per category *and* 500 combined items, so on `claws`
    (~1,100 closed issues, ~1,100 merged PRs) the effective cutoff landed at
    2026-06-13 and incremental runs only ever moved forward.

### Mechanics

- Each qualifying item is written to `.intent/<kind>-<number>.md` (e.g.
  `.intent/issue-1650.md`, `.intent/pr-1934.md`) containing the human-authored
  body (if any) and a bulleted list of human comments; item/comment bodies
  over 2,000 chars are truncated. All GitHub-supplied text (title, body,
  comments) is passed through `guardContent()` before being written, since it
  becomes input to the doc-writing Claude call.
- Comment fetches run through `mapSettledWithConcurrency` at concurrency 6, so
  one failing item doesn't abort the pass.
- `.intent/` is cleaned up after Claude runs and is never committed — the doc
  edits the agent made from it are what persists.

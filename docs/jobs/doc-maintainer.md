# doc-maintainer

**Source**: `src/jobs/doc-maintainer.ts`
**Trigger**: Smart-scheduled
**Schedule**: Evaluated hourly via the shared staleness-based smart-scheduling loop. A repo is due once it has not been processed within the target staleness window (24h by default); the busy gate defers routine runs while Claws is occupied, but the SLO escape valve still forces badly stale repos through. The legacy `smartScheduling.quietHourStart` / `quietHourEnd` settings remain accepted in config for compatibility but are no longer used.

- Only processes repos that Claws has previously cloned (checks for
  `~/.claws/repos/<owner>/<repo>`)
- Skips if an open `claws/docs-*` PR already exists for the repo
- Skips if HEAD matches the last `[doc-maintainer]` commit (no new code
  changes to document) — unless one of four exemptions holds: the Claws
  automation doc is stale, the intent backfill is still walking history, the
  agent-memory digest changed, or the repo is missing an `.agents/*.md` role
  document (see [Agent-guidance maintenance](#agent-guidance-maintenance))
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
- Posts **no** Slack summary (#2642). The old per-tick "N PRs opened / No-op"
  message was noise the owner did not read. Failures still reach Slack and
  GitHub through `reportError("doc-maintainer:process-repo", …)`, which
  `log.error`s (Slack) and files a deduplicated `[claws-error]` issue;
  routine outcomes are visible on the dashboard and in the job logs.

## Progressive-disclosure doc contract

The prompt enforces a three-layer structure across every repo's `docs/`:
`OVERVIEW.md` is the Layer-1 index (a scannable doc map, scanned without
commitment), the dedicated docs it links to are Layer-2 context (each opening
with a short "Read this when" block that lets an agent stop reading if it
opened the wrong one), and the body of each dedicated doc is Layer-3 detail
(read in full only once the reader knows they need it).

Every doc map row and dedicated-doc header uses exactly one of three fixed
depth labels — **Entry point**, **Reference**, **Deep dive** — never
paraphrased wording, so the map stays scannable across regenerations instead
of accumulating synonyms.

Retrieval-cost numbers (token counts, byte sizes, line counts) are
deliberately excluded: they describe a live retrieval API, not hand-maintained
markdown, and a number nobody regenerates is wrong within a week. The depth
label is the cost signal instead. This contract exists so a future
doc-maintainer run doesn't flatten the docs back to prose — issue #2710.

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

Three categories feed both windows: closed issues, merged PRs, and PRs closed
**without** merging. The third is the rejection record — a PR the owner closed
with "no, I don't want this" is some of the highest-signal intent there is, and
`gh pr list --state closed` returns merged PRs too, so
`listRecentlyClosedUnmergedPRs` filters on a non-null `mergedAt` rather than
trusting gh to exclude them.

- **Forward window** (every run): 100 fetched per category with no `since`
  cutoff, filtered in-process, 40 written after newest-first sorting — the same
  incremental cadence as `.plans/`. An item qualifies when its `closedAt`/
  `mergedAt` **or** its `updatedAt` is at or after the last `[doc-maintainer]`
  commit, so a comment added to an item that already passed through the window
  is still picked up. Known limit: `gh list` returns the top-N by *creation*, so
  an item older than that window that gains a new comment is still missed; this
  catches the common case at no extra API cost.
- **Backward backfill chunk** (until the walk finishes): the history walk that
  the original implementation never completed. It fetches up to 3,000 items per
  category with no `since` cutoff, filters to items dated
  strictly older than the recorded watermark, and hands the newest 250 to that
  run's agent pass. Progress lives in the `doc_intent_backfill` table
  (`oldest_scanned`, `complete`, `window_exhausted`, `source_version`); an absent row means the
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

### Source version

`INTENT_SOURCE_VERSION` (in `doc-maintainer.ts`) stamps every watermark row via
`source_version`. When a run finds a stored row whose stamp is older than the
current constant, it discards the row entirely and restarts the backward walk.

This exists because the backfill is already `complete` on every repo: without
it, a newly-added source (PR review notes, closed-unmerged PRs, paginated
comments, a larger truncation budget) would only ever reach *new* items, and
history would keep the shape it had under the old rules. Bump the constant in
the same change that adds a source. The cost is one extra ≤250-item chunk per
repo per daily run until each walk finishes again, and the "HEAD unchanged →
skip" fast path stays un-suspended only once it does.

### Mechanics

- Each qualifying item is written to `.intent/<kind>-<number>.md` (e.g.
  `.intent/issue-1650.md`, `.intent/pr-1934.md`) containing the human-authored
  body (if any), a bulleted list of human comments, and — for PRs — a
  `**Human review comments:**` section with review bodies and inline review
  comments (`- @login (path:line): …`). Resolved review threads are deliberately
  **not** filtered out: a resolved thread's owner comment is still a statement
  of intent. All GitHub-supplied text (title, body, comments, review paths) is
  passed through `guardContent()` before being written, since it becomes input
  to the doc-writing Claude call.
- An item headed "closed WITHOUT merging" carries a one-line note telling the
  agent to read the comments below it as a statement of what the owner does
  *not* want, and the prompt directs it to record the rejection as a constraint
  (in the owning feature doc, else under "Explicitly rejected feature ideas" in
  `docs/requirements.md`).
- Bodies and comments over 6,000 chars are elided head+tail (3,500 leading,
  2,300 trailing, with a `[... N chars elided ...]` marker) rather than cut at
  the head. Corrections land at the *end* of a long comment — the old flat
  2,000-char head cut discarded exactly that (on claws #2300 the owner's
  runner-pool correction was lost mid-sentence).
- Per item, the newest 40 human comments are kept and the whole file is bounded
  at 20,000 chars: the body section is charged first and never dropped, then
  comment and review bullets are kept newest-first until the budget runs out.
  Whatever is dropped is recorded as a trailing
  `_[N earlier human comment(s)/review note(s) omitted for length]_` line. This
  bound matters now that `getIssueComments` paginates.
- Comment and review-note fetches run through `mapSettledWithConcurrency` at
  concurrency 6, so one failing item doesn't abort the pass.
- `.intent/` is cleaned up after Claude runs and is never committed — the doc
  edits the agent made from it are what persists.

## Memory folding (#2666, #2757)

Agent memory notes are not read from the local `~/.claude` store. The service's
home directory is ephemeral in the k8s pod (rebuilt from Secrets on every boot,
with no restore-on-boot), so the durable copy lives on the `claude-memories`
branch of this repo — see [claude-memory-backup.md](claude-memory-backup.md) for
how it gets there. `doc-maintainer` reads that branch directly.

Rather than inject memory content into every agent prompt (which would pay the
token cost on every run, for every provider), `doc-maintainer` reads
`collectRepoMemories(repo)` (`src/agent-memory.ts`) once per repo and stages the
result as a third scratch directory alongside `.plans/` and `.intent/`. This is
what makes memories provider-agnostic: every agent on every provider already
reads `docs/`, so once a durable fact is refined out of a memory store and into
the repo's docs, it reaches every future agent regardless of which provider is
working the next task.

- `syncMemoryBranch()` fetches `origin claude-memories` once per doc-maintainer
  run (deduped and cached for 10 minutes across the tick's concurrent repos)
  into its own read-only checkout at `WORK_DIR/claude-memories-fold` — a
  separate tree from `claude-memory-backup`'s `WORK_DIR/claude-memory-backup`,
  since that job's hourly `reset --hard` / commit / push could otherwise race a
  concurrent read or destroy the backup's staged tree mid-run. Because this
  fetch trails the hourly backup, the fold can lag up to an hour behind a live
  host's memory store.
- `collectRepoMemories(repo)` matches every `memories/<slug>/*.md` directory on
  the branch whose slug ends in `-<owner>-<repo>` (`/` and `.` → `-`), so it
  folds notes written by **any** host that has ever worked on this repo — not
  just the one running the current job — under distinct scopes `claude-h1`,
  `claude-h2`, … (one per matched slug, sorted for determinism; this also keeps
  a raw `/home/<user>` path out of the staged filenames). It then applies
  filename (`.md` only), per-file (64 KiB), file-count (80), and total-size
  (512 KiB) caps across the combined set, and returns a SHA-256 digest of the
  included content alongside the files.
- If the branch or its `memories/` directory could not be read this run,
  `collectRepoMemories` returns `available: false` rather than an empty result
  — callers must treat that as "unknown", not "no memories".
- If any files were collected, they are written to `.memories/<scope>-<name>`
  in the worktree (e.g. `.memories/claude-h1-MEMORY.md`) before the
  doc-writing Claude call, and the prompt is extended with a block instructing
  the agent to read every file, verify each fact against the current code, and
  either record it in the doc owning the subsystem or, if no doc owns it, in
  `docs/agent-notes.md` (created if absent and linked from `docs/OVERVIEW.md`)
  — the same catch-all pattern as `docs/requirements.md` for `.intent/`. The
  agent is told not to commit `.memories/`.
- `.memories/` is deleted and `git rm -rf --cached .memories` attempted after the
  agent pass returns, identically to `.plans/` and `.intent/`.
- The digest is stored in `doc_intent_backfill.memory_digest`
  (`db.getDocMemoryDigest` / `db.recordDocMemoryDigest`) so a repo whose memory
  content changed — even with HEAD otherwise unchanged since the last doc
  commit — still triggers a run instead of hitting the "no changes" skip. The
  digest is recorded unconditionally **when the branch was readable this run**,
  including the empty-string digest for "no memory files", so deleting every
  memory file settles the watermark rather than forcing a run on every future
  tick. A failed branch fetch records nothing, so a transient network error
  can't wipe the stored digest and force every future run.
- `claude-memory-backup` is this fold's upstream feed, not a redundant
  parallel path — it must keep running for the fold to see anything.

## Agent-guidance maintenance

`doc-maintainer` owns four layers of markdown, refined from the same
`.intent/` and `.memories/` capture described above: `docs/` (subsystem
docs and requirements), root `AGENTS.md` + `CLAUDE.md` (cross-cutting repo
facts, build/test commands, invariants), per-role `.agents/*.md` files
(`.agents/issue-refiner.md`, `.agents/issue-implementer.md`,
`.agents/pr-reviewer.md` — injected as system prompts into Claws' headless
planning, implementation, and review runs for the repo), and repo-local
`.skills/<slug>/SKILL.md` (long, situational procedures referenced by name
from a role file rather than inlined).

Placement rules keep a given piece of feedback in exactly one place:

- Cross-cutting repo facts, build/test commands, invariants → `AGENTS.md`.
- Planning/scoping heuristics → `.agents/issue-refiner.md`.
- Implementation scope and verification rules → `.agents/issue-implementer.md`.
- Review focus and style → `.agents/pr-reviewer.md`.
- Long, situational procedures → `.skills/<kebab-slug>/SKILL.md`.

Role files are appended on top of `AGENTS.md` on **every** planning,
implementation, and review run, so the prompt keeps each under ~80 lines and
forbids repeating what `AGENTS.md` already says or duplicating a rule across
files. The agent is told to be conservative: only a repeated failure or
explicit human feedback with a stated rationale becomes a standing rule — a
one-off task instruction, a transient incident detail, or a single reviewer
nit must not be promoted into permanent guidance.

If a role document is missing entirely — from both `.agents/<role>.md` and
the legacy `.claude/agents/<role>.md` fallback — the run is required to
create it, and the skip gate exempts this repo from the "HEAD unchanged"
fast path so the gap doesn't persist forever on a dormant repo. The legacy
path counts as present for this check: a repo still on the old layout must
not re-trigger the gate every day, and `claude-config-scanner` already files
the migration issue for it. If a role document still exists only at the
legacy path, the prompt instructs the agent to `git mv` it to the canonical
`.agents/` path instead of maintaining two copies.

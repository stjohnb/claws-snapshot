# friction-retrospective

**Deep dive.** Read this when you're changing agent friction notes, the
retrospective issue they roll up into, or the `/retro` page. For what happens to
the issue once it is filed, read issue-dispatcher.md instead.

**Source**: `src/jobs/friction-retrospective.ts`, `src/claws-state-tools.ts`
(`claws_note_friction`), `src/server.ts` (`POST /api/friction-notes`, `GET /retro`),
`src/pages/retro.ts`
**Trigger**: Every hour (`intervalMs` 60 minutes); no `weekendPause` or `skipWeekends`
**Targets**: All repos (opt-out per repo via the `/jobs` matrix)

Agents hit small out-of-scope friction while working — a slow or flaky command, a
confusing doc, a tool returning the wrong shape, a convention that fights the task.
Filing an issue for each is the wrong cost (it is planned within minutes and lands on
the board), so they record a note instead, and this job rolls every repo's notes up into
one fleet-wide retrospective issue — a list of proposed follow-ups — the operator triages with a fortnight's perspective
(#clw_01M5SKZK2FXT9BFKZBPZ4QBDE4). It follows the memory-folding pattern: capture at
the edge, review centrally on a schedule. No transcript is kept.

## Capture

`claws_note_friction` is registered unconditionally in `registerClawsStateTools`, so
every headless run (whose `writeAgentMcpConfig` config carries the claws-state server)
and every interactive session has it. It takes `repo`, a `category` from the fixed
list `tooling`, `docs`, `tests`, `ci`, `conventions`, `prompt`, `infra`, `other`
(`FRICTION_CATEGORIES`), one line of `text` (1–300 characters) and an optional
`reference` (a file or command, up to 200). The tool adds the run's identity and posts
to `POST /api/friction-notes`:

- a headless run's `tasks` id, passed by each agent's `writeAgentMcpConfig({ taskId })`
  call as `CLAWS_MCP_TASK_ID`, and its working issue as `origin`;
- an interactive session's id.

A note with neither is stored with nulls. The route checks the repo is managed (case
insensitively), the category and the lengths, returns 400 on a failure, and otherwise
inserts one `friction_notes` row and returns `{ ok: true, id }`. It files no issue,
posts no comment, records no gate event and changes no board state.

Agents are told to use it in three places. `runClaude` appends `FRICTION_NOTE_GUIDANCE`
to every non-isolated run that has an `mcpConfig`, whatever its capabilities. The
interactive session prompt (`sessionWorkflowPrompt`) carries the same instruction
beside its `claws_create_issue` paragraph. And `.agents/issue-implementer.md`,
`pr-reviewer.md` and `issue-refiner.md` each have a "Friction notes" section.

## When a retrospective is due

`retrospectiveDue({ now, lastRetroAt, untriagedCount })` decides once for the whole fleet:

| Condition | Result |
|---|---|
| no untriaged notes | none, on any day |
| 50 or more untriaged notes | `count`, on any day |
| Friday, and 14 or more calendar days since the last retrospective | `time` |
| Friday, and the fleet has never had a retrospective | `time` |
| anything else | none |

"Friday" and the day count use the Claws process's local clock, as `weekendPause` in
`src/scheduler.ts` does. The last retrospective is the latest `triaged_at` of any
note, so either trigger resets the one fleet-wide fortnight clock, and the count is
over every repo combined. `run()` considers only notes whose repo is enabled for the
job in `/jobs`; a disabled repo contributes no notes and is never rolled up or marked
triaged. If Claws is down all Friday the
time trigger slips a week; the count trigger still covers a busy fortnight.
`nextTimeBasedDue()` gives the Friday `/retro` shows: the first Friday on or after
both today and 14 days after the last retrospective.

## The retrospective issue

The issue is a triage list, never one unit of work (#clw_01M640XY068DPVY2HQB64J33PE).
Before filing, `draftFollowUps()` makes one model call that drafts the proposed
follow-ups; the rest of the body is built deterministically by
`buildRetrospectiveBody()`.

### Proposed follow-ups

`draftFollowUps(notes)` runs one tool-free `runClaude` call with `isolatedCompletion`
in a fresh empty `fs.mkdtemp` directory, on the `sonnet` tier, with
`AUXILIARY_AGENT_ADMISSION_BYTES` and a 180 s timeout, recorded as a
`friction-retrospective` task (`db.withTaskRecording`, `trackTaskTokens`) as
`completion-api.ts` does. The prompt passes the notes as data and asks for JSON
`{proposals:[{theme,title,outcome,noteIds,repos}]}`: at most 8 proposals, one-off notes
left out. `validateProposals()` keeps only note ids in the batch and repos in
`retrospectiveRepos(notes)`, falls back to the proposal's notes' repos when none of its
repos survive, drops a proposal left with no notes, and cuts the theme to 80 characters
and the outcome to 200. Note text is agent-written; it reaches only this tool-free run,
whose output is validated against the batch, so nothing in a note can call a tool, file
an issue or name a repo outside the batch.

A model or parse failure never stops the filing: the section reads "Proposed follow-ups
could not be drafted (<reason>); triage from the notes below", and the job logs a
`warn`. The draft runs outside `serialiseIssueCreate`, after the dedupe lookup, so a
retry of an already-filed batch drafts nothing.

### The body

- **Title:** `Fortnightly retrospective: <N> friction notes across <R> repos (<first date> to <last date>)`.
- **Proposed follow-ups,** first: a numbered list, each item naming its theme and
  title, its one-line outcome, its supporting note ids and its repos.
- **Summary:** a table with one row per repo (total plus a column per category) and an
  all-repos row.
- **One section per category,** largest first. Notes are grouped by identical
  reference, repeated references first. Each note cites its date, repo, note id, text and
  source (`task 123 (issue-worker)` or `session <id>`). For a task that still exists it
  adds the task's status and `taskFailureReason` category, and it names the working
  issue.
- **Task outcomes:** a roll-up of the cited tasks by job, with their statuses and failure
  categories.
- **How to triage:** file the follow-ups you choose (from a session or the New issue
  form), then close this issue.

### Filing

The issue is filed with `clawsIssues.createIssue({ source: "automation", labels:
[Blocked], blockedReason, requirementsStage: false, autoPromote: false, dedupeKey,
repos, primaryRepo: RETRO_PRIMARY_REPO })`.

- **Named repos** (`retrospectiveRepos()`): `St-John-Software/claws` plus every repo
  that contributed at least one note in the batch, deduplicated and sorted. A repo
  disabled for the job in `/jobs` contributes no notes, and one that recorded none in
  the batch is not named, so neither appears. The issue is listed under each named
  repo on the dashboard, and its plan may open PRs in any of them. A repo the fix needs
  that recorded no notes is named on the follow-up the operator files for it.
- **Owner:** claws, always. An issue's primary repo is normally the alphabetically
  first of its repos, which would hand a retrospective naming `bstjohn-blog` to that
  repo. The job instead pins claws with `primaryRepo` (`claws_issues.primary_repo`),
  so claws' dispatchers own its planning, labels and phase sequencing however the
  named repos sort. The pin counts only while claws is one of the issue's repos: if the
  operator removes claws, ownership falls back to the alphabetical rule until claws is
  re-added ([issue-tracker.md](../issue-tracker.md#repositories-and-the-primary-repository)).

It starts Blocked, with the reason "Triage list: file the follow-ups you choose, then
close this issue", so no dispatcher plans or implements it. It has no requirements
stage and `auto_promote = 0`, so clearing Blocked leaves it in Drafting with no
automation either: the requirements writer and the planner never touch it. The
operator files the follow-ups they choose — Claws never files them itself — and closes
the retrospective by hand.

The job's `filed` log line carries the proposal count and the draft's duration (or
"already filed, no draft" on a retry).

The dedupe key is `friction-retro-n<first note id>-<last note id>`, so it names the
notes covered rather than a day. Before drafting, and again inside
`serialiseIssueCreate`, the job looks for an open issue with that key whose primary
repo is claws — the pin keeps it there
whatever else it names — so a run that crashed after filing but before
marking its notes gets the same issue back, while a later batch never matches an
earlier issue. The covered notes are then marked triaged
(`markFrictionNotesTriaged`, which only touches still-untriaged rows). A note
therefore appears in one retrospective only and drops out of the untriaged counts.
A failure is reported once with `reportError`.

## The `/retro` page

`GET /retro` (More → Retro in the nav) opens with one fleet-wide block:

- `N/50` untriaged notes (enabled repos only);
- the date of the next time-based retrospective;
- links to past retrospective issues (`/issues/<id>`, the distinct
  `retrospective_issue_id` values, one list for all repos).

Below it every managed repo is listed, the ones with the most untriaged notes first. Each
shows a chip row of counts by category and its untriaged notes as a Date / Category /
Note / Reference / Source table. A repo with no notes shows "No notes"; one switched off
in `/jobs` is marked "Disabled in /jobs".

## Owned state

The `friction_notes` table ([database-schema.md](../database-schema.md#friction_notes-table)).
Triaged notes are not pruned; rows are small and the retrospective cadence bounds the
untriaged pile. Notes for a repo removed from the configuration are neither shown nor
rolled up.

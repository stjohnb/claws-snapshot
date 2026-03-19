# Jobs

Most jobs follow the same lifecycle:

1. List target issues/PRs via `gh` CLI
2. For each item: record task in DB, create a git worktree, run Claude via the
   serial queue, push results, clean up worktree, update DB
3. Errors are caught per-item (one failure doesn't block processing of other
   items) and reported via `error-reporter.ts`

Exceptions: `auto-merger`, `repo-standards`, `runner-monitor`, and
`ubuntu-latest-scanner` do not invoke Claude or create worktrees.
`whatsapp-handler` is event-driven (not scheduled).

## issue-refiner

**Source**: `src/jobs/issue-refiner.ts`
**Trigger**: Open issues discovered via comment analysis
**Interval**: 5 minutes

Scans all open issues per repo. For each issue, determines state by analysing
comments and reactions — no trigger labels required.

**Skip conditions:**
- Issue has the `Refined` label (being implemented)
- `[claws-error]` issues without a triage report comment
- Game-ID issues without a triage report comment

Issues without a body are still processed — the prompt uses "(No description
provided)" as a fallback, allowing Claude to plan from the title alone.

Three modes:

### Fresh planning (no plan comment exists)

- Creates a worktree on branch `claws/plan-<N>-<hex4>`
- Asks Claude for a fresh implementation plan
- Posts the plan as a comment prefixed with `## Implementation Plan`
- Adds the `Ready` label (signals "Claws is done, your turn")

### Refinement (unreacted human comments after plan)

- Finds human comments posted after the latest plan comment
- Checks each comment for a 👍 reaction from Claws (tracked items)
- If unreacted comments exist, creates a worktree on branch `claws/plan-<N>-<hex4>`
- Asks Claude to produce an updated plan addressing the feedback
- **Edits the original plan comment in-place** (rather than posting a new one),
  keeping context concise as plans are refined iteratively
- Reacts 👍 to each addressed comment
- Re-adds the `Ready` label
- If no plan comment is found (e.g. it was deleted), falls back to posting a
  fresh plan comment

### Follow-up response (issue has an open PR)

When an issue has an open PR (implementation in progress), the refiner checks
for unreacted human comments posted after the plan. If found:

- Creates a worktree so Claude can read the repo for context
- Asks Claude to respond to the follow-up questions (not produce a new plan)
- Posts Claude's response as a **new comment** (does not edit the plan)
- Reacts 👍 to each addressed comment
- Does **not** change labels (the issue is already in implementation)

The `findUnreactedHumanComments()` helper (shared with the refinement flow)
filters out Claws-authored comments (via marker) and bot comments, then checks
each for a 👍 reaction from Claws. This prevents infinite response loops since
Claws's own responses are filtered out on the next pass.

To iterate on a plan: post feedback comments on the issue. The refiner will
detect unreacted comments and update its plan. Repeat until satisfied, then add
`Refined` to trigger implementation.

All prompts instruct Claude to read `docs/OVERVIEW.md` first if it exists.
Images embedded in issue bodies are downloaded and provided to Claude for
visual context.

## issue-worker

**Source**: `src/jobs/issue-worker.ts`
**Trigger**: Issues labelled `Refined`
**Interval**: 5 minutes

- Removes the `Ready` label (work starting)
- Creates a worktree on branch `claws/issue-<N>-<hex4>`
- Provides the issue title, body, and all comments as context
- Instructs Claude to read `docs/OVERVIEW.md` for codebase context
- Claude implements the changes and makes commits
- If commits were produced: pushes the branch, generates a PR description
  (via a second Claude call with the diff, falling back to a diffstat if that
  fails), creates a PR titled `fix: resolve #N — <title>` that closes
  the issue
- Adds the `In Review` label to the issue (signals a PR is open for review)
- Removes the `Refined` label

### Multi-PR issues

If the implementation plan contains multiple `### PR N:` phases, the worker
creates one PR per phase:

- Each intermediate PR references `Part of #N` (not `Closes`), keeping the
  issue open
- The final PR uses `Closes #N` to auto-close the issue on merge
- PR titles include `(N/total)` suffixes

Before implementing each subsequent phase, the worker updates the plan comment
to reflect completed work: completed phases get `[COMPLETED]` prepended to
their titles, and remaining phases are revised to account for what has already
been merged. A `<!-- plan-updated-after-phase:N -->` marker prevents redundant
updates.

Between phases, the worker scans open issues for ones with merged `claws/`
PRs but more phases remaining. When a PR has been merged and more phases
remain, it re-adds the `Refined` label, which triggers the next phase on the
next run. The current phase is determined by counting merged PRs with branch
prefixes matching the issue.

## ci-fixer

**Source**: `src/jobs/ci-fixer.ts`
**Trigger**: Any open PR (scans all open PRs per repo)
**Interval**: 10 minutes

Uses a two-phase identify/process pattern:

1. **Identify**: For each open PR, calls `identifyPRWork()` which checks merge
   state, CI status, and classifies failures. Returns typed `WorkItem` entries
   (discriminated union: `conflict`, `rerun`, `unrelated`, `fix`).
2. **Process**: Groups unrelated failures by repo (structural dedup), then
   processes remaining items concurrently.

Two responsibilities, checked in order for each PR:

### 1. Resolve merge conflicts

Checks `getPRMergeableState()`. If `CONFLICTING`:

- Creates a worktree from the PR branch
- Attempts `git merge origin/<base>` — if clean, pushes directly
- If conflicts exist, passes the conflict file list to Claude with
  instructions to resolve markers and complete the merge
- On failure, aborts the merge

If conflicts were resolved, the CI fix step is skipped (the fresh merge
commit will trigger a new CI run).

### 2. Fix CI failures

If checks are in a cancelled/startup-failure state, re-runs the workflow
instead of trying to fix code. Benign "already running" errors (where the
workflow restarted between detection and rerun) are caught and logged at info
level rather than reported as errors.

If Claude classifies the failure as unrelated to the PR (flakey tests, runner
issues, pre-existing failures), the failure is filed on a consolidated
per-repo `[ci-unrelated]` issue rather than attempting a code fix. Unrelated
failures are grouped by repo during the identify phase (structural dedup),
so concurrent PRs with unrelated failures in the same repo produce a single
issue rather than duplicates. All unrelated failures for a repo are tracked
in a single issue (titled `[ci-unrelated] CI failures unrelated to PR
changes`), with each occurrence logged as a comment containing the
fingerprint, PR reference, reason, a link to the failing GitHub Actions run,
and abbreviated log.

**Exception — `[ci-unrelated]` fix PRs**: When the PR being processed is
itself a fix for a `[ci-unrelated]` issue (detected by `[ci-unrelated]` in
the PR title), classification is skipped entirely and failures are always
treated as related. Without this guard, the classifier would see pre-existing
failures, classify them as "unrelated", and the PR would stall indefinitely
in a loop of filing redundant issues and reverting fix attempts. Errors on
these PRs are posted as comments directly on the PR (using an in-place
edit pattern to avoid spam) rather than creating `[claws-error]` issues.

Otherwise:
- Fetches the failed run log via `getFailedRunLog()` (truncated to 20KB).
  The log fetch has a two-tier fallback: the primary `gh run view --log-failed`
  CLI command is tried first; if it returns empty (e.g. runner cancellations
  produce no structured failure output) or throws, the REST API endpoint
  (`/actions/jobs/{jobId}/logs`) is tried as a fallback. If both return empty,
  the workflow is re-run instead of being silently skipped.
- Creates a worktree from the PR branch
- Passes the failure log to Claude to analyze and fix
- Pushes fix commits

## review-addresser

**Source**: `src/jobs/review-addresser.ts`
**Trigger**: Claws PRs (`claws/` branch prefix) with unreacted review comments
**Interval**: 5 minutes

Scans all open PRs. For each PR with a `claws/` branch prefix:

- Fetches all review feedback: review bodies (with state), inline code
  comments (with diff hunks), and general PR comments
- Returns `PRReviewData` with formatted text plus separate `commentIds` and
  `reviewCommentIds` arrays for reaction tracking
- Filters out comments belonging to **resolved** review threads (uses GraphQL
  API to check thread resolution status, since REST doesn't expose this)
- Filters out bare "LGTM" issue-tab comments (approval signals for
  auto-merger, not review feedback)
- Filters out comments that already have a 👍 reaction from Claws
- Skips PRs where all comments have been addressed (no unreacted comments)
- Downloads images embedded in review comments for visual context
- Removes the `Ready` label (work starting)
- Creates a worktree from the PR branch
- Passes all unresolved feedback to Claude
- Pushes fix commits
- Posts Claude's response as a PR comment (summary of actions taken)
- Reacts 👍 to each addressed comment (both issue comments and review comments)
- Adds the `Ready` label (signals "Claws is done, your turn")

## triage-kwyjibo-errors

**Source**: `src/jobs/triage-kwyjibo-errors.ts`
**Trigger**: Open issues with a game UUID in the body (content-based discovery)
**Interval**: 10 minutes

Specialized for the Kwyjibo game application. Discovers issues by scanning
open issues for game UUIDs — no trigger label required. Skips issues that
already have a `## Bug Investigation Report` comment.

- Extracts a game UUID from the issue body (tries URL pattern, labelled
  pattern, then bare UUID)
- Fetches debug data from the Kwyjibo API:
  - `GET /api/games/<id>/debug-logs` — public endpoint
  - `GET /api/games/<id>/turns` — public endpoint
  - `GET /api/games/<id>/pg-net-errors` — requires `KWYJIBO_AUTOMATION_API_KEY`
- Debug logs are truncated if they exceed 50KB (keeps first and last 25KB)
- Reads `docs/debugging-games.md` from the repo if it exists
- Creates a worktree on branch `claws/investigate-<N>-<hex4>`
- Passes all data to Claude for analysis (no code changes, report only)
- Posts the report as a comment prefixed with `## Bug Investigation Report`
- Populates queue cache: `needs-triage` for uninvestigated issues,
  `needs-refinement` for already-investigated issues

## triage-claws-errors

**Source**: `src/jobs/triage-claws-errors.ts`
**Trigger**: `[claws-error]` issues in `SELF_REPO` (title-based discovery)
**Interval**: 10 minutes

Investigates internal Claws errors that were auto-reported by
`error-reporter.ts`. Only operates on the Claws repository itself
(`SELF_REPO`). Discovers issues by title pattern (`[claws-error] ...`) —
no trigger label required. Skips issues that already have a
`## Claws Error Investigation Report` comment.

### Phase 1: Fingerprint deduplication (pre-investigation)

Before investigating, deduplicates incoming issues by fingerprint:

- Groups issues by fingerprint (extracted from `[claws-error] <fingerprint>`
  title pattern)
- Checks existing open `[claws-error]` issues for matching fingerprints
  (including "Known Fingerprints" tracking comments)
- Closes duplicates with a comment linking to the canonical issue
- When multiple new issues share a fingerprint, keeps the lowest-numbered one

### Phase 2: Investigation

For each canonical (non-duplicate) issue:

- Parses error details from the issue body: fingerprint, context, timestamp,
  and stack trace
- Creates a worktree on branch `claws/investigate-error-<N>-<hex4>`
- Passes error details and other open error issues to Claude with instructions
  to read `docs/OVERVIEW.md`, find the relevant source code, run diagnostic
  commands, and produce a root cause analysis
- Claude's output includes a `RELATED_ISSUES:` line identifying issues that
  share the same root cause

### Phase 3: Post-investigation deduplication

- Posts the investigation report as a comment prefixed with
  `## Claws Error Investigation Report`
- If Claude identified related issues, closes them as duplicates of the
  canonical issue and updates a "Known Fingerprints" tracking comment
- Populates queue cache: `needs-triage` for uninvestigated issues

## doc-maintainer

**Source**: `src/jobs/doc-maintainer.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.docMaintainerHour`
(default: 1 AM local time)

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
  `docs: update documentation for <repo>` (auto-merged by the auto-merger
  job once checks pass, with a safety guard ensuring only doc files are
  changed)

## auto-merger

**Source**: `src/jobs/auto-merger.ts`
**Trigger**: Dependabot PRs + LGTM'd Claws PRs + doc PRs
**Interval**: 10 minutes

Scans all open PRs per repo. For each PR:

- **Dependabot PRs** (`dependabot[bot]` author): merges if all CI checks pass
- **Claws PRs** (`claws/issue-` branch prefix): merges if the PR has a valid
  LGTM comment AND all CI checks pass. LGTM validation uses
  `isClawsComment()` (marker-based) rather than self-login to identify
  Claws-authored comments, so LGTM from a shared GitHub account is accepted.
  Merge-from-base commits (e.g. from ci-fixer resolving conflicts) do not
  invalidate an existing LGTM. Other substantive commits pushed after the
  LGTM invalidate it and another LGTM is required.
- **Doc PRs** (`claws/docs-` branch prefix): merges without requiring LGTM.
  Safety guards: verifies all changed files are doc-only (`docs/**` or
  `*.md`) — if any non-doc files are present, the PR is skipped with a
  warning. Since doc-only PRs skip CI (via `paths-ignore` in workflows),
  accepts both "passing" checks and "no checks" (CI never ran). Rejects
  failing or in-progress checks.
- On merge of a Claws PR, removes the `In Review` label from the linked issue
- Other PRs are ignored
- If checks are failing: logs a warning and skips
- If checks are pending: skips silently
- Does not create worktrees or invoke Claude — purely a merge gate

## repo-standards

**Source**: `src/jobs/repo-standards.ts`
**Trigger**: Daily schedule (also runs once on startup)
**Schedule**: Runs at hour configured by `schedules.repoStandardsHour`
(default: 2 AM local time)

Only processes repos that Claws has previously cloned. For each repo:

- **Syncs label definitions** — calls `ensureAllLabels()` to create/update
  all labels defined in `LABEL_SPECS` (from `config.ts`) with correct colors
  and descriptions (`Refined`, `Ready`, `Priority`, `In Review`)
- **Cleans up legacy labels** — removes labels in the `LEGACY_LABELS` set
  (old labels from the previous label-driven system: `Needs Refinement`,
  `Plan Produced`, `Reviewed`, `prod-report`, `investigated`,
  `claws-mergeable`, `claws-error`)

Does not create worktrees, PRs, or invoke Claude — purely label management
via the `gh` CLI.

## improvement-identifier

**Source**: `src/jobs/improvement-identifier.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.improvementIdentifierHour`
(default: 3 AM local time)

Only processes repos that Claws has previously cloned. Skips repos that
already have open `claws/improve-*` PRs (prevents pile-up when previous
improvements haven't been merged). Repos are processed concurrently.
Two-phase approach per repo:

### Phase 1: Analysis

- Fetches all open issue and PR titles for deduplication context
- Creates a worktree on branch `claws/improve-<hex4>`
- Instructs Claude to read `docs/OVERVIEW.md` (if it exists) and analyze
  the codebase for actionable improvements (duplicate logic, dead code,
  performance issues, security concerns, missing error handling, stale TODOs)
- Claude responds with structured JSON listing improvements
- Analysis worktree is cleaned up before implementation begins

### Phase 2: Implementation

Suggested improvements (up to 10 per run) are implemented **concurrently**
via `Promise.allSettled`. Each improvement:

- Searches existing issues **and PRs** for duplicates (skips if found)
- Creates a fresh worktree on branch `claws/improve-<hex4>`
- Instructs Claude to implement the specific improvement
- If commits were produced: pushes the branch, creates a PR titled
  `refactor: <improvement title>` (no labels applied)
- Errors in one improvement do not block processing of others

Conservative by design: only tangible improvements, no stylistic or
documentation suggestions. "No improvements found" is acceptable.

PRs created include a footer: *"Automated improvement by claws improvement-identifier"*

## idea-suggester

**Source**: `src/jobs/idea-suggester.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.ideaSuggesterHour`
(default: 4 AM local time)
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

### History tracking

All files in the `ideas/` directory (including `rejected.md`) are read
and passed to Claude as context, so it avoids re-suggesting previously
triaged ideas. No database schema changes needed.

### Reaction workflow

Ideas are reviewed via Slack emoji reactions on each thread reply:
- ✅ (`white_check_mark`) — Accept: create a GitHub issue, record in ideas directory
- 🤔 (`thinking_face`) — Potential: record in `ideas/potential.md`
- ❌ (`x`) — Reject: record in `ideas/rejected.md`

The `idea-collector` job polls for these reactions and processes the results.

## idea-collector

**Source**: `src/jobs/idea-collector.ts`
**Trigger**: Pending ideas files in `~/.claws/pending-ideas/`
**Interval**: 30 minutes (configurable via `intervals.ideaCollectorMs`)

Scans `~/.claws/pending-ideas/` for JSON files written by idea-suggester.
For each pending file:

1. **Polls reactions** on each idea message via the Slack API
2. **Checks completeness** — if all ideas have a disposition reaction, or
   if 24 hours have elapsed since posting (timeout)
3. If not ready, skips to next run
4. If ready, processes the batch:

### Processing

- **Accepted ideas** (✅): Creates a GitHub issue for each, records in
  the focus-area file (e.g. `ideas/ux.md`) with the issue number
- **Potential ideas** (🤔, or unreacted after timeout): Records in
  `ideas/potential.md`
- **Rejected ideas** (❌): Records title in `ideas/rejected.md`

When multiple reaction types are present on a message, priority applies:
✅ > ❌ > 🤔

### Output

- Creates a single PR per repo titled
  `[claws-ideas] Collected idea responses for <repo>` with a disposition
  table in the body
- Posts a summary reply to the original Slack thread
- Deletes the pending ideas file after successful processing

### Edge cases

- If `getReactions` fails (Slack API error), logs warning and retries next run
- If `createIssue` fails for one idea, logs error but continues with others
- If the pending file references a repo not in the current repos list, skips
- Unreacted ideas after 24h timeout become "potential"

## issue-auditor

**Source**: `src/jobs/issue-auditor.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.issueAuditorHour`
(default: 5 AM local time)

Reconciles every open issue across all repos, ensuring each is either labeled
"Ready" (waiting on a human) or in a state where Claws will process it on the
next pass. No issues should fall between the cracks.

Does not invoke Claude or create worktrees — it's a lightweight, read-only
audit with targeted label fixes.

**Classification states:**

| State | Condition | Action |
|-------|-----------|--------|
| `refined` | Has "Refined" label | None — issue-worker handles |
| `in-progress` | Has open Claws PR | Verify "In Review" label; add if missing |
| `needs-triage` | Is `[claws-error]` or has game-ID, without investigation report | None — triage jobs handle |
| `needs-refinement` | No plan comment exists | None — issue-refiner handles |
| `needs-refinement` | Has plan but unreacted human feedback exists | None — issue-refiner handles |
| `ready` | Has plan, all feedback addressed | Verify "Ready" label; add if missing |
| `stuck-multi-phase` | Has merged Claws PRs, multi-phase plan, more phases remaining, no "Refined" label, no open PR | Add "Ready" label (human decides when to resume) |

**Fixes applied**: Missing "Ready" labels (including for stuck multi-phase
issues that need human attention) and missing/stale "In Review" labels
(added when an issue has an open PR, removed when it doesn't).

**Slack notification**: Sent only when fixes are applied, with a summary of
which issues were fixed.

Per-repo errors are caught and reported without blocking other repos.

## whatsapp-handler

**Source**: `src/jobs/whatsapp-handler.ts`
**Trigger**: Incoming WhatsApp message (event-driven, not scheduled)
**Requires**: `whatsappEnabled: true` in config

Not a scheduled job — registered as a callback on the WhatsApp client via
`createHandler()`. Processes each incoming message:

- If the message contains a voice note and `OPENAI_API_KEY` is configured,
  transcribes it via the Whisper API. If no API key, replies asking for text.
- Truncates message text to 10,000 characters
- Asks Claude to interpret the message and produce a JSON response with
  `repo`, `title`, and `body` fields, choosing the most likely target
  repository from the available list
- Creates a GitHub issue (no labels) in the chosen repository
- Replies to the WhatsApp sender with the issue link
- Does not create worktrees or record tasks in the database

See [WhatsApp Setup](whatsapp-setup.md) for configuration and pairing.

## runner-monitor

**Source**: `src/jobs/runner-monitor.ts`
**Trigger**: Interval-based
**Interval**: 10 minutes (configurable via `intervals.runnerMonitorMs`)

Monitors self-hosted GitHub Actions runner hosts via SSH. Unlike most jobs,
this does not operate on GitHub repos — it directly manages infrastructure.
Runner hosts are configured with baked-in defaults (two Hetzner servers),
overridable via the `runners` array in `config.json`.

For each configured runner (sequential, with per-host error reporting):

### 1. Service health check

- Runs `sudo ./svc.sh status` in the runner's `actionsDir`
- If the service is not active: stops it, starts it, and verifies recovery
- Records action for Slack notification

### 2. Zombie/stale process detection

- Scans for `Runner.Worker` and `Runner.Listener` processes older than 6 hours
- Only auto-kills if the runner service itself is dead (orphaned workers)
- Logs a warning for long-running processes when the service is healthy
  (avoids killing legitimate long CI runs)

### 3. Disk space check

- Reads disk usage via `df`
- If above 90%: cleans up `/tmp/_github_*` and `_work/_temp/*`
- Records action for Slack notification

**SSH configuration**: Uses `BatchMode=yes` (fails rather than prompting),
`ConnectTimeout=10`, `StrictHostKeyChecking=accept-new`, and a 30-second
command timeout. Supports custom ports and identity files per host.

**Notifications**: A single Slack notification is sent at the end of each run
if any actions were taken. Healthy hosts are logged at info level only.

Does not create worktrees, PRs, or invoke Claude — purely infrastructure
monitoring via SSH.

## ubuntu-latest-scanner

**Source**: `src/jobs/ubuntu-latest-scanner.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.ubuntuLatestScannerHour`
(default: 6 AM local time)

Scans GitHub Actions workflow files in all cloned repos for `runs-on:` values
that are not `self-hosted`. Creates a deduped alert issue in the offending
repo.

- Only processes repos that Claws has previously cloned
- Reads `.github/workflows/*.yml` and `*.yaml` from the local clone
- Scans each file line-by-line for `runs-on:` directives
- Skips commented-out lines (leading `#`)
- Detects both direct string form (`runs-on: ubuntu-latest`) and array form
  (`runs-on: [ubuntu-latest]`), matching any non-self-hosted runner
- Deduplicates by searching for an existing open issue before creating a new one
- Issue title: `Alert: workflows using non-self-hosted runners`
- Issue body includes a table of offending workflow files with line numbers
  and specific `runs-on` values

Does not create worktrees, PRs, or invoke Claude — purely a filesystem scan
with issue creation via the `gh` CLI.

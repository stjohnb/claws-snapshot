# Claws — Overview

Claws is a self-hosted
GitHub automation service. It polls GitHub repositories on configurable timers,
identifies work items via comment analysis, reactions, and PR state, and
delegates tasks to the Claude CLI in isolated git worktrees. It runs as a
Linux systemd service.

## Architecture

```
src/
├── main.ts              Entry point — DB init, crash recovery, job registration, shutdown
├── config.ts            Configuration loading (env > config file > defaults)
├── scheduler.ts         Interval/schedule-based job runner with skip-if-busy
├── github.ts            gh CLI wrapper with transient-error retry
├── claude.ts            Claude CLI runner, bounded concurrent queue, git worktree helpers
├── db.ts                SQLite task tracking (better-sqlite3)
├── server.ts            HTTP server — dashboard, health, status, manual triggers
├── log.ts               Timestamped logging + Slack error escalation
├── slack.ts             Slack incoming-webhook notifier
├── error-reporter.ts    Deduplicating GitHub issue-based error reporter (filters ShutdownError, RateLimitError)
├── images.ts            Image/attachment extraction + download for issue/PR context
├── whatsapp.ts          WhatsApp Web client (Baileys) — QR pairing, message routing, transient error filtering
├── transcribe.ts        Voice-note transcription via OpenAI Whisper API
├── version.ts           Build-time injected version string
├── plan-parser.ts       Parses multi-PR implementation plans into phases
├── shutdown.ts          Graceful shutdown flag + ShutdownError class (shared across modules)
├── test-helpers.ts      Test factories (mockRepo, mockIssue, mockPR)
├── resources/
│   └── marketing.ts     Marketing knowledge resource for idea-suggester prompts
├── pages/
│   ├── dashboard.ts     Main status page HTML builder
│   ├── queue.ts         Work queue page HTML builder
│   ├── logs.ts          Log list, detail, and issue logs page HTML builders
│   ├── config.ts        Config editor page HTML builder
│   ├── whatsapp.ts      WhatsApp status/pairing page HTML builder
│   ├── login.ts         Login page HTML builder
│   └── layout.ts        Shared layout (header, theme support, formatters)
└── jobs/
    ├── issue-refiner.ts        Discovers issues needing plans via comment analysis
    ├── issue-worker.ts         Implements issues labelled "Refined" as PRs
    ├── ci-fixer.ts             Fixes failing CI and resolves merge conflicts
    ├── review-addresser.ts     Addresses review comments on Claws PRs
    ├── triage-kwyjibo-errors.ts     Investigates prod bug reports (game-ID issues)
    ├── triage-claws-errors.ts       Investigates internal Claws errors ([claws-error] issues)
    ├── doc-maintainer.ts       Nightly documentation generation/update
    ├── auto-merger.ts          Auto-merges Dependabot and approved Claws PRs
    ├── repo-standards.ts       Syncs labels and cleans legacy labels
    ├── improvement-identifier.ts  Identifies codebase improvements via Claude, implements as PRs
    ├── idea-suggester.ts       Suggests new ideas per repo, posts to Slack for reaction-based review
    ├── idea-collector.ts       Collects Slack reactions on ideas, creates GH issues and collection PRs
    ├── issue-auditor.ts        Daily audit ensuring no issues fall between the cracks
    ├── whatsapp-handler.ts     Interprets WhatsApp messages via Claude, creates GitHub issues
    ├── runner-monitor.ts       Monitors self-hosted GH Actions runners via SSH
    └── ubuntu-latest-scanner.ts  Scans workflows for non-self-hosted runners, creates alert issues

deploy/
├── claws.service           systemd service unit
├── claws-updater.service   systemd updater service
├── claws-updater.timer     systemd timer (every 60s)
├── install.sh              One-shot bootstrap installer
├── deploy.sh               Auto-update with health check + rollback
└── uninstall.sh            Service removal
```

### Module Responsibilities

**`main.ts`** — Wires everything together. Initializes the SQLite database,
recovers orphaned tasks from a previous crash (cleans up dangling worktrees,
marks tasks failed), prunes old logs, registers all 15 jobs with the scheduler
(interval jobs staggered by 2 seconds to prevent thundering herd), starts the
HTTP server, sets up live config reloading (interval and schedule changes
propagated to the scheduler without restart), initializes the WhatsApp gateway
if enabled, and installs SIGINT/SIGTERM handlers that cancel queued tasks,
drain running jobs (5 min timeout), terminate active Claude processes, and
close the database.

**`config.ts`** — Loads configuration in priority order: environment variables >
`~/.claws/config.json` > hardcoded defaults. Exports `LABELS` (`refined`,
`ready`, `priority`, `inReview`), `LABEL_SPECS` (synced to all repos by
repo-standards — includes colors and descriptions for all four labels),
`LEGACY_LABELS` (set of old labels cleaned up as stale, including
`claws-mergeable` and `claws-error`), `INTERVALS`, `SCHEDULES`, and
connection strings. `WORK_DIR` is always `~/.claws`.

**`scheduler.ts`** — Manages job lifecycle. Each job runs immediately on
startup, then repeats on its interval. If a prior run is still active, the
incoming tick is silently skipped (no queuing). Supports `scheduledHour` mode
(fires once daily at a specific hour) with optional `runOnStart` for jobs
that should also fire immediately at startup (e.g. repo-standards). Exposes
`drain()` for graceful shutdown, `triggerJob(name)` for manual HTTP-triggered
runs, `updateInterval()` / `updateScheduledHour()` for live config
changes without restart, `pauseJob(name)` / `resumeJob(name)` for toggling
job execution via the dashboard, `jobScheduleInfo()` for exposing per-job
schedule metadata (interval or scheduled hour) to the dashboard, and exports
`msUntilHour()` for computing next-run countdowns. Paused jobs are
initialized from the `pausedJobs` config array on startup.

**`github.ts`** — All GitHub interaction via the `gh` CLI (never the HTTP API
directly). Wraps `execFile("gh", ...)` with exponential-backoff retry on
transient errors (400, 500, 502, 503, 504, ETIMEDOUT, ECONNRESET, ECONNREFUSED,
connection reset, "Could not resolve to a", "TLS handshake timeout",
"Something went wrong" — up to 3 attempts with 1s/2s/4s delays). Rate limit
errors are not retried — they trip a **circuit breaker** that blocks all API
calls for 60 seconds (throws `RateLimitError`). Includes GraphQL pagination for
resolved review thread filtering. Uses a generic `TTLCache` for API response
caching and in-flight request deduplication (PR lists, check status, issue
comments). Jobs populate a category-based queue cache via
`populateQueueCache()`, and the dashboard reads it via `getQueueSnapshot()`.
Categories: `ready`, `needs-refinement`, `refined`, `needs-review-addressing`,
`auto-mergeable`, `needs-triage`. The `listRepos()` function falls back to a
stale cache when the fresh fetch returns empty (transient failure protection).
Provides `isItemSkipped()` and `isItemPrioritized()` helpers that check
items against the `skippedItems` and `prioritizedItems` config lists,
used by jobs to exclude or fast-track specific issues/PRs. Provides
reaction helpers (`addReaction`, `addReviewCommentReaction`,
`getCommentReactions`) and `getPRReviewDecision()` for review-based gating.
All comments posted by Claws include a hidden `CLAWS_COMMENT_MARKER` and a
visible `CLAWS_VISIBLE_HEADER`, with helper functions `isClawsComment()` /
`stripClawsMarker()` for attribution when processing feedback. Comment
filtering uses `isClawsComment()` (marker-based) rather than self-login
comparison, ensuring correct behavior when the `gh` auth identity is the
same GitHub account as the human user. `hasValidLGTM()` accepts a
`baseBranch` parameter and filters out merge-from-base commits (e.g. from
ci-fixer resolving conflicts) so they don't invalidate an existing LGTM.
`getPRReviewComments()` skips bare "LGTM" issue-tab comments (approval
signals for auto-merger, not review feedback). `getPRCheckStatus()` returns
four states: `"passing"`, `"failing"`, `"pending"`, or `"none"` (no checks
exist at all — used by auto-merger to distinguish doc-only PRs that skip CI
from PRs with in-progress checks).

**`claude.ts`** — Two concerns: (1) a module-level **bounded concurrent queue**
(`enqueue`) that runs up to `MAX_CLAUDE_WORKERS` (default 2) Claude processes in
parallel; (2) git worktree helpers — `ensureClone`, `createWorktree`,
`createWorktreeFromBranch`, `removeWorktree`, `attemptMerge`, `pushBranch`,
`generatePRDescription`, etc. `ensureClone` (exported) clones a repo on first
use and on subsequent calls runs `git fetch --all --prune` followed by
`git checkout origin/<defaultBranch> --force` to refresh the main clone's
working directory — this ensures any code reading directly from the main clone
(e.g. ubuntu-latest-scanner) sees the latest remote state. The queue rejects
new tasks when the system is shutting down (via `shutdown.ts`, throwing
`ShutdownError`). Active Claude child processes are tracked for signal-based
cancellation (`cancelCurrentTask`). Concurrent clones to the same repo are
deduplicated. Claude is invoked via
`spawn("claude", ["-p", "--dangerously-skip-permissions"])` with the prompt
on stdin. PR description generation uses three-dot diff
(`origin/base...HEAD`) to isolate branch changes from concurrent
main-branch movement. Each Claude process has a configurable **timeout**
(`CLAUDE_TIMEOUT_MS`, default 20 minutes) — on expiry, SIGTERM is sent with a
10-second SIGKILL escalation. A 5-minute **heartbeat** logs PID, elapsed time,
and stdout byte count for observability. Timed-out processes throw
`ClaudeTimeoutError` (carries diagnostic fields: `lastOutput`, `lastStderr`,
`outputBytes`, `cwd`) which the error reporter includes in GitHub issue reports.

**`db.ts`** — SQLite database at `~/.claws/claws.db`. Three tables: `tasks`
(tracks every job invocation, linked to `job_runs` via `run_id`), `job_runs`
(tracks scheduled job executions), and `job_logs` (captures log output per run
via `AsyncLocalStorage` context). See [Database Schema](database-schema.md).

**`server.ts`** — Minimal `http.Server` with an embedded HTML/CSS/JS dashboard.
Routes:

- `GET /` — Dashboard: job status with Last Run/Next Run columns, "Run" buttons, queue overview
- `GET /health` — JSON health check
- `GET /status` — JSON with jobs (including `jobSchedules` with per-job `nextRunIn` countdowns), uptime, queue, integrations
- `GET /login` / `POST /login` — Token-based authentication
- `POST /trigger/:job` — Manual job trigger (returns 200/409/404)
- `POST /pause/:job` — Toggle pause/resume for a job
- `POST /cancel` — Cancel current Claude task
- `GET /queue` — Work queue page (PRs first, CI status, squash & merge)
- `POST /queue/merge` — Squash-merge a PR from the queue page
- `POST /queue/skip` — Skip an issue/PR (excluded from all job processing)
- `POST /queue/unskip` — Remove skip for an issue/PR
- `POST /queue/prioritize` — Prioritize an issue/PR (processed first)
- `POST /queue/deprioritize` — Remove priority for an issue/PR
- `GET /logs` — Log viewer with per-job filtering and item search
- `GET /logs/:runId` — Individual run detail page with task list
- `GET /logs/:runId/tail` — Live log tail (JSON, polls for new entries)
- `GET /logs/issue` — Issue-specific logs page (`?repo=...&number=...`)
- `GET /config` / `POST /config` — Config viewer/editor (HTML form)
- `GET /config/api` — JSON config (sensitive fields masked)
- `GET /whatsapp` — WhatsApp status/pairing page
- `GET /whatsapp/pair` — SSE endpoint streaming QR codes for pairing
- `POST /whatsapp/unpair` — Clear WhatsApp auth state

Supports dark/light/system themes. When `authToken` is configured, mutating
endpoints and config views require authentication via
`Authorization: Bearer <token>` header or `claws_token` cookie.
Token comparison uses `crypto.timingSafeEqual`.

**`plan-parser.ts`** — Parses structured implementation plan comments into
discrete phases for multi-PR workflows. Looks for `### PR N:` or `### Phase N:`
headers to split a plan into phases. Also provides `findPlanComment()` to locate the
most recent plan comment in an issue's comment history, `getPlanUpdatePhase()`
to read the `<!-- plan-updated-after-phase:N -->` marker from plan text,
and `makePlanUpdateFooter()` to generate the visible + machine-readable
footer appended after plan updates. Used by issue-worker to implement
multi-phase plans sequentially and update the plan between phases.

**`log.ts`** — Timestamped console logging with four levels: `debug`, `info`,
`warn`, `error`. Errors also trigger Slack notifications. All log calls capture
output into the `job_logs` table via `AsyncLocalStorage`-based run context, so
logs are associated with the job run that produced them.

**`error-reporter.ts`** — On error: logs to console + Slack, then (with a
30-minute per-fingerprint cooldown) either comments on an existing
`[claws-error]` issue in `SELF_REPO` or creates a new one with the
`claws-error` label. These issues are then picked up by the
triage-claws-errors job for automated investigation. Two error types are
filtered before any reporting: `ShutdownError` (logged at info level —
shutdown cancellations are expected) and `RateLimitError` (logged at warn
level — handled by the circuit breaker, not actionable bugs). When the error
is a `ClaudeTimeoutError`, the report includes a diagnostics section with
working directory, stdout byte count, whether Claude was producing output,
and collapsible last stdout/stderr snippets.

**`images.ts`** — Extracts image references (markdown `![](url)` and HTML
`<img>` tags) from issue/PR text, downloads them (up to 10 images, 10 MB
each, 30s timeout), and writes them into the worktree under `.claws-images/`.
Also extracts GitHub file attachments (`[filename](github-attachment-url)`),
downloads them (up to 5 attachments, 1 MB each), validates UTF-8 encoding,
and truncates large text content (100K char limit, keeps first/last halves).
Auto-detects the GitHub token for private image access. Skips badges, data
URLs, and binary attachment types. The main entry point `processTextForImages()`
runs both pipelines and returns a combined prompt section. Used by
issue-refiner, issue-worker, and review-addresser to give Claude visual and
file context.

## Jobs

Fifteen scheduled jobs run on timers or schedules, plus one event-driven handler.
See [Jobs](jobs.md) for detailed behavior of each.

| Job | Trigger | Interval | Summary |
|-----|---------|----------|---------|
| `issue-refiner` | Open issues without plan comment | 5 min | Discovers issues via comment analysis, posts implementation plans, refines plans based on unreacted human feedback, responds to follow-up questions on issues with open PRs |
| `issue-worker` | Label `Refined` | 5 min | Implements the issue, creates a PR |
| `ci-fixer` | Any open PR with failing checks | 10 min | Resolves merge conflicts, fixes CI failures |
| `review-addresser` | Claws PRs with unreacted review comments | 5 min | Fetches unresolved review comments, pushes fix commits, reacts with thumbsup to track addressed comments |
| `triage-kwyjibo-errors` | Open issues with game-ID in body | 10 min | Fetches debug data from Kwyjibo API, posts investigation report |
| `triage-claws-errors` | `[claws-error]` issues in `SELF_REPO` | 10 min | Investigates internal Claws errors, deduplicates by fingerprint, posts report |
| `doc-maintainer` | Daily at 1 AM | Scheduled | Updates `docs/` to reflect current codebase |
| `auto-merger` | Dependabot PRs + LGTM'd Claws PRs + doc PRs | 10 min | Squash-merges PRs when conditions are met |
| `repo-standards` | Daily at 2 AM (+ on startup) | Scheduled | Syncs labels and cleans legacy labels |
| `improvement-identifier` | Daily at 3 AM | Scheduled | Analyzes codebase via Claude, implements improvements as PRs |
| `idea-suggester` | Daily at 4 AM | Scheduled | Suggests new ideas per repo, posts to Slack thread for reaction-based review |
| `idea-collector` | Pending ideas with reactions | 30 min | Polls Slack reactions, creates GH issues for accepted ideas, batches results into collection PR |
| `issue-auditor` | Daily at 5 AM | Scheduled | Reconciles issue states, manages Ready and In Review labels |
| `whatsapp-handler` | WhatsApp message | Event-driven | Interprets messages via Claude, creates GitHub issues |
| `runner-monitor` | Self-hosted GH Actions runners | 10 min | SSHes to runners, checks service health, restarts dead services, cleans disk |
| `ubuntu-latest-scanner` | Daily at 6 AM | Scheduled | Scans workflow files for non-self-hosted runners, creates alert issues |

## Key Patterns

### Content-Based State Machine

Issues and PRs are discovered by analysing comments, reactions, and PR state —
not labels. Four labels are used:

- `Refined` — trigger for issue-worker (only label that drives a state transition)
- `Ready` — informational, signals "Claws is done, your turn"
- `In Review` — informational, signals an issue has an open PR under review
- `Priority` — high-priority items processed first in all Claws queues

```
Issues:
  No plan comment        →  (refiner posts plan)         →  Ready label added
  Unreacted feedback     →  (refiner refines plan)       →  Ready label re-added
  Open PR + follow-up Q  →  (refiner posts response)     →  👍 reactions added (no label changes)
  Refined label          →  (worker creates PR)          →  Refined removed, Ready removed, In Review added
  Game-ID in body        →  (triage-kwyjibo-errors)      →  investigation report posted
  [claws-error] title    →  (triage-claws-errors)        →  investigation report posted

PRs:
  Unreacted review comments  →  (review-addresser)  →  👍 reactions added, Ready added
  Dependabot or LGTM'd Claws PR + passing CI  →  (auto-merger)  →  merged, In Review removed
  Doc PR (claws/docs-*) + doc-only files + CI passing/skipped  →  (auto-merger)  →  merged (no LGTM required)
```

Jobs track processed items via 👍 reactions on comments (issue-refiner,
review-addresser) and by checking for existing report comments (triage jobs).
The issue-auditor reconciles label state daily, adding missing `In Review`
labels to issues with open PRs and removing stale ones.

### Bounded Claude Queue

All Claude invocations go through a module-level queue in `claude.ts`. Up to
`MAX_CLAUDE_WORKERS` (default 2) `claude` processes run concurrently, balancing
throughput with host resource usage. The concurrency limit is configurable via
`maxClaudeWorkers` in `config.json` or the `CLAWS_MAX_CLAUDE_WORKERS` env var.
Each process has a configurable timeout (`claudeTimeoutMs`, default 20 min)
with SIGTERM/SIGKILL escalation. A 5-minute heartbeat logs PID, elapsed time,
and stdout byte count. Timed-out processes throw `ClaudeTimeoutError` with
diagnostic fields, surfaced in error reports for debugging.

### Skip-If-Busy Scheduling

Jobs that fire while a prior instance is still running are silently dropped —
no queue pile-up. This is distinct from the Claude task queue; a job can be
"running" while waiting in the Claude queue.

### Worktree Isolation

Each task gets its own git worktree at
`~/.claws/worktrees/<owner>/<repo>/<job>/<branch>`. The job namespace prevents
different jobs from colliding when they process the same branch concurrently.
The main clone lives at `~/.claws/repos/<owner>/<repo>`. Worktrees are always
cleaned up in a `finally` block after each task.

### Graceful Shutdown

On SIGINT/SIGTERM, `main.ts` cancels all queued (not yet started) Claude tasks,
drains running jobs (5-minute timeout), terminates any in-flight Claude
processes (5-second grace period), closes the database, and exits. The
`shutdown.ts` module provides a shared `isShuttingDown()` flag that prevents
the Claude queue from accepting new tasks during shutdown. Cancelled tasks
throw `ShutdownError` (a distinct error class), which the error reporter
suppresses — no Slack notifications or GitHub issues are created for shutdown
cancellations.

### Crash Recovery

At startup, any tasks still marked `running` in the database (from a previous
crash) have their worktrees cleaned up and are marked `failed`.

### Transient Retry & Rate Limit Circuit Breaker

The `gh` CLI wrapper retries up to 3 times with exponential backoff (1s, 2s,
4s) on transient errors (400, 500, 502, 503, 504, timeouts, connection resets,
"Could not resolve to a", "TLS handshake timeout", "Something went wrong").
Rate limit errors are handled separately: they trip a circuit breaker that
blocks all GitHub API calls for 60 seconds, throwing `RateLimitError`
immediately without retry. A single Slack notification is sent when the
circuit breaker trips, and another when the first API call succeeds after
cooldown expires. Jobs that iterate over repos short-circuit their loops via
`isRateLimited()` to avoid cascading failures during a rate-limit window.

### Error Reporting & Investigation Pipeline

Errors flow through two stages:

1. **Error reporter** (`error-reporter.ts`) — Uses a 30-minute cooldown per
   fingerprint. Recurrences add comments to the existing `[claws-error]` issue
   rather than opening new ones. `ShutdownError` and `RateLimitError` are
   filtered before any reporting. Source-level filtering also applies: the
   WhatsApp module's Baileys logger suppresses transient errors (keep-alive
   timeouts, stream errors) at warn level before they reach the reporter.
2. **Triage** (`triage-claws-errors.ts`) — Discovers `[claws-error]` issues
   by title pattern (no label required), runs two-phase deduplication (by
   fingerprint before investigation, then by root cause after), and posts an
   investigation report. Reads `docs/OVERVIEW.md` for context and identifies
   related issues that share the same root cause.

### CI-Fixer Two-Phase Design

The ci-fixer uses a two-phase identify/process pattern (matching the pattern
used by improvement-identifier and issue-refiner):

1. **Identify**: Scans all PRs, checks merge state, CI status, and classifies
   failures — collects typed `WorkItem` entries (a discriminated union with
   variants: `conflict`, `rerun`, `unrelated`, `fix`)
2. **Process**: Groups unrelated failures by repo (structural dedup — one
   consolidated issue per repo), then processes remaining items concurrently

This eliminates race conditions when multiple PRs in the same repo have
unrelated CI failures — without the grouping, concurrent `searchIssues` +
`createIssue` calls would produce duplicate issues.

Reruns are emitted both for cancelled/startup-failure workflows and when
failure log fetching returns empty (the `getFailedRunLog` two-tier fallback —
CLI then REST API — both returned no output). Benign "already running" errors
(a harmless race condition where the workflow restarted between detection and
rerun) are caught and logged at info level rather than reported as errors.

**`[ci-unrelated]` fix PRs**: When ci-fixer processes a PR whose title
contains `[ci-unrelated]` (i.e., a PR created by issue-worker to fix a
`[ci-unrelated]` issue), it skips the classification step entirely and treats
all CI failures as related. Without this guard, the classifier would see the
pre-existing failures, classify them as "unrelated to the PR's changes", and
the PR would stall indefinitely in a loop of filing redundant issues and
reverting fix attempts. Errors on these PRs are posted as comments directly
on the PR rather than creating `[claws-error]` issues.

### CI Infrastructure Monitoring

Two jobs monitor CI infrastructure health:

- **runner-monitor**: SSHes to configured self-hosted GitHub Actions runner
  hosts on a 10-minute interval. Checks service health (restarts dead `svc.sh`
  services), detects zombie/stale Runner.Worker processes (kills orphaned
  processes older than 6 hours only if the runner service is down), and
  monitors disk usage (cleans temp files when above 90%). Actions taken are
  reported via Slack. Runner hosts are configured with baked-in defaults
  (two Hetzner servers, overridable via `runners` in `config.json`).
- **ubuntu-latest-scanner**: Daily scan of `.github/workflows/*.yml` files in
  all cloned repos. Detects `runs-on:` values that are not `self-hosted` and
  creates a deduped alert issue in the offending repo. Skips commented-out
  lines and handles both direct string and array forms of `runs-on`.

### Image & Attachment Context

When processing issues or PR reviews, `images.ts` extracts embedded image
references and GitHub file attachments from the text, downloads them, and
appends prompt sections so Claude can view images and read attached files.
Images are saved into the worktree; text attachments are inlined in the
prompt. This is used by issue-refiner, issue-worker, and review-addresser.

### Documentation as Context

Issue-refiner, issue-worker, improvement-identifier, idea-suggester, and
triage-claws-errors prompts instruct Claude to read `docs/OVERVIEW.md`
(and linked docs) before starting work. This gives Claude accumulated
architectural context about each repository.

### Prompt Resource Injection

The idea-suggester's `buildPrompt()` accepts a `resources` parameter for
injecting reference material into prompts. Currently used to provide
marketing strategy knowledge (from `src/resources/marketing.ts`, sourced
from the Marketing-for-Founders repository) so Claude considers marketing
tactics when suggesting ideas. The resource is inlined as a TypeScript string
constant to avoid runtime file I/O and build-path issues.

### Branch Naming

| Job | Pattern |
|-----|---------|
| issue-refiner | `claws/plan-<N>-<hex4>` |
| issue-worker | `claws/issue-<N>-<hex4>` |
| triage-kwyjibo-errors | `claws/investigate-<N>-<hex4>` |
| triage-claws-errors | `claws/investigate-error-<N>-<hex4>` |
| doc-maintainer | `claws/docs-<YYYYMMDD>-<hex4>` |
| improvement-identifier | `claws/improve-<hex4>` |
| idea-suggester | `claws/ideas-<hex4>` |
| idea-collector | `claws/ideas-collect-<hex4>` |
| ci-fixer / review-addresser | Uses existing PR branch |

### PR Title Conventions

- `fix: resolve #N — <title>` — single-PR issue implementations
- `fix(#N): <phase title> (X/Y)` — multi-PR issue phases
- `refactor: <title>` — automated improvements
- `docs: update documentation for <repo>` — doc maintenance
- `[claws-ideas] Collected idea responses for <repo>` — idea collection

### Duplicate PR Guards

PR-creating jobs check for existing open PRs before creating new ones to
prevent pile-up when previous PRs haven't been merged:

- **doc-maintainer**: Skips if an open `claws/docs-*` PR exists
- **improvement-identifier**: Skips if any open `claws/improve-*` PR exists
- **idea-suggester**: Skips if a pending ideas file exists (previous batch
  still awaiting collection)
- **ci-fixer**: Uses consolidated per-repo `[ci-unrelated]` issues rather
  than per-fingerprint issues, so all unrelated CI failures for a repo
  are tracked in a single issue

### Item Skip & Prioritize

Individual issues/PRs can be skipped or prioritized via `skippedItems` and
`prioritizedItems` in `config.json` (arrays of `{repo, number}`), or via
the dashboard queue page buttons (`POST /queue/skip`, `/queue/prioritize`).
Skipped items are excluded from all job processing via `isItemSkipped()`.
Prioritized items are processed before others in job queues via
`isItemPrioritized()`. Both lists are hot-reloadable.

### Job Pause/Resume

Individual jobs can be paused and resumed via the dashboard (`POST /pause/:job`)
or pre-configured via `pausedJobs` in `config.json`. Paused jobs skip their
scheduled ticks but can still be triggered manually.

### Commit Tag

Doc-maintainer commits include `[doc-maintainer]` in the message. This is used
by `getLastDocMaintainerSha()` to detect whether docs are already up-to-date.

## Configuration

Configuration is resolved per-field: env vars > `~/.claws/config.json` >
defaults.

| Config key | Env variable | Default |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* |
| `slackBotToken` | `CLAWS_SLACK_BOT_TOKEN` | *(empty — needed for idea threads)* |
| `slackIdeasChannel` | `CLAWS_SLACK_IDEAS_CHANNEL` | *(empty — needed for idea threads)* |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` |
| `port` | `PORT` | `3000` |
| `kwyjiboBaseUrl` | `KWYJIBO_BASE_URL` | `https://kwyjibo.vercel.app` |
| `kwyjiboApiKey` | `KWYJIBO_AUTOMATION_API_KEY` | *(empty)* |
| `intervals.issueWorkerMs` | — | `300000` (5 min) |
| `intervals.issueRefinerMs` | — | `300000` (5 min) |
| `intervals.ciFixerMs` | — | `600000` (10 min) |
| `intervals.reviewAddresserMs` | — | `300000` (5 min) |
| `intervals.triageKwyjiboErrorsMs` | — | `600000` (10 min) |
| `intervals.autoMergerMs` | — | `600000` (10 min) |
| `intervals.triageClawsErrorsMs` | — | `600000` (10 min) |
| `intervals.ideaCollectorMs` | — | `1800000` (30 min) |
| `intervals.runnerMonitorMs` | — | `600000` (10 min) |
| `schedules.docMaintainerHour` | — | `1` (1 AM local time) |
| `schedules.repoStandardsHour` | — | `2` (2 AM local time) |
| `schedules.improvementIdentifierHour` | — | `3` (3 AM local time) |
| `schedules.ideaSuggesterHour` | — | `4` (4 AM local time) |
| `schedules.issueAuditorHour` | — | `5` (5 AM local time) |
| `schedules.ubuntuLatestScannerHour` | — | `6` (6 AM local time) |
| `runners` | — | Two default self-hosted runner hosts (see config) |
| `logRetentionDays` | — | `14` |
| `logRetentionPerJob` | — | `20` |
| `whatsappEnabled` | `WHATSAPP_ENABLED` | `false` |
| `whatsappAllowedNumbers` | `WHATSAPP_ALLOWED_NUMBERS` | `[]` |
| `openaiApiKey` | `OPENAI_API_KEY` | *(empty)* |
| `maxClaudeWorkers` | `CLAWS_MAX_CLAUDE_WORKERS` | `2` |
| `claudeTimeoutMs` | `CLAWS_CLAUDE_TIMEOUT_MS` | `1200000` (20 min, minimum 60s) |
| `authToken` | `CLAWS_AUTH_TOKEN` | *(empty — auth disabled)* |
| `pausedJobs` | — | `[]` (job names to pause on startup) |
| `skippedItems` | — | `[]` (array of `{repo, number}` excluded from processing) |
| `prioritizedItems` | — | `[]` (array of `{repo, number}` processed first) |

Config changes made via the web UI (`POST /config`) take effect immediately
at runtime — no restart required. The config module uses ESM live bindings
(`export let`) so all consumers see updated values on their next access.
Interval and schedule changes are propagated to the scheduler via
`onConfigChange()` listeners that call `updateInterval()` /
`updateScheduledHour()`. The only exceptions are `port` (requires socket
re-bind) and `whatsappEnabled` (requires QR pairing), which are shown as
read-only in the UI.

Env vars always take priority over `config.json`. Fields set via env var
are shown as disabled in the config UI with a note indicating the override.

External tools `gh` and `claude` must be authenticated separately — Claws does
not manage their credentials.

The WhatsApp gateway requires a one-time QR-code pairing step. See
[WhatsApp Setup](whatsapp-setup.md) for the full walkthrough.

## Technology Stack

- **Runtime**: Node.js 22
- **Language**: TypeScript (strict mode, ES2022 target, Node16 modules, ESM)
- **Database**: SQLite via better-sqlite3 (WAL mode)
- **Testing**: Vitest — co-located test files, heavy mocking of external boundaries
- **CI**: GitHub Actions on self-hosted runner — build + test on every push
- **History cleanup**: Workflow-dispatch action for branch cleanup and `git-filter-repo` to audit/scrub git secrets
- **Releases**: Date-based version tags (`v<YYYY-MM-DD>.<N>`), tarball attached to GitHub Release
- **Auto-updates**: systemd timer checks for new releases every 60s, downloads + swaps + health checks with automatic rollback

## Filesystem Layout (Runtime)

```
~/.claws/
├── config.json          Configuration file
├── env                  Environment overrides (loaded by systemd)
├── claws.db             SQLite database
├── whatsapp-auth/       Baileys auth state (created on first QR pairing)
├── pending-ideas/       Transient state for ideas awaiting Slack reaction collection
│   └── <owner>-<repo>.json
├── repos/
│   └── <owner>/<repo>/  Main clone per repository
└── worktrees/
    └── <owner>/<repo>/
        └── <job>/
            └── <branch>/   Isolated worktree per task
```

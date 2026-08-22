# Key Patterns

Conventions, data flow, and design decisions for the claws codebase — see [OVERVIEW.md](OVERVIEW.md) for the high-level architecture.

### Content-Based State Machine

Issues and PRs are discovered by analysing comments, reactions, and PR state —
not labels. Eleven labels are used:

- `Refined` — trigger for issue-worker (only label that drives a state transition)
- `Ready` — informational, signals "Claws is done, your turn"
- `In Review` — informational, signals an issue has an open PR under review
- `Priority` — high-priority items processed first in all Claws queues
- `Duplicate` — issue has been identified as a duplicate; issue-dispatcher skips it in both the planner and implementer phases; canonical issue's last-phase PR auto-closes duplicates via `Closes #N`
- `Claws Ignore` — causes all Claws jobs to skip the item entirely (label-based complement to `skippedItems` config)
- `Claws Problematic` — PR has exceeded CI fixer circuit breaker thresholds and requires manual intervention
- `Billing` — applied by ci-fixer when a workflow run's annotations indicate a GitHub Actions billing/spending-limit block; rerun is skipped for these PRs
- `Plan: Fable` — causes issue-refiner to plan with `claude-fable-5` instead of the default opus tier; per-issue opt-in for Fable 5 planning
- `Manual Action` — applied by issue-worker when the PR-description generator emits a `MANUAL-ACTION:` marker; blocks auto-merger from merging the PR until a human removes it (#1887)
- `Automerge` — opt-in per issue (one-click from the Claws `/queue` and `/issues` pages); propagated by issue-worker onto the PR it opens. On a PR it replaces the human-LGTM gate in auto-merger with an automated one: the latest Claws `## PR Review` must be `clean` **and** must have reviewed the current HEAD SHA, and CI must be `passing` (a `none` check status is not enough). `Manual Action` still blocks the merge (#2120)

For LGTM-exempt dependabot/doc/ideas PRs, auto-merger accepts a `none` check status only once the head commit is at least 5 minutes old, so a head pushed seconds earlier — whose check runs have not registered yet — is never mistaken for a repo with no CI (#2354)

```
Issues (issue-dispatcher):
  No plan comment        →  (planner posts plan)         →  Ready label added
  Unreacted feedback     →  (planner refines plan)       →  Ready label re-added, response comment posted
  Open PR + follow-up Q  →  (planner posts response)     →  👍 reactions added (no label changes)
  Refined label          →  (implementer creates PR)     →  Refined removed, Ready removed, In Review added
  [claws-error] title    →  (triage-claws-errors)        →  investigation report posted
  Plan occurrences stale →  (planner re-plans in-place)  →  CLAWS_PLAN_OCCURRENCES marker updated (fires when currentOcc ≥ plannedOcc×2)
  No code change needed  →  (planner posts explanation + CLAWS_NO_CODE_CHANGES)  →  Claws Ignore label applied; pipeline short-circuits, issue stays open

PRs (pr-dispatcher):
  Empty PR (0 files changed, >10 min old)  →  (empty-pr-closer)  →  comment posted, PR closed; linked issue closed only if a PR for it already merged
  Dependabot PR (Problematic, tracking issue closed, all bumps satisfied-or-blocked on base)  →  (superseded-pr-closer)  →  comment posted, PR closed
  All open PRs               →  (reviewer)           →  review comment posted, Ready added if clean
  "/claude-review" comment   →  (reviewer)           →  re-review forced via Claude (bypasses OpenRouter for one cycle)
  Failing CI checks          →  (ci-fixer)           →  fix commits pushed or workflow rerun
  Merge conflicts            →  (ci-fixer)           →  conflicts resolved
  Reviewer feedback (auto)   →  (review-addresser)   →  🚀 reactions added, commits pushed → reviewer re-reviews
  Human review comments       →  (review-addresser)   →  🚀 reactions added, reply posted + Ready added if no commits pushed
  Dependabot (`dependabot[bot]` or `app/dependabot`) or LGTM'd Claws PR + passing CI  →  (merger)  →  merged, In Review removed
  Doc PR (claws/docs-*) + doc-only files + CI passing/skipped  →  (merger)  →  merged (no LGTM required)
  Idea-collection PR (claws/ideas-collect-*) + ideas-only files + CI passing/skipped  →  (merger)  →  merged (no LGTM required)
  Auto-bump PR (automation/bump-*, label auto-bump, no major-update) + image-pin manifests only (deployment.yaml, migrate-job.yaml, cleanup-test-data-cronjob.yaml under apps/<app>/ or its base/|prod/|migrate/ subdirectory) + CI passing  →  (merger)  →  merged (no LGTM required)
```

**Plan length warning**: After posting any plan comment (fresh plan,
refinement, or follow-up), the issue-refiner checks the output length against
`PLAN_LENGTH_WARN_CHARS` (30,000 chars). If exceeded, it posts an additional
GitHub `> [!WARNING]` callout comment — a yellow alert box in the GitHub UI —
advising that the plan is roughly double the 3,000-word budget and offering to re-plan
more concisely. This is distinct from `IMPLEMENTER_GUIDANCE_INSTRUCTIONS` (which
guides the planner to stay under 3,000 words) — the warning threshold sits at roughly double that budget on purpose: a 3,000-word plan with backticked paths and code fences runs ~16–19k chars, so a threshold near the word budget fires on ordinary plans and becomes noise. The warning is an after-the-fact operator signal for genuine outliers, not an enforcement of the word budget.

**Duplicate issue detection**: During fresh planning (`processIssue`), the
issue-refiner injects up to `MAX_DUPLICATE_CANDIDATES` (20) lower-numbered open
issues as "possible duplicate candidates" into the planner prompt. Claude appends a
`DUPLICATE_OF: #N` or `DUPLICATE_OF: none` line to its output. If a duplicate is
declared, the new issue receives a short "See #N" plan instead of a full
implementation plan, and a back-reference comment is posted on the canonical issue.
The duplicate issue also receives the `Duplicate` label, and the plan comment embeds
a plain-text `CLAWS_DUPLICATE_OF: #N` marker (never an HTML comment — consistent
with `NO_HTML_COMMENTS_INSTRUCTION` injected into all planner prompts). The issue-dispatcher then skips
`Duplicate`-labeled issues in both the planner and implementer phases. When the
canonical issue is implemented, the issue-worker calls `listDuplicateIssuesOf()` on
the last phase and appends `Closes #N` entries to the PR body for each open duplicate,
so all related issues are closed when the PR merges. Tiebreaking is deterministic:
lowest issue number wins (important when a cluster of alert issues is created in
parallel for the same root cause). The `parseDuplicateOf()` helper validates the
declared number against `allowedNumbers` to prevent hallucination. Candidate titles
and bodies are run through `guardContent()` before being injected. This scope is
restricted to fresh plans only — refinement and follow-up paths are not affected.

**Cross-repo issue transfer** (#2216): During fresh planning, if the planner judges
an issue obviously mis-filed, it can emit `CLAWS_TRANSFER_TO: owner/repo` naming
another repo owned by the *same* GitHub owner as the current one — candidates come
from `selectTransferCandidates()`, which lists all other same-owner managed repos
(capped at `MAX_TRANSFER_CANDIDATES`, 30). Transfer is checked before duplicate
detection is skipped (`duplicateOf === null` gates it) and takes precedence over
`CLAWS_NO_CODE_CHANGES`; it is disabled per-process via `CLAWS_PLANNER_TRANSFER=false`
and skipped entirely if the issue already carries a `CLAWS_TRANSFERRED_FROM:` stamp
naming a *different* repo than the current one (`alreadyTransferredInto()`) — one
hop only. The routing comment posted before the transfer uses its own
`## Repository Transfer` header (`TRANSFER_HEADER`), **never** `PLAN_HEADER`
(`## Implementation Plan`) — every "has this issue been planned?" check in the
pipeline (`findUnreactedFeedbackAfterPlan`, `work-handlers.ts`, `plan-parser.
findPlanComment`) tests for `PLAN_HEADER`, and GitHub carries comments across a
transfer, so a `PLAN_HEADER` here would make the destination treat the issue as
already planned and never re-plan it (a design flaw caught and fixed before merge —
see the `## Step Back` critique on #2216). The model's rationale text is passed
through `.replaceAll(PLAN_HEADER, "Implementation plan")` before posting, so a
stray `## Implementation Plan` string inside the model's own prose can't
accidentally re-trigger the same hijack. A stale `Ready` label is removed before
transferring (so the destination doesn't inherit a "Claws is done" signal), and
`gh.transferIssue()` failure falls back to a `Claws Ignore` label plus a comment
asking the human to move the issue manually — the `CLAWS_TRANSFERRED_FROM:` stamp
is only posted alongside a transfer attempt, so a failed transfer never poisons
routing in the (wrong) source repo forever.

Jobs track processed items via reactions on comments: the issue-refiner uses
👍 to mark seen comments, while the review-addresser uses 🚀 to mark
addressed review feedback. Human review comments are processed automatically;
Claws-authored suggestions require a human 👍 before implementation.

**Automated review-implement cycle**: Claws PR reviewer comments with
actionable feedback (`## PR Review` containing issues) are automatically
picked up by the review-addresser without requiring a human 👍 — this
creates a fully automated review → fix → re-review loop. Clean reviews
("no issues found" / "no net changes") are excluded from auto-addressing.
Non-review Claws comments still require human 👍. Text output rules for the
review-addresser: (1) if a review comment asks a **question** (e.g. "why did
you…", "what about…", "can you explain…"), the agent MUST post a written
answer — even when a code commit also addresses it; answering only with a
commit is not acceptable; (2) if a suggestion couldn't be implemented or an
error occurred, the agent explains in text; (3) if every comment was a pure
change request fully addressed by commits (no questions, no problems), the
agent posts no comment. The `Ready` label is added when a text reply is
posted without any commits. When only commits are pushed (no questions
asked), no comment is posted and `Ready` is not added — the reviewer
re-reviews in the same dispatcher cycle. This prevents `Ready` from
flickering on/off between cycles.

**Benign no-change output** (`isBenignNoChangeOutput`, exported from `review-addresser.ts`): when the addresser made no commits but produced text output, the guard distinguishes benign "already addressed / not applicable" confirmations from real blockers. A positive "no change needed" phrase is required AND no blocker/error/uncertainty signal may be present. When the guard returns `true`, `Ready` is applied (with a CI/merge-state re-check mirroring the pr-reviewer path) rather than withheld — fixing the case where a false-positive reviewer nit produces confirmation text that previously caused PRs to stall permanently (the `review-addressed: <SHA>` marker prevents the addresser from re-firing, and without a push there are no new commits for the reviewer to detect).

**Human-over-automated authority**: When human and Claws reviewer comments conflict
(e.g. a human directs "use self-hosted runner" but the automated review says "use
ubuntu-latest"), the review-addresser's prompt explicitly instructs it to follow the
human and ignore the conflicting automated comment. The authority hierarchy — established
by the `getPRReviewComments()` section headers — means human directives cannot be
silently overridden by the next automated review cycle.

**Refined plan is authoritative over the original issue**: `buildIssueContext()`
in `src/agents/pr-reviewer.ts` fetches both the originating issue body and the
Claws refined-plan comment (if one exists, via `planParser.findPlanComment()`).
When a plan comment exists, the reviewer is told the **refined plan**, not the
original issue text, is the authoritative spec — the planner may have
deliberately narrowed, expanded, or changed the original request after
investigation, and the reviewer must not flag that intentional divergence as a
"missing requirement" or "scope drift". The original issue body is still
included, but only as background on the user's initial intent. When no plan
comment exists, the issue body remains the sole source of truth (unchanged
behavior). This prevents the reviewer from forcing a PR back toward a
requirement the plan explicitly rejected (e.g. issue #1792 asked for an in-app
OIDC allowlist; the refined plan concluded it was unnecessary because
authorization is already enforced upstream in Authentik — see the auth
discussion above — and the reviewer must accept that narrower scope).

**`review-result: clean` marker**: When the pr-reviewer posts a "no issues found"
review, the review body includes a plain-text `review-result: clean` marker (in addition
to the human-readable text). `maybeAddReadyLabel()` uses this marker as its primary
detection signal (with a regex fallback for older reviews that predate it), eliminating
fragile text-matching on body content that may have accumulated formatting drift.
`extractCurrentReviewContent()` strips the marker before content comparisons, and also
strips the `review-addressed: <SHA>` marker written by the review-addresser (preventing
it from leaking into content comparisons).

`isNoActionableReview(output)` catches a related edge case: re-reviews whose verdict is
"no actionable changes" phrased conversationally (e.g. "no changes needed", "the review I
already posted is accurate") without the exact `review-result: clean` marker. These are also
classified as clean so the `Ready` label is applied. The helper returns `false` if the review
carries any actionable signal (file/line references, backticked paths, `Suggested Approach
Change`, `recommended-model:` annotation) to prevent false positives.

The pr-reviewer also includes a **reassessment mechanism**: after
`REASSESSMENT_THRESHOLD` (3) previous reviews with substantive issues,
the reviewer prompt includes the last 5 rounds of feedback and asks Claude
to reassess whether the current approach is fundamentally sound, or whether
a different approach would avoid recurring issues entirely. If so, the
review leads with a "Suggested Approach Change" section.

Triage jobs check for existing report comments.
The issue-auditor reconciles label state daily, adding missing `In Review`
labels to issues with open PRs and removing stale ones.

### SQLite-Backed Work Queue

Dispatcher jobs (`issue-dispatcher`, `pr-dispatcher`) classify items and
`enqueue()` work into the `work_queue` SQLite table via `worker.ts`. Up to
`MAX_WORK_WORKERS` (default 2) worker fibers run concurrently; each claims the
highest-priority oldest `queued` row via `claimNextWork()`, invokes the
registered handler, and marks the row `completed` or `failed`. The concurrency
limit is configurable via `maxWorkWorkers` in `config.json` or the
`CLAWS_MAX_WORK_WORKERS` env var (`maxClaudeWorkers` / `CLAWS_MAX_CLAUDE_WORKERS`
are deprecated aliases). Idempotency is enforced by a UNIQUE partial index on
`(kind, repo, item_number) WHERE status IN ('queued', 'running')` — a second
`enqueue()` for the same item no-ops silently.

Each Claude process spawned by a handler has a configurable timeout
(`claudeTimeoutMs`, default 6 hours) with SIGTERM/SIGKILL escalation. Per-item
overrides can extend this for items that have timed out before (see Per-Item
Timeout Escalation below). A 5-minute heartbeat logs PID, elapsed time, and
stdout byte count. A configurable **liveness abort** (`claudeLivenessTimeoutMs`,
default 6 hours) kills processes that produce zero stdout bytes early. A per-worker **memory watchdog** additionally samples each Claude/Codex process tree's RSS every 15s and SIGKILLs the whole tree (children included — e.g. a runaway `openscad` render) when it exceeds `claudeWorkerMemoryMaxBytes` (default 2 GiB; `0` disables), throwing `AgentMemoryLimitError`. The Claude CLI is spawned with `NODE_OPTIONS=--max-old-space-size=1024` to keep its V8 heap footprint deterministic under the cap. After 3 consecutive memory-limit kills in a 2-hour window, the item is auto-skipped (via `gh.skipItem`) and a comment is posted explaining the skip; below that threshold a comment is posted and the item re-queues normally. All liveness, timeout, and memory kills reap the entire process tree, not just the CLI process. `runClaude`
wraps `runClaudeOnce` with a retry layer (gated on `!isShuttingDown()`) that
retries once on: (1) 0-byte timeouts (transient hang recovery), (2) `AgentCliError`
with `numTurns === 0` (transient CLI initialization failure), or (3) `AgentCliError`
matching `API_TRANSIENT_RE` (Anthropic API 5xx errors, unexpected socket closures,
and mid-response connection failures). Non-0-byte timeouts and CLI
errors with turns > 0 that don't match the transient API pattern are not retried.
The stdin pipe has an error handler to prevent unhandled stream errors. Timed-out
processes throw `AgentTimeoutError` with diagnostic fields, surfaced in error
reports for debugging. CLI-level failures (usage limits, auth errors, malformed
output) throw `AgentCliError` — usage-limit errors are suppressed by the error
reporter; other CLI errors create `[claws-error]` issues normally.

### Model Selection

`model-selector.ts` provides `getModel(defaultTier, provider)`. Three tiers
exist: `"cheap"` (trivial tasks), `"sonnet"` (standard), and `"opus"` (complex).
Most call sites pass the tier explicitly; `"sonnet"` is the default. The PR
reviewer embeds a `recommended-model: sonnet` or `recommended-model: opus` marker
(plain text) in its review output, and the review-addresser extracts it to choose
the appropriate tier.
Per-provider model mapping: Claude uses `CLAUDE_CHEAP_MODEL` / `"sonnet"` /
`"opus"`; Codex uses `CODEX_CHEAP_MODEL` / `CODEX_LIGHT_MODEL` /
`CODEX_DEFAULT_MODEL`; OpenCode uses `OPENCODE_CHEAP_MODEL` /
`OPENCODE_ADEQUATE_MODEL` / `OPENCODE_BEST_MODEL`.
Empty-string overrides are handled: if `CLAUDE_CHEAP_MODEL` is `""`, the cheap
tier falls back to `"haiku"` (a valid Claude CLI alias, cheaper than sonnet).
The model used for each task is recorded in the `model_used` column, and the
provider used is recorded in the `provider_used` column, both via `db.ts`.

The issue-refiner (planner) recommends a model tier per issue via embedded
annotations in the plan comment. Provider selection is not part of the plan —
every call site declares its `capability` (`"tool-use"` or `"text-only"`) and
`runClaude()` walks the corresponding fallback order. Tool-use workflows
(issue-worker, ci-fixer, review-addresser, doc-maintainer, improvement-identifier,
triage-claws-errors, pr-reviewer) use Claude — pr-reviewer was flipped from
text-only to tool-use (#1879) so it can verify git facts (diff, blame, file
contents) with real tool calls before asserting them in a review, rather than
trusting the PR description alone. Text-only workflows split
into two groups:

- **Pinned to Claude** (explicit `provider: "claude"` on the `runClaude` call):
  issue-refiner plan generation/refinement/follow-up,
  improvement-identifier analysis phase, email-monitor (both veg-list extraction
  and recipe generation, pinned to avoid OpenRouter 402 credit errors), whatsapp-handler message interpretation (pinned for the same reason, #2151), and the
  PR description/diagnosis utilities in `claude.ts` (`generatePRDescription`,
  `generateDocsPRDescription`, `regeneratePRDescription`, `diagnoseNoCommits`).
  These are pinned for output quality, structured-JSON correctness, or reliable
  auth — Qwen via OpenCode/OpenRouter consistently produces malformed JSON for
  analysis tasks, blocking all downstream work.
- **Unpinned, walks `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`**: idea-suggester.
  The code-level default of that order is `["claude"]` — idea-suggester
  must not default to OpenCode/Qwen, because Qwen-generated ideas were
  noticeably lower quality (#1420). An operator can still override
  `textOnlyProviderFallbackOrder` (or `CLAWS_TEXT_ONLY_PROVIDER_FALLBACK_ORDER`)
  to route these to OpenCode+Qwen on OpenRouter to preserve Claude quota, but
  that is an explicit opt-in, not the shipped default.

Pinning with `provider: "claude"` bypasses the fallback chain entirely and fails
visibly on a Claude outage rather than silently routing to a provider that may
produce unusable output.
The planner itself defaults to the `opus` tier (no classification step) because issue descriptions are frequently too sparse to classify reliably, and a wrong downgrade — especially to `haiku` via the `cheap` tier — produces low-quality plans that propagate through every downstream implementation. When an issue carries the `Plan: Fable` label, `planModelForIssue()` in `issue-refiner.ts` overrides the model to `claude-fable-5` (`FABLE_MODEL`) instead, and `FABLE_PLANNING_CONTEXT` is injected into the prompt to direct extra capability toward deeper investigation rather than longer plans (the implementer model is unchanged, so the planner–implementer capability gap is wider than usual). Follow-up Q&A (`processFollowUp`) always uses the `sonnet` tier regardless of the label.
The planner prompt emphasizes that implementation will run on a smaller model and
instructs the planner to produce a detailed, specification-grade plan (exact file
paths, concrete edits, named invariants and gotchas) to keep the implementer on
track. Attribution footers (`*Models used: <model> (provider: <provider>)*`) are
appended to plan comments and PR descriptions to record which model/provider was
actually used.

### Skip-If-Busy Scheduling

Jobs that fire while a prior instance is still running are silently dropped —
no queue pile-up. This is distinct from the Claude task queue; a job can be
"running" while waiting in the Claude queue.

### Smart Scheduling

Low-priority background jobs (doc-maintainer, improvement-identifier,
issue-auditor, dependabot-alert-monitor, dependabot-run-monitor,
scanner-dispatcher, stale-branch-cleaner) use smart scheduling via
`smart-schedule.ts` rather than fixed intervals — all seven are wired through the
`smartScheduledJob()`/`smartScheduledBatchJob()` factories in `main.ts`. Each smart-scheduled job fires
hourly (configurable via `smartScheduling.tickIntervalMs`) and uses
staleness-based per-repo selection via `selectReposForTick()`:

1. **Due repos** (`targetStalenessMs`, default 24h): only repos not processed
   within the target staleness window are candidates for this tick.
2. **Busy gate** (`isClawsBusy`): skips the tick if `work_queue` has active or
   pending agent tasks (excluding `ignoreBusyKinds` — PR agents and smart-schedule
   jobs themselves are excluded so they don't block each other).
3. **SLO escape valve** (`sloStalenessMs`, default 48h): if Claws is busy but one
   or more repos have exceeded the SLO threshold, only those SLO-breached repos are
   processed regardless of busy state. A throttled Slack warning fires when the
   escape valve engages.
4. **Concurrency cap**: `withSmartJobSlot()` limits concurrent repo processing to
   `smartScheduling.maxConcurrentJobTasks` (default 4).

Jobs call `db.markRepoProcessedDaily()` after each successful repo run.
Skip statuses (disabled repo, no work needed, etc.) do not consume a daily
slot — only actual processing does.

**Manual trigger bypass**: `shouldRunSmartJob(name, now, manual)` gates the tick. All
eight smart-scheduled jobs are present as keys of `smartScheduling.jobs` by default;
if a job name is not a key (e.g. a user-edited `config.json` removed one), the gate
always passes regardless of `manual` or the `smartScheduling.enabled` flag. For jobs
that *are* keys, a `manual` trigger (`POST /trigger/:job` or the dashboard button)
also always passes — the global kill-switch (`smartScheduling.enabled = false`) only
blocks their unattended, non-manual ticks. In every case, staleness-based repo
selection in `selectReposForTick()` still applies (repos already processed within
`targetStalenessMs` are not reprocessed by a manual trigger).

The `main.ts` `smartScheduledJob()` factory wires the gate check into the scheduler's
tick and registers the job with `tickIntervalMs` as the interval.

**Staleness-first ordering**: `selectReposForTick()` in `smart-schedule.ts` sorts due
repos by age descending — the most stale repo is processed first. A stable tiebreak by
`fullName` ensures deterministic ordering when ages are equal. Repos never processed for
a given job have age = `Infinity` and always sort first, preventing starvation.
`db.getLastProcessedTimestampsForJob(jobName)` provides the `Map<repo, epoch-ms>` used
for age computation.

**Owner requirement — not yield-based backoff.** #663 originally proposed a
different design: track each fixed-interval job's "yield rate" (ticks that
find work vs. ticks that don't) and adaptively double the polling interval
during quiet periods, resetting on the next hit. That per-job yield-tracking
mechanism was never built (`scheduler.ts` has no concept of yield or
backoff). What shipped instead, for the nine low-priority jobs above, is the
staleness-based per-repo selection described here — a different mechanism
that happens to address the same underlying waste (polling repos with
nothing to do); `issue-dispatcher`/`pr-dispatcher` and the other
fixed-interval jobs still poll at a flat interval with no yield-based
adjustment.

### Worktree Isolation

Each task gets its own git worktree at
`~/.claws/worktrees/<owner>/<repo>/<job>/<branch>`. Both `createWorktree` and
`createWorktreeFromBranch` use `--no-track` to avoid `.git/config` lock
contention when concurrent worktree operations target the same repo. The job
namespace prevents path collisions. A namespace must be owned by exactly one
work-queue kind: `work_queue`'s partial unique index on `(kind, repo,
item_number)` guarantees at most one queued-or-running task per kind per item,
so single-kind ownership makes concurrent worktrees at one path impossible.
Conflict resolution therefore uses the `ci-fixer-conflict` namespace and is
reached only from `ci-fixer:conflict` tasks — the `ci-fixer` handler enqueues
that kind instead of calling `resolveConflicts` inline (#2158). Read-only jobs (`pr-reviewer`) use
`--detach` mode to avoid git's one-branch-per-worktree restriction, allowing
multiple jobs to read the same branch simultaneously. Write jobs (`ci-fixer`,
`review-addresser`) check out the branch on a namespace-scoped local branch
(`claws-wt/<job>/<remoteBranch>`), with a defensive fallback to detached mode
if the branch is already locked by another worktree. `removeWorktree`
auto-detects and deletes `claws-wt/` scoped branches after worktree removal.
The main clone lives at `~/.claws/repos/<owner>/<repo>`. Worktrees are always
cleaned up in a `finally` block after each task. The higher-level
`withNewWorktree<T>(repo, branchName, namespace, fn)` and
`withExistingWorktree<T>(repo, branchName, namespace, fn)` helpers in
`claude.ts` own the full create + try/finally cleanup lifecycle, eliminating
the footgun of forgetting cleanup. `withExistingWorktree` returns `null` if
the branch doesn't exist (absorbed `BranchDeletedError`). Most agents have
been refactored to use these helpers instead of manual `createWorktree` +
`finally removeWorktree` patterns.

`createWorktreeFromBranch` validates that the remote ref exists (via
`git rev-parse --verify`) before creating the worktree. If the branch has
been deleted (e.g. after a PR merge), it throws `BranchDeletedError`. The
convenience wrapper `createWorktreeFromBranchIfExists` catches this error
and returns `undefined`, allowing callers to skip work items with deleted
branches without noisy error reports. All PR-processing agents (pr-reviewer,
ci-fixer, review-addresser) use `createWorktreeFromBranchIfExists`.

Every interactive session is spawned via tmux with `env: { ...process.env }`,
so `claude` always runs as the service user with the service's `HOME`,
whatever repo's worktree is the current directory. Claude Code resolves
Claude Code skills from both the project's `.claude/skills/` **and**
`~/.claude/skills/`, so a skill installed once at the user level (via
`deploy/install-skills.sh`, e.g. `/postmortem`) is available in every Claws
session in every managed repo, not just the `claws` repo. A skill meant to
run this way must not reference a claws-repo-relative path — it executes
inside a worktree of whichever repo the session is working on.

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

### Auto-Update & Rollback

`deploy/deploy.sh` runs every 60s via `claws-updater.timer` (systemd, outside
the Node process — this is what allows it to keep functioning and alerting
even while the `claws` service itself is crash-looping). Each tick: fetch the
latest GitHub release tag, skip if already current or previously
skip-listed (`$INSTALL_DIR/.skipped-versions`), download and extract the
release tarball to a staging dir, then:

1. **Node ABI gate (before touching the running service).** `release.yml`
   stamps the build's Node major into a `.node-version` file at the tarball
   root (via `process.versions.node`, not the hardcoded `setup-node` version,
   so it stays correct if that's bumped). `deploy.sh` compares it against the
   host's `node --version` *before* backing up or stopping anything. A
   mismatch (release tarballs bundle a prebuilt `node_modules/` with native
   modules like `better-sqlite3` compiled against the build's Node major, so a
   different host major fails `dlopen` at startup) aborts immediately, Slacks
   the operator with the fix (upgrade host Node, then remove the tag from the
   skip file), adds the tag to the skip list, and leaves the running version
   untouched — no downtime. A tarball with no `.node-version` (pre-feature
   release) skips the check with a warning rather than blocking. Added after a
   2026-07-18 incident where a Node-major bump reached the build before the
   host, causing `ERR_DLOPEN_FAILED` after the service had already been
   stopped and swapped.
2. **Backup, stop, swap.** `dist` → `dist.prev` (copy), then `node_modules` is
   backed up to `node_modules.prev` via rename (not copy — same filesystem,
   avoids doubling disk usage for a large tree) *during* the swap step, after
   the service is stopped. Both `.prev` trees are cleaned up on a successful
   deploy and restored together on rollback — a bug where rollback restored
   only `dist.prev` (leaving the old `dist` paired with a still-broken new
   `node_modules`) caused a rollback to fail to actually recover during the
   same incident.
3. **Health check + rollback.** Polls `GET /health` for up to 45s after
   restart; on failure, restores `dist.prev`/`node_modules.prev`, restarts,
   and polls again for up to 30s. A tag that reaches this rollback path (or
   the ABI gate above) is always added to the skip list, and a Slack message
   is sent once — the timer would otherwise re-alert every tick until a human
   intervenes.
4. **Persistent unhealthy reminder.** If the timer skips a skip-listed tag on
   a later tick, `remind_if_unhealthy()` checks `/health` again: if still
   failing, it Slacks a reminder at most once per hour (tracked via a
   `.unhealthy-alert-ts` timestamp file) rather than staying silent between
   the initial failure alert and manual intervention. The stamp is cleared as
   soon as the service reports healthy again (including on the next
   successful deploy), so a fresh outage alerts immediately rather than
   waiting out the old cooldown. This exists because during the 2026-07-18
   incident the only one-time "manual intervention required" Slack message
   was easy to miss, and claws itself couldn't escalate further since it was
   the thing that was down — the updater timer, running independently of the
   Node process, is the only component that reliably keeps checking.

5. **No success notification.** A healthy deploy is silent: it records the tag,
   clears the unhealthy stamp, and logs `Update to <tag> complete` with no Slack
   post (#2561 — releases are cut on every push to `main`, so the per-deploy
   message was pure noise). Slack is reserved for the ABI-gate abort, rollback,
   failed-rollback, no-previous-version, and hourly still-unhealthy paths above.
   `release.yml` still generates release notes from
   `git log --oneline --no-merges <prev-tag>..HEAD` (capped at 20 lines) for the
   GitHub Release page; `deploy.sh` no longer fetches that body, so the
   `gh release view` call is gone.

See `deploy/deploy.sh` for the full script; `~/.claws/` (config, env, DB) is
never touched by any of the above.

**Permission normalisation + Whisper self-healing (#2407).** Release tarballs
carry whatever uid/gid/mode the CI runner's filesystem had, and `deploy.sh`
extracts them **as root** (`claws-updater.service` runs as root), so `tar`
restores those foreign owners/modes verbatim. On 2026-08-07 this left
`deploy/whisper-server.py` unreadable by the unprivileged user
`whisper.service` runs as, crash-looping the local Whisper backend until
`transcribe.ts`'s local→remote→OpenAI fallback chain hit an unfunded OpenAI
account and raised `WhisperQuotaExhaustedError` on an ordinary WhatsApp voice
note (#2407, #2408 — same root cause). Two mechanisms now guard against this:

- `normalize_perms()` — a **chmod-only** `chmod -R u+rwX,go+rX` pass, deliberately
  never `chown`. `claws-updater.service` runs `deploy.sh` from
  `/opt/claws/deploy` as root every 60s, so making that tree writable by the
  unprivileged service user would be a privilege-escalation path (any code
  execution as that user becomes root on the next timer tick) — the failing
  permission was *read*, not ownership, so chmod alone fixes it without that
  risk. Runs as the first statement in `ensure_whisper_unit()` (so the live
  tree self-heals every tick) and again on the freshly-extracted staging dir
  right after `tar -xzf --no-same-owner` (so a bad tarball is fixed before the
  Node-ABI gate and the stop/swap/start window). `release.yml` also now writes
  tarballs pre-normalised (`--owner=0 --group=0 --numeric-owner
  --mode='u+rwX,go+rX'`) so this is defence in depth, not the only fix.
- `check_whisper_health()` — `whisper.service` exhausts `StartLimitBurst=5`
  after a crash loop and then stays `failed` forever; systemd does not retry
  it, and `ensure_whisper_unit` only restarts the unit when the *unit file*
  changed, not when the process has merely died. This runs `systemctl
  reset-failed whisper && systemctl start whisper` at most once per 10 minutes
  while the unit is `failed`, and Slack-alerts at most once per hour
  (`.whisper-alert-ts`) only if that recovery attempt doesn't stick — silent
  otherwise, since the fallback chain already hides a dead local backend from
  the end user.

See [Voice-note transcription](whatsapp-setup.md#step-2--voice-note-transcription-on-by-default)
for the fallback chain this protects and the manual recovery command if
self-healing doesn't hold.

### Transient Retry & Rate Limit Circuit Breaker

Both the `gh` CLI wrapper (in `github.ts`) and the `git()` helper (in
`claude.ts`) retry up to 3 times with exponential backoff (1s, 2s, 4s) on
transient network errors. The `gh` wrapper matches HTTP status codes (400, 401,
500, 502, 503, 504), timeouts, connection resets, "Could not resolve to a",
"TLS handshake timeout", "Something went wrong", Go TCP dial "i/o timeout",
`"invalid character"` (Go `encoding/json` errors from `gh` when GitHub's Checks
API returns a transitional response during an in-progress check), EAGAIN /
"failed to create new OS thread" / "resource temporarily unavailable" (OS-thread
exhaustion when `TasksMax` cgroup pressure prevents Go binaries from spawning
threads), `"unexpected EOF"` and a bare `: EOF` (TCP connection dropped before or during the HTTP response; `gh`
wraps the latter as `failed to update <url>: EOF` — #2417). `getPRCheckStatus` and `getPRChecksSummary` additionally catch
`"invalid character"` in their own `catch` blocks and degrade gracefully to
`"none"` rather than crashing the `processPR` task — the pr-dispatcher re-runs
every 5 minutes, so missing one cycle is invisible to the operator.
The `git()` helper matches HTTP 5xx, ETIMEDOUT, ECONNRESET, ECONNREFUSED,
EAGAIN, TLS handshake timeout, DNS failures, "i/o timeout", "failed to create
new OS thread", and "resource temporarily unavailable" — plus, as a separate
alternative group appended for OpenSSH's own connect-failure wording
("Connection timed out", "Connection refused", "Network is unreachable",
"Connection closed by remote host", `kex_exchange_identification`,
`client_loop: send disconnect`), since a `git@github.com:` SSH remote reports
a connect timeout as `ssh: connect to host github.com port 22: Connection
timed out`, which shares no substring with the HTTPS/libcurl phrasing above it
and so previously retried zero times before failing permanently (#2471).
Permanent SSH failures ("Permission denied (publickey)", "Host key
verification failed", "Repository not found") deliberately still match
nothing. The `gitRaw()` helper does not retry — callers
manage their own error handling.

A GitHub-wide incident is a distinct failure class from a single flaky call:
`github-status.ts` polls githubstatus.com every 2 minutes and, while a
component Claws depends on is non-operational, `error-reporter.ts` downgrades
every `gh`/`git` CLI failure to a warning instead of filing/updating a
`[claws-error]` issue per repo per dispatcher tick — see
[Error Reporting & Investigation Pipeline](#error-reporting--investigation-pipeline)
and [GitHub-Wide Incident Detection](#github-wide-incident-detection) below.
Rate limit errors are handled separately: they trip a circuit breaker that
blocks all GitHub API calls for 60 seconds, throwing `RateLimitError`
immediately without retry. A single Slack notification is sent when the
circuit breaker trips, and another when the first API call succeeds after
cooldown expires. Jobs that iterate over repos short-circuit their loops via
`isRateLimited()` to avoid cascading failures during a rate-limit window.
`createIssue()` and `createPR()` are not idempotent server-side operations,
so retrying a call whose server-side write succeeded but whose response was
lost to a transient error would otherwise surface an opaque "already exists"
failure and, for `createIssue`, potentially file a duplicate. Both catch that
specific error string, parse the issue/PR number out of it, and return that
number instead of throwing — treating a retry-induced duplicate as success
rather than a spurious `[claws-error]` (#197).
Because of this, independent read-only per-item fetches on a hot path (e.g.
`findUnreactedHumanComments` in `issue-refiner.ts`, called every dispatcher
cycle) are gathered with a plain `Promise.all` rather than a bounded-concurrency
wrapper — the owner explicitly rejected adding a concurrency cap here (#1621):
a proposal to defensively cap fan-out at 5 in flight was reverted once it was
confirmed the `gh` wrapper's own rate-limit circuit breaker and retry-with-
backoff already cover this case, making a second throttling layer unnecessary
complexity. Prefer this reasoning before reaching for `mapWithConcurrency` on a
new hot-path loop of independent GitHub reads — it's still the right tool for
large batch fan-outs across many repos, just not for this class of call.

### WhatsApp Pairing Notifications

The WhatsApp module sends Slack notifications on pairing state transitions,
following the same "notify once per state change" pattern as the rate limit
circuit breaker. A `lastNotifiedState` variable deduplicates notifications:
a "pairing required" alert is sent once when the session is lost (logout,
stale session, repeated connection failures), and a "connected" notification
is sent only if a prior pairing-required alert was active. User-initiated
actions (unpair, stop pairing) do not trigger notifications.

Auth state is cleared only on status 401 (`loggedOut`) or 500 (`badSession`) —
the only statuses that actually invalidate credentials. Status 515
(`restartRequired`) fires after post-pairing key exchange and is transient —
the handler reconnects after 1 second without incrementing `consecutiveFailures`.
Every other disconnect (405 stale WA Web version, 440 `connectionReplaced`,
408, 428, unknown) retries indefinitely with backoff capped at 5 minutes and a
one-shot Slack alert after 5 consecutive failures, instead of destroying the
pairing (#2274) — a 440 no longer clears auth state, since the underlying
session is often still valid.

`startPairing()` explicitly resets `lastNotifiedState = "pairing-required"`
after `stop()` (which resets it to `null`) so the `"connected"` Slack
notification fires correctly after the new session establishes.

WhatsApp connection events are persisted to the `whatsapp_events` SQLite table
and accessible at `GET /whatsapp/events` (JSON) and displayed on the WhatsApp
dashboard page as a "Recent Events" log.

### Error Reporting & Investigation Pipeline

Errors flow through two stages:

1. **Error reporter** (`error-reporter.ts`) — Uses a 30-minute cooldown per
   fingerprint. Recurrences edit the body of the existing `[claws-error]` issue
   (via `ensureAlertIssue()`) rather than opening new ones or adding comments.
   `ShutdownError`, `RateLimitError`, `TransientGitHubError`, `PushConflictError`,
   and select `AgentCliError` patterns (usage-limit, transient API 5xx) are
   filtered before any reporting. A `gh`/`git` subprocess failure is also
   downgraded to a warning — instead of filing/updating a `[claws-error]`
   issue — while `github-status.ts` reports GitHub itself is mid-incident
   (`isGitHubDegraded()`); a per-component check (not the overall status
   indicator) keeps a Copilot/Codespaces-only incident from suppressing
   genuine Claws errors, and a 10-minute recovery grace period covers 403s
   that linger briefly after components flip back to operational (#2486).
   The dashboard's Integrations panel and a one-shot Slack notice on each
   incident transition carry the signal instead. Source-level filtering also applies: the
   WhatsApp module's Baileys logger suppresses transient errors (keep-alive
   timeouts, stream errors, bad-request) at warn level before they reach the
   reporter. When Baileys uses structured logging (object + message string),
   `baileysLogger.error` also checks `obj.err` against `TRANSIENT_MESSAGES` —
   this catches cases where the human-readable `msg` differs from the underlying
   error value (e.g. `"unexpected error in 'init queries'"` with `err: "bad-request"`).
2. **Triage** (`triage-claws-errors.ts`) — Discovers `[claws-error]` issues
   by title pattern (no label required), runs two-phase deduplication (by
   fingerprint before investigation, then by root cause after), and posts an
   investigation report. Reads `docs/OVERVIEW.md` for context and identifies
   related issues that share the same root cause. Every investigation prompt
   requires Claude to end its output with a `RELATED_ISSUES: <numbers|none>`
   sentinel. `isReportTruncated(output)` checks for this sentinel; if absent,
   the investigation is retried once with a fresh `runClaude` call. If the
   retry output is also truncated, the task is recorded as complete with zero
   commits (no comment is posted) so that no `REPORT_HEADER` is written and the
   next scheduled triage run picks the issue up again — avoiding a permanently
   truncated report being posted.

### GitHub-Wide Incident Detection

`github-status.ts` polls `https://www.githubstatus.com/api/v2/summary.json`
every 2 minutes (the `github-status` job) to distinguish "GitHub itself is
having an incident" from an ordinary per-repo transient failure (#2486).
`degraded` is computed per-component — `components.some(c =>
COMPONENTS_WE_DEPEND_ON.has(c.name) && c.status !== "operational")` over
`{Git Operations, API Requests, Webhooks, Issues, Pull Requests, Actions}` —
deliberately not from `status.indicator`, so a Copilot/Codespaces-only
incident (which still sets `indicator: "minor"`) does not suppress genuine
Claws error reporting. `isGitHubDegraded()` also stays true for a 10-minute
grace period after components flip back to `operational`, because 403
"Resource not accessible by integration" responses from a mid-incident App
token are observed to linger briefly past the status page's own recovery;
conversely a stale snapshot (no successful poll in 15 minutes) can no longer
gate suppression at all, so a hung poller fails open to normal reporting
rather than silently muting alerts forever. A poll failure itself is
`log.warn`-only and never throws — throwing would route through the
scheduler's own `reportError()` and file the exact `[claws-error]` issue this
mechanism exists to prevent.

`error-reporter.ts` consumes `isGitHubDegraded()` to downgrade any `gh`/`git`
subprocess failure (matched via `isGitHubCliError()` on the fixed `gh <args>
failed:` / `git <args> failed in ` message prefixes) to a warning while an
incident is live, instead of filing or bumping a `[claws-error]` issue per
repo per dispatcher tick. The result is also surfaced directly: the
dashboard's Integrations panel links to githubstatus.com and shows the active
incident name plus a relative "last checked" time, and each transition into
or out of `degraded` posts exactly one Slack notice (not one per tick).

### CI-Fixer Circuit Breaker

The ci-fixer includes a circuit breaker to prevent infinite automated fix
attempts on PRs where CI continues to fail despite multiple attempts.
Configuration via `ciFixerCircuitBreaker` in `config.json`:

| Config key | Default | Description |
|---|---|---|
| `maxAttempts` | `5` | Maximum CI fix attempts per PR within the window |
| `windowMs` | `86400000` (24h) | Time window for counting attempts |
| `maxConsecutiveFailures` | `3` | Maximum consecutive failures before tripping |
| `maxCommitGrants` | `3` | Lifetime new-commit fix grants per PR (see below) |

The breaker only trips while the PR still has **dispatchable work** — a failing
check, or a `CONFLICTING` mergeable state the conflict resolver keeps failing to
clear. Exceeding the attempt budget on a green, mergeable PR logs and does
nothing: there is no further work to stop, and re-applying `Claws Problematic`
there just fights the diagnoser's stale-label clearing, which strips it again on
the next pass (#2390: ~18 add/remove cycles on one PR). The diagnoser enforces
the mirror-image rule — see `hasBlockingConflict()` below — so the two
definitions of "dispatchable work" stay in sync. If they diverge, one side loops
silently forever: gate only on the failing check and a permanently-conflicting PR
gets an endless stream of resolver runs with no escalation; clear the label on
green CI alone and a conflict-triggered trip never sticks.

When thresholds are exceeded, the PR is marked as problematic:
- Further automatic CI fix attempts are skipped
- A comment is posted on the PR explaining the situation
- The PR appears in a "Problematic PRs" section on the `/queue` dashboard page
- Manual unmarking is available via `POST /queue/unmark-problematic`

#### New-commit grants

A problematic PR is not frozen forever. A commit pushed to it *after* the
breaker tripped is new information — usually the manual intervention the
problematic comment asks for — so `identifyPRWork` grants a fresh attempt
budget for it (`maybeGrantNewCommitAttempt` in `src/agents/ci-fixer.ts`).

State lives in the `ci_fixer_breaker` table, keyed `(repo, item_number)`:

- `tripped_sha` — the head SHA when the breaker tripped
  (`recordCIFixerBreakerTrip`, called from `triggerCircuitBreaker`).
- `last_claws_sha` — the head SHA of the most recent push Claws made to the
  branch (`recordCIFixerPush`). **The critical guard**: the ci-fixer pushes
  commits itself, so "the head moved" alone is not evidence of manual
  intervention. Every ci-fixer push goes through the `pushPRBranch` helper, and
  the problematic-PR diagnoser and review-addresser record their own pushes too
  (pr-dispatcher does not skip problematic PRs for review rounds, so the
  addresser can legitimately push to one). Missing a push site would let a
  Claws-authored commit reset its own budget — an unbounded retry loop.
- `budget_floor_at` — a timestamp floor passed to `countCIFixerAttempts` as its
  optional fourth argument, so attempts made before a grant stop counting
  toward `maxAttempts`. The budget *resets* per new commit rather than
  disappearing.
- `grants` — lifetime count of automatic grants, capped at `maxCommitGrants`.

A grant fires only when the current head differs from both `tripped_sha` and
`last_claws_sha`, and checks for that head are no longer `pending`. A status of
`none` is only believed once the head commit clears the settle window
(`haveChecksSettled` in `src/github.ts`, shared with the auto-merger) — CI takes
a minute or two to register runs against a fresh SHA, and reading that gap as
"green" would clear the label before anything ran (#2354). If the new
head is green the label is cleared and `grants` resets to 0; if it is still
failing the label is cleared, one grant is spent, and the PR re-enters the
normal fix flow bounded by the usual thresholds.

A PR with no `tripped_sha` (label applied by a human, or by a build predating
this table) stays frozen — fail-closed. Both the manual unmark endpoint and the
diagnoser's label removals call `resetCIFixerBreakerGrants`, which clears the
trip, zeroes `grants` and advances the budget floor; without that floor the
pre-existing attempts still inside the 24h window re-trip the breaker on the
very next sweep.

Every one of those state writes happens **after** `removeLabel` confirms the
label is gone, never before. `removeLabel` returns a boolean: `gh issue edit
--remove-label` errors both when the label was never applied (benign) and on a
transient API failure (not benign), so on error it re-reads the live labels to
tell the two apart. Committing the state write against a label GitHub still
shows would leave the breaker looking untripped while the PR stays labelled —
and since `maybeGrantNewCommitAttempt` only runs for PRs with a `tripped_sha`,
that combination freezes the PR permanently with no further grant possible.

Attempt counting is database-backed via `countCIFixerAttempts()` in `db.ts`,
which queries the `tasks` table for CI fixer attempts per PR within the
configurable window and returns `{ total, failed, successful, transientApiFailed }`
— transient API failures (4xx/5xx infrastructure errors) are counted separately
so they don't unfairly trip the circuit breaker. The `Claws Problematic` label
is applied to flagged PRs.

After the label is applied, `pr-dispatcher` enqueues a one-shot
**problematic-PR diagnosis pass** (`ci-fixer:problematic` kind →
`src/agents/problematic-pr-diagnoser.ts`). The diagnoser first checks whether
CI has already recovered before running any rounds: if `getFailedRunLog()`
returns empty, it calls `getFailingCheck()` and — if no check is failing —
calls `getPRCheckStatus()`; when the status is `"passing"` or `"none"`, it
immediately resolves as `success` and removes the label (CI recovered between
the label being applied and the diagnosis pass running — e.g. a flaky check
passed on retry, a transient infra failure cleared, or a manual fix landed).
The dedup guard that prevents re-running the diagnoser once a final report comment
exists (`DIAGNOSIS_COMMENT_MARKER`) now also clears the `Claws Problematic` label
before short-circuiting, via `clearStaleProblematicLabelIfGreen()` — this handles
the case where CI recovered on its own (flaky check passed on retry, transient infra
cleared, manual fix landed) after the diagnosis report was posted. Without this,
a PR that goes green post-diagnosis keeps the stale label forever because the marker
blocks every future diagnosis pass.

Both recovery checks additionally consult `hasBlockingConflict()`
(`getPRMergeableState() === "CONFLICTING"`, failing closed to `true` on an API
error so a transient failure never strips a label). Green CI alone is not
recovery: the breaker also trips on unresolvable merge conflicts, so clearing the
label on a green-but-conflicting PR would drop the label the breaker just applied
and hand the PR straight back to the conflict resolver. A round-1 pass that finds
green CI on a conflicting PR resolves as `no-fix-possible` instead — the label
stays and the report asks for a manual rebase.

Only when CI is genuinely still failing does the diagnoser run up to
`MAX_ROUNDS` (3) deeper-diagnosis rounds: each round invokes Claude with the
full failure-log + recent-error history and an explicit instruction to take a
more thorough approach (consider reverting earlier ci-fixer commits, merging
the base branch, etc.). When Claude produces commits the diagnoser pushes the
branch and polls CI for up to 30 min per round (`getPRHeadSHA` +
`getFailingCheck` + `getPRCheckStatus`). On success it removes the
`Claws Problematic` label so the PR re-enters the normal flow; on failure or
exhaustion it posts a single final report comment (marker:
`problematic-pr-diagnosis-report`) that the dedup guard uses to prevent
re-entry. Each round records its own task with `job_name = 'ci-fixer:problematic'`
so the round-by-round logs are visible at `/logs/issue?repo=...&number=...`.
Fork PRs and `[ci-unrelated]` fix PRs are skipped — the diagnoser can't push to
forks, and `[ci-unrelated]` PRs are already a downstream remediation path.

### CI-Fixer Two-Phase Design

The ci-fixer uses a two-phase identify/process pattern (matching the pattern
used by improvement-identifier and issue-refiner):

1. **Identify**: Scans all PRs, checks merge state, CI status, and classifies
   failures — collects typed `WorkItem` entries (a discriminated union with
   variants: `conflict`, `rerun`, `unrelated`, `fix`)
2. **Process**: Groups unrelated failures by repo (structural dedup — one
   consolidated issue per repo), then processes remaining items concurrently

This eliminates race conditions when multiple PRs in the same repo have
unrelated CI failures — without the grouping, concurrent `findIssueByExactTitle` +
`createIssue` calls would produce duplicate issues.

Reruns are emitted both for cancelled/startup-failure workflows and when
failure log fetching returns empty (the `getFailedRunLog` two-tier fallback —
CLI then REST API — both returned no output). Each no-log cycle is handled by
`handleMissingFailLog()`, which records a `ci-fixer` task failure with
`failureCategory: "logs-unavailable"`. This counts toward the circuit
breaker's `nonTransientFailed` counter (only `transient-api` rows are
excluded), so a PR whose logs are permanently unfetchable trips the breaker
after `maxConsecutiveFailures` cycles rather than looping indefinitely.
Benign "already running" errors (a harmless race condition where the workflow
restarted between detection and rerun) are caught and logged at info level
rather than reported as errors. Non-rerunnable workflows (`"cannot be rerun"`
from GitHub — e.g. runs older than 30 days) are logged at warn level and also
not reported as errors; these are expected terminal conditions, not Claws bugs.
`reportRunNotRerunnable()` (#2218) records the run ID in `deadRerunIds` (so
neither classification path — the cancelled-run branch nor the
logs-unavailable fallback — retries the same dead run every sweep), labels
the PR `Manual Action`, and writes a one-time notice into the PR body's
manual-action section asking a human to push a commit or close/reopen the PR
to get a fresh CI run; it deliberately does **not** file a standalone alert
issue — the label is already the durable, actionable signal auto-merger
honours, and a matching issue only duplicated it with no new information
(#2218, filed 7 times against one PR before the fix).

That label was, until #2462, permanently sticky: nothing ever removed it once
the dead run was superseded by a fresh one, so a PR that went green (a human
push, a Claws-authored fix commit, or a reopen) stayed stuck behind
`Manual Action` forever and auto-merger skipped it indefinitely
(`bstjohn-blog#581` — green at 02:22, still unmerged hours later). The mirror
function `clearNotRerunnableIfResolved()`, called once per PR per
`pr-dispatcher` sweep right alongside `reportRunNotRerunnable()`, clears it:
if the PR carries `Manual Action` **and** `gh.getPRCheckStatus()` reports
`"passing"` **and** the PR body still contains the
`claws:not-rerunnable-run` marker, it strips just that marked section from
the body via `stripNotRerunnableSection()`. `"none"` and `"pending"` check
status deliberately do not clear anything: nothing has re-tested the branch
yet, and clearing on those would unblock a merge on unverified code.

Green CI only retires *this function's own* reason for the label — the same
label carries other agents' reasons too, and only one of them is visible in
the body. If another manual-action section survives the strip (e.g.
issue-worker's own `MANUAL-ACTION:` note), or `hasEscalatedReview()` reports a
pr-reviewer escalation still outstanding (a blocking finding the implementer
refuted, or a review loop that never converged — labelled but recorded only
as a review comment, invisible to a body scan), the label stays; only the
stale not-rerunnable note is stripped. Only when neither other reason applies
does the function also remove `Manual Action` itself. Label removal happens
before the body rewrite (mirroring `maybeGrantNewCommitAttempt`'s ordering,
#2391) so a failed second call never leaves the PR blocked with nothing left
for the next sweep to re-detect.

**Missing `Actions: write` permission is not a dead run (#2514).** GitHub's
`403 Resource not accessible by integration` — the App installation lacks
`Actions: write` — used to be matched by the same `"cannot be rerun"`-adjacent
regex as a genuine per-run refusal, so a fleet-wide permission misconfiguration
mislabelled every affected PR `Manual Action` with a factually wrong
explanation and poisoned `deadRerunIds` so retries never resumed even after
the permission was granted. `isActionsPermissionDenied(err)` (all four rerun
call sites in `ci-fixer.ts`) now recognises this case separately:
`reportActionsPermissionDenied(fullName, runId)` files a single one-time
`[claws-config]` alert issue on `SELF_REPO` (an in-flight promise, stored
synchronously before the `await`, so two worker fibers hitting the org-wide
403 in the same sweep share one `ensureAlertIssue` call instead of racing to
file duplicates) and returns — the run is never added to `deadRerunIds`, the
PR is never labelled, and the next sweep retries automatically once an
operator grants the permission in the App's settings. `identifyPRWork`'s
GitHub-incident fast-path also now covers `isPreRepoStepFailure` (a job that
fails only in GitHub's own setup/checkout step, e.g. a codeload 429
downloading `actions/checkout`) in addition to `isInfrastructureOutage`
(zero recorded steps) — both are evidence of the incident, not a defect in
the diff, so neither spends fix-attempt budget while `isGitHubDegraded()` is
true.

**`[ci-unrelated]` fix PRs**: When ci-fixer processes a PR whose title
contains `[ci-unrelated]` (i.e., a PR created by issue-worker to fix a
`[ci-unrelated]` issue), it skips the classification step entirely and treats
all CI failures as related. Without this guard, the classifier would see the
pre-existing failures, classify them as "unrelated to the PR's changes", and
the PR would stall indefinitely in a loop of filing redundant issues and
reverting fix attempts. Errors on these PRs are posted as comments directly
on the PR rather than creating `[claws-error]` issues.

### No-Commit Feedback

When the implementer (issue-worker) runs but produces zero commits, it first
calls `diagnoseNoCommits(wtPath, baseBranch)` in `claude.ts` — a cheap Claude
invocation that inspects `git status`, `git log`, and `git diff --stat` to
produce a 1–3 sentence diagnosis (e.g. "implementation already appears complete",
"files were edited but not committed"). The diagnosis is injected as a
`**Diagnosis:**` block into the `## No changes produced` comment. If the
diagnostic call fails, the comment is posted without it (`.catch(() => null)`
guard). The comment is deduplicated per phase via a `no-commit:${currentPhase}`
plain-text marker — if a prior comment for the same phase already exists, no
new comment is posted. The `Refined` label is removed before the comment is
posted, preventing re-entry until the user explicitly retries.

### Multi-Phase Plan Validation

After a multi-phase plan's PR is merged, the issue-worker runs
`validateAndUpdatePlan()` which compares the completed phase's plan text
against the actual PR diff using Claude. If significant deviations are
found, the plan comment is updated in-place so subsequent phases have an
accurate picture of reality. The update is tracked via a
`plan-updated-after-phase:N` plain-text marker (deduplication —
each phase only triggers one update). Validation failures are caught and
logged but never block phase advancement.

**Phase overflow protection**: `currentPhase` is derived from the count of
merged PRs for the issue (`mergedPRs.length + 1`). If this exceeds
`totalPhases` (can occur after plan edits reduce phase count, or out-of-order
merges), `processIssue()` returns early and removes the `Refined` label —
allowing the planner to re-refine with an updated phase count.

**Owner requirement — not yet fully addressed.** #831 (a multi-PR issue that
stopped progressing) asked for more than drift detection: *"We shouldn't
rely on counting PRs. The plan should be reassessed in light of all PRs that
have been merged and any outstanding work should be identified. Counting PRs
is too simplistic."* `validateAndUpdatePlan()` above only compares one
just-merged phase's plan text to its diff; `currentPhase` selection itself
still is `mergedPRs.length + 1` — a count, not a holistic reassessment of
outstanding work across every merged PR. Treat the underlying ask as
partially open if a similar stall recurs.

All three
build helpers (`buildPrompt()`, `buildPRTitle()`, `buildPRBody()`) include
defensive bounds checks on `plan.phases[currentPhase - 1]` as a second guard.

### CI & Codebase Infrastructure Monitoring

The `runner-monitor` job runs independently. The remaining twelve scanners
(ubuntu-latest, concurrency, migration, main-build-monitor, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, gitignore, dependabot-config, design-guidelines, dynamic-workflow-runner) run sequentially via `scanner-dispatcher`:

- **runner-monitor**: SSHes to configured self-hosted GitHub Actions runner
  hosts on a 10-minute interval. Checks service health (restarts dead `svc.sh`
  services), detects zombie/stale Runner.Worker processes (kills orphaned
  processes older than 6 hours only if the runner service is down), and
  monitors disk usage with tiered cleanup: Tier 1 (>85%) runs basic cleanup
  (temp files, `docker system prune -f`, `docker image prune -af --filter 'until=24h'`
  to remove tagged CI images older than 24 hours, journal vacuum); Tier 2 (>90%) adds
  aggressive cleanup (all unused Docker images + volumes, tool cache). The
  `until=24h` filter keeps in-use images (active CI runs) safe while reclaiming
  tagged-but-old build cache images that `docker system prune` misses. After
  cleanup, if disk is still >90%, `getDiskBreakdown()` fetches a disk usage
  breakdown and either comments on an existing open `[runner-monitor] Persistent
  high disk` issue or creates a new one (label: `runner-maintenance`).
  `getDiskBreakdown()` uses sequential per-probe SSH calls (60s timeout each
  via the optional `timeoutMs` parameter of `sshExec`) instead of a single
  bundled command — probes include `df -h /`, `du -sh` per directory, top
  docker images by size, and `docker system df`; each probe is wrapped in its
  own `try/catch` so a slow probe does not abort the rest. Actions taken are
  reported via Slack. Runner hosts are configured with baked-in defaults
  (one Hetzner server, overridable via `runners` in `config.json`).
  Supports two runner flavours, selected by the presence of `serviceUnit`
  in the config entry: self-installed `svc.sh` runners (`actionsDir`) and
  NixOS `services.github-runners` systemd units (`serviceUnit` + `workDir` +
  `toolDir`) — see `docs/jobs/runner-monitor.md` for the full command/path
  mapping.
  **Security**: `actionsDir`/`workDir`/`toolDir` are validated against a
  safe-path regex (`/^\/[a-zA-Z0-9._/-]+$/`) and `serviceUnit` against
  `/^[a-zA-Z0-9@._-]+$/`, both in the Zod config schema and at runtime via
  `assertSafeRunnerPaths()` before any SSH command that interpolates them.
  This is defense-in-depth against the Zod schema being bypassed by the
  `safeParse` fallback path in config loading.
- **ubuntu-latest-scanner**: Daily scan of `.github/workflows/*.yml` files in
  all cloned repos. Detects `runs-on:` values matching known GitHub-hosted runner
  patterns (`ubuntu-*`, `windows-*`, `macos-*`) and creates a deduped alert issue in the
  offending repo with the `Priority` label. Skips commented-out lines and handles both direct string and
  array forms of `runs-on`. Custom self-hosted runner labels (e.g. `ryzen`,
  `arm64`) are not flagged — detection is positive-match only, not a
  `self-hosted`-string check. Expression syntax (`${{ matrix.os }}`) is **not**
  flagged — runtime expressions are indeterminate at static analysis time and
  flagging them unconditionally produces false positives. False positives are
  treated as worse than false negatives for this scanner.
- **concurrency-scanner**: Daily scan of `.github/workflows/*.yml` files in
  all cloned repos. Detects three classes of concurrency misconfiguration:
  (1) missing top-level `concurrency:` groups — only flagged when
  `workflowBenefitsFromConcurrency()` returns `true` (PR-relevant triggers:
  `pull_request`, `pull_request_target`, `merge_group`; or `push` to non-default
  branches — bare `push` or `push` with non-`{main,master}` branch filters;
  `schedule`, `workflow_run`, `release`, and other event-only workflows are
  not flagged because per-branch cancellation provides no value there); also
  suppressed if any job uses dynamic concurrency (e.g., Vercel preview
  deployments with per-deployment groups, indicated by `${{ }}` in a job-level
  concurrency key), (2) job-level concurrency groups using static names (no
  `${{ github.ref }}` interpolation) **only** when `cancel-in-progress: true`
  (intentional serialization with `cancel-in-progress: false` is not flagged),
  and (3) `deployment_status`-triggered workflows using `${{ github.ref }}` in
  concurrency groups — `github.ref` always resolves to the default branch for
  deployment events, creating a global mutex across all PRs. Creates a deduped
  alert issue per repo with recommended fixes and the `Priority` label.
- **migration-scanner**: Daily scan of all cloned repos for directories
  containing incrementally-numbered migration files (e.g. `001_create_users.sql`).
  Detects migration directories via common paths (`migrations/`,
  `db/migrations/`, etc.) plus a shallow recursive scan (up to 4 levels deep)
  for any directory named `migrations`. Files with numeric prefixes of 6 or
  fewer digits are classified as incremental; 8+ digit prefixes that
  resemble dates or 10+ digit prefixes that resemble Unix timestamps are
  classified as date-based. If any date-based file exists in a directory
  (even alongside incremental files), the directory is considered
  mid-transition and is not flagged. Creates a deduped alert issue per repo
  with the `Priority` label, a table of violations, and recommended convention: `YYYYMMDDHHMMSS_description.ext`
  filenames, directory scanning (no barrel file), `schema_migrations` table
  for tracking, and out-of-order application support.
- **main-build-monitor-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Identifies workflows that run automatically against the
  `main` branch: push-triggered builds (handling inline `on: push`, array, and
  block forms, including `branches:` and `branches-ignore:` filters) **and**
  `schedule`-triggered workflows (which always execute against the default
  branch). `workflow_dispatch`-only workflows are excluded — those are
  human-initiated and observed by the operator. Checks whether a dedicated
  `notify-failures.yml`-style workflow exists with a `workflow_run:` trigger
  whose `workflows:` list covers every monitored workflow AND which creates a
  GitHub issue on failure (detected by the presence of `gh issue create` and
  `failure` in the file body). If any monitored workflow is unmonitored, files
  a deduped alert issue with the `Priority` label. When no monitor workflow
  exists at all, the issue body includes a recommended `notify-failures.yml`
  template (patterned after the production-infra example) listing all
  monitored workflows in the `on.workflow_run.workflows` list. When a partial
  monitor exists, prompts the implementer to extend its `workflows:` list.
  Skips repos with no push-to-main or scheduled workflows entirely to avoid noise.
  Detects a monitor workflow structurally — a `workflow_run:`-triggered
  workflow whose body is gated on a failed conclusion (`FAILURE_GATE_RE`,
  tolerant of folded YAML scalars and either `conclusion`/`failure` ordering)
  — rather than string-matching `gh issue create`, since some monitors report
  failures via a sourced shell helper, `github-script`, or a marketplace
  action (production-infra#1036 false positive, #2154). The recommended
  template it emits uses `runs-on: [self-hosted, linux]`, not a bare
  `self-hosted` label, so it doesn't itself trip `runner-os-scanner`.
- **cache-on-self-hosted-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Identifies jobs whose `runs-on` is a self-hosted runner
  and flags any cache-related step uses inside those jobs (`actions/cache`,
  `setup-*` actions with cache options). Self-hosted runners persist their
  workspace and caches between runs, making these steps redundant. Creates a
  deduped alert issue per repo with the `Priority` label. Uses `workflow-parser.ts`
  `JobInfo.steps` to inspect step `uses` fields and `StepInfo.with` for cache
  configuration keys. **Owner rationale (#2329, #2331)**: this is not only
  storage-quota waste — a `cache: npm`-style step on a self-hosted runner was
  the trigger event in the incident chain behind [runner-monitor](jobs/runner-monitor.md)'s
  job-in-progress cleanup guard (#2327): the multi-GB cache write filled
  `hetzner-beefy-actions` past the tier-1 threshold, runner-monitor's disk
  cleanup fired mid-restore, and wiped the live job's `_work/_temp` — failing
  that job *and* an unrelated repo's job on the same host with unrelated-looking
  errors (`ENOENT … cache.tzst`, a missing `set_output` file-command file).
  `claws`'s own `ci.yml` was itself a repeat offender here (6.58 GB of cache
  against the org's shared 2 GB quota, all from one `actions/setup-node`
  `cache: npm` step) before the full nix-devShell migration removed
  `actions/setup-node` — and its cache step — from `claws` entirely.
- **issue-comment-spam-scanner**: Daily scan of `.github/workflows/*.yml` files
  in all cloned repos. Detects workflows that create new issues for failures
  (`gh issue create`) and then post new comments on recurrence (`gh issue comment`)
  — this produces comment spam in alert issues. The scan uses raw text matching:
  flags files that contain both `gh issue create` and `gh issue comment` but do NOT
  already contain `gh issue edit`, `**Occurrences:**`, or `**First seen:**` (already
  migrated). Files where the only `gh issue comment` usage is within a `close --comment`
  invocation are not flagged. Creates a deduped alert issue per repo with a
  recommended fix (`gh issue view` + `awk` body-edit + `gh issue edit` pattern).
- **runner-os-scanner**: Daily scan of `.github/workflows/*.yml` files in all
  cloned repos. Flags jobs whose `runs-on` contains `self-hosted` but no OS label
  (`linux` or `macos`, case-insensitive). Jobs using dynamic expressions (`${{ … }}`)
  or custom non-`self-hosted` labels are not flagged. Creates a deduped alert issue
  per repo with the `Priority` label. Issue title: `Alert: self-hosted runner jobs
  missing OS label`. Uses `workflow-parser.ts` `JobInfo.runsOn` to inspect runner labels.
- **claude-config-scanner**: Daily scan of all cloned repos. Checks each repo for four
  required files: `CLAUDE.md` at the repo root, `.claude/agents/issue-refiner.md`,
  `.claude/agents/issue-implementer.md`, and `.claude/agents/pr-reviewer.md`. These are
  the minimum Claude agent configuration Claws needs to delegate issue refinement,
  implementation, and pull request review to repo-tailored subagents. If any are missing,
  files a combined alert issue per repo listing only the absent files as an actionable
  checklist. Uses `fs.existsSync` for each check (symlinks are acceptable). Alert title:
  `Alert: missing Claude agent configuration`.
- **gitignore-scanner**: Daily scan of all cloned repos. Checks whether `.mcp-claws.json`
  appears as its own line in `.gitignore` (treating a missing `.gitignore` as equivalent to
  an empty one). Files an **unlabeled** chore issue per repo with issue title
  `chore: add .mcp-claws.json to .gitignore` when the entry is absent. Uses
  `ScannerSpec` without a `label` field (the only scanner that does so — all others use the
  `Priority` label). Extracted from `repo-standards.ts` (#1453) to follow the standard
  `ScannerSpec`/`runRepoScanner` pattern.
- **dependabot-config-scanner**: Daily scan of all cloned repos. Walks each repo (max depth 3)
  for dependency manifests, mapping them to Dependabot `package-ecosystem` values, and compares
  them against `.github/dependabot.yml` as **(ecosystem, directory) pairs** — not by ecosystem
  alone, so a separate project like `bonkus`'s `apps/mobile` is not masked by a root-only entry.
  npm directories are anchored on lockfile presence, which drops workspace members covered by a
  root lockfile (emitting entries for those yields a config Dependabot errors on). Repos with no
  manifests, a Renovate config, or a committed `.claws/dependency-updates-optout` are left alone;
  an unparseable `dependabot.yml` logs a warning rather than filing an alert. Files a `Priority`
  issue containing the exact YAML to add, which the normal issue pipeline turns into the PR.
  Alert title: `Alert: missing dependency-update configuration`. Note Dependabot *alerts* are an
  org default needing no config — *version updates* are what this file enables. See
  [docs/jobs/dependabot-config-scanner.md](jobs/dependabot-config-scanner.md).
- **design-guidelines-scanner**: Daily scan of all cloned repos. Walks each repo (max depth 3,
  skipping `docs`/`.github` along with the standard vendor/build dirs) collecting UI evidence:
  framework dependencies (react, vue, svelte, next, tailwindcss, astro, solid-js, preact,
  @angular/core) parsed from each `package.json`, and up to 5 example paths with a UI file
  extension (`.html`, `.css`, `.scss`, `.sass`, `.less`, `.tsx`, `.jsx`, `.vue`, `.svelte`,
  `.astro`). A repo is judged to "have a UI" if any framework dependency matched, or at least 3
  UI files matched — the ≥3 threshold plus the `docs`/`.github` exclusion keep a stray
  `docs/coverage.html` in a backend repo from tripping it. Repos with a UI but none of
  `docs/DESIGN.md`, `DESIGN.md`, `docs/design-system.md`, `docs/DESIGN-SYSTEM.md`,
  `docs/design.md`, `.claude/rules/frontend.md`, `.claude/rules/design.md`, or a
  design/frontend/styling heading in `CLAUDE.md` get an **unlabeled** chore issue with a starter
  `docs/DESIGN.md` template. Opt out per-repo via the `design-guidelines-scanner` job-disable
  config rather than closing the issue — `runRepoScanner` only dedupes against *open* issues, so
  a closed-as-won't-do issue is re-filed on the next daily run. Issue title:
  `chore: add frontend design guidelines (docs/DESIGN.md)`.
- **dynamic-workflow-runner-scanner**: Daily scan via the GitHub API, not the filesystem.
  Detects the same self-hosted-only violation as `ubuntu-latest-scanner` but for **dynamic
  workflows** — GitHub-generated jobs with no workflow file in the tree (Dependabot's updater,
  CodeQL default setup) — which the file-based scanner structurally cannot see. Fetches each
  repo's dynamic workflow runs, keeps only the latest run per distinct path, and inspects each
  job's runner identity (`runnerGroupName === "GitHub Actions"` or a label matching
  `^(ubuntu-|windows-|macos-)`). Files a `Priority` alert whose body states the exact remedy for
  Dependabot's updater specifically: its runner is an org-wide setting (Org Settings → Security →
  Advanced Security → Global settings → Dependabot → Runner label), not a per-repo one, so the
  scanner reports rather than attempting a per-repo fix. Issue title: `Alert: dynamic workflows
  are running on GitHub-hosted runners`. See
  [docs/jobs/dynamic-workflow-runner-scanner.md](jobs/dynamic-workflow-runner-scanner.md).
- **k3s-monitor**: Runs every 15 minutes. Uses `kubectl get pods/nodes` to detect
  failing pods and unhealthy nodes in the k3s cluster, and additionally fetches
  Flux `Kustomization` and `HelmRelease` resources (best-effort — Flux may not
  be installed) to detect reconciliation failures. When a `kubectl` call fails
  with a stale-kubeconfig error (unreachable endpoint, expired cert, etc.) and
  `kubeconfigRefresh` is configured, the monitor calls `refreshKubeconfig()` from
  `kubeconfig-refresh.ts` to fetch a fresh kubeconfig from the remote host via
  SSH before retrying — this handles cluster rebuilds that change the endpoint or CA. Both Flux resource kinds share
  the same detection logic: `DependencyNotReady` resources are suppressed
  entirely (checked first) — these are always cascade noise: the named
  dependency raises its own alert if genuinely stuck, and the dependent
  self-heals within one Flux `retryInterval` if merely mid-reconcile. This
  suppression applies to both Kustomizations and HelmReleases on both clusters
  (prod-k8s-monitor reuses the same `detectFluxAlerts` function). A
  `Ready=False`/`Unknown` condition then triggers an alert after a 2-minute
  grace period (to ride out transient reconciliation hiccups), **except**
  reasons in `TERMINAL_FLUX_FAILURE_REASONS` (currently just
  `HealthCheckFailed`), which bypass the grace period since they represent a
  *concluded* failure — a Kustomization with `wait: true` health-checking a
  Failed Job fails fast every `retryInterval`, flapping `Ready`
  `False→Unknown→False` and refreshing `lastTransitionTime` on each flip,
  which previously kept the condition permanently inside the grace window and
  suppressed a 6-hour prod chain wedge with zero alerts (#1989, #1990).
  All new alert issues are created with the `Priority` label so they are fast-tracked
  through the Claws issue pipeline (issue-worker propagates the label to its fix PRs).
  A newly created alert also fires an immediate Slack notification naming it a
  `:rotating_light:` **Priority alert** and linking the issue URL, so an operator can act
  without first working out which issue the ping refers to (#2088 — the previous
  `New alert: <title>` text carried no link and read like a routine pod restart). Recurrences
  stay silent: only the `created` outcome notifies, or every 15-minute tick would spam.
  All alerts are raised as issues in `FLEET_INFRA_REPO`. On recurrence, updates
  the existing issue body with occurrence tracking (`**First seen:**` /
  `**Last seen:**` / `**Occurrences:**` appended as a `---`-separated block at
  the end of the body) rather than posting repeated comments. Retroactively adds
  tracking to pre-existing issues that lack it. Can be disabled via
  `k3sMonitorEnabled: false` in config. **`kubectlExec` timeout errors** include
  the server URL extracted lazily from the kubeconfig file (via `extractKubeconfigServer()`,
  regex-based, no YAML parser) so timeout messages name the unreachable cluster endpoint
  rather than giving a generic error — the path itself is never logged. **Ignored-node
  suppression** is nuanced: node health alerts for ignored nodes are unconditionally suppressed
  (even when `NotReady`); pod alerts for pods on ignored nodes are suppressed
  only while that node is actually `NotReady` — when the node is `Ready`, pod
  failures on it are reported normally. If the node-status fetch fails, the
  monitor conservatively treats all ignored nodes as down (fallback to full
  suppression). **Pod alert dedup keys** are derived by `workloadNameForPod()`
  using `metadata.ownerReferences` when present: Job pods use the Job name
  with a trailing 7–12 digit numeric suffix stripped (CronJob-created Jobs are
  named `<cronjob>-<scheduled-time-in-minutes>`, e.g. `forgejo-backup-29762010`
  — without stripping that suffix, every scheduled run filed a separate issue
  instead of updating one; minutes-since-epoch is 8 digits today and hand-named
  one-off Jobs don't hit that length, so short suffixes like `backup-2024`
  survive; PR #2296, fleet-infra `forgejo-backup`/`immich-db-backup` CronJobs),
  ReplicaSet pods strip the trailing pod-template-hash to recover the
  Deployment name, StatefulSet/DaemonSet pods use the owner name directly.
  This is robust to all-alpha (digit-free) pod-template hashes that the
  legacy `podWorkloadName()` regex-strip missed, which previously caused
  duplicate pod-failure issues for the same workload.
  `podWorkloadName()` remains as the fallback for bare pods with no controller
  owner.
  The failure reason is deliberately **not** part of a pod alert title —
  `podAlertTitle()` yields `[k3s] Workload failing: <ns>/<workload>` and the
  reason lives in the body, which `ensureAlertIssue`'s `refreshBody` option
  rewrites on every update. Keying on the reason meant one broken workload filed
  up to four issues as it transitioned Failed → CrashLoopBackOff → OOMKilled
  (issue #2298, fleet-infra #713/#714 vs #730/#731). Pre-rename titles are
  enumerated by `legacyPodAlertTitles()` and renamed onto the new key on first
  match — an explicit reason allow-list, never a `[k3s] *: ns/name` wildcard,
  which would also match `[k3s] Flux Kustomization NotReady: ns/name`.
  **Same-run dedup**: `dedupeAlertsByTitle(alerts)` collapses entries sharing the same title to a single alert. Without this, workloads with multiple failing pod replicas (e.g. a Kubernetes Job) would produce N identical-titled alerts in one monitor run — each calling `ensureAlertIssue`, which uses GitHub's search index and cannot see an issue created milliseconds earlier in the same run, causing N duplicate issues. On a collision it keeps the first alert *unless* a later one carries a `podRef` and the stored one does not — with workload-keyed titles a workload's `Pod Failed` alert (no `podRef`) collides with its `CrashLoopBackOff` alert (`podRef` → log enrichment), and plain first-wins would systematically drop the log-bearing one; result order stays stable. Pod alerts are deduped *before* the 10-per-run cap, so one noisy workload can't crowd out every other workload and the log-fetch loop doesn't fetch for collapsed duplicates. The status counters (`podAlertCount`, `nodeAlertCount`, `fluxAlertCount`) are read off the per-source arrays before the final combined dedup pass, so `podAlertCount` now counts distinct failing workloads rather than failing pods.
  See [k3s-monitor](jobs/k3s-monitor.md) for details.

### Docker on NixOS Runners

`docker run -v "$PWD":/path` silently mounts an **empty** directory on the
self-hosted NixOS runners: the workspace checkout lives on a bind mount that
is private to the runner service unit's own mount namespace, so the Docker
daemon (running outside that namespace) resolves the host path in *its* own
namespace instead and finds nothing there. This is the same failure class
that broke `bin-scraper#250` and later `release.yml`'s container-based
`node_modules` build (#2351, added by #2348/#2349 to link native modules —
`node-pty`, `better-sqlite3` — against Debian glibc instead of the nix
devShell's glibc, which the non-nix Ubuntu deploy host can't resolve). The
fix is always the same shape: stream files **in** with
`tar -cf - <paths> | docker run -i ... IMAGE bash -c 'tar -xf - -C /dest && ...'`
and copy results **out** with `docker cp <container>:/path ./local-path` —
never a bind mount. `docker cp` also has the side benefit of extracting
client-side, so the copied-out files come back owned by the runner user with
no `chown` step needed.

### GitHub Actions Concurrency & Runner Priorities

GitHub Actions has no native job priority system. The "higher priority waiting
request" cancellation message comes from GitHub's concurrency model, not from
any configurable priority setting. When multiple jobs share the same
concurrency group (e.g. `group: self-hosted-runner` without per-branch
scoping), only one runs at a time across all branches. With multiple open PRs,
jobs queue up and get cancelled by newer pushes — producing systemic CI
failures.

**A concurrency group is not a queue — it holds one running + one pending.**
When a third job enters the same group, GitHub silently cancels the older
*pending* job. `cancel-in-progress: false` does not prevent this: it only
protects the job that is already *running*. So a group shared by 3+
jobs/workflows that can be triggered by the same push deterministically
evicts one of them on every push — even a correctly per-ref-scoped group
like `self-hosted-runner-${{ github.ref }}`, which looks safe by the
cross-branch rule above.

The fix is to **never share one group across 3+ jobs or workflows that can
trigger together**. Give each workflow its own group (`ci-${{ github.ref }}`,
`e2e-${{ github.ref }}`, …) and let runner-level queueing handle capacity —
runners already serialize work; a concurrency group is the wrong tool for
rationing runner slots. Reach for a shared group only where mutual exclusion
is genuinely required (a single deploy target, a shared preview
environment), and then only between at most two participants; beyond that,
use a real lock rather than a concurrency group.

**Diagnosis hint (ci-fixer symptoms).** A check that is **cancelled ~2
seconds in with zero steps executed** is concurrency-group eviction, not a
runner failure, a flake, or a lost runner. Re-running it without fixing the
group just re-rolls the dice — the re-run rejoins the same group and can be
evicted again. ci-fixer's automatic reruns usually mask this, so it stays
invisible until GitHub refuses a rerun (`cannot be rerun` /
`Resource not accessible by integration`, which Claws surfaces as the
`claws:not-rerunnable-run` PR comment) and retries stop — the failure mode
that stalled `St-John-Software/namey` PR #1652. When triaging repeated
zero-step cancellations, read the workflow files' `concurrency:` keys before
touching the runner.

Claws mitigates this in several ways:

- **Concurrency groups in own workflows**: `ci.yml` uses
  `group: ci-${{ github.ref }}` (per-branch, cancel-in-progress) and
  `release.yml` uses `group: release` (never cancel — only triggers on main).
- **Throttled reruns in ci-fixer**: When 3+ PRs in the same repo have
  cancelled checks, ci-fixer throttles to 1 rerun per repo per cycle
  (prevents cascade while still making progress). Priority-labeled PRs
  are rerun first.
- **Priority-aware rerun ordering**: Reruns that pass bottleneck filtering are
  processed sequentially with a 2-second stagger. PRs with the `Priority`
  label are re-run first.
- **Concurrency scanner**: Daily scan detects misconfigured concurrency groups
  across all managed repos and files advisory issues with recommended fixes.

The `Priority` label affects Claws' internal Claude task queue and ci-fixer
rerun ordering, but cannot control GitHub's runner allocation.

### Image & Attachment Context

When processing issues or PR reviews, `images.ts` extracts embedded image
references and GitHub file attachments from the text, downloads them, and
appends prompt sections so Claude can view images and read attached files.
Images are saved into the worktree; text attachments are inlined in the
prompt. This is used by issue-refiner, issue-worker, and review-addresser.

### Parallel Repo Processing

Both `issue-dispatcher` and `pr-dispatcher` process repos concurrently using
`Promise.allSettled(repos.map(...))`. One failure in a repo does not block
others. The rate-limit circuit breaker check at the start of each repo callback
short-circuits only that repo — other repos proceed normally.

### Fast-Checks Guidance

`agent-context.ts` exports `FAST_CHECKS_GUIDANCE` (injected into issue-worker
and review-addresser prompts) and `CI_FIXER_FAST_CHECKS_GUIDANCE` (injected into
ci-fixer prompts). Both instruct Claude to prefer fast local checks (type-check,
lint, unit tests) and leave slow ones (integration tests, Docker, external
services) to CI, which is the source of truth for them. The ci-fixer variant
notes that CI reruns automatically on push rather than "after the PR is opened".

`RUNNER_POLICY_CONTEXT` (also in `agent-context.ts`) is injected into all three
issue-refiner prompt builders (fresh plan, refinement, follow-up), both
issue-worker prompt builders, and both pr-reviewer prompt builders
(`buildStandardReviewPrompt` and the per-file `filePrompt` for large PRs).
It instructs Claude not to suggest or add GitHub-hosted runners
(`ubuntu-latest`, `windows-latest`, `macos-latest`, etc.) — this organisation
uses only self-hosted runners due to cost, with no macOS exception. The
constant also instructs agents to always include an OS label when using
`self-hosted` runners (`[self-hosted, linux]` or `[self-hosted, macos]`),
mirroring the enforcement done by the `runner-os-scanner` detector. Together,
these constants apply the runner policy proactively at plan/implementation/review
time rather than reactively after a violation is committed.

### Documentation as Context

Issue-refiner, issue-worker, improvement-identifier,
idea-suggester, and triage-claws-errors prompts instruct Claude to read
`docs/OVERVIEW.md`
(and linked docs) before starting work. This gives Claude accumulated
architectural context about each repository.

### Client TypeScript Pipeline

Client-side JavaScript is authored as TypeScript in `src/client/*.ts` and
compiled/bundled by `scripts/build-client.mjs` (esbuild) into
`src/resources/*.generated.ts` constants. The pattern mirrors
`tailwind-css.generated.ts`: each generated file exports a string constant
containing an inline `<script>…</script>` block, which page builders
interpolate directly into HTML. `tsconfig.client.json` type-checks client
sources with DOM libs; the generated `.ts` files are excluded from the main
server `tsconfig.json`. The `npm run build:client` script type-checks then
bundles; `npm run build` runs `build:client` first. Generated files are
checked into the repo so CI and production require no extra build step beyond
`npm run build`.

### Prompt Resource Injection

The idea-suggester's `buildPrompt()` accepts a `resources` parameter for
injecting reference material into prompts. Currently used to provide
marketing strategy knowledge (from `src/resources/marketing.ts`, sourced
from the Marketing-for-Founders repository) so Claude considers marketing
tactics when suggesting ideas. The resource is inlined as a TypeScript string
constant to avoid runtime file I/O and build-path issues.

Frontend guidance is injected into every prompt built by `issue-worker.ts`,
`issue-refiner.ts`, and `review-addresser.ts`, but which version gets injected is
decided per worktree by `frontendContext(wtPath)` (`src/agents/agent-context.ts`)
— progressive disclosure rather than a fixed block. It checks `docs/DESIGN.md`,
`DESIGN.md`, then `.claude/rules/frontend.md` under the worktree; if one exists,
the prompt gets a one-line pointer naming that path as authoritative. Only when
the repo has no design doc at all does it fall back to the exported
`FRONTEND_AESTHETICS_CONTEXT` — the full anti-slop block (distinctive typeface,
one palette as custom properties, layered background, motion behind a
`prefers-reduced-motion` guard), which also tells the agent to write its invented
choices into `docs/DESIGN.md` so the repo converges after one UI ticket. Both
versions self-gate ("only if this task touches user-facing HTML/CSS/UI"), like
`RUNNER_POLICY_CONTEXT`. A nonexistent worktree path simply yields the fallback.
The `design-guidelines-scanner` job is the other half of this: it files the issue
that gets a repo's first `docs/DESIGN.md` written in the first place.

### Branch Naming

| Agent / Job | Pattern |
|-----------------|---------|
| planner (issue-refiner) | `claws/plan-<N>-<hex4>` |
| implementer (issue-worker) | `claws/issue-<N>-<hex4>` |
| ci-fixer / review-addresser | Uses existing PR branch |
| triage-claws-errors | `claws/investigate-error-<N>-<hex4>` |
| doc-maintainer | `claws/docs-<YYYYMMDD>-<hex4>` |
| improvement-identifier | `claws/improve-<hex4>` (analysis worktree only; no PR is opened) |
| idea-suggester | `claws/ideas-<hex4>` |

### PR Title Conventions

- `fix: resolve #N — <title>` — single-PR issue implementations
- `fix(#N): <phase title> (X/Y)` — multi-PR issue phases
- `docs: update documentation for <repo>` — doc maintenance

### Issue Title Conventions (Claws-created)

- `security: <title>` — security finding raised by improvement-identifier (one issue per finding; deduped by title prefix)
- `<title>` (raw) — improvement finding filed by improvement-identifier (one issue per finding; no prefix added)
- `Alert: self-hosted runner jobs missing OS label` — runner-os-scanner alert
- `[runner-monitor] Persistent high disk` — runner-monitor disk alert
- `[claws-error] <fingerprint>` — internal Claws error reports
- `[disallowed-actor] @<login> is blocked from Claws automation` — filed in `SELF_REPO` when the issue-dispatcher skips an issue whose author is not in `ALLOWED_ACTORS` (and is not a CI failure alert); one issue per actor, occurrence-tracked so the body is updated rather than new comments posted

### Duplicate PR Guards

PR-creating jobs check for existing open PRs before creating new ones to
prevent pile-up when previous PRs haven't been merged:

- **doc-maintainer**: Skips if an open `claws/docs-*` PR exists
- **improvement-identifier**: Skips analysis entirely if both an open `security: ` issue and an open `claws/improve-*` PR exist (legacy guard; no longer triggered since improvement PRs are no longer opened). Skips security filing if any `security: ` issue is open. Skips improvement issue filing if security findings were filed this tick
- **idea-suggester**: Before filing each idea, looks it up with
  `findIssueByExactTitle()` against the repo's open issues and skips it if a
  matching title is already open. Filing is sequential so `createIssue`'s
  cache invalidation makes each lookup see the issues filed earlier in the
  same run
- **ci-fixer**: Uses consolidated per-repo `[ci-unrelated]` issues rather
  than per-fingerprint issues, so all unrelated CI failures for a repo
  are tracked in a single issue. Within that issue, `fileUnrelatedIssue()`
  further dedups at comment granularity via an in-memory
  `reportedUnrelatedOccurrences` set keyed by `unrelatedOccurrenceKey()` — the
  failing run's ID parsed out of its run URL, or a `pr+fingerprint` fallback
  when the URL carries none — so a run that's still failing across several
  ~5-minute dispatcher sweeps gets exactly one comment instead of a fresh one
  per sweep (bin-scraper#250: 5 comments for one run in 16 minutes, #2338).
  Same in-memory trade-off as `deadRerunIds` above: a process restart costs at
  most one extra duplicate comment per run, not unbounded reposting

### Merge Button Visibility

Never gate the dashboard's Squash & Merge button behind label/CI-state
heuristics (e.g. "only when `Ready` is applied" or "only when CI is green") —
surface all relevant signals (labels, CI/pipeline status, infra-path warnings)
beside each PR instead and let the human operator decide, because per-criteria
gating is fragile and hides information the operator needs to judge
mergeability themselves (#1204). `src/pages/queue.ts` hides the button only for
a hard GitHub-reported blocker (`item.mergeableState === "CONFLICTING"`).

### Item Skip & Prioritize

Individual issues/PRs can be skipped or prioritized via `skippedItems` and
`prioritizedItems` in `config.json` (arrays of `{repo, number}`), or via
the dashboard queue page buttons (`POST /queue/skip`, `/queue/prioritize`).
Skipped items are excluded from all job processing via `isItemSkipped()`.
Prioritized items are processed before others in job queues via
`isItemPrioritized()`. Both lists are hot-reloadable.

### Per-Repo Job Disabling

Individual jobs can be disabled for specific repos via `disabledJobsByRepo` in
`config.json` (a `Record<string, string[]>` mapping repo full names to arrays
of job names) or via the `/jobs` matrix page in the dashboard. The matrix UI
shows repos on one axis and jobs on the other with checkboxes. Changes are
written to `config.json` and hot-reloaded. `isJobDisabledForRepo(jobName,
repoFullName)` is called in each job's `run()` function to filter out disabled
repos before processing. For example, `ci-fixer` can be disabled per-repo this
way to suppress automated CI fix attempts on repos where manual intervention is
preferred.

**Opt-in jobs** (`OPT_IN_JOB_NAMES`): some jobs are disabled by default for all
repos and require explicit opt-in via `enabledJobsByRepo` in `config.json`. Currently
`main-build-monitor-scanner` is the only opt-in job — it is suppressed unless a repo
explicitly lists it in `enabledJobsByRepo[repoFullName]`. `isJobDisabledForRepo()`
handles both lists: a job is disabled if it appears in `disabledJobsByRepo` for the
repo, or if it is in `OPT_IN_JOB_NAMES` and the repo is not in `enabledJobsByRepo`.

### Job Pause/Resume

Individual jobs can be paused and resumed via the dashboard (`POST /pause/:job`)
or pre-configured via `pausedJobs` in `config.json`. Paused jobs skip their
scheduled ticks but can still be triggered manually.

### Disabled Agents

Agents within `issue-dispatcher` and `pr-dispatcher` can be individually disabled
via `disabledAgents` in `config.json` (array of agent names) or via the config
page checkboxes. Valid agent names: `planner`, `implementer`, `ci-fixer`,
`review-addresser`, `reviewer`, `merger`. A disabled agent's phase is silently
skipped — the parent agent job still runs and processes other phases. Legacy
`pausedJobs` entries for the old job names are automatically migrated to
`disabledAgents` on config load.

### Push Branch Concurrency

`pushBranch()` in `claude.ts` uses a fetch-rebase-push retry loop (up to 3
attempts) to handle concurrent pushes to the same PR branch. The initial
`git fetch` uses an explicit refspec (`refs/heads/${branchName}:refs/remotes/origin/${branchName}`)
rather than passing `branchName` bare — `branchName` is `pr.headRefName`, an
attacker-controlled GitHub value (a PR author can name their branch e.g.
`--upload-pack=...`), and `execFile` runs `git` without a shell so this isn't
shell injection but is git **option injection**: a bare argument starting
with `-` is parsed by git as a flag rather than a ref name. Prefixing with
the literal `refs/heads/` makes the token unparseable as an option (#1861).
When multiple jobs operate on the same branch (e.g. review-addresser and ci-fixer),
non-fast-forward rejections are resolved by fetching the latest remote state,
rebasing local commits on top (using `--rebase-merges` to preserve merge
commit topology), and retrying. The `--rebase-merges` flag is critical when
ci-fixer's `resolveConflicts()` creates merge commits — without it, plain
rebase would decompose merge commits into individual constituent commits,
causing conflicts. For new branches (where fetch fails because the branch
doesn't exist on the remote yet), rebase is skipped and push proceeds
directly. When a rebase conflict occurs, `pushBranch` falls back to merging
the remote branch — this handles the common case where both sides
incorporated the same upstream changes via different merge paths. If the
merge also conflicts, the operation aborts with a `PushConflictError` — a named error class that the error reporter suppresses (logs at warn, does not create a `[claws-error]` issue) since this is a transient race resolved by the next dispatcher cycle.

As a defense-in-depth measure, the pr-dispatcher skips review-addresser
for PRs with active ci-fixer work in the same cycle. During Phase 1
(identification), the dispatcher collects PR numbers that have `fix` or
`conflict` ci-fixer tasks. Phase 3 (review-addresser) skips those PRs
with a `continue` guard — they are picked up on the next cycle (~60s
later). This prevents concurrent pushes to the same branch. The
dispatcher also skips CONFLICTING PRs in the review-addresser phase,
since ci-fixer handles conflict resolution.

### Commit Tag

Doc-maintainer commits include `[doc-maintainer]` in the message. This is used
by `getLastDocMaintainerSha()` to detect whether docs are already up-to-date.

### Per-Item Timeout Escalation

When a Claude process times out on a specific issue/PR, the
`timeout-handler.ts` module:

1. Counts recent timeouts for that item (2-hour sliding window via
   `db.countRecentTimeouts()`)
2. If fewer than 3 timeouts: escalates the per-item timeout by 1.5x (capped
   at 6 hours), persisted in `itemTimeoutOverrides` config
3. If 3+ timeouts: auto-skips the item via `gh.skipItem()` (adds to
   `skippedItems` config and removes from queue cache)
4. Posts a comment on the source issue/PR via `reportTimeoutOnItem()` with
   timeout count, escalation details, and skip status

Jobs call `getItemTimeoutMs()` before invoking Claude to retrieve any
per-item override. `getItemTimeoutMs()` applies a floor at the global
`CLAUDE_TIMEOUT_MS` default — legacy overrides from previous lower-default
eras are silently ignored so items aren't cut short. All jobs that invoke
Claude must use both `getItemTimeoutMs()` (before invocation) and
`handleTimeoutIfApplicable()` (in error handlers) for consistent timeout
tracking and escalation.

### Plain-Text Markers (No HTML Comments)

Claws does not use HTML comments (`<!-- ... -->`) as machine-readable markers.
All structured markers in GitHub comments and PR bodies are plain text:

- `review-addressed: <SHA>` — review-addresser marks addressed feedback (backward-compatible regex handles legacy HTML-comment form in old comments)
- `Reviewed commit: \`<SHA>\`` — pr-reviewer records the last-reviewed commit
- `recommended-model: sonnet` / `recommended-model: opus` — pr-reviewer's model hint
- `review-provider: openrouter` / `review-provider: claude` — legacy marker from a previous OpenRouter routing experiment; no longer written but still parsed for backward compatibility (strips the marker from displayed comment text)
- `plan-updated-after-phase:N` — plan-parser deduplication marker
- `no-commit:<phase>` — dedup marker in issue-worker no-commit feedback (one per phase; `no-commits-warning` global marker removed in #851)
- `CLAWS_PLAN_OCCURRENCES: N` — appended to every plan comment by issue-refiner, recording the `**Occurrences:**` count from the issue body at planning time; parsed by `parsePlannedOccurrences()` and used by issue-dispatcher to trigger re-planning when recurrence count doubles
- `CLAWS_NO_CODE_CHANGES` — planner verdict emitted when the issue requires no file changes (purely operational task, fix already shipped, not actionable as code). `issue-refiner` posts the planner's explanation paragraph, then applies the `Claws Ignore` label to stop all further planner + implementer dispatch. The issue stays open so `ensureAlertIssue` can still find it by title on recurrence. Must appear on its own line; rejected if combined with a plan body or a `DUPLICATE_OF` verdict.
- `CLAWS_TRANSFER_TO: owner/repo` — planner verdict naming a same-owner repo the issue actually belongs to (see [Cross-repo issue transfer](#content-based-state-machine) above); parsed by `parseTransferTarget()` against the allowlisted candidate list to prevent hallucinated destinations.
- `CLAWS_TRANSFERRED_FROM: owner/repo#N` — stamped on the routing comment right before `gh.transferIssue()` is attempted; read back by `alreadyTransferredInto()` to cap transfers at one hop, comparing the stamped repo against the *current* repo so a failed transfer (stamp names the still-current repo) doesn't permanently block a retry.

Agent prompts include explicit instructions not to use HTML comments in output.

**Exception**: `ci-fixer.ts`'s `reportRunNotRerunnable()` delimits its not-rerunnable
note within the PR body's manual-action section with an HTML-comment marker pair
(`NOT_RERUNNABLE_MARKER`/`NOT_RERUNNABLE_END`, #2218) rather than a plain-text one.
Unlike the markers above — which are meant to stay visible as part of a
human-readable comment — this one exists purely so a later call can find and
replace its own note without disturbing another agent's manual-action text sharing
the same heading; rendering it invisible in GitHub's Markdown view is the point,
not a violation of the convention's rationale.

### Zod Runtime Validation

All external data entering the system is validated with Zod schemas rather than
cast with `as T`. The key surfaces:

- **`github.ts`** — `safeJsonParse<T>(schema, raw, context)` requires a Zod schema
  at every call site. It handles `gh` returning an empty string `""` for empty list
  results (e.g. `gh pr list` when no PRs exist) by falling back to `[]` before
  parsing. `ghJson<T>` forwards the schema. All `gh` output parsed this way: PR
  lists, issue lists, check status, reactions, labels, etc.
- **`server.ts`** — POST request bodies (`/queue/merge`, `/queue/skip`,
  `/queue/prioritize`, etc.) are parsed with Zod schemas. WebSocket messages
  (`input`/`resize`) use a `discriminatedUnion` schema.
- **`slack.ts`** — Slack API response shapes (`postMessage`, `getReactions`) are
  validated on receipt.
- **`mcp-server.ts`**, **`agents/ci-fixer.ts`**, **`github-app.ts`** — AI-extracted
  JSON and GitHub App API responses are validated.
- **`transcribe.ts`**, **`ollama-rate-limit-classifier.ts`** — External API responses
  validated before field access.
- **`jobs/whatsapp-handler.ts`**, **`jobs/improvement-identifier.ts`**,
  **`jobs/idea-suggester.ts`** — AI-extracted JSON outputs validated before use.
- **`config.ts`** — Config file parsing validated with a full schema (no
  `passthrough()` — schema surfaces unknown/cruft fields).

The rule: no `JSON.parse(...) as T` casts. Every parse site uses a Zod schema so
shape mismatches throw a `ZodError` with a readable message rather than producing
silent type-unsafe values.

### GitHub App Authentication

Claws requires GitHub App authentication for its own GitHub and git operations.
On startup, `ensureGitHubAppConfigured()` validates that either global
`githubAppId` + `githubAppPrivateKeyPath` are set with an existing key file, or
that `githubOwnerAppCredentials` includes at least one fully-resolvable per-owner
entry; otherwise startup fails. Per-owner credentials take priority and allow
different GitHub Apps for different organisations. All `gh` and `git` subprocess
invocations are passed short-lived installation tokens via env var injection
(`GH_TOKEN`, `GITHUB_TOKEN`). Tokens are minted per-owner via RS256 JWT →
GitHub API → installation access token, with a 10-minute expiry buffer.
Concurrent token refreshes for the same owner are deduplicated via a promise
cache. PRs and comments appear under the App bot identity.

Agents that operate in a repo worktree now receive a short-lived GitHub App
installation token as `GH_TOKEN`/`GITHUB_TOKEN` via `RunClaudeOptions.githubTokenOwner`,
minted in `runClaudeInner` and layered in by `runCliProcess` under the backend
env. This replaces an undocumented dependency on the host's ambient
`gh auth login` credential; a mint failure is `log.error`'d (Slack) and the
agent degrades to ambient auth rather than crashing.

The option is opt-in per call site, and the set of sites that opt in is a
security decision, not a mechanical sweep: an installation token is **owner-wide**,
not repo-scoped (#2246), so every site that receives one widens what a
prompt-injected agent could reach. Covered today are the agents that already act
on a repo under an explicit issue/PR mandate, where the token merely replaces the
ambient `gh auth login` credential they were already using: `issue-refiner`
(planning, refinement and follow-up passes), `issue-worker`, `ci-fixer`
(conflict, fix and revert passes), `review-addresser`, and `pr-reviewer`.
`src/claude.test.ts` asserts the per-file call-site counts, *and* asserts that no
other file under `src/agents/` or `src/jobs/` sets the option — so both a silent
omission and a silent widening fail the suite.

Not covered, by design:

- Calls that deny Bash, and therefore `gh`, outright — `issue-refiner`'s
  complexity classifier, `escalation-reviewer`, `email-monitor` and
  `whatsapp-handler` via `disallowedTools: TEXT_ONLY_DISALLOWED_TOOLS`, and
  `shopping-sourcer` via its own explicit deny list. A credential there would be
  pure attack surface with no caller able to use it.
- Closed-form text transforms with no repo mandate: `public-snapshot-sync`'s
  README-tailoring and commit-message passes.
- Calls whose cwd is not a repo checkout at all (`sessions.ts` on `$HOME`,
  `issue-worker`'s tmpdir summariser, `ci-fixer`'s `process.cwd()` triage).
- Worktree agents that read lower-trust or open-ended input and are *not*
  tool-stripped — `public-repo-scanner`, `improvement-identifier`,
  `idea-suggester`'s analysis pass, `doc-maintainer`, `triage-claws-errors`,
  `problematic-pr-diagnoser`, and `issue-refiner`'s step-back pass. These would
  work mechanically, but each needs its own risk analysis of what an owner-wide
  token in that context permits before it is granted one; widening to them is
  deliberately left to a follow-up change. They continue to use whatever
  ambient credential the host provides.

Known limitation:
installation tokens live 1 hour while agent timeouts run up to 6 hours — the
token is minted once, immediately before spawn, so a run whose first `gh` call
happens more than ~55 minutes in will get a 401 instead of silently degrading;
this is accepted rather than solved with a refresh mechanism, since planner/worker
runs are normally minutes long and an explicit 401 beats invisible degradation.

### Security Model

Because Claude runs with `--dangerously-skip-permissions`, all user-supplied
input paths must be guarded upstream. Six primary defenses:

- **Query param escaping**: The `/logs/issue` page escapes the `repo` query param through both `encodeURI()` and `escapeHtml()` (in that order) before interpolating it into an `href` attribute — preventing reflected XSS via a crafted `repo` value containing a double-quote. A repo-membership check (`listRepos()`) also gates the handler: unknown repos return 404 rather than rendering an empty page with the attacker-controlled value.
- **Configured-repo allowlist on dashboard mutation routes**: `isConfiguredRepo(repo)` in `server.ts` checks a client-supplied `repo` string against `listRepos()` and is applied to every dashboard route that mutates GitHub state or reads issue-scoped logs — `/queue/merge`, `/queue/mark-refined`, `/queue/mark-automerge`, `/queue/mark-problematic`, `/queue/unmark-problematic`, `/runners/cancel`, and `GET /logs/issue`. The GitHub App installation token these routes run under can reach every repo in the installation, which is typically broader than Claws' configured/managed repo set, so without this check a dashboard client could direct a mutation (merge, label) at a repo Claws doesn't manage (#2221). `/queue/skip`, `/queue/unskip`, `/queue/prioritize`, `/queue/deprioritize` are deliberately exempt — they only write local config (`skippedItems`/`prioritizedItems`) and never call GitHub, and gating them would block un-skipping an item whose repo was later removed from the managed list.
- **Repo-scoped installation tokens in image/attachment downloads**: GitHub App installation tokens are owner-wide, not repo-scoped, so `images.ts`'s `shouldAttachGitHubToken()` withholds the token whenever a URL found in issue/PR text (`extractRepoFromGitHubUrl()`) positively identifies an `owner/repo` that doesn't match the repo currently being processed — otherwise a comment in one repo could pull private content out of a sibling repo under the same installation (#2246). See the `images.ts` entry in [modules.md](modules.md) for the full mapping.
- **Fork PR filtering**: All PR-processing jobs (pr-reviewer, ci-fixer,
  auto-merger, review-addresser) skip fork PRs via `isForkPR()`
  (checks the `isCrossRepository` field). This prevents untrusted external
  contributors from injecting content that Claude would execute with full
  host access.
- **Allowed actor gating**: `isAllowedActor()` in `github.ts` checks whether
  a user is in the `ALLOWED_ACTORS` list or is the authenticated `gh` user.
  Applied at multiple layers:
  - **issue-dispatcher** gates on issue *author* in both Phase 1 (refined → implementer) and Phase 2 (fresh plan/refine → planner) — issues from non-allowed actors are logged and skipped; the dispatcher also Slack-notifies and files a tracked `[disallowed-actor] @<login> is blocked from Claws automation` issue in `SELF_REPO` (via `ensureAlertIssue`, one issue per actor with occurrence tracking; individual item dedup via `markUntrustedActorNotified` in `notified_untrusted_actors` DB table) so the operator can grant an `allowedActors` exception. One CI bot exception exists: `isCiAlertBotAuthor()` grants a full pass-through for any issue authored by the GitHub Actions runner bot (`github-actions[bot]` / `app/github-actions`) — any such issue is dispatched into the refine-and-fix pipeline regardless of title. Other bots (dependabot, etc.) are not covered and remain subject to the untrusted-actor path.
  - **issue-refiner** gates the auto-`Refined` label application for `[ci-unrelated]` issues on the issue author (defense-in-depth against escalation from untrusted actors).
  - **issue-refiner** also filters comments by actor — only comments from allowed actors trigger plan refinement or follow-up.
  - **triage jobs** check issue authors.
  For the self-repo (`SELF_REPO`), issue
  processing includes a collaborator check via the GitHub API. A
  `normalizeBotLogin()` helper normalizes both the incoming login and self-login
  before comparing: `gh` CLI returns GitHub App authors as `app/<slug>` in
  `--json author` output, while the REST `/app` endpoint returns `<slug>[bot]`.
  `normalizeBotLogin` converts `app/<slug>` → `<slug>[bot]` so comparisons
  work regardless of which API surface produced the login. `isAllowedActor`
  passes `SELF_REPO.split("/")[0]` to `getSelfLogin()` to ensure the correct
  App credentials are used (critical in multi-owner setups where different owners
  have different App slugs).
- **Injection-detection visibility**: `guardContent()` in `prompt-guard.ts` must
  never fail silently — a detected injection (score ≥ 10) is redacted before it
  reaches the model *and* posted back as a comment on the originating issue/PR
  (`formatInjectionComment()` / `postInjectionComment()`) quoting the matched
  pattern name, phrase, and offset, deduplicated per item via `POSTED_COMMENTS`
  (capped at 1000 keys with FIFO eviction, not a TTL — a TTL would let the same
  ⚠️ comment repost on the same item every time it's rescanned, exactly the
  spam `issue-comment-spam-scanner` exists to flag; #2291).
  A Slack-only or log-only alert is not sufficient — a human reviewing the item
  must be able to see what was flagged and why without cross-referencing Slack
  history (#1275).

### PR Review Comment Protocol

Every terminal code path in the pr-reviewer must leave a comment with the
standard `REVIEW_HEADER` (`## PR Review`) and a `Reviewed commit: \`SHA\``
marker (plain text). This invariant prevents infinite re-review loops — without
a commit marker, `hasNewCommitsSinceLastReview()` cannot determine whether
re-review is needed, causing the PR to be re-processed every cycle. Three terminal states:

1. **Empty diff** — posts "no net changes" comment with marker
2. **No issues found** — posts "Reviewed — no issues found" comment with marker, adds `Ready` label
3. **Issues found** — posts review feedback with marker (review-addresser auto-picks up)

On re-review (new commits since last review), the reviewer always posts a
new comment rather than editing the previous one. This preserves discussion
threads and approval signals on previous reviews. The dispatcher calls
`hasNewCommitsSinceLastReview(repo, prNumber)`, which internally finds the
latest review comment and compares its commit marker against the current
HEAD. If no new commits are found, the PR is skipped. If new commits exist
(or no prior review exists), `processPR(repo, pr)` is called to generate
and post a fresh review.

**Large PR diff handling**: The reviewer uses a two-phase diff strategy. Phase 1
attempts to fetch the full diff with a 200 MB buffer. If the buffer is exceeded
(or the diff exceeds 50,000 chars), Phase 2 switches to per-file mode: each
changed file is diffed individually; files larger than 20,000 chars receive a
dedicated Claude call with a structure-focused prompt (schema validity, format
consistency, field naming); smaller files are reviewed together in a single call
with the standard review prompt. Results from all segments are merged into one
`## PR Review` comment. The `generatePRDescription*` functions also use the
larger 200 MB buffer, truncating to 30,000 chars after fetch.

**Provider for PR reviews**: The pr-reviewer always uses Claude CLI with
`capability: "tool-use"` and `provider: "claude"` (#1879 — flipped from
`"text-only"` so the reviewer can verify git facts with real tool calls before
asserting them; see `REVIEW_VERIFICATION_CONTEXT` in `agent-context.ts`). A previous routing
mechanism (`resolveReviewDispatch()`) that dispatched to OpenRouter/Qwen for
smaller PRs was removed after review quality degraded. The `REVIEW_PROVIDER_PATTERN`
regex (`review-provider: (openrouter|claude)`) is retained in the code for
backward compatibility — existing comments with that marker are parsed to strip
the marker from displayed text. `isVagueReview()` validates reviewer output
before posting — comments with empty `Lines:` fields or missing required details
are suppressed entirely rather than posted as low-quality feedback.

**Dynamic context budgeting**: `buildReviewContext()` accepts an optional byte
budget (`contextBudgetBytes(diffBytes, reassessmentBytes)`) and passes it to
`loadRepoDocs()` to cap how much of `docs/OVERVIEW.md` is included. The budget
is derived from `REVIEW_MODEL_MAX_INPUT_TOKENS` (30,000) × `BYTES_PER_TOKEN`
(3.5) minus the diff and reassessment sizes — preventing over-large context
even with Claude's 200K window, keeping reviews focused.

### MCP Server Context

Claude sessions spawned by Claws can access operational state via the
built-in MCP server (`mcp-server.ts`). `writeClawsMcpConfig()` in `claude.ts`
generates an MCP config file that includes the Claws state server and
optionally additional MCP servers (e.g. Playwright for shopping-sourcer). The Claws MCP
server provides four core tools (`claws_status`, `claws_task_history`, `claws_open_prs`,
`claws_config`) plus
`ha_list_entities` / `ha_api_request` when `HOME_ASSISTANT_BASE_URL` and
`HOME_ASSISTANT_TOKEN` are configured, giving Claude visibility into what Claws
is currently doing, recent task history, operator configuration, and live Home Assistant entity
state and services.

`includeHomeAssistant` defaults to `false` and every call site must opt in
explicitly (#2064 — `ha_api_request` can invoke arbitrary HA services, e.g.
unlocking doors, so handing it to fleet agents working on unrelated repos was
a standing risk). Call sites pass
`{ includeHomeAssistant: isHomeAssistantConfigRepo(fullName) }`
(`isHomeAssistantConfigRepo()` in `home-assistant.ts`, a case-insensitive
match against `HOME_ASSISTANT_CONFIG_REPO`, default
`"St-John-Software/home-assistant-config"`) — issue-refiner (planner),
issue-worker (implementer), ci-fixer, review-addresser, pr-reviewer,
problematic-pr-diagnoser, and improvement-identifier all gate this
way, so HA tools are wired in only when the agent is actually working on the
HA config repo. `triage-claws-errors.ts` always operates on `selfRepo` and
passes no HA option at all, relying on the `false` default. The
`homeAssistantContext()` prompt text (which tells the model the HA MCP tools
exist) is gated by the same `isHomeAssistantConfigRepo(fullName)` check at
each call site, so agents on other repos are no longer told about tools they
don't have.

# Module Responsibilities

Detailed per-module reference for the claws codebase — see [OVERVIEW.md](OVERVIEW.md) for the high-level architecture.

**`main.ts`** — Wires everything together. Acquires a **PID file lock** at
`~/.claws/claws.pid` on startup (liveness check via `process.kill(pid, 0)`);
exits immediately if a live sibling holds it — prevents double-scheduling in
k8s rolling updates. Initializes the SQLite database,
recovers orphaned tasks from a previous crash (cleans up dangling worktrees,
marks tasks failed), calls `recoverWorkOnStartup()` to reset any `work_queue`
rows stuck in `running` state from a previous crash back to `queued` (so they
are retried after restart), prunes old logs. When `ACTIVATION_STATE === "verify-only"`,
no jobs are registered, WhatsApp is not started, and `runConnectivityVerification()`
runs once at startup to populate `verification_reports`. When `"active"`,
registers all 32 jobs with the scheduler
(interval jobs staggered by 2 seconds to prevent thundering herd), calls
`registerWorkHandlers()` (from `work-handlers.ts`) to register agent callbacks
with the work queue, starts `worker.ts` fibers, starts the HTTP server, sets up
live config reloading (interval and schedule changes propagated to the scheduler
without restart), initializes the WhatsApp gateway if enabled, and installs
SIGINT/SIGTERM handlers that cancel queued tasks, drain running jobs (5 min
timeout), terminate active Claude processes, and close the database.

**`config.ts`** — Loads configuration in priority order: environment variables >
`~/.claws/config.json` > hardcoded defaults. Also exports `INTERNAL_MCP_TOKEN`, a per-process
random 64-hex-char token generated at startup via `crypto.randomBytes(32)`. It is never read from
env or config, never shown in the config UI, and never persisted — its sole purpose is to
authenticate MCP child processes (spawned by `claude.ts`) to the local HTTP server's `/api/state`
endpoint. It is the only programmatic credential the API accepts.
`requireApiAuth` in `server.ts` checks `INTERNAL_MCP_TOKEN` first, then accepts a valid
`claws_session` cookie when OIDC is enabled.
Exports `LABELS` (`refined`,
`ready`, `priority`, `inReview`, `clawsIgnore`, `problematic`, `duplicate`, `billing`, `planFable`, `manualAction`, `automerge`), `LABEL_SPECS`
(synced to all repos by repo-standards — includes colors and descriptions for
all eleven labels; `Plan: Fable` triggers Fable 5 planning in issue-refiner; `Manual Action` blocks
auto-merge (see `auto-merger.ts`) and is applied by `issue-worker` when the PR-description generator
emits a `MANUAL-ACTION:` marker; `Automerge` replaces the human-LGTM gate in auto-merger with an automated one (#2120)), `LEGACY_LABELS` (set of old labels cleaned up as stale, including
`claws-mergeable` and `claws-error`), `INTERVALS`, `SCHEDULES`, and
connection strings. `WORK_DIR` is always `~/.claws`. Also exports `PROMPT_CAPTURE_DIR`
(`~/.claws/prompt-captures/`), where `claude.ts` writes a JSONL record of every
`runClaude()` prompt/output pair when capture is enabled (see
`docs/dspy-prompt-analysis.md`); capture is opt-in/off by default, enable with
`CLAWS_PROMPT_CAPTURE=1` (or `true`), override the directory with
`CLAWS_PROMPT_CAPTURE_DIR`. AI provider model
mapping includes Codex (`codexDefaultModel`/`codexLightModel`/`codexCheapModel`),
OpenCode/OpenRouter tool-use tier (`opencodeBestModel`, `opencodeAdequateModel`, `opencodeCheapModel`),
OpenCode text-only tier (`opencodeTextBestModel`, `opencodeTextAdequateModel`, `opencodeTextCheapModel`)
defaulting to Qwen 2.5 Coder on OpenRouter, and Claude cheap tier (`claudeCheapModel`).
Provider fallback is controlled per-capability via `toolUseProviderFallbackOrder` (default
`["claude"]`) and `textOnlyProviderFallbackOrder` (default `["claude"]` — was `["openrouter"]`
until the direct-HTTP OpenRouter provider was removed, #2229, because the OpenRouter account
had been out of credits long-term with no top-up planned), plus
`providerRateLimitCooldownMs` for rate-limit circuit breaker timing.
Ollama integration is configured via `ollamaBaseUrl`, `ollamaTimeoutMs`, and
`ollamaConsecutiveFailuresBeforeDisable`. Whisper transcription is configured via
`whisperLocalUrl` (env: `CLAWS_WHISPER_LOCAL_URL`; default `http://127.0.0.1:9000` — a same-VM Whisper server, auto-installed by the updater along with `uv`/`uvx` and tried first; empty string disables it)
and `whisperBaseUrl` (env: `CLAWS_WHISPER_BASE_URL`; default `https://whisper.home.bstjohn.net` — a remote Whisper server, tried second; empty string disables it, leaving OpenAI as the only backend). `whisperModel` (env:
`CLAWS_WHISPER_MODEL`; default `Systran/faster-whisper-base`, matching `WHISPER__MODEL` in
`deploy/whisper.service`) is the model ID sent to self-hosted (local/remote) Whisper servers only —
the OpenAI fallback always sends OpenAI's own `whisper-1` alias regardless of this setting; the two
must not be conflated since a self-hosted faster-whisper server rejects `whisper-1` outright (#1931).
GitHub App authentication is
configured via `githubAppId`, `githubAppPrivateKeyPath`, and
`githubAppInstallationIds`. OIDC/SSO is configured via `oidcClientId`,
`oidcClientSecret`, `oidcBaseUrl`, `oidcApplicationSlug`, and
`oidcRedirectUri`. Per-repo job disabling is configured via
`disabledJobsByRepo` (a `Record<string, string[]>` mapping repo full names to
arrays of job names) and exposed via `isJobDisabledForRepo()` helper and
`DISABLED_JOBS_BY_REPO` export. `oidcClientSecret` and
`githubAppPrivateKeyPath` are in `SENSITIVE_KEYS` (masked in config UI).
`getUnknownConfigKeys()` returns a readonly list of keys present in `config.json`
that are not recognised by the schema (e.g. stale keys from old versions);
`removeConfigKeys(keys)` rewrites `config.json` without those keys and calls
`reloadConfig()`. Both are used by the config page to surface and clean up
unknown keys. Both `writeConfig()` and `removeConfigKeys()` write `config.json` with mode `0o600`
plus an explicit `fs.chmodSync(CONFIG_PATH, 0o600)` (the `mode` option is ignored when overwriting
an existing file, so the chmod is what actually tightens permissions on a pre-existing config.json) —
`config.json` holds plaintext secrets (Slack tokens, OIDC client secret, GitHub App private key path,
etc.), so it must not be left world-readable under the default umask (#1937). `activationState?: "verify-only" | "active"` controls whether the
instance runs jobs (`"active"`) or only performs connectivity checks
(`"verify-only"`). The exported `ACTIVATION_STATE` mutable variable and
`isActive()` helper are the runtime source of truth; `activationState` is
persisted to `config.json` via the **Activate** button or the
`CLAWS_ACTIVATION_STATE` env var. On first boot (no `claws.db`), the default is
`"verify-only"`; if `claws.db` already exists the loader auto-selects
`"active"` (so copying a populated data volume from systemd does not require a
manual flip). `BIND_HOST` (`CLAWS_BIND_HOST` env or `"0.0.0.0"`) controls the
interface the HTTP server listens on; required when Claws runs in a container.

**`scheduler.ts`** — Manages job lifecycle. Each job runs immediately on
startup, then repeats on its interval. If a prior run is still active, the
incoming tick is silently skipped (no queuing). Supports `scheduledHour` mode
(fires once daily at a specific hour) with optional `runOnStart` for jobs
that should also fire immediately at startup (e.g. repo-standards) and
optional `skipWeekends` to suppress Saturday/Sunday runs (manual triggers
bypass this). Exposes
`drain()` for graceful shutdown, `triggerJob(name)` for manual HTTP-triggered
runs, `updateInterval()` / `updateScheduledHour()` for live config
changes without restart, `pauseJob(name)` / `resumeJob(name)` for toggling
job execution via the dashboard, `jobScheduleInfo()` for exposing per-job
schedule metadata (interval or scheduled hour) to the dashboard, and exports
`msUntilHour()` for computing next-run countdowns. Paused jobs are
initialized from the `pausedJobs` config array on startup. Jobs can declare
a `triggers` array of downstream job names — when a run completes
successfully and produced tasks (checked via `getTasksByRunId()`), each
downstream job is triggered after a 10-second delay to allow GitHub
webhooks and CI status to propagate. Cascades terminate naturally when a
triggered run produces no tasks. Existing polling is preserved as fallback.

**`github.ts`** — All GitHub interaction via the `gh` CLI (never the HTTP API
directly). Wraps `execFile("gh", ...)` with exponential-backoff retry on
transient errors (400, 401, 500, 502, 503, 504, ETIMEDOUT, ECONNRESET, ECONNREFUSED, EAGAIN,
connection reset, "Could not resolve to a", "TLS handshake timeout",
"Something went wrong", "i/o timeout", "failed to create new OS thread", "resource temporarily unavailable", "unexpected EOF",
"invalid character", "unexpected end of JSON input" — up to 3 attempts with 1s/2s/4s delays). The last two are Go/gojq
JSON-decode errors raised when GitHub returns a truncated or garbled response body to a `gh --jq`/`gh --json` call — a
one-off network hiccup worth retrying (#2240) but deliberately *not* added to `SERVER_SIDE_PHRASE_RE`/`GH_SERVER_ERROR_RE`,
so a persistently truncated response still surfaces as a reportable `[claws-error]` rather than being suppressed as
self-healing. The EAGAIN variants handle OS-thread exhaustion from Go-binary (`gh`, `git`) spawn failures under `TasksMax` cgroup pressure. The 401
retry handles transient GitHub OAuth token rotation — if the token is truly
revoked, all 3 retries fail and the error surfaces normally. Rate limit
errors are not retried — they trip a **circuit breaker** that blocks all API
calls for 60 seconds (throws `RateLimitError`). If a GitHub-side failure
(`GH_SERVER_ERROR_RE`: a literal `HTTP 500/502/503/504`, or a shared
server-side phrase like `Something went wrong` or `ECONNRESET` matched via
`SERVER_SIDE_PHRASE_RE`) is still the failure after all retries are exhausted,
`gh()` rejects with `TransientGitHubError` instead of a plain `Error`
(#2036/#2039, widened in #2147) — `error-reporter.ts` recognizes the type and
logs a warning rather than opening a `[claws-error]` issue, since the
condition is self-healing (the dispatcher retries the item on its next
cycle). Bare numeric status codes and `Could not resolve to a` are
deliberately excluded from this suppression even though `TRANSIENT_RE` retries
on them: a bare `502` can appear in echoed issue/PR content, and `Could not
resolve to a` usually indicates a genuine bad ref, so both should still
surface as a reportable `[claws-error]` issue rather than being suppressed.
Includes GraphQL pagination for
resolved review thread filtering. Uses a generic `TTLCache` for API response
caching and in-flight request deduplication (PR lists, check status, issue
comments, and `getRunJobSummaries` — `identifyPRWork` asks for the same run's
jobs from the classification phase, the `CI_FIXER` handler and the
`CI_FIXER_RERUN` sweep within one cycle). Jobs populate a category-based queue cache via
`populateQueueCache()`, and the dashboard reads it via `getQueueSnapshot()`.
Categories: `ready`, `needs-refinement`, `refined`, `needs-review-addressing`,
`auto-mergeable`, `needs-triage`, `needs-qa`. `populateQueueCache()` accepts an
optional `labels?: string[]` field — issue-dispatcher, pr-dispatcher, and all other
callers pass `issue.labels.map((l) => l.name)` so labels are stored in the cache
entry and rendered on the queue page. `enrichQueueItemsWithPRStatus()` only
overwrites `item.labels` for `type === "pr"` — issue labels are preserved from
the cache. The queue cache has four correctness
invariants: (1) `populateQueueCache()` evicts any existing entry for the same
`(repo, number)` under a different category before writing the new one — preventing
stale categories from lingering after a state transition (e.g. `needs-refinement` →
`refined`); (2) `getQueueSnapshot()` performs TTL eviction on read, removing entries
older than `QUEUE_ENTRY_TTL_MS` (20 minutes — longer than the slowest dispatcher
interval so a single transient scan failure does not wipe the cache); (3) when the
same `(repo, number)` appears under multiple categories, deduplication keeps the
freshest entry (by `fetchedAt`), not the oldest; (4) after each dispatcher completes
a full repo scan, `reconcileQueueCache(repo, categories, populated, type)` evicts
entries in the categories that dispatcher owns whose item number was not populated
this cycle — removing items that closed, merged, or changed state on GitHub without
a tracked Claws transition (the `type` parameter keeps `issue-dispatcher` and
`pr-dispatcher` from clobbering each other's entries in the shared `"ready"` category;
reconciliation is skipped if the rate-limit circuit breaker fired mid-scan, since
`populated` would be incomplete). `oldestFetchAt` (the "last scanned"
banner on the queue page) is computed only over returned entries, not evicted ones.
The `listRepos()` function caches its result for `REPO_CACHE_TTL` (5 min),
shared across all callers, and dedupes concurrent cache misses via a shared
in-flight `repoCachePromise` rather than firing one fetch per caller — added
because ~10+ jobs independently called `listRepos()` within seconds of each
other at startup, bursting past the GraphQL rate limit (#230). It also falls
back to that stale cache when a fresh fetch returns empty (transient failure
protection).
Its underlying `fetchRepos()` filters to **private repos only** (`isPrivate` from the
installation-repositories API) in addition to skipping archived repos, so the whole
polling/dispatch pipeline ignores public repos (#1826). `listPublicReposIncludingArchived()`
is unaffected and still enumerates public repos for `public-repo-scanner`.
Provides `isItemSkipped()` and `isItemPrioritized()` helpers that check
items against the `skippedItems` and `prioritizedItems` config lists,
used by jobs to exclude or fast-track specific issues/PRs.
`findIssueByExactTitle(repo, title)` — exported helper that does an exact-title lookup over the cached, strongly-consistent `listOpenIssues` result (not `gh search issues`, which parses its query as GitHub advanced-search syntax and can misread a title containing a bare `key:value` token, #2289). Replaces the duplicated `open.find(r => r.title === title)` pattern at four call sites (`ensureAlertIssue`, `ha-upgrader`, `bin-day-monitor`, `idea-collector`). Returns `{ number: number; title: string } | null`; when `listOpenIssues` is already at its 100-item `--limit` cap, logs a warning that dedup may be incomplete rather than failing silently.
`findOpenPRsByTitle(repo, needle)` — the PR-side counterpart (#2289), replacing the old `gh search prs` path for the same reason: a substring filter over the cached `listPRs` result, not a GitHub search query. Returns every open PR whose title contains `needle`. Used by `idea-reconciler.ts` and `improvement-identifier.ts` to check for an already-open PR before creating a new one.
`isCiAlertBotAuthor(issue)` returns `true` for any issue authored by the GitHub
Actions runner bot (`github-actions[bot]` or `app/github-actions`, via
`CI_FAILURE_ALERT_BOT_LOGINS`). The issue-dispatcher uses this as its single bot gate:
any runner-authored issue is dispatched into the refine-and-fix pipeline regardless of
title — no title allowlist is needed. Other bots (dependabot, etc.) are not in
`CI_FAILURE_ALERT_BOT_LOGINS` and remain subject to the untrusted-actor notify/skip
path.
`isRepoPrivate(repo)` fetches repo visibility via `gh api repos/{repo} --jq .private`;
on non-rate-limit errors it defaults to `false` (safer for public-repo findings) — used
by `improvement-identifier` to suppress two classes of findings on private repos: (1)
fork-PR hardening recommendations (a private repo can't receive fork PRs from users
without write access, so untrusted fork code never runs on its runners), and (2)
findings whose only threat model is that GitHub-supplied issue/comment/PR text is
attacker-controlled or a prompt-injection vector — on a private repo only invited
collaborators can post that content, so it's trusted-party input, not anonymous
attacker input. This second carve-out does **not** extend to injection arriving via
other channels (webhooks, external HTTP, file contents, command output), which are
still reported normally regardless of repo visibility (#1874).
`listPublicReposIncludingArchived()` iterates `GITHUB_OWNERS`, calls `listInstallationRepositories(owner)` from
`github-app.ts`, filters to non-private entries, and returns `PublicRepoEntry[]` (includes `isArchived: boolean`);
archived repos are intentionally kept — this is the only enumeration path that covers them since `fetchRepos()`
skips archived repos; used exclusively by `public-repo-scanner`. Provides
`hasIgnoreLabel()` for the `Claws Ignore` label check, `skipItem()` for
programmatic auto-skipping, and `getDeploymentUrl()` for discovering preview
deployment URLs for QA — the Deployments-API path is only trusted when
`isSafeDeploymentUrl()` confirms the returned `environment_url` parses as an
`http:`/`https:` URL (rejecting `javascript:`/`data:`/malformed values before
the URL reaches the Playwright-equipped `qa-phase` agent prompt, #1945); the
Vercel-comment fallback is already regex-anchored to `https://…vercel.app` and
needed no change. `listCompareCommits(repo, base, head)` calls the GitHub
Compare API (`/repos/{repo}/compare/{base}...{head}`) and returns
`{ sha, subject }[]` (chronological, capped at 250 commits — pagination not
needed for typical deploy ranges); used by `ha-deploy-watcher` to format
per-commit Slack notifications. `listDuplicateIssuesOf(repo, canonicalNumber)` returns
all open issues labeled `Duplicate` whose comments contain the plain-text
`CLAWS_DUPLICATE_OF: #N` marker — used by issue-worker to add `Closes #N`
closing keywords for every duplicate when the canonical issue's last-phase PR
is created. (GitHub's search is substring-based, so legacy issues with the old
`<!-- claws-duplicate-of:N -->` HTML comment format are still matched.)
`getIssueBodyHtml(repo, issueNumber)` fetches the rendered `body_html` field
via `gh api repos/{repo}/issues/{number}` with `Accept: application/vnd.github.full+json` — this HTML contains pre-signed
`private-user-images.githubusercontent.com` URLs that are directly
downloadable, used by `processTextForImages()` to access private-repo images.
(Prior implementation used `gh issue view --json bodyHTML` which is not a valid
JSON field for that command and silently returned empty strings.)
`getIssueComments()` requests `Accept: application/vnd.github.full+json`
so each comment includes a `body_html` field alongside `body`. Provides
reaction helpers (`addReaction`, `addReviewCommentReaction`,
`getCommentReactions`, `getReviewCommentReactions`). Review-comment reactions
use `pulls/comments/{id}/reactions` and issue-comment reactions use
`issues/comments/{id}/reactions` — separate ID namespaces, so each gets its
own 60s TTL cache key, and each is invalidated by its corresponding
`add*Reaction` writer as soon as it posts (#2265).
All comments posted by Claws include a hidden `CLAWS_COMMENT_MARKER` and a
visible header. When an `agentName` is provided, the header shows
`*— Automated by Claws · <agentName> —*` (e.g., `· Planner ·`, `· CI Fixer ·`);
otherwise the default `CLAWS_VISIBLE_HEADER` is used. Helper functions
`isClawsComment()` / `stripClawsMarker()` handle attribution when processing
feedback. Comment
filtering uses `isClawsComment()` (marker-based) rather than self-login
comparison, ensuring correct behavior when the `gh` auth identity is the
same GitHub account as the human user. `hasValidLGTM()` accepts a
`baseBranch` parameter and filters out merge-from-base commits (e.g. from
ci-fixer resolving conflicts) so they don't invalidate an existing LGTM.
`getPRReviewComments()` skips bare "LGTM" issue-tab comments (approval
signals for auto-merger, not review feedback). Reaction state for inline review
comments, Claws non-review issue comments, and human issue comments is
prefetched with `mapSettledWithConcurrency` at `REACTION_FETCH_CONCURRENCY`
rather than fetched one `gh api` subprocess at a time in-loop (#2265). It
returns `PRReviewData`: an authority-structured
`formatted` string plus a `htmlBodies: string[]` array populated from `body_html` fields. All three
`gh api` calls (reviews, inline review comments, and issue-tab comments) use
`Accept: application/vnd.github.full+json` to receive `body_html`; the PR description's own HTML
is fetched once at the top of the function and prepended to `htmlBodies`. `htmlBodies` is accumulated
in parallel with the text `formatted` string — every body that contributes a line to `formatted` also
contributes its `body_html` to `htmlBodies`. The review-addresser passes `reviewData.htmlBodies` as
the fifth argument to `processTextForImages()` so the image pipeline prefers pre-signed
`private-user-images.githubusercontent.com` URLs (mirroring the fix applied to the issue path in
#1135). Human review comments (top-level reviews, inline review comments, and human issue-tab
comments) appear under `=== HUMAN REVIEWER COMMENTS (AUTHORITATIVE — must be followed) ===`; the
single Claws `## PR Review` comment (when present and non-clean) appears under
`=== AUTOMATED CLAWS REVIEW (advisory — defer to human directives above when they conflict) ===`;
other Claws comments with human 👍 approval appear under a third section. Empty sections are omitted
entirely. This structure lets the review-addresser reliably distinguish owner directives from
automated suggestions — human instructions win any conflict. `getPRCheckStatus()` returns
four states: `"passing"`, `"failing"`, `"pending"`, or `"none"` (no checks
exist at all — used by auto-merger to distinguish doc-only PRs that skip CI
from PRs with in-progress checks). Check status strings returned by different GitHub APIs use different casing (GitHub Actions returns uppercase `"FAILURE"`, `"SUCCESS"`, etc.; Statuses API uses lowercase). `normalizeCheckState(s)` (`s.toUpperCase()`) normalises all values before membership tests against `FAILED_STATES` and `PASSING_STATES` sets — applied at four call sites: `getPRCheckStatus`, `getPRChecksSummary`, `getFailingCheck`, and `getFailedRunLog`. The original cased values are preserved in returned objects; only comparisons are normalised.
`getRunAnnotations(repo, runId)` fetches job annotations for a completed workflow run (paginates job IDs, then fetches per-check-run annotations). `isBillingBlocked(annotations)` checks the annotation messages against `BILLING_ANNOTATION_PATTERN` to detect GitHub Actions spending-limit blocks. The ci-fixer calls both before deciding to rerun a failed workflow — billing-blocked runs are skipped (with a `Billing` label applied) rather than rerun.
`getPRMergeableState()` polls up to 5
times (3-second intervals) when GitHub returns `"UNKNOWN"` — a transient state
GitHub sets while computing the merge commit; the auto-merger skips the PR if
`"UNKNOWN"` persists after all retries, and re-processes it on the next cycle. `getIssueState()` returns
`state` and `stateReason` for an issue, used by idea-reconciler to detect
issues closed without implementation. `editIssue()` edits an issue's body
in place (used by k3s-monitor to update occurrence tracking without posting
new comments).
`fetchRepoCacheUsage(repo)` fetches cache usage via `GET /repos/{repo}/actions/cache/usage`
(returns `{ bytes, count }`; tolerates 404 as zero). `fetchRepoArtifactUsage(repo)` paginates
`GET /repos/{repo}/actions/artifacts` using `--paginate --jq` (one JSON object per line) and
sums non-expired artifact sizes. `fetchRepoStorageUsage(repo)` combines both into a
`RepoStorageUsage` object (`{ repo, cacheBytes, cacheCount, artifactBytes, artifactCount,
oldestArtifactAt }`). Used exclusively by `actions-storage-monitor`.
`fetchRepoFileContent(repo, path)` fetches a file's contents via `GET /repos/{repo}/contents/{path}` and base64-decodes the response; returns `null` on 404/403/missing file. Used by `dependabot-alert-monitor`'s manifest-pin staleness pass.
`DependabotAlertsPermissionError` — named error class thrown by `listOpenDependabotAlerts` when the GitHub App lacks the `dependabot_alerts: read` permission (HTTP 403 "Resource not accessible by integration"); distinct from the 404 / "disabled" case (which returns `[]` silently, per-maintainer guidance to leave repos with scanning disabled as-is). The permission-check must come before the 404 swallow in the catch block to avoid misclassifying permission failures as "no alerts". `listOpenDependabotAlerts(repo)` returns up to 100 open alerts (no pagination; caller warns on exact-100 result) as typed `DependabotAlert[]`. `dismissDependabotAlert(repo, number, reason, comment)` sends `PATCH /repos/{repo}/dependabot/alerts/{number}` with `state=dismissed` and the provided `dismissed_reason` (required by GitHub — defaults to `"inaccurate"` for stale-version dismissals). `fetchRepoSbomPackages(repo)` fetches the SPDX 2.3 dependency graph via `GET /repos/{repo}/dependency-graph/sbom`, strips the `<manager>:` prefix from each package name, and lowercases the remainder; tolerates 403/404/disabled by returning `[]`. Used by `dependabot-alert-monitor` to compare patched versions against the SBOM and dismiss alerts whose fixed version is already present in the graph.
`listDependabotUpdateRuns(repo)` returns the repo's Dependabot updater runs (`GET /repos/{repo}/actions/runs?event=dynamic&per_page=50`, jq-filtered on `path == "dynamic/dependabot/dependabot-updates"` — filtering on `event` alone would also match CodeQL default setup); returns `[]` and never throws for repos with Actions disabled or no updater history. `fetchFailedJobLog(repo, runId, maxChars = 300_000)` returns the **tail** of the first failed job's log for a run — the Dependabot updater reports its error near the end of a ~700-line log, so the head-slicing private `getFailedJobLog` used by the CI-fixer path would miss it; the `.../actions/jobs/{id}/logs` endpoint returns plain text (via a 302 `gh api` follows), not JSON. Both are used by `dependabot-run-monitor`.

**`github-app.ts`** — GitHub App authentication (required). Supports two
credential modes: **global** (`githubAppId` + `githubAppPrivateKeyPath`) and
**per-owner** (`githubOwnerAppCredentials`, a `Record<string, OwnerAppCredential>`
mapping owner names to `{appId, privateKeyPath, installationId?}`). Per-owner
credentials take priority over global credentials (useful when different GitHub
organisations use different Apps). `ensureGitHubAppConfigured()` is the startup
validator — called early in `main.ts`, it checks per-owner credentials first,
then global credentials, and throws with a clear message if neither resolves.
`isGitHubAppEnabled()` is retained as a vestigial always-true accessor for
callers that haven't been simplified yet. When configured, the module signs RS256
JWTs (cached, 9-minute expiry), resolves installation IDs per-owner (via org or
user installation endpoint, configurable override via `githubAppInstallationIds`),
and mints short-lived installation tokens (cached with 10-minute expiry
buffer, concurrent refresh deduplication). `getInstallationTokenForOwner(owner)`
returns a valid token or throws; `getAnyInstallationToken()` walks `GITHUB_OWNERS`
and returns the first success or throws. Tokens are validated at mint time
(non-empty, no whitespace) before entering `tokenCache`, so a malformed/blank
token can never be cached; `invalidateInstallationToken(owner)` evicts a
cached entry on demand (deliberately leaves `inFlightTokenRefresh` alone to
avoid a duplicate-mint race). `buildEnvForGh(token)` produces an env
with `GH_TOKEN` and `GITHUB_TOKEN` set; `buildEnvForGhGit(token)` additionally
injects a one-shot inline credential helper via `GIT_CONFIG_COUNT/KEY/VALUE`
env vars so authenticated git pushes/fetches use the installation token
without mutating git global config — the helper reads the token from the
`CLAWS_GIT_CREDENTIAL_TOKEN` env var at runtime rather than embedding it in
the helper's shell source, so no character allowlist is required and any
GitHub token format (including legacy `v1.<hex>`) works. The remaining guard
rejects only non-strings, empty tokens, and tokens containing whitespace, and
logs shape (prefix + length, via `describeTokenShape()`) only, never the
value. `buildGitEnvForOwner(owner)` wraps mint + env build with one
evict-and-retry on failure, returning `undefined` only after both attempts
fail — it escalates the first failure per owner to `log.error` (later ones
`log.warn`) because falling back to the host's ambient git credentials is a
silent privilege change. `listInstallationRepositories(owner)`
paginates the installation repositories endpoint with up to 3 retry attempts on
transient network failures (DNS, ECONNRESET, ETIMEDOUT) via the module-level
`isRetryableFetchError()` helper — which inspects `err.message` and `err.cause`
since raw `fetch()` wraps the underlying cause. The token is re-fetched inside
each retry body (safe because `getInstallationTokenForOwner` caches tokens).
`InstallationRepoEntry` includes an `isPrivate: boolean` field (from `r.private` in
the raw GitHub API response) — used by `listPublicReposIncludingArchived()` to filter
to public repos only; `fetchRepos()` ignores this field and existing behavior is unchanged.
PRs and comments posted by
Claws appear under the App bot identity. `extractOwnerFromGhArgs()`
parses a `gh` argv array to determine which owner's token should be injected,
enabling per-call token scoping. `resetGitHubAppState()` clears all caches
(called on config reload).

**`sessions.ts`** — Interactive PTY session manager. Each session is wrapped in
a detached `tmux` session (`claws-<id>`); the `node-pty` process that the
WebSocket bridges to is a `tmux attach-session` client. This lets sessions
survive Claws service restarts: the tmux server lives outside Claws's cgroup
(enabled by `KillMode=process` in the systemd unit). All tmux invocations use
`-L claws` (the `TMUX_SOCKET = "claws"` constant) to isolate Claws sessions to
a named socket, keeping them separate from any user tmux server and allowing the
socket to survive cgroup OOM kills that target claude child processes first. On startup,
`recoverSessions()` reconciles the `sessions` SQLite table with live tmux
sessions and re-attaches a fresh bridge for each survivor (with scrollback
seeded from `tmux capture-pane`). After reconciling, it also sweeps for stray
`claws-*` tmux sessions: any on the `claws` socket with no DB row is killed
(crash between tmux-create and DB-insert leaves such leaks), and any on the
default tmux socket is killed (claws never creates on the default socket, so
any match is a leak from an older build or manual session). **Capability-based env gating** (via `capabilities.ts`): sessions are default-deny for gated secrets. `createSession` and `createMultiWorktreeSession` accept a `capabilities: string[]` parameter (selected IDs from the `CAPABILITIES` registry). Every gated key (`HOME_ASSISTANT_BASE_URL/TOKEN`, `NAMEY_DB_URL`, `KUBECONFIG`) plus the baseline `SENSITIVE_ENV_KEYS` is stripped with `env -u` before the claude process is spawned — since #2138 that includes *granted* keys too, so a session can never silently inherit an ambient value. Granted values are then delivered out-of-band: `sessions.ts`'s `capabilityEnvArgs(id, caps)` writes them to `${WORK_DIR}/session-env/<id>.env` at mode 0600 (`session-env-file.ts`) and `buildCapabilityEnvArgs` appends a `/bin/sh -c '. "$1"; rm -f "$1"; shift; exec "$@"' claws-session <path>` prelude that sources the file, deletes it immediately, and `exec`s the real command — so `/proc/<pid>/cmdline` carries key names and a path but never a credential. This replaced discrete `KEY=value` argv elements, which put the Home Assistant long-lived token in the output of any `ps aux` or `systemctl status` for any local user (#2138 — the token was rotated). A tmux spawn runs inside the already-running tmux *server*, which does not inherit the client's environment, so `childSpawn("tmux", …, { env })` cannot deliver these values; the sourced file is the workaround. Sourcing is fail-closed: a missing file aborts `sh` and the session dies visibly rather than running unauthenticated. `recoverSessions()` calls `pruneSessionEnvFiles()` first to clear files orphaned by a crash between the write and the spawn (`NAMEY_DB_URL` is stripped only as a baseline sensitive key now — no capability grants it since `namey-db` was removed; the `namey_query` MCP tool self-disables when it's unset). `--append-system-prompt` is now always passed: it always carries `SESSION_WORKFLOW_PROMPT` (telling the session to follow the Claws issue/PR lifecycle rather than invoking the repo's `.claude/agents/*` definitions itself, #2360) and, when at least one capability is granted, a brief description of each granted capability appended after it (via `buildCapabilityPrompt`). The `capabilities` column in the `sessions` DB table (JSON array of selected IDs) persists the selection so `resumeSession` can re-apply the same env grant and system-prompt injection. The session-create UI exposes checkboxes for all currently-available capabilities (those whose backing config is non-empty). `prod-infra` and `fleet-infra` grant `KUBECONFIG` — when both are selected, the two kubeconfig paths are colon-joined so kubectl can address both clusters. The eight `ssh:<alias>` capabilities (#1985) are always available (they resolve to `{}` regardless of config) and always appear in the checkbox list; granting one injects no env var, it only adds the host to `buildCapabilityPrompt`'s description of what the session may do.
`createSession(repo, mode)` supports five modes (exported as `SESSION_MODES`):
`repo-zsh` (zsh in the repo's main clone), `repo-claude` (claude in the repo's
main clone), `worktree-claude` (claude in a fresh worktree), `home-claude`
(claude in `$HOME`, no repo required), and `multi-worktree-claude` (multi-repo —
must be created via `createMultiWorktreeSession`, not `createSession`).
`createMultiWorktreeSession(repos: string[])` (requires ≥ 2 repos) creates a
fresh worktree for each repo, runs Claude in the first repo's worktree, and
passes additional worktree paths via `--add-dir <path>` so Claude can
read/write across all of them in one session. The primary worktree/repo is
stored in the existing `repo`/`worktreePath`/`cwd` DB columns; additional ones
are stored as JSON in a new `extra_worktrees` column and surfaced via
`session.extraWorktrees: Array<{ repo: string; worktreePath: string }>`.
Initiated via `POST /sessions/create-multi`.
**Session resume**: When a tmux session exits normally (process finishes), the
session row and in-memory entry are kept rather than deleted, and `session.resumable`
is set to `true`. `resumeSession(id)` recreates worktrees at the same deterministic
path (`claws-wt/<id>`) so `claude --continue` finds the path-keyed conversation
history preserved in `~/.claude/projects/`. For `repo-claude`/`home-claude`/`repo-zsh`
modes the cwd is a stable main clone / `$HOME` and is never deleted, so resume just
relaunches tmux there. `session.resumeRepos: string[]` stores the repo list needed to
reconstruct worktrees (set before cleanup in the bridge-exit handler). Sessions that fail
their bridge (respawn) or are killed manually are not marked resumable and are reaped by
the 60-second reaper normally. Accessible via `POST /sessions/:id/resume`.
Before opening any repo-backed session
(`repo-zsh`, `repo-claude`, `worktree-claude`), `ensureClone()` is called to
fetch the latest remote state; failures surface as `"fetch-failed"` (a
`CreateSessionError` variant). Path traversal is guarded by verifying the
resolved `cwd` starts with `~/.claws/repos/` when a repo is specified. No hard
cap on concurrent sessions; `createSession` returns a `{ ok, reason }` result
and failures (shutdown, bad mode/repo, fetch failure, tmux/worktree errors)
surface a specific reason to the caller. No idle timeout — sessions
persist until explicitly killed. `session.scrollback` retains up to 50,000
bytes of recent output for reconnect. Immediately after a tmux session is created
(and again during `recoverSessions()` for pre-existing sessions), mouse mode is
enabled via `tmux set-option -t =<name> mouse on` — this forwards xterm.js wheel
events to tmux's copy-mode for scroll, fixing desktop terminal scrolling. Failures
to set mouse mode are logged at warn level and do not abort session creation.
`listSessions()`, `killSession(id)`, and `disconnectAllSessions()` manage
lifecycle; `disconnectAllSessions()` is called from `server.ts` on server close
and only tears down PTY bridges (tmux sessions keep running). Sessions are
accessible via WebSocket at `/sessions/:id/ws`. Each session is summarized shortly after it accumulates ≥80 chars of scrollback, via `summarizeSession()` (a 30-second poll retries un-summarized sessions until they have enough output). A non-idle summary is then frozen for the session's lifetime, but an idle placeholder (`isIdlePlaceholder()` matches `"Idle at shell prompt"` / `"Idle at Claude prompt"`) is re-summarized once `session.lastActivity` advances past the summary's timestamp, and any idle-sounding model output is deterministically collapsed to one of those two canonical repo-free strings rather than left as free text (#1884). The call pins `provider: "claude"` (text-only, `sonnet` tier) for reliability, mirroring `classify-complexity.ts`.

**Session history**: when a session's tmux process exits, `recordSessionEnded()` persists it as a terminated-but-browsable row (`sessions.ended_at` set, `resume_repos` JSON storing the repo list needed to reconstruct worktrees) instead of deleting it outright. `listEndedSessions()` returns up to `MAX_ENDED_SESSIONS` (50) most-recent ended sessions, pruned oldest-first via `pruneEndedSessions()`; `getEndedSessions`/`markSessionEnded`/`clearSessionEnded` (`db.ts`) back this. The sessions page merges ended sessions (filtered against still-live IDs) alongside live ones (#1883). `reconstructEndedSession()` rebuilds a `Session` object from the DB row on demand — its `pty` field is left as an unused placeholder until `resumeSession` attaches a live bridge, so code reading `session.pty` must not assume it is set for a reconstructed-but-not-yet-resumed session. `deleteSession` (`POST /sessions/:id/delete`) permanently removes an ended session's row.

**`claude.ts`** — Git worktree helpers and Claude/Codex/OpenCode CLI runner. Key exports: `ensureClone`, `createWorktree`,
`createWorktreeFromBranch`, `createWorktreeFromBranchIfExists`, `removeWorktree`,
`withNewWorktree` (create + try/finally cleanup in one call), `withExistingWorktree`
(same but returns `null` if branch is gone), `attemptMerge`, `pushBranch`,
`generatePRDescription`, `generateDocsPRDescription`, `regeneratePRDescription`,
`readRepoAgentDoc(wtPath, role)` — reads a repo's `.claude/agents/<role>.md` from a worktree, strips YAML frontmatter, and returns the body for injection via `RunClaudeOptions.appendSystemPrompt`; agents use this to load their corresponding per-repo doc (role mapping: `issue-refiner` → issue-refiner.md, `issue-implementer` → issue-implementer.md, `pr-reviewer` → pr-reviewer.md). Missing files return `undefined` (graceful no-op). `ensureClone` (exported) clones a repo on first use and on subsequent calls
runs `git fetch --all --prune` followed by `git checkout origin/<defaultBranch>
--force` to refresh the main clone's working directory — this ensures any code
reading directly from the main clone (e.g. ubuntu-latest-scanner) sees the
latest remote state. Before that fetch, `unshallowIfNeeded()` checks `.git/shallow`
and best-effort runs `git fetch --unshallow` when the clone is shallow (#2337) —
shallow state lives in the shared `.git` dir, so a shallow fetch run by an agent
inside *any* worktree (e.g. a CI tool defaulting to `--depth 1`) breaks
`git diff origin/<base>...HEAD` ("no merge base") for every later job on that
repo until repaired; failure to unshallow is logged and swallowed rather than
thrown, since the caller may still be able to do useful non-diff work. The
`skipFetchIfRecent` fast path additionally requires the clone not be shallow,
so a still-shallow clone always goes through the full fetch+repair branch even
within the TTL window. The `git()` helper wraps `execFile("git", ...)` with
exponential-backoff retry (up to 3 attempts, 1s/2s/4s) on transient network
errors (HTTP 5xx, ETIMEDOUT, ECONNRESET, ECONNREFUSED, TLS handshake timeout,
DNS failures). The separate `gitRaw()` helper returns `{ code, stdout, stderr }`
without throwing or retrying — callers like `pushBranch` and `attemptMerge`
manage their own error handling. The queue rejects new tasks when the system is
shutting down (via `shutdown.ts`, throwing `ShutdownError`). Active child
processes are tracked for signal-based cancellation: `cancelCurrentTask()` kills
the most-recently-spawned process (used by shutdown and the `/cancel` endpoint),
while `cancelTaskByRunId(runId)` kills all child processes for a specific job run
(used by the `/logs/:runId/cancel` dashboard endpoint). The `activeRunChildren`
map (`Map<string, Set<ChildProcess>>`) tracks which children belong to each run ID
by reading `runContext.getStore()` (AsyncLocalStorage from `log.ts`) at spawn time
— entries are cleaned up in the `"close"` and `"error"` handlers.
Concurrent clones to the same repo are deduplicated.

**Multi-provider backend:** `RunClaudeOptions` requires a `capability` field
(`"tool-use"` or `"text-only"`) — every call site must declare whether the
workflow needs tool calling (file edits, git, gh) or only text generation. The
options also accept an optional `provider` field (`"claude"`, `"codex"`, or
`"opencode"`) and an optional `agent` field (`"plan"` or `"build"`, passed to
OpenCode via `--agent`). The `runClaude()` function implements a **capability-aware
provider fallback loop**: it walks the capability-specific fallback order
(`TOOL_USE_PROVIDER_FALLBACK_ORDER` or `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`) —
explicit provider first if pinned, then remaining entries — skipping any that are
currently rate-limited (circuit breaker). On failure,
`ollama-rate-limit-classifier.ts` determines whether the error is a rate limit;
confirmed rate limits mark the provider as unavailable for `providerRateLimitCooldownMs`.
The `onProviderUsed` callback lets callers track which provider was actually used
(for DB persistence and attribution). The `onTokensUsed` callback reports token count and cost when the provider exposes usage data: Claude CLI extracts `total_cost_usd` and sums the four `usage.*` fields from its JSON output; OpenCode and OpenRouter direct extract token/cost from their NDJSON event streams; Codex CLI does not expose usage data and never fires `onTokensUsed`. All agent call sites (issue-worker, issue-refiner, ci-fixer, review-addresser, pr-reviewer, and problematic-pr-diagnoser) capture the callback result and write it to the DB via `db.updateTaskTokenUsage()`. `runClaudeOnce()` dispatches to
`runClaudeCliOnce()` (Claude CLI), `runCodexOnce()` (OpenAI Codex CLI), or
`runOpenCodeOnce()` (OpenCode CLI with `OPENROUTER_API_KEY` env). Claude is invoked via
`spawn("claude", ["-p", "--dangerously-skip-permissions", "--output-format", "json"])`
while Codex uses `spawn("codex", ["exec", "--dangerously-bypass-approvals-and-sandbox"])`
and OpenCode uses `spawn("opencode", ["--no-tui", "--format", "json"])`.
All three receive the prompt on stdin. OpenCode `--format json` produces an NDJSON
event stream (events: `text`, `error`, `step_finish`) parsed to extract output,
detect errors, and capture token usage. Claude uses `--output-format json` for
structured output parsing. Codex output is plain text.
MCP config is not passed to Codex/OpenCode sessions.
The `agent` field maps to OpenCode's agent types: analysis/review tasks use
`agent: "plan"` (issue-refiner, pr-reviewer), code generation tasks use
`agent: "build"` (issue-worker, ci-fixer, review-addresser).

**Env sanitization:** `RunClaudeOptions.envSanitization` (`"strict" | "passthrough"`) controls whether `sanitiseEnvForChild()` strips `SENSITIVE_ENV_KEYS` (HA token, `NAMEY_DB_URL`, `CLAWS_AUTH_TOKEN`, `CLAWS_OIDC_CLIENT_SECRET`, Slack tokens/webhook, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, Gmail app password, etc.) from the spawned child's environment before it inherits `process.env`. It defaults to `"strict"`. `SENSITIVE_ENV_KEYS` must be kept in sync with whatever env var name `config.ts`'s `loadConfig()` actually reads for each secret — the list previously carried `CLAWS_SLACK_WEBHOOK_URL` while the loader read `CLAWS_SLACK_WEBHOOK`, and omitted `CLAWS_OIDC_CLIENT_SECRET` (the dashboard session-cookie HMAC key) entirely, so both leaked into every strict-mode child until fixed (#1859); a name in the list that no loader reads is silently a no-op, not a caught error. Every `capability: "tool-use"` call site (planner, issue-worker, ci-fixer, review-addresser) runs strict — a `"passthrough"` override on these was removed (#1840) because it handed a Bash/git-capable agent every production secret while processing untrusted GitHub issue/PR/comment content, and the one legitimate need (Home Assistant access) is already served out-of-band by the `ha_list_entities`/`ha_api_request` MCP tools (`writeClawsMcpConfig()` writes the HA token into the MCP server's own env regardless of the child's sanitization mode). LLM provider credentials survive strict mode too: `runCliProcess` layers the backend's own `env` back on top of the sanitised env, so `OPENROUTER_API_KEY` reaches OpenCode/OpenRouter even after stripping. `qa-phase.ts` remains `"passthrough"` because it needs ambient auth to reach a live preview deployment via Playwright. `pr-reviewer.ts`'s three `runClaude` calls were flipped from `capability: "text-only"` to `"tool-use"` (#1879, so the reviewer can verify git facts — diff, blame, file contents — before asserting them, rather than trusting the PR description) **but their `envSanitization` was left at `"passthrough"`**, making pr-reviewer the exception to the "every tool-use site runs strict" rule above. Since `capability` never actually gated tool availability on the Claude CLI (see Gotcha below), this was not a new hole opened by #1879 — the reviewer always had real Bash/git/file access in the PR's worktree while processing untrusted, guarded-but-still-model-visible PR/issue/comment content — but it does mean pr-reviewer is now the only *labelled* `tool-use` site that still runs with ambient production secrets (Slack tokens/webhook, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `NAMEY_DB_URL`, `CLAWS_AUTH_TOKEN`, `CLAWS_OIDC_CLIENT_SECRET`, Gmail app password) in its child env. Anyone hardening the strict/passthrough split further should treat this as the next site to reconcile.
This automated-`runClaude` sanitization is separate from interactive-session env stripping: `sessions.ts`
never calls `sanitiseEnvForChild()` directly, but `capabilities.ts`'s `buildCapabilityEnvArgs()` (called
by `createSession`, `createMultiWorktreeSession`, and `resumeSession`) always strips the same
`SENSITIVE_ENV_KEYS` set in addition to any ungranted capability keys, so a zero-capability interactive
session gets the same baseline protection as a strict-mode automated child (#1944/#1947 — previously
interactive sessions inherited these secrets unconditionally, since `buildCapabilityEnvArgs()` only
stripped the four capability bundles' own env keys).
Both mechanisms strip secrets from a child's *environment*; a separate leak class is putting a secret
on a child's **argv**, which `/proc/<pid>/cmdline` exposes to every local user and to any `ps aux`,
`systemctl status`, or support paste. `capabilities.ts` was the only spawn path in `src/` that did this
(#2138, fixed via the 0600 env file + `/bin/sh` prelude described above). `github-app.ts`'s
`buildEnvForGh`/`buildEnvForGhGit` were audited during that fix and are env-object based throughout —
the inline git credential helper goes through `GIT_CONFIG_VALUE_0` in the env, not the command line.
Any new spawn site must keep credentials off argv.

**Gotcha:** `capability` (`"tool-use" | "text-only"`) is a **routing** hint, not a tool-access gate, when `provider: "claude"` is in play — the Claude CLI is always invoked with the same tool schemas (Bash, Read, Edit, …) regardless of the declared capability; `capability` only selects the model tier (`model-selector.ts`) and which provider fallback order applies. A prompt that needs an actual no-tools guarantee cannot rely on `capability: "text-only"` alone if the resolved provider is `"claude"` — it must either pin a provider that genuinely lacks tool schemas or avoid tool-shaped instructions in the prompt itself (#1876).

An optional model flag is appended when the caller passes a `model`
option (`--model` for Claude CLI, `-m` for Codex CLI). For Claude, the `--output-format json` flag enables structured
output parsing: on completion, `runClaudeCliOnce()` parses the JSON response and
checks the `is_error` boolean. If `is_error` is `true`, or if the CLI outputs
non-JSON (e.g. a usage-limit message), the process rejects with `AgentCliError`
— this prevents error text from being treated as real work output and posted as
PR comments or triggering false reactions. `AgentCliError` carries the
`exitCode`, a truncated (500 char) message, and an optional `numTurns`
property (extracted from parsed JSON output). Three PR description functions exist:
`generatePRDescription()` (issue + diff → PR body for issue-worker),
`generateDocsPRDescription()` (diff-only → PR body for doc-maintainer), and
`regeneratePRDescription()` (full diff → updated body after ci-fixer or
review-addresser pushes; preserves any `Closes #N` / `Part of #N` closing
keywords from the original body so issue auto-close links are not lost).
All use three-dot diff (`origin/base...HEAD`) to
isolate branch changes from concurrent main-branch movement. `pushBranch()`
uses a **fetch-rebase-push retry loop** (up to 3 attempts) to handle
concurrent pushes to the same branch — when a non-fast-forward rejection
occurs, it fetches the latest remote state, rebases local commits on top,
and retries. If the branch doesn't exist on the remote yet (new branches),
the fetch is skipped and push proceeds directly. Rebase conflicts (and their
fallback merge conflicts) abort with `PushConflictError` — a named class
suppressed by the error reporter (logged at warn, no `[claws-error]` issue) since
this is a transient race resolved on the next dispatcher cycle. Each Claude process has a configurable **timeout**
(`CLAUDE_TIMEOUT_MS`, default 6 hours) — on expiry, SIGTERM is sent with a
10-second SIGKILL escalation. Per-item timeout overrides can escalate this
for items that have timed out before (see `timeout-handler.ts`). A **spawn
log line** records PID, working directory, and effective timeouts at process
start for post-mortem analysis. A 5-minute **heartbeat** logs PID, elapsed
time, and stdout byte count for observability.
A configurable **liveness abort** (`claudeLivenessTimeoutMs`, default 6
hours) kills processes that produce zero stdout bytes early, and `runClaude`
automatically retries once on 0-byte timeouts (transient hang recovery).
Timed-out processes throw `AgentTimeoutError` (carries diagnostic fields:
`lastOutput`, `lastStderr`, `outputBytes`, `cwd`) which the error reporter
includes in GitHub issue reports. `writeClawsMcpConfig()` generates MCP
configuration files that give Claude sessions access to the Claws MCP server
(operational state) and optionally additional MCP servers (e.g. Playwright
for QA); the generated `.mcp-claws.json` is written with mode `0o600` (plus an
explicit `chmodSync` to tighten a pre-existing file, since `mode` is ignored on
overwrite) since it can carry secrets such as the Home Assistant token (#1937).

**`db.ts`** — SQLite database at `~/.claws/claws.db`. Fifteen tables: `tasks`
(tracks every job invocation, linked to `job_runs` via `run_id`), `job_runs`
(tracks scheduled job executions), `job_logs` (captures log output per run
via `AsyncLocalStorage` context), `queue_snapshots` (hourly queue depth
snapshots for trend visualization), `workflow_runs` (GitHub Actions
workflow run data synced by `runner-metrics-sync` for runner utilization
analytics — indexed by repo, status, and created_at), `whatsapp_events`
(append-only log of WhatsApp connection state transitions, keyed by
`event_type` values: `connected`, `disconnected`, `restart-required`,
`connection-replaced`, `logged-out`, `auth-cleared`, `message-received`,
`pairing-required`; readable via `GET /whatsapp/events`), `sessions`
(persisted PTY session records — `id`, `tmux_name`, `mode`, `repo`, `cwd`,
`worktree_path`, `extra_worktrees` (JSON array of additional worktrees for
`multi-worktree-claude` sessions), `capabilities` (JSON array of selected capability IDs — persisted so `resumeSession` re-applies env gating and system-prompt injection), `created_at`,
`ended_at` (set when a session's tmux process exits — retains the row as browsable
history instead of deleting it), `resume_repos` (JSON array of repos needed to
reconstruct worktrees for an ended session, see "Session history" above); reconciled with live tmux sessions on startup),
`verification_reports` (connectivity check results written by
`runConnectivityVerification()` — stores a JSON `payload` with per-check
pass/fail results indexed by `ts`; latest row retrieved by `GET /api/activation`
and rendered on the `/verify` page), `work_queue` (SQLite-backed agent dispatch
queue — one row per pending/running/completed agent task; `kind` maps to
`AGENT_KINDS` constants in `worker.ts`; a UNIQUE partial index on
`(kind, repo, item_number) WHERE status IN ('queued', 'running')` is the
idempotency guard preventing double-dispatch; `enqueueWork()` returns `alreadyQueued: true`
on a silent no-op; `claimNextWork()` atomically claims the highest-priority oldest
`queued` row; `recoverWorkOnStartup()` resets stuck `running` rows to `queued`
on restart; `pruneWorkQueue()` deletes completed/failed rows older than 7 days),
and `processed_repos_daily` (smart-scheduling daily per-repo ledger —
primary key `(job_name, repo, local_date)`; `markRepoProcessedDaily()` inserts via
`INSERT OR IGNORE`; `getReposProcessedOn()` returns the processed set for a given
job/date; `getLastProcessedTimestampsForJob()` returns a `Map<repo, epoch-ms>` of most-recent
processing timestamps for fairness-based sorting; rows older than 7 days are
pruned by `pruneProcessedReposDailyOlderThan()`), and `ha_upgrader_state` (one row per
observed HA update entity — tracks `first_seen_at`, `attempted_at`, `failure_count`;
`getAllHaUpgraderStates()` returns all rows for the `/ha-upgrader` dashboard page),
and `ha_deploy_watcher_state` (one row per addon slug — tracks `last_notified_sha`
and `last_seen_at`; used by `ha-deploy-watcher` to deduplicate Slack notifications
across restarts), `notified_untrusted_actors` (durable dedup table for
untrusted-actor Slack notifications — primary key `(repo, issue_number)`;
`markUntrustedActorNotified(repo, issueNumber)` uses `INSERT OR IGNORE` and returns
`true` on the first notification for a given issue, `false` on subsequent calls;
survives process restarts, preventing re-notification on the same blocked item after
a Claws restart), and `damp_readings` (#1819 — one row per logged damp-meter
reading: `location`, `point`, `value` (REAL), `reading_date` (`YYYY-MM-DD`), and
`recorded_at` (full ISO timestamp); indexed on `(location, point)` and on
`reading_date DESC`; `upsertDampReading()` writes a row, `getRecentDampReadings(limit=200)`
returns the most recent rows across all points for the `/damp` history table, and
`getDampTrendRows()` returns every row ordered by `(location, point, reading_date DESC,
recorded_at DESC)` so `pages/damp.ts` can pick the two most-recent rows per point to
compute a trend delta; `initDb()` seeds one idempotent backfill row — `("Hall Closet",
"utility", 0.5, "2026-07-02", ...)` — guarded by a `COUNT(*) = 0` check, since that
point (#1824) was added to `DAMP_POINTS` after the other points' first readings had
already been logged through the UI), and `blog_drafts` (#1849 — one row per
in-progress blog post edit, primary key `(repo, path)`; `content`, `base_sha`
(the GitHub content SHA the draft was based on, used as the base for `putRepoFile()`'s
optimistic-concurrency check), `title` (parsed from the frontmatter `title:` field),
`status` (`'draft' | 'pushed'`), `pr_number`/`pr_branch` (set once pushed);
`upsertBlogDraft()` resets `status` back to `'draft'` on every re-save while leaving
`pr_number`/`pr_branch` untouched, so a subsequent push (#1953) commits onto the
existing PR's branch rather than opening a duplicate PR; `clearBlogDraftPR(repo, path)`
nulls the PR pointer and resets `status` to `'draft'` when the recorded PR turns out
to be closed/merged/deleted, so the next push falls back to opening a fresh PR;
`listBlogDrafts(repo)` orders by `updated_at DESC` for the `/blog` list page).
`updateTaskTokenUsage(taskId, tokensUsed, costUsd)` writes token and cost data into `tasks.tokens_used` / `tasks.cost_usd`. `trackTaskTokens(taskId)` returns an accumulating `onTokensUsed` callback bound to `taskId` — reusable across multiple `runClaude` calls for one task (e.g. triage-claws-errors and pr-reviewer each call `runClaude` 2–3 times per item); accumulates totals and writes the running sum on every invocation via `updateTaskTokenUsage`, so partial accounting is preserved if a later call throws. Used by all agent call sites: review-addresser, issue-worker, ci-fixer, issue-refiner, problematic-pr-diagnoser, idea-suggester, improvement-identifier, doc-maintainer, qa-phase, and public-repo-scanner. `getUsageStats(days)` and `getTotalUsage(days)` aggregate token/cost data over a configurable time window, returning `UsageStats` (breakdowns by repo, job, and provider+model, all sorted by cost descending) and `UsageTotals` (overall counts). Job names are normalised with the same colon-prefix-stripping pattern as `getAllAverageTaskDurations` so `ci-fixer:revert` rolls up with `ci-fixer`. See [Database Schema](database-schema.md).
`completeJobRun(runId, status)` accepts `"completed" | "failed" | "cancelled"`
and includes `AND status != 'cancelled'` in its SQL — this prevents the
scheduler's error handler from overwriting a `"cancelled"` status with `"failed"`
after SIGTERM. `cancelJobRunIfRunning(runId)` atomically sets status to
`"cancelled"` only when the current status is `"running"` (returns `true` if the
row was updated); used by the `/logs/:runId/cancel` endpoint to record
cancellation before sending SIGTERM, so the SQL guard in `completeJobRun` takes
effect.

**`server.ts`** — HTTP server built on the **Hono** framework (via `@hono/node-server` adapter). The public interface is unchanged — `createServer(scheduler)` still returns a native `http.Server`. WebSocket support uses `@hono/node-server` v2's built-in `upgradeWebSocket` backed by a `ws` `WebSocketServer({ noServer: true })` passed to `serve()`. Auth middleware (`requireAuth`, `requireApiAuth`) is implemented as Hono `MiddlewareHandler` and applied per route group (not globally). `apiAuthMiddleware` (applied to `/api/state`) accepts: (1) `INTERNAL_MCP_TOKEN` Bearer unconditionally (loopback/MCP), or (2) a valid `claws_session` cookie when OIDC is enabled. There is no operator-token fallback — every other request returns 401. `isConfiguredRepo(repo)` (checks membership in `listRepos()`, which is itself cached) gates every dashboard route that takes a client-supplied `repo` string and performs a GitHub mutation or reads issue-scoped logs — the GitHub App installation token can reach every repo in the installation, typically a broader set than Claws' managed repos, so an unguarded route would let a client mutate an unmanaged repo (#2221). Routes:

- `GET /` — Dashboard: job status with Last Run/Next Run columns, "Run" buttons, queue overview, integrations status (Slack, Slack Bot, WhatsApp, Email)
- `GET /health` — JSON health check
- `GET /status` — JSON with jobs (including `jobSchedules` with per-job `nextRunIn` countdowns), uptime, queue, integrations (slack, slackBot, whatsapp, email)
- `GET /api/state` — JSON queue state for MCP server consumption (requires API auth)
- `GET /login` — Redirects to authentik's authorization endpoint when OIDC is configured; returns 503 otherwise
- `GET /auth/callback` — OAuth2 OIDC callback — exchanges code, fetches userinfo, issues signed session cookie
- `POST /trigger/:job` — Manual job trigger (returns 200/409/404)
- `POST /pause/:job` — Toggle pause/resume for a job
- `POST /cancel` — Cancel current Claude task
- `GET /queue` — Work queue page; within each section items are sorted flat: all open PRs first (by `updatedAt` desc), then all open issues (by `updatedAt` desc); each item shows an inline per-item category badge (reusing `CATEGORY_DISPLAY` colors) in place of the old category-group headers; also shows CI status, squash & merge, queue position + ETA estimates; includes a "Refresh from GitHub" button; each item's `#N` links to the GitHub issue/PR (PR path when a linked PR exists), with a separate small "logs" link to the Claws log view. That ordering is an explicit owner requirement (#1763: open PRs by last-update desc, then open issues by last-update desc), not an incidental sort
- `POST /queue/refresh` — Triggers `issue-dispatcher` and `pr-dispatcher` to rescan GitHub immediately; returns `{ results: Record<string, string> }` (values: `"started"`, `"already-running"`, `"draining"`, `"unknown"`); always 200 — `"already-running"` is benign (scan already in flight)
- `POST /queue/merge` — Squash-merge a PR from the queue page
- `POST /queue/skip` — Skip an issue/PR (excluded from all job processing)
- `POST /queue/unskip` — Remove skip for an issue/PR
- `POST /queue/prioritize` — Prioritize an issue/PR (processed first)
- `POST /queue/deprioritize` — Remove priority for an issue/PR
- `POST /queue/mark-refined` — Apply `Refined` label to an issue in the `ready` or `needs-refinement` queue category; removes it from the queue cache. The "Refined" button is suppressed in the rendered HTML when the issue already carries the `Refined` label (checked via `item.labels?.includes(LABELS.refined)`) to prevent duplicate label application.
- `POST /queue/mark-automerge` — Applies (creating if needed) the `Automerge` label to a PR; optional `alsoRefine` also applies `Refined` and drops it from the queue cache
- `POST /queue/mark-problematic` / `POST /queue/unmark-problematic` — Manually apply/remove the `Claws Problematic` label on a PR (operator override of the CI-fixer circuit breaker)
- `GET /logs` — Log viewer with per-job filtering and item search
- `GET /logs/:runId` — Individual run detail page with task list
- `POST /logs/:runId/cancel` — Cancel a running job: atomically marks the run `"cancelled"` via `cancelJobRunIfRunning()`, sends SIGTERM to its child processes via `cancelTaskByRunId()`, and returns `{ result: "cancelled" | "not-running" }`
- `GET /logs/:runId/tail` — Live log tail (JSON, polls for new entries)
- `GET /logs/issue` — Issue-specific logs page (`?repo=...&number=...`); returns 404 for a repo that fails `isConfiguredRepo()`
- `GET /config` / `POST /config` — Config viewer/editor (HTML form); displays an "Unknown Config Keys" warning banner when `getUnknownConfigKeys()` returns any entries
- `POST /config/remove-unknown-keys` — Removes all unknown keys from `config.json` via `removeConfigKeys()` and reloads config
- `GET /config/api` — JSON config (sensitive fields masked)
- `GET /api/activation` — Returns `{ state, lastVerification }` (activation state + latest connectivity check)
- `POST /api/activation` — Sets activation state (`{ state: "active"|"verify-only", confirm: true }`); requires restart to register jobs when flipping to `"active"`
- `POST /api/client-error` — Receives client-side JS error reports (fingerprint, message, stack, context) from `ERROR_HANDLER_SCRIPT`; deduplicates via `reportError()` and creates `[claws-error]` issues for novel errors; responds 204, ignores malformed payloads
- `GET /verify` — Connectivity verification page; shows latest `verification_reports` result (database, GitHub App, CLIs, Slack, IMAP, SSH, Ollama, WhatsApp)
- `POST /api/verify/run` — Triggers an on-demand connectivity verification and redirects to `/verify`
- `GET /topology` — Pipeline topology visualization (SVG diagram with live job status)
- `GET /repos` — Repo list page (#2364): a `data-cards` table of every managed repo with open PR/open issue counts (from the 60 s-cached `listPRs`/`listOpenIssues`, fetched at concurrency 8; renders `—` when a fetch fails so a rate-limit trip doesn't masquerade as zero) alongside last-Claws-activity, server-side sortable via `?sort=name|prs|issues|activity` (default `activity`, `getLastTaskTimePerRepo()`)
- `GET /repos/:owner/:name` — Per-repo page: open PRs (with CI status), open issues, recent Claws run logs, 30-day task stats, active worktrees
- `GET /prs` — All open PRs across every managed repo (#2096), sorted by `updatedAt` desc; enriched with a per-repo bulk `listPRStatuses()` fetch (CI status shown for every PR, not just ones in the in-memory queue cache) and, for merge candidates only, `getPRReviewStatus()`; Squash & Merge button gated on mergeable + CI passing/none + clean review (#2110)
- `GET /issues` — All open issues across every managed repo (#2096), sorted by `updatedAt` desc; each row has a Refined button (hidden if already `Refined`) reusing the queue page's `markRefined` client handler (#2099)
- `GET /claude-auth` — Reauth page (#2082) for refreshing the `claude` CLI's subscription OAuth credential from the browser
- `POST /api/claude-auth/start` — Begins the `claude setup-token` PTY flow, returns the OAuth URL once available
- `POST /api/claude-auth/code` — Submits the pasted authorization code to complete the flow
- `GET /api/claude-auth/status` — Polls login status (`awaiting-url`/`awaiting-code`/`completed`/`failed`)
- `GET /whatsapp` — WhatsApp status/pairing page
- `GET /whatsapp/pair` — SSE endpoint streaming QR codes for pairing
- `GET /whatsapp/events` — Recent WhatsApp connection events (JSON, `?limit=N`, max 200; requires auth)
- `POST /whatsapp/unpair` — Clear WhatsApp auth state
- `GET /runners` — Runner utilization page (active workflow runs, per-repo stats, per-`(repo, workflow_name)` stats with a Repository column so identically-named workflows in different repos are not merged, cancel buttons for queued runs). Both tables include a `Total Duration` column (`totalDurationS` — sum of completed run durations); the "By Workflow" table is sorted by total duration descending.
- `POST /runners/cancel` — Cancel a queued GitHub Actions workflow run (only `queued` status, not `in_progress`); throws (→ 403) for a repo that fails `isConfiguredRepo()`
- `GET /usage` — Token/cost usage dashboard; `?days=1|7|30` (defaults to 7, invalid values fall back to 7) selects the `getUsageStats`/`getTotalUsage` aggregation window; breaks down by repo, job, and provider+model sorted by cost descending
- `GET /sessions` — Interactive session list page
- `POST /sessions/create` — Create a new PTY session; redirects to `/sessions/:id`
- `POST /sessions/create-multi` — Create a multi-repo session (≥2 repos required); calls `createMultiWorktreeSession`; redirects to `/sessions/:id`
- `GET /sessions/:id` — Terminal page (xterm.js over WebSocket)
- `POST /sessions/:id/kill` — Kill a session
- `POST /sessions/:id/resume` — Resume an exited session: recreates worktrees at the original path and relaunches `claude --continue`; calls `resumeSession(id)`
- `POST /sessions/:id/delete` — Permanently delete an ended session's history row
- `GET /sessions/:id/ws` — WebSocket endpoint for PTY I/O
- `GET /jobs` — Per-repo job enable/disable matrix page
- `POST /jobs` — Save `disabledJobsByRepo` config changes from matrix UI
- `GET /ha-upgrader` — Home Assistant update state page; categorizes DB rows from `getAllHaUpgraderStates()` into pending/applied/failing/blocked sections with dwell-window countdown ETAs
- `GET /damp` — Damp meter reading page (#1819); renders the log form, trends table, and recent history from `getDampTrendRows()` / `getRecentDampReadings(200)`; `?saved=1` shows a "Saved ✓" banner
- `POST /damp/log` — Logs one row per non-empty numeric field (`p0`, `p1`, … indexed into `DAMP_POINTS`) for the submitted `reading_date` (defaults to today if malformed); redirects to `/damp?saved=1`
- `GET /k8s` — Kubernetes integrations page; shows k3s and prod-k8s monitor status, recent monitor runs, and a link to open `Priority`-labelled alert issues for each cluster
- `GET /blog` — Blog post list page (#1849); merges posts fetched live from `BLOG_REPO`/`BLOG_CONTENT_DIR` with in-progress `blog_drafts` rows; `?pushed=<PR#>` / `?error=badpath|push` show a flash banner
- `GET /blog/edit` — Blog post editor; `?new=1` opens a blank post from `NEW_POST_SKELETON`, `?path=...` opens an existing post — prefers the stored draft (if any) over the live GitHub content so cross-browser edits aren't lost, else fetches via `fetchRepoFileWithSha()`; the PR link is shown whenever the draft has a recorded `pr_number`, regardless of `status`, so it stays visible after a further edit resets `status` back to `'draft'`
- `POST /blog/save` — Validates the path via `isValidBlogPath()` (re-renders the form with the submitted content on failure, never discarding what was typed), upserts a `blog_drafts` row, and — only when `action=push` (#1953) — reuses the draft's recorded `pr_branch` when `getPRState()` reports the PR is `OPEN` (committing via `putRepoFile()` against the branch's blob sha, skipping the commit when content is unchanged), and only creates a new branch + PR via `createPR()` when there is no recorded PR or the recorded one is closed/merged/missing (in which case `clearBlogDraftPR()` drops the stale pointer first); either path ends by marking the draft `pushed` via `setBlogDraftPushed()`
- `GET /manifest.webmanifest` — PWA web app manifest (#1818, from `pwa.ts`)
- `GET /static/icon-{180,192,512}.png`, `GET /apple-touch-icon.png`, `GET /apple-touch-icon-precomposed.png` — PNG app icons rasterized on demand from `APP_ICON_SVG` via `getAppIconPng(size)` (memoized per size, `sharp`-backed)

Supports dark/light/system themes. **Authentication is fail-closed — nothing
runs open:**

- **OIDC configured** (when `oidcClientId`, `oidcClientSecret`, `oidcBaseUrl`,
  and `oidcApplicationSlug` are all set): `GET /login` redirects immediately to
  authentik's authorization endpoint. After authentication, `/auth/callback`
  exchanges the code for a token, fetches userinfo, and issues a signed session
  cookie (`claws_session`), which is the only browser credential accepted.
  Programmatic access (the MCP server) uses the loopback-scoped
  `INTERNAL_MCP_TOKEN` Bearer on `/api/state`. The `next=` query parameter on
  `GET /login` is validated: it must start with `/`, must not start with `//`,
  and must not contain a backslash — any path that fails these checks falls
  back to `"/"` to prevent open-redirect attacks (e.g. `/\evil.example` being
  interpreted as a host by some browsers). There is deliberately **no in-app
  identity allowlist** in `/auth/callback` — any `sub`/`email` that reaches the
  callback is treated as authorized. This is not an oversight: dashboard
  authorization is enforced upstream by version-controlled Authentik group
  policy bindings (`fleet-infra` repo, `apps/authentik/configmap-blueprints.yaml`)
  restricting completion of OIDC authorization for the claws-app application to
  members of specific groups (`policy_engine_mode: any`). A user who can
  authenticate to the IdP but isn't in an allowed group is rejected at the
  application-authorization step and never reaches the callback with a valid
  code. Adding a second allowlist here would duplicate that authorization
  across two systems (drift hazard) for what is a single-tenant deployment. See
  the comment at the top of the session-minting code in `/auth/callback` in
  `server.ts`.
- **OIDC not configured**: every authenticated route returns **503**
  ("configure OIDC"). The dashboard and API never serve content without a
  session, so the `OIDC_*` variables must be set in `~/.claws/env` before first
  boot — there is no web-UI bootstrap path and no static token. The only thing
  that still works is the loopback `INTERNAL_MCP_TOKEN` on `/api/state`.
- **Authentik endpoint-slug quirk**: the authorize (`/application/o/authorize/`),
  token (`/application/o/token/`), and userinfo (`/application/o/userinfo/`)
  endpoints are built **without** `oidcApplicationSlug` in the path — only
  `end-session` (`/application/o/<slug>/end-session/`) is slug-scoped.
  Interpolating the slug into the authorize/token/userinfo URLs 404s the very
  first step of login and was filed twice independently against the same
  regression (#1567, #1568). `oidcApplicationSlug` is still required for
  `end-session` (logout) and for the "OIDC configured" check above.

All dashboard mutation endpoints
send Slack notifications (gated by `notifyDashboardActions` config, default
`true`) with only an action description — no client IP is attached, since
there is no trusted reverse proxy in front of Claws and the
`x-forwarded-for` header is fully client-suppliable, making it unsafe for
audit attribution.

**`format.ts`** — Duration formatting utility. Exports `formatMs(ms)` which
converts milliseconds to human-readable strings: `0ms`, `5s`, `1m 5s`, `2m`,
`1h 30m`, `6h`. Used across `claude.ts`, `github.ts`, `scheduler.ts`,
`main.ts`, and `whatsapp.ts` for log messages and error reports. Replaces
ad-hoc `/ 1000` and `/ 60_000` conversions with a single consistent formatter.

**`plan-parser.ts`** — Parses structured implementation plan comments into
discrete phases for multi-PR workflows. Looks for `### PR N:` or `### Phase N:`
headers to split a plan into phases. Also provides `findPlanComment()` to locate the
most recent plan comment in an issue's comment history, `getPlanUpdatePhase()`
to read the `plan-updated-after-phase:N` marker from plan text,
`makePlanUpdateFooter()` to generate the plain-text footer
appended after plan updates, `getRecommendedModel()` to extract the
recommended model tier (`cheap`/`sonnet`/`opus`), and
`extractModelsAttribution()` to extract any existing `*Models used:...*` attribution
line for reuse in refinements. The `Provider` type is exported for use by
`model-selector.ts`. Plans embed only a model tier recommendation — provider
selection is handled entirely by the capability-specific fallback order config
(`TOOL_USE_PROVIDER_FALLBACK_ORDER` / `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`), not by
plan annotations. Used by issue-worker to implement multi-phase plans
sequentially and update the plan between phases. `stripVerbosePreamble()`
strips verbose introductory filler (`"I'll analyze..."`, `"Let me examine..."`,
etc.) commonly produced by OpenCode plan output before it's posted as a plan
comment — OpenCode-authored plans were otherwise mostly preamble noise ahead
of the actual plan, or in the worst case only the preamble with no plan text
at all (#910).

**`log.ts`** — Timestamped console logging with four levels: `debug`, `info`,
`warn`, `error`. Errors also trigger Slack notifications. All log calls capture
output into the `job_logs` table via `AsyncLocalStorage`-based run context, so
logs are associated with the job run that produced them. `errorAndFlush(msg)`
is an awaitable variant of `error()` that waits (up to 5 s) for the Slack
webhook POST to complete — required before `process.exit()`, since `notify()`
is otherwise fire-and-forget and the pending request dies with the process.
Used by the two fatal PID-lock failure paths in `main.ts`.

**`ollama-rate-limit-classifier.ts`** — Classifies whether a CLI error string
represents a usage/rate-limit error. Primary strategy: sends the error text to a
local Ollama instance (`llama3`) via POST `/api/generate` with a long timeout
(`OLLAMA_TIMEOUT_MS`, default 60 seconds, to accommodate cold GPU starts) and
parses a YES/NO response. Falls back to `RATE_LIMIT_RE` regex on any failure.
A **circuit breaker** disables Ollama for 5 minutes after
`OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE` consecutive failures (default 3).
`clearOllamaAvailabilityCache()` resets state for test isolation. Used by
`claude.ts` provider fallback logic to decide whether to mark a provider as
rate-limited.

**`error-reporter.ts`** — On error: logs to console + Slack, then (with a
30-minute per-fingerprint cooldown) calls `ensureAlertIssue()` from `occurrence-tracking.ts`
to either edit the body of an existing `[claws-error]` issue in `SELF_REPO` (bumping the
occurrence count) or create a new one with an initial occurrence-tracking block appended.
Recurrences no longer post new comments — only the issue body is updated, eliminating
comment spam for repeated errors. The module-level `lastReported` cooldown map is
otherwise unbounded for the life of the long-running service process; `sweepExpiredCooldowns(now)`
(#2291) lazily deletes entries older than `COOLDOWN_MS` at the top of `reportError`,
`reportFailedAttachments`, and `reportMemoryLimitOnItem` — behaviour-preserving, since an
expired entry can no longer suppress a report anyway. These issues are then picked up by the
triage-claws-errors job for automated investigation. Several error
conditions are filtered before any reporting: `ShutdownError` (logged at info level —
shutdown cancellations are expected), `RateLimitError` (logged at warn
level — handled by the circuit breaker, not actionable bugs),
`TransientGitHubError` (#2036/#2039; logged at warn level — a `gh` call whose
final failure, after `gh()`'s own retries, was a GitHub-side `HTTP 500/502/503/504`;
self-healing since the dispatcher retries the item next cycle, so it must not open
a `[claws-error]` issue the way an unclassified `Error` carrying the same "HTTP 503"
text would),
`PushConflictError` (logged at warn level — transient race where another actor
pushed to the same branch concurrently; the dispatcher retries on the next cycle),
`AgentCliError` matching usage-limit messages (`USAGE_LIMIT_RE`:
`/you're out of .* usage|hit your limit/i` — transient credit exhaustion,
downgraded to warn), and `AgentCliError` matching transient Anthropic API errors
(`API_TRANSIENT_RE` — Anthropic API 5xx errors and unexpected socket closures, downgraded
to warn). Other `AgentCliError` instances (auth failures, unknown CLI errors)
flow through to the normal reporting path. When the error
is a `AgentTimeoutError`, the report includes a diagnostics section with
working directory, stdout byte count, whether Claude was producing output,
and collapsible last stdout/stderr snippets. Also exports
`reportTimeoutOnItem()`, which posts a comment on the source issue/PR when
a CLI timeout occurs, informing the user of the timeout count, any
escalation, and whether the item was auto-skipped. Also exports
`reportFailedAttachments()`, which creates or comments on a deduplicated
`[claws-error] Attachment download failures` issue in `SELF_REPO` when
`processTextForImages()` cannot download one or more referenced files — the
fingerprint is scoped per source issue (`attachment-download-failures:<repo>:<number>`)
with the same 30-minute cooldown. Failed URLs are listed in backticks (not
markdown image/link syntax) to prevent re-triggering the image extractor on
the generated issue body.

**`timeout-handler.ts`** — Central per-item timeout escalation logic. When a
`AgentTimeoutError` occurs, `handleTimeoutIfApplicable()` counts recent
timeouts for that item (via `db.countRecentTimeouts()`, 2-hour window) and
either escalates the timeout by 1.5x (capped at 6 hours) or auto-skips the
item after 3 timeouts. Escalated timeouts are persisted via
`itemTimeoutOverrides` in `config.json`. Jobs call `getItemTimeoutMs()` to
retrieve any per-item override before invoking Claude. For repo-level jobs
that have no issue number (e.g. `improvement-identifier`, `doc-maintainer`),
`itemNumber` is `0` — auto-skip and comment-posting are suppressed (no issue
to skip or comment on), but timeout escalation still applies so subsequent
runs use a larger budget. Returns `Promise<boolean>` (true = item was skipped).
`handleMemoryLimitIfApplicable()` counts recent memory-limit kills for that
item (via `db.countRecentMemoryLimits()`, 2-hour window) and either posts a
feedback comment (below threshold) or auto-skips the item via `gh.skipItem()`
after 3 kills (no timeout escalation — memory kills have a fixed cap).
Bounded by a 30-minute cooldown in `reportMemoryLimitOnItem`. Repo-level jobs
(item number 0) only log at warn — no comment or skip. `reportError()` suppresses
the `[claws-error]` alert for memory kills so they don't create noise in the
Claws repo.

**`outcome.ts`** — Task outcome builders used by agents to record structured
metadata on completed/failed tasks. Exports `buildSuccessOutcome()` (extracts
commit count and diff stats from the worktree), `buildFailureOutcome()`, and
`categorizeFailure()` (maps error types to failure categories: `timeout`,
`shutdown`, `rate-limit`, `push-rejection`, `git-conflict`, `ref-not-found`,
`transient-api`, `payload-too-large`, `unknown`). `BranchDeletedError` maps to
`ref-not-found` by error name; `PushConflictError` maps to `git-conflict` via the
`"Rebase onto origin/"` substring in its message; transient Anthropic 5xx errors match via
`"API Error: 5"` substring. (The direct-HTTP OpenRouter provider and its
`OpenRouterClientError` class — HTTP 4xx non-429 errors like context-too-long —
were removed in #2229; text-only workflows now default straight to Claude.)

**`occurrence-tracking.ts`** — Shared helpers for recurring alert issues. Body-level exports:
`appendOccurrenceTracking(body, timestamp, initialCount?)` appends a `---`-separated block with
`**First seen:**`, `**Last seen:**`, and `**Occurrences:**` lines to an issue body.
`updateOccurrenceTracking(body, timestamp)` increments the count and updates `**Last seen:**` in
an existing block (matched by the block's regex). `applyOccurrenceTracking(currentBody, timestamp)`
combines both — if the body already has tracking it calls `updateOccurrenceTracking`; otherwise it
retroactively appends with count=2 (the caller just observed a recurrence). The higher-level
`ensureAlertIssue({ repo, title, body, labels?, timestamp?, logPrefix, legacyTitles?, refreshBody? })`
does the full search → update-or-create flow: searches for an open issue with the given exact title,
calls `applyOccurrenceTracking` + `editIssue` on a hit (warning on regex-miss), or `createIssue` with
`appendOccurrenceTracking(body, timestamp)` on a miss. Returns `{ outcome: "created" | "updated"
| "tracking-not-updated", issueNumber }`. Used by `error-reporter.ts` (both `reportError` and
`reportFailedAttachments`), `main.ts` (unknown-config-key reporting), and `k3s-monitor.ts` / `runner-monitor.ts`.
Two opt-in options support alert titles that have been re-keyed (both no-ops when omitted, so every
other caller is unaffected):
`legacyTitles` — pre-rename titles for the same alert. When set, the lookup switches from a plain
`findIssueByExactTitle` call to `findExistingWithLegacyTitles()`, which scans the same underlying
cached `listOpenIssues(repo)` result for the new title or any legacy title in one pass (both paths
are cached-list lookups since #2289 retired `gh search issues`); if no issue carries the new title but one carries a legacy title, it is
renamed via `editIssueTitle` instead of a duplicate being filed, and any extra legacy matches are
commented ("Superseded by #N") and closed `not_planned` best-effort. `refreshBody` — replace the whole
issue body with `body` on update via `rebuildOccurrenceTracking(newBody, currentBody, timestamp)`,
which carries `First seen` forward (`parseFirstSeen`) and increments `Occurrences`; for alerts whose
body describes state that changes between runs. This path always counts as matched, so it never
returns `tracking-not-updated`, and it discards hand-edited body prose. Both are used by
`k3s-monitor.ts` for workload-keyed pod alerts (issue #2298).
`parseOccurrenceCount(body)` — pure parser that extracts the `**Occurrences:** N` integer from
an issue body; returns `null` when absent. Used by `issue-dispatcher` to detect when an alert
issue has recurred enough since its plan was written to warrant a re-plan.

**`prompt-guard.ts`** — Prompt injection detection for user-submitted content.
`scanContent()` checks text against four pattern categories: instruction
overrides, zero-width characters, HTML comment injections, and base64-encoded
payloads. `guardContent()` wraps scanning with automatic redaction of
suspicious sections and Slack audit notifications. Claws-authored content
(identified via `isClawsComment()`) is never passed through `guardContent()`
— only human-authored comments, issue bodies, PR review text, and WhatsApp
inbound messages are guarded, preventing false positives from Claws' own
structured output. The `whatsapp-handler` guards the message text inline in
the prompt (via `makeGuardCtx("whatsapp", 0)` / `guardContent(text, guardCtx("whatsapp-message"))`)
while leaving the issue body raw — the body is plain data posted to GitHub,
not an instruction context, so redaction markers there would degrade the issue.
`formatGuardedTitleList(titles, guardCtx, source)` — shared helper used by
`improvement-identifier` and `idea-suggester` to build an indented Markdown
bullet list of GitHub-supplied issue/PR titles, passing each through
`guardContent()`. Returns `"  (none)"` for empty lists.
Every GitHub-supplied string interpolated into a prompt or a comment `ci-fixer.ts` posts must be
guarded — including `occ.pr.title` in `fileUnrelatedIssue()`'s `[ci-unrelated]` tracking comment
(#1812) and `pr.title` in issue-worker's `postPhaseProgressComment()` (#1860). Both comments are
posted via `gh.commentOnIssue()`, which stamps them with the Claws marker, so
`formatIssueCommentsForPrompt()` later treats them as self-authored and skips `guardContent()`
when reading them back — an unguarded, attacker-influenceable PR title would otherwise become a
permanently-trusted prompt-injection vector reachable by the opus-tier issue-refiner planner. See
also `CLAUDE.md`'s "Common gotchas" entry for this invariant.

**Guard once, reuse the guarded value**: guarding a piece of GitHub-supplied text at one embedding
site does not cover every other place the same underlying value is re-embedded — each additional
appearance (a second interpolation into the same prompt, or into a different comment/file) needs
either the already-guarded variable reused or an independent `guardContent()` call. Three fixes
converged on this pattern from separate angles: `triage-claws-errors.ts` guards `errorDetails.fingerprint`
once (`guardedFingerprint`) and reuses that single value at both of its embedding sites rather than
re-embedding the raw fingerprint a second time, and also guards it before writing it into the
self-authored "Known Fingerprints" comment (#1868/#1869); `doc-maintainer.ts` guards `issue.title`
before writing it into a `.plans/*.md` file, since that file is later read back by planning/implementing
agents just like a self-authored GitHub comment would be (#1870).

`formatInjectionComment()` quotes the actual matched span (`m.matched`) inside a code fence in its
own Claws-authored alert comment when `scanContent()` flags something — but that comment is
subject to the exact same unguarded-read-back risk, and `guardContent()` can't be applied to the
quoted span itself (it would redact the whole phrase and defeat the point of the report). Instead
`defangPhrase()` (`prompt-guard.ts`) inserts zero-width spaces (`\u200B`) into the quoted text
before it's fenced: breaking `<!--`/`-->` sequences so an HTML-comment-injection match can't
re-parse as a real comment, and splitting common instruction-trigger words (`ignore`, `disregard`,
`override`, `system`, `prompt`, etc.) so they read normally to a human but no longer match as clean
tokens to a scanner or LLM on read-back (#1862).

**`mcp-server.ts`** — Standalone stdio-based MCP (Model Context Protocol)
server that exposes Claws operational state to Claude sessions. Spawned by
Claude CLI via `--mcp-config`. Intentionally self-contained — imports only
`namey-query.js` and `ha-mcp.js` from the Claws source tree and avoids importing `config.ts`
or other main-process modules (e.g. `home-assistant.ts`), so it can run as a
stdio child of the Claude CLI without dragging in the full config loader or
its transitive dependencies. Provides four core tools: `claws_status` (running
tasks, queue items, Claude queue counts), `claws_task_history` (recent task
history filtered by repo/issue), `claws_open_prs` (open PRs via `gh` CLI),
`claws_config` (skip and priority lists); plus `namey_query` (read-only SQL
queries against the namey production PostgreSQL database) registered only when
`NAMEY_DB_URL` is configured; plus `ha_list_entities` (projects `/api/states` to
`{ entity_id, state, friendly_name }`, filterable by domain or search substring,
capped at 500) and `ha_api_request` (generic passthrough to any `/api/…` endpoint,
GET/POST, non-JSON bodies handled as raw text) registered only when both
`HOME_ASSISTANT_BASE_URL` and `HOME_ASSISTANT_TOKEN` env vars are present.
Reads from the SQLite database (read-only), the
Claws HTTP API (`/api/state`), and optionally the namey PostgreSQL database or
Home Assistant REST API.

**`namey-query.ts`** — Handler logic for the `namey_query` MCP tool, extracted
for testability. `handleNameyQuery()` validates SQL via `sql-validation.ts`
(rejects multi-statement queries, enforces a 500-row LIMIT cap), acquires a
pooled PostgreSQL connection, wraps the query in `BEGIN TRANSACTION READ ONLY`,
and races it against a 30-second client-side abort timer. On timeout, the
connection is destroyed (not returned to pool) to avoid blocking on the
in-flight query. On success or error, `statement_timeout` is restored before
releasing the connection to prevent `set_config()` bypass attacks.

**`sql-validation.ts`** — SQL validation helpers for `namey-query.ts`. Exports
`isMultiStatement(sql)` (detects semicolons outside string literals and
comments via a single-pass tokenizer) and `ensureLimit(sql)` (appends
`LIMIT 500` if missing, caps existing LIMIT/FETCH FIRST clauses to 500).
The tokenizer strips single-quoted string literals, block comments, and line
comments to prevent bypass via `'LIMIT 10'` or `-- LIMIT 1`. Parenthesized
subqueries are stripped before checking so inner LIMITs don't satisfy the
outer-level check. Does not handle PostgreSQL dollar-quoting — false positives
only, not false negatives. The extended query protocol (`values: []`) is the
real single-statement guard.

**`images.ts`** — Extracts image references (markdown `![](url)` and HTML
`<img>` tags) from issue/PR text, downloads them (up to 10 images, 10 MB
each, 30s timeout), and writes them into the worktree under `.claws-images/`.
Also extracts GitHub file attachments (`[filename](github-attachment-url)`),
downloads them (up to 5 attachments, 1 MB each), validates UTF-8 encoding,
and truncates large text content (100K char limit, keeps first/last halves).
Auto-detects the GitHub token for private image access. Skips badges, data
URLs, and binary attachment types. `extractImageUrls(text, format)` takes a `"markdown" | "html"` format
(default `"markdown"`, matching every caller but `processTextForImages`'s HTML-body branch) and calls
`stripCodeRegions(text, format)` before running URL-extraction regexes to remove inline code spans, fenced
code blocks, and `<code>`/`<pre>` HTML regions — preventing false positives from code examples
that contain image-like syntax in backticks. In `"html"` mode only the `<img>`-tag pass runs; the
markdown-syntax pass is skipped, because GitHub renders every real markdown image into an `<img>` tag, so
markdown image syntax still literally present in rendered HTML is by definition escaped text inside
`<code>`/`<pre>` (GitHub HTML-entity-encodes it, e.g. `&lt;owner&gt;`) or plain prose — not a real image.
Before this fix (#2247) both passes always ran, and the markdown pass (which never entity-decodes) matched
that escaped syntax verbatim inside a rendered `<code>` span, producing an unreachable URL that 404'd and
filed a spurious `[claws-error]` alert. URL candidates are then
validated with `isUsableImageUrl()` (must be `http:`/`https:` or `data:`) to
reject fragments, relative paths, or other regex surprises. Same code-region
stripping is applied to `extractAttachmentUrls()`. **SSRF protection**: `assertPublicHost(rawUrl)` (exported) guards every fetch — it parses the URL, rejects non-http(s) protocols and localhost, and DNS-resolves hostnames via `dns.lookup({all:true})` requiring every returned address to pass `isPrivateIp()` (private IPv4 ranges: loopback 127/8, link-local 169.254/16, RFC-1918 10/8, 172.16/12, 192.168/16, "this network" 0/8, CGN 100.64/10, multicast 224/4, reserved 240/4; private IPv6: loopback `::1`, unspecified `::`, link-local `fe80::/10`, unique-local `fc00::/7`, multicast `ff00::/8`, plus IPv4-mapped `::ffff:*/96` via embedded v4 re-check). `fetchWithGuard(url, token, controller)` is an internal helper that calls `assertPublicHost` then fetches with `redirect:"manual"`, following up to `MAX_REDIRECT_HOPS` (3) redirects with a fresh `assertPublicHost` and GitHub token re-evaluation per hop (never carries auth to a non-github host). Both `downloadImages` and `downloadAttachments` use `fetchWithGuard` in their per-URL loops. **Auth header strategy**: `private-user-images.githubusercontent.com` pre-signed URLs are
fetched without auth (sending a token would invalidate the JWT signature);
all other `github.com` and `githubusercontent.com` URLs — including
`github.com/user-attachments/` — are fetched with the installation token,
except that repo-scoped GitHub URLs (`github.com/<owner>/<repo>/…`,
`raw.githubusercontent.com/<owner>/<repo>/…`,
`media.githubusercontent.com/media/<owner>/<repo>/…`) only receive the token
when `<owner>/<repo>` matches the repo currently being processed —
`extractRepoFromGitHubUrl()` (exported) positively identifies the URL's
owner/repo, and `shouldAttachGitHubToken()` withholds the token on a mismatch
— because installation tokens are owner-wide, not repo-scoped, so an
unchecked cross-repo URL in a comment would let a collaborator on one repo
read a private sibling repo under the same GitHub App installation. URLs that
can't be mapped to a repo (e.g. `user-attachments` assets, which are
UUID-addressed) are unaffected by this check.
The main entry point `processTextForImages(texts, wtPath, repo?, posting?,
htmlBodies?)` runs both pipelines and returns a combined prompt section. When
`htmlBodies` is provided (rendered `body_html` from GitHub's REST API), image
URLs are extracted from the HTML rather than the raw markdown — `body_html`
contains pre-signed `private-user-images.githubusercontent.com` URLs that are
directly downloadable, making private-repo images accessible. Both
`downloadImages` and `downloadAttachments` return a two-part result:
`downloaded` and `failed`. Non-OK HTTP responses from any URL are classified
as `failed` and trigger `reportFailedAttachments()` to create a `[claws-error]`
issue; failed URLs are surfaced in the user-facing warning comment so Claude
knows the files were absent. Since that comment is self-authored by Claws (never
re-guarded on read-back), each failed URL is passed through `guardContent()`
before interpolation, both in the comment built here and again independently in
`reportFailedAttachments()` — an unreachable URL is still attacker-controlled
text and would otherwise become a permanent prompt-injection channel (#1842).
Used by issue-refiner, issue-worker, and review-addresser to give Claude visual
and file context.

## Other Top-Level Modules

**`smart-schedule.ts`** — Smart-scheduling gate + staleness-based per-repo selection (isClawsBusy check with SLO escape valve, selects repos with age ≥ targetStalenessMs, forces SLO-breached repos through even when busy); also exports `runDailyRepoLoop(jobName, repos, processRepo)`, a shared daily-repo-processing loop (rate-limit check that breaks the loop, per-repo error reporting fingerprinted `${jobName}:process-repo`, then `db.markRepoProcessedDaily` unconditionally) extracted from `idea-reconciler` and `stale-branch-cleaner` (#1978) — both jobs' `run()` now just delegate to it. Also exports `withDailyRepoMarking(jobName, repoFullName, fn, onError?)` (#1992), a concurrent-variant wrapper for smart-scheduled jobs that fan out a single repo's processing with `Promise.all`/`allSettled` rather than looping sequentially — runs `fn`, and on throw either returns `onError(err)` (if supplied) or rethrows, always calling `db.markRepoProcessedDaily` in a `finally` so staleness selection can never miss a repo whose handler forgot to mark it; used by `doc-maintainer`, `idea-suggester`, `improvement-identifier`, `public-repo-scanner`, `dependabot-alert-monitor`, and `issue-auditor`'s `processRepo` functions

**`capabilities.ts`** — Session capability registry — defines three gated capability bundles (home-assistant, prod-infra, fleet-infra) plus eight hardcoded `ssh:<alias>` capabilities (#1985; e.g. `ssh:nas`, `ssh:homeassistant`, `ssh:k3s`, `ssh:hetzner-actions-runner`, `ssh:hetzner-beefy-actions`, `ssh:ryzen`, `ssh:k3s-nas`, `ssh:proxmox`) — the SSH capabilities inject no env vars (auth is via on-disk keys already present on the Claws host) so `envKeys: []` and `resolve()` always returns `{}` (always-available, never null), and exist purely to drive the session-create checkbox UI and tell the model via `buildCapabilityPrompt` which hosts it may SSH to; exports `resolveCapabilityEnv` (pure: returns `{ vars, stripKeys }` for a selection) and `buildCapabilityEnvArgs(selected, envFilePath)` (strips every gated + sensitive env key via `env -u` — granted keys included since #2138, so a session can never silently inherit an ambient value — and, when `envFilePath` is non-null, appends a `/bin/sh -c '. "$1"; rm -f "$1"; shift; exec "$@"' claws-session <path>` prelude that sources the granted values from a 0600 file written by `session-env-file.ts`; granted values are **never** placed on argv, which is world-readable via `/proc/<pid>/cmdline` — that was the HA-token leak in #2138 — since #1944/#1947 this also always strips the full `SENSITIVE_ENV_KEYS` set, imported from the zero-dependency `sensitive-env.ts` leaf module to avoid pulling `claude.ts`'s heavy import tree into `capabilities.test.ts`, so a zero-capability interactive session no longer inherits Slack/OIDC/OpenRouter/OpenAI/Gmail secrets from `process.env`) and `buildCapabilityPrompt` (generates `--append-system-prompt` text listing only granted capabilities — returns "" when nothing is granted; the caller still always emits `--append-system-prompt` since #2360, now carrying just `SESSION_WORKFLOW_PROMPT`); `CAPABILITIES` registry reads live config bindings at call time to reflect reloads

**`slack.ts`** — Slack incoming-webhook + Bot API (ideas, notifications)

**`model-selector.ts`** — Provider-aware model selection (Claude/Codex/OpenCode, cheap/sonnet/opus tiers, config override)

**`classify-complexity.ts`** — Lightweight Claude call to classify whether a task warrants opus-level reasoning. Accepts `defaultOnFailure` option (defaults to `"sonnet"`; ci-fixer, triage jobs, and improvement-identifier are the current callers — the issue-refiner planner does NOT use this and is hardcoded to opus. Pinned to provider="claude" because the OpenRouter direct backend has a 32 K context limit that overflows on large prompts.)

**`whatsapp.ts`** — WhatsApp Web client (Baileys) — QR pairing, message routing, Slack pairing alerts; `downloadAudio` enforces the 25 MB cap while streaming (not after buffering) so oversized/malformed media cannot drive memory up before the check; the Baileys auth directory (`~/.claws/whatsapp-auth`) is created with mode 0o700 and explicitly `chmod`ed on every connect (#2148), matching the 0o600 handling of `config.json` and `~/.claws/env`; auth state is cleared only on status 401 (loggedOut) or 500 (badSession) — all other disconnects (405, 440, 408, 428, unknown) retry with backoff capped at 5 minutes and a one-shot Slack alert after 5 consecutive failures

**`transcribe.ts`** — Voice-note transcription — tries same-VM Whisper (`whisperLocalUrl`) first, then remote Whisper (`whisperBaseUrl`), each with a per-URL circuit-breaker (disabled for 5 min after 3 consecutive failures), falls back to OpenAI Whisper API; `isAvailable()` returns true if any backend is configured; self-hosted requests send `WHISPER_MODEL` (default `Systran/faster-whisper-base`) as the model field, never the OpenAI-only `"whisper-1"` alias (#1931)

**`version.ts`** — Build-time injected version string

**`ha-mcp.ts`** — Standalone HA MCP handler — `ha_list_entities` (projects /api/states to entity_id/state/friendly_name, filterable by domain/search, capped at 500) and `ha_api_request` (generic passthrough to any `/api/…` endpoint, GET/POST); imported by mcp-server.ts; path validation resolves `opts.path` via `new URL(opts.path, baseUrl)` first, then checks the resolved URL's `origin` (must match HA host — rejects absolute URLs, protocol-relative paths, and `@`/backslash host-swap variants) and `pathname` (must start with `/api/` — prevents percent-encoded traversal like `/api/%2e%2e/config` since the pathname is post-normalization); `fetch` is called with the resolved `URL` object, never via string concatenation; never includes token in error messages; no config.ts imports

**`worker.ts`** — SQLite-backed work queue — `N` worker fibers (default 2, `MAX_WORK_WORKERS`) claim rows from `work_queue`, execute registered handlers, handle `ShutdownError`/`RateLimitError`/timeout escalation, and recover stuck `running` rows on startup via `recoverWorkOnStartup()`; exports `AGENT_KINDS` constants, `enqueue()`, `registerHandler()`, `workerStatus()`, and `start()`

**`work-handlers.ts`** — Registers all per-kind work handlers with `worker.ts` via `registerAll()` — one handler per `AGENT_KINDS` constant; each handler re-fetches the live issue/PR state before invoking the agent, ensuring stale queue entries are handled gracefully; also wires the auto-merger sweep chain (every agent handler that mutates a PR enqueues an `AUTO_MERGER_SWEEP` in its `finally` block)

**`retry.ts`** — `retryWithBackoff(fn, maxRetries, isTransient, label)` — generic exponential-backoff retry helper (1s/2s/4s delays) extracted from `gh()` and `git()`; callers supply their own `isTransient` predicate

**`rate-limit.ts`** — GitHub API rate-limit circuit breaker (#2108) — extracted from `github.ts` into a leaf module (no imports from `github.ts`/`github-app.ts`) so both can depend on it without a circular import. Exports the `RateLimitError` class, `isRateLimited()`/`setRateLimited(cooldownMs?)`/`clearRateLimitState()`, and `checkAndResumeAfterCooldown()` (called by `gh()` before each attempt to notify once when a cooldown expires). `github.ts` re-exports `RateLimitError`/`isRateLimited`/`clearRateLimitState` for backward compatibility with existing importers (`error-reporter.ts`, tests); `setRateLimited` is also called directly by `github-app.ts` when `listInstallationRepositories()` hits a 403 rate-limit response, so that path trips the same shared breaker instead of escalating straight to a `[claws-error]` issue

**`claude-auth.ts`** — Server-side orchestration of the `claude setup-token` OAuth flow (#2082) via a `node-pty` child — lets the subscription credential be refreshed from the web UI instead of a cramped browser terminal. Spawns the PTY with a wide `cols` so the OAuth URL is emitted unwrapped (easy to copy); `startClaudeLogin()` begins the flow and captures the URL via `URL_REGEX`, `submitClaudeLoginCode(code)` writes the pasted code to the PTY, `getClaudeLoginStatus()` reports `awaiting-url`/`awaiting-code`/`completed`/`failed` with any token redacted (`redactToken`, matches `sk-ant-oat01-…`) before it reaches the browser. On success the `sk-ant-oat01-…` token is persisted as `CLAUDE_CODE_OAUTH_TOKEN`, which outranks the expired `/login` subscription credential in the CLI's precedence, so subsequent `runClaude`/session spawns pick it up immediately without a restart

**`json-extract.ts`** — `extractJsonCandidates(output)` — multi-strategy JSON extraction for LLM outputs; tries greedy fence match, non-greedy fence match, and brace-balanced extraction. `parseFirstValidJson(output, schema, logPrefix, onFailure?)` — generic helper that iterates candidates from `extractJsonCandidates`, validates each against a Zod schema via `safeParse`, and returns the first valid result or `null`; logs on failure; used by `improvement-identifier` (`parseReviewOutput`), `public-repo-scanner` (`parseFindings`), `idea-suggester`, `whatsapp-handler`, `ci-fixer` (`classifyCIFailure`), and other jobs that parse structured JSON from Claude. `repairJsonEscapes(input)` — exported helper that repairs invalid JSON string escapes (e.g. `\(`, `\.`, `\s` from Markdown-escaped chars or regex snippets embedded in LLM string values) by dropping the backslash from any `\X` where `X` is not a legal JSON escape char; used internally by `parseFirstValidJson` as a single-retry fallback when a candidate fails `JSON.parse` — the repaired form is tried once before discarding the candidate. `isCompleteJson(output)` — string-escape-aware brace-balance walk (mirrors the `extractJsonCandidates` strategy 3 logic) that returns `true` only when `output` contains a top-level JSON object whose outer braces close cleanly; used by `improvement-identifier` and `public-repo-scanner` to distinguish a genuinely-malformed Claude response (file a `[claws-error]` issue) from a transient max-tokens truncation (warn and retry next tick) — replaces a prior "ends with a closing \`\`\` fence" heuristic that produced false negatives when truncation happened to land right after an *inner* fence embedded in the LLM's own output (#1810)

**`util.ts`** — `sleep(ms)` — shared async sleep helper; `resolveIdentityFile(path)` — expands a leading `~/` in a path to the user's home directory (via `os.homedir()`; bare `~` without a slash is passed through unmodified for `ssh` to interpret). Imported by `worker.ts`, `github.ts`, `agents/problematic-pr-diagnoser.ts`, `jobs/datasette-export.ts`, `jobs/runner-monitor.ts`, and `jobs/connectivity-verifier.ts`. `mapWithConcurrency(items, concurrency, fn)` (#2022) — bounded-concurrency batch mapper, `Promise.all` semantics (rejects on first failure, preserves input order); moved here verbatim from a local copy in `triage-claws-errors.ts`, which now imports it. `mapSettledWithConcurrency(items, concurrency, fn)` — a thin wrapper returning `PromiseSettledResult<R>[]` (per-item error isolation, never rejects) for callers that previously hand-rolled a `for` loop of `Promise.allSettled` batches; used by `public-repo-scanner.ts`, `runner-metrics-sync.ts`, `actions-storage-monitor.ts`, and `github.ts`'s `fetchWorkflowRunsBatched` (#2044) — replaced a batch-synchronous loop (wait for all `concurrency` repos to settle before starting the next batch) with a sliding window (starts the next repo as soon as any one finishes), which is strictly faster and never exceeds the concurrency cap

**`sensitive-env.ts`** — Exports `SENSITIVE_ENV_KEYS` — a zero-dependency leaf module (#1944) so `capabilities.ts` can import the constant without pulling in `claude.ts`'s heavy dependency tree (which would break `capabilities.test.ts`, which mocks only `./config.js`); `claude.ts` re-exports the same constant for backward compatibility

**`session-env-file.ts`** — Per-session capability env files (#2138) — a leaf module (only `node:fs`, `node:path`, `./config.js`) so `sessions.test.ts` can `vi.mock` it wholesale and `capabilities.ts` can stay pure/fs-free. `writeSessionEnvFile(sessionId, vars)` writes `export K='v'` lines (single-quoted, `'` escaped as `'\''`) to `${WORK_DIR}/session-env/<sessionId>.env` and returns the absolute path; the explicit `chmodSync(dir, 0o700)` / `chmodSync(file, 0o600)` calls are load-bearing, not redundant — the `mode` options on `mkdirSync`/`writeFileSync` are masked by umask and ignored outright when the target already exists (the `resumeSession` path rewrites the file). Throws on any fs failure so the caller fails the spawn rather than silently running without credentials. `removeSessionEnvFile(sessionId)` (best-effort cleanup when the spawn never happened) and `pruneSessionEnvFiles()` (drops the whole dir; called first in `recoverSessions` because a crash between the write and the tmux spawn strands a credential on disk) never throw. The directory is exposed as a `sessionEnvDir()` function rather than a top-level `const` because `server.test.ts` mocks `./config.js` without `WORK_DIR`, and a module-load-time `path.join(undefined, …)` would throw on import — the same reason `sessions.ts` computes `path.join(WORK_DIR, "repos")` inside its functions

**`session-uploads.ts`** — Per-session drag-and-drop upload storage (#2272). The `POST /sessions/:id/upload` route (`server.ts`) enforces `MAX_UPLOAD_BYTES` *while the body streams in*, via Hono's `bodyLimit` middleware (`hono/body-limit`) rather than a hand-rolled `Content-Length` header check — a chunked request (`Transfer-Encoding: chunked`) has no `Content-Length` to check, so the old guard let an unbounded body reach `c.req.parseBody()`/`file.arrayBuffer()` and buffer entirely into process memory before `saveSessionUpload` ever tested the size, letting any authenticated dashboard user OOM the process (#2285, fixed in #2286). `bodyLimit` is capped at `MAX_UPLOAD_BYTES + 4096` (slack for multipart boundary/header framing around an exactly-at-cap file); the true per-file cap is still enforced by `saveSessionUpload` below. — a leaf module (only `node:fs`, `node:path`, `node:crypto`, `./config.js`, `./log.js`) for the same reasons `session-env-file.ts` is a leaf module. Files land at `${WORK_DIR}/session-uploads/<sessionId>/`, deliberately outside every git worktree so a dropped screenshot can never be committed into a PR. Caps: `MAX_UPLOAD_BYTES` (10 MB) and `MAX_FILES_PER_SESSION` (20) — exceeding either returns `{ ok: false, reason: "too-large" | "too-many" }` from `saveSessionUpload` rather than throwing. `sanitizeUploadFilename(name)` runs `path.basename()` first (kills `../` traversal), replaces every character outside `[A-Za-z0-9._-]` with `_`, strips leading dots (no hidden files), and truncates to 80 chars, falling back to `"upload"` if the result is empty. `saveSessionUpload` prefixes the sanitized name with 3 random hex bytes so repeated same-name drops (e.g. `screenshot.png`) never collide, then defends in depth against path escape with a `resolve().startsWith(dir + path.sep)` check before writing at mode 0600. `ensureSessionUploadDir` (0700, `chmodSync` explicit for the same umask/existing-dir reasons as `session-env-file.ts`) is called from `sessions.ts`'s `claudeShellArgs(sessionId, caps, extra)` to add the dir via `--add-dir` on every spawn/resume — a failed `mkdir` is caught and logged, not fatal, so a broken upload dir never blocks a session from starting. `removeSessionUploadDir` (best-effort, never throws) is called only from `deleteSession`, not `killSession`/`recordSessionEnded`, because an ended session is resumable via `--continue` and its conversation history may reference upload paths that must stay valid.

**`ssh.ts`** — Shared SSH/scp helpers (#1909), extracted from duplicated argument-assembly and `execFile`→Promise code across remote-ops jobs. `buildSshArgs(cfg: SshConnection, opts?)` assembles the common connection flags in a fixed order — `-o StrictHostKeyChecking=<accept-new|yes> -o ConnectTimeout=10 -o BatchMode=yes`, plus `-p`/`-P <port>` (scp uses `-P`) when `port !== 22` and `-i <identityFile>` (resolved via `resolveIdentityFile`) when set — and does NOT append the target or command; callers append `user@host` + command (ssh) or `localPath` + `target:remotePath` (scp) themselves. `execCapture(cmd, args, opts)` wraps `execFile` in a Promise (default `maxBuffer` 4 MiB), resolving stdout as a string and rejecting with trimmed stderr (falling back to the error message). `isSafeAbsolutePath(path)` (#1993) validates a config-supplied absolute path against `/^\/[a-zA-Z0-9._/-]+$/` (leading `/`, conservative charset excluding shell metacharacters) before it is interpolated into an SSH command string — the single shared implementation of a regex previously duplicated byte-for-byte in `kubeconfig-refresh.ts` (`SAFE_REMOTE_PATH`) and `runner-monitor.ts` (`SAFE_ACTIONS_DIR`), both of which now import it instead. Used by `jobs/runner-monitor.ts` (`sshExec`, `assertSafeRunnerPaths` — validates `actionsDir` for svc runners or `serviceUnit`/`workDir`/`toolDir` for NixOS systemd runners, #2336), `jobs/kubeconfig-refresh.ts` (`sshCapture`, remote-path validation), `jobs/datasette-export.ts`, `jobs/connectivity-verifier.ts`, and `jobs/mac-runner-waker.ts`

**`home-assistant.ts`** — Home Assistant REST API client — `listStates()`, `callService()`, `listUpdateEntities()`, `installUpdate()`, addon log fetching; `isConfigured()` checks `HOME_ASSISTANT_BASE_URL`/`HOME_ASSISTANT_TOKEN`; `isHaTransient()` matches HA 429/5xx for `retryWithBackoff`; used by `ha-upgrader`, `ha-deploy-watcher`, and `bin-day-monitor`

**`mcp-result.ts`** — Shared MCP tool-result helpers (`ToolResult` interface, `textResult`, `errorResult`) — pure, no config/runtime dependencies; imported by `namey-query.ts`, `ha-mcp.ts`, and `mcp-server.ts` (extracted from those modules to avoid duplication; `ha-mcp.ts` requires the wider `obj: unknown` signature rather than `Record<string, unknown>`)

**`shutdown.ts`** — Graceful shutdown flag + ShutdownError class (shared across modules)

**`test-helpers.ts`** — Test factories (mockRepo, mockIssue, mockPR)

**`pwa.ts`** — PWA support (#1818) — `APP_ICON_SVG` (inline SVG icon), `WEB_MANIFEST` (JSON web app manifest served at `/manifest.webmanifest`; `display: "standalone"`, `/` scope/start_url, 192/512 PNG icon refs), and `getAppIconPng(size)` (rasterizes the SVG to PNG via `sharp` — already a dependency, used elsewhere in `images.ts` — memoized per size in an in-process `Map` since the icon is static); deliberately ships with no service worker (iOS Add-to-Home-Screen standalone mode doesn't require one, and a cache-first worker would risk serving stale auth-gated dashboard content)

## resources/

**`resources/claws-info.ts`** — Exports `CLAWS_AUTOMATION_DOC` (the canonical `docs/claws-automation.md` markdown) and `CLAWS_AUTOMATION_DOC_PATH` (`"docs/claws-automation.md"`); `doc-maintainer` compares the committed file against this constant and rewrites it when stale — the content is owned here, not by Claude. Also exports `SESSION_WORKFLOW_PROMPT`, always injected via `--append-system-prompt` into interactive sessions (`sessions.ts`) so a session files/updates an issue and waits for the Claws pipeline instead of invoking the repo's `.claude/agents/*` definitions as subagents (#2360)

**`resources/marketing.ts`** — Marketing knowledge resource for idea-suggester prompts

**`resources/alpinejs.ts`** — Exports `ALPINE_JS_SOURCE` — Alpine.js bundle served at `/static/alpine.js`

**`resources/tailwind-css.generated.ts`** — Exports `TAILWIND_STYLESHEET` — generated Tailwind CSS link tag

**`resources/error-handler.generated.ts`** — esbuild bundle of `src/client/error-handler.ts`; exports `ERROR_HANDLER_SCRIPT` (window.onerror + unhandledrejection → `/api/client-error`)

**`resources/queue.generated.ts`** — esbuild bundle of `src/client/queue.ts`; exports `QUEUE_SCRIPT`

**`resources/sessions-list.generated.ts`** — esbuild bundle of `src/client/sessions-list.ts`; exports `SESSIONS_LIST_SCRIPT`

**`resources/session-terminal.generated.ts`** — esbuild bundle of `src/client/session-terminal.ts`; exports `SESSION_TERMINAL_SCRIPT`

## client/

**`client/error-handler.ts`** — Client-side window.onerror + unhandledrejection handler; POSTs deduplicated fingerprints to `/api/client-error`

**`client/queue.ts`** — Client-side queue page interactions — skip/prioritize/unmark-problematic buttons and "Refresh from GitHub" button (POSTs to `/queue/refresh`, reloads page after 4 s on success; `already-running` treated as success); `markRefined` keeps the row in place on success (sets button text to "Refined ✓", disables it, adds `refined-done` class for stable green styling) — the row self-reconciles on the 60 s page auto-refresh once the server stops rendering the Refined button for that item. On a failed `/queue/merge` call, the error is shown as a persistent inline `.merge-error` span next to the button rather than a hover-tooltip that silently auto-cleared after ~3s and was easy to miss, and the button relabels to "Retry Merge" so a fresh attempt is visually distinct from a never-attempted one (#1517)

**`client/sessions-list.ts`** — Client-side sessions list page interactions

**`client/session-terminal.ts`** — xterm.js terminal — WebSocket PTY bridge, ResizeObserver-based fit (replaces RAF), Paste button, Copy button (snapshot overlay), Enter key (`"\r"` in `KEY_MAP`) and other mobile keys; Cmd+C (mac) / Ctrl+Shift+C (linux/windows) and right-click both copy xterm's **own** selection (`term.getSelection()`) rather than relying on the browser's native DOM copy (#1822) — xterm.js renders selection on its own canvas layer, which is nearly invisible to native Cmd+C (previously copied ~one word) and is dropped by the browser before a right-click context-menu "Copy" can fire; `term.attachCustomKeyEventHandler()` intercepts the keystroke (returning `false` only when it actually consumes it, so all other keys reach the shell unmodified) and a `contextmenu` listener on the terminal element calls `event.preventDefault()` + copies when a selection exists; **never intercepts plain Ctrl+C**, which must keep sending SIGINT to the shell; copy result flows through `navigator.clipboard.writeText()` with an `execCommand("copy")` textarea fallback, flashing "Copied ✓"/"Copy failed" on the same Copy button used by the whole-buffer overlay; drag-and-drop upload (#2272) — `window`-level `dragenter`/`dragover`/`dragleave`/`drop` listeners (gated on `hasFiles()` checking `dataTransfer.types` so non-file drags into other controls are unaffected) show/hide `#drop-overlay` via a drag-depth counter (avoids flicker from child-element `dragleave`), and an Attach button (`#attach-btn` → hidden `#attach-input[type=file]`) offers the same path; both funnel into `uploadFiles()`, which `POST`s each `File` sequentially (so multi-file drops insert paths in drop order) to `/sessions/:id/upload` as `multipart/form-data`, then `sendInput(path + " ")` (no trailing `\r` — that would submit Claude's prompt before the user finishes typing) types the returned absolute path into the PTY exactly like dragging a file onto a local terminal; all upload feedback goes through a `#upload-toast` element (`showToast()`), never `term.write()`, since writing into the PTY stream would corrupt Claude's TUI redraw

## pages/

**`pages/dashboard.ts`** — Main status page HTML builder

**`pages/queue.ts`** — Work queue page HTML builder

**`pages/logs.ts`** — Log list, detail, and issue logs page HTML builders

**`pages/config.ts`** — Config editor page HTML builder

**`pages/topology.ts`** — Pipeline topology visualization page (SVG diagram, live status)

**`pages/whatsapp.ts`** — WhatsApp status/pairing page HTML builder

**`pages/sessions.ts`** — Session list + terminal page HTML builders. The list page (#2214) renders, top to bottom: an **Active Sessions** table (`sessions.filter(s => s.alive)`, or "No active sessions."), a **New Session** section with the single- and multi-repo create forms, then an **All Sessions** table (only when any session exists) with a `.filter-bar` status filter (All/Active/Ended) and a text search box filtering on id/repo/dir/summary via a `data-search` attribute per row — both client-side, wired by `SESSIONS_LIST_SCRIPT`. Active sessions deliberately appear in both tables. `renderSessionRow()`/`renderSessionsTable()` are shared between the two tables so row markup can't drift. This intentionally supersedes an earlier layout (#2172) that moved the *combined* live+ended table above the forms without splitting by status — the combined table is still used for the All Sessions section, just no longer the only one. Session list form uses `display:flex; flex-wrap:wrap` so label+select pairs stack on mobile; terminal page injects `ERROR_HANDLER_SCRIPT` (from `error-handler.generated.ts`), adds `ws.onerror` handler that writes a red reconnect message to xterm.js, and uses `SESSION_TERMINAL_SCRIPT` (from `session-terminal.generated.ts`) for the xterm.js terminal — ResizeObserver-based fit (replaces RAF; fixes 1-row canvas on mobile), Paste button (`navigator.clipboard.readText()` → WebSocket `{type:'input',data}`), Copy button (dumps terminal buffer via `term.buffer.active` into a read-only `<textarea>` overlay — supports native long-press selection and OS copy on mobile where shift-click is unavailable; includes a "Copy all" convenience button with clipboard API + `execCommand` fallback; closes on backdrop click), and mobile keybar with Esc, Tab, Enter, font-size controls (A−/A+), ^D, ^D×2 (sends Ctrl+D twice ~50ms apart for Claude Code exit), arrow keys, Ctrl, Home/End/PgUp/PgDn, ^C/^Z/^L; the terminal page also renders an Attach button + hidden file input, a `#drop-overlay` (shown while dragging a file over the window) and a `#upload-toast` status element for the drag-and-drop file upload feature (#2272), styled with DESIGN.md tokens only (`--bg-secondary`, `--border`, `--accent`, `--text`, `--danger`)

**`pages/jobs-matrix.ts`** — Per-repo job enable/disable matrix page HTML builder

**`pages/ha-upgrader.ts`** — Home Assistant update state page HTML builder — shows pending/applied/failing/blocked HA updates from the DB

**`pages/damp.ts`** — Damp meter reading page HTML builder (`/damp`, #1819/#1824/#1900/#1904) — exports `DAMP_POINTS` (the single source of truth for the 15 fixed `{ location, point, wall: "masonry"|"stud", exposure: "interior"|"exterior" }` measurement points: 4 in the downstairs toilet, 3 on the sitting-room wall, 3 on the sitting-room bay window, 2 in the Hall Closet — `Manifold` and `utility`, and 3 on the utility wall; readings are keyed by `(location, point)` strings, not array index, so inserting a new point anywhere in the array cannot corrupt existing rows — `src/server.ts`'s `POST /damp/log` handler iterates by index for form field names but only reads back `.location`/`.point`, so reordering or resizing the array would silently misalign submitted readings even though adding fields is safe) and `buildDampPage()`. `wallLabel(p)` renders `"<wall> · <exposure>"` (middle dot, HTML-safe) and is surfaced as a "Wall" column in both the log-entry form and the trends table; `renderHistory()` looks up the same label via a `WALL_BY_KEY` map keyed by `pointKey(location, point)`. `renderContext()` includes qualitative expected-reading guidance per wall type (interior stud reads low/stable, interior masonry moderately higher, exterior masonry highest and rain-reactive) so readings are judged against their own construction type, not each other. `renderCharts()` plots all 15 points as a single multi-series SVG (one shared date/value axis, a 15-colour `CHART_PALETTE`, location+point legend labels since point names repeat across locations) rather than one chart per location. `buildDampPage()` renders the log-entry form, the consolidated chart, a trends table (latest value, reading date, previous value, and a Δ arrow computed from the two most-recent rows per point), and a recent-history table. Mobile logging rework (#2156/#2157): `renderContext()`'s explanatory copy is now collapsed behind a `<details class="damp-context"><summary>How to read these numbers</summary>` disclosure and moved to the bottom of the page (below the history table) so the entry form is reachable without scrolling past it first. `renderForm()` no longer emits a 5-column `<table>` — each point is a stacked `<li class="damp-row">` (grouped under a `<li class="damp-group">` per location) with a single numeric input, preserving the original `DAMP_POINTS` array index (`name="p${i}"`, `data-index="${i}"`) so `POST /damp/log` and the autosave script's `data-index` lookups are unaffected by the grouping. The date field (`.damp-date`) is `position: sticky; top: 0` so it stays visible while scrolling through all 15 inputs. **Owner requirements**: track readings over time for a *fixed, enumerated* set of measurement points (#1819; the Hall Closet "utility" point was added after the first pass, #1824) — the point list is the owner's, not a suggestion. Readings must be **saved incrementally as they are entered** so a part-finished batch can never be lost (#1890) — that is what the autosave script is for, and a rework that only persists on submit regresses it. Show all points as **one combined chart**, not one per location (#1891/#1904). Wall construction type and interior/exterior exposure are recorded per point (#1900) *with* contextual guidance text, so a reading is judged against its own construction type rather than against other points (#1892, #1900 comment). Weekly entry happens from a phone (#2156): "No need for the text at the start" — the explanatory copy must not sit above the entry form. Note the meter's 2.5 maximum is already being hit at some points, so a reading at the cap may be censored data rather than a true value

**`pages/k8s.ts`** — Kubernetes integrations page HTML builder — shows monitor status, recent monitor runs, and a link to open alert issues for k3s and prod-k8s clusters; renders only cached `K8sMonitorStatus` state written by the `k3s-monitor`/`prod-k8s-monitor` jobs and must never issue a live `kubectl` call from the request handler, because querying the clusters synchronously on page load makes the dashboard slow (#1263)

**`pages/repo.ts`** — Per-repo detail page HTML builder (`/repos/:owner/:repo`) — recent tasks with outcome summaries and open queue items for that repo. Also exports `buildRepoListPage`/`sortRepoRows`/`parseRepoListSort` for the `/repos` list page (#2364): a `data-cards` table with sortable Repo/Open PRs/Open Issues/Last activity headers, each `<th>` linking to `/repos?sort=<key>` with the validated `RepoListSort` enum (never the raw query string) interpolated into the markup

**`pages/lists.ts`** — Cross-repo aggregate list pages (#2096) — `buildAllPRsPage()` (`/prs`) and `buildAllIssuesPage()` (`/issues`) flatten every managed repo's open PRs/issues into one sorted (by `updatedAt` desc) table with a Repo column, reusing the pipeline-stage badge logic from `repo.ts`. Both pages are Alpine components (`pageShell` loads `ALPINE_SCRIPT` + `QUEUE_SCRIPT` and sets `x-data="queuePage()"`) so each row's **Actions** column reuses the existing `mergePR`/`markRefined` client handlers verbatim — no new server routes or client script needed (#2099). The PR row's Squash & Merge button is gated (#2110) on `resolveStatus()`: hidden unless `mergeableState === "MERGEABLE"`, `checkStatus === "passing"` (or `"none"` with no CI configured), and `reviewStatus` is not `"issues"`/`"escalated"`; status comes from a per-repo bulk `listPRStatuses()` fetch (falls back to the queue-cache item if that fetch failed, so nothing regresses to a permanently-hidden button). Every GitHub-supplied string (title, author, branch, repo) is passed through `escapeHtml` — these tables render attacker-influenceable text. Both tables opt into `PAGE_CSS`'s shared `.data-cards` mobile layout (#2124) via `class="data-cards"` plus a `data-label` attribute on every `<td>`; other table pages can adopt the same pattern by adding the same class and attributes. **Owner requirements**: these pages exist because the owner wanted aggregate views of *all* open PRs and issues across every repo, not just the priority queue (#2096), with the same actionable buttons as the queue page reusing the existing endpoints rather than new ones (#2099), and with the merge button gated on CI-green + clean-review while **CI status is always shown regardless** of whether merging is offered (#2110)

**`pages/claude-auth.ts`** — Reauth page HTML builder (`/claude-auth`, #2082) — "Start login"/paste-code UI driving `startClaudeLogin`/`submitClaudeLoginCode`/`getClaudeLoginStatus` in `../claude-auth.ts`; the OAuth URL is rendered in a `readonly` selectable input (`onclick="this.select()"`) so it's easy to copy in full, unlike a wrapped terminal line

**`pages/runners.ts`** — Self-hosted runner utilization page HTML builder (`/runners`) — active workflow runs and `WorkflowRunStats` synced by `runner-metrics-sync`

**`pages/usage.ts`** — Token/cost usage dashboard HTML builder (`/usage`) — `getUsageStats`/`getTotalUsage` breakdowns by repo, job, and provider+model over a selectable 1/7/30-day window

**`pages/verify.ts`** — Connectivity verification report page HTML builder (`/verify`) — shows the latest `VerificationReport` and current `ActivationState` (active vs. verify-only)

**`pages/blog.ts`** — Blog post editor page HTML builder (`/blog`, #1849) for `BLOG_REPO` (`St-John-Software/bstjohn-blog` default, env `CLAWS_BLOG_REPO`) — no Claude/agent invocation, plain CRUD over GitHub content plus a `blog_drafts` SQLite table (survives across browsers/sessions). Read directly from `process.env` rather than routed through `config.ts` (unlike most other configurable values in this codebase). `buildBlogListPage()` lists posts fetched live from `BLOG_CONTENT_DIR` (`src/content/blog` default, env `CLAWS_BLOG_CONTENT_DIR`) via `listRepoDirectory()`, merged with any in-progress drafts (draft-only rows for posts not yet pushed to GitHub) and a status badge (`draft` / `pushed #N`). `buildBlogEditPage()` edits the **raw file text** (frontmatter + body) in a single textarea — deliberately does not parse/rebuild YAML frontmatter, since the sole editor is the trusted repo owner. `isValidBlogPath()` is the only guard on the write path: the path must be under `BLOG_CONTENT_DIR`, end in `.md`, and contain no `..` segment. **Owner requirements** (#1849): edit `bstjohn-blog` posts from the Claws UI, saving drafts **server-side first** so an edit started on one browser can be finished on another, then push to a PR on demand — which is why `blog_drafts` exists rather than relying on browser state. Editing a post that already had an open PR must **update that PR**, not open a second one (#1953, fixed in PR #1954 — the duplicate PRs it had already created were closed by hand as part of the fix, verified against the `blog_drafts` pointer). **Comment moderation (proposed, unbuilt)** (#548): a job to check Bluesky hourly for new replies to blog posts, classify each as useful or hidden, add useful ones to an allowlist, and update the blog to only render approved comments, with a Slack post for every new reply regardless of verdict. Not implemented — there is no Bluesky integration anywhere in `src/` and the blog has no comment system at all yet

**`pages/layout.ts`** — Shared layout (header, theme support, formatters, `timestampHtml()` / `LOCAL_TIME_SCRIPT` for client-side timestamp localisation, `ALPINE_SCRIPT` for defer-loading Alpine.js on all pages, `TAILWIND_STYLESHEET` link tag for pages using the generated Tailwind CSS alongside `PAGE_CSS`, `buildPageHeader()` for consistent `<h1>claws</h1>` + nav + optional `<h2>` across all pages; `ERROR_HANDLER_SCRIPT` from `error-handler.generated.ts` is prepended so the error handler runs before any other script on every page that calls `buildPageHeader()`; `HEAD_META` (#1818/PWA) — manifest link, `theme-color`/`apple-mobile-web-app-*` meta tags, and apple-touch-icon link, sourced from `pwa.ts` — is included in most page builders' `<head>` (notably absent from `damp.ts`, which was added after PWA support landed); `buildNav()` includes `/prs`, `/issues`, `/damp`, `/k8s`, and `/claude-auth` ("Reauth") links. Mobile layout (#2124): `PAGE_CSS` ships a shared `.data-cards` responsive block — tables opted in via `class="data-cards"` collapse to stacked cards below 768px, keyed off `data-label` on each `<td>` (`content: attr(data-label)`), with `hide-sm` dropping low-value columns and `cell-title` hoisted to the top of the card via `order: -1`. `buildNav()` is a CSS-only checkbox disclosure (`#nav-toggle` + `.nav-toggle-label`/`.nav-links`, no JS) — collapsed behind a "Menu" toggle below 768px, always expanded at ≥768px; `sessions.ts`'s terminal page dropped its own redundant hamburger-button nav toggle in favor of this shared mechanism. A `.nav-favourites` bar (#2131) sits as the last child of `<nav>` with `flex-basis: 100%`, holding pill-styled `/queue`, `/prs`, `/issues` and `/sessions` links that stay visible below 768px while the rest of the nav is collapsed; it is `display: none` at ≥768px (the full `.nav-links` list already shows those links) and is also suppressed on `sessions.ts`'s full-bleed terminal page, which cannot spare the vertical space.

## agents/

**`agents/issue-refiner.ts`** — Per-item planning functions (fresh plan, refinement, follow-up); planners run in fresh git worktrees (created via `createWorktree()` in `src/claude.ts`) containing only tracked files — dependencies are NOT installed (`node_modules` is `.gitignore`d and omitted); agents that need them must run `npm install`/`npm ci` themselves, but planners typically read lockfiles directly for dependency/version analysis rather than incurring the cost of a full install. Planner runs with the full main-agent toolset — per-repo behaviour is shaped by the repo's `.claude/agents/issue-refiner.md` document, which is read via `readRepoAgentDoc()` and injected into every `runClaude` call via `--append-system-prompt`; and the prompt builders. All three prompt builders inject `RESEARCH_INSTRUCTIONS` — one merged block (previously four separate constants) covering the context-gathering the implementer cannot do for itself: the planner **must** fetch linked GitHub issues/PRs via `gh` before writing the plan and is explicitly **forbidden** from deferring the lookup to the implementer (which runs on a smaller model and will produce wrong code without the facts embedded in the plan; applies to cross-repo links, with a fallback to proceed-with-what's-in-the-issue when both `gh issue view` and `gh pr view` return 404), WebFetch for external URLs and WebSearch for library/API research, inspection of GitHub Actions logs/artifacts before diagnosing (`gh run view --log-failed` / `--log`, `gh run download`) with commitment to ONE diagnosed root cause rather than speculative branches, and treating an occurrence-tracking count above 1 as a recurring failure the plan must address. They also inject `homeAssistantContext()` when `HOME_ASSISTANT_BASE_URL`/`HOME_ASSISTANT_TOKEN` are configured **and** `isHomeAssistantConfigRepo(fullName)` is true (default-deny elsewhere, #2064) — giving the planner access to `ha_list_entities` and `ha_api_request` MCP tools only for issues on the HA config repo. `homeAssistantContext()` (`agent-context.ts`) directs the model to use **only** those two MCP tools and explicitly tells it not to expect an HA token in its shell environment or to `curl` the HA API directly (#1814): every `tool-use` agent that calls this shared context string (planner, issue-worker, ci-fixer, review-addresser) runs with strict env sanitization by default (`sanitiseEnvForChild` in `claude.ts` strips `SENSITIVE_ENV_KEYS`, including the HA token, from the child process env — see #1840), so a shell-token/curl approach reliably fails for all of them — the MCP server holds the credential out-of-band regardless. MCP config is written with `{ includeNameyDb: false, includeHomeAssistant: isHomeAssistantConfigRepo(fullName) }` (Namey is out of scope for the planner; HA tools are scoped to the HA repo). Plan generation and refinement run on the opus-tier Claude model by default; an issue labelled `Plan: Fable` is planned with `claude-fable-5` instead. Follow-up Q&A does not honour the label. When Fable routing applies, `FABLE_PLANNING_CONTEXT` is injected into the prompt instructing the model to invest the extra capability in deeper investigation — reading more of the codebase, tracing actual code paths, verifying assumptions against real files — rather than writing a longer plan, and emphasising that the implementer is unchanged so the planner–implementer capability gap is wider than usual. After generating any plan output, `stripLeadingPlanHeader()` strips a leading `## Implementation Plan` header from the model output before posting — instruction-faithful models like Fable reliably produce this since `IMPLEMENTER_GUIDANCE_INSTRUCTIONS` tells the planner to start with that header and the posting code also prepends it, resulting in duplication. After a fresh plan is generated and before it is posted, a second text-only pass (`runStepBack`, gated on `CLAWS_PLANNER_STEP_BACK !== "false"` and plans at least `STEP_BACK_MIN_PLAN_CHARS` long) asks whether the plan is a well-executed version of a suboptimal approach; it defaults to "sound" and stays silent, and on a `reconsider` verdict its complete replacement plan is posted as the plan while the critique goes out as a separate `## Step Back` comment (deliberately not containing `## Implementation Plan`, since plan lookup elsewhere finds the last comment containing that header). It runs on `processIssue` only — not `processRefinement`/`processFollowUp`, which already have a human in the loop — and any failure or unparseable output falls back to posting the original plan.
Every plan comment (fresh plan, refinement, and in-place replan edits) appends a plain-text
`CLAWS_PLAN_OCCURRENCES: N` marker recording the occurrence count of the issue body at planning
time. `parsePlannedOccurrences(planBody)` extracts this integer from a plan comment; `findUnreactedFeedbackAfterPlan`
returns it as `plannedOccurrences` alongside the existing `hasPlan`/`unreacted` fields. The
`issue-dispatcher` uses this to trigger `ISSUE_REFINER_REPLAN` when the current issue occurrence
count is ≥ `plannedOccurrences * 2` (and > `plannedOccurrences`) — handled by calling
`processRefinement` with no unreacted feedback, which edits the plan in place with updated context.
Legacy plans without the marker default to `plannedOccurrences = 1`, ensuring existing alert issues
receive one backfill re-plan. `findUnreactedFeedbackAfterPlan` also returns `hasEscalationReview` —
whether a Claws `## Escalation Review` comment appears *after* the last plan comment. Scanning only
after the last plan is deliberate: a re-plan invalidates the old verdict and correctly triggers a
fresh review. The dispatcher checks this **before** the re-plan branch and `continue`s on a match,
because monitor alert issues bump their occurrence count on every tick — the re-plan trigger fires
almost immediately and would otherwise starve the escalation review forever.

**`agents/issue-worker.ts`** — Per-item implementation functions (create PR, continue phases). Injects repo agent doc (`issue-implementer`) via `appendSystemPrompt`. `buildPRTitle()` uses the diff-derived subject from `claude.generatePRDescription()`'s `TITLE:` marker (extracted by `extractTitleMarker`, #2028) for single-phase PRs instead of the original issue title, since refinement can diverge the implementation from what the issue asked for; the multi-phase path still uses plan phase titles, unchanged.

**`agents/ci-fixer.ts`** — Per-item CI fix functions (identify, fix, conflicts, unrelated). Injects repo agent doc (`issue-implementer`) via `appendSystemPrompt`. `pushAndUpdatePR()` regenerates the PR body via `issue-worker.ts`'s shared `regenerateAndUpdatePRBody()` helper (#2294 — previously duplicated byte-for-byte in both this file and `review-addresser.ts`), which runs `claude.regeneratePRDescription()` and re-extracts/reattaches the phase header (`## PR N of M: ...`) and `Closes #N`/`Part of #N` line from the pre-regeneration body before overwriting it (#2018) — otherwise a CI-fix or conflict-resolution pass would silently drop the issue auto-close link and the multi-phase identifier; failures are swallowed and logged, never thrown, since the push it follows has already succeeded. Exports `parseMajorBumps(text)` (#2065) — scans a PR title/body for Dependabot "bump X from A to B" phrasing and returns only the pairs whose leading integer increases (so `5.4.5→7.0.0` flags but `4.1.8→4.1.10` doesn't; also flags non-semver majors like a Docker base-image tag bump), deduped by package name. `fileMajorBumpIssue(fullName, pr)` runs `parseMajorBumps` against the title, falling back to the PR body for grouped bumps, and — when `triggerCircuitBreaker` fires (the PR is stuck, not on first CI failure) — files a tracking issue via `ensureAlertIssue()` describing the broken major-version bump, per the policy that a failing major bump must be fixed properly rather than blocklisted in `dependabot.yml`. Filing at the circuit-breaker point (rather than on first failure) preserves auto-fixing of majors that *are* fixable via codemods/API renames and only escalates genuinely-stuck ones. `reportRunNotRerunnable(repo, pr, runId)` (#2218) — called when GitHub refuses to re-run a CI run (too old / not in a re-runnable state) — no longer files a standalone `[claws-error]`-style alert issue (the prior version added nothing actionable beyond the `Manual Action` label auto-merger already honours, and its counter climbed indefinitely since #1652 sat unactioned for 7 occurrences). Instead it labels the PR `Manual Action` and writes a one-time note into the PR body's manual-action section (reusing `extractManualActionSection`/`MANUAL_ACTION_HEADING` from `issue-worker.ts`), delimited by an HTML-comment marker pair (`NOT_RERUNNABLE_MARKER`/`NOT_RERUNNABLE_END`, keyed by run ID) so `stripNotRerunnableSection()` can find and replace just this note on a later call without disturbing a manual-action note written by another agent under the same heading — `dropEmptyManualActionHeading()` removes the heading too if nothing else is left under it. An in-memory `deadRerunIds` set (also used to gate the rerun attempt itself, shared with the circuit-breaker guard) short-circuits repeat calls for the same run before any PR-body read/write. Uses `log.warn`, not `log.error`, deliberately — `log.error` escalates to Slack, which would recreate the exact noise this change removes. A job that fails or is cancelled having recorded **zero steps** never ran user code — the runner went away mid-job (registration purge, `nixos-rebuild`, host reboot) — so `gh.getRunJobSummaries()` + `gh.isInfrastructureOutage()` classify that shape as an infrastructure outcome rather than a PR defect (#2300); `isInfrastructureOutage` requires *every* failed/cancelled job to be stepless, so a run mixing a stepless death with a genuine failure stays a normal fix. `performRerun(item)` is now the single entry point for executing a rerun work item, used by both the `CI_FIXER` and `CI_FIXER_RERUN` handlers. An infra item re-runs only the failed jobs (`gh.rerunFailedJobs`, falling back once to a full `rerunWorkflow` since the failed-jobs endpoint rejects an all-cancelled run) and — the load-bearing invariant — is **never** labelled `Manual Action` and **never** records a task, so an outage costs nothing against `CI_FIXER_MAX_ATTEMPTS` or the consecutive-failure count that trips `Claws Problematic` (fleet-infra#745 and 3d-models#350 both sat blocked for hours under the old path, then went green on a single unchanged re-run). Three bounds keep it from running away: `INFRA_MAX_RERUNS` (3) per run ID, after which the run falls through to the normal fix path and the circuit breaker behaves exactly as before — counted only once a rerun call has actually succeeded, so a rerun that throws outright never re-tested anything and doesn't burn one of the three; `INFRA_MAX_RERUN_FAILURES` (2) per run ID, counting rerun calls GitHub *refused* (`noteInfraRerunFailure`, from the fallback `catch` where both `rerunFailedJobs` and `rerunWorkflow` threw) — without it a run GitHub permanently refuses to re-run (too old, jobs cancelled at the 24h limit) increments neither counter, so every sweep re-classifies it as an outage and re-calls `performRerun` forever, the exact loop `deadRerunIds` exists to prevent; once either bound trips, `isInfraRerunExhausted` sends the run down the normal path, which surfaces it to a human instead of retrying silently — and `RERUN_QUEUE_DEPTH_LIMIT` (10) — `isPoolSaturated()` defers a non-priority infra rerun (logging why, and without spending budget, so the next sweep retries) when that many runs are already queued org-wide, since the linux pool is two runners and one 3d-models render can hold one for ~2h. `identifyPRWork` deliberately does not increment the counter — it runs every sweep and would exhaust the budget without ever issuing a rerun. When `runCIFix` classifies a CI failure as unrelated to the PR, it re-runs the run once (via `gh.rerunWorkflow`) before `revertPreviousUnrelatedFixes`/`mergeBaseIfBehind` run, guarded by an in-memory `autoRerunIds` set — since `gh run rerun` reuses the run ID, a second failure on the same ID presents that same ID and is skipped rather than looping. This is deliberately unconditional on log content: "unrelated" already means flaky/runner/pre-existing, the class where a requeue is the right answer, with issue #2278's NixOS `ryzen` runner (matches `[self-hosted, linux]` but can't build claws' native modules) as the motivating case.

**`agents/review-addresser.ts`** — Per-item review addressing functions. Injects repo agent doc (`issue-implementer`) via `appendSystemPrompt`. PR-description regeneration after a push goes through `issue-worker.ts`'s shared `regenerateAndUpdatePRBody()` (#2294), same as `ci-fixer.ts`. Posts its summary of actions taken as a single comment edited in place each round (`postOrEditAddresserComment`, marked with `review-addresser-summary`) rather than a fresh comment per round, avoiding per-round comment spam on long review loops (#1927). When it finishes without pushing any commits it stamps `review-addressed: <sha>` on the review comment so the review isn't re-processed; if it *declined* the request (non-empty output that `isBenignNoChangeOutput()` doesn't classify as a benign "nothing to change" note) it additionally stamps `review-rebutted: <sha>`, which hands the disagreement back to pr-reviewer for one final round (#2128).

**`agents/pr-reviewer.ts`** — Per-item PR review functions. Injects repo agent doc (`pr-reviewer`) via `appendSystemPrompt`. Reviews are posted as a **single comment that is edited in place** each round (`postOrEditReview`) rather than a fresh comment per round; prior rounds are preserved in a collapsed `<details>` audit log (`ARCHIVE_SUMMARY`, capped at `ARCHIVE_MAX_ENTRIES` entries / `ARCHIVE_MAX_ENTRY_CHARS` chars each) so `getReviewHistory()` can recover full multi-round context for the reassessment prompt instead of only the latest round. A review is classified `review-result: clean`, `review-result: advisory` (findings exist but are all non-blocking — the review never withholds Ready, and pr-reviewer itself never starts another round), or left blocking (default — withholds Ready and triggers review-addresser). After `MAX_REVIEW_ITERATIONS` (8) rounds without converging, the loop escalates: posts a `review-result: escalated` marker and the `Manual Action` label instead of grinding on (escalated reviews are never Ready-eligible, unlike advisory) (#1927). `getPendingRebuttal()` closes the reviewer↔addresser deadlock: when the review comment carries `review-rebutted: <HEAD sha>` the reviewer re-fires exactly once for that HEAD (gated in `work-handlers.ts` alongside `hasNewCommitsSinceLastReview()`) with the addresser's rebuttal in-prompt, and must terminate — either it withdraws the finding (`clean`/`advisory` → Ready) or it holds, which posts `review-result: escalated` + `Manual Action` for a human to settle. `postOrEditReview` rewrites the comment body each round, so the marker self-clears and no second round is possible (#2128). `ciAllowsReady()` grants Ready-eligibility not only for a `"passing"` check status but also for `"none"` when every changed file matches a CI-exempt path (`docs/**`, `*.md`, `LICENSE`) — repos whose CI workflows `paths-ignore` docs produce zero check runs on docs-only branches, so a strict `"passing"`-only gate left such PRs permanently invisible in the Queue UI (pr-2089); an empty or error-fallback changed-file list is never treated as exempt. Advisory findings are not pure audit-trail noise: pr-dispatcher Phase 3 gives them **exactly one** addresser round while the PR is Ready-idle — the `Ready` label present, no valid LGTM, no `Automerge` label, and not LGTM-exempt (`isLgtmExempt` from `auto-merger.ts`) — since any of those signals means a merge may be imminent and pushing then can invalidate the LGTM or restart CI mid-merge. `Ready` is never removed on that path. The one-shot guard is the `advisory-addressed: <sha>` stamp written by review-addresser (whether or not commits were pushed); `getPRReviewComments({ includeAdvisory: true })` skips any review carrying it, and `postOrEditReview` explicitly carries the stamp forward across re-reviews because the archive truncates entries. A re-review that is still advisory-only therefore just re-applies `Ready` and stops (#2230).

**`agents/auto-merger.ts`** — Per-item merge function (tryMerge); LGTM-exempt categories: dependabot, claws docs, idea-collection, and prod-infra auto-bump PRs (branch automation/bump-*, label auto-bump) — bump PRs still require passing CI and may only touch the image-pin manifests the bump-app-version workflow rewrites: `deployment.yaml`, `migrate-job.yaml`, and `cleanup-test-data-cronjob.yaml` under `apps/<app>/` or its `base/`/`prod/` overlay.

**`agents/problematic-pr-diagnoser.ts`** — One-shot deep-diagnosis pass (`ci-fixer:problematic` kind) for PRs flagged `Claws Problematic` by the ci-fixer circuit breaker; short-circuits to `success` (clears the label) if CI already recovered before the pass runs; otherwise runs up to `MAX_ROUNDS` (3) rounds watching CI (`ciWatchBudgetMs`/`ciPollIntervalMs`) and posts a final report comment marked with `DIAGNOSIS_COMMENT_MARKER`

**`agents/escalation-reviewer.ts`** — Auto-escalation gate for `Priority` cluster-monitor alerts (#2088). `isEscalationCandidate(issue, selfLogin)` matches issues titled `[k3s] …` that carry `Priority` **and** were authored by the Claws app itself — the author check is a security gate, since without it any actor who can open a `[k3s]`-titled issue with `Priority` gets a path to unattended implementation. `reviewPlanAndEscalate(repo, issue)` reads the plan comment already posted on the issue and runs a cheap text-only opus pass (no repo checkout — it judges from the plan text alone) returning `{verdict: "proceed"|"hold", reason}`; `proceed` requires a small, mechanical, revertible fix with an obvious correct implementation on an active incident, and the rubric says to answer `hold` when unsure or when the problem is not code-fixable at all (node down, resource exhaustion). On `proceed` it applies `Refined` so the implementer starts without waiting for a human; on `hold` it applies no label and Slack-pings for a human. A `## Escalation Review` verdict comment is posted on EVERY path (including parse failure and a thrown reviewer call, both treated as `hold`) — that comment is the durable dedup record, and it is posted *before* the label so a label failure cannot leave the review unrecorded. Like the step-back critique it deliberately does not contain `## Implementation Plan`, which would hijack plan lookup elsewhere.

**`agents/agent-context.ts`** — Shared tool-context strings (kubectl, namey_query, home-assistant including ha_list_entities/ha_api_request tool hints, fast-checks guidance, runner policy) injected into agent prompts; `RUNNER_POLICY_CONTEXT` composes two exported halves (#2300): `RUNNER_LABEL_POLICY` (the `runs-on: [self-hosted, linux|macos]` rule) and `RUNNER_ENVIRONMENT_POLICY`, which states that a linux job **may** land on a NixOS runner — phrased as capability, not census, because the pool is heterogeneous while hosts are converted — so it must never depend on `apt`/`apt-get`/`dpkg`/`dpkg-query`/`sudo`, must probe with `command -v` (never `dpkg -s`, which returns non-zero on NixOS for lack of a dpkg database *even when the tool works*, sending probe-then-install steps down the install branch), and must escalate a genuinely missing tool to an issue on `St-John-Software/nixos-config` rather than installing it in CI. Extending this one constant reaches all seven prompt builders that inject it with no call-site edits. exports `frontendContext(wtPath)`, which returns a one-line pointer at the repo's own design doc (`docs/DESIGN.md`, `DESIGN.md`, or `.claude/rules/frontend.md`, checked in that order under the worktree) when one exists and falls back to the full `FRONTEND_AESTHETICS_CONTEXT` block only when the repo has none — so the long anti-slop guidance is not paid for on every prompt; also exports `formatIssueCommentsForPrompt(comments, selfLogin, guardCtx)` — shared helper that formats `IssueComment[]` into flat prompt lines (`---` / label / body / `""` per comment); strips the Claws marker from self-authored comments without guarding them (no injection risk), and runs `guardContent()` on all human-authored comments; used by issue-refiner (three prompt builders) and issue-worker

## jobs/

**`jobs/issue-dispatcher.ts`** — Unified issue dispatcher — orchestrates planner + implementer agents; gates dispatch on issue author via `isAllowedActor()` in both Phase 1 (refined → implementer) and Phase 2 (fresh plan/refine → planner)

**`jobs/sequential-issue-processor.ts`** — Opt-in (per repo, via the `/jobs` matrix or the per-repo page's "Auto-process mode" toggle — `OPT_IN_JOB_NAMES`) "auto-process" mode for backlog-heavy repos (#2103, #2356). Each tick, per opted-in repo: gathers open, non-skipped, non-duplicate issues; if any of them already carries `Refined` it's in flight, so the job returns (serialized — one issue at a time); issues carrying `Manual Action` are dropped from the candidate set; if the candidate backlog signature (numbers + `updatedAt`) is unchanged since the last tick that ran the ranking, the job returns *before* the per-issue comment fetches (the cooldown is load-bearing, not an optimisation — without it the opus call would fire every 10 minutes on a static backlog); otherwise calls `prioritiseIssues()` (a single opus call in `issue-refiner.ts` that ranks **all** open candidates together and classifies each `auto`/`needs_human`/`out_of_scope`/`duplicate`/`obsolete` — issue number is filing order, not priority). It then labels `duplicate` entries `Duplicate` with a `CLAWS_DUPLICATE_OF:` back-reference comment (both issues stay open, matching `issue-refiner.ts`'s convention), comments-then-closes `obsolete` entries as `not_planned` (skipped when the issue carries `Priority` or already has an open PR — auto-closing is the only destructive action here and every one of those gates is deliberate), and applies the `Refined` label to the top `auto`-classified issue, which launches the existing plan → implement → PR → review → merge pipeline unchanged. A hallucinated `duplicateOf` is dropped unless it names another issue in the same tick's candidate set. Every per-issue mutation is individually `try`/`catch`ed so one 404 doesn't abort the pass, and at most one Slack line is posted per repo per tick. Cross-repo grouping (e.g. app + its deployment repo processed as one unit) is a known limitation, not yet implemented — each opted-in repo advances independently. **Owner requirements** (#2103): process one issue at a time, auto-refine and merge the non-controversial fixes, and defer to a human otherwise. Three corrections landed and must not be undone: (1) **issue number is not a proxy for priority** — "issues may be filed in an arbitrary order… a priority ordering must be established by looking at all open issues", which is why `prioritiseIssues()` ranks every candidate in a single call rather than taking the lowest number; (2) **opting a repo into this mode must be UI-driven**, not a raw config edit — hence the `/jobs` matrix toggle and, since #2356, the per-repo page toggle; and (3) #2356 replaced #2103's repo-wide `Manual Action` halt with per-issue exclusion — "if human input is required then it's fine to stop but try to make progress where possible" — with the blocked issues surfaced in the per-repo page's "Needs your input" panel instead

**`jobs/pr-dispatcher.ts`** — Unified PR dispatcher — orchestrates CI fixer + review addresser + reviewer + merger agents

**`jobs/scanner-runner.ts`** — Shared scanner runner utility used by scanner-dispatcher; `runRepoScanner()` walks a scanner's `repos` array via `mapSettledWithConcurrency` at `REPO_CONCURRENCY` (4, #2287) rather than a serial loop — safe because each of the 11 scanners' `spec.scan()` is synchronous (no interleaving), touches only its own repo's clone directory (`ensureClone` additionally dedups by directory), and `reportError()` never throws; matches the "max 4 concurrent repos" cap already used by smart-scheduled jobs. Exports `RECURRENCE_TRACKING_SNIPPET_LINES` (a `readonly string[]` canonical bash occurrence-tracking snippet for CI failure notification workflows — single source of truth shared by `main-build-monitor-scanner` and `issue-comment-spam-scanner` so both scanners recommend the identical pattern); also exports `renderViolationTable<T>(opts: ViolationTableOptions<T>)` and the `ViolationTableOptions<T>` interface — used by concurrency-scanner, runner-os-scanner, cache-on-self-hosted-scanner, migration-scanner, and ubuntu-latest-scanner to generate GitHub Markdown violation tables consistently (header row, separator, data rows, footer prose) without duplicating table-formatting logic. `processRepo()`'s dedup check uses `findIssueByExactTitle(repo.fullName, spec.issueTitle)` (#2019) — an exact-title lookup over the cached open-issue list — so an unrelated open issue sharing words with the scanner's title no longer suppresses real violation reports

**`jobs/workflow-parser.ts`** — YAML workflow parser utility — `parseWorkflow()` returns a typed `ParsedWorkflow` with `getTriggers()`, `getJobs()` (typed `JobInfo` with `runsOn`, `concurrency`, `steps`), `getPushConfig()`, and `getWorkflowRunTargets()`; `listParsedWorkflows(repoDir)` iterates a repo's `.github/workflows/` directory and returns `ParsedWorkflowFile[]` (each entry: `{ file, filePath, content, workflow }`) or `null` when the directory is absent — used by concurrency-scanner, cache-on-self-hosted-scanner, runner-os-scanner, and main-build-monitor-scanner to eliminate repeated boilerplate; `listWorkflowFiles(repoDir)` is the lower-level file enumeration used by ubuntu-latest-scanner; tolerates malformed YAML (returns an empty-job object rather than throwing)

**`jobs/connectivity-verifier.ts`** — On-demand connectivity checker used by `verify-only` mode — `runConnectivityVerification()` runs every configured integration (DB, GitHub App, CLIs, Slack, IMAP, SSH, Ollama, WhatsApp) with a 30 s per-check timeout and writes results to `verification_reports`; `getLatestVerificationReport()` is read by `GET /verify` and `GET /api/activation`

**`jobs/triage-claws-errors.ts`** — Investigates internal Claws errors ([claws-error] issues)

**`jobs/doc-maintainer.ts`** — Nightly documentation generation/update; also deterministically syncs `docs/claws-automation.md` (from `src/resources/claws-info.ts`) into every repo after each Claude pass — the skip gate requires both an unchanged HEAD and a current `claws-automation.md` to skip processing, so the first rollout touches every repo even without code changes; links it from OVERVIEW.md. Also gathers human-authored intent (#2090, #2227) — issue/PR bodies and comments filtered to exclude bot/Claws-authored content (`isHumanLogin()`) — into a temporary `.intent/` directory (never committed), and asks Claude to ensure every requirement it states is *reflected* in the standard feature docs a planning agent already reads, with cross-cutting ones recorded in `docs/requirements.md` (the old append-only `docs/intent-log.md` journal is retired). `machineAuthoredBodyReason()` additionally drops machine-written *bodies* that slip past `isHumanLogin()` (returning which rule matched, so each run logs a per-rule count of what it dropped) — before the GitHub App migration Claws posted under the owner's PAT, so alert issues (`[...]`-prefixed titles, `**Auto-created by Claws**`/`**Fingerprint:**` bodies) and `claws/`-branch PRs carry a human login; the check applies to bodies only, since human comments on machine-filed alert issues are often where real requirements live. History is walked BACKWARDS in dated chunks (250 items per run — a soft cap, extended to cover every item sharing the chunk's oldest date so the day-granular watermark can't strand the remainder of a busy day, 3,000 fetched per category) across successive nightly runs, tracked by the `doc_intent_backfill` watermark table and marked complete once a chunk exhausts history; running out of items while a fetch came back at the 3,000 limit instead records the distinct `window_exhausted` terminal state (history beyond the fixed `gh list` window is unreachable, so the walk stops with a warning rather than claiming completion); the watermark advances only after the agent pass returns, so a crash re-does the chunk rather than skipping it. See [doc-maintainer.md](jobs/doc-maintainer.md)

**`jobs/repo-standards.ts`** — Syncs labels and cleans legacy labels for each managed repo; removes stale local clones

**`jobs/improvement-identifier.ts`** — Reviews codebases for security issues and improvements via Claude; files issues for both (no longer opens PRs); conditionally emits Web/SEO and JSON-LD structured-data suggestions for repos that serve user-facing HTML (detected by presence of `*.html` files, static-site generator configs, or `public/`/`static/`/`dist/` output dirs — skipped for backend, library, CLI, and infra repos); truncated Claude output in the analysis phase is detected structurally — via `isCompleteJson()` in `json-extract.ts`, not by checking whether the output ends with a closing code fence (a prior heuristic that false-negatived whenever truncation happened to land right after an inner fence inside the improvement `body` text, issue #1810) — in the `parseReviewOutput` `onFailure` callback, and downgraded to a warning rather than an error issue; the job retries on the next tick

**`jobs/public-repo-scanner.ts`** — Daily scan of all public repos (including archived) for accidentally-committed sensitive data (secrets, private keys, credentials, PII); manages its own 7-day per-repo throttle via `processed_repos_daily`; does NOT call `writeClawsMcpConfig()` (capability: text-only, no MCP needed); files alert issues via `ensureAlertIssue()`; `parseFindings`'s `onFailure` callback also gates on `isCompleteJson()` (#1810) before calling `reportError`, so a truncated scan output is silently skipped and retried next tick instead of always filing a `[claws-error]` issue; `findSnapshotSource(fullName)` checks whether the scanned repo is a `PUBLIC_SNAPSHOTS` target and, if so, `fileFindings` routes the alert to `SELF_REPO` instead (never the private source — the body explains the finding is fixed by adding the path to that pair's `scrubPaths`, not by editing the source, which is allowed to hold the data) — see `public-snapshot-sync.ts` (#1875, #1962)

**`jobs/idea-suggester.ts`** — Suggests new ideas per repo, posts to Slack for reaction-based review

**`jobs/idea-collector.ts`** — Collects Slack reactions on ideas, creates GH issues and collection PRs; `appendEntries(file, header, ideas, formatFn)` (#2012) is the shared write helper for the accepted/potential/rejected branches — it writes each target file exactly once, so callers with multiple ideas destined for the same file must group by file path first (see the accepted branch's `acceptedByFile` map) rather than calling `appendEntries` once per idea, or concurrent same-file writes would clobber each other

**`jobs/issue-auditor.ts`** — Daily audit ensuring no issues fall between the cracks

**`jobs/whatsapp-handler.ts`** — Interprets WhatsApp messages via Claude, creates GitHub issues; runs the Claude call in `claude.ensureScratchDir("whatsapp-handler")` rather than `process.cwd()`, with `disallowedTools: claude.TEXT_ONLY_DISALLOWED_TOOLS` (#2068) and pinned to `provider: "claude"` (#2151) to isolate untrusted inbound message text from the production working directory, strip filesystem/shell/network tool access, and avoid OpenRouter 402 credit exhaustion

**`jobs/runner-monitor.ts`** — Monitors self-hosted GH Actions runners via SSH

**`jobs/mac-runner-waker.ts`** — Wakes sleeping self-hosted Macs over SSH — polls `MAC_RUNNER_REPOS` for queued workflow runs older than `QUEUED_GRACE_MS` (60s), fetches each run's queued jobs, matches macOS jobs (`isMacJob()`, any `macos` label) to a configured `MacRunner` by label subset match (`matchingRunners()`), then SSHes a bounded `nohup caffeinate -dimsu -t <WAKE_HOLD_SECONDS> & disown; echo awake` per matched host (`wakeRunner()`, 3 retries via `retryWithBackoff`) subject to a 5-minute per-host `WAKE_COOLDOWN_MS`. A bare network wake is a "dark wake" — the Mac answers SSH long enough to be picked up by the runner, then re-sleeps within seconds unless something holds a power assertion, causing the job to go silent mid-checkout ("lost communication with the server"); `caffeinate` holds the assertion for `WAKE_HOLD_SECONDS` (600s, covering pickup through the job's own keep-awake step) and the `-t` bound ensures a wake with no job behind it cannot pin the Mac awake indefinitely. SSH failures are split by cause (#2160, #2203): `isHostAbsent(err)` matches resolver/routing failures (`could not resolve hostname`, `name or service not known`, `no route to host`, etc. — deliberately excluding timeouts, connection-refused, and auth failures, which stay alert-worthy) and routes them to a `log.warn` plus one Slack `notify()` per absence *episode* (a per-host `absentSince` streak counter, reset on the next successful wake, gates repeat notification) instead of `reportError()` — a Mac being off the network is not a Claws defect and must not open a `[claws-error]` issue. Any other SSH failure still reports the per-host `[claws-error]` fingerprint (`mac-runner-waker-ssh:<host>`) via `reportError()`; GitHub API errors use the bare `"mac-runner-waker"` fingerprint. Deliberately excluded from `runners`/`RUNNER_HOSTS` — `runner-monitor`'s `df`/`sudo ./svc.sh status`/`journalctl` checks assume Linux and would fail non-interactively on macOS. Each `MacRunner` has an optional `enabled` flag (togglable per-Mac in the config UI); a Mac with `enabled: false` is skipped entirely — no SSH attempt and no `[claws-error]` alert — which is how an operator silences a Mac taken off the LAN (issue #1980). Also verifies the runner agent actually came online: when a job is still queued `RUNNER_ONLINE_GRACE_MS` (3 min) after a host was woken (i.e. the cooldown-skip path), it fetches the registered self-hosted runners via `gh.fetchSelfHostedRunners()` (repo-level registry merged with the org's — the Macs are org-level runners, so the repo list alone is empty; returns `null` on HTTP 403, in which case the check is skipped rather than false-positiving "unregistered") and raises a `mac-runner-offline:<host>` `[claws-error]` alert if no runner carrying the config runner's labels is registered, or if all matching runners are still `offline` — catching the case where the Mac answers SSH but the runner service is dead or unregistered, which previously left the job queued forever while the waker silently re-caffeinated the host every 5 minutes. **Owner requirements**: the job exists because self-hosted Macs may be asleep and Claws has SSH access, so it should wake them over the network itself rather than leaving a job stuck queued (#1959); the bounded `caffeinate` assertion is required, not optional, because a bare network wake produces only a dark wake — the owner reverted an attempt to drop it with "restore those commits. they were intentionally added to remove the need for manual steps" (#1934, landed in PR #2035); persistent SSH wake failures for one Mac must surface as a *per-host* alert (#1963); and the per-Mac `enabled` toggle exists so a laptop taken off the LAN can be silenced instead of alerting forever (#1980) — used in practice for `Brendans-MacBook-Pro` (#2112 needed no code change; the alert worked as designed)

**`jobs/scanner-dispatcher.ts`** — Runs scanners sequentially: ubuntu-latest, concurrency, migration, main-build-monitor, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, gitignore, dependabot-config, design-guidelines, dynamic-workflow-runner

**`jobs/ubuntu-latest-scanner.ts`** — Scans workflows for non-self-hosted runners, creates alert issues

**`jobs/concurrency-scanner.ts`** — Scans workflows for missing/misconfigured concurrency groups

**`jobs/migration-scanner.ts`** — Scans repos for incrementally-numbered migrations, recommends date stamps

**`jobs/main-build-monitor-scanner.ts`** — Scans workflows for main-branch builds and scheduled jobs, files alert if failures aren't monitored

**`jobs/cache-on-self-hosted-scanner.ts`** — Scans workflows for unnecessary caching steps (actions/cache, setup-* cache options) in self-hosted runner jobs where workspace is persisted

**`jobs/issue-comment-spam-scanner.ts`** — Scans workflows for the `gh issue create` + `gh issue comment` pattern (posting new comments on recurrence instead of editing the issue body)

**`jobs/runner-os-scanner.ts`** — Flags self-hosted runner jobs missing a linux/macos OS label

**`jobs/claude-config-scanner.ts`** — Scans repos for missing CLAUDE.md and named subagents in .claude/agents/, files alert issue with recommended layout

**`jobs/gitignore-scanner.ts`** — Scans repos for a missing `.mcp-claws.json` entry in `.gitignore`, files an unlabeled chore issue

**`jobs/dependabot-config-scanner.ts`** — Detects dependency manifests per repo and flags (ecosystem, directory) pairs no dependabot.yml/Renovate config covers, files alert issue with the exact YAML to add

**`jobs/design-guidelines-scanner.ts`** — Scans repos with a UI (framework dep or ≥3 UI-extension files) for missing design guidelines (docs/DESIGN.md or equivalent), files an unlabeled chore issue with a starter template

**`jobs/dynamic-workflow-runner-scanner.ts`** — Detects GitHub-generated dynamic workflows (Dependabot's updater, CodeQL default setup — no file in the tree, so `ubuntu-latest-scanner`'s `runs-on:` regex can't see them) executing on billed GitHub-hosted runners; fetches run history via `gh.listDynamicWorkflowRuns()`/`gh.getRunJobRunnerInfo()` rather than scanning files. For Dependabot's updater the fix is a single org-wide setting (Runner label), not a per-repo one, so the alert body states the exact remedy rather than attempting per-repo fixes (#2322). Ignores `dynamic/pages/` paths and paths whose latest run is >14 days old, so dead paths age out and their alerts auto-close (#2339). See [jobs/dynamic-workflow-runner-scanner.md](jobs/dynamic-workflow-runner-scanner.md)

**`jobs/stale-branch-cleaner.ts`** — Deletes stale claws/* remote branches after PR merge/close. Eligibility (`isBranchEligible`) is now a pure synchronous evaluator over a pre-fetched PR list rather than an async per-branch `gh` call: `processRepo` batches all candidate branch names for the repo through `gh.listPRsForBranches()` (#2293) in one shot before looping, so a repo with hundreds of stale branches issues a handful of GraphQL calls instead of one `gh pr list --head <branch>` subprocess per branch. A branch omitted from the returned map (unsafe name, or the fetch failed) is skipped rather than treated as an orphan — never delete blind.

**`jobs/idea-reconciler.ts`** — Reconciles closed-without-implementation ideas back to potential.md

**`jobs/qa-phase.ts`** — Exploratory QA on deployed PRs via Playwright browser automation

**`jobs/email-monitor.ts`** — Polls Gmail for veg box emails, generates recipes via Claude; IMAP connect goes through `retryWithBackoff` (#2037, 1 retry — 2 total attempts, matching the prior hand-rolled loop it replaced) rather than a bespoke retry loop; each attempt constructs a fresh `ImapFlow` instance since one whose `connect()` rejected is not reusable. Both Claude calls (extraction + recipe generation) run in `claude.ensureScratchDir("email-monitor")` rather than `process.cwd()`, with `disallowedTools: claude.TEXT_ONLY_DISALLOWED_TOOLS` (#2068) — email content is reachable by any external sender, so the agent runs isolated from the production working directory with filesystem/shell/network tools stripped. Before extraction, `processVegBoxEmail` checks the sender's address against `config.EMAIL_ALLOWED_SENDERS` (case-insensitive; enforced only when non-empty) and skips (marking the message seen) if it doesn't match

**`jobs/k3s-monitor.ts`** — Monitors k3s cluster pod/node health and Flux Kustomization/HelmRelease reconciliation failures; raises alerts with occurrence tracking (updates issue body instead of posting comments). Status reports `nodesNotReady` (alertable, excludes `k3sIgnoredNodes`) separately from `mutedNodesNotReady` (names of muted NotReady nodes), so the dashboard's red "Degraded" badge always corresponds to a filed alert issue, while muted-node downtime renders amber (#2133)

**`jobs/kubeconfig-refresh.ts`** — Kubeconfig auto-refresh via SSH — `refreshKubeconfig()` SSHes to a remote host (supports Tailscale hostname resolution via `resolveTailscaleHost()`), fetches the remote kubeconfig, rewrites its `server:` URL if needed, and atomically writes it locally; `isStaleKubeconfigError()` classifies kubectl errors that indicate a stale/rebuilt cluster vs. Claws-side defects a refresh cannot fix; used by k3s-monitor and prod-k8s-monitor as a best-effort recovery step before failing

**`jobs/prod-k8s-monitor.ts`** — Same detection logic as k3s-monitor but targets the prod cluster via configurable kubeconfig and files alerts to `PROD_K8S_REPO` (default: `St-John-Software/production-infra`); enabled via `prodK8sMonitorEnabled`; supports `prodK8sKubeconfigRefresh` for automatic kubeconfig rotation when the cluster endpoint changes

**`jobs/runner-metrics-sync.ts`** — Adaptive sync of GitHub Actions workflow runs to SQLite for runner utilization analytics

**`jobs/ha-upgrader.ts`** — Home Assistant update manager — polls HA entities, installs updates within dwell windows, raises GitHub issues on failures

**`jobs/ha-deploy-watcher.ts`** — Home Assistant deploy notifications — polls git-pull addon logs for Updating events, posts Slack notification with commit list (via `listCompareCommits`), compare link, and diffstat when `Updating <old>..<new>` is detected; commit-list fetch failures fall back to compare link only; first run baselines silently

**`jobs/datasette-export.ts`** — Exports the SQLite database to a remote host via scp (for Datasette exploration)

**`jobs/worktree-cleaner.ts`** — Daily prune of stale ~/.claws/worktrees/ directories

**`jobs/ha-monitor-common.ts`** — Shared entry guard for Home Assistant monitors — `resolveHaMonitorContext(enabled, logPrefix)` checks the enabled flag, `ha.isConfigured()`, and repo resolution (`HOME_ASSISTANT_CONFIG_REPO || FLEET_INFRA_REPO`), then fetches `ha.listStates()`; returns `{ repo, states } | null` (`null` on any guard failure, after logging the reason at `debug` or `warn` level as appropriate). Extracted from `bin-day-monitor.ts` and `ha-battery-monitor.ts`, which previously duplicated this sequence byte-for-byte; both now call it as the first line of `run()`

**`jobs/bin-day-monitor.ts`** — Polls Home Assistant every 15 minutes for `sensor.bin_scraper_*` entities (configurable prefix); maintains a single long-lived GitHub issue as a running availability log — issue is created on first MISSING event and never closed; body is rebuilt on every run to keep "Last checked" fresh; status transitions (HEALTHY ↔ MISSING) are appended as rows to an embedded history table; does NOT use `ensureAlertIssue` (that helper cannot record recoveries); entry guard via `resolveHaMonitorContext()`; enabled via `homeAssistantBinDayMonitorEnabled`; disabled by default

**`jobs/ha-battery-monitor.ts`** — Polls Home Assistant for battery sensors (`device_class=battery`, `unit_of_measurement=%`) below `homeAssistantBatteryThresholdPercent` (default 10%); creates a Priority issue in `homeAssistantConfigRepo` (falls back to `FLEET_INFRA_REPO`) listing all low devices; auto-closes the issue when all devices recover; body rebuilt in-place on each tick (never posts comments — compliant with issue-comment-spam rule); entry guard via `resolveHaMonitorContext()`; disabled by default (`homeAssistantBatteryMonitorEnabled`)

**`jobs/damp-reminder.ts`** — Weekly reminder (#1824) to log damp meter readings — runs on `intervals.dampReminderMs` (default 15 min, #1880); each tick checks `hasDampReadingLoggedSince(weekStart)` and auto-closes the open reminder (once per week, via the `closedForWeek` module-level guard) once readings are logged; on Monday local time ≥ 9 AM (`isReminderDay()`) with no readings yet, files a single deduplicated `Priority` issue in `SELF_REPO` via `findIssueByExactTitle` + `createIssue` (guarded by the `ensuredForWeek` module-level flag) pointing at the dashboard's `/damp` page — deliberately does NOT use `ensureAlertIssue()` (#1999): that helper is for recurring alerts where re-detection should bump an occurrence counter, and using it here rewrote the issue body (bumping "Occurrences") on every 15-minute tick all day instead of leaving a filed reminder untouched until closed. The owner's requirement is explicit (#1824, #1999): a weekly deduplicated reminder to log readings, filed as **one open issue that stays untouched** until it is closed — one-shot reminders are not "occurrences"

**`jobs/dependabot-alert-monitor.ts`** — Polls the GitHub Dependabot Alerts API per repo; auto-dismisses stale alerts (SBOM-based, then manifest-pin-based for pip `==` pins) and suppresses alerts via central config or a repo-local `.claws/dependabot-deferrals.json` manifest; files a Priority alert issue for the remainder. See [jobs/dependabot-alert-monitor.md](jobs/dependabot-alert-monitor.md).

**`jobs/dependabot-run-monitor.ts`** — Polls each repo's *dynamic* Dependabot updater Actions runs (`event=dynamic` filtered on `path == "dynamic/dependabot/dependabot-updates"` — a workflow with no repo file, so `on.workflow_run` and `main-build-monitor-scanner` can never cover it); groups completed runs from the last 30 days by ecosystem, keeps only the latest per group, scrapes the failed job log tail for the error, and files/auto-closes one unlabelled `ensureAlertIssue` per repo. Before reporting, cross-checks each failing group against the repo's live `.github/dependabot.yml` via `isRetiredGroup()` (reusing `normalizeDir`/`parseCoverage` from `dependabot-config-scanner.ts`) and drops groups whose ecosystem (mapped through `RUN_ECOSYSTEM_ALIASES`, since a run's internal ecosystem id — e.g. `npm_and_yarn` — doesn't always match the `package-ecosystem` value written in the config) no longer has a declaring entry — GitHub retains a retired ecosystem's last (failing) run as the permanent "latest" for 30 days otherwise (#2205); conservative on any ambiguity (globbed directories, unmapped ecosystem tokens) so an unclear case is still reported. Fails open — reports everything — when the config file is unreadable or unparsable. See [jobs/dependabot-run-monitor.md](jobs/dependabot-run-monitor.md).

**`jobs/actions-storage-monitor.ts`** — Daily scan of GitHub Actions cache + artifact storage usage across all repos. Fetches per-repo stats via `fetchRepoCacheUsage` and `fetchRepoArtifactUsage` in `github.ts` (fault-tolerant: 404 returns zero). Files a per-repo `ensureAlertIssue` when a repo uses ≥ 50 MB of Actions **cache** or has artifacts older than 7 days (high retention); files an org-level roll-up alert in `SELF_REPO` when total usage nears 80% of the 2 GB account quota. Runs at 5 AM (`actionsStorageMonitorHour`). **Owner requirements**: hitting the Actions storage quota (#1698) — and, separately, the Actions *minutes* quota (#1740, which is why Actions-hosted macOS runners were an exception worth tracking until #1855 retired them) — should produce continual monitoring with deduplicated per-repo issues naming the culprit repo, rather than a one-off cleanup. Zero usage is explicitly **not** the target: some repos (e.g. ones with heavy build caches) will never get there, and that is acceptable as long as Actions storage isn't used for *caching* and artifact retention stays low (#1738). Several storage alerts (#1724, #1759) were correctly resolved by one-time operational cleanup — purging orphaned caches/artifacts — with no Claws code change; the monitor was working as designed

**`jobs/public-snapshot-sync.ts`** — Daily (3 AM, #2106) private→public snapshot sync (#1826) of the `PUBLIC_SNAPSHOTS` pairs (`claws`, `3d-models`, `TempoStatusBar`, `fleet-infra` → `stjohnb/*`): rebuilds each target from its source's tracked files via `git archive`, scrubs development-process artefacts, disables workflow triggers, runs a fail-closed secret scan, and pushes one summarising commit. See [jobs/public-snapshot-sync.md](jobs/public-snapshot-sync.md).

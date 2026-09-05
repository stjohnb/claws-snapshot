# main-build-monitor

**Source**: `src/jobs/main-build-monitor.ts`
**Trigger**: Every 5 minutes (`intervals.mainBuildMonitorMs`)

Owns default-branch build monitoring for every repo, on GitHub and Forgejo, end to end: it
detects a failing run, re-runs it once when the failure looks transient, files or bumps a
`Build failure: <workflow name>` tracking issue when it does not (or when the retry fails
too), and closes that issue once the workflow goes green again.

## Why this job exists

`St-John-Software/namey#1881` (`Build failure: Build and publish Docker image`,
**Occurrences: 1**) was a pure transient: the Docker build's `RUN npm ci` died with
`npm error code ECONNRESET` / `npm error network aborted` against `registry.npmjs.org`. The
next push rebuilt `main` green with no code change. Nothing re-ran it — the repo's
`notify-failures.yml` simply filed an issue, and a planner burned a full plan on Dockerfile
retry hardening for a problem that had already fixed itself.

Eleven repos carried a hand-copied, drifted `notify-failures.yml`: ten titled the issue
`Build failure: <workflow name>`, `production-infra` used `[main] <workflow name> failed on
main`, several labelled it `bug`, some closed on recovery and some did not, and none of them
retried. Doing this centrally means one implementation to fix, one place to tune, and a
retry step that the repo-side `on.workflow_run` trigger could never perform.

## How it works

1. **Resolve** — every row in `main_build_failures` with a retry still in flight
   (`retried = 1 AND outcome IS NULL`, detected in the last 24 h) is re-read via
   `gh.fetchWorkflowRunById`. A `not_found` run is recorded `abandoned`; a run still in
   progress (or an API failure) stays pending for the next pass; a green retry is recorded
   `success` and nothing else happens — the close-on-recovery step below picks the issue up
   when it sees the green latest run. A retry that failed again is recorded `failure` and
   reported, with the issue body saying the retry was attempted.
2. **Expire** — a retry can fall out of that 24h window without ever resolving (e.g. a
   self-hosted runner pool down long enough that the re-run never completes).
   `db.getExpiredMainBuildRetries()` finds those `retried = 1 AND outcome IS NULL` rows once
   `detected_at` has aged past 24h and forces them to `retry-timed-out`, so the genuine
   failure they represent still flows into the retry-report step below instead of quietly
   disappearing until `pruneMainBuildFailures` deletes the row 30 days later.
3. **Retry unreported failures** — a row can reach a terminal outcome (above, or in the scan
   below) without ever getting `reported = 1`, because `ensureAlertIssue` itself can throw
   (a transient GitHub API error while filing/bumping the issue). `db.getUnreportedMainBuildFailures()`
   returns those rows — terminal outcome, `reported = 0`, excluding `success`/`abandoned` —
   and `reportFailure` is retried for each, every pass, so a single API hiccup can't
   permanently and silently drop a build-failure report.
4. **Scan** — repos with the job disabled in the `/jobs` matrix are dropped; the rest are
   processed four at a time via `mapWithConcurrency`.
5. Per repo, `loadRuns()` returns the completed `push`/`schedule` runs, newest first. For a
   GitHub repo that's `db.getDefaultBranchRuns(repo, defaultBranch, 7)`, reading what
   `runner-metrics-sync` already synced into `workflow_runs` — the job adds no second polling
   path of its own, so detection latency is `runner-metrics-sync`'s (up to ~20 min when a
   repo is idle). For a `forge: "forgejo"` repo it's `forgejo.listDefaultBranchActionRuns()`
   instead (two `?event=` filtered calls against `/repos/{repo}/actions/runs`, since Forgejo
   Actions history is never synced into `workflow_runs`), so detection latency there is just
   this job's own 5-minute tick. See "Forgejo differences" below.
6. The first row per `workflow_name` is that workflow's latest run. Workflows listed in
   `mainBuildMonitorIgnoreWorkflows[repo]` are dropped here.
7. A latest run with `conclusion: "success"` closes any tracking issue this job filed (see
   below). Any other non-`failure` conclusion — `cancelled`, `skipped`, `startup_failure`,
   `null` — is left alone: neither filed nor closed, matching the `conclusion == 'failure'`
   gate the per-repo workflows used.
8. A `failure` already present in `main_build_failures` has been handled; otherwise the job
   fetches the branch tip once per repo (`gh.getBranchTipCommit`) and decides whether to
   retry via `isRetryCandidate()` plus a transient classification:
   `gh.isInfrastructureOutage(jobs) || gh.isPreRepoStepFailure(jobs)` (reason `infra`), or —
   only when exactly one job failed — `isTransientLog()` over the tail of that job's log
   (reason `log-pattern`).
9. Transient → `gh.rerunFailedJobs`, a row with `retried = 1, outcome = NULL`, and step 1
   picks it up on a later pass (or step 2, if it never resolves within 24h). A `already
   running` error counts as a successful retry; a `403 Resource not accessible by
   integration` files the shared missing-`actions: write` alert via
   `reportActionsPermissionDenied` and then falls through to reporting; any other error
   warns and falls through to reporting, recorded `rerun-errored` so the issue says the
   re-run request itself errored rather than claiming the failure did not look transient.
10. Not transient (or the re-run call failed) → the run is recorded `not-retried` (or
    `rerun-errored`) and `ensureAlertIssue` files or bumps `Build failure: <workflow name>`.
    The issue is **unlabelled** — see [label-audit.md](../label-audit.md); `legacyTitles`
    carries production-infra's `[main] <workflow name> failed on main`, so an issue already
    open under the old title is *renamed* rather than duplicated. `ensureAlertIssue` writes
    the `First seen` / `Last seen` / `Occurrences` block on creation and bumps it on
    recurrence. The call passes `refreshBody: true`: the body carries *this* run's URL and
    event, so a later failure of the same workflow must rewrite it rather than leave a link
    to a run that has since rotated out of the Actions UI. A `reportFailure` call that
    throws (e.g. a transient `ensureAlertIssue` error) is caught per workflow so it cannot
    abort scanning the repo's remaining workflows; the row is already recorded with
    `reported = 0`, so step 3 retries it next pass.
11. Workflows listed in `prodAlertWorkflows[repo]` also page `notifyProdAlert`. That default
    is deliberately non-empty (`production-infra`'s `Tofu Apply` and `Flux Bootstrap`) so
    paging survives deleting the repo's own workflow with no ops step. Slack is wrapped in
    its own try/catch: a Slack outage must never abort issue filing.
12. **Close on recovery** — when the latest run of a workflow is green and this job has an
    unclosed reported failure for it, the tracking issue is commented on and closed as
    `completed`. The DB rows are marked closed regardless of whether an issue was found, so
    a missing issue does not retry the lookup on every tick.

## Forgejo differences

- **No retry** — `forgejo.rerunFailedJobs` is a documented no-op and Forgejo exposes no
  rerun endpoint, so step 8's branch-tip fetch (`gh.getBranchTipCommit`, which is
  GitHub-only) is skipped entirely for a `forge: "forgejo"` repo and every failure goes
  straight to step 10 (file/bump the issue).
- **Workflow name is the file name** — Forgejo's run record carries no display name, only
  the workflow file name (`workflow_id`, e.g. `deploy.yml`), so the tracking issue reads
  `Build failure: deploy.yml` rather than a human-readable workflow title.
- **`status` carries the conclusion** — there is no separate `conclusion` field; Forgejo's
  `status` (`success`/`failure`/`cancelled`/`skipped`/...) is mapped directly onto
  `MainBuildRunRow.conclusion`.
- **Namespaced DB keys** — `main_build_failures.run_id` is a shared TEXT primary key across
  every repo, and Forgejo's run ids are small per-instance integers, so they are stored as
  `forgejo:<id>` (see `runKey()`) to guarantee they never collide with a GitHub run id.
- **Detection latency is this job's own 5-minute tick**, not `runner-metrics-sync`'s, since
  Forgejo runs are fetched directly rather than synced.
- **An expired or missing Forgejo token surfaces as HTTP 404**, not 401 — indistinguishable
  from "the endpoint does not exist" at the API layer.

## Safety rails

- **Tip-SHA equality** (`isRetryCandidate`) — a run is only re-run when its `head_sha` still
  equals the branch tip. Re-running a superseded run republishes a stale artefact: namey's
  failing workflow pushes `latest` to GHCR. This is load-bearing. Never relax it, and never
  fall back to retrying when the tip is unknown.
- **`run_attempt <= 1`** — a hard "retry at most once" bound read from GitHub's own attempt
  counter, so it holds even if the DB is wiped.
- **4-hour age window** — a service restart must not resurrect and re-run day-old runs.
- **`push`/`schedule` events only** — `workflow_dispatch` is excluded on purpose: a human
  pressing "Run workflow" should see their own failure.
- **Single failed job on the log path** — `gh.fetchFailedJobLog` reads only the *first*
  failed job, so with two failures a transient one could mask a genuine one. The log
  heuristic is therefore skipped entirely unless exactly one job failed.
- **Per-pass budgets and pool-saturation deferral** — at most 5 re-runs and 5 log fetches per
  pass, and nothing is re-run while `isPoolSaturated()` (the shared ci-fixer queue-depth
  check) is true. A blocked run is left untouched in the DB, so it is neither retried nor
  reported yet and stays eligible on the next tick. Deferral is per workflow: the repo's
  remaining workflows are still scanned, since closing a green issue or reporting a
  non-retryable failure spends no budget. A re-run slot is reserved *synchronously* before
  the classification `await` and handed back if the re-run does not happen, so four repos
  running concurrently cannot each pass the check and overshoot the budget.
- **Issue-closing label guards** — an issue carrying `Refined`, `In Review` or `Claws Ignore`
  is never closed: it is already being implemented, already has an open PR, or has been
  parked by a human.
- **Per-workflow report isolation** — `reportFailure` is called inside its own try/catch in
  the per-repo scan, so a single workflow's `ensureAlertIssue` throwing (a transient GitHub
  API error) cannot abort scanning the repo's remaining workflows for that pass.
- **No retry can silently vanish** — a retry that is still in flight when its `detected_at`
  ages past the 24h window `getPendingMainBuildRetries()` looks at is forced to a terminal
  `retry-timed-out` outcome by `getExpiredMainBuildRetries()` rather than just dropping out
  of that query, so it still reaches `getUnreportedMainBuildFailures()` and gets reported.
- **Never widen `TRANSIENT_LOG_PATTERNS`** — the list is exactly the network/registry/runner
  errors that mean the build never reached a verdict on the repo's own code. A pattern like
  `/error/` or `/exit code 1/` would spend real CI runs on genuine failures and, worse, hide
  a red `main` behind an automatic retry.

## Configuration

| Key | Default | Effect |
|---|---|---|
| `intervals.mainBuildMonitorMs` | `300000` (5 min) | How often the job runs |
| `prodAlertWorkflows` | `{"St-John-Software/production-infra": ["Tofu Apply", "Flux Bootstrap"]}` | Repo → workflow names whose failure also pages `slackProdAlertsWebhook` |
| `mainBuildMonitorIgnoreWorkflows` | `{}` | Repo → workflow names the job must never file issues for |
| `slackProdAlertsWebhook` | *(empty)* | Prod-alert webhook; falls back to `slackWebhook` |

Per-repo opt-out is the standard `disabledJobsByRepo` / `/jobs` matrix entry.

## State

`main_build_failures` in SQLite — see
[database-schema.md](../database-schema.md#main_build_failures-table). Rows are pruned after
30 days by the daily prune loop in `main.ts`.

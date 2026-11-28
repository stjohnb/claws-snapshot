# Claws metrics

Claws exports its own Prometheus metrics, so dashboard slowness and rollout
downtime can be measured in Grafana (#clw_01M59ZXZ26S1WBJQRSBGJXZVPZ). The source
is `src/metrics.ts`.

## Endpoint

- `GET /metrics` on a separate listener, port `CLAWS_METRICS_PORT` (default
  `9464`, `0` disables it), bound to `CLAWS_BIND_HOST`. See
  [configuration.md](configuration.md).
- The dashboard port (3000) returns 404 for `/metrics`, and nothing on 9464 goes
  through the Ingress. Prometheus scrapes the in-cluster Service directly, using a
  static `additionalScrapeConfigs` job in fleet-infra.
- The metrics server is closed during `shutdown()`, just before the database.

## Metrics

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `claws_http_request_duration_seconds` | histogram | `route`, `method`, `status_class` | Time spent serving each dashboard/API request. Buckets: 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30 s. |
| `claws_http_requests_in_flight` | gauge | — | Requests currently being served. |
| `claws_forge_request_duration_seconds` | histogram | `forge` (`github`/`forgejo`), `outcome` (`ok`/`error`) | One `gh` CLI call in `github.ts`'s `gh()`, or one Forgejo API request in `forgejo.ts`'s `forgejoRequest()` (behind `forgejoFetch`, `forgejoSend` and raw reads). Retries are included. |
| `claws_build_info` | gauge | `version` | Always 1. The label is the running build. |
| `claws_shutting_down` | gauge | — | 1 once SIGTERM/SIGINT has started `shutdown()`. |
| `claws_process_listening_timestamp_seconds` | gauge | — | Unix time this process's dashboard started listening. |
| `claws_last_rollout_gap_seconds` | gauge | `previous_version` | Time from the previous process's SIGTERM to this process listening. The series is absent until a marker has been read. |
| `claws_last_shutdown_phase_seconds` | gauge | `phase` | How long each phase of the previous shutdown took. Phases: `drain`, `cancel`, `auth_sync`, `memory_flush`, `close`. |
| `claws_alertmanager_poll_ok` | gauge | `cluster` (`prod`/`fleet`), `repo` (`owner/name`) | 1 when the `alertmanager-poller` job's last read of the repo's Alertmanager (through its Grafana's `alertmanager` datasource proxy, or Grafana's own managed-alerts Alertmanager for `poll.source: "grafana"`, signed in as `claws-service`; a poll with no credentials mounted fails) returned 200 and parsed, else 0. Set once a minute for each repo with an `alertBridge.poll`, so two repos polling one cluster through different datasources (e.g. `alertmanager` and `alertmanager-prod` on fleet) each keep their own series; fleet Grafana's `claws-alertmanager-poll-failing` rule fires after 30 min at 0. See [issue-tracker.md#alert-bridges](issue-tracker.md#alert-bridges). |
| `claws_alert_issues_filed_total` | counter | `cluster` (`prod`/`fleet`) | Alert issues the `alertmanager-poller` filed, one per alert group, for a repo whose `alertBridge.poll.mode` is `write` or `direct` (`routeDirectAlerts` in `src/alert-bridge.ts`). See [issue-tracker.md#alert-bridges](issue-tracker.md#alert-bridges). |
| `claws_alert_filing_capped_total` | counter | `cluster` (`prod`/`fleet`) | Direct-mode polls that reached `alertBridge.poll.maxNewIssuesPerPoll` and deferred the remaining alert groups to the next poll (logged as `warn` `alert filing capped`). |
| `claws_dedupe_key_moves_total` | counter | `reason` (`merge`, `adopt`) | Dedupe keys moved onto a native issue: `merge` counts the keys a duplicate hands to the issue it duplicates when it is closed (`src/issue-merge.ts`; see [issue-tracker.md](issue-tracker.md#merging-a-duplicates-keys)); `adopt` counts an alert group's exact key added to the open per-service alert issue that already tracked the alert (the poller's legacy adoption). Counted by the process that makes the merge, so a merge inside an agent pod's planner run is logged (`dedupe keys moved`) but not counted. |
| `claws_conflict_fix_runs_total` | counter | `repo` | `ci-fixer:merge-conflict` runs the PR dispatcher enqueued (a new `work_queue` row, not one already queued). A conflict routed from a `ci-fixer` run inside an agent pod is not counted. With `claws_prs_merged_total`, the conflict-fix runs per merged PR. See [jobs/pr-dispatcher.md](jobs/pr-dispatcher.md#1-resolve-merge-conflicts). |
| `claws_conflict_fix_deferred_total` | counter | `repo` | Conflicting PRs whose conflict resolution began waiting on an overlapping open PR ahead of them (`src/overlap-gate.ts`), counted once per deferral when it starts, not each tick it lasts. Counted by the controller's PR dispatcher; a `ci-fixer` handler in an agent pod logs but does not count. |
| `claws_prs_merged_total` | counter | `repo` | `claws_prs` rows the PR dispatcher's store refresh finalised as `merged`, whether the auto-merger or a person merged the PR. |
| `claws_actions_control_total` | counter | `action` (`cancel-run`/`disable-workflow`/`enable-workflow`), `outcome` (`ok`/`already_finished`/`failed`) | Forgejo Actions runs a session (`claws_cancel_runs`) or the dashboard cancelled, one per run, and workflows it disabled or enabled (`src/forgejo-run-control.ts`). `already_finished` is a run that ended before the cancel reached it. No alert. |
| `claws_overlap_held_steps` | gauge | `repo` | Ready plan steps the issue dispatcher found held behind overlapping in-flight work (`src/overlap-gate.ts`'s `heldSteps`) on its last tick, by the step's repo; set for every dispatched repo each tick, 0 when none. See [jobs/issue-dispatcher.md](jobs/issue-dispatcher.md). |
| `claws_grafana_auth_ok` | gauge | `cluster` (`fleet`) | 1 when the cluster's Grafana accepted Claws' last sign-in probe on `GET /api/user`: a non-admin user and, when the `claws-service` credentials are mounted, the login `claws-service`; else 0. Probed every 15 minutes, fleet only: prod observability is read through fleet Grafana's `prometheus-prod`, `loki-prod` and `alertmanager-prod` datasources; fleet Grafana's `claws-grafana-auth-failing` rule fires after 1 h at 0. See [observability-access.md](observability-access.md). |
| `claws_aws_grant_sweep_grants_total` | counter | `outcome` (`ended`/`retry`/`failed_signin`) | AWS grants the controller's expiry sweep (`sweepExpiredAwsGrants` in [`src/aws-access.ts`](../src/aws-access.ts), every 30 s) handled, from the totals its `AWS grant expiry sweep finished` line carries: `ended` is an expired grant it revoked, `retry` a grant whose revoke it could not confirm and left for the next sweep (stale `granting`/`revoking` take-backs included), `failed_signin` an expired or interrupted sign-in it failed. Controller only; every label value is zero-seeded at start. A steadily non-zero `retry` means a grant is not being revoked. |
| `claws_aws_grant_sweep_warnings_total` | counter | `warning` (`revoke_retry`/`end_failed`) | Warnings the AWS grant expiry sweep logged, one per line: `revoke_retry` is `Could not revoke an expired AWS grant; retrying next sweep`, `end_failed` is `Could not end an expired AWS grant`. Controller only, every 30 s, zero-seeded; see [`src/aws-access.ts`](../src/aws-access.ts). |
| `claws_aws_grant_sweep_last_finish_timestamp_seconds` | gauge | — | Unix time the AWS grant expiry sweep last finished, set on every run including those that changed nothing, so a stalled sweep shows. Controller only, every 30 s; see [`src/aws-access.ts`](../src/aws-access.ts). |
| `claws_session_process_exits_total` | counter | `reason` (`pane_dead`/`tmux_gone`/`pane_gone`/`start_failed`/`unreported`/`other`), `code` (`0`/`nonzero`) | Session pod process exits reported to `POST /session-pods/:id/exit`, by the reason the pod gave (`recordPodExit` in [`src/session-backend-k8s.ts`](../src/session-backend-k8s.ts), #clw_01M8997QNSAC11ZBBCZ4HCNVVC): `pane_dead` is tmux showing the agent pane dead, `tmux_gone`/`pane_gone` are ends confirmed with the agent process gone but no dead pane, `start_failed` is tmux failing to create the session, `unreported` is a pod on an image from before the report carried a reason, `other` any other value. Counted by the web process after the exit is recorded; zero-seeded. No alert yet. |
| `claws_db_pool_clients` | gauge | `state` (`total`/`idle`/`waiting`) | The Postgres connection pool's open clients, idle clients, and queries waiting for a free client. Read at scrape time; absent on SQLite and PGlite, which have no pool. |
| `claws_nodejs_*`, `claws_process_*` | various | — | prom-client default runtime metrics, e.g. `claws_nodejs_eventloop_lag_seconds`, heap and GC. |
| `claws_agent_tokens_total` | counter | `provider`, `model`, `account`, `repo`, `job` | Agent tokens used by tasks and interactive sessions, since records began. `job` is the job-name prefix (as `/usage` groups it), `interactive-session` for sessions. Controller only; see [Agent and pipeline metrics](#agent-and-pipeline-metrics). Held at a per-process high-water mark per label set. |
| `claws_agent_cost_usd_total` | counter | `provider`, `model`, `account`, `repo`, `job` | Agent cost in US dollars, with the same labels and sources as the tokens counter. Rounded to 1e-6 USD and held at a per-process high-water mark per label set. |
| `claws_agent_tasks_total` | counter | `job`, `outcome` (`completed`/`failed`) | Finished agent tasks. |
| `claws_agent_task_failures_total` | counter | `job`, `failure_reason`, `pod_class` (`default`/`large`/`none`) | Failed agent tasks by recorded failure reason; see [Task failures and queue removals](#task-failures-and-queue-removals). |
| `claws_agent_items_removed_from_queue_total` | counter | `job`, `reason` (`memory-limit`/`timeout`), `pod_class` (`default`/`large`/`none`) | Items auto-skipped (removed from the queue) after three kills of the same kind. |
| `claws_provider_hold_expiry_timestamp_seconds` | gauge | `provider`, `account`, `tier`, `reason` (`usage-limit`/`rate-limit`/`auth-expired`/`model-tier`) | Unix time each active provider hold lapses. Only holds still in force have a series. A 5-hour and a weekly account limit both read `usage-limit`. |
| `claws_agents_running` | gauge | `job` | Agent tasks running now. |
| `claws_queue_items` | gauge | `category` | Items in the controller's in-memory work queue snapshot (`getQueueSnapshot`), every category included. |
| `claws_work_queue_items` | gauge | `kind`, `status` (`queued`/`running`) | Queued and running `work_queue` rows. |
| `claws_board_issues` | gauge | `column` | Open issues on the board in each column, the cards the nav's issues count covers. Every board column has a series. |
| `claws_board_issues_waiting_on_operator` | gauge | — | Board issues in a column that waits on the operator: the nav's issues attention count. |
| `claws_open_prs` | gauge | `stage` | Open Claws PRs (`claws_prs` rows not `merged` or `closed`) per stage. Every open stage has a series. |
| `claws_job_last_run_timestamp_seconds` | gauge | `job` | Unix time each job prefix's latest finished (`completed` or `failed`) run completed. |
| `claws_job_last_run_success` | gauge | `job` | 1 when that run completed, 0 when it failed. |
| `claws_agent_metrics_last_sample_timestamp_seconds` | gauge | — | Unix time the agent and pipeline metrics last sampled with every part succeeding. |

### The `route` label

`route` is Hono's matched route pattern, not the raw path. For example
`/issues/clw_…` is recorded as `/issues/:id`, which keeps the number of label
values bounded. The timing middleware is registered on `*` before every route. It
takes the last matched route that is not a wildcard (`*`, `/*`), and a request
that matched nothing is labelled `unmatched`. Long polls such as `/api/events`
have their own route label, so they do not skew page percentiles.

## Agent and pipeline metrics

The `claws_agent_*`, `claws_provider_hold_*`, `claws_agents_running`,
`claws_queue_items`, `claws_work_queue_items`, `claws_board_*`, `claws_open_prs`
and `claws_job_last_run_*` series come from `src/agent-metrics.ts`
(#clw_01M663VPZ4ES5PZTY4JQ9VJ5CT).

- **Controller only.** Only the controller process (`CLAWS_ROLE` `controller` or
  `all`) imports the module and starts its sampler, so the series carry
  `role="controller"` and a query never sums a web copy.
- **Sampled, not computed per scrape.** A background sampler refreshes the cached
  values every 60 s, and the board columns every 5 min (each count lists every
  repo's open issues). A scrape only reads the cache. A part that fails to sample
  keeps its last values and logs a `[agent-metrics]` warning with the `part`; each
  sample logs a debug line with `duration_ms`.
- **Counted from the database.** The token, cost and task counters are recounted
  from the database on each sample, never incremented in memory, so a restart,
  a rollout or the web/controller split neither loses nor double-counts usage, and
  `increase(...[24h])` stays exact.
- **Rounded and monotonic per process.** Cost is rounded to 1e-6 USD, and both
  usage counters are held at a per-process high-water mark per label set, so
  float noise in the database sum never reads as a counter reset. Data scraped
  before this guard still shows phantom resets until it ages out of the query range.
- **The ledger keeps them monotonic.** Before `pruneTasks` or a session delete
  (`pruneEndedSessions`, `deletePersistedSession`, `deleteEndedPersistedSession`)
  removes rows, the same transaction folds their sums into the
  `usage_retired_totals` table. When a task's or session's cumulative usage is
  overwritten by a lower snapshot, the old values are folded in first.
- **Bounded labels.** No issue or PR numbers, and never a session's working
  directory: a session's `repo` is its repo or `""`, its `account` is `""`. A
  task's `account` is the Claude account that served it, or `""`.

The first sample after this shipped exposed every retained task as one jump;
`increase()` reads correctly from the next sample on.

### Task failures and queue removals

`claws_agent_task_failures_total` and `claws_agent_items_removed_from_queue_total`
(#clw_01M7ST52PFKR6PRCF0FTS0GT8T) are not recounted from `tasks`. Each is read
from the `agent_event_totals` table, which is incremented when the event is
recorded: `recordTaskFailed` bumps a `task_failures` row, and the timeout handler
bumps an `items_removed` row when it auto-skips an item. Pruning `tasks` never
lowers them. They started at zero on deploy; earlier failures are not backfilled.

- **`failure_reason`** is the task outcome's `failureCategory` (`memory-limit`,
  `timeout`, `external-kill`, `rate-limit`, …), or `unknown` when it has none.
  A Kubernetes OOM kill of an agent pod is recorded as `memory-limit` (outcome
  `memoryMeasurement: kubernetes-oom`), so it is counted once, as
  `memory-limit`. Only the call that moves a task from `running` to `failed`
  counts it.
- **`reason`** on a removal is `memory-limit` (the third same-cap watchdog kill)
  or `timeout` (the third timeout). A default-class kill that escalates its item
  to the large class is not a removal.
- **`pod_class`** is the agent pod's size class (`default`, `large`) from the
  task's `work_queue` row, or `none` for an in-process run.
- **Zero-seeded.** Every job with a finished task exports a 0 series for the
  `memory-limit` failure reason and both removal reasons, in
  each of `default`, `large` and `none`, so `increase()` sees the first memory
  kill. Other failure reasons appear on their first occurrence. A job with no
  finished task yet has no seed, so its very first failure is not visible to
  `increase()`.
- A failed bump logs a warning and never fails the recording or the skip; a pod
  on a newer image talking to an older controller loses only the removal count.

## Rollout window and the shutdown marker

Under `CLAWS_ROLE=all` the dashboard is unreachable for the whole of
`shutdown()`: a Terminating pod leaves the Service's ready endpoints at once.
So the rollout window is measured from **SIGTERM until the next process is
listening**, not from `server.close()`. Under `CLAWS_ROLE=controller` the web
tier keeps serving the dashboard, and the same window measures only how long
background processing is stopped, not dashboard downtime.

`shutdown()` in `src/main-controller.ts` times each phase:

- `drain`: WhatsApp stop and `scheduler.drain` (cap 300 s);
- `cancel`: cancelling the current task, plus its 5 s wait;
- `auth_sync`: the credential Secret sync;
- `memory_flush`: the memory backup (cap 60 s).

Right after `server.close()` it writes `WORK_DIR/state/last-shutdown.json` on the
data PVC:

```json
{
  "version": "2026.10.19-abc1234",
  "shutdownStartedAt": "2026-10-19T12:00:00.000Z",
  "phases": { "drain": 30.2, "cancel": 0, "auth_sync": 0.8, "memory_flush": 12.5 },
  "serverClosedAt": "2026-10-19T12:00:43.700Z"
}
```

Phases are in seconds and timestamps are ISO 8601 UTC. When the next process is
listening, `readRolloutGap` reads the marker and does the following:

- It sets `claws_last_rollout_gap_seconds` to listening − `shutdownStartedAt`.
- It sets the phase gauges. `close` is derived as (`serverClosedAt` −
  `shutdownStartedAt`) minus the four timed phases.
- It logs one `[metrics] rollout gap` line whose context has `rollout_gap_ms`,
  `boot_gap_ms` (listening − `serverClosedAt`, the boot part of the window),
  `previous_version`, `version` and `phases`.
- It deletes the marker, so a later crash-restart cannot report the same
  shutdown again.

A missing or malformed marker is ignored. So is a stale one, whose
`shutdownStartedAt` is more than 24 h before this boot, as left behind when an
OOM kill or eviction skipped the write. In all of these cases the gap gauges stay
unset.

If a shutdown runs past the 420 s grace period it is SIGKILLed before the marker
is written. That outage is still visible from outside: in the Gatus `Claws` check,
`up{job="claws"}` and `kube_pod_status_ready{pod="claws-0"}`.

## Reading p50/p95

In Grafana (the board is defined in fleet-infra), the per-page percentiles are:

```promql
histogram_quantile(0.5,  sum by (le, route) (rate(claws_http_request_duration_seconds_bucket{method="GET"}[5m])))
histogram_quantile(0.95, sum by (le, route) (rate(claws_http_request_duration_seconds_bucket{method="GET"}[5m])))
```

Plot these against `claws_build_info` (one series per version) to see a release.
`claws_last_rollout_gap_seconds` and `claws_last_shutdown_phase_seconds` show how
long the last window was and which phase dominated it. Forge latency is
`histogram_quantile(0.95, sum by (le, forge) (rate(claws_forge_request_duration_seconds_bucket[5m])))`.

Without Grafana, the read-only MCP tool `claws_dashboard_latency` calls
`GET /api/runtime/latency` (API auth). It returns:

- `sinceBoot`, the start of the sample window;
- `version`;
- `lastRolloutGapSeconds` and `lastShutdownPhases`;
- `routes`: one entry per method and route, with `count` since boot and `p50Ms`,
  `p95Ms` and `maxMs` over that route's last 1000 requests, slowest p95 first.

It covers only the current process. Grafana keeps the history across restarts.

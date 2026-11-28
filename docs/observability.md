# Claws observability

Claws' own observability policy under the
[observability contract](observability-contract.md). The whole file is the policy; the
`observability-contract-scanner` checks it like any other repo's. Keep it accurate as routes,
jobs, metrics and alerts change.

## Observability

### Scope

Claws runs as a single StatefulSet pod in the fleet cluster (`CLAWS_ROLE=all`, or split into
controller and web tiers), plus short-lived agent and session pods in `claws-sessions`. The
dashboard, the scheduler's background jobs, the database and the forge client are all in
scope.

### Logging

This service follows the St-John-Software structured logging contract: one JSON object per
line on stdout, never to files. Loki parses it at query time with `| json`.

| Field | Rule |
|---|---|
| `time` | ISO 8601 UTC with milliseconds |
| `level` | lowercase **string**, one of `trace debug info warn error fatal`. Never numeric (pino's default numeric levels are not detected by Loki) |
| `msg` | short, constant message. Ids and values go in fields, never interpolated into the message |
| `service` | service name, matching the Kubernetes `app` label |
| `component` | subsystem or job name (e.g. `reminder-monitor`) |
| `err` | object `{ type, message, stack }` for errors. Never a bare string |
| correlation keys | `request_id`, `run_id`, `repo`, `issue`, `pr` when known |
| HTTP access lines | `http.method`, `http.path`, `http.status`, `duration_ms` |

- Keys are `snake_case`; durations end in `_ms`.
- No secrets, tokens or credentials in any field or message.
- Pretty-print only when stdout is a TTY (e.g. `pino-pretty` in dev). In containers always emit JSON.
- Shell scripts and CronJobs may use logfmt (`level=info msg="..."`) since JSON is awkward in
  shell. Loki parses both.
- Keep Loki labels low-cardinality: nothing in this contract becomes a Loki label; fields are
  parsed at query time with `| json` / `| logfmt`.
- Do not add direct `console.*` calls to service code; log through the shared logger module.

Reference Node implementation (pino):

```ts
import pino from "pino";

export const logger = pino({
  base: { service: "my-service", component: "api" },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  serializers: { err: pino.stdSerializers.err },
});
```

The `formatters.level` line is required: without it pino emits numeric levels (`"level":30`),
which Loki does not detect.

A `component` field passed to the logger fills the line's `component` when the message has no `[component]` prefix.

In Claws, service code logs through `src/log.ts` (modules upstream of it use
`src/log-core.ts`, the session pod `src/session-pod/log.ts`); see
[observability-contract.md](observability-contract.md#in-the-claws-codebase).

New log lines keep `msg` constant and pass ids and values through the logger's trailing
fields argument (`log.info(msg, { op, duration_ms })`, `log.error(msg, err, fields)`), never
interpolated into `msg`. Lines logged while serving a dashboard request carry its
`request_id`: the `*` middleware in `src/server.ts` keeps a well-formed incoming
`X-Request-Id` (`^[A-Za-z0-9._-]{1,128}$`) or generates a UUID, and echoes it in the
`X-Request-Id` response header. WebSocket upgrades bypass that middleware and carry none.

Log route: `src/log-core.ts` applies no level filter: `debug`/`info` lines go to
stdout and `warn`/`error` to stderr. Fleet-infra's Promtail DaemonSet (`apps/monitoring/promtail.yaml`) reads both
container streams, and its pipeline drops only CoreDNS in-cluster lookups and decorates step-ca lines; it filters
nothing by level, so every `info`-and-above line reaches Loki. Query one component with
`{app="claws"} | json | level="info" | component="<component>"`.

As rules for new changes: every action Claws takes logs one `info` line naming the action and
its outcome or new state, routine polling stays at `debug`, and failures log at `warn` or
`error`. No change sets a log filter or forwarding level that drops `info`.

### Metrics

`GET /metrics` on its own listener, port `9464` (`CLAWS_METRICS_PORT`), served by prom-client
from `src/metrics.ts`. Every series is listed in [metrics.md](metrics.md). Prometheus scrapes
the in-cluster Service through a static `additionalScrapeConfigs` job in fleet-infra; nothing
on that port goes through the Ingress.

### Traces

None. Claws runs no tracing SDK and exports no spans; per-request and per-call timing comes
from the histograms in [metrics.md](metrics.md) and `duration_ms` log fields.

### Latency budgets

- Dashboard `GET` routes: p95 ≤ 500 ms per `route` label of
  `claws_http_request_duration_seconds`, excluding the `/api/events` long poll.
- Forge requests: p95 ≤ 2 s on `claws_forge_request_duration_seconds`.

Saturation:

- Memory: `container_memory_working_set_bytes{namespace="default",container="claws"}` stays
  below 80 % of `kube_pod_container_resource_limits{resource="memory"}` (10 GiB on the
  controller StatefulSet, 1 GiB on `claws-web`); `claws_process_resident_memory_bytes` is the
  in-process view.
- CPU: the `claws` container has no CPU limit, so it is never throttled;
  `rate(claws_process_cpu_seconds_total[5m])` and `claws_nodejs_eventloop_lag_p99_seconds`
  ≤ 0.1 s stand in.
- DB pool: `claws_db_pool_clients{state="waiting"}` is 0 outside short bursts.

These are working budgets; correct the numbers here when they change. No alert rule watches
them yet.

### Dashboards and alerts

- The Claws dashboard-latency board is defined in fleet-infra
  `apps/monitoring/dashboards/claws-dashboard-latency.yaml` and served by fleet Grafana.
- The Claws overview board (uid `claws-overview`, fleet-infra
  `apps/monitoring/dashboards/claws-overview-dashboard.yaml`) charts the agent usage and
  pipeline metrics ([metrics.md](metrics.md#agent-and-pipeline-metrics)).
- Fleet Grafana's `claws-grafana-auth-failing` rule files an alert issue when Claws' Grafana
  JWT has been rejected for an hour (see [observability-access.md](observability-access.md)).
- Fleet Grafana's `claws-alertmanager-poll-failing` rule ("Claws Alertmanager poll failing",
  `min by (cluster) (claws_alertmanager_poll_ok) == 0` for 30 minutes) files an alert issue when
  the `alertmanager-poller` job cannot read a cluster's Alertmanager; a `claws-overview`
  panel charts the gauge.
- Two fleet Grafana rules in the `Claws` group watch agent memory kills
  ([metrics.md](metrics.md#task-failures-and-queue-removals)), each with `claws_service: claws`
  and filing an alert issue with no Slack route: `claws-agent-memory-kills-repeating` ("Claws
  Agent Memory Kills Repeating", warning) fires when one job and pod class has two or more
  `memory-limit` task failures (the watchdog's and Kubernetes OOM kills) within an hour, and
  `claws-agent-item-removed-memory-kills` ("Claws Agent Item Removed After Memory Kills",
  critical) fires for 24 hours after an item is removed from the queue after `memory-limit`
  kills. A single kill followed by a successful retry does not alert. The `claws-overview`
  board's "Memory kills and queue removals" and "Task failures by reason" panels chart the two
  counters.
- The `claws-overview` board charts the controller's AWS grant expiry sweep from
  `claws_aws_grant_sweep_grants_total`, `claws_aws_grant_sweep_warnings_total` and
  `claws_aws_grant_sweep_last_finish_timestamp_seconds` ([metrics.md](metrics.md#metrics));
  no alert rule watches it.
- The `alertmanager-poller` job (component `alertmanager-poller`, once a minute) logs `info`
  `poll started` / `poll finished` (with `duration_ms` and a `failed` count), a `debug` line with
  `duration_ms` and the Grafana URL for each Alertmanager fetch, a `warn` with `cluster`,
  `http_status` or `probe_error` and `duration_ms` for a failed fetch, and one `info`
  `no alert issue change` with `bridge_repo`, `cluster`, `mode`, `decision`, `firing` and a
  `reason` (`no_firing`, `unchanged`) on a successful poll that changes no alert issue. Query
  `{app="claws"} | json | component="alertmanager-poller"`.
- Brokered AWS access (`src/aws-access.ts`, component `aws-access`,
  #clw_01M8426RTMG1TWE224NXW1V02S) logs one line per Identity Center call (`AWS call`, with
  `op` — `RegisterClient`, `StartDeviceAuthorization`, `CreateToken`, `GetRoleCredentials`,
  `Logout` — `target` host, `status` and `duration_ms`; `info`, `debug` for the `CreateToken`
  polls, `warn` `AWS call failed` with `error_code` on a failure), and one `info` per state
  change: `AWS sign-in started`, `AWS sign-in failed` (with `reason`), `AWS sign-in
  ended` (with `outcome`: `superseded` by a newer sign-in or `declined` by a Deny), `AWS
  grant started` (with `permission_set`, `granted_by` and
  `credentials_expire_at`) and `AWS grant ended` (with `outcome`: `expired`, `revoked`,
  `released`, `session-ended` or `replaced`). The controller's 30-second expiry sweep logs
  `debug` start and finish lines, and its finish at `info` with `ended`, `retry`,
  `failed_signins` and `duration_ms` when it ended or deferred a grant or failed a stale
  sign-in; a row it could not end logs `warn` `Could not end an expired AWS grant`. A grant
  write the runtime answered `unavailable` logs `warn` `AWS grant write could not land;
  retrying` (with `attempt`) before each of its up to three retries. A grant
  that could not be recorded logs `warn` `AWS grant could not be recorded; took it back`
  (with `outcome`), or `error` `AWS grant could not be recorded or taken back; the sweep
  retries the take-back` when the take-back was not confirmed, and the session backend logs
  `info` `Emptied the session's AWS credentials slot` (with `grant`) for each take-back that
  emptied it. No line carries a device code, token or
  credential. Query `{app=~"claws|claws-web"} | json | component="aws-access"`.
- Session ends (`src/session-pod/terminal-server.ts`, service `claws-session`, component
  `session-pod`, #clw_01M8997QNSAC11ZBBCZ4HCNVVC) log one `info` `Session process exited
  with code N — exiting` with `reason` (`pane_dead`, `tmux_gone` or `pane_gone`), `check`
  (`poll` or `pty-exit`), `pane_dead`, `agent_alive`, `has_session` and `failed_queries`.
  Every agent-pane query that gives no clear answer logs `warn` `tmux agent pane query gave
  no clear answer` with `check`, `why` (`query_failed` or `pane_mismatch`),
  `tmux_code`, `tmux_signal`, `tmux_stderr` and `tmux_stdout`; a streak of them while the
  agent process lives logs one `warn` `tmux pane query keeps failing; agent process alive,
  not ending` and one `info` `tmux pane query recovered; agent pane running` once it clears.
  These recovered failures are log lines only, not a metric. Query
  `{app="claws-session"} | json | level="warn" |= "tmux"`. The web tier logs the pod's exit
  report as `info` `Session <id> process exited with code N` with `reason` (`unreported` from
  a pod on an older image) and counts it in `claws_session_process_exits_total`
  ([metrics.md](metrics.md)).
- A raised review tier (`maybeRaiseSuggestedReviewTier` in `src/agents/pr-reviewer.ts`, run in
  the agent pod) logs one `info` `[pr-reviewer] Raised suggested review tier to opus` with
  `action: "review-tier-raised"`, `repo`, `pr`, `from`, `to`, `kind` (`lines`, `code` or
  `unmeasured`), `lines` and `reason`; a kept suggestion logs `debug` with
  `action: "review-tier-kept"`. It is a log line, not a metric: the agent pod's counters are not
  scraped. Query `{app="claws"} | json | action="review-tier-raised"` to see how often it fires
  ([model-selection.md](model-selection.md#raising-a-suggested-review)).
- Alert filing (`routeDirectAlerts` in `src/alert-bridge.ts`, component `alert-bridge`; one open
  issue per alert group, keyed `alert-group-<service>.<alert>`, no inbox) logs one `info` per
  alert group it acts on:
  `filed alert issue` or `bumped alert issue`, each with `bridge_repo`, `cluster`, `mode`,
  `group`, `key` and `issue` (a filing citing a closed issue that held the key adds
  `previous_issue`), and `adopted alert issue` when an open per-service issue gains a group's
  key. In `shadow` mode the same routing runs as a dry run and logs `would file alert issue` /
  `would bump alert issue` / `would adopt alert issue`, writing nothing; `write` and `direct`
  apply it. A poll that reaches `poll.maxNewIssuesPerPoll` logs one `warn`
  `alert filing capped` with `cap` and the `deferred` group names (`info` `would cap alert
  filing` in a dry run). Counters
  `claws_alert_issues_filed_total{cluster}`, `claws_alert_filing_capped_total{cluster}` and
  `claws_dedupe_key_moves_total{reason="adopt"}` count filings, capped polls and adoptions
  ([metrics.md](metrics.md)). Query `{app="claws"} | json | component="alert-bridge"`.
- Merging a duplicate native issue into the issue it duplicates (`src/issue-merge.ts`, component
  `issue-merge`) logs one `info` `dedupe keys moved` with `from`, `to`, `keys` and `repo` (the
  survivor's primary repo, as the correlation key) and adds the number of keys moved to the
  counter `claws_dedupe_key_moves_total{reason="merge"}` ([metrics.md](metrics.md)); a merge
  the planner's duplicate path cannot make logs `warn` `duplicate not merged into canonical
  issue` (component `issue-handback`) with the refusal as `why`. Query
  `{app="claws"} | json | component="issue-merge"`.
- At boot the controller probes the read token's code, pull request, Actions run and release
  reads on the self repo (`probeForgejoReadTokenAccess`, component `forgejo-read-token`): a
  401/403/404 on any of them logs one `error` `forgejo read token cannot read a required route`
  with `repo` and `denied` (route and status pairs), which the `Claws Error Logs` rule files;
  all four answering logs `info`, and a 5xx or network failure logs `warn`. Query
  `{app="claws"} | json | component="forgejo-read-token"`.
- A refused or failed board card action (`/board/infra-approve`, `/board/merge-approve`,
  `/board/operator-step-done`, `/board/approve-through`,
  `/board/start-session`) logs one `board action refused` line (component `board`) with `route`,
  `status`, `reason`, `by` and, when known, `repo`, `issue`, `pr_repo` and `pr_number`: `info` for
  a 4xx, `warn` for a 5xx, never `error`. Query
  `{app="claws"} | json | msg="board action refused"`.
- Service faults are filed by Claws itself as `[claws-error]` issues through
  `src/error-reporter.ts`.
- Error-log alerting: fleet Grafana's `Claws Error Logs` rule (uid `claws-error-logs`, group
  `Claws` in fleet-infra `apps/monitoring/kube-prometheus-stack.yaml`) counts the `error` and
  `fatal` log lines of `{app=~"claws|claws-web"} | json | __error__="" | level=~"error|fatal" | alert_issue=""`
  over 10 minutes, per `component`, and fires at once (`for: 0m`, `noDataState: OK`). It keys
  on `component` alone, not `msg`, because most existing `msg` values interpolate ids (see
  Known gaps). Its `claws_alertname` label, `Claws error logged: <component>`, makes the
  fleet-infra `grafana-github-alerts` bridge file each distinct component's errors as one
  fleet-infra issue with dedupe key `alert-claws-error-logged-<component>`, updated in place on
  repeats. The `log.error` lines `reportError` writes carry an `alert_issue` field naming their
  `[claws-error] <fingerprint>` issue, so the rule excludes them and one fault is never filed
  twice. Every `error` line Claws logs for a fault it files itself is that tagged line; no job
  logs a separate untagged `error` line for such a fault.

### What every change adds

What a change must instrument when it adds:

- A new HTTP route: nothing extra for timing — the `*` middleware in `src/server.ts` records
  it in `claws_http_request_duration_seconds` under its matched route label. Its handler logs
  through `src/log.ts` with a `component`.
- A new DB query: a log line with a `duration_ms` field when it can be slow (a scan, a
  migration, a backfill, a prune); `timedDb` in `src/db/core.ts` logs one (SQL lives in `src/db/<domain>.ts` behind the `src/db.ts` façade).
- A new background job: start and finish log lines under its job `component`, and
  `trackTaskTokens` for any agent call it makes.
- A new external call: forge calls go through `src/github.ts` / `src/forgejo.ts`, whose
  `claws_forge_request_duration_seconds` histogram times them; any other external call logs a
  timed line with `duration_ms` and the target.
- A new action Claws takes on another system (a forge write, a Slack message, a pod launch or
  delete, a merge): one `info` line through `src/log.ts` naming the action and its outcome.
- A new metric, route family or background job worth watching: a panel on the `claws-overview`
  board (fleet-infra `apps/monitoring/dashboards/claws-overview-dashboard.yaml`), added through
  a fleet-infra companion PR on the same issue.
- A new `error`/`fatal` log path: it logs through `src/log.ts` (or `src/log-core.ts`) under
  `app` `claws` or `claws-web`, with a `component`, so the `Claws Error Logs` rule catches it;
  a path that files its own issue through `reportError`, `ensureAlertIssue` or
  `upsertAlertIssue` passes the issue title as `alert_issue` on any `error` line for that fault
  and never logs a separate untagged `error` line for it. A `log.error` right before
  `reportError` is redundant, because `reportError` logs the tagged line (enforced by
  `src/alert-issue-log-tag.test.ts`).

### Known gaps

Places the existing code falls short of the contract or of the rules above:

- Accepted: about 1,500 existing `log.*` calls interpolate ids and values into `msg`, contrary
  to the `msg` rule above. `src/log.ts` and `src/log-core.ts` now take a fields argument; the
  existing calls move to it when they are next touched, and new code must use it.
- Deferred (#clw_01M85BNP5KBERSHHRYARX19HBA): the AWS grant expiry sweep
  (`sweepExpiredAwsGrants`, component `aws-access`) has no `claws-overview` panel for its
  `ended`, `retry` and `failed_signins` counts or its revoke warnings.

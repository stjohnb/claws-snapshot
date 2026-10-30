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
| `claws_grafana_auth_ok` | gauge | `cluster` (`prod`/`fleet`) | 1 when the cluster's Grafana accepted Claws' last observability JWT on `GET /api/user` as a non-admin user, else 0. Probed every 15 minutes; fleet Grafana's `claws-grafana-auth-failing` rule fires after 1 h at 0. See [observability-access.md](observability-access.md). |
| `claws_nodejs_*`, `claws_process_*` | various | — | prom-client default runtime metrics, e.g. `claws_nodejs_eventloop_lag_seconds`, heap and GC. |

### The `route` label

`route` is Hono's matched route pattern, not the raw path. For example
`/issues/clw_…` is recorded as `/issues/:id`, which keeps the number of label
values bounded. The timing middleware is registered on `*` before every route. It
takes the last matched route that is not a wildcard (`*`, `/*`), and a request
that matched nothing is labelled `unmatched`. Long polls such as `/api/events`
have their own route label, so they do not skew page percentiles.

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

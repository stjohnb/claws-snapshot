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

In Claws, service code logs through `src/log.ts` (modules upstream of it use
`src/log-core.ts`, the session pod `src/session-pod/log.ts`); see
[observability-contract.md](observability-contract.md#in-the-claws-codebase).

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

These are working budgets; correct the numbers here when they change.

### Dashboards and alerts

- The Claws dashboard-latency board is defined in fleet-infra
  `apps/monitoring/dashboards/claws-dashboard-latency.yaml` and served by fleet Grafana.
- Fleet Grafana's `claws-grafana-auth-failing` rule files an inbox issue when Claws' Grafana
  JWT has been rejected for an hour (see [observability-access.md](observability-access.md)).
- Service faults are filed by Claws itself as `[claws-error]` issues through
  `src/error-reporter.ts`.

### What every change adds

What a change must instrument when it adds:

- A new HTTP route: nothing extra for timing — the `*` middleware in `src/server.ts` records
  it in `claws_http_request_duration_seconds` under its matched route label. Its handler logs
  through `src/log.ts` with a `component`.
- A new DB query: a log line with `duration_ms` when it can be slow (a scan, a migration, a
  backfill).
- A new background job: start and finish log lines under its job `component`, and
  `trackTaskTokens` for any agent call it makes.
- A new external call: forge calls go through `src/github.ts` / `src/forgejo.ts`, whose
  `claws_forge_request_duration_seconds` histogram times them; any other external call logs a
  timed line with `duration_ms` and the target.

### Known gaps

Places the existing code falls short of the contract or of the rules above:

- `request_id` is never emitted: `src/log-core.ts` sets no request id on dashboard log lines,
  although the logging contract names it as a correlation key.
- `src/log.ts` has no structured-field API: `info/warn/error` take only a `msg` string, so ids
  and values are interpolated into `msg` throughout the code, contrary to the `msg` rule above.
  Only `component` and `repo` are emitted as fields.
- Existing DB scans, migrations and backfills in `src/db.ts` emit no `duration_ms` field; the
  OpenCode all-time spend query and one migration interpolate their time into `msg`.
- No resource-saturation signal (CPU throttling, memory, DB pool wait) is declared beside the
  latency budgets, although `collectDefaultMetrics` in `src/metrics.ts` already exports process
  CPU and memory series.

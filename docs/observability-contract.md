# Observability contract

This is the canonical observability contract for every St-John-Software repo. It grew out of
the structured logging contract (every service writes one JSON object per line to stdout, and
Promtail ships it to Loki) and adds metrics, traces, latency budgets, where dashboards and
alerts live, and what each new route, DB query, background job or external call must add.
The machine source of truth is [`src/observability-contract.ts`](../src/observability-contract.ts)
— the starter template below, the `observability-contract-scanner` issue body and the fallback
prompt block given to planning, implementing and reviewing agents are all generated from it, and a test keeps this page
byte-identical to it.

Every managed repo declares its policy, whatever its kind: services, infra repos that own
dashboards and alerts, static sites with analytics and uptime checks, and libraries or CLIs
that state what they emit or that they emit nothing. Claws' own policy is
[`observability.md`](observability.md).

## Where a repo declares its policy

The scanner checks these locations in order and passes the repo when any one is complete:

1. `docs/observability.md` — the whole file is the policy, no heading needed.
2. An `## Observability` section in `AGENTS.md` (a heading naming observability, telemetry,
   monitoring or logging, up to the next heading of the same or a higher level).
3. A legacy logging section in `AGENTS.md` or `docs/logging.md`. On its own it satisfies the
   logging rules only, so the repo is asked for the observability sections and not re-asked
   about logging.

Headings inside fenced code are ignored, and when several headings match, the section missing
the fewest rules wins.

## Rules

| Area | Rule | Passes when the policy mentions |
|---|---|---|
| Logging | `json-stdout` | JSON or stdout |
| Logging | `string-level` | a lowercase / `level` field |
| Logging | `error-object` | `err` or stack |
| Logging | `no-secrets` | secrets, tokens or credentials |
| Observability | `scope` | scope, deploy, or what it runs as/on/in |
| Observability | `metrics` | metrics, Prometheus or analytics |
| Observability | `traces` | traces, tracing, spans, OpenTelemetry or OTel |
| Observability | `latency-budgets` | latency, SLO, budget or uptime |
| Observability | `dashboards-alerts` | dashboards, alerts or Grafana |
| Observability | `per-change-instrumentation` | instrument, new route, new query, background job or external call |
| Observability | `known-gaps` | a Known gaps section (see [Known gaps](#known-gaps)) |
| Observability | `no-placeholders` | no `TODO(observability)` marker remains |

The rules are deliberately loose: they check that each topic is addressed, not how, and not
whether what the policy says is true. A policy that contains the logging block below verbatim
(under any heading) passes the four logging keyword rules, but the block is a claim about
current behaviour: keep it only when the repo's code emits one JSON object per line on stdout
today, replacing the placeholder line above it in the template with the logger module that
does; otherwise describe what the code logs and record the shortfall under Known gaps.

## Policies describe the code as it is

Every statement a policy makes about current logging, metrics, traces, latency budgets and
dashboards/alerts must be true of the repo's code and config today. A rule for future changes
is allowed, worded as a rule for new changes, never as current behaviour. The scanner does not
check this; the agents that plan, implement and review a policy do (see
[What agents receive](#what-agents-receive)).

## Known gaps

Every policy carries a section under a heading containing "Known gaps" (the template's
`### Known gaps`) listing each place existing code falls short of the contract or of the
policy's own per-change rules:

- One top-level list item per gap (`-`, `*`, `+` or `1.`); continuation and nested lines
  belong to the item above and are not separate gaps.
- A gap the repo accepts starts its item with `Accepted: <reason>` (bold, as
  `**Accepted:**`, is fine). No follow-up issue is filed for it.
- A repo with no gaps writes `None.`; a section with no list items has no gaps.

For the unaccepted gaps the daily scan files one native issue per repo, titled
`chore: close this repo's known observability gaps` with dedupe key
`observability-known-gaps`, listing them. While it is open the scan rewrites its body in place
when the list changes; after it is closed as not planned it is never re-filed, and after it
is closed as completed it is re-filed only if unaccepted gaps remain.

## Opting out by declaration

A repo with nothing to observe writes this sentence on a line of its own inside its policy:

```markdown
This repo emits no runtime telemetry.
```

It satisfies every rule except `known-gaps` and `no-placeholders`: the sentence waives the
subsections, not the Known gaps section, and must itself be true of the code. Quoting the sentence mid-line does not opt
out. A repo that should not be scanned at all disables `observability-contract-scanner` on the
`/jobs` matrix or in its `claws.json` `disabledJobs`; the former name
`logging-conventions-scanner` still disables it.

## Placeholders

Every fill-in line of the starter template starts with `TODO(observability):`. The
`no-placeholders` rule fails while any remains, so pasting the template unchanged does not
pass. Replace each with the repo's answer, or with `none` and the reason.

## Starter template

## Observability

This is the repo's observability policy under the St-John-Software observability contract.
Replace each placeholder line below with this repo's answer, or with `none` and the reason.
Every statement below about current logging, metrics, traces, latency budgets and dashboards
must be true of this repo's code and config today; word a rule for future changes as a rule for
new changes, and list each place existing code falls short under Known gaps.
A repo with nothing to observe (a library, CLI or config-only repo) may instead replace the
subsections with one line reading exactly `This repo emits no runtime telemetry.`

### Scope

TODO(observability): what runs and where (service, CronJob, static site, library, CLI), and which subsections below apply.

### Logging

TODO(observability): keep the block below only if this repo's code emits one JSON object per line on stdout today, and name the logger module; otherwise describe what it logs and list the shortfall under Known gaps.

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

### Metrics

TODO(observability): the metrics endpoint or analytics tool, where its series are listed, and what scrapes it.

### Traces

TODO(observability): the tracing SDK and backend and the spans it records, or `none`.

### Latency budgets

TODO(observability): the p95 latency budget or SLO for each user-facing path, or the uptime target for a static site.

### Dashboards and alerts

TODO(observability): the repo and path where the dashboards and alert rules live, and which alerts notify someone.

### What every change adds

What a change must instrument when it adds:

- TODO(observability): a new HTTP route: its access log line, request metric and latency budget.
- TODO(observability): a new DB query: a log line or span with `duration_ms`.
- TODO(observability): a new background job: start and finish log lines and a duration or failure metric.
- TODO(observability): a new external call: a timed log line or span naming the target.

### Known gaps

TODO(observability): list every place existing code falls short of the contract or of this policy's own per-change rules, one list item each, or write `None.`; start an accepted gap's item with `Accepted: <reason>`.

## What agents receive

Claws gives its planner (issue-refiner), implementer (issue-worker), review addresser and PR
reviewer one `<observability>` prompt block, built by `observabilityContext(wtPath)` in
`src/agents/agent-context.ts` from the same locations the scanner checks, in the same order:

- **The repo declares a policy** (`docs/observability.md` exists, or `AGENTS.md` or
  `docs/logging.md` has an observability, telemetry, monitoring or logging section): a short
  pointer at that file. It tells the agent to consult the policy before adding an HTTP route,
  DB query, background job, external call or log line; a plan names the logs, metrics, spans,
  latency budget and alert the policy requires; an implementation adds them in the same PR;
  a review flags any such change that skips them.
- **No policy**: the fallback `OBSERVABILITY_CONTEXT` block — the logging rules, plus: treat
  a new route, query, job or external call as needing a structured log line with
  `duration_ms` and ids, a metric where the repo has a metrics endpoint, and a stated latency
  budget in the PR, and say in the PR that the repo has no observability policy.

Both blocks also carry a verification paragraph: when the task declares, rewrites or reviews
the repo's observability policy, the agent verifies every statement about current logging,
metrics, traces, latency budgets, dashboards and alerts against the repo's code and config
(the logger module, metrics endpoint, tracing SDK, and the dashboard and alert files in
fleet-infra or production-infra read over the Forgejo API), corrects any claim the code does
not support before merge, words future rules as rules for new changes, and keeps a Known gaps
section listing every shortfall or `None.`, with `Accepted: <reason>` for accepted gaps; a
review flags an unsupported claim.

The PR reviewer's checklist also carries an Observability item: a new HTTP route, DB query,
background job or external call must add the logs, metrics or spans the repo's policy
requires, and the reviewer flags one that skips them. When the PR adds or edits the policy
itself, the reviewer checks each current-behaviour claim against the code, flags one the code
does not support, and flags a missing Known gaps section.

## Querying

Nothing in the contract becomes a Loki label, so select streams by the Kubernetes `app` label
and parse fields at query time:

```logql
{app="x"} | json | level="error"
{app="x"} | json | component="reminder-monitor"
{app="x"} | json | err_type=~".*Timeout.*"
{app="x"} | logfmt | level="warn"
```

`| json` flattens nested objects with `_`, so `err.type` is queried as `err_type` and
`http.status` as `http_status`. Use `| logfmt` for shell scripts and CronJobs that log in
logfmt.

## In the Claws codebase

- Service code logs through `src/log.ts`. Modules upstream of it (`config.ts`,
  `slack.ts`, `db.ts`, `db-driver-pg.ts`, `db-import.ts`) use `src/log-core.ts`,
  and the session pod uses `src/session-pod/log.ts`.
- A leading `[component]` tag in a message becomes the `component` field.
- `CLAWS_LOG_FORMAT=json|text` overrides the TTY-based choice.
- No direct `console.*` in `src/` outside tests, `src/tools/` and browser code;
  `src/no-console.test.ts` enforces this.

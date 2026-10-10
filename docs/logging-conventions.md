# Logging conventions

This is the canonical structured logging contract for every St-John-Software service: every
service writes one JSON object per line to stdout, and Promtail ships it to Loki. The machine
source of truth is [`src/logging-contract.ts`](../src/logging-contract.ts) — the block below,
the `logging-conventions-scanner` issue body and the prompt block given to implementing agents
are all generated from it, and a test keeps this page byte-identical to it. Service repos adopt
the contract by pasting the block below into their own `AGENTS.md`.

## Logging

This service follows the St-John-Software structured logging contract: one JSON object per
line on stdout, never to files. Loki parses it at query time with `| json`.

| Field | Rule |
|---|---|
| `time` | ISO 8601 UTC with milliseconds |
| `level` | lowercase **string**, one of `trace debug info warn error fatal`. Never numeric (pino's default numeric levels are not detected by Loki) |
| `msg` | short, constant message. Ids and values go in fields, never interpolated into the message |
| `service` | service name, matching the Kubernetes `app` label |
| `component` | subsystem or job name (e.g. `ha-backup-monitor`) |
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

## Querying

Nothing in the contract becomes a Loki label, so select streams by the Kubernetes `app` label
and parse fields at query time:

```logql
{app="x"} | json | level="error"
{app="x"} | json | component="ha-backup-monitor"
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

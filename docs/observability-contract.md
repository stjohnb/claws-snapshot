# Observability contract

This is the canonical observability contract for every St-John-Software repo. It grew out of
the structured logging contract (every service writes one JSON object per line to stdout, and
Promtail ships it to Loki) and adds metrics, traces, latency budgets, where dashboards and
alerts live (each service's own Grafana dashboard), and what each new route, DB query, background job or external call must add.
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
| Observability | `dashboards-alerts` | a dashboard file path under `dashboards/` (`.json`/`.yaml`), a `uid`, or an explicit "no … dashboard" statement |
| Observability | `per-change-instrumentation` | instrument, new route, new query, background job or external call |
| Observability | `info-shipping` | "log route", or `info` on the same line as action, actuation, forward or ship, or `info` followed on that line by reach, ship or forward (see [Levels and shipping](#levels-and-shipping)) |
| Observability | `error-alerting` | a line naming error/fatal logging (error-level, error log lines, logged errors, logs at `error`) together with an alert, rule or ruler, so the rule or its absence under Known gaps passes (see [Error-log alerting](#error-log-alerting)) |
| Observability | `known-gaps` | a Known gaps section (see [Known gaps](#known-gaps)) |
| Observability | `no-placeholders` | no `TODO(observability)` marker remains |

The rules are deliberately loose: they check that each topic is addressed, not how, and not
whether what the policy says is true. A policy that contains the logging block below verbatim
(under any heading) passes the four logging keyword rules, but the block is a claim about
current behaviour: keep it only when the repo's code emits one JSON object per line on stdout
today, replacing the placeholder line above it in the template with the logger module that
does; otherwise describe what the code logs and record the shortfall under Known gaps.

## Adding or tightening a rule

Every rule in `src/observability-contract.ts` that existed at rollout is undated. A rule added
later, or an existing rule tightened, sets `added: "YYYY-MM-DD"` to the day of the change; a
test checks each date is real. A repo whose existing policy fails only dated rules then gets
no declare issue: the [`observability-contract-scanner`](jobs/observability-contract-scanner.md#contract-rule-changes) lists those rules
in its known-gaps follow-up instead. Missing dated rules alone open a new follow-up only once
every one is seven days old (`RULE_SETTLE_DAYS`), so several rule changes in one week land as
one round of issues; an open follow-up lists them at once. A rule added without `added` files
a declare issue in every repo that fails it, so always set it. The scanner logs one
`contract rule backfill` line per dated rule with the repos failing it.

## Levels and shipping

The log format says how a line looks; these rules say which lines exist and where they go.
They are rules for new changes, so a repo adopting them lists a gap only where existing code
already falls short:

- Every action a component takes logs one `info` line naming the action and its outcome or
  new state: an actuation or relay change, a write to another system, a job's start and
  finish, a config or state change. Routine polling and sensor readings stay at `debug`.
  Failures log at `warn` or `error`.
- Every `info`-and-above line a component emits reaches Loki and can be queried per
  component. A log filter or forwarding level that drops `info` must not be set.
- A component whose lines cannot reach Loki lists that under Known gaps.

The template carries these as a block after the logging block, so a policy that pasted the
logging block verbatim keeps it verbatim. The `info-shipping` rule checks that a policy
addresses the topic; the logging block alone does not pass it, because its level-name line
mentions `info` without an action or a shipping word.

Why: on 2026-11-04 the ESPHome heating controller in home-assistant-config logged relay
switching at DEBUG while Home Assistant forwarded device logs at INFO, so no 230 V relay
action reached Loki and nothing in the contract flagged it (`#clw_01M6KC16S5KZC1E0CRE6WJ7CJ0`).

## Error-log alerting

Every repo that emits runtime logs has its `error` and `fatal` log lines watched by a Grafana
alert rule, and each alert becomes a Claws issue deduplicated per distinct error: a recurring
error keeps one open issue, updated in place, and distinct errors get separate issues. The
policy's `### Dashboards and alerts` section names the rule (file path and title), how its
alerts reach the Claws tracker, and the labels that identify one distinct error. As rules for
new changes:

- A new `error`/`fatal` log path stays inside the rule's stream selector, logs JSON, and uses a
  short constant `msg` with ids in fields, so repeats of the same error share one issue.
- A change does not remove, narrow or silence the rule.

The recipe:

- A Grafana-managed rule in fleet-infra `apps/monitoring/kube-prometheus-stack.yaml` for a
  service on the home/fleet cluster, or a Loki ruler rule under production-infra
  `infrastructure/prod/observability/loki-rules/` for one on the Hetzner prod cluster.
- Query `sum by (app, component, msg) (count_over_time({app="x"} | json | __error__="" | level=~"error|fatal" [10m])) > 0`
  (a Grafana-managed rule reduces with `last` and thresholds at `> 0`), `for: 0m`,
  `noDataState: OK`.
- A `claws_alertname` label templated from `app`, `component` and the constant `msg`, e.g.
  `'x error logged: {{ $labels.component }}: {{ $labels.msg }}'`. Keep `msg` short: the
  dedupe key is cut at 90 characters, so two errors sharing a long prefix share an issue.
  - Grafana file provisioning (fleet-infra's `grafana.alerting."rules.yaml"` values) expands
    `$` variables in label values but not in annotations. A plain `$labels` in a label expands
    to an empty string, so `{{ $labels.component }}` is stored as the literal `{{ .component }}`
    and every error shares that name. In a file-provisioned rule, write `$$labels.<x>` in label
    values, which Grafana reads back as `$labels.<x>`. In fleet-infra's Helm values the braces
    are wrapped too, so the form is `{{ "{{" }} $$labels.component {{ "}}" }}`. Annotations
    (`summary`, `description`) keep `$labels.<x>`, because `$$` there renders literally.
  - Rules loaded by the Loki ruler (production-infra `loki-rules/`) or created through the
    Grafana API need no escape and keep `$labels.<x>`.
  - fleet-infra's `scripts/check-grafana-alert-annotations.sh` fails CI on a label value that
    contains a `$` not part of `$$`. Another repo with Grafana file-provisioned rules should add
    a similar check.

Claws' Alertmanager poller uses `claws_alertname` in place of `alertname` when it is set, so
each distinct value is its own alert group and its own issue (see [Alert issues](#alert-issues)).
Repeats, restarts and repeated Grafana notifications update that issue rather than opening a
new one. Error issues land in the bridge repo's tracker (fleet-infra or production-infra),
titled with the service and error.

Claws' own rule is the reference: `Claws Error Logs` (uid `claws-error-logs`, group `Claws` in
fleet-infra `apps/monitoring/kube-prometheus-stack.yaml`), described in Claws' policy,
[`observability.md`](observability.md).

A repo whose error-log alerting is not in place yet lists that under Known gaps (e.g. "No alert
watches logged errors yet"), which passes the `error-alerting` rule and is tracked by the
Known gaps follow-up issue. A repo that declares it emits no runtime telemetry is not asked for
it. Monitoring `warn` and lower lines is not part of the contract.

Why: error lines already reached Loki, but nothing required anyone to watch them, so a repo
could log errors indefinitely unnoticed; the alert pipeline already deduplicates alerts onto one
issue, so the standard now requires feeding it (`#clw_01M6M0VZ59BH6DYS5YGNNKFGF1`). Every templated
`claws_alertname` in fleet-infra rendered as `{{ .src }}` or `{{ .component }}` until its
label was escaped with `$$labels` (`#clw_01M6RB2N4MV720W4WYYR272MMH`).

## Log routes other than stdout

The logging block assumes a container writing JSON to stdout, collected by Promtail or
Alloy. A policy whose code is firmware, a device or a host daemon describes its log route
instead of keeping that block, replacing the template's log route placeholder with:

- the device or daemon that emits the lines;
- the forwarding hop: journald, a Home Assistant log subscription (ESPHome devices through
  "Subscribe to logs" into `home-assistant.service`'s journal), or syslog;
- the level that hop forwards, which must include `info`;
- the Loki stream labels the lines land under, and a per-device query;
- how the JSON-stdout rules (`json-stdout`, `string-level`, `error-object`) are met, or which
  are exempt because the framework fixes the log format, with the reason. The scanner checks
  keywords only, so a statement that names the format (JSON or not, stdout or not), the
  `level` and how errors and their stack appear passes those rules: an exempt rule is a
  stated reason, not a missing topic.

No new Loki labels: a route's stream labels are the ones its collector already sets.

## Policies describe the code as it is

Every statement a policy makes about current logging, metrics, traces, latency budgets and
dashboards/alerts must be true of the repo's code and config today. A rule for future changes
is allowed, worded as a rule for new changes, never as current behaviour. The agents that plan,
implement and review a policy check this (see [What agents receive](#what-agents-receive)),
and the daily `observability-contract-scanner` runs a deterministic drift check
(`src/observability-drift.ts`) on every repo with a policy. Each rule fires only on a claim the
policy makes:

| Rule | Fires when |
|---|---|
| `no-telemetry-service` | The policy says `This repo emits no runtime telemetry.` but the repo ships a runnable service (the scanner's service detection). |
| `console-bypass` | The policy claims JSON/stdout logging or names a logger module, and a non-test source file under `src`, `lib`, `app` or `server` calls `console.*`. Files the policy names by path (the logger itself) and the dirs `tools`, `scripts`, `resources`, `public`, `static`, `client`, `browser` and `vendor` are exempt. One finding per file, at its first call. |
| `named-path-missing` | A backticked path the policy names does not exist. File paths (a `/` or an extension), directories (a trailing `/`) and `*`/`**` globs (at least one file must match) are checked; tokens with `<` or `{` are skipped. A managed repo's name (optionally `owner/`) and a colon pins the lookup to that repo's clone, e.g. `` `claws:src/jobs/alertmanager-poller.ts` `` (`fleet-infra:` and `production-infra:` are the infra cases); a prefix naming no managed repo is skipped, and a token whose last segment is a version (`curl/8.6.0`) is not a path; an unqualified, unprefixed path is looked up in this repo, then fleet-infra, then production-infra, and the finding names every repo checked. The rule is `unavailable` as a whole when a path is missing locally and a needed infra clone is absent. |
| `alert-reference-missing` | A rule uid the policy names (`` uid `x` ``) or a `claws_service` / `claws_alertname` value it names appears in no file under fleet-infra `apps/monitoring/` or production-infra `infrastructure/prod/observability/` (plain text search). |
| `info-dropped` | The policy says `info` reaches Loki (the `info-shipping` rule holds), but a non-test, non-doc config file sets `LOG_LEVEL` or a log `level` key to `warn`, `warning`, `error` or `fatal`. |

A finding is dropped when a Known gaps item, accepted or not, names in backticks its key (the
file path, named path, uid or label value) and its rule id or finding id, or when a
[scanner exception](#scanner-exceptions) covers it. A Known gaps item should cover one finding: an item naming several files and rule ids matches any key with any rule id in the same item, so keep one finding per item. Suppression is scoped to that one finding:
a new finding of a different rule on the same file is still reported. Findings are recomputed
on every scan and stored nowhere: they disappear once the code is fixed, the shortfall is
listed, or an exception covers it. The infra rules read the local fleet-infra and production-infra clones; when a
clone they need is absent the rule concludes nothing, the scanner reports
`observability-contract-scanner:drift-unavailable` and leaves the repo's follow-up issue
untouched that run. The remaining findings go into the repo's known-gaps follow-up issue (see
[Known gaps](#known-gaps)).

The per-change rules ("What every change adds") need judgement a text check cannot give, so
the weekly [`contract-audit`](jobs/contract-audit.md) job runs a read-only agent over each
repo's changes since its last audit (when 7 days have passed and HEAD has moved) and stores
the concrete mismatches it reports, each with a file and line. The daily scan adds the stored
findings to the same follow-up issue under **Audit findings**, dropping any a Known gaps item
or scanner exception covers by finding id (an audit finding is never matched by rule and file
alone, since that would silence every audit claim on the file). A completed close of the follow-up issue retires the findings
stored before it. Claws' own `docs/observability.md` passes the repo-local rules,
enforced by `src/observability-drift.test.ts`.

## Dashboards

Every deployed service has its own Grafana dashboard, and its policy's `### Dashboards and
alerts` section names it by file path and uid:

- A service on the home/fleet cluster: a ConfigMap under fleet-infra
  `apps/monitoring/dashboards/` (see fleet-infra `docs/monitoring.md`, "Custom Dashboards"),
  loaded by fleet Grafana's sidecar.
- A service on the Hetzner prod cluster: JSON under production-infra
  `infrastructure/prod/observability/dashboards/`, validated by `scripts/validate-dashboards.sh`.
- At minimum: request rate, errors and latency against the stated latency budget, plus any key
  job or queue metrics the service exports. A static site shows uptime and analytics instead.
- A library, CLI or repo that emits no metrics writes `no dashboard: <reason>`; that is
  complete.
- A service with no dashboard yet writes "No dashboard yet" and lists it under Known gaps, so
  the gap is tracked.
- A change that adds a new metric, route family or background job worth watching adds or
  updates its panel in the same PR set, as a companion PR in fleet-infra or production-infra on
  the same multi-repo issue. The PR reviewer flags one that skips it.

## Alert issues

Claws' Alertmanager poller (`alertBridge.poll` in fleet-infra's and production-infra's
`claws.json`) reads each cluster's active alerts and files one Claws issue per alert group,
found by its exact key. There is no inbox and no triage step:

- **Service identity.** Every alert rule for a service sets a `claws_service` label to that
  service's stable name, the same value on every rule for it; a rule whose series span
  several services derives it per series (e.g. `label_replace` from Traefik's
  `exported_service`). Without `claws_service` the poller takes the first non-empty of
  `exported_service`, `app`, `deployment`, `statefulset`, `daemonset`, `cronjob`, `container`,
  `job`, `node`, `host`, skipping a value that names a scrape target (`kube-state-metrics`,
  `kubelet`, `cadvisor`, `apiserver`, `node-exporter`, `prometheus-node-exporter`); it never
  uses `namespace` (one holds unrelated workloads) or `pod` (unique per restart). The PR
  reviewer flags a new alert rule for a service that sets no `claws_service`.
- **Group name.** A firing's group is `<service> / <alert>`, where `<alert>` is
  `claws_alertname` when set, else `alertname`; an alert with no service identity (cluster-wide
  or Flux alerts) keeps its bare alert name. A ` / ` inside a service or alert name becomes
  ` - `, so the separator only ever marks the service boundary.
- **One open issue per alert group.** A group has at most one open issue in its bridge repo,
  keyed exactly `alert-group-<service-slug>.<alert-slug>` (a bare alert keeps
  `alert-<alert-slug>`); every firing of that group collects on it, and Claws lists each alert
  seen on the issue's `**Alerts:**` line. Two groups never share an issue unless they are
  merged.
- **Merge moves keys.** An issue may hold several keys. When an agent or the operator
  establishes that two alert issues share one root cause and fix and closes one as a
  duplicate of the other, its keys, `**Alerts:**` names and occurrence counts move to the
  survivor, so later firings of either group count there.
- **Owning repo.** An alert issue also names the managed repo(s) that own its fix, from the
  bridge repo's `alertBridge.serviceRepos` map in `claws.json` (`claws_service` value to
  `owner/name`); the bridge repo stays the issue's primary repo. A new app service alerting
  through a bridge adds its entry there; an unmapped service's issue names only the bridge
  repo.
- **Per-error identity.** `claws_alertname` is the identity of one distinct error: its own
  group and its own issue, with its own first/last/count.
- **No reopen.** Claws never reopens a closed alert issue. A new firing after the close files a
  new issue whose body cites the previous one; a re-notification of an instance that began
  before the close, within 14 days of it, only counts on the closed issue.
- **Flood cap.** At most `alertBridge.poll.maxNewIssuesPerPoll` (default 3) new issues are filed
  per bridge repo per poll; later groups wait for the next poll.

## Known gaps

Every policy carries a section under a heading containing "Known gaps" (the template's
`### Known gaps`) listing each place existing code falls short of the contract or of the
policy's own per-change rules:

- One top-level list item per gap (`-`, `*`, `+` or `1.`); continuation and nested lines
  belong to the item above and are not separate gaps.
- A gap the repo accepts starts its item with `Accepted: <reason>` (bold, as
  `**Accepted:**`, is fine). No follow-up issue is filed for it.
  An accepted item that waives a contract-level requirement (a metrics endpoint, a dashboard,
  …) may say so with a `(waives: <requirement>)` marker naming the requirement as `/contracts`
  labels it, e.g. `(waives: Dashboard, Alert rule)`; without one the requirement is inferred
  from the item's wording.
- A gap the repo cannot fix yet starts its item with exactly one of two forms, bold or code
  marks allowed as for `Accepted:`:
  - `Deferred until YYYY-MM-DD: <reason>` holds through that UTC date inclusive and is
    unaccepted from the next day. A date more than 366 days ahead, or one that is not a real
    calendar day (`2026-02-30`), is unaccepted from the start, so a far-future date cannot
    stand in for acceptance.
  - `Deferred (#clw_<id>): <reason>` holds while that Claws-native issue exists and is open;
    once it closes for any reason, or if no such issue exists, the gap is unaccepted.

  While a deferral holds no follow-up issue lists the gap; once it lapses the follow-up lists
  it under **Unaccepted gaps** with a trailing `(deferral lapsed)`. Any other `Deferred…`
  spelling (`Deferred:` with no date, both forms combined) is an unaccepted gap. A deferred
  item still silences the drift and audit findings it names, like any other Known gaps item.
- A repo with no gaps writes `None.`; a section with no list items has no gaps.
- Known gaps lists real shortfalls only. A scanner finding that is wrong or does not apply is
  a [scanner exception](#scanner-exceptions), never an `Accepted:` item.
- An item silences a drift finding only when it names, in backticks, the finding's key and
  either its rule id or its finding id (for an audit finding, its finding id).

For the unaccepted gaps (neither accepted nor deferred) and any drift the [drift check](#policies-describe-the-code-as-it-is)
finds, the daily scan files one native issue per repo with dedupe key
`observability-known-gaps`, titled `observability: …` after the items it lists (at most 100
characters, rewritten when they change), listing them under **Unaccepted gaps** and **Drift: the policy
says X, the code shows Y** (each drift item with its `file:line`, ending with its rule and
finding id, e.g. `` (rule `console-bypass`, finding `1a2b3c4d`) ``). Its asks: close each gap, or
start its item `Accepted: <reason>` to live with it or with one of the `Deferred` forms when it
cannot be fixed yet; and for each drift or audit finding either fix the code or correct the policy; list a real
shortfall the repo keeps under Known gaps, naming the finding's key and rule in backticks; or,
for a finding that is wrong or does not apply, add a scanner exception, never an `Accepted:`
gap. It also lists, under **Contract rules added since this policy was declared**, any
dated rules the policy misses (see [Adding or tightening a rule](#adding-or-tightening-a-rule)).
While it is open the scan rewrites its body in place when the lists change; after it is closed
as completed it is re-filed only while gaps, drift or missing rules remain. A close as not
planned dismisses only the gaps and findings that issue listed: a gap or finding that appears
later files a new issue, and a reworded gap or a finding whose message changes counts as new.
Settled missing rules still re-file. To opt a repo out for good, list
`observability-contract-scanner` in its `claws.json` `disabledJobs`.

### Reviewing accepted gaps

Accepted gaps come back to a person once a quarter in one fleet-wide review covering every
repo's observability policy (#clw_01M753CRBTEEXJM0QMWEZQBWN4): the dashboard's `/contracts/review`
page lists every accepted gap, those waiving a contract-level requirement first, with the gaps
new or reworded since they were last reconfirmed shown and the unchanged ones collapsed. One
digest issue, `chore: review the fleet's accepted observability gaps` (dedupe key
`accepted-gaps-review`, in the claws repo, held in Blocked), links to it about every 91 days.
Closing the digest as completed, or pressing **Reconfirm all** on the page, reconfirms every
accepted gap; to turn one into work, use its Defer or Stop accepting link, which files an issue
asking to defer it or drop its `Accepted:` prefix, after which the follow-up above lists it. See
[the job doc](jobs/accepted-gaps-review.md). Accepted security gaps are reviewed on
sentinel's CVE exception page instead (#clw_01M75KGK2BVJVVMX73Z03ZBV5B), which the review page
and digest link to.

Accepting a gap is also visible when it happens: a plan that intends to accept or defer one
lists it in a Decisions item starting `Accepts gap:` or `Defers gap:`, naming any
contract-level requirement it waives; the implementer appends a
`## Known gaps accepted or deferred in this PR` section to the PR description naming each added
or reworded `Accepted:` or `Deferred` item, its file and what it waives; and the Claws review
opens with an `### Accepted or deferred gaps` section on whether each reason is specific,
whether it waives a contract-level requirement and whether a deferral would fit better.

## Scanner exceptions

A repo records that one specific drift or audit finding is wrong or does not apply in
`.claws/contract-exceptions.yaml` (`CONTRACT_EXCEPTIONS_PATH`, read by
`src/contract-exceptions.ts`), not in its policy: backticked paths in a policy feed
`named-path-missing` and the `console-bypass` exemption, so a policy subsection would change
the drift results. The file is shared with the [security contract](security-contract.md#scanner-exceptions).

```yaml
exceptions:
  - contract: observability
    rule: named-path-missing
    keys:
      - dist-server/main.js
    reason: Gitignored build output, not a tracked file.
  - contract: observability
    rule: observability-audit
    finding: "1a2b3c4d"
    keys:
      - src/server.ts
    reason: The route is internal and covered by the gateway metrics.
```

Each entry has:

- `contract`: `observability` or `security`. Each scanner reads only its own entries.
- `rule`: a drift rule id from the table above, or `observability-audit` for an audit finding.
- `keys`: the exact finding keys it covers (file path, named path, uid or label value); never
  a directory or glob.
- `reason`: why the finding is wrong or does not apply, at least three words.
- `finding` (optional): one finding's id, always a quoted string (`finding: "1a2b3c4d"`); unquoted, YAML can read it as a number and lose digits. Required when `rule` is `observability-audit`.

An entry covers a finding when the rule is equal, the finding's key is in `keys`, and, when the
entry has `finding`, the finding id is equal. An audit finding is matched only by finding id.
Every finding carries an id, shown in the follow-up issue: the first 8 hex characters of the
sha256 of `rule`, `key` and `message` joined by newlines, computed on each scan and stored
nowhere. It changes when the message does (for `console-bypass`, the call count), so an entry
pinned with `finding` re-raises the finding when the code changes again. The weekly audit agent
is given the repo's exceptions with their reasons, so it does not report them again in other
words.

An unparseable file, or an entry with an unknown `contract`, a `rule` the contract does not
have, empty `keys`, a `reason` under three words, a malformed `finding` or an audit rule
without `finding`, suppresses nothing and is itself reported as a drift finding with rule
`contract-exceptions` and key `.claws/contract-exceptions.yaml`, which nothing suppresses. An
entry that matches no finding is not reported.

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

TODO(observability): the log route. For a container, the Loki stream selector that holds its lines. For firmware, a device or a host daemon, describe the route instead of the block above: the device or daemon, the forwarding hop (journald, a Home Assistant log subscription, syslog), the level that hop forwards (which must include `info`), the Loki stream labels and a per-device query; and say how the JSON-stdout rules (`json-stdout`, `string-level`, `error-object`) are met, or which are exempt because the framework fixes the log format, with the reason.

Levels and shipping, as rules for new changes:

- Every action a component takes logs one `info` line naming the action and its outcome or new
  state: an actuation or relay change, a write to another system, a job's start and finish, a
  config or state change. Routine polling and sensor readings stay at `debug`. Failures log at
  `warn` or `error`.
- Every `info`-and-above line a component emits reaches Loki and can be queried per component.
  Never set a log filter or forwarding level that drops `info`.
- A component whose lines cannot reach Loki lists that under Known gaps.

### Metrics

TODO(observability): the metrics endpoint or analytics tool, where its series are listed, and what scrapes it.

### Traces

TODO(observability): the tracing SDK and backend and the spans it records, or `none`.

### Latency budgets

TODO(observability): the p95 latency budget or SLO for each user-facing path, or the uptime target for a static site.

### Dashboards and alerts

TODO(observability): this service's own Grafana dashboard: its file path and uid. A service on the home/fleet cluster has a ConfigMap under fleet-infra `apps/monitoring/dashboards/<name>.yaml`; a service on the Hetzner prod cluster has JSON under production-infra `infrastructure/prod/observability/dashboards/<name>.json` (checked by `scripts/validate-dashboards.sh`). At minimum it charts request rate, errors and latency against the stated latency budget, plus any key job or queue metrics the service exports (uptime and analytics for a static site). A library, CLI or repo that emits no metrics writes `no dashboard: <reason>`; a service without a dashboard yet writes `No dashboard yet` and lists it under Known gaps. Also say which alerts notify someone, and the `claws_service` value its alert rules set.

TODO(observability): the Grafana rule that watches this repo's error and fatal log lines (file path and rule title), how its alerts reach the Claws tracker, and the labels that identify one distinct error; or list its absence under Known gaps.

### What every change adds

What a change must instrument when it adds:

- TODO(observability): a new HTTP route: its access log line, request metric and latency budget.
- TODO(observability): a new DB query: a log line or span with `duration_ms`.
- TODO(observability): a new background job: start and finish log lines and a duration or failure metric.
- TODO(observability): a new external call: a timed log line or span naming the target.
- TODO(observability): a new action, actuation or state-changing command: its `info` log line naming the action and outcome, in the same PR.
- TODO(observability): a new `error`/`fatal` log path: it stays inside the error-log rule's stream selector, with a constant `msg`.
- TODO(observability): a new metric, route family or background job worth watching: add or update its dashboard panel in the same PR set, as a companion PR in fleet-infra or production-infra on the same multi-repo issue.

### Known gaps

TODO(observability): list every place existing code falls short of the contract or of this policy's own per-change rules, one list item each, or write `None.`; start an accepted gap's item with `Accepted: <reason>`, and a gap the repo cannot fix yet with `Deferred until YYYY-MM-DD: <reason>` (a date at most a year ahead) or `Deferred (#clw_<id>): <reason>` (until that Claws issue closes). Known gaps lists real shortfalls only; a wrong or not-applicable scanner finding goes in the repo's .claws/contract-exceptions.yaml file, never an `Accepted:` item.

## What agents receive

Claws gives its planner (issue-refiner), implementer (issue-worker), review addresser and PR
reviewer one `<observability>` prompt block, built by `observabilityContext(wtPath)` in
`src/agents/agent-context.ts` from the same locations the scanner checks, in the same order:

- **The repo declares a policy** (`docs/observability.md` exists, or `AGENTS.md` or
  `docs/logging.md` has an observability, telemetry, monitoring or logging section): a short
  pointer at that file. It tells the agent to consult the policy before adding an HTTP route,
  DB query, background job, external call or log line; a plan names the logs, metrics, spans,
  latency budget, alert and dashboard panel the policy requires; an implementation adds them in the same PR;
  a review flags any such change that skips them.
- **No policy**: the fallback `OBSERVABILITY_CONTEXT` block — the logging rules, plus: treat
  a new route, query, job or external call as needing a structured log line with
  `duration_ms` and ids, a metric where the repo has a metrics endpoint, and a stated latency
  budget in the PR, and say in the PR that the repo has no observability policy. A new metric, route family or
  background job worth watching also adds or updates its Grafana dashboard panel through a
  companion fleet-infra or production-infra PR.

Both blocks also carry a verification paragraph: when the task declares, rewrites or reviews
the repo's observability policy, the agent verifies every statement about current logging,
metrics, traces, latency budgets, dashboards and alerts against the repo's code and config
(the logger module, metrics endpoint, tracing SDK, and the dashboard and alert files in
fleet-infra or production-infra read over the Forgejo API), corrects any claim the code does
not support before merge, words future rules as rules for new changes, and keeps a Known gaps
section listing every shortfall or `None.`, with `Accepted: <reason>` for accepted gaps and
`Deferred until YYYY-MM-DD: <reason>` (at most a year ahead) or `Deferred (#clw_<id>): <reason>`
for gaps the repo cannot fix yet; Known
gaps lists real shortfalls only, and a wrong or not-applicable scanner finding goes in
`.claws/contract-exceptions.yaml`, never an `Accepted:` item; a review flags an unsupported
claim. A plan that intends to accept or defer a gap lists each in a Decisions item starting
`Accepts gap:` or `Defers gap:`, naming any contract-level requirement it waives, and a PR that
adds or changes an accepted or deferred gap names it in its description.

Both blocks also carry a levels paragraph (`LOG_LEVEL_SHIPPING_CONTEXT`): a state-changing
action logs one `info` line naming the action and its outcome, polling and sensor readings
stay at `debug`, failures are `warn` or `error`; never set a log filter or forwarding level
that drops `info`; where the policy describes a non-stdout log route, log through it in its
stated format. The pointer block says log output goes through the shared logger or the log
route the policy describes.

Both blocks also carry an error-log alerting paragraph (`ERROR_ALERTING_CONTEXT`): errors a
repo logs at `error` or `fatal` are watched by a Grafana rule whose alerts reach the Claws
tracker through the alert bridge, deduplicated per distinct error by a `claws_alertname`
label; a new error log path stays inside that rule's selector with a constant `msg`; a change
must not remove or weaken the rule; and a review flags either.

Both blocks also carry an alert-service paragraph (`ALERT_SERVICE_CONTEXT`): every alert rule
for a service sets `claws_service` to the service's stable name, the same value on every rule
for it, and a review flags a new service alert rule without it.

The PR reviewer's checklist also carries an Observability item: a new HTTP route, DB query,
background job or external call must add the logs, metrics or spans the repo's policy
requires, and the reviewer flags one that skips them, including a new metric, route family or
background job worth watching that skips its dashboard panel. When the PR adds or edits the policy
itself, the reviewer checks each current-behaviour claim against the code, flags one the code
does not support, and flags a missing Known gaps section. It also flags a state-changing
action logged only at `debug`, and a log filter or forwarding level that drops `info`. It
flags an `error`/`fatal` log path the repo's error-log alert rule would not catch (outside its
stream selector, non-JSON, or an interpolated `msg` that defeats dedupe), and a change that
removes, narrows or silences that rule. It flags a new alert rule for a service that sets no
`claws_service` label.

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
- Ids and values go in the trailing fields argument — `log.info(msg, { repo_count })`,
  `log.warn(msg, fields, err)`, `log.error(msg, err, fields)` — and become top-level
  snake_case keys; a field may not overwrite a fixed key such as `msg` or `run_id`.
- Dashboard request lines carry `request_id`, taken from a well-formed incoming
  `X-Request-Id` header or generated, and echoed back in that response header.
- `CLAWS_LOG_FORMAT=json|text` overrides the TTY-based choice.
- No direct `console.*` in `src/` outside tests, `src/tools/` and browser code;
  `src/no-console.test.ts` enforces this.

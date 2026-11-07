# observability-contract-scanner

**Deep dive.** Read this when you're changing the scanner that asks every repo
to declare an observability policy. For the contract itself, read
[../observability-contract.md](../observability-contract.md).

**Source**: `src/jobs/observability-contract-scanner.ts`, rules in `src/observability-contract.ts`,
drift rules in `src/observability-drift.ts`, follow-up issue in `src/contract-drift.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Every managed repo declares how it is observed: logs, metrics, traces, latency
budgets, where dashboards and alerts live, and what each new route, DB query,
background job or external call must add — or that it emits nothing — and
where its existing code falls short (Known gaps). This scanner files one issue
in every repo whose policy is missing or incomplete, and one follow-up issue in
every repo whose policy lists unaccepted known gaps or disagrees with its code.

## Scope

All monitored repos, Claws included. Service detection (root `Dockerfile`,
server dependency, `bin`/`start` entrypoint, minus static sites behind
nginx/caddy/httpd, static Astro, Next.js static exports and CRA SPAs) only
picks the issue's wording — never whether a repo is scanned. A non-service repo
is told to declare analytics/uptime or the no-telemetry sentence; a service
repo also gets logger, `console.*` and framework-default-logging evidence.

## Detection

The scanner reads these docs in order and stops at the first compliant one:

1. `docs/observability.md` — the whole file is the policy.
2. `AGENTS.md` — the best section under a heading naming observability,
   telemetry, monitoring or logging.
3. `docs/logging.md` — same, for repos that documented logging there.

A doc containing the starter template verbatim is checked for leftover
placeholders only.

## Rules

Four logging rules (`json-stdout`, `string-level`, `error-object`,
`no-secrets`, unchanged from the logging contract) and ten observability
rules (`scope`, `metrics`, `traces`, `latency-budgets`, `dashboards-alerts`,
`per-change-instrumentation`, `info-shipping`, `error-alerting`, `known-gaps`,
`no-placeholders`). `error-alerting` passes on a line naming error/fatal logging
together with an alert, rule or ruler, so a Grafana rule on logged errors or its
absence listed under Known gaps passes; the no-telemetry sentence waives it. `info-shipping` passes when the policy says actions log at
`info` and `info` lines reach Loki (`info` on a line with an action or shipping
word), or names its log route; the logging block's level-name line alone does
not pass it. The table is in
[the contract doc](../observability-contract.md#rules). A repo whose logging
section already satisfies the logging rules in any accepted doc is told
"logging already satisfied" and asked only for the observability sections.

## Opt-out by declaration

The line `This repo emits no runtime telemetry.`, on its own line inside the
policy, satisfies every rule except `known-gaps` and `no-placeholders`, so a
no-telemetry repo still lists its Known gaps (or `None.`).

## Placeholder rule

Each fill-in line of the starter template starts with `TODO(observability):`.
`no-placeholders` fails while any remains, so an unfilled paste does not pass.

## Issue

- Title: `chore: declare this repo's observability policy` (frozen — it is the
  dedupe key). No labels; a human reviews each plan.
- The body groups missing rules under **Logging rules** and **Observability
  sections**, embeds the starter template in a four-backtick fence, and links
  the contract doc. When a policy already exists, a **Check the policy against
  the code** paragraph says this is not a rewrite: verify every current-behaviour
  statement against the code, correct unsupported ones, word future rules as
  rules for new changes, and add the Known gaps section. An ask checkbox names
  the Known gaps section and the follow-up issue below.
- Only open issues are deduplicated. A closed issue is not consulted, so a repo
  that later regresses gets a fresh one.

## Known-gaps follow-up

After the declare pass, the scanner reads each repo's policy (the whole
`docs/observability.md`, else the policy section of `AGENTS.md` or
`docs/logging.md`), parses its Known gaps section with `parseKnownGaps` (one gap
per top-level list item, accepted when it starts `Accepted:`) and runs the
[drift check](#drift-check). It also reads the latest stored
[`contract-audit`](contract-audit.md) findings for the repo
(`db.getContractAudit("observability", repo)`), minus any whose file a Known
gaps item names in backticks. With one or more unaccepted gaps, drift findings
or audit findings it files one native issue in that repo through
`refreshFollowUpIssue` (`src/contract-drift.ts`):

- Title `chore: close this repo's known observability gaps`, dedupe key
  `observability-known-gaps`, source `automation`, unapproved.
- The body lists **Unaccepted gaps**, **Drift: the policy says X, the code
  shows Y** and **Audit findings** (with the audit date and short SHA), each
  drift and audit item with its `file:line`, and asks to close each gap and,
  for each finding, to fix the code or correct the policy and list the
  shortfall under Known gaps.
- While it is open, the scan rewrites its body in place when any list
  changes, and logs the update.
- When the newest keyed issue closed as not planned, it is never re-filed.
  After a close as completed it is re-filed only while gaps or findings remain.
- No gaps (or only accepted ones), no drift and no audit findings files nothing.

## Drift check

`detectObservabilityDrift` (`src/observability-drift.ts`) checks each policy's
claims against the repo's code and config and the fleet-infra and
production-infra monitoring files, with five rules that fire only on a claim the
policy makes: `no-telemetry-service`, `console-bypass`, `named-path-missing`,
`alert-reference-missing` and `info-dropped`. The rule table is in
[the contract doc](../observability-contract.md#policies-describe-the-code-as-it-is).

- A finding whose key (file path, named path, uid or label value) appears in any
  Known gaps item, accepted or not, is suppressed.
- Infra files come from the local clones of `St-John-Software/fleet-infra` and
  `St-John-Software/production-infra` (`claude.repoDir`). When a rule needs a
  clone that is absent it returns `unavailable`: the scanner calls
  `reportError("observability-contract-scanner:drift-unavailable", …)` and does
  not touch that repo's follow-up issue this run.
- Findings are recomputed every scan and never stored.
- One `info` line per repo, `drift check finished`, carries `repo`, `gaps`,
  `drift`, `suppressed` and `unavailable` counts.

The backfill for repos that already had a policy when the `known-gaps` rule
shipped is this scanner: the rule makes each such policy incomplete, so the
next daily scan files the declare issue asking for the code check. A declare issue that
is already open is not rewritten, so it keeps its old body until it is closed and re-filed.

The `info-shipping` rule is backfilled the same way: it makes every policy
silent on actions at `info` and shipping incomplete, so the next daily scan
re-scans every repo and files the declare issue for each one that lacks the
topic; a repo with an open declare issue is not re-filed.

## Legacy-title migration

The scanner used to be `logging-conventions-scanner`, filing
`chore: adopt the structured logging contract`. When an open issue with that
title exists and no open issue has the new title, the scanner retitles it and
rewrites its body in place (`ScannerSpec.legacyIssueTitles` in
`scanner-runner.ts`) instead of filing a second issue.

## Opting out

Disable `observability-contract-scanner` for the repo on the `/jobs` matrix (or
in its `claws.json` `disabledJobs`) rather than closing the issue. The former
name `logging-conventions-scanner` is an alias: either name disables it.

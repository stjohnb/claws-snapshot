# observability-contract-scanner

**Deep dive.** Read this when you're changing the scanner that asks every repo
to declare an observability policy. For the contract itself, read
[../observability-contract.md](../observability-contract.md).

**Source**: `src/jobs/observability-contract-scanner.ts`, rules in `src/observability-contract.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Every managed repo declares how it is observed: logs, metrics, traces, latency
budgets, where dashboards and alerts live, and what each new route, DB query,
background job or external call must add — or that it emits nothing — and
where its existing code falls short (Known gaps). This scanner files one issue
in every repo whose policy is missing or incomplete, and one follow-up issue in
every repo whose policy lists unaccepted known gaps.

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
`no-secrets`, unchanged from the logging contract) and eight observability
rules (`scope`, `metrics`, `traces`, `latency-budgets`, `dashboards-alerts`,
`per-change-instrumentation`, `known-gaps`, `no-placeholders`). The table is in
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
`docs/logging.md`) and parses its Known gaps section with `parseKnownGaps`:
one gap per top-level list item, accepted when it starts `Accepted:`. With one
or more unaccepted gaps it files one native issue in that repo:

- Title `chore: close this repo's known observability gaps`, dedupe key
  `observability-known-gaps`, source `automation`, unapproved.
- While it is open, the scan rewrites its body in place when the gap list
  changes, and logs the update.
- When the newest keyed issue closed as not planned, it is never re-filed.
  After a close as completed it is re-filed only if unaccepted gaps remain.
- No gaps, `None.` or only accepted gaps files nothing.

The backfill for repos that already had a policy when the `known-gaps` rule
shipped is this scanner: the rule makes each such policy incomplete, so the
next daily scan files the declare issue asking for the code check. A declare issue that
is already open is not rewritten, so it keeps its old body until it is closed and re-filed.

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

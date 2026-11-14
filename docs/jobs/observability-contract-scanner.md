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
- Not filed when an existing policy fails only dated rules; see
  [Contract rule changes](#contract-rule-changes).

## Contract rule changes

A rule added or tightened after rollout carries an `added` date
(`YYYY-MM-DD`) in `src/observability-contract.ts`. When a repo already has a
policy and every rule it fails (counted across docs, so a policy split between `docs/logging.md` and `AGENTS.md` is judged as one) is dated, the declare pass files nothing:
the dated rules go into the repo's [known-gaps follow-up](#known-gaps-follow-up)
under **Contract rules added since this policy was declared** (label, rule id
and date), with an ask to add each to the policy as an edit, checked against the
code. A repo with no policy, or one that fails any undated rule, still gets the
declare issue, which lists every missing rule, dated or not. A policy that
drops a dated rule it once passed is reported the same way, since no per-repo
history is stored.

So a burst of rule changes lands as one round of issues, new rules have a
settle window, `RULE_SETTLE_DAYS` (7) in `src/contract-drift.ts`:

- An open follow-up lists every missing dated rule straight away, as does a new
  follow-up filed for gaps, drift or audit findings.
- With none open, missing dated rules alone open a follow-up only once every one
  is at least 7 UTC days old; until then `refreshFollowUpIssue` returns
  `held-new-rules` and logs `follow-up issue held` with
  `reason: "new_rules_settling"` and the rule ids.
- A close as not planned dismisses only the gaps and drift and audit findings
  that issue listed (`dismissedItems`: the gap texts under
  `**Unaccepted gaps:**` and every ``finding `<id>` ``), unioned across every
  keyed issue closed as not planned; a gap or finding that appears later files
  a new follow-up listing only it. Settled missing rules still file one,
  because a declared policy is a hard requirement. When dismissal leaves
  nothing to file, `refreshFollowUpIssue` returns `skipped-not-planned` and
  logs `follow-up issue skipped` with `reason: "closed_not_planned"` and a
  `dismissed` count.

After the per-repo pass the scanner logs one `info` line per dated rule any
repo fails, `contract rule backfill`, with `component` (`observability-contract-scanner`),
`contract` (`observability`), `rule`, `added`, `settled`, `failing` (count) and
`repos` (full names): the rule change's blast radius, visible before its
issues appear.

## Known-gaps follow-up

Before any follow-up work, the scanner saves the repo's `/contracts` snapshot
(`contract_status`, see `src/contract-status.ts`) for every repo with a clone,
including one with no policy: the policy status (complete, incomplete with its
missing rules, or missing), every Known gaps item with its accepted, deferred or unaccepted state, the
drift findings and unavailable rules, and the audit findings it keeps. It saves
before the drift-unavailable skip, logs `contract status saved` at `info` with
the counts, and a failed save logs `warn` without stopping the follow-up.

After the declare pass, the scanner reads each repo's policy (the whole
`docs/observability.md`, else the policy section of `AGENTS.md` or
`docs/logging.md`), parses its Known gaps section with `parseKnownGaps` (one gap
per top-level list item, accepted when it starts `Accepted:`) and runs the
[drift check](#drift-check). `resolveGapStates` (`src/contract-drift.ts`) then gives each gap a state:
accepted; deferred, for an exact `Deferred until YYYY-MM-DD:` item through
that UTC date (at most 366 days ahead) or a `Deferred (#clw_<id>):` item while
that Claws issue is open; or unaccepted. A deferral whose date has passed or
whose issue has closed is unaccepted and listed with `(deferral lapsed)`; an
unknown issue, an invalid or too-distant date and any other `Deferred…`
spelling are unaccepted. A failed issue lookup counts as deferred for that run
and logs `deferral issue lookup failed` at `warn`. Only unaccepted gaps go in
the follow-up; every gap, whatever its state, still suppresses the drift and
audit findings it names. It also reads the latest stored
[`contract-audit`](contract-audit.md) findings for the repo
(`db.getContractAudit("observability", repo)`), minus any a scanner exception
or Known gaps item covers by finding id (`suppressFindings` with `audit: true`)
or whose file changed since
the audited SHA (one
`git diff --name-only` per repo; all findings are kept if it fails). If the
follow-up issue closed as completed after the audit and `origin/<default>`
differs from the audited SHA, the findings that issue listed by `file:line` are
dropped too; unlisted findings, or a repo whose default branch has not moved,
are still raised. The
`drift check finished` line carries the `audit` (kept) and `audit_stale`
(dropped) counts. A repo whose policy fails only dated rules also passes them
as new rules (see [Contract rule changes](#contract-rule-changes)); when no
policy section is readable the incomplete doc's path is used and only the rules
are listed. With one or more unaccepted gaps, drift findings,
audit findings or new rules it files one native issue in that repo through
`refreshFollowUpIssue` (`src/contract-drift.ts`):

- Titled `observability: <item>` after the one item it lists, or
  `observability: <N> gaps — <item>, <item>, …` (`findings` when none is a Known
  gap, `items` when mixed), at most 100 characters (`followUpTitle`), built from
  each gap's first clause, each finding's file basename and what the code shows,
  and each missing rule's id. The scan rewrites the title with the body when the
  listed items change; a title-only change (a new title format) goes through
  `retitleKeepingPlanCurrent` (`src/issue-retitle.ts`), which re-stamps a current
  plan's hash so the rename never re-plans the issue. Dedupe key
  `observability-known-gaps`, source `automation`, unapproved.
- The body lists **Unaccepted gaps**, **Drift: the policy says X, the code
  shows Y**, **Audit findings** (with the audit date and short SHA) and
  **Contract rules added since this policy was declared**, each
  drift and audit item with its `file:line` and ending with its rule and
  finding id (`` (rule `<rule>`, finding `<id>`) ``). It asks to close each
  gap, or start its item `Accepted: <reason>` to live with it or
  `Deferred until YYYY-MM-DD: <reason>` / `Deferred (#clw_…): <reason>` when it
  cannot be fixed yet, and, for each finding, to fix the code or correct the policy; to list a
  real shortfall under Known gaps naming the finding's key and rule in
  backticks; or, for a finding that is wrong or does not apply, to add an entry
  to `.claws/contract-exceptions.yaml`, never an `Accepted:` gap.
- While it is open, the scan rewrites its body in place when any list
  changes, and logs the update.
- A close as not planned dismisses only the gaps and findings that issue
  listed; anything that appears later, a reworded gap or a finding whose
  message changes (its finding id is a hash of rule, key and message, so a
  message embedding a count changes with the count) included, files a new
  issue. Listing `observability-contract-scanner` in the repo's `claws.json`
  `disabledJobs` is the permanent opt-out.
  After a close as completed it is re-filed only while unaccepted gaps, drift, or audit findings
  from an audit newer than that close remain, since the close resolved the earlier ones, or
  new rules remain.
- New rules alone wait out the settle window before opening an issue.
- No gaps (or only accepted ones), no drift, no audit findings and no new rules files nothing.

## Accepted-gap review

The scanner no longer files a review of the repo's accepted gaps. Its daily
snapshot feeds the fleet-wide review instead: the
[`accepted-gaps-review`](accepted-gaps-review.md) job keeps one digest issue
for every repo's observability gaps, linking to the dashboard's
`/contracts/review` page (#clw_01M753CRBTEEXJM0QMWEZQBWN4). The quarterly
per-repo review issues it used to file (dedupe key `observability-accepted-gaps-review`)
are retired; that job closes any still open. Listing `observability-contract-scanner` in `disabledJobs` leaves
the repo out of the review.

## Drift check

`detectObservabilityDrift` (`src/observability-drift.ts`) checks each policy's
claims against the repo's code and config and the fleet-infra and
production-infra monitoring files, with five rules that fire only on a claim the
policy makes: `no-telemetry-service`, `console-bypass`, `named-path-missing`,
`alert-reference-missing` and `info-dropped`. The rule table is in
[the contract doc](../observability-contract.md#policies-describe-the-code-as-it-is).
The scanner passes a `repoClones` map of every scanned repo, so a `<repo>:path`
claim resolves against that repo's clone.

- `suppressFindings` (`src/contract-drift.ts`) drops a finding a
  [scanner exception](../observability-contract.md#scanner-exceptions) in
  `.claws/contract-exceptions.yaml` covers (rule, key and, when pinned, finding
  id), or a Known gaps item, accepted or not, names in backticks with its key
  (file path, named path, uid or label value) and its rule id or finding id.
  A different rule's finding on the same file is still reported, and a gap
  naming only the key drops nothing.
- Each problem in the exceptions file (unparseable, unknown contract or rule,
  empty `keys`, a `reason` under three words, an audit entry without
  `finding`) is reported as a `contract-exceptions` finding that nothing
  suppresses; the bad entry suppresses nothing.
- Infra files come from the local clones of `St-John-Software/fleet-infra` and
  `St-John-Software/production-infra` (`claude.repoDir`). When a rule needs a
  clone that is absent it returns `unavailable`: the scanner calls
  `reportError("observability-contract-scanner:drift-unavailable", …)` and does
  not touch that repo's follow-up issue this run.
- Findings are recomputed every scan and never stored.
- One `info` line per repo, `drift check finished`, carries `repo`, `gaps`
  (unaccepted), `deferred`, `drift`, `unavailable`, `audit` and `audit_stale` counts, and the drift and
  audit findings dropped by a rule-scoped gap (`suppressed`) and by an
  exception (`excepted`).

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

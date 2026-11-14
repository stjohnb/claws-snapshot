# security-contract-scanner

**Deep dive.** Read this when you're changing the scanner that asks every repo
to declare a security policy, or its drift checks. For the contract itself, read
[../security-contract.md](../security-contract.md); for Claws' own policy,
[../security.md](../security.md).

Product requirements: [product/operations-and-safety.md](../product/operations-and-safety.md)

**Source**: `src/jobs/security-contract-scanner.ts`, rules in `src/security-contract.ts`,
drift checks in `src/security-drift.ts`, follow-up issue in `src/contract-drift.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Every managed repo declares its security policy: what it ships and runs, how
dependency and image vulnerabilities are found, where accepted findings live
(`.vex/`), how secrets reach the code, how the supply chain is pinned, what is
exposed and how it authenticates, and its Known gaps. This scanner files one
issue in every repo whose policy is missing or incomplete, and one follow-up
issue in every repo whose policy lists unaccepted gaps or disagrees with its
code.

## Scope

All monitored repos, Claws included. No repo is exempt by type: compliance is
judged on the policy text alone, and workflows are never parsed to decide it.
`detectRepoKind` (container service, infra, static site, CLI or library,
firmware or hardware, config-only) only picks the guidance shown in the issue.

## Declare pass

The scanner reads `SECURITY_DOC_PATHS` in order and stops at the first doc whose
policy meets every rule (`missingSecurityRules` empty):

1. `docs/security.md` — the whole file is the policy.
2. `AGENTS.md` — the best section under a heading naming security
   (`findSecuritySection`).

Each of the seven `###` subsections (Scope, Dependency and image
vulnerabilities, Accepted findings, Secrets, Supply chain, Exposure and
authentication, Known gaps) must be present, non-empty and placeholder-free,
and match its keyword rule or say it does not apply with a reason; Known gaps
needs list items or `None.`. `no-placeholders` fails while any
`TODO(security):` line remains. The table is in
[the contract doc](../security-contract.md#rules).

When a rule fails it files one issue:

- Title `chore: declare this repo's security policy` (frozen — it is the
  dedupe key). No labels; a human reviews each plan.
- The body lists the detected repo kind, the incomplete policy doc (or that
  none exists), any accepted doc that exists with no `## Security` heading, the
  missing subsections, the `SECURITY_GUIDANCE` bullets for the repo's kind, the
  starter template in a four-backtick fence, the contract link and the `/jobs`
  disable note. When a policy already exists, a **Check the policy against the
  code** paragraph says it is not a rewrite.
- Only open issues are deduplicated, so a repo that later regresses gets a
  fresh one.
- Not filed when an existing policy fails only dated rules; see
  [Contract rule changes](#contract-rule-changes).

## Contract rule changes

A rule added or tightened after rollout carries an `added` date
(`YYYY-MM-DD`) in `src/security-contract.ts`. When a repo already has a
policy and every rule it fails is dated, the declare pass files nothing:
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
repo fails, `contract rule backfill`, with `component` (`security-contract-scanner`),
`contract` (`security`), `rule`, `added`, `settled`, `failing` (count) and
`repos` (full names): the rule change's blast radius, visible before its
issues appear.

## Known-gaps follow-up

Before any follow-up work, the scanner saves the repo's `/contracts` snapshot
(`contract_status`, see `src/contract-status.ts`) for every repo with a clone,
including one with no policy: the policy status (complete, incomplete with its
missing rules, or missing), every Known gaps item with its accepted, deferred or unaccepted state and
the drift findings; `audit` holds the stored security audit findings after suppression. It
logs `contract status saved` at `info` with the counts, and a failed save logs
`warn` without stopping the follow-up.

After the declare pass the scanner reads each repo's policy (the whole
`docs/security.md`, else the security section of `AGENTS.md`), parses its Known
gaps with `parseKnownGaps` (the observability grammar: one gap per top-level
list item, accepted when it starts `Accepted:`) and runs the
[drift checks](#drift-checks). `resolveGapStates` (`src/contract-drift.ts`) then gives each gap a state:
accepted; deferred, for an exact `Deferred until YYYY-MM-DD:` item through
that UTC date (at most 366 days ahead) or a `Deferred (#clw_<id>):` item while
that Claws issue is open; or unaccepted. A deferral whose date has passed or
whose issue has closed is unaccepted and listed with `(deferral lapsed)`; an
unknown issue, an invalid or too-distant date and any other `Deferred…`
spelling are unaccepted. A failed issue lookup counts as deferred for that run
and logs `deferral issue lookup failed` at `warn`. Only unaccepted gaps go in
the follow-up; every gap, whatever its state, still suppresses the drift and
audit findings it names. A repo whose policy fails only dated rules also
passes them as new rules (see [Contract rule changes](#contract-rule-changes)).
With one or more unaccepted gaps, drift items or new rules it files one native issue through `refreshFollowUpIssue`
(`src/contract-drift.ts`):

- Titled `security: <item>` after the one item it lists, or `security: <N> gaps — <item>, <item>, …`
  (`findings` when none is a Known gap, `items` when mixed), at most 100 characters
  (`followUpTitle`), built from each gap's first clause, each finding's file
  basename and what the code shows, and each missing rule's id. The scan rewrites
  the title with the body when the listed items change; a title-only change (a new
  title format) goes through `retitleKeepingPlanCurrent` (`src/issue-retitle.ts`),
  which re-stamps a current plan's hash so the rename never re-plans the issue. Dedupe key
  `security-known-gaps`, source `automation`, unapproved.
- The body lists **Unaccepted gaps**, **Drift: the policy says X, the code
  shows Y**, **Audit findings** from the weekly
  [`contract-audit`](contract-audit.md) security audit and **Contract rules
  added since this policy was declared**, each drift or audit item with its
  `file:line` and ending with its rule and finding id, and asks to close each gap, or
  start its item `Accepted: <reason>` or `Deferred until YYYY-MM-DD: <reason>` /
  `Deferred (#clw_…): <reason>`, and for each finding to fix the code
  or correct the policy; to list a real shortfall under Known gaps naming its
  file and rule (or, for an audit finding, its finding id) in backticks; or,
  for an item that is wrong or does not apply, to add an entry to
  `.claws/contract-exceptions.yaml`, never an `Accepted:` gap.
- While it is open, the scan rewrites its body in place when either list
  changes.
- A close as not planned dismisses only the gaps and findings that issue
  listed; anything that appears later, a reworded gap or a finding whose
  message changes (its finding id is a hash of rule, key and message, so a
  message embedding a count changes with the count) included, files a new
  issue. Listing `security-contract-scanner` in the repo's `claws.json`
  `disabledJobs` is the permanent opt-out.
  After a close as completed it is re-filed only while gaps, drift, audit findings or new rules remain.
- New rules alone wait out the settle window before opening an issue.
- The audit findings are the stored `contract_audits` row for `security`
  (`storedAuditFindings`, `src/contract-drift.ts`), minus those a scanner
  exception or Known gaps item (accepted or not) covers by finding id and those
  whose file changed between the audited SHA and `origin/<default>`. A finding in another repo
  (fleet-infra or production-infra) has no `file`, so it is never dropped as
  stale; the next audit or a completed close of the issue retires it.
- No gaps (or only accepted ones), no drift, no audit findings and no new rules files nothing.
- A failure for one repo is reported as `security-contract-scanner:known-gaps`
  and does not stop the others.

## Accepted-gap review

The scanner files no review of the repo's accepted gaps, and Claws' fleet-wide
[`accepted-gaps-review`](accepted-gaps-review.md) covers the observability
contract only. Accepted security gaps are reviewed on sentinel's private CVE
exception page (<https://pages.home.bstjohn.net/sentinel/docs/cve-exceptions/>,
#clw_01M75KGK2BVJVVMX73Z03ZBV5B), which reads each repo's policy itself and
files one issue per repo whose accepted gaps no longer match it. The quarterly
per-repo review issues this scanner used to file (dedupe key
`security-accepted-gaps-review`) are retired; the `accepted-gaps-review` job
still closes any left open.

## Drift checks

`detectSecurityDrift(repoDir, policyText)` (`src/security-drift.ts`) runs four
`DriftRule`s through `runDriftRules`. Each fires only on a claim the policy
makes, reads only the repo, and is recomputed every scan, never stored:

| Rule | Fires when the policy… | Drift |
|---|---|---|
| `image-gate` | claims an image push (`policyClaimsImagePublish`) | a `.forgejo/workflows/*.y*ml` line pushing an image (`docker push`, `podman push`, `buildah push`, `--push`, `push: true`) with no `trivy`, `grype` or `scripts/ci/*scan*.sh` line earlier in the same file |
| `undeclared-image` | says the repo publishes no container image | any workflow line pushing an image; a bare registry hostname is not a push, because it may be a pull |
| `sha-pinning` | claims in its Supply chain subsection that actions are SHA-pinned (`pinned to a commit SHA`, `SHA-pinned`, …) | a `uses:` not ending in `@<40 hex>`; `./` and `docker://` values are exempt |
| `vex` | (always) | a `.vex/*.json` that is not valid JSON or fails `validateVexDocument` |

Full-line YAML comments are ignored, so a comment never counts as a push or a
scan. The file-order check can pass a scan placed in an unrelated job; the PR
reviewer's Security checklist item covers that. Every finding is keyed by its
file. `suppressFindings` drops an item a
[scanner exception](../security-contract.md#scanner-exceptions) in
`.claws/contract-exceptions.yaml` covers, or a Known gaps item, accepted or
not, names in backticks with its file and its rule id or finding id; a
different rule's item on the same file is still reported, and a gap naming only
the file drops nothing. Each problem in the
exceptions file is reported as a `contract-exceptions` item that nothing
suppresses. `src/security-drift.test.ts` asserts Claws' own policy shows no
drift.

## Observability

One `info` line per repo, `drift check finished`, carries `repo`, `gaps`
(unaccepted), `deferred`, `drift`, `audit` and `audit_stale` counts and the drift and audit items dropped
by a rule-scoped gap (`suppressed`) and by an exception (`excepted`);
`refreshFollowUpIssue` logs one `info` line when it files,
updates, skips or holds the follow-up, with a `new_rules` count. After the
per-repo pass one `contract rule backfill` line per failing dated rule gives
the fleet summary ([Contract rule changes](#contract-rule-changes)). Failures go through `reportError`. The scanner
adds no route, DB query or metric.

## Opting out

List `security-contract-scanner` in the repo's `claws.json` `disabledJobs`
(the `/jobs` matrix shows it on the `scanner-dispatcher` cell) rather than
closing the issue; an open issue
with the frozen title is otherwise re-filed on the next daily scan.

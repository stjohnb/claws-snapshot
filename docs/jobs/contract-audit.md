# contract-audit

**Deep dive.** Read this when you're changing the weekly agent audit that
checks each repo's declared policies (observability and security) against the
code, or adding a contract to it.

**Source**: `src/jobs/contract-audit.ts`, the registry in
`src/contract-drift.ts` (`CONTRACT_AUDITS`, `ContractAuditSpec`) and the
observability spec in `src/observability-audit.ts` and the security spec in
`src/security-audit.ts`
**Trigger**: Smart-scheduled, `weekendPause` (no unattended ticks from Fri
18:00 to Sun 18:00 local; a manual trigger bypasses it)
**Per-repo toggle**: yes, "Audits policies against code" on the `/jobs` matrix

The daily `observability-contract-scanner` drift check
([its doc](observability-contract-scanner.md#drift-check)) catches mechanical
drift. This job catches what only reading the changes can: a new route, DB
query, background job, external call or `error`/`fatal` log path that skips
what the policy's "What every change adds" rules require. The security audit
checks the whole security policy against the code instead (see
[Security audit](#security-audit)).

## Cadence

The job registers like other smart-scheduled jobs, so each repo is offered to
`processRepo` about once a day. For each contract in `CONTRACT_AUDITS` it then
decides for itself:

1. **Skip** (`skipped-disabled`) when the contract's scanner job
   (`spec.scannerJob`, e.g. `observability-contract-scanner`) is disabled for
   the repo.
2. **Skip** (`skipped-no-policy`) when there is no local clone, no policy, or
   the policy carries `This repo emits no runtime telemetry.` (observability) or
   still contains `TODO(security):` (security; the declare issue covers it).
3. **Skip** (`skipped-not-due`) when the last audit is under 7 days old. A
   repo never audited is due only on its own weekday,
   `1 + sha256(repo) % 5` (Monday to Friday), so the first-audit backfill is
   spread over a week instead of landing on one tick. The buckets skip the
   weekend because the job pauses then. A contract's
   `firstAuditOffsetDays` shifts that weekday (wrapping within Monday to
   Friday): security uses 2, so a repo's first security audit lands two
   weekdays after its observability one.
4. **Skip** (`skipped-unchanged`) when `origin/<default>` in the clone equals
   the stored `head_sha`. The stored audit time is not touched, so the repo is
   re-checked on the next daily tick.
5. **Defer** (`skipped-deferred`) when an earlier contract already ran an agent
   audit in this call. A repo gets at most one agent audit per daily offer; the
   contracts are ordered by `auditedAt` ascending, never-audited first, and the
   deferred one stays due (its `auditedAt` is untouched) for the next offer.
   The busy gate is fleet-wide, so spreading the audits, not more slots, keeps
   them from starving each other.
6. Otherwise **audit** (`audited`).

## Audit

- Runs in a fresh worktree (`claude.withNewWorktree`, branch
  `claws/contract-audit-<hex>`) under `db.withTaskRecording("contract-audit", …)`
  with `trackTaskTokens`, on the `sonnet` tier with the read-only `plan` agent.
- The prompt (`spec.buildPrompt`) carries the policy, its Known gaps items, an
  `<exceptions>` block with the worktree's valid
  [scanner exceptions](../observability-contract.md#scanner-exceptions) for the
  contract (rule, keys and reason, read by `spec.readExceptions`, with "never report
  anything these cover") and `git log --stat <last sha>..HEAD`. On a first audit, or when the stored SHA
  is no longer an ancestor of HEAD (a force-push), it uses the last 50 commits.
- The agent checks each new route, DB query, background job, external call,
  state-changing action and error-log path against the policy, reading
  dashboards and alert rules in fleet-infra and production-infra over the
  Forgejo API with `$CLAWS_FORGEJO_READ_TOKEN`. It reports only concrete
  mismatches with file and line, never style or anything Known gaps already
  lists or an exception covers.
- The reply must end with `{"findings":[{"file","line","claim","evidence"}]}`,
  parsed with `parseFirstValidJson` and a zod schema. Each finding becomes a
  `DriftFinding` with rule `observability-audit` and its `file` as `key`.
- `saveContractAudit` replaces the `contract_audits` row for
  `(contract, repo)` with the audited HEAD, the time and the findings.
- A parse failure or agent error is reported as
  `reportError("contract-audit:process-repo", …)` and saves nothing, so the
  previous findings stay in place.

One `info` line per repo and contract, `contract audit finished`, carries
`repo`, `contract`, `outcome` (`audited`, `skipped-unchanged`, `skipped-not-due`,
`skipped-no-policy`, `skipped-disabled`, `skipped-deferred` or `error`), `findings` and
`duration_ms`. A failed audit logs `error` as well as reporting. There is no
metric or dashboard panel; the `/jobs` task history covers a weekly job.

## Security audit

`SECURITY_AUDIT` (`src/security-audit.ts`) audits the whole security policy on
every run, not only the changes since the last audit: the prompt ignores the
git range. The agent lists each current-behaviour claim and checks it,
skipping rules for new changes: secrets (the stated source matches the code,
nothing plaintext is committed, values never quoted), exposure and
authentication (ingress, middleware and NetworkPolicy files the policy names,
read in fleet-infra or production-infra over the Forgejo API), supply-chain
pinning and Renovate coverage, lockfiles and CI installing from them, and the
scan gate and `.vex/` beyond the daily drift rules, which it is told not to
repeat. The reply's JSON adds an optional `repo` field; a finding in another
repo is stored with no `file`, keyed `<repo>:<path>`, with its location at the
start of the message, so the local staleness diff never drops it. Rule id
`security-audit`. The trigger is unchanged: 7 days passed and the default
branch moved, so a deployment-repo-only change is picked up at the next audit
after the repo itself changes.

## Where findings go

The contract's daily scanner reads the stored row, drops findings a scanner
exception or Known gaps item covers by finding id (`suppressFindings` with
`audit: true`: an audit finding is never matched by rule and file alone), and
lists the rest
under **Audit findings** (with the audit date and short SHA) in the repo's
follow-up issue (dedupe key `observability-known-gaps`, or
`security-known-gaps` for security), titled after the items it lists. The
scanner also drops a finding whose file changed (or was deleted) between the
audited SHA and `origin/<default>`, and keeps every finding when that diff
cannot run; the next audit re-checks such files. A completed close of the
follow-up issue retires the stored findings from audits at or before it until
the next audit replaces the row. When the follow-up issue closed as completed
after the audit and `origin/<default>` differs from the audited SHA,
`refreshFollowUpIssue` also drops the findings that issue listed by
`file:line`; a finding it did not list, or a repo whose default branch has not
moved since the audit, is still raised. A close of the follow-up issue as not
planned dismisses only the findings it listed, by finding id; a later finding,
or one whose message changes, is raised in a new follow-up issue.

## Adding a contract

Register a `ContractAuditSpec` in `CONTRACT_AUDITS` (`src/contract-drift.ts`)
with its `contract` name, `scannerJob`, `readPolicy`, `buildPrompt`,
`parseFindings`, `readExceptions` (its valid scanner exceptions, as
`OBSERVABILITY_AUDIT` reads through `readObservabilityExceptions`) and the
`followUp` issue identity, then have the contract's scanner call
`storedAuditFindings` (`src/contract-drift.ts`) with the spec and its rule ids,
which drops covered findings with `suppressFindings(…, { audit: true })`, and
pass the rest to `refreshFollowUpIssue`. Set `firstAuditOffsetDays` so its first
audits do not share a weekday with another contract's. See [modules.md](../modules.md).

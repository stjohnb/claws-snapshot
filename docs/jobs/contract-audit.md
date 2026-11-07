# contract-audit

**Deep dive.** Read this when you're changing the weekly agent audit that
checks each repo's declared policies (observability today) against its recent
changes, or adding a contract to it.

**Source**: `src/jobs/contract-audit.ts`, the registry in
`src/contract-drift.ts` (`CONTRACT_AUDITS`, `ContractAuditSpec`) and the
observability spec in `src/observability-audit.ts`
**Trigger**: Smart-scheduled, `weekendPause` (no unattended ticks from Fri
18:00 to Sun 18:00 local; a manual trigger bypasses it)
**Per-repo toggle**: yes, "Audits policies against code" on the `/jobs` matrix

The daily `observability-contract-scanner` drift check
([its doc](observability-contract-scanner.md#drift-check)) catches mechanical
drift. This job catches what only reading the changes can: a new route, DB
query, background job, external call or `error`/`fatal` log path that skips
what the policy's "What every change adds" rules require.

## Cadence

The job registers like other smart-scheduled jobs, so each repo is offered to
`processRepo` about once a day. For each contract in `CONTRACT_AUDITS` it then
decides for itself:

1. **Skip** (`skipped-disabled`) when the contract's scanner job
   (`spec.scannerJob`, e.g. `observability-contract-scanner`) is disabled for
   the repo.
2. **Skip** (`skipped-no-policy`) when there is no local clone, no policy, or
   the policy carries `This repo emits no runtime telemetry.`
3. **Skip** (`skipped-not-due`) when the last audit is under 7 days old. A
   repo never audited is due only on its own weekday,
   `1 + sha256(repo) % 5` (Monday to Friday), so the first-audit backfill is
   spread over a week instead of landing on one tick. The buckets skip the
   weekend because the job pauses then.
4. **Skip** (`skipped-unchanged`) when `origin/<default>` in the clone equals
   the stored `head_sha`. The stored audit time is not touched, so the repo is
   re-checked on the next daily tick.
5. Otherwise **audit** (`audited`).

## Audit

- Runs in a fresh worktree (`claude.withNewWorktree`, branch
  `claws/contract-audit-<hex>`) under `db.withTaskRecording("contract-audit", …)`
  with `trackTaskTokens`, on the `sonnet` tier with the read-only `plan` agent.
- The prompt (`spec.buildPrompt`) carries the policy, its Known gaps items and
  `git log --stat <last sha>..HEAD`. On a first audit, or when the stored SHA
  is no longer an ancestor of HEAD (a force-push), it uses the last 50 commits.
- The agent checks each new route, DB query, background job, external call,
  state-changing action and error-log path against the policy, reading
  dashboards and alert rules in fleet-infra and production-infra over the
  Forgejo API with `$CLAWS_FORGEJO_READ_TOKEN`. It reports only concrete
  mismatches with file and line, never style or anything Known gaps already
  lists.
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
`skipped-no-policy`, `skipped-disabled` or `error`), `findings` and
`duration_ms`. A failed audit logs `error` as well as reporting. There is no
metric or dashboard panel; the `/jobs` task history covers a weekly job.

## Where findings go

The contract's daily scanner reads the stored row, drops findings whose `key`
a Known gaps item names in backticks (`suppressListed`), and lists the rest
under **Audit findings** (with the audit date and short SHA) in the repo's
follow-up issue, `chore: close this repo's known observability gaps`. A
finding that cites a since-deleted file stays until the next audit replaces
the row.

## Adding a contract

Register a `ContractAuditSpec` in `CONTRACT_AUDITS` (`src/contract-drift.ts`)
with its `contract` name, `scannerJob`, `readPolicy`, `buildPrompt`,
`parseFindings` and the `followUp` issue identity, then have the contract's
scanner read `db.getContractAudit(contract, repo)` and pass the findings to
`refreshFollowUpIssue`. See [modules.md](../modules.md).

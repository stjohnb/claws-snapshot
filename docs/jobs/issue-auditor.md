# issue-auditor

**Deep dive.** Read this when you're changing Ready reconciliation or
native-issue close-out for issues. For issue planning and implementation dispatch, read
issue-dispatcher.md instead.

**Source**: `src/jobs/issue-auditor.ts`
**Trigger**: Smart-scheduled
**Schedule**: Evaluated hourly via the shared staleness-based smart-scheduling loop. A repo is due once it has not been processed within the target staleness window (24h by default). Unlike other smart-scheduled jobs, issue-auditor ignores the busy gate entirely: it is a read-only, API-only reconciliation with no LLM calls, so treating it as busy-blocked work bought nothing except a starved safety net — with agents running near-continuously, the ordinary busy gate meant it effectively only ran once a day via the SLO escape valve, leaving issues out of Awaiting plan review for up to 48h (#3338). The legacy `smartScheduling.quietHourStart` / `quietHourEnd` settings remain accepted in config for compatibility but are no longer used.

Reconciles every open issue across all repos, ensuring each is either labeled
"Ready" (waiting on a human) or in a state where Claws will process it on the
next pass. No issues should fall between the cracks.

Does not invoke Claude or create worktrees — it's a lightweight, read-only
audit with targeted label fixes.

**Classification states:**

| State | Condition | Action |
|-------|-----------|--------|
| `refined` | Has "Refined" label | None — implementer handles |
| `in-progress` | Has open Claws PR | None — the board reads the PR from `claws_prs`; the state only keeps "Ready" off |
| `needs-triage` | Is `[claws-error]` or has game-ID, without investigation report | None — triage jobs handle |
| `needs-refinement` | No plan comment exists | None — planner handles |
| `needs-refinement` | Has plan but unreacted human feedback exists | None — planner handles |
| `ready` | Has plan, all feedback addressed | Verify "Ready" label; add if missing |
| `stuck-multi-phase` | Has merged Claws PRs, multi-phase plan, more phases remaining, no "Refined" label, no open PR | Add "Ready" label (human decides when to resume) |

**Fixes applied**: Missing "Ready" labels (including for stuck multi-phase
issues that need human attention) and closing native issues whose merged PR
closes them (`done-native`). There is no `In Review` label any more: "has an
open PR" is a `claws_prs` lookup (#clw_01M39G3H99HV6ED4378ZXHER6K).

The per-issue step is exported as `auditIssue(repo, issue)`. An issue whose PR
closed unmerged goes back to Awaiting plan review on the next daily run; a PR
merged by hand closes its native issue sooner, on the PR dispatcher's next
tick (see [pr-dispatcher.md](pr-dispatcher.md)).

### PR state store comparison

After the issue loop, `auditPrStore(repo)` compares every open PR's
`claws_prs` row with its raw forge labels (`listPRs(repo, { raw: true })`, never
the façade's output, read past the 60 s list cache), using the label↔row contract in
[database-schema.md](../database-schema.md#claws_prs-table). It only reports —
it never edits a row or a label. Only the PR dispatcher seeds rows, so a repo
where `pr-dispatcher` is disabled (globally or for the repo) is not compared;
its alert issue, if any, is closed. Each disagreement is:

- a `log.warn` line and an entry in the run's fixes, in the form
  `pr-store: OWNER/NAME#N field=<label> row=<present|absent> labels=<present|absent>`
  (`field=missing-row` for an open PR with no row);
- a row in one alert issue per repo in the Claws repo, titled
  `[pr-store] claws_prs disagrees with PR labels in OWNER/NAME`, kept current
  with `upsertAlertIssue` and closed with `closeAlertIssueIfResolved` on a
  clean sweep.

The PR dispatcher reconciles every forge-side label edit within one tick and logs
it as `pr-store: forge-edit`
([pr-dispatcher.md](pr-dispatcher.md#phase-0a-pr-store-refresh)), so a human
editing labels as the docs direct reaches this alert only if the audit runs in
the few minutes before that reconcile; what otherwise reaches it is drift the
dispatcher has not reconciled — a failed hook write, or a reconcile that
itself failed.

A clean sweep logs `[issue-auditor] pr-store: OWNER/NAME clean (N PRs compared)`.
A run of clean sweeps is what the operator waits for before setting
`CLAWS_PR_STORE_FACADE=true` ([configuration.md](../configuration.md)).

**Slack notification**: None. The auditor posts nothing to Slack; a per-repo
`[issue-auditor]` log line summarises the fixes applied, and the dashboard
reflects the resulting label and state changes.

Per-repo errors are caught and reported without blocking other repos.

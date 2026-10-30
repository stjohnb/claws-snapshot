# issue-auditor

**Deep dive.** Read this when you're changing plan-review reconciliation or
native-issue close-out for issues. For issue planning and implementation dispatch, read
issue-dispatcher.md instead.

**Source**: `src/jobs/issue-auditor.ts`
**Trigger**: Smart-scheduled
**Schedule**: Evaluated hourly via the shared staleness-based smart-scheduling loop. A repo is due once it has not been processed within the target staleness window (24h by default). Unlike other smart-scheduled jobs, issue-auditor ignores the busy gate entirely: it is a read-only, API-only reconciliation with no LLM calls, so treating it as busy-blocked work bought nothing except a starved safety net — with agents running near-continuously, the ordinary busy gate meant it effectively only ran once a day via the SLO escape valve, leaving issues out of Awaiting plan review for up to 48h (#3338). The legacy `smartScheduling.quietHourStart` / `quietHourEnd` settings remain accepted in config for compatibility but are no longer used.

Reconciles every open issue across all repos, ensuring each is either in Awaiting plan review
(lifecycle `awaiting-plan-review`, waiting on a human) or in a state where Claws will process it on the
next pass. No issues should fall between the cracks.

Does not invoke Claude or create worktrees — it's a lightweight, read-only
audit with targeted lifecycle fixes.

**Classification states:**

| State | Condition | Action |
|-------|-----------|--------|
| `refined` | Approved through Plan (`approved_through` is `plan` or `merge`) | None — implementer handles |
| `in-progress` | Has open Claws PR | None — the board reads the PR from `claws_prs`; the state only keeps the issue out of Awaiting plan review |
| `needs-triage` | Is `[claws-error]` or has game-ID, without investigation report | None — triage jobs handle |
| `needs-refinement` | No plan comment exists | None — planner handles |
| `needs-refinement` | Has plan but unreacted human feedback exists | None — planner handles |
| `ready` | Has plan, all feedback addressed | Verify lifecycle `awaiting-plan-review`; set it with `gh.setIssueLifecycle` if missing |
| `stuck-multi-phase` | Has merged Claws PRs, multi-phase plan, more phases remaining, not approved through Plan, no open PR | Set lifecycle `awaiting-plan-review` (human decides when to resume by approving the Plan gate) |

**Fixes applied**: Moving an issue whose plan is posted into Awaiting plan
review (including stuck multi-phase issues that need human attention) — a
lifecycle write, never a label: the `Ready` label is retired
(#clw_01M5VW14RKAAGS6VZ5PCKQXB9F) — and closing native issues whose merged PR
closes them (`done-native`). There is no `In Review` label any more: "has an
open PR" is a `claws_prs` lookup (#clw_01M39G3H99HV6ED4378ZXHER6K).

The per-issue step is exported as `auditIssue(repo, issue)`. An issue whose PR
closed unmerged goes back to Awaiting plan review on the next daily run; a PR
merged by hand closes its native issue sooner, on the PR dispatcher's next
tick (see [pr-dispatcher.md](pr-dispatcher.md)).

### Retired PR state store comparison

Until phase 5 of the issue-flow redesign, the auditor compared every open PR's
`claws_prs` row with its forge labels and kept a
`[pr-store] claws_prs disagrees with PR labels in OWNER/NAME` alert issue per
repo. Now the row is the only PR state input and the labels are a write-only
mirror, so nothing is compared. Each run calls
`closeAlertIssueIfResolved` for that title with the reason
"row-versus-label comparison retired", which closes any leftover alert issue
once and does nothing afterwards.

**Slack notification**: None. The auditor posts nothing to Slack; a per-repo
`[issue-auditor]` log line summarises the fixes applied, and the dashboard
reflects the resulting lifecycle and state changes.

Per-repo errors are caught and reported without blocking other repos.

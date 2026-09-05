# issue-auditor

**Source**: `src/jobs/issue-auditor.ts`
**Trigger**: Smart-scheduled
**Schedule**: Evaluated hourly via the shared staleness-based smart-scheduling loop. A repo is due once it has not been processed within the target staleness window (24h by default); the busy gate defers routine runs while Claws is occupied, but the SLO escape valve still forces badly stale repos through. The legacy `smartScheduling.quietHourStart` / `quietHourEnd` settings remain accepted in config for compatibility but are no longer used.

Reconciles every open issue across all repos, ensuring each is either labeled
"Ready" (waiting on a human) or in a state where Claws will process it on the
next pass. No issues should fall between the cracks.

Does not invoke Claude or create worktrees — it's a lightweight, read-only
audit with targeted label fixes.

**Classification states:**

| State | Condition | Action |
|-------|-----------|--------|
| `refined` | Has "Refined" label | None — implementer handles |
| `in-progress` | Has open Claws PR | Verify "In Review" label; add if missing |
| `needs-triage` | Is `[claws-error]` or has game-ID, without investigation report | None — triage jobs handle |
| `needs-refinement` | No plan comment exists | None — planner handles |
| `needs-refinement` | Has plan but unreacted human feedback exists | None — planner handles |
| `ready` | Has plan, all feedback addressed | Verify "Ready" label; add if missing |
| `stuck-multi-phase` | Has merged Claws PRs, multi-phase plan, more phases remaining, no "Refined" label, no open PR | Add "Ready" label (human decides when to resume) |

**Fixes applied**: Missing "Ready" labels (including for stuck multi-phase
issues that need human attention) and missing/stale "In Review" labels
(added when an issue has an open PR, removed when it doesn't).

**Slack notification**: Sent only when fixes are applied, with a summary of
which issues were fixed.

Per-repo errors are caught and reported without blocking other repos.

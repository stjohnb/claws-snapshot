# idea-reconciler

**Source**: `src/jobs/idea-reconciler.ts`
**Trigger**: Smart-scheduled (hourly during off-hours)
**Schedule**: Runs hourly during the configured quiet window (default 19:00–07:00 local time). Each tick processes all repos that haven't been processed today. Skips the tick entirely if Claws has active or pending Claude tasks, or running jobs.

Scans focus-area files in the `ideas/` directory for accepted ideas that
reference closed GitHub issues. When an accepted idea's issue has been
closed without implementation, the idea is moved back to `ideas/potential.md`
with a note about its history.

## Processing

- Reads all focus-area `.md` files in `ideas/` (excludes potential.md,
  rejected.md, overview.md, focus-areas.md)
- Parses `### Title (#NNN)` headings to find accepted ideas with issue refs
- Checks each referenced issue's state via the GitHub API
- Moves ideas back to potential.md when the issue is closed without
  implementation (stateReason != "COMPLETED")
- Creates a single PR per repo when changes are needed

## Edge cases

- Issues closed as "completed" (stateReason: "COMPLETED") are left in place
- Issues closed without a reason (stateReason: null) are treated as
  not implemented and moved back
- If the GitHub API call fails for a specific issue, that idea is skipped
- Rate-limit aware — stops processing if rate limited

Does not invoke Claude — purely file manipulation and `gh` CLI calls.

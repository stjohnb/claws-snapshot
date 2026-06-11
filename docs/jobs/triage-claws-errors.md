# triage-claws-errors

**Source**: `src/jobs/triage-claws-errors.ts`
**Trigger**: `[claws-error]` issues in `SELF_REPO` (title-based discovery)
**Interval**: 10 minutes

Investigates internal Claws errors that were auto-reported by
`error-reporter.ts`. Only operates on the Claws repository itself
(`SELF_REPO`). Discovers issues by title pattern (`[claws-error] ...`) —
no trigger label required. Skips issues that already have a
`## Claws Error Investigation Report` comment.

## Phase 1: Fingerprint deduplication (pre-investigation)

Before investigating, deduplicates incoming issues by fingerprint:

- Groups issues by fingerprint (extracted from `[claws-error] <fingerprint>`
  title pattern)
- Checks existing open `[claws-error]` issues for matching fingerprints
  (including "Known Fingerprints" tracking comments)
- Closes duplicates with a comment linking to the canonical issue
- When multiple new issues share a fingerprint, keeps the lowest-numbered one

## Phase 2: Investigation

For each canonical (non-duplicate) issue:

- Parses error details from the issue body: fingerprint, context, timestamp,
  and stack trace
- Creates a worktree on branch `claws/investigate-error-<N>-<hex4>`
- Passes error details and other open error issues to Claude with instructions
  to read `docs/OVERVIEW.md`, find the relevant source code, run diagnostic
  commands, and produce a root cause analysis
- Claude's output includes a `RELATED_ISSUES:` line identifying issues that
  share the same root cause

## Phase 3: Post-investigation deduplication

- Posts the investigation report as a comment prefixed with
  `## Claws Error Investigation Report`
- If Claude identified related issues, closes them as duplicates of the
  canonical issue and updates a "Known Fingerprints" tracking comment
- Populates queue cache: `needs-triage` for uninvestigated issues

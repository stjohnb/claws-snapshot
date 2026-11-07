# post-merge-action-sweeper

**Source**: `src/jobs/post-merge-action-sweeper.ts`
**Trigger**: Interval-based
**Interval**: 30 minutes (configurable via `intervals.postMergeActionSweeperMs`)

Global and DB-only (no repo toggle). Lists merged PRs still carrying a
`Manual action after merge:` note (`db.listPostMergeActionPrs`) and clears each
one (`clearPrHold` with `POST_MERGE_PREFIX`) when `postMergeActionResolution`
says so:

- `issue-closed` — the row's tracker issue is closed (completed or not planned).
- `plan-step` — the issue's plan has a later PR step in a repo the note names,
  or any later operator step (`postMergeNoteDuplicatesPlan`).

A row with no `issueId` is never cleared automatically. Each run logs `info`
`sweep started` / `sweep finished` (with `duration_ms`, `cleared`, `failed`) and each clear
logs one `info` line, with ids as fields, and posts no comment; the first run backfills existing stale rows.
New notes that duplicate a plan step are never recorded
(`announcePostMergeAction` in `auto-merger.ts`).

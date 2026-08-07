# reminder-monitor

**Source**: `src/jobs/reminder-monitor.ts`
**Trigger**: Daily at 8 AM local time (`reminderMonitorHour`, #2355)
**Targets**: All repos (opt-out per repo via the `/jobs` matrix)

Scans `docs/scheduled-reminders/*.md` on the default branch of every managed repo and
files a GitHub issue when a reminder's notification date arrives — the mechanism for
repo-specific, human-facing schedules like credential rotation or certificate renewal
that don't fit any existing scanner.

## File format

Each reminder is a Markdown file with YAML frontmatter followed by the exact steps to
take:

```markdown
---
id: aws-deploy-key-rotation      # optional; defaults to the filename
title: Rotate the AWS deploy access key
notify_on: 2026-09-01            # YYYY-MM-DD — when Claws files the issue
expires_on: 2026-10-01           # optional — when the credential stops working
owner: stjohnb                   # optional
priority: true                   # optional; false files without the Priority label
---

1. Step-by-step instructions the agent must follow...
```

`README.md` in that directory is ignored (repos may want a human-facing index there),
as is any non-`.md` file.

## Firing and dedup

A reminder is due once local `today >= notify_on` (not `===`, so a missed day — e.g.
Claws being down at 8 AM — still recovers on the next tick instead of silently skipping
the reminder forever). Firing is deduplicated in SQLite by `(repo, reminder id,
notify_on)`, so a human closing the filed issue does not cause it to be re-filed. The
filed issue's title embeds `notify_on`, so a re-armed reminder (new `notify_on` in a
later commit) cannot collide with a still-open earlier one.

There is no recurrence/cron field. The issue body instructs the agent to update
`notify_on`/`expires_on` in the same PR as the rotation work (or delete the file if the
reminder is no longer needed) — since the dedup key includes `notify_on`, changing the
date is what arms the next cycle.

Reminder bodies are trusted content from the repo's own default branch (like any other
file an agent reads there), so they are **not** passed through `guardContent()` before
being embedded in the filed issue — doing so would strip the very instructions the
reminder exists to convey. As a narrower defence, a body beginning with a reserved Claws
control marker (e.g. `CLAWS_TRANSFER_TO:`) is rejected as malformed rather than honoured.

## Malformed files

A file with missing/invalid frontmatter, or a rejected reserved-marker body, is reported
via a single per-repo `ensureAlertIssue` (title prefixed `[reminder-monitor] Malformed
files in docs/scheduled-reminders/`) rather than one issue per bad file. The alert closes
automatically via `closeAlertIssueIfResolved` once every file in the directory parses
cleanly.

## Config

- `schedules.reminderMonitorHour` — local hour to run (default 8 AM).
- Per-repo opt-out via the `reminder-monitor` toggle in the `/jobs` matrix.

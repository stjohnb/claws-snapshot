# claude-memory-backup

**Source**: `src/jobs/claude-memory-backup.ts`
**Trigger**: Interval-based
**Interval**: 1 hour (configurable via `intervals.claudeMemoryBackupMs`)

Mirrors `~/.claude/projects/*/memory/*.md` — Claude's persistent per-project
memory files — into `memories/<project-slug>/*.md` on the orphan
`claude-memories` branch of `SELF_REPO`. Nothing else on the host backs these
files up: no restic/borg/cron unit and no other off-host copy.

Memories are not restored anywhere — `~/.claude` is disposable and rebuilt from
Secrets on every pod boot, deliberately with no restore-on-boot and no PVC.
This job is purely a one-way feed: see [Downstream](#downstream).

## Why a git branch on this repo

`claude.git(args, cwd, { owner })` already routes pushes through the
installation-token credential helper (`buildEnvForGhGit`), and `SELF_REPO`
is private, so this is the only off-host store Claws already authenticates
to. No new credentials, no new host, and git history gives free versioning
of every memory file — and, since #2757, a location `doc-maintainer` can fetch
from directly rather than reading a host-local store. The branch is
`claude-memories`, deliberately **not** prefixed `claws/` —
`stale-branch-cleaner` deletes stale `refs/remotes/origin/claws/*` branches
after 7 days, which would silently wipe both the backup and the fold's only
source. It is never opened as a PR or merged, and `public-snapshot-sync`
cannot leak it into a public mirror since that job only publishes
`git archive` of the default branch and release tags.

## Guards

- **Empty scan.** If the scan finds zero readable memory files anywhere
  (e.g. `~/.claude` is missing or unreadable), the job returns without
  touching git at all — an emptied or unreadable source must never be
  pushed as a fresh, empty backup.
- **Per-project wipe guard.** A project directory is only overwritten in the
  backup tree when its `memory/` directory was successfully enumerated this
  run. A project whose `memory/` directory throws on read (e.g. a transient
  permissions error) is skipped entirely and its existing committed copy is
  left untouched, rather than being deleted because this run couldn't see it.
- Symlinks, non-`.md` files, and files over 512 KB are skipped.

## Alerting

A failed push (network, secret scanning, auth) files/updates
`[claude-memory-backup] Memory backup push is failing` via `ensureAlertIssue`
and is swallowed rather than re-thrown, so an hourly failure updates one
issue instead of paging Slack every tick. `claude.git`'s own
`retryWithBackoff` already retries a transient network failure before this
alert path fires. The issue is closed via `closeAlertIssueIfResolved` once a
push succeeds again.

## Shutdown flush

`src/main.ts`'s `shutdown()` calls `run()` once, after the task-cancel step and
before `server.close()`, so memories written since the last hourly tick aren't
lost when a k8s pod is torn down. Gated on `isActive()` (a verify-only pod must
never push to `claude-memories` while the systemd instance owns it) and raced
against a 60 s timer so a stuck push can't block shutdown; a failure is logged
and swallowed rather than thrown. `claude-memories` — not any host — is the
durable store; see [Downstream](#downstream).

## Downstream

`doc-maintainer` folds this branch into each repo's `docs/` (#2757): it fetches
`claude-memories` into its own read-only checkout, gathers every
`memories/<slug>/*.md` directory whose slug belongs to a given repo (matching on
the trailing `-<owner>-<repo>` segment, so notes from any host that has ever
worked on that repo fold in — not just this one), and asks an agent to refine
durable facts out of them into the repo's docs. See
[doc-maintainer.md](doc-maintainer.md#memory-folding-2666-2757). A broken push
here starves that fold, so a failing backup is not just a lost-history risk —
it silences the mechanism that turns memories into anything read by future
agents.

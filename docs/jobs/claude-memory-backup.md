# claude-memory-backup

**Deep dive.** Read this when you're changing memory backup to the
`claude-memories` branch. For how doc-maintainer consumes memories, read
doc-maintainer.md instead.

**Source**: `src/jobs/claude-memory-backup.ts`
**Trigger**: Interval-based
**Interval**: 1 hour (configurable via `intervals.claudeMemoryBackupMs`)

Mirrors `~/.claude/projects/*/memory/*.md` — Claude's persistent per-project
memory files — into `memories/<project-slug>/*.md` on the orphan
`claude-memories` branch of `SELF_REPO`. Nothing else on the host backs these
files up: no restic/borg/cron unit and no other off-host copy.

It has a second source: the memory files of interactive k8s sessions, which
live on each session's own HOME PVC rather than the service's HOME — see
[Session memories](#session-memories). Headless agent pods (emptyDir HOME)
are not captured.

Memories are not restored anywhere — `~/.claude` is disposable and rebuilt from
Secrets on every pod boot, deliberately with no restore-on-boot and no PVC, and
a session never has the branch seeded into it.
This job is purely a one-way feed: see [Downstream](#downstream).

## Why a git branch on this repo

`claude.git(args, cwd, { owner })` already routes pushes through the
Forgejo credential helper (`buildEnvForForgejoGit`), and `SELF_REPO`
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

## Session memories

A session's `~/.claude/projects/*/memory/*.md` files would otherwise die with its
PVC on Delete or history pruning, and no other session or host ever sees them.
So whenever an interactive k8s session ends — End, Delete, the agent exiting, a
crash or an eviction — `src/session-memory-capture.ts` reads them off the PVC:

- **Capture pod.** A one-shot pod `claws-session-memory-<id>`
  (`buildMemoryCapturePod`, workload kind `session-memory`) mounts the session's
  PVC **read-only** at `/home/claws` with no Secret volumes and no
  ServiceAccount token, runs `node dist/session-pod/dump-memories.js`, and
  exits. It prints the files as one JSON line
  (`{"v":1,"projects":{slug:{file:content}},"skipped":n}`), using the same
  filters as the host scan (`collectMemoryFiles` in `src/claude-memory-files.ts`)
  plus a 2 MiB total cap. Claws reads the line through the pod-log API (`get
  pods/log` on the `claws-sessions` namespace), validates it, and always deletes
  the pod. The pod has 180 s to schedule and finish (`activeDeadlineSeconds`
  300 bounds a leftover one).
- **Database, not git.** A capture only upserts `session_memory_captures` (its
  files, `captured_at`, `pushed_at` cleared) and stamps
  `sessions.memories_captured_at`. The write is conditional on the row still
  having the `ended_at` it was taken for, so a capture racing a resume is
  discarded and the next end captures again. This job is the branch's only
  git writer, so the web and controller processes never race a push.
- **When.** The controller's reconcile captures up to 2 pending ended rows a
  pass (once their pod is gone, holding the id's lock), then triggers a run of
  this job. `remove()` and history pruning capture before deleting the PVC if
  that has not happened yet, and delete the capture pod ahead of the PVC so
  pvc-protection cannot hold it.
- **Give-up.** Each ended row gets 3 attempts (`memory_capture_attempts`). A
  failure never stops a session ending or its PVC being deleted: after 3
  failures, or with no PVC left, Delete and pruning go ahead uncaptured. Every
  reopen resets both columns, so a resumed session that ends again is captured
  again.

### Branch layout and the merge rule

A capture of session `<id>` lands in `memories/session-<id>-<slug>/`, where
`<slug>` is the session's own project directory name (always starting with
`-`). The directory name still ends in `-<owner>-<repo>`, so doc-maintainer's
suffix match attributes it with no change, and two sessions' `MEMORY.md` never
collide.

The merge is non-destructive:

- The host pass replaces only the host's own project directories. It never
  writes or removes a `session-*` directory, and skips any local project named
  `session-*`.
- Applying a session's capture removes every `memories/session-<id>--*`
  directory and writes its current files, so a file deleted or renamed after a
  resume disappears for that session only. An empty capture clears that
  session's directories. It never touches the host's or another session's.
- A capture is marked pushed (`pushed_at`) only after the push succeeds, or when
  it changed nothing; a failed push leaves it to retry next run. Captures
  outlive the session row, since the push may come after the row is pruned.

## Guards

- **Empty scan.** If the scan finds zero readable memory files anywhere
  (e.g. `~/.claude` is missing or unreadable) and no session capture is
  waiting, the job returns without touching git at all — an emptied or
  unreadable source must never be pushed as a fresh, empty backup. An empty
  host scan with captures waiting pushes only the captures.
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

A failed session capture (the pod failing, a 403 on `pods/log`, an invalid
dump, the 180 s timeout) logs a warning and files/updates one separate issue,
`[claude-memory-backup] Session memory capture is failing`, via
`ensureAlertIssue` — one issue for every session, never a page per session. The
next successful capture closes it.

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
worked on that repo, and from every captured session's
`session-<id>-<slug>` directory, fold in — not just this one), and asks an agent to refine
durable facts out of them into the repo's docs. See
[doc-maintainer.md](doc-maintainer.md#memory-folding-2666-2757). A broken push
here starves that fold, so a failing backup is not just a lost-history risk —
it silences the mechanism that turns memories into anything read by future
agents.

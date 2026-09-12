# staging-db-sync

**Deep dive.** Read this when you're changing the openclaw SQLite to staging
Postgres sync. For the final operator cutover order, read ../k8s-cutover.md
instead.

**Source**: `src/jobs/staging-db-sync.ts`
**Trigger**: Scheduled
**Interval**: Daily at 1 AM local (configurable via `schedules.stagingDbSyncHour`)

Loads openclaw's live `~/.claws/claws.db` into the Postgres database the
`claws-staging` pod runs against, so staging is ready to activate the moment
the rest of the k8s cutover lands (#2954). It takes a consistent online copy of
the SQLite database, prunes the *copy* down to a shippable size, streams it into
the pod through the apiserver, and runs
`dist/tools/import-sqlite-db.js` there to replace staging's contents.

Staging is verify-only, and overwriting whatever it wrote since the last sync
is **intended** — its own writes are disposable. The job's purpose is to keep
the two databases in step and to make the final cutover step small and
rehearsed rather than a one-shot `tar | kubectl exec` of a 647 MB file. See
[k8s-cutover.md § Data migration](../k8s-cutover.md#data-migration).

## The gates

Four gates, each of which logs and returns without touching `kubectl`:

1. **`CLAWS_DATABASE_URL` is set** — this instance is already on the Postgres
   backend, so there is no SQLite source to sync from. Read directly from the
   environment rather than through `src/config.ts`, because it is a gate on
   which backend the *local* instance uses, not a connection. This is what makes
   the job a permanent no-op inside the pod, and a permanent no-op everywhere
   after the cutover.
2. **The instance is verify-only** (`isActive()`). The scheduler registers zero
   jobs in verify-only mode already; this gate covers the manual
   `/trigger/staging-db-sync` path.
3. **No `CLAWS_STAGING_DB_SYNC_TARGET`** configured. Leave this unset until
   #2953 has shipped and the pod has booted against Postgres at least once —
   until the target schema exists, every run would fail loudly at the importer's
   "has `initDb()` run" check. With the target unset the job is a silent no-op
   instead.
4. **No fleet kubeconfig** (`fleetKubeconfigPath`). Same kubeconfig
   `k3s-monitor` uses; `pods/exec` is already permitted on it.

The target is `<namespace>/<pod>`, e.g. `default/claws-staging-0`. Anything
else throws rather than guessing a namespace.

## The pipeline

1. **Snapshot.** `better-sqlite3`'s `db.backup()` into a `mkdtemp` directory
   under `os.tmpdir()`. Never `fs.copyFileSync(DB_PATH, ...)`: `claws.db` is a
   live WAL database, and a plain file copy taken while claws is writing is
   torn. `db.backup()` is the online-backup API and produces a
   transactionally consistent file with claws still serving.
2. **Prune.** The live database is ~647 MB, of which `job_logs` alone is
   ~526 MB across ~390k rows; everything else is under 50 MB. `pruneSnapshot()`
   runs the same SQL as `pruneOldLogs()` in `src/db.ts` — old `job_runs` beyond
   `stagingDbSyncLogRetentionDays` (default 7), keeping the newest 20 runs per
   job, then the `job_logs` orphaned by that delete — followed by a `VACUUM`.
   Expect ~60 MB over the wire.
3. **Stream.** `kubectl exec -i -n <ns> <pod> -- sh -c 'cat > /home/claws/.claws/import-snapshot.db'`
   with the snapshot piped into the child's stdin. `kubectl exec`, not
   `kubectl cp` — no `tar` dependency in the container and no path quirks.
   20-minute timeout. A local `spawn` wrapper is used rather than
   `k3s-monitor`'s `kubectlExec`, whose 30-second timeout and `maxBuffer` are
   both wrong for a multi-minute upload.
4. **Import.** `kubectl exec -n <ns> <pod> -- node /opt/claws/dist/tools/import-sqlite-db.js /home/claws/.claws/import-snapshot.db`,
   30-minute timeout, stdout logged. `kubectl exec` inherits the container's
   environment, so `CLAWS_DATABASE_URL` and `CLAWS_DATABASE_PASSWORD` come from
   the StatefulSet's Secret with nothing passed on the command line.
5. **Clean up in the pod**, in a `finally` so it runs even when the import
   fails. Without it a ~60 MB file accumulates on the PVC every night.
   Failures here are logged at `warn` and do not fail the run.

The local temp directory is removed in an outer `finally`. That is
load-bearing — the un-pruned snapshot is the size of the live database, and
the automation host's disk is not spacious.

## Pruning only ever touches the copy

`pruneSnapshot()` runs against the temporary file in `os.tmpdir()`, never
against `~/.claws/claws.db`. The host database is opened
`{ readonly: true }` and the job issues no `DELETE` and no `VACUUM` against it;
the only statement it ever runs on the live database is the backup itself.
The host's own log retention is unchanged and remains governed by
`logRetentionDays`.

The consequence is deliberate: **staging carries a shorter `job_logs` history
than production.** A run older than the retention window is visible on
openclaw's dashboard and absent from staging's. That is the price of a nightly
full copy that fits comfortably inside the pod's resources, and staging exists
to verify behaviour, not to serve history.

## What the success log line reports

One `log.info` on success carries the numbers:

```
[staging-db-sync] Synced to default/claws-staging-0: snapshot 641.2 MB → 58.3 MB after pruning (312 job_runs removed), streamed in 74s, import 96s
```

Raw and pruned snapshot size, rows pruned, wire time and import time. Because
the scheduler records a `job_runs` row for every registered job, the run
history doubles as a growth chart for the database with no extra
instrumentation: if the pruned size starts climbing, something other than
`job_logs` is growing.

## Atomicity and failure

The importer does the whole load inside one Postgres transaction: `TRUNCATE`
of every target table, batched multi-row `INSERT`s, a per-table row-count
assertion against the source, then `setval` on every identity/serial sequence
to `max(id) + 1`. `TRUNCATE` is transactional in Postgres, so any failure —
including a row-count mismatch — rolls back and leaves staging's previous data
exactly where it was. Skipping the sequence repair is what produced the
duplicate-key failure fleet-infra hit restoring Forgejo in
`migrations/0030-forgejo-db.sh`.

The load holds `ACCESS EXCLUSIVE` on every table for its duration, so staging's
readers block and then see the new data in one step. No restart is needed
afterwards. `lock_timeout = '60s'` bounds acquisition; the 30-minute
`kubectl exec` timeout bounds the rest, and a SIGTERM'd `kubectl exec` kills
the pod-side process, which makes Postgres roll the transaction back.

Failures file a single recurring alert issue via `ensureAlertIssue` and
rethrow, so the scheduler marks the `job_runs` row `failed`; a success closes
it via `closeAlertIssueIfResolved`.

## Schema drift is a warning, not a failure

Tables and columns are discovered by intersecting SQLite's `sqlite_master` with
the target's `information_schema` — the importer never issues DDL and carries
no copy of the schema. Anything present on only one side is skipped and logged.
That covers `sqlite_sequence` (always in the source, never in Postgres) and,
more usefully, a pod running an older image than openclaw: its Postgres schema
is missing the newest columns, those columns are dropped for that run, and the
sync still succeeds. A hard failure there would block every sync during a
rollout.

One gap this does not cover: `TRUNCATE ... CASCADE` empties any table with a
foreign key into a truncated one, even a Postgres-only table that is itself
skipped because it has no SQLite counterpart yet. Such a table would be wiped
by the cascade and never repopulated. This has not come up because every
current table has a matching one on both sides; it becomes a real risk the
first time a newer Postgres schema adds a table with an FK onto an
already-synced table ahead of the SQLite side picking it up.

## Backup consequence

fleet-infra's `postgres-db-backup` dumps the shared Postgres at 02:30, which is
why this job runs at 01:00 — `scheduledHour` fires at HH:00, so that leaves 90
minutes of headroom. That dump is therefore the **only** backup of openclaw's
claws data that exists anywhere: `~/.claws/claws.db` on the host is not backed
up today.

## Container requirement

`better-sqlite3` must stay in the runtime container image. The importer reads a
SQLite file *inside the pod*, so it is a production dependency there even once
claws itself runs entirely on Postgres.

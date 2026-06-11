# migration-scanner

**Source**: `src/jobs/migration-scanner.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.migrationScannerHour`
(default: 6 AM local time)

Scans all cloned repos for migration directories containing incrementally-
numbered files instead of date-stamped filenames. Creates a deduped alert
issue per repo with a table of violations and the recommended convention.

- Only processes repos that Claws has previously cloned
- Discovers migration directories via two methods:
  - **Common paths**: checks `migrations/`, `db/migrations/`,
    `src/migrations/`, `database/migrations/`
  - **Recursive scan**: walks up to 4 levels deep for any directory named
    `migrations` (covers monorepo patterns like `packages/<name>/db/migrations`)
  - Skips `node_modules`, `.git`, `vendor`, `dist`, `build`, `.next`,
    `__pycache__`
- For each migration directory, classifies files by numeric prefix:
  - **Incremental**: prefix of 6 or fewer digits (e.g. `001_create_users.sql`)
  - **Date-based**: prefix of 8+ digits that resembles a date (`YYYYMMDD...`)
    or 10+ digits that resembles a Unix timestamp
- If **any** date-based file exists in a directory, the directory is considered
  mid-transition and is **not** flagged (suppresses warnings for repos
  actively migrating)
- Requires at least 2 incremental files to flag a directory (a single file
  doesn't establish a pattern)
- Deduplicates by searching for an existing open issue before creating a new one
- Issue title: `Alert: migrations using incremental numbering instead of date stamps`
- Issue body includes a table of violating directories with example filenames
  and the recommended convention: `YYYYMMDDHHMMSS_description.ext` filenames,
  directory scanning (no barrel file), `schema_migrations` table, and
  out-of-order application support

Does not create worktrees, PRs, or invoke Claude — purely a filesystem scan
with issue creation via the `gh` CLI.

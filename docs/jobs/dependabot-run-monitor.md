# dependabot-run-monitor

**Source**: `src/jobs/dependabot-run-monitor.ts`
**Trigger**: Smart-scheduled (see [OVERVIEW.md](../OVERVIEW.md) "Smart Scheduling")

Watches the **Dependabot updater** Actions runs per repo and files an alert issue when they fail.

## Why this job exists

A repo-side `notify-failures.yml` cannot cover this. The Dependabot updater is a *dynamic*
workflow (`path: dynamic/dependabot/dependabot-updates`, `event: dynamic`) with no file in the
repository, so `on.workflow_run.workflows:` cannot target it and `main-build-monitor-scanner`
(which only parses `.github/workflows/*.yml`) never sees it. Before this job, an updater that had
been failing on every run for days — e.g. `Handled error whilst updating @types/react:
dependency_file_not_resolvable` on `St-John-Software/perudo` — went entirely unnoticed while
dependency updates silently stopped arriving.

## How it works

1. `gh.listDependabotUpdateRuns(repo)` calls `GET /repos/{repo}/actions/runs?event=dynamic` and
   filters on `.path == "dynamic/dependabot/dependabot-updates"`. The `.path` filter is
   load-bearing: CodeQL default setup also emits `event: dynamic` runs. Repos with Actions
   disabled or no updater history return `[]` and are a silent no-op.
2. Runs are narrowed to `status === "completed"` (an `in_progress` run must never look like a
   non-failure) and to the last 30 days.
3. Runs are grouped by ecosystem via `groupKey()` — the run name minus its `" - Update #<n>"`
   suffix, e.g. `npm_and_yarn in /.` — and only the **latest** run per group is considered. This
   is the self-heal mechanism: a group that has since gone green is not reported.
4. For the first three failing groups, `gh.fetchFailedJobLog()` pulls the failed job's log and
   `extractDependabotErrors()` scrapes the error lines from it. The helper returns the **tail** of
   the log (the updater reports its error around line 500–700 of a ~700-line log, so head
   truncation would lose it), and the `.../jobs/{id}/logs` endpoint returns plain text, not JSON.
   Logs are fetched sequentially and capped at three per repo — each is ~100 KB.
5. `extractDependabotErrors()` strips ISO timestamps and ANSI escapes, then collects, in priority
   order, `Handled error whilst updating <dep>: <type> {detail}` lines, `##[error]` lines, and
   `ERROR <job_N> ...` lines; deduped, truncated to 500 chars each, at most five per group.
6. Each remaining failing group is cross-checked against the repo's live `.github/dependabot.yml`
   via `isRetiredGroup()` (reusing `normalizeDir`/`parseCoverage` from `dependabot-config-scanner.ts`)
   and dropped if no entry in the config can still produce that update job — GitHub keeps a retired
   ecosystem's last (failing) run as the permanent "latest" for that group after its
   `dependabot.yml` entry is removed, otherwise re-alerting for the full 30-day window even though
   the job can never run again (#2205). A run's internal ecosystem id (e.g. `npm_and_yarn`) is
   mapped to the `package-ecosystem` value(s) it could come from via `RUN_ECOSYSTEM_ALIASES` before
   comparing against the config; unmapped ecosystems, globbed directories, and unparsable/missing
   config all fail *open* (the group is still reported) rather than risk silently swallowing a real
   failure.
7. Files a single occurrence-tracked `ensureAlertIssue()` per repo titled
   `Alert: Dependabot update jobs are failing`, with a table of failing groups, a fenced error
   block per group, and remediation guidance (check `.github/dependabot.yml` ignore rules; for npm
   `dependency_file_not_resolvable`, a package in both `overrides` and `dependencies` blocks the
   bump). Auto-closes the issue once every group's latest run is green or retired.

## Deliberate choices

- **No label.** A stalled updater is not an outage, and Priority-queue flooding is a known problem
  in this repo, so the issue is filed unlabelled.
- **Log text is guarded.** Extracted error lines are third-party content that planning agents read
  back later, so each passes through `guardContent()` before being embedded in the issue body.
- **A repo with no updater runs at all is skipped entirely** — no issue filed, and any existing
  issue is left untouched rather than being closed on missing data.
- **Retired-ecosystem suppression fails open.** `isRetiredGroup()` only drops a group when the
  config can be read, parsed, and confidently shows no matching entry anywhere (including glob
  directories) — any ambiguity means the group stays reported, since a false suppression (silently
  missing a genuine ongoing failure) is worse than one stale re-alert (#2205).

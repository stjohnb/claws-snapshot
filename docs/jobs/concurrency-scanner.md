# concurrency-scanner

**Source**: `src/jobs/concurrency-scanner.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Scans GitHub Actions workflow files in all cloned repos for misconfigured
concurrency groups. Creates a deduped alert issue per repo with a table of
violations and recommended fixes.

## Detection classes

Three types of concurrency misconfiguration are detected:

1. **Missing top-level concurrency group** (`missing-workflow-concurrency`) —
   Workflow has no `concurrency:` key at the top level AND no job has a
   dynamic (expression-based) concurrency group. If any job uses `${{ ... }}`
   in its concurrency group, the workflow author is deliberately managing
   concurrency at the job level and this check is suppressed.

   This check is also suppressed for workflows whose triggers do not benefit
   from cancelling stale runs. Concurrency cancellation is most valuable for
   PR branches, where rapid pushes should obsolete in-flight runs (see
   [#1178](https://github.com/St-John-Software/claws/issues/1178)). Only
   workflows triggered by `pull_request`, `pull_request_target`, `merge_group`,
   or `push` to non-default/wildcard branches are checked. Workflows triggered
   solely by `schedule`, `workflow_run`, `release`, `repository_dispatch`,
   `deployment_status`, tag-only `push`, or `push` restricted to `main`/`master`
   are skipped because rapid duplicate runs on the same ref are not expected.

2. **Shared global group** (`shared-global-group`) — A job-level concurrency
   group uses a static name without `${{ github.ref }}` interpolation AND has
   `cancel-in-progress: true`. This creates a cross-branch mutex — only one
   job runs at a time across all branches, cancelling older runs on new
   pushes. Static groups with `cancel-in-progress: false` (the default) are
   intentional serialization and are not flagged.

3. **`deployment_status` uses `github.ref`** (`deployment-status-github-ref`) —
   A `deployment_status`-triggered workflow uses `${{ github.ref }}` in its
   concurrency group. For deployment events, `github.ref` always resolves to
   the default branch, creating a global mutex across all PRs. The fix is to
   use `${{ github.event.deployment.ref }}` instead.

## Known limitation: shared groups across 3+ workflows

The scanner does not detect a concurrency group *shared by 3+ jobs or
workflows that can trigger together*, whether static or per-ref. A group
holds one running + one pending job, so the third entrant silently cancels
the older pending one regardless of `cancel-in-progress: false` — the
eviction hazard described in
[patterns.md](../patterns.md#github-actions-concurrency--runner-priorities).
Detecting it requires cross-workflow analysis (grouping every workflow's
group expressions by resolved key and correlating trigger sets), which the
current per-file scan does not do. Repos hitting it show checks cancelled
seconds in with zero steps.

## Behavior

- Only processes repos that Claws has previously cloned
- Reads `.github/workflows/*.yml` and `*.yaml` from the local clone
- Skips `workflow_dispatch`-only workflows (manual-only, no benefit from
  concurrency groups)
- Suppresses `missing-workflow-concurrency` for workflows whose triggers do not
  benefit from concurrency (e.g. `schedule`, `workflow_run`, `release`,
  tag-only `push`, `push` restricted to `main`/`master`)
- Parses `on:` block to extract trigger event names
- Scans for both inline (`concurrency: group-name`) and block-form
  (`concurrency:` / `group:`) concurrency configurations at top-level and
  job-level
- Deduplicates by searching for an existing open issue before creating a
  new one
- Issue title: `Alert: workflow concurrency misconfiguration`
- Issue body includes a table of violations (file, problem, details) and a
  recommended fix snippet

Does not create worktrees, PRs, or invoke Claude — purely a filesystem scan
with issue creation via the `gh` CLI.

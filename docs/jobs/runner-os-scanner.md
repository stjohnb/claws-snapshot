# runner-os-scanner

**Source**: `src/jobs/runner-os-scanner.ts`
**Trigger**: Via `scanner-dispatcher` (daily schedule)

Scans GitHub Actions workflow files for jobs that use a `self-hosted` runner
without specifying an OS label (`linux` or `macos`). Creates a deduped alert
issue in the offending repo.

## Detection rule

A job is flagged when **all** of the following are true:

- `runs-on` contains the literal label `self-hosted`
- `runs-on` does **not** contain `linux` or `macos` (case-insensitive)
- `runs-on` does **not** contain a GitHub Actions expression (`${{ … }}`)

Examples:

| `runs-on` value | Result |
|---|---|
| `self-hosted` | Flagged |
| `[self-hosted]` | Flagged |
| `[self-hosted, x64]` | Flagged |
| `[self-hosted, linux]` | OK |
| `[self-hosted, Linux]` | OK (case-insensitive) |
| `[self-hosted, macos, arm64]` | OK |
| `ryzen` | OK (no `self-hosted`) |
| `[ryzen, linux]` | OK (no `self-hosted`) |
| `ubuntu-latest` | OK (other scanner's concern) |
| `${{ matrix.os }}` | OK (indeterminate) |
| `[self-hosted, ${{ matrix.arch }}]` | OK (indeterminate) |

## Implementation notes

- Uses `parseWorkflow` from `workflow-parser.ts` and inspects `JobInfo.runsOn`
- Issue title: `Alert: self-hosted runner jobs missing OS label`
- `searchQuery` equals `issueTitle` exactly for dedupe via `gh.searchIssues`
- Does not create worktrees, PRs, or invoke Claude — purely a filesystem scan

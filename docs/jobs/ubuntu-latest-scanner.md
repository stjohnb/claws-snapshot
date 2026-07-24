# ubuntu-latest-scanner

**Source**: `src/jobs/ubuntu-latest-scanner.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.ubuntuLatestScannerHour`
(default: 6 AM local time)

Scans GitHub Actions workflow files in all cloned repos for `runs-on:` values
that use GitHub-hosted runners (such as `ubuntu-latest`, `windows-2022`, or
`macos-latest`). Creates a deduped alert issue in the offending repo.

GitHub-hosted macOS runners (`macos-latest`, `macos-14`, etc.) used to be the
one allowed exception to the self-hosted-only policy; that exception was
removed once self-hosted macOS runners became available, so this scanner now
flags `macos-*` exactly like `ubuntu-*`/`windows-*` (#1855).

- Only processes repos that Claws has previously cloned
- Reads `.github/workflows/*.yml` and `*.yaml` from the local clone
- Scans each file line-by-line for `runs-on:` directives
- Skips commented-out lines (leading `#`)
- Detects GitHub-hosted runners matching `ubuntu-*`, `windows-*`, or `macos-*` patterns
- Supports both direct string form (`runs-on: ubuntu-latest`) and array form
  (`runs-on: [ubuntu-latest, ...]`), matching the first element
- Does **not** flag expression syntax (`runs-on: ${{ matrix.os }}`) — the
  resolved value can't be determined by static analysis, and flagging it
  unconditionally would false-positive on repos that resolve `matrix.os` to a
  custom self-hosted label. False positives are treated as worse than false
  negatives for this scanner.
- Custom self-hosted runners (like `ryzen`, `beefy`, `arm64`, or
  `[self-hosted, macos]`) are not flagged — only the first array element is
  checked, so `[self-hosted, macos]` is correctly ignored
- Deduplicates by searching for an existing open issue before creating a new one
- Issue title: `Alert: workflows using GitHub-hosted runners`
- Issue body includes a table of offending workflow files with line numbers
  and specific `runs-on` values

Does not create worktrees, PRs, or invoke Claude — purely a filesystem scan
with issue creation via the `gh` CLI.

# ubuntu-latest-scanner

**Source**: `src/jobs/ubuntu-latest-scanner.ts`
**Trigger**: Daily schedule
**Schedule**: Runs at hour configured by `schedules.ubuntuLatestScannerHour`
(default: 6 AM local time)

Scans GitHub Actions workflow files in all cloned repos for `runs-on:` values
that use GitHub-hosted runners (such as `ubuntu-latest` or `windows-2022`).
Creates a deduped alert issue in the offending repo.

- Only processes repos that Claws has previously cloned
- Reads `.github/workflows/*.yml` and `*.yaml` from the local clone
- Scans each file line-by-line for `runs-on:` directives
- Skips commented-out lines (leading `#`)
- Detects GitHub-hosted runners matching `ubuntu-*` or `windows-*` patterns
- Supports both direct string form (`runs-on: ubuntu-latest`) and array form
  (`runs-on: [ubuntu-latest, ...]`), matching the first element
- Flags expression syntax (`runs-on: ${{ matrix.os }}`) as non-self-hosted,
  since the resolved value cannot be statically determined — note that repos
  which resolve `matrix.os` to a custom self-hosted label will produce a
  false positive and should be reviewed manually
- Custom self-hosted runners (like `ryzen`, `beefy`, `arm64`) are not flagged
- Deduplicates by searching for an existing open issue before creating a new one
- Issue title: `Alert: workflows using GitHub-hosted runners`
- Issue body includes a table of offending workflow files with line numbers
  and specific `runs-on` values

Does not create worktrees, PRs, or invoke Claude — purely a filesystem scan
with issue creation via the `gh` CLI.

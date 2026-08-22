# repo-standards

**Source**: `src/jobs/repo-standards.ts`
**Trigger**: Daily schedule (also runs once on startup)
**Schedule**: Runs at hour configured by `schedules.repoStandardsHour`
(default: 2 AM local time)

Only processes repos that Claws has previously cloned. For each repo:

- **Applies label renames** — calls `applyLabelRenames()` first, before label
  sync, to fix case/name collisions (currently `duplicate` → `Duplicate`, since
  GitHub matches label names case-insensitively and `ensureLabel` had silently
  adopted repos' pre-existing lowercase `duplicate` instead of creating
  `Duplicate`). Idempotent no-op once applied. See
  [label-audit.md](../label-audit.md).
- **Syncs label definitions** — calls `ensureAllLabels()` to create/update
  all labels defined in `LABEL_SPECS` (from `config.ts`) with correct colors
  and descriptions (`Refined`, `Ready`, `Priority`, `In Review`, `Claws Ignore`)
- **Cleans up legacy labels** — removes labels in the `LEGACY_LABELS` set
  (old labels from the previous label-driven system, plus fleet-wide unwanted
  labels: GitHub defaults and dead ad-hoc labels). Full provenance and per-repo
  usage counts are in [label-audit.md](../label-audit.md).
Label management uses the `gh` CLI only. `.gitignore` enforcement (ensuring
`.mcp-claws.json` is present) is **not** handled by this job — it was moved to
the separate `gitignore-scanner` job (runs as part of `scanner-dispatcher`) and
converted from a worktree/commit/push/PR flow to a plain `gh.createIssue` call
with title-based dedup, per the owner's request to stop `repo-standards` from
opening PRs automatically and conserve CI minutes on repos where a PR triggers
a costly build (#1452). See `jobs/gitignore-scanner.ts` in
[modules.md](../modules.md).

## Owner requirement

Every managed repo should carry a `CLAUDE.md` (PR #1658 comment) so a manual or
agent session lands with repo-specific context. This is enforced, but not by
`repo-standards` — the separate `claude-config-scanner` job (also run via
`scanner-dispatcher`) scans for a missing `CLAUDE.md` or named subagents in
`.claude/agents/` and files an alert issue with a recommended layout; see
`jobs/claude-config-scanner.ts` in [modules.md](../modules.md).

## Stale Repo Cleanup

After processing all active repos, `cleanupStaleRepos()` removes local directories
for repos that are no longer in the configured `GITHUB_OWNERS` set:

- Deletes the main clone under `~/.claws/repos/{owner}/{name}`
- Deletes the worktree directory under `~/.claws/worktrees/{owner}/{name}`
- Removes empty owner-level directories after all their repos are removed

Cleanup is skipped if the active repo list is empty (transient fetch failure guard)
or if the GitHub API is currently rate-limited.

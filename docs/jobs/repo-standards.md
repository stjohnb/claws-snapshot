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
Label management uses the `gh` CLI only. `.gitignore` enforcement (ensuring `.mcp-claws.json` is present) was moved out of this job into a separate `gitignore-scanner` in #1453, and that scanner was decommissioned in #2743: since #2598 the MCP config is written outside every repo checkout — `writeAgentMcpConfig()` in `claude.ts` puts it under `~/.claws/agent-mcp/<hash>/`, and the session and shopping-sourcer configs live under `~/.claws` too — so no agent can leave a `.mcp-claws.json` in a working tree for a `git add -A` to pick up. The `.gitignore` entry it enforced protects against nothing, and no job enforces `.gitignore` contents any more.

## Owner requirement

Every managed repo should carry root agent instructions (PR #1658 comment) so a
manual or agent session lands with repo-specific context. The canonical file is
`AGENTS.md`, with a one-line `CLAUDE.md` containing `@AGENTS.md`: the Codex CLI
only auto-loads `AGENTS.md` and the Claude CLI only auto-loads `CLAUDE.md`.
This is enforced, but not by `repo-standards` — the separate
`claude-config-scanner` job (also run via `scanner-dispatcher`) files an alert
issue when a repo has *neither* `AGENTS.md` nor `CLAUDE.md`, or is missing named
role documents in `.agents/`, with a recommended layout; see
`jobs/claude-config-scanner.ts` in [modules.md](../modules.md).
`claude-config-scanner` detects *absence*; `doc-maintainer` maintains the
*content* of those role documents over time, refining them from `.intent/`
and `.memories/` capture — see
[doc-maintainer.md](doc-maintainer.md#agent-guidance-maintenance).

The one-time fleet-wide migration to `.agents/` (15 repos) was done by opening
the rename PRs directly rather than building a dedicated `agent-doc-migrator`
job (#2709, rejecting the approach sketched in the #2700 plan) — a schedule
key, matrix entry, tests, and doc edits would all be infrastructure for
something that runs exactly once. `claude-config-scanner` remains the drift
detector — a repo without `.agents/` role docs is reported as missing them;
do not re-propose a standalone migrator job.

## Stale Repo Cleanup

After processing all active repos, `cleanupStaleRepos()` removes local directories
for repos that are no longer in the configured `GITHUB_OWNERS` set:

- Deletes the main clone under `~/.claws/repos/{owner}/{name}`
- Deletes the worktree directory under `~/.claws/worktrees/{owner}/{name}`
- Removes empty owner-level directories after all their repos are removed

Cleanup is skipped if the active repo list is empty (transient fetch failure guard)
or if the GitHub API is currently rate-limited.

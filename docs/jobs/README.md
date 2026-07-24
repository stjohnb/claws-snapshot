# Jobs

Most jobs follow the same lifecycle:

1. List target issues/PRs via `gh` CLI
2. For each item: record task in DB, create a git worktree, run Claude via the
   serial queue, push results, clean up worktree, update DB
3. Errors are caught per-item (one failure doesn't block processing of other
   items) and reported via `error-reporter.ts`

Exceptions: `repo-standards`, `runner-monitor`, `scanner-dispatcher`
(and its sub-scanners), `stale-branch-cleaner`, `k3s-monitor`, `prod-k8s-monitor`,
`ha-upgrader`, `ha-deploy-watcher` do not invoke Claude or create worktrees. `idea-reconciler` creates
worktrees for file changes but does not invoke Claude. `email-monitor` invokes Claude
but does not create worktrees or interact with GitHub.
`whatsapp-handler` is event-driven (not scheduled).

## Agent Architecture

Issue and PR processing is handled by two dispatcher jobs (`src/jobs/`) that
each fetch items once per repo, classify them, and dispatch to the appropriate
agent (`src/agents/`):

- **`issue-dispatcher`** (`issue-dispatcher.ts`) orchestrates: planner (issue-refiner) + implementer (issue-worker)
- **`pr-dispatcher`** (`pr-dispatcher.ts`) orchestrates: ci-fixer + review-addresser + reviewer (pr-reviewer) + merger (auto-merger)

Agents can be individually disabled via `disabledAgents` in `config.json`
or the config page. Valid names: `planner`, `implementer`, `ci-fixer`,
`review-addresser`, `reviewer`, `merger`, `empty-pr-closer`. A disabled agent's phase is
silently skipped.

Each agent's comments include an agent-aware header:
`*— Automated by Claws · <AgentName> —*`

## Job Reference

Thirty jobs run on timers or schedules, plus `whatsapp-handler`, which is
event-driven. See [OVERVIEW.md](../OVERVIEW.md#jobs) for the canonical table
with trigger/interval details; this page links to the dedicated per-job docs
that exist.

| Job | Description |
|-----|-------------|
| [issue-dispatcher](issue-dispatcher.md) | Fetches open issues, dispatches to Planner and Implementer agents |
| sequential-issue-processor | Opt-in per repo (`/jobs` matrix) "process all issues" mode for incident-heavy repos — serializes to one issue at a time in an LLM-assessed priority order (#2103) |
| [pr-dispatcher](pr-dispatcher.md) | Fetches open PRs, dispatches to CI Fixer, Review Addresser, Reviewer, and Merger agents; closes empty (0-diff) PRs first |
| [triage-claws-errors](triage-claws-errors.md) | Investigates internal Claws errors with fingerprint deduplication |
| [doc-maintainer](doc-maintainer.md) | Nightly documentation updates from recent implementation plans |
| [repo-standards](repo-standards.md) | Syncs label definitions and cleans up legacy labels |
| [improvement-identifier](improvement-identifier.md) | Reviews codebases for security issues and improvements; files issues for both (no longer opens PRs) |
| public-repo-scanner | Daily scan of all public repos (incl. archived) for accidentally-committed secrets/PII |
| actions-storage-monitor | Daily scan of GitHub Actions cache + artifact storage usage across all repos |
| [public-snapshot-sync](public-snapshot-sync.md) | Daily (3 AM, #2106) private→public snapshot sync of the `PUBLIC_SNAPSHOTS` repo pairs |
| [idea-suggester](idea-suggester.md) | Suggests feature ideas via Slack with reaction-based triage |
| [idea-collector](idea-collector.md) | Collects Slack reactions on ideas and creates GitHub issues |
| [issue-auditor](issue-auditor.md) | Reconciles open issues to ensure correct label state |
| [dependabot-alert-monitor](dependabot-alert-monitor.md) | Polls Dependabot alerts per repo, auto-dismisses stale ones, files a remediation issue for the rest |
| [whatsapp-handler](whatsapp-handler.md) | Creates GitHub issues from WhatsApp messages (event-driven) |
| [runner-monitor](runner-monitor.md) | Monitors self-hosted GitHub Actions runners via SSH |
| mac-runner-waker | Wakes sleeping self-hosted Macs over SSH when a macOS CI job in `bonkus`/`namey`/`TempoStatusBar` has been queued for >60s, matched to a runner by `runs-on` label; SSH wake failures raise a per-host `[claws-error]` alert issue |
| [datasette-export](datasette-export.md) | Exports SQLite database to remote host via scp for Datasette exploration |
| scanner-dispatcher | Runs scanners sequentially: [ubuntu-latest-scanner](ubuntu-latest-scanner.md), [concurrency-scanner](concurrency-scanner.md), [migration-scanner](migration-scanner.md), main-build-monitor-scanner, cache-on-self-hosted-scanner, issue-comment-spam-scanner, [runner-os-scanner](runner-os-scanner.md), claude-config-scanner, gitignore-scanner, [dependabot-config-scanner](dependabot-config-scanner.md) |
| [stale-branch-cleaner](stale-branch-cleaner.md) | Deletes stale `claws/*` branches after PR merge/close |
| [idea-reconciler](idea-reconciler.md) | Reconciles closed-without-implementation ideas back to potential.md |
| [qa-phase](qa-phase.md) | Exploratory QA testing via Playwright browser automation |
| [email-monitor](email-monitor.md) | Processes emails for vegetable box recipe generation |
| [k3s-monitor](k3s-monitor.md) | Monitors k3s cluster pods, nodes, and Flux resources for failures |
| prod-k8s-monitor | Same detection as k3s-monitor for the prod cluster; configurable kubeconfig and target repo; disabled by default |
| [runner-metrics-sync](runner-metrics-sync.md) | Syncs GitHub Actions workflow runs to SQLite for runner utilization analytics |
| ha-upgrader | Polls Home Assistant for pending updates, installs within dwell windows, raises issues on failures; Slack only on installs/failures (not on routine dwell waits) |
| ha-deploy-watcher | Polls git-pull addon logs every 5 min for `Updating <old>..<new>` events; posts Slack notification with compare link and diffstat on each new deploy; first run baselines silently |
| worktree-cleaner | Daily prune of stale `~/.claws/worktrees/` directories older than 7 days |
| bin-day-monitor | Polls Home Assistant bin-day sensors; maintains a running availability log issue; disabled by default |
| ha-battery-monitor | Polls Home Assistant battery sensors below a threshold; files/auto-closes a low-battery issue; disabled by default |
| damp-reminder | Weekly (Monday) reminder to log damp meter readings on the `/damp` dashboard page |

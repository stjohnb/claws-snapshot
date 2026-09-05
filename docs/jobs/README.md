# Jobs

**Reference.** The shared job lifecycle plus the per-job doc index. For a
single job's trigger/interval/summary, OVERVIEW's Jobs table is enough; open
this doc when you need the shared lifecycle steps or a linked per-job deep
dive.

Most jobs follow the same lifecycle:

1. List target issues/PRs via `gh` CLI
2. For each item: record task in DB, create a git worktree, run Claude via the
   serial queue, push results, clean up worktree, update DB
3. Errors are caught per-item (one failure doesn't block processing of other
   items) and reported via `error-reporter.ts`

Exceptions: `repo-standards`, `runner-monitor`, `host-disk-monitor`, `claude-memory-backup`, `auth-secret-sync`, `scanner-dispatcher`
(and its sub-scanners), `stale-branch-cleaner`, `k3s-monitor`, `prod-k8s-monitor`, `github-status`,
`ha-upgrader`, `ha-deploy-watcher`, `ha-area-reconciler`, `ha-energy-reconciler`, `ha-repairs-monitor`, `reminder-monitor`, `upstream-watcher` do not invoke Claude or create worktrees. `email-monitor` invokes Claude
but does not create worktrees or interact with GitHub. `shopping-sourcer` and
`shopping-comment-processor` invoke Claude in a scratch directory (never a worktree) and
file GitHub issues.
`whatsapp-handler` is event-driven (not scheduled). `dmarc-monitor` is not scheduled at
all — it is a handler `email-monitor` calls per message; it invokes no Claude but does
file GitHub alert issues.

## Agent Architecture

Issue and PR processing is handled by two dispatcher jobs (`src/jobs/`) that
each fetch items once per repo, classify them, and dispatch to the appropriate
agent (`src/agents/`):

- **`issue-dispatcher`** (`issue-dispatcher.ts`) orchestrates: planner (issue-refiner) + implementer (issue-worker)
- **`pr-dispatcher`** (`pr-dispatcher.ts`) orchestrates: ci-fixer + review-addresser + reviewer (pr-reviewer) + merger (auto-merger)

Agents can be individually disabled via `disabledAgents` in `config.json`
or the config page. Valid names: `planner`, `implementer`, `ci-fixer`,
`review-addresser`, `reviewer`, `merger`, `empty-pr-closer`, `superseded-pr-closer`. A disabled agent's phase is
silently skipped.

Each agent's comments include an agent-aware header:
`*— Automated by Claws · <AgentName> —*`

## Job Reference

Forty jobs run on timers or schedules, plus `whatsapp-handler`, which is
event-driven. See [OVERVIEW.md](../OVERVIEW.md#jobs) for the canonical table
with trigger/interval details; this page links to the dedicated per-job docs
that exist.

| Job | Description |
|-----|-------------|
| [issue-dispatcher](issue-dispatcher.md) | Fetches open issues, dispatches to Planner and Implementer agents |
| [pr-dispatcher](pr-dispatcher.md) | Fetches open PRs, dispatches to CI Fixer, Review Addresser, Reviewer, and Merger agents; closes empty (0-diff) PRs first |
| [triage-claws-errors](triage-claws-errors.md) | Investigates internal Claws errors with fingerprint deduplication |
| [doc-maintainer](doc-maintainer.md) | Nightly documentation updates from recent implementation plans |
| [repo-standards](repo-standards.md) | Syncs label definitions and cleans up legacy labels |
| [improvement-identifier](improvement-identifier.md) | Reviews codebases for security issues and improvements; files issues for both (no longer opens PRs) |
| public-repo-scanner | Daily scan of all public repos (incl. archived) for accidentally-committed secrets/PII |
| actions-storage-monitor | Daily scan of GitHub Actions cache + artifact storage usage across all repos |
| [public-snapshot-sync](public-snapshot-sync.md) | Daily (3 AM, #2106) private→public snapshot sync of the `PUBLIC_SNAPSHOTS` repo pairs |
| [idea-suggester](idea-suggester.md) | Manually triggered; suggests feature ideas and files them as GitHub issues |
| [issue-auditor](issue-auditor.md) | Reconciles open issues to ensure correct label state |
| [dependabot-alert-monitor](dependabot-alert-monitor.md) | Polls Dependabot alerts per repo, auto-dismisses stale ones, files a remediation issue for the rest |
| [dependabot-run-monitor](dependabot-run-monitor.md) | Watches the dynamic Dependabot updater Actions runs per repo and alerts when dependency updates stop arriving |
| [main-build-monitor](main-build-monitor.md) | Retries transient default-branch build failures once, then files, bumps and closes the `Build failure: <workflow>` tracking issue |
| [dependabot-tofu-unblocker](dependabot-tofu-unblocker.md) | Pushes an empty `ci: run tofu plan` commit onto confined `dependabot/terraform/*` PRs in bstjohn-blog so the Tofu Plan gate can run |
| [whatsapp-handler](whatsapp-handler.md) | Creates GitHub issues from WhatsApp messages (event-driven) |
| [runner-monitor](runner-monitor.md) | Monitors self-hosted GitHub Actions runners via SSH |
| [host-disk-monitor](host-disk-monitor.md) | Monitors the disk of the host Claws itself runs on; non-Docker tiered cleanup, escalation issue, and a container-runtime tripwire for this plan-only host |
| [claude-memory-backup](claude-memory-backup.md) | Mirrors ~/.claude memory files to the claude-memories branch, which doc-maintainer folds into docs/ |
| [auth-secret-sync](auth-secret-sync.md) | Persists rotated Codex/Claude auth from the pod's local files to the `claws-auth` k8s Secret |
| mac-runner-waker | Wakes sleeping self-hosted Macs over SSH when a macOS CI job in `bonkus`/`namey`/`TempoStatusBar` has been queued for >60s, matched to a runner by `runs-on` label; SSH wake failures raise a per-host `[claws-error]` alert issue, except host-absent failures (Mac off the network), which send a Slack notice per absence episode instead |
| scanner-dispatcher | Runs scanners sequentially: [ubuntu-latest-scanner](ubuntu-latest-scanner.md), [concurrency-scanner](concurrency-scanner.md), [migration-scanner](migration-scanner.md), cache-on-self-hosted-scanner, issue-comment-spam-scanner, [runner-os-scanner](runner-os-scanner.md), claude-config-scanner, [dependabot-config-scanner](dependabot-config-scanner.md), design-guidelines-scanner, [dynamic-workflow-runner-scanner](dynamic-workflow-runner-scanner.md), [host-policy-scanner](host-policy-scanner.md) |
| [stale-branch-cleaner](stale-branch-cleaner.md) | Deletes stale `claws/*` branches after PR merge/close |
| [email-monitor](email-monitor.md) | Processes emails for vegetable box recipe generation |
| [dmarc-monitor](dmarc-monitor.md) | Handler inside `email-monitor` (not separately scheduled) — ingests DMARC aggregate reports from the mailbox into SQLite, classifies each row, and alerts on spoofs, unaligned senders and policy drift |
| [k3s-monitor](k3s-monitor.md) | Monitors k3s cluster pods, nodes, and Flux resources for failures |
| prod-k8s-monitor | Same detection as k3s-monitor for the prod cluster; configurable kubeconfig and target repo; disabled by default |
| [runner-metrics-sync](runner-metrics-sync.md) | Syncs GitHub Actions workflow runs to SQLite for runner utilization analytics |
| ha-upgrader | Polls Home Assistant for pending updates, installs within dwell windows, raises issues on failures; Slack only on installs/failures (not on routine dwell waits) |
| ha-deploy-watcher | Polls git-pull addon logs every 5 min for `Updating <old>..<new>` events; posts Slack notification with compare link and diffstat only when the config check errors or warns; clean deploys are silent; first run baselines silently |
| ha-area-reconciler | Reconciles Home Assistant entity → area assignments to match the version-controlled `registry/areas.yaml` manifest over the WebSocket API, and device → area assignments from the `devices:` block over `config/device_registry/update`; files a `Priority` alert issue for unknown entities or area ids |
| ha-energy-reconciler | Reconciles the Energy dashboard prefs to `registry/energy.yaml` over the WebSocket API (`energy/get_prefs` → `energy/save_prefs`); refuses and files a `Priority` issue rather than saving an empty `energy_sources`; silent no-op while the file is absent |
| worktree-cleaner | Daily prune of stale `~/.claws/worktrees/` directories older than 7 days |
| bin-day-monitor | Polls Home Assistant bin-day sensors; maintains a running availability log issue; disabled by default |
| ha-battery-monitor | Polls Home Assistant battery sensors below a threshold; files/auto-closes a low-battery issue; disabled by default |
| ha-backup-monitor | Polls Home Assistant backup event/overdue entities; files/auto-closes issues for failed or overdue automatic backups; alerts when the overdue sensor is itself unavailable for 48 h; disabled by default |
| ha-deploy-stall-monitor | Polls `binary_sensor.deploy_pipeline_stalled`; files/auto-closes a Priority issue when the `core_git_pull` add-on stalls and the automatic restart doesn't self-heal; enabled by default |
| ha-repairs-monitor | Polls Home Assistant's WebSocket-only repairs list (`repairs/list_issues`); files/auto-closes a Priority issue listing all currently open, un-ignored repairs; enabled by default when HA is configured; a `homeAssistantRepairsIgnore` list suppresses permanently-noisy repairs such as the nightly `nas_backup` mount failure |
| damp-reminder | Weekly (Monday) reminder to log damp meter readings on the `/damp` dashboard page |
| [reminder-monitor](reminder-monitor.md) | Daily scan of `docs/scheduled-reminders/` across repos; files an issue when a reminder's `notify_on` date arrives |
| [upstream-watcher](upstream-watcher.md) | Daily scan of `docs/upstream-watches/*.yaml`; unparks an issue (removes `Claws Ignore`, adds `Ready`, comments) once the upstream PR/issue/release it was waiting on has landed |
| [blog-draft-scanner](blog-draft-scanner.md) | Daily scan for draft blog posts left in other repos; files a port issue in `bstjohn-blog` when one hasn't been published yet |
| [shopping-sourcer](shopping-sourcer.md) | Daily phase-gated hardware sourcing from `docs/shopping/*.yaml`; browses marketplaces for wanted items and maintains a `[shopping]` tracking issue per manifest for manual purchase |
| [shopping-comment-processor](shopping-comment-processor.md) | Turns plain-English comments on a `[shopping]` tracking issue into validated manifest mutations, committed to the default branch and replied to on the issue; the primary way to update a shopping list |
| [site-promoter](site-promoter.md) | Daily website promotion from `docs/promotion/*.yaml`; runs an OpenCode/OpenRouter agent in a worktree of the site's own repo and files up to two issues per site — code channels unlabelled for the normal pipeline, manual channels `Claws Ignore` with ready-to-post copy |

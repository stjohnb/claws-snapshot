# runner-monitor

**Source**: `src/jobs/runner-monitor.ts`
**Trigger**: Interval-based
**Interval**: 10 minutes (configurable via `intervals.runnerMonitorMs`)

Monitors self-hosted GitHub Actions runner hosts via SSH. Unlike most jobs,
this does not operate on GitHub repos — it directly manages infrastructure.
Runner hosts are configured with baked-in defaults (two Hetzner servers),
overridable via the `runners` array in `config.json`.

For each configured runner (sequential, with per-host error reporting):

## 1. Service health check

- Runs `sudo ./svc.sh status` in the runner's `actionsDir`
- If the service is not active: stops it, starts it, and verifies recovery
- Records action for Slack notification

## 2. Zombie/stale process detection

- Scans for `Runner.Worker` and `Runner.Listener` processes older than 6 hours
- Only auto-kills if the runner service itself is dead (orphaned workers)
- Logs a warning for long-running processes when the service is healthy
  (avoids killing legitimate long CI runs)

## 3. Disk space check (tiered cleanup)

- Reads disk usage via `df`
- **Tier 1 (>85%)**: cleans temp files (`/tmp/_github_*`, `_work/_temp/*`),
  runs `docker system prune -f`, vacuums journal logs (`--vacuum-time=3d`)
- **Tier 2 (>90%)**: additionally runs `docker system prune -af --volumes`
  and clears the tool cache (`_work/_tool/*`)
- Each cleanup step is independently try/caught (Docker may not be present)
- Post-cleanup: re-checks disk usage and reports before→after in Slack
- **Persistent high disk**: if usage remains >90% after cleanup, collects a
  disk breakdown (`du -sh` on key dirs + `docker system df`) and either:
  - Comments on an existing open issue matching the runner name
  - Creates a new issue labeled `runner-maintenance` with the breakdown
- Issue creation failures are logged as warnings and do not block the monitor

**SSH configuration**: Uses `BatchMode=yes` (fails rather than prompting),
`ConnectTimeout=10`, `StrictHostKeyChecking=accept-new`, and a 30-second
command timeout. Supports custom ports and identity files per host.

**Notifications**: A single Slack notification is sent at the end of each run
if any actions were taken. Healthy hosts are logged at info level only.

Does not create worktrees, PRs, or invoke Claude — infrastructure monitoring
via SSH, with automatic GitHub issue creation for persistent disk problems.

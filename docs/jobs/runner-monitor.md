# runner-monitor

**Source**: `src/jobs/runner-monitor.ts`
**Trigger**: Interval-based
**Interval**: 10 minutes (configurable via `intervals.runnerMonitorMs`)

Monitors self-hosted GitHub Actions runner hosts via SSH. Unlike most jobs,
this does not operate on GitHub repos — it directly manages infrastructure.
There are no baked-in default runner hosts (the `hetzner-beefy-actions` host was decommissioned, #2770) —
runner hosts come solely from the `runners` array in `config.json`. With an empty list, this job logs
`[runner-monitor] No runners configured — skipping` and does nothing.

**Open gap**: The org's two live Linux runners, `ryzen` (NixOS `services.github-runners` unit
`github-runner-ryzen`) and `nas` (NixOS `services.github-runners` unit `github-runner-nas`),
are not in the `runners` list and so get none of this job's health/disk monitoring — adding them
is a config-only change now that systemd-flavour support (#2336) exists, not a code change.

## Runner flavours

A `RunnerHost` entry is either an **svc** runner (a self-installed
`./svc.sh`-managed Actions runner, identified by `actionsDir`) or a
**systemd** runner (a NixOS `services.github-runners` unit, identified by
`serviceUnit` + `workDir` + `toolDir`). The flavour is selected purely by the
presence of `serviceUnit` — svc runners keep using `actionsDir` and its
`_work`/`_work/_tool` subdirectories, while systemd runners use `workDir`
(the `_work` equivalent, holding checkouts and `_temp`) and `toolDir` (the
tool cache, with no `_tool` subdirectory) directly. `assertSafeRunnerPaths()`
validates whichever fields the flavour requires before any SSH command
interpolates them.

The host Claws itself runs on is deliberately **not** a `RunnerHost` (same
rationale already recorded for the Macs) — it has no Actions runner, and Claws
would be SSHing to itself; its disk is covered by
[host-disk-monitor](host-disk-monitor.md), which runs locally.

A systemd runner's `workDir`/`toolDir` are also bind-mounted at a `/run/github-runner/<name>` path, but that bind mount is private to the runner unit's own mount namespace — an SSH session (and this job) must always use the `/var/lib/...` path from config, never the `/run/...` one, which resolves to something else outside the unit's namespace (same namespace-privacy class as the [Docker on NixOS Runners](../patterns.md#docker-on-nixos-runners) pattern).

For each configured runner (sequential, with per-host error reporting):

## 1. Service health check

- svc: runs `sudo ./svc.sh status` in the runner's `actionsDir`; active means
  the output contains `active (running)`
- systemd: runs `systemctl is-active <serviceUnit> || true` (the `|| true` is
  required because `is-active` exits non-zero when inactive, which would
  otherwise be indistinguishable from an SSH failure); active means the
  trimmed output is `active` or `activating` (a unit still starting up must
  not be restarted)
- If the service is not active: restarts it (svc: `svc.sh stop` then
  `svc.sh start`; systemd: `sudo systemctl restart <serviceUnit>`, given a
  120s timeout since a unit stop can take a while) and verifies recovery
- Records action for Slack notification

## 2. Zombie/stale process detection

- Scans for `Runner.Worker` and `Runner.Listener` processes older than 6 hours
- Only auto-kills if the runner service itself is dead (orphaned workers)
- Logs a warning for long-running processes when the service is healthy
  (avoids killing legitimate long CI runs)

## 3. Disk space check (tiered cleanup)

- Reads disk usage via `df`
- **Tier 1 (>85%)**: cleans temp files (`/tmp/_github_*` and, per flavour,
  `<actionsDir>/_work/_temp/*` or `<workDir>/_temp/*`), runs `docker system
  prune -f`, **and** `docker image prune -af --filter 'until=24h'` (120s
  timeout), vacuums journal logs (`--vacuum-time=3d`). The time-bounded
  tagged-image prune is required in addition to the dangling-only `docker
  system prune -f` because CI workflows that tag every build (e.g.
  `ci-<sha>`) leave images that survive dangling-only prune indefinitely and
  never trip tier 2's >90% threshold on their own (#1349/#1352). If a
  `Runner.Worker` process is live (a job is executing right now), the
  temp-file cleanup is skipped entirely — otherwise it only removes entries
  older than 6 hours. Deleting the live temp dir mid-job destroys the job's
  scratch dir and the runner's own `set_output`/`set_env` file-command files,
  failing the job with a spurious `ENOENT ... cache.tzst` (#2327)
- **Tier 2 (>90%)**: additionally runs `docker system prune -af --volumes`
  and clears the tool cache — `<actionsDir>/_work/_tool/*` for svc runners,
  or `<toolDir>/*` directly for systemd runners (there is no `_tool`
  subdirectory under `toolDir` — tools live straight under it, e.g.
  `<toolDir>/node/20.x/x64`) — likewise skipped while a job is running,
  since the tool cache holds the toolchain (e.g. Node) the live job is
  executing from
- Each cleanup step is independently try/caught (Docker may not be present)
- Post-cleanup: re-checks disk usage and reports before→after in Slack
- **Persistent high disk**: if usage remains >90% after cleanup, collects a
  disk breakdown and either:
  - Comments on an existing open issue matching the runner name
  - Creates a new issue labeled `runner-maintenance` with the breakdown
- Issue creation failures are logged as warnings and do not block the monitor

**Disk breakdown** (`getDiskBreakdown`): `df -h /`, per-directory `du -sh`,
top 10 largest `_work` subdirectories, top 20 Docker images by size, and
`docker system df` — each run as its **own** SSH call with a 60-second
timeout, not one combined call, because a single 30s-bounded combined call
reliably timed out on runners with large `_work`/Docker state, silently
producing an empty breakdown (#1352).

**SSH configuration**: Uses `BatchMode=yes` (fails rather than prompting),
`ConnectTimeout=10`, `StrictHostKeyChecking=accept-new`, and a 30-second
default command timeout (overridden per-call where a longer-running command
needs it, e.g. the disk-breakdown probes above). Supports custom ports and
identity files per host.

**Notifications**: A single Slack notification is sent at the end of each run
if any actions were taken. Healthy hosts are logged at info level only.

Does not create worktrees, PRs, or invoke Claude — infrastructure monitoring
via SSH, with automatic GitHub issue creation for persistent disk problems.

# runner-monitor

**Deep dive.** Read this when you're changing self-hosted runner health or disk
cleanup. For the Claws host's local disk cleanup, read host-disk-monitor.md
instead.

**Source**: `src/jobs/runner-monitor.ts`
**Trigger**: Interval-based
**Interval**: 10 minutes (configurable via `intervals.runnerMonitorMs`)

Monitors self-hosted Actions runner hosts via SSH. Unlike most jobs,
this does not operate on GitHub repos — it directly manages infrastructure.
Runner hosts come from two sources:

- **Static `runners` config (legacy GitHub runners).** There are no baked-in
  defaults (the `hetzner-beefy-actions` host was decommissioned, #2770), and the
  live list is currently empty. With an empty list, the job logs
  `[runner-monitor] No runners configured — skipping` and skips the static checks
  below (sections 1–3), then still runs the Forgejo checks. The on-demand
  `hetzner-runner` is deliberately **not** listed: `hetzner-runner-down.yml`
  destroys it, so a static entry would post a `restart failed` line every run
  while it is down (#2863).
- **Forgejo runners, discovered dynamically** from the Forgejo org runner
  registry on every run — see [Forgejo runners](#forgejo-runners). No per-host
  config.

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

For each statically configured runner (sequential, with per-host error reporting):

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

## Forgejo runners

`checkForgejoRunners()` runs after the static loop on every tick, and does
nothing when Forgejo is not configured (#2863).

**Discovery.** For each owner that has a Forgejo repo (from the cached
`listRepos()`), the job reads `GET /orgs/{owner}/actions/runners` with the
read-only `forgejoAdminToken`. With no admin token, or a 403/404 on the
registry, that owner is skipped quietly. Only **org-scope** runners are visible:
the global registry (`/admin/actions/runners`) needs `read:admin`, which the
admin token lacks. The runners registered globally today are fleet-infra's k3s
pods, which cannot be reached over SSH anyway.

**Name is the SSH host.** A runner's registered name is first checked as a safe
hostname (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) and then resolved through
`resolveLanHost()` / `LAN_HOST_ALIASES` in `config.ts` before SSH. The two Mac
runner names are intentionally handled there so `runner-monitor` and
`mac-runner-waker` share one source for the address and default login user.
Explicit custom hosts are preserved even when a runner's display name matches
a built-in alias; explicit login users also override the alias default.
Unknown names pass through to LAN DNS, Tailscale MagicDNS, or the Claws host's
`~/.ssh/config`. User, port and key otherwise come from ssh_config; there is no
second Secret or dotfile alias source.

**Per runner status** (sequential; one runner's failure never stops the rest):

- **Online** (`idle`/`active`): runs `df -P / | tail -1` (POSIX `-P`, because
  macOS `df` has no `--output`). Above 90% raises
  `[runner-monitor] High disk on Forgejo runner <name>`. At 85% or below that
  alert is closed.
- **Offline, `macos` label**: never probed. An SSH probe through the Bonjour
  sleep proxy would wake a sleeping Mac every 10 minutes, and
  `mac-runner-waker` already owns Mac wake and offline alerts.
- **Offline, other**: runs `true` over SSH. If it succeeds, the host is up but
  the runner agent is not, and the job raises
  `[runner-monitor] Forgejo runner <name> offline but host is up`.
- **Host absent** (`isHostAbsent` in `src/ssh.ts`: name does not resolve, no
  route, timeout): skipped silently, since hosts like `nas` are powered off by
  design and Macs sleep. For an offline runner this also closes its
  offline-but-up alert.
- **Any other SSH error** (permission denied, connection refused, host key
  mismatch): raises `[runner-monitor] Cannot SSH to Forgejo runner <name>`,
  closed after the next successful SSH to that runner. The alert points at
  `resolveLanHost` / `LAN_HOST_ALIASES` without printing private LAN addresses.

Nothing is restarted, cleaned up, or cancelled on a discovered runner. Runner
layouts differ (k3s docker-mode, launchd on Macs, NixOS units), so these checks
only raise alerts.

**Queue stall.** For each Forgejo repo, the waiting jobs
(`forgejo.listWaitingRunJobs`, admin token) that have no `macos` label and were
first seen more than **30 minutes** ago raise one
`[runner-monitor] Forgejo Actions jobs waiting with no runner` issue. The issue
lists each job and gives a snapshot of the org runner registry. Jobs whose
labels no runner advertises (e.g. `tailnet`) also land here. The first-seen time
is kept in memory, so a Claws restart restarts the clock; that delays an alert
but never drops it.

**Long-running jobs.** For each Forgejo repo, running tasks from
`GET /repos/{repo}/actions/tasks?limit=50` (bot token) that started more than
**45 minutes** ago raise one `[runner-monitor] Forgejo Actions job running over 45m`
issue. The issue names the workflow, job, run number, start time and URL.
Nothing is cancelled. The endpoint returns tasks newest first, so in a very busy
repo a long-running task can fall outside the first 50.

**Alert lifecycle.** Every Forgejo alert uses `ensureAlertIssue` with
`refreshBody: true`, so one issue body is kept current. The single end-of-run
Slack summary gets a line only when an issue is first created. Each alert is
closed with `closeAlertIssueIfResolved` once its condition clears. A failure in
one repo's waiting-jobs or tasks read is logged and does not stop the other
repos.

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
via SSH, with automatic GitHub issue creation for persistent disk problems and
for Forgejo runner, queue-stall and long-running-job alerts.

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
pods, which cannot be reached over SSH anyway. Their presence is inferred from
*running* jobs (see "Queue stall"), not listed in a registry.

**Name is the SSH host.** A runner's registered name is first checked as a safe
hostname (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) and then resolved through
`resolveLanHost()` / `LAN_HOST_ALIASES` in `config.ts` before SSH. The two Mac
runner names are intentionally handled there so `runner-monitor` and
`mac-runner-waker` share one source for the address and default login user.
Explicit custom hosts are preserved even when a runner's display name matches
a built-in alias; explicit login users also override the alias default.
Unknown names pass through to LAN DNS, Tailscale MagicDNS, or the Claws host's
`~/.ssh/config`. User, port and key otherwise come from ssh_config; there is no
second Secret or dotfile alias source. The Claws pod's fleet-infra egress policy
must allow TCP 22 to every runner address, as the PR #120 outage on 2026-10-13
showed.

**Duplicate names:** Forgejo keeps orphaned registry rows after a runner is
re-registered, and alerts are keyed by runner name. Rows are therefore collapsed
by name before the per-runner loop: the first `idle`/`active` row wins, else the
first row, so a name is probed once. Each skipped row is logged at info as
`ignoring registry row <id> (<status>) — row <keptId> is <keptStatus>`. The
queue-stall snapshot still lists every row. Motivating case: the 2026-10-16
`ryzen` flap (row 11 idle, stale row 9 offline) that opened and closed an alert
every tick.

**Per runner status** (sequential; one runner's failure never stops the rest):

- **Online** (`idle`/`active`): runs `df -P / | tail -1` (POSIX `-P`, because
  macOS `df` has no `--output`). Above 90% raises
  `[runner-monitor] High disk on Forgejo runner <name>`. At 85% or below that
  alert is closed.
- **Offline, `macos` label**: never probed. An SSH probe through the Bonjour
  sleep proxy would wake a sleeping Mac every 10 minutes, and
  `mac-runner-waker` already owns Mac wakes, and an unavailable Mac is
  deliberately never alerted on.
- **Offline, other**: runs `true` over SSH. If it succeeds, the host is up but
  the runner agent is not, and the job raises
  `[runner-monitor] Forgejo runner <name> offline but host is up`.
- **Host absent** (`isHostAbsent` in `src/ssh.ts`: name does not resolve, no
  route, timeout): skipped silently, since hosts like `nas` are powered off by
  design and Macs sleep. For an offline runner this also closes its
  offline-but-up alert. An online (`idle`/`active`) runner whose name does not
  resolve is the exception: it raises the Cannot SSH alert.
- **Any other SSH error**: raises `[runner-monitor] Cannot SSH to Forgejo runner <name>`
  only after two consecutive failed checks for that runner. A success or a
  host-absent result resets the count; the count is in memory and resets when
  the service restarts. The alert is closed after the next successful SSH to that runner. The alert has a
  resolved-target line (`user@address` and whether it came from a
  `LAN_HOST_ALIASES` entry or plain LAN DNS), a `Failure:` kind
  (`name-resolution`, `refused`, `auth`, `host-key` or `other`) and a cause line
  for that kind. A refusal lists the three possible causes: sshd off, the
  address now belonging to another machine, or the pod's egress NetworkPolicy
  lacking a TCP 22 rule.

Nothing is restarted, cleaned up, or cancelled on a discovered runner. Runner
layouts differ (k3s docker-mode, launchd on Macs, NixOS units), so these checks
only raise alerts.

**Queue stall.** For each Forgejo repo, the waiting jobs
(`forgejo.listWaitingRunJobs`, admin token) that have no `macos` label and were
first seen more than **30 minutes** ago raise one
`[runner-monitor] Forgejo Actions jobs waiting with no runner` issue. Identical
jobs (same repo, name and label set) are shown once under a per-repo heading with
a count and the longest wait, a tag and a cause number (`— unverified (cause 1)`).
A numbered `**Causes**` section after the repo blocks lists each distinct cause once,
so identical paragraphs are not repeated per job. Every cause starts with a tag. `confirmed:` means the registry
proves it: a matching runner is idle but not picking the job up, a visible matching
runner is busy and none is idle (`confirmed: queue backlog — matching runner busy:
…`), or every matching visible runner is offline (named, with its status).
`unverified:` means Claws cannot know: the registry is unavailable, or no visible
runner advertises the labels (`no runner visible in the org registry advertises …`,
with the caveat that instance-scope runners such as fleet-infra's k3s pods are not
visible). A no-match line ends with a fixed remedy clause: bring up or register a runner
advertising the missing labels (or the full label set when every label exists on some
runner but no single runner has them all), or drop a retired label from the job's
`runs-on`. It is advice worded conditionally ("if none does"), not a diagnosis, and the
group stays `unverified:`. Confirmed and registry-unavailable lines carry no remedy.
Tier labels above what the always-on thinkcentre runner advertises (`ram-<N>g` above 6,
`disk-<N>g` above 40) are served only by fleet-infra's instance-scope `forgejo-runner-nas`
and `forgejo-runner-ryzen` pods, pinned to the nas and ryzen nodes, and `gpu` only by the
ryzen pod (see fleet-infra's
[`docs/runner-labels.md`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/docs/runner-labels.md)).
For a no-match group that needs such a tier, `describeOnDemandHosts` instead names the
serving hosts (nas and ryzen, or ryzen alone for `gpu`) with their org-registry status
(offline, idle/active, or not in the registry) and advises powering one on when they are
offline, or checking the runner pod when a host is online or absent. This replaces the
generic remedy for that group, ends with "keep the tier on the job" (the always-on runner
does not offer it), and never advises dropping the tier from `runs-on`. It stays
`unverified:` and conditional. The thresholds (`ALWAYS_ON_RAM_GB`, `ALWAYS_ON_DISK_GB`)
and host names are in `onDemandNeed` in `src/jobs/runner-monitor.ts`; change them if
fleet-infra resizes the thinkcentre runner or moves the pods.
`queue backlog` is used only with a busy visible runner. When a *running*
job in any monitored repo has the same normalised label set (from one
`forgejo.listActionRunJobs` request per repo), that is only a clause prefixed
`inference, not registry proof:` (an instance-scope runner may serve the labels); it
never makes the wait a "backlog". Visible offline runners are not named for a no-match
group, since none matches every label. The intro counts confirmed and unverified groups, and the issue ends
with a snapshot of the org runner registry and a legend of the two tags. The first-seen time
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

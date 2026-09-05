# host-disk-monitor

**Source**: `src/jobs/host-disk-monitor.ts`
**Trigger**: Interval-based
**Interval**: 10 minutes (configurable via `intervals.hostDiskMonitorMs`)

Watches the disk of the host Claws itself runs on (`openclaw`), runs tiered
cleanup when it gets tight, and escalates to a deduplicated GitHub issue when
cleanup doesn't recover the space. It also carries a tripwire that alerts if a
container runtime appears on what is meant to be a plan-only host.

Unlike [runner-monitor](runner-monitor.md), this job does no SSH: it inspects
and cleans the local filesystem directly, in-process. Claws runs *on* the host
it is monitoring, so a `RunnerHost` entry would mean SSHing to its own LAN
address and switching off every Actions-runner behaviour of that abstraction.

## Why it exists

On 2026-08-07 `openclaw` filled its root filesystem to 100% (#2386). Nothing was
monitoring it, so there was no alert — it was found by hand. The proximate
cause was an agent installing `docker.io` on the box and pulling ~6.9 GB of
container images while working an issue whose repo docs told it to start a
local Supabase stack.

## Disk check

Usage is read from `fs.statfsSync(WORK_DIR)` — the filesystem holding the Claws
work directory, not a hardcoded `/`. Capacity excludes root-reserved blocks so
the percentage matches what `df -h` shows.

Thresholds are tighter than runner-monitor's 85/90:

| Threshold | Value | Behaviour |
|-----------|-------|-----------|
| Warn | 80% | Tier 1 cleanup; escalates to tier 2 in the same tick if tier 1 leaves usage above 80% (max once per 6 h) |
| Critical | 88% | Tier 1 + tier 2 cleanup |

`openclaw`'s steady state sits near 70%, so runner-monitor's 85% tier-1 trigger
would leave almost no headroom before a single dependency install or image pull
blows past it. A CI runner's bursty churn tolerates a later trigger; a host
running long-lived agent sessions does not.

### Tier 1 (>80%)

1. `npm cache clean --force`
2. `rm -rf ~/.npm/_npx` (2.3 G in the incident)
3. `sweepTmp()` — two halves. The first two `find` passes cover the four named
   roots — `/tmp/claude-<uid>`, `/tmp/nix-shell.*`, `/tmp/node-compile-cache`
   and `/tmp/jest_rs`: age files older than 24 h with `-delete`, then prune
   directories left empty by that pass. Measured at 7.4 GB / 334,448 files on
   `openclaw` (#2535). The second two passes are a generic sweep of the rest
   of `/tmp`, rooted at `os.tmpdir()` and scoped to `-uid $(id -u)`, excluding
   the named roots (and hidden/socket paths) with `! -path`: age files older
   than **72 h**, then prune directories left empty and older than 72 h.
   `openclaw` had 23,652 top-level `/tmp` entries on 2026-09-02, of which
   126,657 files / 3.55 GiB outside the four named roots were reclaimable at
   the 72 h cutoff — 24 h reclaimed only 1% more (3.59 GiB), at higher risk of
   deleting a file a session that started yesterday still needs (#2791).
4. `worktree-cleaner` with `staleMs` overridden to **24 hours** instead of the
   configured 7 days. Safe under load: the cleaner snapshots in-use paths from
   `getRunningTasks()`/`getAllPersistedSessions()` before enumerating and skips
   any leaf whose mtime is inside the threshold, so a live agent's tree is never
   touched.
5. `sudo -n journalctl --vacuum-size=200M`
6. `sudo -n apt-get clean`

### Tier 2 (>88%, or >80% when tier 1 fails to recover)

7. `nix-collect-garbage -d` — by far the single biggest win in the incident
   (7.8 GiB across 19,384 store paths).
8. `rm -rf ~/.cache/{puppeteer,Cypress,ms-playwright,ms-playwright-mcp}` —
   ~4.3 G combined, regenerable but slow to re-download, hence tier 2 only.
   `ms-playwright-mcp` (1.3 G on `openclaw`, 2026-09-02) was added in #2791:
   `ms-playwright` does not match it, so the Playwright-MCP browser download
   directory was going untouched.
9. `rm -rf ~/.cache/{uv,gh,pnpm,next-swc,node-gyp,pip,yarn}` (~1.4 G) —
   regenerable tool caches. `yarn` (483 M on `openclaw`, 2026-09-02) was added
   in #2791 — it wasn't in either cache list at all. Deliberately excludes
   `claude-cli-nodejs` and `opencode` (live processes own them), `nix` (its own
   GC is step 7), and `huggingface` (model re-downloads are asymmetrically
   slow, even though the cache itself is small today).

Every step is independently try/caught: a host without apt, or without
passwordless sudo, simply skips those steps.

### Gotchas encoded in the cleanup set

- **No `docker` or `podman` command appears anywhere in this job**, cleanup or
  otherwise. Docker is deliberately absent from this host; a cleanup path that
  shells out to it would normalise its presence. The only mentions are
  `/var/lib/{docker,containerd}` path strings, the tripwire's PATH probe, and
  alert-body prose.
- **`nix-collect-garbage` must be found by absolute path.** It lives in the
  single-user Nix profile (`~/.nix-profile/bin/`), which is on neither the
  systemd unit's `PATH` nor `enrichedPath`'s `EXTRA_BIN_DIRS`. Invoking it by
  bare name fails with `command not found` and the biggest win silently never
  happens. The job tries `~/.nix-profile/bin/nix-collect-garbage` then
  `/nix/var/nix/profiles/default/bin/nix-collect-garbage` before falling back to
  the bare name.
- **It is not run under `sudo`.** The store here is a single-user install owned
  by the same account Claws runs as. It is also safe against in-flight work —
  live `nix develop` shells hold auto GC roots under
  `/nix/var/nix/gcroots/auto`.
- **`sudo` is always `sudo -n`.** Without `-n`, sudo can block indefinitely on a
  password prompt with no TTY attached.
- **`npm cache clean` can fail a concurrently running `npm install`.** Accepted:
  the cache is regenerable, and this only runs above 80%.
- Every subprocess has an explicit timeout (300 s for npm, 900 s for the nix GC,
  120 s otherwise) since cleanup runs in the Claws event loop. The nix GC also
  gets a 64 MiB `maxBuffer` — 19,384 deleted store paths, one line each, overrun
  the default and would report a success as a failure.
- The `du -sh` breakdown list is hand-maintained and, after #2435, also covers
  `~/.local`, `~/.claude`, `~/.platformio`, `~/.rustup`, `/usr` and `/snap`.
  Before #2435 the list accounted for only ~24 G of 49 G used, which made the
  alert body read as if nothing was wrong. `/snap` (6.4 G) and `/usr` (6.8 G)
  are surfaced for human diagnosis only — the job never touches them; snap
  retention is host config (`snap set system refresh.retain=2`), not something
  Claws should automate.
- **`sweepTmp()` ages files, not directories.** A session directory's own
  mtime freezes once its `tasks/` subdirectory is created, so a
  directory-level staleness gate would delete a live long-running agent's
  scratch. Ageing individual files keeps anything still being written alive
  regardless of how old its parent directory looks.
- **`-mindepth 1` means `find` never deletes a start point.** A live-but-idle
  `nix develop` shell's `$TMPDIR` still exists after the sweep even if every
  file inside it was removed — the shell recreates what it needs, and a
  missing start point would make a later `mkdtemp` there fail with `ENOENT`.
- **`-delete` implies `-depth`**, which is what collapses nested empty
  directories — e.g. 1,730 empty cwd-slug directories under a stale
  `claude-<uid>` root — bottom-up in a single `find` invocation, with no
  second pass or loop needed.
- **Roots are matched as `/^claude-\d+$/`, not a `claude-` prefix.**
  `/tmp/claude-shell-snapshot-*` files are sourced by every Bash call of a
  live session and must never be swept.
- A naive `find /tmp -maxdepth 1 -mtime +7` frees only ~448 M of the 11 G
  measured on `openclaw`, because all four large trees have fresh top-level
  mtimes — the directories are touched continuously even as their old
  contents go stale. `systemd-tmpfiles-clean.timer`'s `D /tmp 1777 root root
  30d` is also far too lax for the ~1.4 G/day this host was accumulating.
- **The generic `/tmp` passes never use `-prune`.** `-delete` implies
  `-depth`, and GNU find documents that `-prune` has no effect under `-depth`
  — a `-prune`-based version of the exclusion list would silently descend
  into and delete files inside the protected roots. The `! -path` negative
  tests are load-bearing precisely because they survive `-depth`; `*` in
  `-path` spans `/`, so `! -path '/tmp/claude-*'` excludes the whole subtree.
  The accepted cost is that `find` still walks (stats) the excluded subtrees
  without deleting inside them — a walk passes 1–2 already do, on a job that
  only reaches this code path above 80%.
- **The generic sweep is rooted at `os.tmpdir()`, not a `readdirSync`-built
  start-point list.** `/tmp` held 23,652 top-level entries on `openclaw`
  (2026-09-02); passing that many as argv start points risks `E2BIG`.
- **The generic empty-directory pass keeps a `-mmin` age gate that the
  root-scoped pass 2 doesn't need.** Pass 2 is confined to the four named
  roots, which are never used for `mkdtemp`-style scratch outside of Claude's
  own management. The generic pass sees all of `/tmp`, where a freshly
  `mkdtemp`-ed empty directory can be seconds old and about to be written to
  by an unrelated process — an ageless `-empty -delete` there would race live
  work. The consequence is accepted: a directory emptied by the generic file
  pass has a fresh parent mtime and is only pruned on a later tick; at 4 KB
  each that's noise.

## Escalation

On 2026-08-12 (#2435) `openclaw` sat at 82% with `/nix` at 6.3 G and browser
caches at 3.5 G, while every tier-1 target combined was ~230 MB — under 0.4% of
a 60 G filesystem. Tier 1 alone could never clear the warn band, so `post` came
back equal to `usage` every 10-minute cycle, and the job refreshed the same
issue over and over: 8 occurrences and climbing, with no automated remedy ever
attempted.

The fix: when tier 1 leaves usage above 80%, tier 2 escalates **in the same
tick**, rate-limited to once per 6 hours (`TIER2_COOLDOWN_MS`). Above 88%,
tier 2 always runs regardless of the cooldown — that path is unchanged and
ignores rate-limiting entirely, since it's an emergency.

After cleanup, usage is re-read:

- Back at or under 80% → log recovery and close the alert issue via
  `closeAlertIssueIfResolved`.
- Reduced, but still between 80% and 88%, and tier 2 actually ran → log only,
  no issue.
- Tier 2 was suppressed by its cooldown and usage is still at or under 88% →
  log only, no issue. **No issue is filed from the warn band until tier 2 has
  actually run** — an alert whose only fix is a tier the job declined to run
  isn't actionable, and this is exactly the 10-minute refresh loop being cut.
- Unreadable, still above 88%, or tier 2 ran and didn't recover it → file/update
  `[host-disk-monitor] Persistent high disk on <hostname>` via
  `ensureAlertIssue` with `refreshBody: true` (the body describes current
  state), labelled `runner-maintenance`. Slack is notified only on first
  creation; subsequent cycles update the same issue's occurrence tracking.

The 6-hour cooldown exists so a genuinely stuck warn band doesn't run a full
nix GC every 10 minutes inside the Claws event loop. The deliberate
consequence: during the cooldown the issue body stops refreshing (its
"Last seen" timestamp lags), but a stuck warn band still files or refreshes at
least once every 6 hours — tier 2 runs at least that often, and when it runs
and still fails to recover, the issue is filed exactly as before — and it still
auto-closes the moment usage drops to 80% or below.

The issue body includes a best-effort breakdown: `df -h` plus `du -sh` for
`~/.claws/worktrees`, `~/.claws/repos`, `~/.cache`, `~/.npm`, `~/.nvm`,
`~/.local`, `~/.claude`, `~/.platformio`, `~/.rustup` and (under `sudo -n`)
`/nix`, `/var/log`, `/var/lib/docker`, `/var/lib/containerd`, `/tmp`,
`/var/cache`, `/usr`, `/snap`, plus a top-10 `du -sh /tmp/*` probe so the
alert body says which part of `/tmp` is large, and (#2791) a top-10
`du -sh ~/.cache/*` probe — added after `ms-playwright-mcp` sat at 1.3 G
inside `~/.cache` with no line in the alert body pointing at it.

## Container-runtime tripwire

Runs every cycle regardless of disk usage. Evidence is gathered with `fs` only —
no subprocess:

- a `docker` or `podman` binary on the enriched `PATH`
- `/var/lib/docker` or `/var/lib/containerd` existing

Any evidence files/updates
`[host-disk-monitor] Container runtime present on plan-only host <hostname>`
with the same `ensureAlertIssue` semantics; no evidence closes it.

Deliberately **not** keyed on network interfaces: `docker0` and `br-*` bridges
survive a full Docker purge until reboot and are present on this host right now
with no Docker installed, so an interface check false-positives forever.

Known benign case: an empty leftover `/var/lib/docker` directory trips it. The
`du` line in the body shows `4.0K`, and the issue auto-closes on the next cycle
once the directory is removed.

This is a tripwire, not a control — it closes the loop fast, it does not
prevent an install. Durable prevention is APT pinning of the container-runtime
package names (`docker.io`, `docker-ce*`, `containerd*`, `runc`, `podman`,
`docker-compose*`) to `Pin-Priority: -1`. Name-based prevention by removal alone
is fragile: the May 2026 purge targeted `docker-ce*` and the August reinstall
used `docker.io`, sidestepping it entirely. That pinning is host configuration
and belongs in `nixos-config`, not in this repo.

## Failure isolation

The disk check and the tripwire are wrapped separately, so a failure in either
cannot stop the other, and `run()` never rejects.

If the Claws process itself is dead, nothing checks the disk. That is equally
true of `runner-monitor`, which runs in the same process.

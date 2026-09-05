# Postmortem: Node 24 release on a Node 22 host — failed deploy, failed rollback, ~23h outage

- **Date:** 2026-07-18
- **Author:** Claude Code session, with the operator
- **Status:** draft
- **Severity:** Full outage of all Claws automation (polling, PR review, CI fixing, issue work) for ~23 hours. No data loss.
- **Incident issue:** none — the incident was raised via the deploy script's Slack alerts and an operator report; this postmortem's PR serves as the record.

## Summary

PR [#2046](https://github.com/St-John-Software/claws/pull/2046) moved the release build from Node 22 to Node 24, so release tarballs began shipping `node_modules` with native modules (`better-sqlite3`) compiled for Node 24, while the deployment host still ran Node 22. Deploys of `v2026-07-18.3` and `.4` failed their health checks, and the rollback — which restores `dist` but not `node_modules` — also failed, leaving the service crash-looping on `ERR_DLOPEN_FAILED` for ~23 hours. Resolved by upgrading the host to Node 24 (matching the release pipeline's intentional move to the current LTS), clearing the skip list, and re-running the updater, which deployed `v2026-07-18.4` cleanly.

## Impact

- All Claws jobs stopped for ~23h 9m (2026-07-18 11:05 UTC → 2026-07-19 10:14 UTC): no repo polling, PR reviews, CI fixes, issue implementation, or alerting across all managed repositories.
- systemd restarted the failed service ~14,300 times (5s backoff loop); no persistent-state damage — the SQLite DB and `~/.claws/` config were untouched.
- Two good releases (`v2026-07-18.3`, `.4`) were skip-listed even though the builds themselves were fine; the incompatibility was on the host.

## Timeline

All times UTC, 2026-07-18 unless noted. (Journal timestamps below were logged in BST = UTC+1 and are converted here.)

| Time (UTC) | Event | Source |
| --- | --- | --- |
| 10:06:08 | Release `v2026-07-18.2` created — the last build on Node 22 | `gh release view v2026-07-18.2 --json createdAt` |
| 10:41:40 | PR #2046 merged: Dependabot's Docker bump to Node 26 retargeted to Node 24 LTS, with `ci.yml` and `release.yml` aligned to 24 in the same PR. The automated PR review had flagged that the tarball deploy would diverge from the host "if that host's Node version isn't bumped in lockstep" | `gh pr view 2046 --comments` |
| 10:41:39–11:04:34 | Release `v2026-07-18.3` built and published — first tarball whose native modules require NODE_MODULE_VERSION 137 (Node 24) | `gh release view v2026-07-18.3` |
| 10:43:45 | Host auto-deployed `v2026-07-18.2` successfully (defect not yet live — this tarball was still a Node 22 build) | `journalctl -u claws-updater` |
| 11:05:17 | Updater began deploying `v2026-07-18.3` — defect became live | `journalctl -u claws-updater` |
| 11:05:22 | Service stopped for the file swap — **outage begins** | `journalctl -u claws-updater` |
| 11:06:16 | Post-deploy health check failed (first symptom); rollback started, restoring `dist` only | `journalctl -u claws-updater` |
| 11:06:47 | Rollback health check also failed; Slack alert "rollback also failed, manual intervention required"; `v2026-07-18.3` skip-listed — **detected** | `journalctl -u claws-updater` |
| 11:21:18 | Release `v2026-07-18.4` published | `gh release view v2026-07-18.4` |
| 11:22:10–11:23:31 | Identical failure sequence for `v2026-07-18.4`; second Slack alert; skip-listed | `journalctl -u claws-updater` |
| 11:23:31 onward | Service crash-loops: `better-sqlite3` compiled for NODE_MODULE_VERSION 137, host Node 22 requires 127 (`ERR_DLOPEN_FAILED`); updater logs only `Skipping <tag> (previously rolled back)` each minute | `journalctl -u claws` |
| 2026-07-19 ~10:08 | Operator reported the failed update/rollback in a Claude Code session; investigation began | session transcript |
| 2026-07-19 ~10:11 | Root cause identified; host NodeSource apt repo switched `node_22.x` → `node_24.x`; nodejs 24.18.0 installed | session transcript / `apt-cache policy nodejs` |
| 2026-07-19 10:12:39 | Skip list cleared; updater triggered — **mitigation begins** | `journalctl -u claws-updater` |
| 2026-07-19 10:14:14 | `v2026-07-18.4` deployed, health check passed — **outage ends** | `journalctl -u claws-updater` |

## Metrics

- **Time to detect:** 1m 25s (11:05:22 outage start → 11:06:47 Slack "manual intervention required")
- **Time to mitigate:** 23h 7m — no interim mitigation existed; the first corrective action (host Node upgrade + updater re-run) was also the resolution
- **Time to resolve:** 23h 8m 52s (2026-07-18 11:05:22 → 2026-07-19 10:14:14)

## Contributing factors

1. **The release build's Node version and the host's Node version are provisioned independently, with no mechanism linking them.** Release tarballs ship prebuilt `node_modules` including native modules compiled against whatever `node-version` `release.yml` pins, while the host's runtime comes from a NodeSource apt repo configured at install time. A one-line workflow change could (and did) silently invalidate every future release for the existing host, and nothing in the repo could observe or correct the host side.

2. **The rollback path was asymmetric: it backed up and restored `dist` but not `node_modules`.** The deploy swaps both directories, so when the incompatibility was in `node_modules`, restoring the old `dist` against the new `node_modules` still crashed. The rollback design implicitly assumed `node_modules` changes are always backward-compatible — true for pure-JS dependency bumps, false the first time the native-module ABI changed.

3. **The relevant risk was identified before merge but had nowhere actionable to land.** The automated PR review on #2046 explicitly warned that the tarball deployment would diverge from the host if the host's Node wasn't bumped in lockstep. The repo-side inconsistency it flagged (CI/release on 22, Docker on 26) was properly fixed in the same PR by aligning everything on 24 — but the host is outside the repo, so the "bump the host in lockstep" half of the warning had no corresponding diff, check, or checklist item, and the information evaporated at merge time.

4. **After the failed rollback, the system settled into a silent degraded steady-state.** The skip list correctly stopped the updater from re-attempting the bad releases, but from then on each 60-second timer tick logged only "Skipping … (previously rolled back)" while systemd crash-looped the service indefinitely. One Slack message per bad release was the entire escalation; Claws's own `log.error` → Slack pathway could not fire because Claws itself was what was down.

5. **The deploy verifies health only after destructively swapping files.** The health check works (it caught both bad deploys within 45s), but by the time it runs, the old service has already been stopped and its files replaced. There was no pre-swap compatibility check that could have concluded "this tarball cannot run on this host" while the old version was still running.

## Detection ladder

| Rung | Would it have caught this? | Why / why not | Change that would make it catch this |
| --- | --- | --- | --- |
| 1. Design / issue refinement | No | This was a Dependabot dependency bump — there was no design or refinement phase. The failure mode (host runtime out of lockstep with build runtime) is foreseeable in principle, but only with a documented invariant about runtime-major bumps, which didn't exist | Document in CLAUDE.md/OVERVIEW.md that a Node major bump in `release.yml` requires a host upgrade first — makes the invariant visible to future reviews (subsumed by the rung-5 fix, which enforces it mechanically) |
| 2. Human PR review | Partially — the automated review saw it, but the host isn't in the diff | No human review was recorded on #2046. The automated Claws reviewer did flag the host-divergence risk explicitly. However, the host's actual Node version is state outside the repo — classic config drift, invisible in any diff — so a reviewer could at best raise the same caveat, not verify it | None realistic at this rung — host state can't be reviewed in a diff; enforce at deploy time instead |
| 3. Automated pre-merge checks | No — and the guarding checks that did run all passed honestly | CI (`build`) ran and passed under Node 24; after the in-PR fix, repo-side versions (Dockerfile, ci.yml, release.yml) were mutually consistent. No pre-merge check can see the host's installed Node version, so there was no check that was silently filtered out — the blind spot is structural | A consistency check pinning all repo-side Node versions to one source of truth (e.g. `.node-version`) helps hygiene, but cannot close this gap pre-merge; the enforcement point is rung 5 |
| 4. Merge gate | No | The one required-status-relevant check (`build`) passed. A merge gate composed of pre-merge signals inherits rung 3's blindness to host state | None at this rung |
| 5. Deploy-time verification | **Yes — this is where it should have been caught** | `deploy.sh` had the new tarball extracted in staging *and* shell access to the host's `node --version` before stopping the service — everything needed to detect the ABI mismatch pre-swap. It didn't compare them; the first verification was the post-swap health check, after the point of no (working) return | Embed the build's Node major in the tarball and have `deploy.sh` refuse to swap on mismatch, alerting instead — [#2054](https://github.com/St-John-Software/claws/issues/2054) |
| 6. Runtime monitoring / alerting | Partially — detected in 85s, then went quiet for 23h | The health-check + Slack alert worked exactly as designed and named the problem ("manual intervention required"). But it fired once per bad release; there was no repeat or escalation while the service stayed down, and Claws's internal alerting was itself down | Updater-tick re-alerting while the service is unhealthy — [#2056](https://github.com/St-John-Software/claws/issues/2056) |
| 7. User report | Yes — this is what actually drove resolution | The operator opened an investigation session ~23h after the alerts. All prior rungs either couldn't see the problem or alerted once without escalation | n/a if rungs 5–6 land; this rung remains the backstop |

**Shift-left target:** Rung 5 — deploy-time verification. A pre-swap Node-ABI check would have converted this incident into a zero-downtime "deploy refused, host upgrade needed" alert while `v2026-07-18.2` kept running.

## What went well

- The post-deploy health check caught both bad deploys within 45 seconds, and the skip list correctly prevented an infinite deploy/rollback thrash loop.
- The Slack alerts fired promptly and said precisely the right thing ("rollback also failed, manual intervention required").
- The automated PR review on #2046 had already articulated the exact failure mode, which made root-cause diagnosis during recovery very fast (crash log → known suspect → confirmed in minutes).
- Recovery was clean and simple: switch the NodeSource repo, install Node 24, clear the skip list, re-run the updater. No data loss, no manual file surgery, and the previously-skipped release deployed unmodified.
- The PR-review process had also steered the bump from non-LTS Node 26 to LTS Node 24, so the host upgrade during recovery landed on a supported LTS line.

## Action items

| # | Action | Class (prevent/detect/mitigate) | Issue | Status |
| --- | --- | --- | --- | --- |
| 1 | `release.yml` embeds the build's Node major in the tarball; `deploy.sh` verifies it against the host's `node --version` before stopping the service, refusing + alerting on mismatch | prevent | [#2054](https://github.com/St-John-Software/claws/issues/2054) | open |
| 2 | `deploy.sh` backs up and restores `node_modules` alongside `dist` on rollback, so rollback works when the breakage is in dependencies | mitigate | [#2055](https://github.com/St-John-Software/claws/issues/2055) | open |
| 3 | Updater re-alerts (rate-limited) on each timer tick while the service remains unhealthy after a failed rollback, instead of one Slack message then silence | detect | [#2056](https://github.com/St-John-Software/claws/issues/2056) | open |

## Considered and rejected

| Action | Why not |
| --- | --- |
| External uptime monitoring for the Claws host (third-party pinger, watchdog service) | The 60s updater timer already survives Claws being down and is the natural re-alert channel (#2056). Adding external infrastructure for a failure mode #2054 prevents and #2056 escalates would be premature. |
| Automatically upgrading the host's Node when a release requires a newer one | Unattended major-version runtime upgrades from a deploy script are riskier than the failure they prevent; refusing the deploy and alerting (#2054) keeps a human in the loop for exactly the rare, consequential change. |
| Constraining Dependabot to LTS-only Node majors | Already effectively handled — the PR review process retargeted 26→24 in-PR, and the failure was host lockstep, not the LTS choice. |
| Single `.node-version` source of truth consumed by Dockerfile, CI, and release workflows | Nice hygiene but doesn't close the gap: all repo-side versions were already mutually consistent post-#2046; the divergence was repo↔host. Fold into #2054 if convenient. |

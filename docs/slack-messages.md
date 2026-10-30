# Slack messages

**Reference.** Every message Claws can send to Slack: what triggers it, whether the
operator must act, and whether it stays in Slack. Read this before adding a
`slack.notify` / `notifyProdAlert` call. The policy is in
[product/operations-and-safety.md](product/operations-and-safety.md#reserve-slack-for-operator-attention):
Slack is for getting the operator's attention, the dashboard's `/alerts` page is the
complete record of open alerts.

A message kept in Slack must name the action expected of the operator and be sent once
per alert (or per episode), not on every recurrence. Everything else goes to the logs,
the issue itself and `/alerts`.

Reviewed for #clw_01M5YPSK289NXAK8E6K6RNTFS5 (2026-10-27).

## Kept in Slack

| Message | Source | Trigger | Operator action named | Once per |
|---|---|---|---|---|
| `[claws-error] agent-auth-expired-…` needs you | `src/error-reporter.ts` | An agent CLI's credentials expire and the `[claws-error]` alert issue is first filed | Re-authenticate the CLI at `/reauth` (the `reauthInstruction` text), with the issue link | Alert issue (created outcome) |
| `[claws-error] agent-model-unsupported-…` needs you | `src/error-reporter.ts` | The provider rejects the configured model ID and the alert is first filed | Change `codexDefaultModel` / `codexLightModel` / `codexCheapModel` on the config page | Alert issue |
| `[claws-error] …` external kill needs you | `src/error-reporter.ts` | The CLI process is killed from outside Claws (OOMKill, drain) and the alert is first filed | Check the Claws pod for OOMKilled or eviction events | Alert issue |
| `[claude-accounts]` Claude account's credentials have expired | `src/claude.ts` | One Claude account's auth fails while the run carries on on another account or provider | Re-authenticate that account at `/reauth` | Auth episode (not the hourly re-alert) |
| `[alert] … needs a human` | `src/issue-handback.ts` (`parkForHuman`, `blockAlertForHuman`) | An alert issue's automatic fix is parked in Blocked by Claws (failed or stalled implementation, no-commit circuit breaker, unmanaged step, ambiguous coverage, the planner's `blocked` verdict, an alert inbox with an untrackable section, …) | Read the reason and unblock or close the issue, with the issue link | Blocked stay (`claws_issues.alert_attention_notified_at`, cleared when the issue leaves Blocked) |
| `[alert] …: plan needs your review` | `src/agents/issue-refiner.ts` | The planner's step-back says `reconsider` and withdraws an alert issue's Plan pre-approval | Review the plan and approve it through Plan | Withdrawn approval |
| `[escalation-reviewer] … needs a human` | `src/agents/escalation-reviewer.ts` | The escalation reviewer holds an escalated issue instead of approving it | Review and approve or close it | Escalation verdict |
| `[auto-merger] Merged … — manual action required` | `src/agents/auto-merger.ts` | A merged PR declares a post-merge manual action that is not verification-only | Carry out the named action | Merged PR |
| `[auto-merger]` every PR has merged — operator step N remains | `src/agents/auto-merger.ts` | Every PR of a plan merged but its manual operator step is open; the issue is parked in Blocked | Do the step, then comment `claws-phase-done: N` and move the issue out of Blocked, or close it | Operator step (awaiting-operator marker) |
| `` `workflow` FAILED on main `` (prod alert channel) | `src/jobs/main-build-monitor.ts` (`notifyProdAlert`) | A workflow listed in `prodAlertWorkflows` fails on the default branch | Investigate now (prod-down class), with the run link | Failed run |
| Claws ignored … — author is not a trusted actor | `src/jobs/issue-dispatcher.ts` | An issue by a login outside `allowedActors` is skipped and its `[disallowed-actor]` alert is first filed | Add the login to `allowedActors` if a person, otherwise leave it blocked | Actor (alert issue) |
| Prompt injection detected … | `src/prompt-guard.ts` | Any guarded fetched content (repo item, CI log, email, attachment) scores as a prompt injection, the judge confirms a directive (or cannot answer), and the `[prompt-injection]` alert issue is first filed, under the repo or under the Claws repo for unmanaged and repo-less contexts | Review the item before trusting its author | Alert issue (created outcome) |
| `[whatsapp] Not paired — scan this QR …` | `src/whatsapp.ts` | WhatsApp needs pairing and nobody is on the pairing page | Scan the QR or pair at `/whatsapp` | QR cooldown |
| `[whatsapp] Pairing required: …` | `src/whatsapp.ts` | The session is logged out or stale | Pair at `/whatsapp` | Pairing episode |
| `[whatsapp]` still unpaired / auth cleared N times — no longer retrying | `src/whatsapp.ts` | Unattended QR regeneration or re-auth gives up | Pair at `/whatsapp` | Give-up |
| `[whatsapp] Disconnected — 5 consecutive reconnect failures` | `src/whatsapp.ts` | Five reconnects in a row fail with auth preserved | If it persists, unpair and re-pair at `/whatsapp` | Failure streak |
| `[ERROR]` fatal startup error | `src/log.ts` (`errorAndFlush`), called by `src/main-controller.ts` | The controller exits at startup (another instance holds the PID lock, the lock cannot be written) | Stop the other instance or remove the stale PID file; check the work directory is writable | Process start |

## Dashboard only

These alerts are still filed as issues and listed on `/alerts`; they post nothing to
Slack while Claws handles them. If one stalls, the `[alert] … needs a human` line above
fires for it.

| Message (before) | Source | Trigger | Why not Slack |
|---|---|---|---|
| `[ERROR]` every `log.error` line, including `[claws-error]` filings | `src/log.ts` (`error`) | Any logged error | An alert issue auto-promotes, is planned and fixed without the operator; `/alerts`, `/logs` and job logs hold it |
| `host-disk-monitor: disk … filed issue` / container runtime found | `src/jobs/host-disk-monitor.ts` | Host disk stays high after cleanup / container runtime on a plan-only host | The alert issue is on `/alerts` and handled automatically |
| `Runner monitor: …` action summary | `src/jobs/runner-monitor.ts` | The runner monitor restarted a service, cleaned a disk or filed an issue | Routine remediation; any issue it filed is on `/alerts`; the summary stays in the logs |
| `[disallowed-actor]` repeat blocked items | `src/jobs/issue-dispatcher.ts` | Another item by an actor that already has an open alert | The alert's occurrence count records it |

## Dropped

| Message (before) | Source | Trigger | Why dropped |
|---|---|---|---|
| `[dashboard] Job "…" paused/resumed`, cooldown cleared, activation flipped, job toggles, unknown keys removed, config updated, WhatsApp paired/unpaired | `src/server.ts` | The operator's own dashboard action | Echoes the operator's own action; the `notifyDashboardActions` option is removed |
| `[INFO] … authentication recovered` | `src/agent-auth-state.ts` | A run succeeds after an auth latch | Routine recovery; the dashboard shows the state |
| `[INFO] Codex CLI re-authenticated — cleared the cooldown` / `[INFO] Claude account … re-authenticated` | `src/codex-auth.ts`, `src/claude-auth.ts` | The operator re-authenticated on `/reauth` | Echoes the operator's own action |
| `[whatsapp] Pairing complete — WhatsApp connected` | `src/whatsapp.ts` | The connection opens after pairing was required | Routine recovery; the dashboard shows the state |
| `[whatsapp] Reconnected — auth state was preserved` | `src/whatsapp.ts` | The connection returns after the disconnect alert | Routine recovery |
| `[backlog] … is back from the Backlog` | `src/backlog-until.ts` | A Backlog issue's return date passes | The issue comment and its board column carry it |
| `smart-scheduler escape valve fired` | `src/smart-schedule.ts` | SLO-breached repos are forced through while Claws is busy | Informational; logged as `scheduling_slo_override` |

Logged errors that file no issue (IMAP, session persistence, blog push, …) are not alerts:
they stay in `/logs` and the job logs. If one needs the operator, route it through
`reportError` so it becomes an alert issue, or add a `slack.notify` naming the action and
a row above.

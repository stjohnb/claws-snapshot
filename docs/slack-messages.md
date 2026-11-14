# Slack messages

**Reference.** Every message Claws can send to Slack: what triggers it, whether it stays
in Slack, and where the dashboard shows it otherwise. Read this before adding a
`slack.notify` / `notifyProdAlert` call. The policy is in
[product/operations-and-safety.md](product/operations-and-safety.md#reserve-slack-for-urgent-attention).

**The urgency rule.** Slack is for urgent attention only: Claws, production or the
operator's path to Claws is broken or at risk now, and waiting for the operator's next
dashboard visit would make it worse. Work that merely waits on the operator — a manual
step, a plan to review, an issue parked for a human — is shown on the dashboard, which
is where the operator goes to do it. The dashboard's `/alerts` page is the complete
record of open alerts.

A message kept in Slack must name the action expected of the operator and be sent once
per alert or per episode, not on every recurrence. Everything else goes to the logs,
the issue or PR itself, the board and `/alerts`.

Reviewed for #clw_01M6GWYR04FZRE5AK80P8TW02C (2026-11-03).

## Kept in Slack

| Message | Source | Trigger | Operator action named | Once per |
|---|---|---|---|---|
| `[claws-error] agent-auth-expired-…` needs you | `src/error-reporter.ts` | An agent CLI's credentials expire and a run fails for want of any working account | Re-authenticate the CLI at `/reauth` (the `reauthInstruction` text), with the issue link | Auth episode |
| `[claws-error] agent-model-unsupported-…` needs you | `src/error-reporter.ts` | The provider rejects the configured model ID | Change `codexDefaultModel` / `codexLightModel` / `codexCheapModel` on the config page | Alert cooldown window |
| `` `workflow` FAILED on main `` (prod alert channel) | `src/jobs/main-build-monitor.ts` (`notifyProdAlert`) | A workflow listed in `prodAlertWorkflows` fails on the default branch | Investigate now (prod-down class), with the run link | Failed run |
| `[ERROR]` fatal startup error | `src/log.ts` (`errorAndFlush`), called by `src/main-controller.ts` | The controller exits at startup (another instance holds the PID lock, the lock cannot be written) | Stop the other instance or remove the stale PID file; check the work directory is writable | Process start |
| Prompt injection detected … | `src/prompt-guard.ts` | Guarded fetched content (repo item, CI log, email, attachment) scores as a prompt injection, the judge confirms a directive (or cannot answer), and the `[prompt-injection]` alert issue is first filed | Review the item before trusting its author | Alert issue (created outcome) |
| `[whatsapp]` not paired / pairing required / no longer retrying / disconnected | `src/whatsapp.ts` | WhatsApp needs pairing (QR, logged out, stale session), gives up unattended re-auth or QR regeneration, or fails five reconnects in a row | Pair (or unpair and re-pair) at `/whatsapp` | Unpaired or disconnected episode: the first of these messages posts, later ones are logged; the episode ends when the connection opens, on `stop()` and when pairing starts |

The OpenCode spend warning (`src/opencode-spend.ts`, "OpenCode Anthropic API spend … has
passed the … warning threshold") also posts, once per threshold value the operator sets,
as a budget guard; it predates this review and was left as it is.

## Dashboard only

These post nothing to Slack. The issue comment, PR comment, Blocked state and `/alerts`
entry each one had are unchanged; the cue column says where the dashboard shows it.

| Message (before) | Source | Trigger | Dashboard cue |
|---|---|---|---|
| `[auto-merger] Merged … — manual action required` | `src/agents/auto-merger.ts` | A merged PR declares a post-merge manual action that is not verification-only or a standing note | `/prs` "Merged — manual action pending" section, the ⚠ badge on the issue page's Pull requests table, the nav PRs count and the Blocked chip, until cleared |
| `[auto-merger]` operator step N is ready | `src/awaiting-operator.ts` | Every step a plan's manual operator step follows has landed; the issue is parked in Blocked | Blocked column and Board count, with "Operator step N is ready: …" as the reason |
| `[alert] … needs a human` | `src/issue-handback.ts` (`parkForHuman`), `src/agents/issue-refiner.ts` (planner `blocked` verdict) | An alert issue's automatic fix is parked in Blocked | Blocked column and Board count, with the reason |
| `[alert] …: plan needs your review` | `src/agents/issue-refiner.ts` | The planner's step-back says `reconsider` and withdraws an alert issue's Plan pre-approval | Awaiting plan review column |
| `[escalation-reviewer] … needs a human` | `src/agents/escalation-reviewer.ts` | The escalation reviewer holds an escalated issue instead of approving it | Awaiting plan review column, with the verdict comment |
| `[claude-accounts]` Claude account's credentials have expired | `src/claude.ts` | One Claude account's auth fails while the run carries on on another account or provider | `/reauth` shows the account "Auth expired"; a run with no account left posts the kept `agent-auth-expired` line |
| `[claws-error] …` external kill needs you | `src/error-reporter.ts` | The CLI process is killed from outside Claws (OOMKill, drain) | `/alerts` |
| Claws ignored … — author is not a trusted actor | `src/jobs/issue-dispatcher.ts` | An issue by a login outside `allowedActors` is skipped and its `[disallowed-actor]` alert is filed | `/alerts`; repeat items bump the alert's occurrence count |
| `[ERROR]` every `log.error` line, including `[claws-error]` filings | `src/log.ts` (`error`) | Any logged error | `/alerts`, `/logs` and job logs; an alert issue auto-promotes and is planned and fixed without the operator |
| `host-disk-monitor: disk … filed issue` / container runtime found | `src/jobs/host-disk-monitor.ts` | Host disk stays high after cleanup / container runtime on a plan-only host | `/alerts`; handled automatically |
| `Runner monitor: …` action summary | `src/jobs/runner-monitor.ts` | The runner monitor restarted a service, cleaned a disk or filed an issue | `/alerts` for any issue it filed; the summary stays in the logs |

## Dropped

| Message (before) | Source | Trigger | Why dropped |
|---|---|---|---|
| `[dashboard] Job "…" paused/resumed`, cooldown cleared, activation flipped, job toggles, unknown keys removed, config updated, WhatsApp paired/unpaired | `src/server.ts` | The operator's own dashboard action | Echoes the operator's own action; the `notifyDashboardActions` option is removed |
| `[INFO] … authentication recovered` | `src/agent-auth-state.ts` | A run succeeds after an auth latch | Routine recovery; the dashboard shows the state |
| `[INFO] Codex CLI re-authenticated — cleared the cooldown` / `[INFO] Claude account … re-authenticated` | `src/codex-auth.ts`, `src/claude-auth.ts` | The operator re-authenticated on `/reauth` | Echoes the operator's own action |
| `[whatsapp] Pairing complete — WhatsApp connected` | `src/whatsapp.ts` | The connection opens after pairing was required | Routine recovery; the dashboard shows the state |
| `[whatsapp] Reconnected — auth state was preserved` | `src/whatsapp.ts` | The connection returns after the disconnect alert | Routine recovery |
| `[whatsapp]` second and later messages of an episode | `src/whatsapp.ts` | Another QR, pairing-required, give-up or failure-streak message in an episode that already posted | The first message already asked for the pairing; later ones are logged |
| `[backlog] … is back from the Backlog` | `src/backlog-until.ts` | A Backlog issue's return date passes | The issue comment and its board column carry it |
| `smart-scheduler escape valve fired` | `src/smart-schedule.ts` | SLO-breached repos are forced through while Claws is busy | Informational; logged as `scheduling_slo_override` |

Logged errors that file no issue (IMAP, session persistence, blog push, …) are not alerts:
they stay in `/logs` and the job logs. If one is urgent under the rule above, route it
through `reportError` so it becomes an alert issue and add a `slack.notify` naming the
action and a row to the Kept table; otherwise give it a dashboard cue.

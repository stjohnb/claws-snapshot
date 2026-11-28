# Operations and safety

**Reference.** Read this when changing deployment, monitoring, alerts, credentials,
database operations, or runner handling. Read [automation lifecycle](automation-lifecycle.md)
instead for ordinary issue and pull-request flow.

## Problem

Claws operates automation infrastructure that can fail noisily, lose state, consume
limited resources, or expose credentials unless its safeguards are explicit.

## Users

Operators need alerts that name an action, safe rollout behaviour, and confidence that
routine automation will neither conceal a failure nor leak a secret.

## Requirements

### Surface recurring failures as one current alert

Recurring alerts must update a single current issue and close it on recovery rather
than emitting a stream of duplicate issues or comments.
A cluster alert issue covers one alert group (`<service> / <alert>`, or a bare alert name): each
firing group routes to the one open issue holding its exact key, or files its own issue at once with
the alert's evidence. There is no alert inbox and no triage step.
An issue may hold several keys: when two alert issues are found to share one root cause and fix,
closing one as a duplicate of the other moves its keys and occurrence counts to the survivor, so
later firings of either group count there.
An alert issue names the managed repo owning its service, from the bridge repo's committed
service map, as well as the bridge repo, which stays its primary repo.
A closed alert issue is never reopened by a new firing: a new instance files a new issue that names
the previous one, and a re-notification of an instance that was already firing when the issue
closed is only counted on the closed issue.
A burst of new alert groups files at most a few issues per poll; the rest wait for the next poll.
An alert issue with a plan, a Plan approval, an open PR or a queued or running planner is held open with a "resolved for now"
note when the alert clears, keeps taking occurrences if it fires again, and closes through its
lifecycle rather than the alert-clear path.
A build failure that recurs after its issue was closed as a duplicate of a still-open issue is
counted on one comment on that open issue rather than filed as a new issue.
**Why:** an alert must make the current state actionable rather than create notification noise. nas/ryzen queue-stall issues were closed with unreviewed plans eight times between 2026-10-28 and 2026-11-03 (#clw_01M6KJP18TGA8DX826JFMAAZ4N). On 2026-10-27 the prompt guard commented on claws PR 277 for the repo's own test-fixture output and left no alert record (#clw_01M5Z27J5SRTTE4AKQKPHVW7GT).
One fault on one Deployment on 2026-10-18 produced four alert inboxes, none of which closed
when the series vanished, because the open-inbox lookup ignored retitled inboxes before #152
and the bridge reconciled against Alertmanager only on a delivery (#clw_01M59QTCER4G0N89SBV4HRG6Z1).
On 2026-10-25 a rejected OpenRouter key (a 401 "User not found.") filed a separate `[claws-error]` issue per OpenCode run instead of the latched per-provider auth alert (#clw_01M5T43M83QEP8X7VQE5NQDC96).
On 2026-10-26 a Grafana repeat notification for a renovate Job that failed before fleet-infra#535
merged reopened its closed issue and re-planned it for nothing, and past the 24h reopen window such a
repeat filed a second issue for the same Job (#clw_01M5T9PRWQ5YWKVWYW4SY8KADJ).
On 2026-10-28 the prod inbox the requirements writer had retitled as a mailserver issue was reopened
for FluxKustomizationNotReady and took a KubeJobFailed section, so alerts were misfiled on an unrelated
issue (#clw_01M61M73EW1AMEZPD9V06YW18X).
Prod's `AppRequestLatencyP95Regression` fires one series per Traefik service, so namey and bonkus
latency firings shared `alert-apprequestlatencyp95regression`; the operator's done-close of that issue
was undone by bonkus on 2026-10-29 and 2026-10-30 and by namey on 2026-11-04, and it sat Blocked for six
days (#clw_01M6M9AK9QBEHKDDGS75CM32MW).
Per-service keys and the triaged inbox in turn merged unrelated alerts of one service onto one issue
and left every new alert waiting on a planner triage run, so alerts now file one issue per alert group
and merging is an explicit duplicate decision (#clw_01M7554EZ4SGZQHDHWTAEQW2QV).
After the 2026-11-05 prod Flux source switch, twelve `Build failure: publish-flux-source.yml` issues were each
filed with `Occurrences: 1`, planned, and closed as duplicates of the open `Build failure: tofu-apply.yml`
issue (#clw_01M6PGJT5Z7P635SR3NKE94M7R), one planner run per recurrence (#clw_01M6RPD77S4VCG7068KVFN4GEF).

### Judge a regex prompt-injection hit before redacting or alerting

A prompt-guard regex hit is acted on only when a model judge, shown the matched span with bounded
surrounding context and the source field, reads it as a directive aimed at the agent; a hit it reads
as quoted, printed or discussed text is left unredacted and raises no alert. When the judge cannot
answer, the hit is redacted and alerted as if it were a directive. Content with no regex hit is never
sent to the judge.
**Why:** a context-free regex cannot tell a directive from a quote. Every detection on 27–28 Oct 2026
was a quote or fixture — claws PR 277's CI log printing the repo's own prompt-guard test fixtures, and
#clw_01M5Z27J5SRTTE4AKQKPHVW7GT's body quoting the phrase that motivated the alert, flagged again as
#clw_01M5ZYKKXTKWR18Z7HEWQFMQWC — each costing a Blocked issue, a Slack ping and mangled text
(#clw_01M610W4XQJNSQC0AT66X9FVFF).

### Close a build-failure alert once its workflow is green again

A failure alert for a default-branch workflow, and a CI-fixer tracking issue for the build
it tracks, closes as completed once a later run of that workflow passes, even if the planner
parked it as a transient failure and even after the issue was retitled. Open
a plan, a Refined label or an open PR holds it open, and its normal lifecycle closes it.
**Why:** alerts for failed builds stayed open for days after the build recovered and were closed by hand
(#clw_01M4RW0KH4CJTBWDCDKXJWM8RA). A green main proved nothing about an intermittent PR-only failure:
fleet-infra #clw_01M5H67CHFSGWZH77FY1WSCSS5 (2026-10-22) was closed with a plan awaiting review.

### Name the pod and cluster behind a suspicious-DNS-lookup alert

The "Workload DNS Suspicious Lookup" alert must say which pod, and which cluster, issued the query.
**Why:** the operator judged the alert itself acceptable but could not tell where a lookup came from, so could not act on it (#clw_01M5MD6PP1JYV4PYJGW0Z29QX3).

### Say whether a long-running Forgejo job is wedged or merely slow

The over-45-minute job alert states each job's runtime, the threshold passed, its current step and
when its log last grew. A repository may mark a workflow or job as normally long-running with a
larger allowance in its own Claws settings, and the same mark sets how long its log may stay silent;
such a job alerts only past the allowance or when its log goes silent for that window. Jobs are never cancelled, and unmarked jobs alert at 45 minutes as before.
**Why:** a silent wedged job and a slow but logging one looked identical to the operator
(#clw_01M5J7SE3QNHV57FED6G6HVQW4, #clw_01M64E801AFCFMN5GMSQ23WPGW).

### Retry a default-branch build once when it failed on a transient forge error

A default-branch run on GitHub or Forgejo that failed on a transient error — including the
forge answering a git checkout with HTTP 502 — is re-run once before any alert is filed, and
the alert is filed only if the retry fails too. The alert names the event that actually
triggered the run, as the forge records it. DNS failures, registry connection refusals and an
explicit `::error::… (not a PR fault)` marker count as transient too.
**Why:** bonkus run 352 failed its checkout on a Forgejo 502, was never retried, and was filed
as a `push` build failure although Forgejo ran it on `schedule` (#clw_01M4WJFVZYBB9MV9DGVNWSFG9X). bonkus 1784, production-infra 3569 and nixos-config 648 were
filed as real build failures for registry refusals, DNS errors and a not-a-PR-fault marker
(#clw_01M6V4P0ZT6S8WW5T7KD0ZQA6F).

A 503 or 504 answer, or `remote: no available server`, on a git push or fetch counts as
transient too.
**Why:** nixos-config run 796 failed its `git push` during a 12-second Forgejo rollout with
`remote: no available server` and a 503, so an issue was filed instead of a retry
(#clw_01M7BBK6WGFFABBXADN7YNM1GE).

When no retry ran, the alert states the actual reason (superseded by a newer commit, later
attempt, too old, retry deferred, not transient) rather than blaming the heuristic.
**Why:** production-infra run 765 failed on registry 503s that matched the transient
patterns, but `main` had moved on so the superseded run was rightly not re-run; the alert
still said the failure did not match the heuristic, pointing readers at a pattern list that
was fine (#clw_01M57X169RR52PQSR9CGH33QY2).

### Ride out a short forge outage when cloning, refreshing, pushing or resolving a managed repo

Cloning a managed repo, refreshing an existing clone (`git fetch`) and pushing a branch to it
retry transient 5xx and network errors for about half a minute. A
clone, refresh or push still failing after that stops quietly and a later poll cycle retries it; a
`[claws-error]` issue is filed only for a non-transient failure or a third consecutive
transient failure of the same work item within two hours. Reported clone errors omit
credential-helper noise. The remote-branch check before a push gets the same
retry window, quiet stop and third-failure escalation. A work item whose repo is missing from a
repo list built while forge discovery failed is retried later, never failed as `Unknown repo`;
`Unknown repo` is reported only when discovery succeeded and the repo is still absent.
**Why:** the namey requirements-writer run was filed as `requirements-writer:write:run` after a
3 s retry window on a Forgejo 502 (#clw_01M515ATCK3269BZ3RM5TYB5GR); a 503 "no available server"
`git fetch --all --prune` on an existing clone was likewise filed as `triage-claws-errors:process-issue`
(4 occurrences, #clw_01M57ZPS932YX7RTN5BF0ZDH8B), and the same outage failed a push as
`review-addresser:run` (#clw_01M583D748HW9CTRWYQ6K2FH0H); fresh agent pods also failed correctly managed repos as `Unknown repo` during a Forgejo outage (#clw_01M57ZE7VJC1GMK8FZMY2VXJQN); a libcurl `Failed to connect … Couldn't connect to server` push failure by the CI fixer on fleet-infra was filed as `ci-fixer:run` with zero retries (#clw_01M5TAH9YQMT53BMBZBBFQCCY3).

### Send no Slack message for a GitHub platform outage

Claws does not monitor GitHub's public status or post outage messages to Slack. Repo-level failures from a forge outage are handled by the retry and quiet-stop behaviour above.
**Why:** the operator no longer needs those messages (#clw_01M5ADSFMXPYCT0N52MWQXGT4S).

### Reserve Slack for urgent attention

An alert from any source (prod Alertmanager, home Grafana, Flux, Gatus or Claws itself)
posts to Slack only when the operator is the only one who can act and waiting costs
something, in one of four classes: users are hurt now, a possible compromise, automation
is broken, or Claws is stuck on the operator. Alert rules opt in with a `page: "true"`
label; severity no longer routes, so every other alert, warning or critical, only files or
bumps its Claws issue, and the Claws poller still sees every alert. A resolved message is
sent only for an alert that posted. A false page is fixed at its rule through the rule's
alert issue; a second false page from one rule inside 30 days removes its `page` label
until the fix lands. fleet-infra's `scripts/page-alerts.txt` is the checked-in list of
paging alerts, and its CI fails when the labels and the list differ.

Claws' own messages meet the same bar. Every such message names the action and posts once
per episode: expired agent credentials, a rejected model ID, a failed main-branch workflow
on the prod alert webhook, a fatal startup error, a detected prompt injection, one
WhatsApp unpaired-or-disconnected message per episode, and a down service whose alert
issue waits on the operator. Work that merely waits on the operator is
dashboard only, with its issue comment, PR comment, Blocked state and `/alerts` entry:
an operator step that is ready (including one Claws added from a merged PR's post-merge note), an issue parked
for a human, a withdrawn plan pre-approval, an escalation hold, a single expired Claude
account while another carries on, an external kill of an agent CLI and an issue by an
untrusted actor. A logged error, a routine recovery, an informational notice and an echo
of the operator's own dashboard action never post. The dashboard's `/alerts` page is the
complete record of open alerts. The inventory of messages, with each one's trigger and
dashboard cue, is [slack-messages.md](../slack-messages.md).
**Why:** Slack still carried every task waiting on the operator, so the messages that
needed them now were lost among ones that could wait; on 2026-11-03 #lab got four
auto-merger messages within minutes, three about one operator step and one a standing
"whenever a JWK provisioner is rotated" note that asked for nothing
(#clw_01M6GWYR04FZRE5AK80P8TW02C, after #clw_01M5YPSK289NXAK8E6K6RNTFS5). Routing every
critical alert to Slack still buried the few that needed the operator now among ones an
issue could carry (#clw_01M8AG9RS0KT92NKD1F93CXHHJ).

### Page the operator when a down service's alert issue waits on them

While a bridge repo's service has a down-signal alert firing (`TargetDown`,
`KubePodCrashLooping`, `KubeDeploymentReplicasMismatch`, any alert labelled
`page: "true"`, or a name the repo lists in `alertBridge.downNotify.alertnames`) and an
open alert issue for that service waits on the operator, Claws posts one urgent Slack
message per issue per window (six hours by default), naming the service and its down
alerts and linking the issue. The issue waits on the operator when it holds a plan in
Awaiting plan review that is not approved through Plan (the message quotes the plan's
first line and its Stops at line), or when it is Blocked with a current reason that does
not start with ``PR ` ``, ``Waiting on ` `` or ``Depends on`` (an issue waiting on another
open issue) (the message quotes the reason on one line, at most 300 characters). One window
covers both cases. It fires whether the outage or the wait came first, sends nothing when
no down signal fires or when the alert is merely `severity: critical`, and never approves
or merges the plan itself. An issue waiting on the operator otherwise stays dashboard only.
**Why:** on 2026-11-20 bonkus was down (`TargetDown`, `KubePodCrashLooping`,
`KubeDeploymentReplicasMismatch`) while its alert issue held a correct plan from 07:01Z,
and nothing told the operator for about 48 minutes, because a plan waiting for review was
dashboard only (#clw_01M7VZZYSAGW87NV1HVZJXEE4F). A down service whose issue is Blocked on
the operator is stuck the same way, and severity stopped meaning "page"
(#clw_01M8AG9RS0KT92NKD1F93CXHHJ).

### Post every alert to #lab

Every Slack alert, from production or the home cluster and from Claws itself, posts to
`#lab`; the `[prod]` / `[fleet]` title prefixes tell the stacks apart. A failed
main-branch workflow (`prodAlertWorkflows`) posts to `#lab` through the prod webhook.
No per-stack or prod-only Slack channel is an alert target.
**Why:** with paging narrowed to alerts that need the operator now, one channel carries
little enough to watch; the per-stack channel split (#clw_01M78Q5JYZ2PZ6Q2RD6JB6KN73) was
closed unbuilt (#clw_01M8AG9RS0KT92NKD1F93CXHHJ).

### Name the cluster and the Claws issue in every Slack alert

Every Slack alert message, firing and resolved, from either production cluster names its cluster
(`prod` or `fleet`) prominently, and links the Claws issue tracking that alert, or the alert
inbox when none is dedicated.
**Why:** on 2026-10-28 the operator could not tell from Slack whether Flux and job-failure alerts came from prod or fleet, and nothing in the message led to the issue already tracking them (#clw_01M61M73EW1AMEZPD9V06YW18X).

### Report image-scan and domain-posture findings through the main-build monitor

A scheduled scan that has something to report (blocking CVEs, expired or expiring exceptions, domain-posture findings) fails its workflow run, and the main-build monitor's `Build failure` card is the only card for it: one per workflow, refreshed on each failing run, closed on the next green run. The scans file no separate forge issue and need no credential to reach Claws; their follow-up steps still run on a failing run, and the failure comes last.
**Why:** the issue-filer route needed a minted token and a second card for the same finding; the operator chose the monitor so a scan reaches Claws with no credential (#clw_01M61KN5ZGQM6X0Z7VBJE674HE).
**Supersedes:** the scan-specific issue-filer route. Scans no longer use the filer; its routes and tokens stay for other services such as growth-engine's site visits and sentinel's findings.

### Monitor resource exhaustion before it blocks work

Claws must monitor actionable runner, build, storage, and host resource failures, while
avoiding alerts for known unavailable or intentionally disabled resources.
**Why:** unattended automation cannot depend on an operator discovering outages by chance.

### Keep low-priority background work within a shared API budget

Background work that spends the shared forge API quota — such as the doc-maintainer
history backfill — must check the remaining quota first, keep a reserve it never spends,
be capped across all repos together, and must not mark a repo processed when a rate limit
stopped it.
**Why:** a background walk that starves the dispatchers and the merger is a service outage.

### Re-check each repo's docs every few days, not daily

Doc maintenance is a backstop that runs about every four days per repo; other scheduled
jobs keep their own cadence. No condition that forces a run bypasses that window.
**Why:** implementers update docs in the PRs that change code, so about half of daily runs
changed nothing (81 of 167 in the week to 2026-11-25, about $31).

### Spend Anthropic API credit only on work pinned to OpenCode, with visible, bounded spend

OpenCode must run on Anthropic directly with a short-lived federated token (workload
identity federation from the cluster's ServiceAccount identity), with a static Anthropic API
key as fallback, and that credential must reach only the OpenCode child, never the Claude
CLI or pi, which stay on the subscription token.
OpenCode must stay out of the weighted provider draw by default, so only work pinned to it
(a `Use OpenCode` label, an `opencode/` model-plan cell, the OpenCode-pinned jobs, OpenCode
sessions and the completion API's `opencode` option) spends that credit. The operator must
see cumulative OpenCode-on-Anthropic spend on the Usage page and get one Slack warning when
it passes a configurable threshold.
**Why:** OpenRouter's key stopped working and the operator chose not to renew it, so the
OpenCode-pinned jobs move to each Claude Max account's Anthropic API credit; that credit is
finite and must not become overflow for ordinary agent runs (#clw_01M5XBRWMG0KMGTT84Z5890BDY).
A long-lived API key stored in a Secret or pasted into the config page is a standing
credential to leak; a token minted per use from the cluster's identity expires on its own
(#clw_01M6KP2HTJ2K6NXSCX5VZJ61PE).

### Move OpenCode model settings still on a retired default to the current default, and leave operator choices alone

A model setting saved in the config that exactly equals a retired shipped OpenRouter default must
move to the current Anthropic default once, with each change logged; a value the operator
really chose, including a deliberate OpenRouter one, is never touched. Saving the config page
must not store a model field left at its shipped default.
**Why:** every config save before the move to Anthropic wrote the old defaults into the saved
config as if chosen, so they kept winning: the since-removed improvement identifier kept calling the dead
OpenRouter key and latched the OpenCode auth alert three times (#clw_01M6TPJ26B3PDT927QM4909GA0).

### Declare and follow an observability policy in every managed repo

Every managed repo, whatever its kind, must declare its observability policy under the shared
contract in `docs/observability-contract.md`: its logs (one structured record per line on
stdout, with a lowercase string level and no secret values), metrics, traces, latency budgets,
its alerts and its own Grafana dashboard (named by path and uid in fleet or prod Grafana, or
`no dashboard: <reason>`, or listed under Known gaps while missing), its resource-saturation signals (CPU throttling, memory,
connection-pool wait) alongside its latency budgets, and what each new route, DB query,
background job or external call adds — or state that it emits no runtime telemetry. Plans,
implementations and reviews follow that policy.
A policy's statements about current logging, metrics, traces, latency budgets and dashboards
must be true of the repo's code and config today, checked against the code by the agents that
plan, implement and review it; rules for future changes are worded as rules for new changes.
Every policy, the no-telemetry one included, lists under Known gaps each place existing code
falls short of the contract or of its own per-change rules (or says there are none), and may
mark a gap accepted with a reason, or deferred when it cannot be fixed yet: until a date at
most a year ahead, or until a named Claws issue closes. A deferred gap files nothing while the
deferral holds and counts as unaccepted once it lapses; a malformed deferral counts as
unaccepted, never accepted, so a far-future date cannot stand in for acceptance
(#clw_01M72KKZBZVJ5QAM7FAAR1MHD0). Each repo with unaccepted gaps gets one follow-up issue for
them, filed once and not re-filed while it is open (#clw_01M63K1WRSFPZSG18HSRBKNN5P). Closing
it as not planned dismisses only the gaps and findings it listed; a gap or finding that appears
later, a reworded gap or a finding whose message changes included, files a new issue, and
listing the scanner in the repo's `claws.json` `disabledJobs` is the permanent opt-out
(#clw_01M72KKZBZVJ5QAM7FAAR1MHD0). The follow-up's title names the items it lists, prefixed
`observability:`, changes only when they change, and a rename alone never re-plans the issue
(#clw_01M7530QVYM589363S0R8N3K4K).
Accepted observability gaps come back to a person once a quarter in one fleet-wide review of
every repo's observability policy, never one issue per repo, so a quiet quarter takes seconds and no batch of
issues opens at once: gaps that waive a contract-level requirement first, gaps new or reworded
since the last reconfirmation shown and the rest collapsed, one action to reconfirm them all
and a per-gap action to turn one into work (#clw_01M753CRBTEEXJM0QMWEZQBWN4); accepted
security gaps are reviewed on sentinel's page instead (#clw_01M75KGK2BVJVVMX73Z03ZBV5B). Accepting
or deferring a gap is visible when it happens: the plan names it in its decisions, and the PR
description and the Claws review each call it out with what it waives
(#clw_01M72KKZBZVJ5QAM7FAAR1MHD0).
Claws also keeps each policy true: a daily drift check compares what the policy claims (no
telemetry, logging through its logger, the files, dashboards, rule uids and alert labels it
names, `info` reaching Loki) with the repo's code and the fleet-infra and production-infra
monitoring files, and lists each mismatch, with its file and line, in that same follow-up
issue as a gap to fix in the code or to correct in the policy and list under Known gaps. A
mismatch is not raised when a Known gaps item, accepted or not, names that finding (its file or
other key together with its rule or finding id), or when the repo records it in
`.claws/contract-exceptions.yaml` as wrong or not applicable, scoped to the contract, rule and
key (an agent-audit finding by its finding id), with a reason; a new finding of a different rule
on the same file is still raised. Known gaps lists real shortfalls only, never a false positive,
and an invalid exceptions entry silences nothing and is itself raised. A check that cannot read
what it needs concludes nothing (#clw_01M6P6EX2MQ5E2R2AGKFKM8EXC, #clw_01M72KKJ8DB6N6D01Q4SQ0ESQB). A weekly
agent audit, run only for a repo whose code has changed since its last audit, checks those
changes against the policy's per-change rules and adds each concrete mismatch, with its file
and line, to the same issue. A finding whose file has changed since the audit is withdrawn
from the issue until the next audit re-checks it, so a fix does not stay raised for a week.
Once that issue closes as completed and the repo's default branch moves past the audited commit,
the findings it listed are not raised again before the next audit (#clw_01M6X6DAJ2SSRHQ4X5MV239NEC).
A policy also states, as rules for new changes, that every state-changing action logs one
`info` line naming the action and its outcome, queryable per component; that every
`info`-and-above line reaches Loki, with no log filter or forwarding level that drops `info`;
and, for firmware, a device or a host daemon, its log route (the forwarding hop, the level it
forwards, the Loki stream labels and a per-device query) instead of the JSON-on-stdout block.
A policy silent on actions at `info` and shipping is incomplete (#clw_01M6KC16S5KZC1E0CRE6WJ7CJ0).
A repo that emits runtime logs has its `error` and `fatal` log lines watched by a Grafana alert
rule, and each alert becomes a Claws issue through the alert bridges, deduplicated per distinct
error: repeats, restarts and repeated notifications keep one open issue updated, and distinct
errors get separate issues. The policy names that rule, or lists its absence under Known gaps;
a policy silent on it is incomplete, and new error log paths stay inside the rule while no
change removes or weakens it. Claws' own logged errors are monitored the same way, without
filing a second issue for a fault it already reports as `[claws-error]`
(#clw_01M6M0VZ59BH6DYS5YGNNKFGF1).
A contract rule change must not file a fresh declare issue in every repo: a repo whose existing
policy fails only rules added or tightened since rollout gets them in its one follow-up issue,
filed if none is open, while a repo with no policy, or one failing an older rule, still gets the
declare issue. New rules alone open a follow-up only after a seven-day settle window, so a burst
of rule changes lands as one round of issues, and each daily scan logs which repos fail each new
rule (#clw_01M72KMF7B2BYEDTDB3N303J3N).
**Why:** failures must be queryable across the fleet. In NAMEY-5Q a 1.21 s "slow DB query" was
not the database: Postgres was idle and query p50 stayed at 3–5 ms, while p99 rose to 1.5–5 s as
the pod's CPU throttling rose from about 1% to 13–20% during a crawl. A latency budget alone
cannot tell "the dependency is slow" from "we are starved and waiting on it"; saturation signals can.
A keyword check passes a policy that describes logging, metrics or dashboards that do not
exist, and declaring a policy instruments nothing, so without the code check and Known gaps the
shortfalls of existing code would never be tracked. Few services had a dashboard because the
contract only asked where dashboards live (#clw_01M668P7YKRPMN4VHYWH1D1NZN). On 2026-11-04 the
ESPHome heating controller logged relay switching at DEBUG while Home Assistant forwarded device
logs at INFO, so no 230 V relay action reached Loki and nothing in the contract flagged it
(#clw_01M6KC16S5KZC1E0CRE6WJ7CJ0). Error lines reaching Loki is not the same as anyone hearing
about them: a repo could log errors indefinitely with nothing watching, while the alert bridges
already deduplicate recurring alerts onto one issue, so the standard now requires each repo's
logged errors to feed them (#clw_01M6M0VZ59BH6DYS5YGNNKFGF1). Silencing by file alone let one
listed item hide every later finding on that file, and repos used `Accepted:` gaps to record
false positives, so Known gaps stopped meaning real shortfalls (#clw_01M72KKJ8DB6N6D01Q4SQ0ESQB).
The 171 accepted gaps across the fleet carried no review date, so once accepted a gap was never
looked at again, and an acceptance added in a PR was easy to approve without noticing
(#clw_01M72KKZBZVJ5QAM7FAAR1MHD0).
Between 2026-10-30 and 2026-11-07 each contract rule change filed a declare issue in
every repo, about 65 of roughly 140 contract issues in twelve days, each needing a plan, an
approval, a PR and a review for what was mostly a one-paragraph doc edit (#clw_01M72KMF7B2BYEDTDB3N303J3N).

### Count a valid infrastructure-repo path as present in the observability drift check

The observability drift check must not report a policy path as missing when it exists in
the production-infra or fleet-infra repo, even if the policy names it without the repo prefix or
as a glob; a path that exists in none of the repos checked is still reported, and the finding
names the repos checked.
**Why:** valid paths such as production-infra `apps/plausible/` and fleet-infra `apps/gatus/`
were reported as drift while refining perudo and bonkus, sending planners after gaps that did not
exist (#clw_01M6V4PDWYXEPTH3W5PMHZJF6M).

### Never read a version-like token or another managed repo's path as a missing file

The observability drift check must not report a backticked token shaped like `name/semver` (a
User-Agent such as `curl/8.6.0`) as a missing path, and must resolve a path prefixed with
any managed repo's name against that repo instead of the app repo.
**Why:** both were filed as drift gaps in repos whose policies were correct
(#clw_01M7BBK1BVP0VFJTZC4ZEAM991).

### Log every decision of a successful poll of an alert bridge

Every successful Alertmanager poll of a polled bridge repo must log one `info` line per alert
issue it files, bumps or adopts (prefixed "would" in shadow mode), or, when it changes none, one
line giving the reason it did nothing with the firing count.
**Why:** the poller is the only writer of that repo's alert issues, and the decision lines are the
only way to see from logs that it decided correctly or reached the decision at all; the lines
stopped on 2026-11-07 while polls kept succeeding (#clw_01M6V6CWR9DV69JES12JSPNNXY).

### Explore the wall dashboards daily and file what no alert covers

Once a day, early morning Europe/London, Claws must render every dashboard in the home-Grafana
playlist `Wall` the way the dashpi office wall shows it (1920×1080 at device pixel ratio 1, kiosk,
dark theme, the dashboard's own time range), signed in only as the `claws-service` Authentik
service account, and have an agent judge the screenshots. It files an issue, with the panel and
dashboard screenshots attached, for an operational problem the wall shows that no firing or
pending alert and no open issue covers, and for a wall that does not communicate well (checked
against open issues only). A run files at most five issues, never files the same finding twice
while it is open, holds a dismissal for 30 days, and files nothing on a clean day.
**Why:** nobody looks at the wall closely, so a problem it shows plainly (a "No data" panel, a
stale tile, growth heading for a limit) went unnoticed when no alert covered it
(#clw_01M7Q9Q20W7AQ7XT6C8RJBWWF4, #clw_01M7Q8S8S5AX0SGZSHCZW6JGHX); much of what is wrong with a
wall only shows when it renders. See [jobs/wall-explorer.md](../jobs/wall-explorer.md).

### Declare a security policy, keep it true, and gate every first-party image push on a vulnerability scan

Every managed repo, whatever its kind, must declare a security policy under the shared contract
in `docs/security-contract.md`, in `docs/security.md` or a `## Security` section of `AGENTS.md`,
with one subsection each for its scope, dependency and image vulnerabilities, accepted
findings, secrets, supply chain, exposure and authentication, and Known gaps. Each subsection
describes the repo's approach or says it does not apply, with a reason; no repo is exempt by
type. A repo that publishes a container image scans the built image before every push, and the
push fails on a fixable High or Critical finding unless an OpenVEX `not_affected` statement
under `.vex/`, with a justification and an impact statement, covers it; a first-party image's
findings are never accepted through fleet-infra or production-infra `exceptions.yaml`. When
the vulnerability database cannot be downloaded from any mirror the push goes ahead with a
loud warning, and the weekly deployment-repo scan is the backstop. The policy describes the
repo as it is today, every shortfall goes under Known gaps with the same grammar as the
observability policy (accepted, deferred until a date or a Claws issue, or unaccepted;
#clw_01M72KKZBZVJ5QAM7FAAR1MHD0), and unaccepted gaps and drift between the policy's claims and the code
become one Claws issue per repo to remediate; closing it as not planned dismisses only the
gaps and findings it listed, so later ones file a new issue, and `disabledJobs` is the
permanent opt-out (#clw_01M72KKZBZVJ5QAM7FAAR1MHD0). That issue's title names the items it
lists, prefixed `security:`, changes only when they change, and a rename alone never re-plans
the issue (#clw_01M7530QVYM589363S0R8N3K4K). Accepted security gaps are reviewed in one place,
sentinel's private CVE exception page, beside the fleet's CVE exceptions, not in Claws'
quarterly observability review: it judges each repo's accepted gaps against the repo, lists the
ones whose claim no longer holds or whose cited path is gone for a re-check, and files one issue
per repo for them, so no quarterly reconfirm-all is needed (#clw_01M75KGK2BVJVVMX73Z03ZBV5B).
A plan, PR
description and Claws review call out any gap they accept or defer
(#clw_01M72KKZBZVJ5QAM7FAAR1MHD0). A drift item is silenced only for that finding:
by a Known gaps item naming its file and rule, or by a `.claws/contract-exceptions.yaml` entry
recording, with a reason, that it is wrong or does not apply; Known gaps lists real shortfalls
only (#clw_01M72KKJ8DB6N6D01Q4SQ0ESQB). A weekly read-only agent audit checks every
current-behaviour claim in the policy (secrets, exposure and authentication, pinning and
Renovate, lockfiles, the scan gate and `.vex/`) against the code and the ingress and network
policy in fleet-infra and production-infra, and adds its findings to that same issue
(#clw_01M72KM7ES9TCJNKNBEMPJKSK9). Claws' own policy passes the contract, and its
release scans the image before pushing it (#clw_01M6P4VKXAZBKPXHADA6KXM1WM).
A contract rule change must not file a fresh declare issue in every repo: a repo whose existing
policy fails only rules added or tightened since rollout gets them in its one follow-up issue,
filed if none is open, while a repo with no policy, or one failing an older rule, still gets the
declare issue. New rules alone open a follow-up only after a seven-day settle window, so a burst
of rule changes lands as one round of issues, and each daily scan logs which repos fail each new
rule (#clw_01M72KMF7B2BYEDTDB3N303J3N).
**Why:** fleet-infra and production-infra had accumulated 176 `exceptions.yaml` entries for
first-party images, written by the deployment repos without the source context to judge them
(61 for Claws alone), so findings in images we build were waved through far from the code that
could fix them. Scanning before the push puts each finding in front of the repo that can fix it,
and a VEX statement beside the code records why one that does not apply is safe
(#clw_01M6P4VKXAZBKPXHADA6KXM1WM). Between 2026-10-30 and 2026-11-07 each contract rule change filed a declare issue in
every repo, about 65 of roughly 140 contract issues in twelve days, each needing a plan, an
approval, a PR and a review for what was mostly a one-paragraph doc edit (#clw_01M72KMF7B2BYEDTDB3N303J3N). Accepted
security gaps were reconfirmed quarterly in Claws while the CVE exceptions that carry the same
risk were judged on sentinel's page, so security risk was reviewed in two places and the
quarterly click checked nothing against the repo (#clw_01M75KGK2BVJVVMX73Z03ZBV5B).

### Resolve Mac runners without pod mDNS

Mac runner SSH from the Claws pod must not depend on pod mDNS (#3169). The two
registered Mac identities resolve through one code-owned LAN alias table shared
by `mac-runner-waker` and the Mac SSH session capabilities (Forgejo
`runner-monitor` never SSHes to a Mac), preserving explicit user
overrides without a second Secret or dotfile alias source.
**Why:** Mac waking and session SSH need consistent host resolution inside Kubernetes.

### Treat a runner as online while a stale registry row shares its name

A runner name is online if any registry row with that name is idle or active; stale offline rows with the same name are logged and ignored, never probed or alerted on. A name with only offline rows is still checked, once.
**Why:** a stale row left by a re-registration made the offline alert open and close every tick, which is unactionable (#clw_01M5336HE9A9V7SW49PM7HCVB0).

### Log, never alert on, queued Forgejo jobs

runner-monitor logs Forgejo Actions jobs waiting over the threshold (one info line per tick) and never files, updates or reopens an issue for them. Long-running-job alerts and, for non-Mac runners, per-runner high-disk, offline-but-host-up and Cannot SSH alerts still file; Mac runners are not probed (see "Alert on a Mac runner's real free space").
**Why:** the queue-stall alert filed about 15 issues, each costing a planner run that ended "operator task". Instance-scope k3s runners are invisible to Claws so most causes were `unverified`, nas is off by design, and in #clw_01M6QTXYNYKMK4HAQRPPTZEVP8 claws `release.yml` run 1390 waited about 93 minutes behind the `release` concurrency group and was mislabelled as a missing runner (#clw_01M6TNMQTRHYBKKK4540GBT5JM).

### Hold work that pushes to a repo while its CI queue is deep

While a repo has 8 or more non-Mac Forgejo Actions jobs that have waited at least 5 minutes for a runner (`CLAWS_CI_QUEUE_HOLD_JOBS`, `0` disables), Claws starts no new CI fixer, review addresser or implementer run for it and makes no automatic branch update of its PRs, and resumes by itself once the queue drains. Reviews, planning and merges are not held, an item with the Priority label is never held, and a queue Claws cannot read never holds work. A held CI fix, review addresser or first implementer run shows `Waiting for the CI queue` on the dashboard; a held continuation, re-run sweep or awaiting-merge PR's advisory nits show no note. Every held item logs one `info` line.
**Why:** on 2026-11-19 bonkus CI bursts filled the shared `[container, linux]` runner pool, with jobs queued 30–48 minutes; every push Claws added to a repo already that far behind made the queue longer for every repo on the pool (#clw_01M7T7K12NNP20WJ83PWMAVZB1).

### Never alert on an unavailable Mac runner

Claws keeps waking Macs for queued macOS jobs, but a Mac that is asleep, off the
network, refusing or failing SSH, or whose runner never comes online is logged
only (no Slack notice, no `[claws-error]` issue, no alert issue) and the job
stays queued. runner-monitor never SSHes to a Mac runner, online or offline, and
Grafana's Mac alerts stay silent while a Mac is asleep or away. Failures reading the forge's queued runs or jobs are
Claws' own fault and still report as errors.
**Why:** both laptops are routinely offline for long stretches, the alerts were noisy and repeatedly wrong (#clw_01M4T7BYENPV5854WJGFBX1G77), and the operator decided unavailability should surface only as work not moving (#clw_01M537H86YQX63Q2ZM1FF21R5Q).

### Alert on a Mac runner's real free space

A Mac runner's low-disk alert is Grafana's `Mac Disk Space Low` rule in
fleet-infra, fed by the metrics each Mac pushes to the fleet Prometheus. It
measures free space on the data volume (`/System/Volumes/Data`) in absolute GiB
(raise below 10 GiB, close at 15 GiB or more), names the usual causes, never
cleans up automatically, and reaches Claws through the alert bridge on the Mac
runner issue. A `Mac Metrics Missing` rule fires when an awake Mac sends no
metrics. Claws does not SSH to a Mac for disk checks.
**Why:** `df -P /` on macOS reads the sealed system snapshot, so the percentage hid a container that was about 99% full and the alert closed at about 4.5 GB free and refilled within days (#clw_01M66C3HWPREBSSS4Y03QTPVTY, #clw_01M6JKBQJDJK2XNXT5MGRZ1BNK). Probing over SSH every 10 minutes cost about 12 certificate signings an hour, and pushed metrics let a sleeping Mac stay silent (#clw_01M8C1453K6SG6CTM0PK2S7V79).
**Supersedes:** the runner-monitor SSH disk check on Macs, which measured the same thresholds with `df` and attached a `du` breakdown.

### Raise a non-Mac runner's "Cannot SSH" alert only after two consecutive failed checks

A non-Mac host's "Cannot SSH" alert opens only once two consecutive SSH checks to that host have
failed. A successful check resets that host's count and closes any open alert; counts are
per host, and may reset on a service restart.
**Why:** a single failure (host mid-reboot, a network blip) opened an alert that closed itself on the next pass, which was noise.

### Make a "Nix is not installed" runner failure diagnosable from its own log

When the Nix setup step fails on a CI runner, its log must identify the runner and show the
state of the Nix store mount, so the failing runner can be found after a re-run replaces the log.
Runner-side logs should likewise show which store volume a runner mounted and whether it was
seeded when a job started.
**Why:** an intermittent failure fixed by a re-run left no way to tell which runner or volume was at fault.

### Bound headless-agent memory across shared service budgets

Headless agent supervision must enforce both an effective per-run memory cap and aggregate admission/backpressure where agents share the service's own container or node budget.
**Why:** a legitimate large agent run should have a path to completion without allowing concurrent runs to OOM the dashboard or the worker service.
In an agent pod the pod's Kubernetes memory limit is the limit: no in-process watchdog runs there, and the run may use the whole pod. A pod Kubernetes ends `OOMKilled` is reported as a Claws memory-limit failure (`failureCategory: memory-limit`, `memoryMeasurement: kubernetes-oom`, the pod limit as the breached cap) with the same "Memory limit reached" item comment, escalation and three-kill rule a watchdog kill gets, never as an unexplained external kill.
The in-process watchdog applies only where agents share the service's container (or the systemd host), and it measures summed proportional set size (PSS) over the run's process tree, which counts a shared page once; summed per-process RSS, which counts it once per process, is a cheap pre-check and a diagnostic and never decides a kill. Its comment names the measurement.
**Why:** on 2026-11-19 bonkus PR #404's review-addresser was killed ten times by a watchdog that summed per-process RSS — it reported up to 19.5 GiB in a 16 GiB pod that Kubernetes never OOM-killed, whose real working set peaked at 11.9 GiB — because parallel `rustc` workers mapping the same libraries were counted once each. In a dedicated pod the watchdog was only a lower, mis-measured copy of a limit the kernel already enforces exactly.
A heavy run has a larger size to go to: an item labelled `Agent: Large` runs its agent pods in a large class (a bigger memory request and limit, and a larger ephemeral-storage limit and HOME size so a heavy build is not evicted for filling the default disk; an eviction failure names the kubelet's stated reason) that is pinned to the named large nodes and never placed on the always-on node. While every large node is off, the run waits and raises the capacity alert; it is never failed and never run at the default size instead. The class a run used is shown on `/status`, in `claws_work_queue` and in `claws_task_history`.
A default-class pod the kubelet evicts for exceeding a storage limit (an `EmptyDir` volume or ephemeral local storage, not node disk pressure) is escalated the same way, and its row is re-queued once in the large class instead of failing; the comment names the disk limit, and no `claws-error` is filed once the retry is queued. A large-class storage eviction still fails with the kubelet's reason. An agent pod stopped by a signal exits non-zero, and an eviction is recognised even when Kubernetes reports the pod as succeeded (#clw_01M83V0QGWV3AVHNN0NYR9Y4EP). A default-class pod `OOMKilled` by Kubernetes escalates its item: Claws adds `Agent: Large`, says so in the "Memory limit reached" comment, and the item's next run goes large and stays large until the operator removes the label. Such a kill is not a strike; the three-kills-at-the-same-limit rule that removes an item from the queue counts only kills the larger size cannot fix — at the large limit, at a lowered auxiliary cap in a shared container, or wherever the large class is not configured.

### Alert when agent runs are repeatedly killed for memory

A memory kill of a headless agent run — a Claws watchdog `memory-limit` kill or a Kubernetes `OOMKilled` pod, in any repo, in pod mode or shared-container mode — must be visible in Prometheus by job and pod size class. Two such kills of one job class within an hour raise a warning alert, and an item removed from the queue after repeated memory kills raises a critical alert; each files a Claws alert issue naming the job, the pod size class, where to restore the item and the remedies. A single kill followed by a successful retry does not alert, and the alerting adds no running cost.
**Why:** on 2026-11-19 one review-addresser run was killed for memory ten times and nobody noticed, because the kills were recorded only in task outcomes and item comments that no alert rule could see (#clw_01M7ST52PFKR6PRCF0FTS0GT8T).

### Headless agent runs survive a service restart

In a Kubernetes deployment a headless agent run must not share the service process's
lifetime: a Claws restart or rollout mid-run leaves the run going and the next boot
re-attaches to it, rather than killing it and re-queuing it from scratch. The service
ends a run only when the run itself ended, was cancelled, or its pod died. The run's pod
records its result, tasks and logs through the service's agent-pod ops API, retrying
while the service restarts. A repeatable repo-scoped run (such as the auto-merger sweep)
whose pod vanishes is failed and logged but raises no `[claws-error]` issue; any other
lost-pod report names the run kind and whether it was adopted after a restart.
A run whose pod cannot be placed for lack of cluster capacity waits and then runs; a
lasting shortage raises one alert naming capacity as the cause, not an issue per run.
A pod that stays Pending with no stated reason, or only an ordinary startup state (`ContainerCreating`, `PodInitializing`), is named as never scheduled, or as scheduled to a given node with no container started; it is retried once by re-queueing the row, and only a second stall raises the single `[claws-error] agent-pod:never-started` issue. A start-timeout failure also names the pod's latest warning event (`last pod event: <reason>: <message>`) when one exists.
**Why:** long runs — a pr-reviewer on a large PR takes ~40 minutes — otherwise lose all
progress to every deploy and can loop indefinitely on a busy day.

### Keep the dashboard responsive and measurable across a rollout

Claws records every dashboard request's duration per route pattern, its forge call
timings, its running version, and the dashboard's unavailable window across each
rollout (from SIGTERM until the next process is listening), split by shutdown
phase. It exports these as Prometheus metrics, so that each page's p50 and p95, and
how they change across a release, can be read in Grafana. The metrics are served on
a separate port, never the dashboard's, so they are never exposed through the
Ingress. The current process's per-route percentiles are also readable through a
read-only diagnostics tool.

Dashboard reloads do not wait on the forge. Page handlers and the nav counts
render from cached forge lists, which are refreshed in the background. The
data shown can be at most ten minutes stale, and the nav counts about 20 s.
Jobs and `/api` reads stay strict. The targets, measured in-process during
normal use, are:

- the nav counts add at most 0.2 s at p95 to any page;
- `/board`, `/backlog` and `/prs` answer within 0.5 s at p50 and 1.5 s at p95;
- the boot part of a rollout's window, from `server.close()` until the next
  process is listening, is at most 30 s;
- the full window, from SIGTERM until listening, is below the measured
  baseline.

**Why:** operators reported slow reloads that were worse during a rollout, but no
timings existed to find the slowest pages or to confirm a fix
(#clw_01M59ZXZ26S1WBJQRSBGJXZVPZ).

### Show agent token usage and pipeline state in Grafana

Claws exports the agent-side state it already records as Prometheus metrics on
its metrics port: agent tokens and cost by provider, model, Claude account, repo
and job (interactive sessions included), task outcomes, failed tasks by failure
reason and pod size class, items removed from the queue after repeated kills,
provider holds, running
and queued work, board issues by column with the count waiting on the operator,
open Claws PRs by stage, and each scheduled job's last run. A day's token total
read in Grafana stays exact across restarts, rollouts and the web/controller
split, and the labels stay bounded: no issue or PR ids and no session working
directories. A dedicated Claws overview board (separate from the latency
board) charts them, including tokens per repo and per job, and the fleet wall
shows tokens by model. Plan-utilisation percentages are deliberately not polled
from Anthropic: that would add an external call and credentials for a figure
Claws does not record itself, so its absence is a non-goal, not a gap.

**Why:** token spend and pipeline state were visible only on the dashboard's own
pages, with no history and nothing on the Grafana boards and wall the operator
watches (#clw_01M663VPZ4ES5PZTY4JQ9VJ5CT).

### Keep the dashboard available while the background controller restarts

The dashboard, `/api` and the interactive session pages are served by a
stateless web tier. It rolls without failing a request, and it keeps serving
while the single background controller (scheduler, work queue, WhatsApp,
session timers, auth sync, memory backup) restarts or rolls out. Every page
then says that background processing is restarting. Triggers and cancels
filed meanwhile are queued and run when the controller is back. Everything the
web tier reads or changes about background processing goes through shared
durable state, never an in-process call. Only re-auth and WhatsApp pairing
reach the controller directly. Only the controller migrates the database or
runs jobs, and web and controller work one release apart.

**Why:** every rollout took the dashboard down for the whole graceful shutdown
plus the next boot, and the single process could not be doubled
(#clw_01M5APX7YF3AGWHV1S1WMHJDR6).

### A headless run whose pod vanishes is retried once, resuming its own work

Alongside the never-started retry above, a still-running headless run whose agent pod is
deleted outside Claws mid-run is re-queued once, with its Secret deleted and its token
cleared, for every kind except the repo-scoped repeatable kinds (`auto-merger:sweep`,
`ci-fixer:rerun`), which keep their quiet failure because the next cycle re-runs them
anyway. Only a second vanish fails the row with a `vanished on retry` reason and raises the
single `[claws-error] agent-pod:vanished` issue; the dispatcher then re-enqueues the item
from forge state on its next cycle. A pod the kubelet rejects at admission for a resource or affinity reason (`OutOfmemory`, `OutOfcpu`, `OutOfpods`, `UnexpectedAdmissionError`, `NodeAffinity`; classified with `admissionRejected`) is re-queued once for any kind, with a warning naming the reason and no `[claws-error]` issue; only a second rejection files `agent-pod:run`. A pod whose first ops-API call never reached the Claws service (its connect retries exhausted) did no work, so it exits 75 and is re-queued once in the same way, with no `[claws-error]` issue; only a second such exit fails the row `on retry` and files `agent-pod:run`, and every agent-pod failure reason names the pod's underlying error, not just its log message (#clw_01M8C5N94SATCSW7K77WFAHK2F). A pod Claws
deleted itself and a run that already ended are never retried. When the pod was seen being
disrupted before it disappeared, the log and failure name the reason (e.g.
`PreemptionByScheduler`) instead of a bare "agent pod not found". Agent pods should run
under a priority class that low-priority workloads cannot preempt, set with
`CLAWS_AGENT_POD_PRIORITY_CLASS`, or inherited from `CLAWS_SESSION_PRIORITY_CLASS` when
that is unset, so interactive sessions and agent pods can take different priorities. A pod whose container the kubelet reports lost to a node or
runtime restart (exit 255 with the kubelet's termination-message error, or an
`Unknown`/`ContainerStatusUnknown` reason) counts as a disruption too, including when found
after a Claws restart: it is retried under the same rules, and a repo-scoped kind is
failed and logged as lost to a node or runtime restart without a `[claws-error]` issue.

A retried run is correct however far the lost attempt got. Kinds that push commits mid-run
resume rather than repeat: the implementer reuses the lost attempt's branch, building on
any commits it pushed without rewriting them, and settles the PR that attempt already
opened instead of opening another; before opening a PR it adopts any open PR already on
its branch, so one branch never has two PRs. CI-fixer, review-addresser and continuation
runs start from the PR branch as pushed, never force-push, and edit or reaction-mark their
comments, so a repeat adds no duplicate comment or reply. A lost-node loss is recorded as
an external kill, never as an agent failure: it spends no CI-fix attempt, counts towards
no failure or no-commit counter and never marks a PR Claws Problematic.

Every headless kind may therefore run on off-node hosts that may power off
(`CLAWS_AGENT_POD_OFFNODE_*`, `CLAWS_AGENT_POD_PREFERRED_NODES`), ranked in list order —
an earlier Ready host is preferred over a later one — and falling back to the session node
when none is Ready. The NAS is on by default and the operator may switch it off at any
time; ryzen still powers off nightly. Interactive session pods
run only on the session nodes (`CLAWS_SESSION_NODES`, meant to list the NAS (`nas`) first and then
`thinkcentre`, never ryzen; with it unset, the session node selector), and each session stays on the node whose node-local volume holds its HOME until a node evacuation copies that HOME to the home node, `thinkcentre` ([interactive-sessions.md](interactive-sessions.md#move-every-session-off-a-node-before-it-goes-down)). A pod left Terminating
after its powered-off node's taint-manager eviction is force-removed and retried under the
same once-only rule.
**Why:** one cluster-side disruption, such as scheduler preemption on a full node, should
not lose a run or file an error issue; and with only review and planning runs allowed
off-node, implementer and CI-fixer runs competed for k3s memory after the 2026-10-26
preemption while ryzen and the NAS sat idle (#clw_01M5ZCYHRJ9SPXX78HFC21J6GK).

### Size headless-agent concurrency from live node capacity

Under the `k8s-pod` backend, how many headless agent runs Claws claims at once follows the
memory it can actually place agent pods on: every minute it reads the Ready nodes and the
memory already requested on them (its own agent pods excluded, and every pod still waiting
to be scheduled counted against each node it could land on, so a displaced lower-priority
pod gets its room back instead of losing it to agents) and sizes one lane of fibers
for every kind from the always-on session node's headroom and a second lane, which also
claims every kind, from the off-node hosts every headless kind may use (ranked in list
order; the NAS is on by default and may be switched off by the operator, and ryzen still
powers off nightly). The total stays
between an operator-configured minimum (default 2) and hard maximum; with the off-node
hosts down, the second lane shrinks to nothing and every kind stays within the session
node's own headroom. A node going NotReady or powering off lowers the
ceiling within a minute without killing running pods: surplus fibers stop claiming after
their current row. A failed node read holds the minimum and logs a warning rather than
stopping work or launching unbounded pods. The live ceiling, the min/max and the per-node
Ready state, allocatable and requested memory (including unscheduled pods' share) and slots are shown on `/status` and in
`claws_runtime_status`. A large-class agent pod's request beyond the default one counts
against its node, so the derived ceiling never hands that memory to default-size runs, and
a large pod waiting for its nodes does not hold back other work: each adds one fiber.
**Why:** on 2026-10-26 a fixed count of 4 left 20 rows queued — 13 of them review and
planning kinds that could have run on ryzen or the NAS — while 4 ran; the part-time nodes
added placement choices but no throughput. The second lane claims every kind since
push-capable runs may leave k3s too (#clw_01M5ZCYHRJ9SPXX78HFC21J6GK).

### Log why the auto-merger skipped an eligible-looking pull request

When a sweep passes over a pull request that looks mergeable, it logs a reason code that
the recent-job-logs tool can see, and every configured repository is swept on the same
cadence.
**Why:** green, reviewed auto-bump PRs in one repository sat unmerged with no trace of
why, and the operator had to merge them by hand (#clw_01M4TK4C1E6VHMC09T13HDCBHJ).

### Agent pods act through an enumerated Claws API, never the database

A headless agent run's pod must hold no database credentials and open no database
connection. Everything it records goes through a fixed list of named operations on the
Claws service, authenticated by the run's own token and limited to that run's work row,
job run and tasks; the list is reviewable in one place (`src/agent-pod-ops.ts`).
**Why:** least privilege — a pod's Secret must not be a database credential, the
database's network policy admits only the service, and what a pod can do must be
reviewable as a list rather than "anything SQL can".

### No cluster holds a Claws token for alerting

Claws reads each cluster's alerts itself (`alertBridge.poll`), through that cluster's Grafana with its own observability JWT; nothing in a cluster can call Claws to write an alert issue, and Claws serves no alert-bridge route.
**Why:** a token running in another repo's cluster is a standing write path into Claws. A retitled inbox was invisible to the push bridge, which filed three inboxes for one fault on 2026-10-18 (#clw_01M57WT147NY6J4N0X369K3F9Y). Polling removes the token and prod's only route home for alerting, so a compromised prod cluster cannot write Claws issues at all (#clw_01M6NVG8QYJ0MN59X0Q3CWR932); once both clusters were polled the push routes were deleted (#clw_01M7554EZ4SGZQHDHWTAEQW2QV).

### An issue filer's token reaches only its own repo's filed issues

The token an external issue filer sends to Claws works only on `/api/issue-filer/<its repo>/…`. There it can file an issue in that repo, look up the open issue holding a dedupe key, and attach a PNG to an issue, always within native issues whose primary repo is that repo and whose dedupe key starts with the prefix that repo's `claws.json` configures. Filing dedupes by that key alone, never by title similarity. The token may also mark a filed issue as an alert so `/alerts` lists it, and nothing more. A filed issue waits in Requirements review on its own text, and an upload posts no comment and queues no re-plan. The token opens no other issue and no other route, and no agent or operator credential opens those routes.
**Why:** growth-engine's site visits run outside Claws and must file a run's findings, with their screenshots (growth-engine #clw_01M5HZ9CEJPMS6V2DNF3S9FXWY; consolidated into one issue per run by #clw_01M5MHZ0PJZXYX2E15QR83ZHD4). A leaked token must cost at most that repo's filed issues, and similarity dedupe would merge an unrelated finding into another issue.

### Accept a rotated alert-bridge or issue-filer token within minutes of its merge

When a repository merges a new alert-bridge or issue-filer token and hash in one change, the newly deployed bridge or filer must authenticate within a few minutes, not wait out the repository-configuration cache. A rejected token triggers one fresh read of that repository's configuration before the request is refused.
**Why:** the documented rotation merges the token and hash together and the old token is gone at once; the bridge got 401s for up to 30 minutes after two rotations, so alerts were dropped (#clw_01M504RRF447J19BBKEZFAYZ0R).

### Grafana observability access needs no runtime state in Grafana

Each cluster's Grafana must accept Claws' observability credentials with nothing created in Grafana by hand and nothing copied between clusters. The same credentials serve Claws' Alertmanager poller, and the operator must be alerted when a poll keeps failing, not only when an agent's grant would. After a Grafana rebuild, the next request must work again as a Viewer-only identity with no operator action. Claws must keep its credentials out of argv, logs and git, and the operator must be alerted when either Grafana stops accepting them.
**Why:** the 2026-10-19 service-account tokens were Grafana database state, so a PVC rebuild would silently break both observability capabilities until an operator recreated them and carried the prod token to the fleet cluster (#clw_01M5AW39TVQ6KX2WRDZGHSN2TZ).

### Keep secret values out of operator-facing output

Configuration pages, agent prompts, arguments, logs, and diagnostic results must not
embed live secret values; a required placeholder must be conspicuous in the pull request.
**Why:** observability must not turn into a credential disclosure channel.

### Let a session add a secret as its own encrypted file, never with the decryption key

A session, or anyone without the private decryption key, adds a secret to a managed repo by
committing one encrypted file per secret; the key is never given to sessions and no
decrypt-and-merge service is built. Adding it must refuse to overwrite an existing file, never echo
the value, leave no plaintext behind even on failure, and fail the repo's checks when a secret
file is not wired into its app or holds an unencrypted value. Uploaded plaintext secrets expire
rather than lingering on the automation host. Folding such files into an app's main secrets file
is optional housekeeping.
**Why:** the private key would let a session decrypt every secret in the cluster repo, but
without it a session could not add a key to an existing encrypted file; the manual workaround left
plaintext on the host and was easy to get wrong (#clw_01M6K7MPBP2468D369N1XJ7HMV).

### Emit machine-parseable service logs

Operator-facing services must emit one structured line per log event, so failures can be
queried by level, component, run and repository without regex scraping; the structured
fields are bound by the secret-output rule above.
**Why:** unattended automation must be diagnosable after the fact.

### Build, release and run Claws itself from its Forgejo repository

Claws' own repository is hosted on Forgejo and managed like any other Forgejo repo: its CI,
releases and pull-request flow (merged through Automerge, never a self-approving comment) run
there, and the GitHub copy is archived. Its service image is published only to the LAN
registry, and session and agent pods default to that image; the GitHub App stays only for
repositories still on GitHub. Runners are selected by the labels the Forgejo runners declare.
**Why:** the fleet moved off GitHub and Claws' own repo was the deliberately last to move;
GitHub cannot publish to the LAN registry, and a pipeline split across forges left images and
pull secrets inconsistent.

### Move only allow-listed state during a deployment cutover

A migration may copy only the operational state it needs; environment files and mounted
credentials are supplied by the destination and must never be copied as durable state.
**Why:** copied host credentials can override destination configuration or remain on persistent storage.

### Preserve database compatibility across supported deployments

The service must support its configured database backends with one logical schema and
must not replicate instance-local or oversized diagnostic state into a migration.
**Why:** a deployment migration should preserve useful history without importing avoidable risk.

### Agents read only files held in Claws' own issue tracker

At agent run time (Requirements writer, Planner, Implementer), image and attachment context comes solely
from files already stored against the native issue being processed — never a live
fetch to GitHub, Forgejo or any other forge. Links to attachments hosted elsewhere are
named in the prompt as not downloaded, but never fetched, authenticated to, or alerted
on. The importer's one-time copy of forge files into the native store, when an issue is
imported, is the only place a forge attachment is ever downloaded. An agent can
reach every file on its native issue — each is saved into its worktree (up to 200
images and 50 other files), with the total stated in the prompt — not a sample.
**Why:** authentication to external forges stays inside the service's own import path,
not scattered across every agent run — an agent never needs, and is never given, a
credential to reach outside Claws' own store. A 55-photo inventory issue was previously
read from a 10-image sample, so requirements and implementation worked from part of the evidence.

### Never push a core dump or oversized new file to a forge

An agent run that commits — implementer, CI fixer, review addresser or any other —
never sends a core dump (`core`, `core.<pid>`, at any path and any size) or a file new
to the branch above the repo's size limit (5 MiB unless `claws.json` sets
`maxPushFileBytes`) to GitHub or Forgejo. Core dumps are kept out of `git add`
entirely; anything that still reaches a commit makes Claws refuse the push, name the
file and the reason in the log, on the PR or issue, and in a `[claws-error]` issue, and
fail the run. Files the remote already tracks commit as before at any size.
**Why:** on 2026-10-18 an implementer committed a 4.1 GB `core` on bonkus PR #39;
serving that blob OOMKilled Forgejo on every fetch, so it crash-looped for about three
hours and every job on a Forgejo-hosted repo stalled (#clw_01M5863MC9E599TGY0S6R12VN4).

### Keep everything working when the operator switches the NAS off

The NAS stays on around the clock and headless agents prefer it over ryzen, but the operator may switch it off at any time: agents fall back to ryzen then thinkcentre, CI to the other runners, and no queue-stall or alert issue is filed because it is down. Only its disk shelf keeps a nightly schedule for backups: the nightly backup wakes the NAS head if it is off (and does nothing extra if it is already on), so backups still run whether or not the operator left it on. The NAS needs a clean manual shutdown: its shutdown hook (nixos-config) cordons it, asks Claws to evacuate its sessions ([interactive-sessions.md](interactive-sessions.md#move-every-session-off-a-node-before-it-goes-down)), lets agent pods finish or re-queue within a bounded wait, stops its runner, exports the shelf pool and powers off.
**Why:** the NAS has more memory and no desktop user, but the operator wants to turn it off when little is happening without anything alarming or failing; a NotReady NAS deliberately raises no alert (#clw_01M7Q3NQMGPNKSPNYRXC4KS7W7, 2026-11-18).
**Supersedes:** the nightly power-on/power-off cycle of the NAS head.

## Non-goals & rejected ideas

- Do not spend Claws effort on shared GitHub Actions storage: the fleet runs CI on Forgejo, so that concern is retired (#clw_01M47SAG4J7HFPSTDP6D3DE0R8).
- Do not add a container runtime to the automation host as a convenience for cleanup or verification.
- Do not treat a green staging pipeline alone as proof that session-survival cutover is safe.
- Do not monitor Kubernetes pod, node or Flux health inside Claws — Prometheus/Grafana/Alertmanager owns cluster alerting; agents may read those systems through the observability capabilities, but Claws files no alerts from them.

## Open questions

- The final production cutover sequence remains an operator-controlled operational decision.
- The shared observability contract template and scanner rules do not yet ask for resource-saturation signals; the requirement above is not yet enforced by the scanner.

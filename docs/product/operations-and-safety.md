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
**Why:** an alert must make the current state actionable rather than create notification noise.
One fault on one Deployment on 2026-10-18 produced four alert inboxes, none of which closed
when the series vanished, because the open-inbox lookup ignored retitled inboxes before #152
and the bridge reconciled against Alertmanager only on a delivery (#clw_01M59QTCER4G0N89SBV4HRG6Z1).

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
larger allowance in its own Claws settings; such a job alerts only past the allowance or when its
log goes silent. Jobs are never cancelled, and unmarked jobs alert at 45 minutes as before.
**Why:** a silent wedged job and a slow but logging one looked identical to the operator
(#clw_01M5J7SE3QNHV57FED6G6HVQW4).

### Retry a default-branch build once when it failed on a transient forge error

A default-branch run on GitHub or Forgejo that failed on a transient error — including the
forge answering a git checkout with HTTP 502 — is re-run once before any alert is filed, and
the alert is filed only if the retry fails too. The alert names the event that actually
triggered the run, as the forge records it.
**Why:** bonkus run 352 failed its checkout on a Forgejo 502, was never retried, and was filed
as a `push` build failure although Forgejo ran it on `schedule` (#clw_01M4WJFVZYBB9MV9DGVNWSFG9X).

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
`review-addresser:run` (#clw_01M583D748HW9CTRWYQ6K2FH0H); fresh agent pods also failed correctly managed repos as `Unknown repo` during a Forgejo outage (#clw_01M57ZE7VJC1GMK8FZMY2VXJQN).

### Send no Slack message for a GitHub platform outage

Claws does not monitor GitHub's public status or post outage messages to Slack. Repo-level failures from a forge outage are handled by the retry and quiet-stop behaviour above.
**Why:** the operator no longer needs those messages (#clw_01M5ADSFMXPYCT0N52MWQXGT4S).

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

### Emit a machine-parseable log line from every managed service

Every managed service must log one structured record per line to stdout using the shared
contract in `docs/logging-conventions.md`, with a lowercase string level and no secret values.
**Why:** failures must be queryable across the fleet, not only readable by eye.

### Resolve Mac runners without pod mDNS

Mac runner SSH from the Claws pod must not depend on pod mDNS (#3169). The two
registered Mac identities resolve through one code-owned LAN alias table shared
by `mac-runner-waker`, Forgejo `runner-monitor` and the Mac SSH session
capabilities, preserving explicit user
overrides without a second Secret or dotfile alias source.
**Why:** runner monitoring and waking need consistent host resolution inside Kubernetes.

### Treat a runner as online while a stale registry row shares its name

A runner name is online if any registry row with that name is idle or active; stale offline rows with the same name are logged and ignored, never probed or alerted on. A name with only offline rows is still checked, once.
**Why:** a stale row left by a re-registration made the offline alert open and close every tick, which is unactionable (#clw_01M5336HE9A9V7SW49PM7HCVB0).

### State only what the runner registry proves in a queue-stall alert

Each waiting-job cause in the queue-stall alert is tagged `confirmed:` (the org registry proves it) or `unverified:` (instance-scope runners are invisible to Claws). "Queue backlog" is claimed only when a visible matching runner is busy. Each job line carries its tag and a cause number, and each distinct cause is listed once under a numbered `**Causes**` section instead of being repeated per job. Evidence from a same-label job running on an invisible runner is marked `inference, not registry proof:`, and visible offline runners are named only when they advertise every required label. An `unverified:` no-match cause ends with one conditional remedy naming the missing labels (bring up or register a runner advertising them, or drop a retired label from `runs-on`) without claiming no runner serves them. A `beefy` no-match line instead names the on-demand hosts serving the label (nas, ryzen) with their registry status and advises powering one on, never dropping the label.
**Why:** cause lines were guesses stated as fact and the alert fired alike for ordinary backlog (#clw_01M552JP1B0BZK3Y2456TYZAV9). The 3d-models `beefy` job in #clw_01M55A0R82BEF3J9VF1Q6ECAPQ waited about 290 minutes and the operator had to investigate to learn the fix, while an invisible runner eventually served it, so the alert must advise rather than assert. The operator again had to work out the fix by hand when nas and ryzen were off (#clw_01M57DH2CA51PJ14SK49AWAFJ3). In #clw_01M57RVA7QKRS4R7PMMKA1XR3B five identical paragraphs claimed "likely backlog" and named non-matching offline nas/ryzen.

### Never alert on an unavailable Mac runner

Claws keeps waking Macs for queued macOS jobs, but a Mac that is asleep, off the
network, refusing or failing SSH, or whose runner never comes online is logged
only (no Slack notice, no `[claws-error]` issue, no alert issue) and the job
stays queued. Failures reading the forge's queued runs or jobs are
Claws' own fault and still report as errors.
**Why:** both laptops are routinely offline for long stretches, the alerts were noisy and repeatedly wrong (#clw_01M4T7BYENPV5854WJGFBX1G77), and the operator decided unavailability should surface only as work not moving (#clw_01M537H86YQX63Q2ZM1FF21R5Q).

### Raise a "Cannot SSH" runner alert only after two consecutive failed checks

A host's "Cannot SSH" alert opens only once two consecutive SSH checks to that host have
failed. A successful check resets that host's count and closes any open alert; counts are
per host, and may reset on a service restart.
**Why:** a single failure (host mid-reboot, a Mac waking, a network blip) opened an alert that closed itself on the next pass, which was noise.

### Make a "Nix is not installed" runner failure diagnosable from its own log

When the Nix setup step fails on a CI runner, its log must identify the runner and show the
state of the Nix store mount, so the failing runner can be found after a re-run replaces the log.
Runner-side logs should likewise show which store volume a runner mounted and whether it was
seeded when a job started.
**Why:** an intermittent failure fixed by a re-run left no way to tell which runner or volume was at fault.

### Bound headless-agent memory across shared service budgets

Headless agent supervision must enforce both an effective per-run memory cap and aggregate admission/backpressure when agents share a service container or node budget.
**Why:** a legitimate large agent run should have a path to completion without allowing concurrent runs to OOM the dashboard or the worker service.
In an agent pod the cap is derived from the pod's own memory limit rather than inherited from the service, so a runaway run there ends in a diagnosable Claws memory-limit kill, not a kernel OOM kill.

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
A pod that stays Pending with no stated reason is named as never scheduled, or as scheduled to a given node with no container started; it is retried once by re-queueing the row, and only a second stall raises the single `[claws-error] agent-pod:never-started` issue.
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

### A headless run whose pod vanishes is retried once when it is safe to repeat

Alongside the never-started retry above, a still-running headless run whose agent pod is
deleted outside Claws mid-run is re-queued once, with its Secret deleted and its token
cleared, for kinds that post their output only at the end (pr-reviewer, issue-refiner,
requirements-writer, escalation-reviewer). Only a second vanish raises the single
`[claws-error] agent-pod:vanished` issue, stating the pod vanished on retry. A pod Claws
deleted itself, a run that already ended, and kinds that push commits mid-run are never
retried; repo-scoped repeatable kinds keep their quiet failure. When the pod was seen being
disrupted before it disappeared, the log and failure name the reason (e.g.
`PreemptionByScheduler`) instead of a bare "agent pod not found". Agent pods should run
under a priority class that low-priority workloads cannot preempt, set with
`CLAWS_SESSION_PRIORITY_CLASS`. A pod whose container the kubelet reports lost to a node or
runtime restart (exit 255 with the kubelet's termination-message error, or an
`Unknown`/`ContainerStatusUnknown` reason) counts as a disruption too, including when found
after a Claws restart: it is retried under the same rules, and a kind that is not retried is
failed and logged as lost to a node or runtime restart without a `[claws-error]` issue.
**Why:** one cluster-side disruption, such as scheduler preemption on a full node, should
not lose an idempotent run or file an error issue.

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

### An alert bridge's token reaches only its own repo's alert issues

The token an alert bridge sends to Claws works only on `/api/alert-bridge/<its repo>/…`. There it reaches the one native issue that repo's `claws.json` names by label and the title it was filed under, plus the issues that repo files to track single alerts: native issues whose primary repo is that repo and whose dedupe key starts `alert-`. It opens no other issue and no other route, and no agent or operator credential opens those routes.
**Why:** the token runs in another repo's cluster, so a leak must cost at most that repo's alert issues. Repeat firings of a tracked alert must update its dedicated issue, not the shared alert issue, so the bridge needs to reach those issues too. A retitled inbox was invisible to the bridge, which filed three inboxes for one fault on 2026-10-18 (#clw_01M57WT147NY6J4N0X369K3F9Y).

### An issue filer's token reaches only its own repo's filed issues

The token an external issue filer sends to Claws works only on `/api/issue-filer/<its repo>/…`. There it can file an issue in that repo, look up the open issue holding a dedupe key, and attach a PNG to an issue, always within native issues whose primary repo is that repo and whose dedupe key starts with the prefix that repo's `claws.json` configures. Filing dedupes by that key alone, never by title similarity. A filed issue waits in Requirements review, and an upload posts no comment and queues no re-plan. The token opens no other issue and no other route, and no agent or operator credential opens those routes.
**Why:** growth-engine's site visits run outside Claws and must file a run's findings, with their screenshots (growth-engine #clw_01M5HZ9CEJPMS6V2DNF3S9FXWY; consolidated into one issue per run by #clw_01M5MHZ0PJZXYX2E15QR83ZHD4). A leaked token must cost at most that repo's filed issues, and similarity dedupe would merge an unrelated finding into another issue.

### Accept a rotated alert-bridge or issue-filer token within minutes of its merge

When a repository merges a new alert-bridge or issue-filer token and hash in one change, the newly deployed bridge or filer must authenticate within a few minutes, not wait out the repository-configuration cache. A rejected token triggers one fresh read of that repository's configuration before the request is refused.
**Why:** the documented rotation merges the token and hash together and the old token is gone at once; the bridge got 401s for up to 30 minutes after two rotations, so alerts were dropped (#clw_01M504RRF447J19BBKEZFAYZ0R).

### Grafana observability access needs no runtime state in Grafana

Each cluster's Grafana must accept Claws' observability credentials with nothing created in Grafana by hand and nothing copied between clusters. After a Grafana rebuild, the next request must work again as a Viewer-only identity with no operator action. Claws must keep its credentials out of argv, logs and git, and the operator must be alerted when either Grafana stops accepting them.
**Why:** the 2026-10-19 service-account tokens were Grafana database state, so a PVC rebuild would silently break both observability capabilities until an operator recreated them and carried the prod token to the fleet cluster (#clw_01M5AW39TVQ6KX2WRDZGHSN2TZ).

### Keep secret values out of operator-facing output

Configuration pages, agent prompts, arguments, logs, and diagnostic results must not
embed live secret values; a required placeholder must be conspicuous in the pull request.
**Why:** observability must not turn into a credential disclosure channel.

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

## Non-goals & rejected ideas

- Do not spend Claws effort on shared GitHub Actions storage: the fleet runs CI on Forgejo, so that concern is retired (#clw_01M47SAG4J7HFPSTDP6D3DE0R8).
- Do not add a container runtime to the automation host as a convenience for cleanup or verification.
- Do not treat a green staging pipeline alone as proof that session-survival cutover is safe.
- Do not monitor Kubernetes pod, node or Flux health inside Claws — Prometheus/Grafana/Alertmanager owns cluster alerting; agents may read those systems through the observability capabilities, but Claws files no alerts from them.

## Open questions

- The final production cutover sequence remains an operator-controlled operational decision.

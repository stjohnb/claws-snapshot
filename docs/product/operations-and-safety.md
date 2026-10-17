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

### Close a build-failure alert once its workflow is green again

A failure alert for a default-branch workflow, and a CI-fixer tracking issue for the build
it tracks, closes as completed once a later run of that workflow passes, even if the planner
marked it Claws Ignore as a transient failure and even after the issue was retitled. Open
work in flight or a Refined issue may still hold it open.
**Why:** alerts for failed builds stayed open for days after the build recovered and were closed by hand
(#clw_01M4RW0KH4CJTBWDCDKXJWM8RA).

### Retry a default-branch build once when it failed on a transient forge error

A default-branch run on GitHub or Forgejo that failed on a transient error — including the
forge answering a git checkout with HTTP 502 — is re-run once before any alert is filed, and
the alert is filed only if the retry fails too. The alert names the event that actually
triggered the run, as the forge records it.
**Why:** bonkus run 352 failed its checkout on a Forgejo 502, was never retried, and was filed
as a `push` build failure although Forgejo ran it on `schedule` (#clw_01M4WJFVZYBB9MV9DGVNWSFG9X).

### Ride out a short forge outage when cloning a managed repo

Cloning a managed repo retries transient 5xx and network errors for about half a minute. A
clone still failing after that stops quietly and a later poll cycle retries it; a
`[claws-error]` issue is filed only for a non-transient failure or a third consecutive
transient failure of the same work item within two hours. Reported clone errors omit
credential-helper noise.
**Why:** the namey requirements-writer run was filed as `requirements-writer:write:run` after a
3 s retry window on a Forgejo 502 (#clw_01M515ATCK3269BZ3RM5TYB5GR).

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
`CLAWS_SESSION_PRIORITY_CLASS`.
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

The token an alert bridge sends to Claws works only on `/api/alert-bridge/<its repo>/…`. There it reaches the one native issue that repo's `claws.json` names by label and title, plus the issues that repo files to track single alerts: native issues whose primary repo is that repo and whose dedupe key starts `alert-`. It opens no other issue and no other route, and no agent or operator credential opens those routes.
**Why:** the token runs in another repo's cluster, so a leak must cost at most that repo's alert issues. Repeat firings of a tracked alert must update its dedicated issue, not the shared alert issue, so the bridge needs to reach those issues too.

### Accept a rotated alert-bridge token within minutes of its merge

When a repository merges a new alert-bridge token and hash in one change, the newly deployed bridge must authenticate within a few minutes, not wait out the repository-configuration cache. A rejected token triggers one fresh read of that repository's configuration before the request is refused.
**Why:** the documented rotation merges the token and hash together and the old token is gone at once; the bridge got 401s for up to 30 minutes after two rotations, so alerts were dropped (#clw_01M504RRF447J19BBKEZFAYZ0R).

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
imported, is the only place a forge attachment is ever downloaded.
**Why:** authentication to external forges stays inside the service's own import path,
not scattered across every agent run — an agent never needs, and is never given, a
credential to reach outside Claws' own store.

## Non-goals & rejected ideas

- Do not spend Claws effort on shared GitHub Actions storage: the fleet runs CI on Forgejo, so that concern is retired (#clw_01M47SAG4J7HFPSTDP6D3DE0R8).
- Do not add a container runtime to the automation host as a convenience for cleanup or verification.
- Do not treat a green staging pipeline alone as proof that session-survival cutover is safe.
- Do not monitor Kubernetes pod, node or Flux health inside Claws — Prometheus/Grafana/Alertmanager owns cluster alerting; agents may read those systems through the observability capabilities, but Claws files no alerts from them.

## Open questions

- The final production cutover sequence remains an operator-controlled operational decision.

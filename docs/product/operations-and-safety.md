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
by `mac-runner-waker` and Forgejo `runner-monitor`, preserving explicit user
overrides without a second Secret or dotfile alias source.
**Why:** runner monitoring and waking need consistent host resolution inside Kubernetes.

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
while the service restarts.
**Why:** long runs — a pr-reviewer on a large PR takes ~40 minutes — otherwise lose all
progress to every deploy and can loop indefinitely on a busy day.

### Agent pods act through an enumerated Claws API, never the database

A headless agent run's pod must hold no database credentials and open no database
connection. Everything it records goes through a fixed list of named operations on the
Claws service, authenticated by the run's own token and limited to that run's work row,
job run and tasks; the list is reviewable in one place (`src/agent-pod-ops.ts`).
**Why:** least privilege — a pod's Secret must not be a database credential, the
database's network policy admits only the service, and what a pod can do must be
reviewable as a list rather than "anything SQL can".

### Keep secret values out of operator-facing output

Configuration pages, agent prompts, arguments, logs, and diagnostic results must not
embed live secret values; a required placeholder must be conspicuous in the pull request.
**Why:** observability must not turn into a credential disclosure channel.

### Emit machine-parseable service logs

Operator-facing services must emit one structured line per log event, so failures can be
queried by level, component, run and repository without regex scraping; the structured
fields are bound by the secret-output rule above.
**Why:** unattended automation must be diagnosable after the fact.

### Move only allow-listed state during a deployment cutover

A migration may copy only the operational state it needs; environment files and mounted
credentials are supplied by the destination and must never be copied as durable state.
**Why:** copied host credentials can override destination configuration or remain on persistent storage.

### Preserve database compatibility across supported deployments

The service must support its configured database backends with one logical schema and
must not replicate instance-local or oversized diagnostic state into a migration.
**Why:** a deployment migration should preserve useful history without importing avoidable risk.

### Agents read only files held in Claws' own issue tracker

At agent run time (Planner, Implementer), image and attachment context comes solely
from files already stored against the native issue being processed — never a live
fetch to GitHub, Forgejo or any other forge. Links to attachments hosted elsewhere are
named in the prompt as not downloaded, but never fetched, authenticated to, or alerted
on. The importer's one-time copy of forge files into the native store, when an issue is
imported, is the only place a forge attachment is ever downloaded.
**Why:** authentication to external forges stays inside the service's own import path,
not scattered across every agent run — an agent never needs, and is never given, a
credential to reach outside Claws' own store.

## Non-goals & rejected ideas

- Do not add a container runtime to the automation host as a convenience for cleanup or verification.
- Do not treat a green staging pipeline alone as proof that session-survival cutover is safe.
- Do not monitor Kubernetes pod, node or Flux health inside Claws — Prometheus/Grafana/Alertmanager owns cluster alerting.

## Open questions

- The final production cutover sequence remains an operator-controlled operational decision.

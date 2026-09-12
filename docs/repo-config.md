# Per-repo `claws.json`

**Reference.** Read this when you're onboarding a repo or adding a per-repo
setting. For host-level config keys and env vars, read configuration.md
instead.

`claws.json` at the **root of a repo's default branch** is how a repo opts into
Claws automation. It is **required**, on GitHub and on Forgejo alike: a repo
without one is not discovered at all — no work queue, no jobs, no dashboard
entry, no issues, no PRs. Committing the file is what brings a repo under
Claws; deleting it takes the repo back out.

This is also the extension point for per-repo settings. New per-repo knobs
belong here, in the repo that they describe, rather than as another map in
`~/.claws/config.json` on the automation host.

## Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` keeps the file but pauses all automation for the repo — the same effect as deleting it, without losing the rest of the settings. |
| `disabledJobs` | string[] | `[]` | Job names that must never run on this repo. Use the names shown as columns on the dashboard's [`/jobs` matrix](OVERVIEW.md#per-repo-job-disabling) — that page is the authoritative list. |
| `runners` | string[] | `[]` | Runner labels this repo's CI needs. `"macos"` enrols the repo in `mac-runner-waker`'s polling, which wakes a sleeping Mac when one of its jobs queues. Unioned with the host's `macRunnerRepos` (#2898). |
| `prodAlertWorkflows` | string[] | `[]` | Workflow names whose default-branch failure also pages the prod-alerts Slack channel, on top of the usual alert issue. Case-sensitive. Unioned with the host's `prodAlertWorkflows` entry for this repo (#2898). |
| `mainBuildIgnoreWorkflows` | string[] | `[]` | Workflow names `main-build-monitor` must never file build-failure issues for. Case-sensitive. Unioned with the host's `mainBuildMonitorIgnoreWorkflows` entry for this repo (#2898). |
| `dependabotIgnoredAdvisories` | string[] | `[]` | `GHSA-...` IDs `dependabot-alert-monitor` must suppress for this repo. Unioned with the host's `"*"` global list and its entry for this repo (#2898). |
| `notes` | string | — | Free text for humans. Claws never parses it. |

Unknown keys are **ignored, not rejected**, so a repo can adopt a key a newer
Claws understands without breaking discovery on an older one.

Jobs listed in `disabledJobs` are disabled *by the repo*, so they render greyed
out and locked on the `/jobs` matrix and the dashboard cannot re-enable them.
The two never fight: the file wins for the jobs it names, and the dashboard's
`disabledJobsByRepo` still covers everything else. The effective disable set is
the union of the two.

## Minimal file

```json
{
  "enabled": true,
  "notes": "Opted into Claws automation."
}
```

`{}` is equally valid: an empty object means "monitored, everything on".

## Example — turning off the repo-wide scanners

A repo that vendors upstream code the repo-wide scanners must not run over
can disable them explicitly.

```json
{
  "enabled": true,
  "disabledJobs": ["doc-maintainer", "improvement-identifier", "idea-suggester", "repo-standards", "issue-auditor", "scanner-dispatcher"],
  "notes": "Vendored upstream code — repo-wide scanners must not run over it."
}
```

`scanner-dispatcher` gates every deterministic sub-scanner in one name.

`St-John-Software/forgejo` was the live example until 2026-09-08; it is now a
small patch-and-build repo (`UPSTREAM_VERSION` + `patches/`) rather than an
upstream clone, so it runs with a default `{"enabled": true}`.

## Precedence — the file and the host config are unioned

Every key above that has a host-config counterpart is **additive**: the
effective value is the union of the host's entry for the repo and the repo's
own list. Neither side can subtract from the other. The host config remains the
operator-level override — useful for a one-off from the dashboard, or for a
repo Claws must configure before a PR against it can land — but the repo file
is where a setting should live once it is settled.

`disabledJobs` is the shape of this: jobs it names render greyed out and locked
on the `/jobs` matrix, and the dashboard's `disabledJobsByRepo` covers
everything else.

Because the file wins for what it names, the host config is **pruned on Save**
so it does not keep a stale shadow of every repo file (#2936). Saving the
`/jobs` matrix drops any `disabledJobsByRepo` job name that the repo's own
`claws.json` already names, and saving the config page drops any
`macRunnerRepos` entry for a repo whose file declares `runners: ["macos"]`.
The effective disable set and the effective Mac-runner set are unchanged by
the prune — only the redundant copy goes. Pruning is gated on a *present,
parsed* `claws.json` for an enabled repo: a repo whose file was missing or
unreadable at the last discovery, or whose file sets `enabled: false`, has its
host entries left exactly as they were — the same fail-open rule discovery uses.

The same Save also drops job names that are no longer jobs at all — a name in
neither the `/jobs` matrix's `REPO_JOB_NAMES` nor the scheduler's registered
job list (#2936). A name that *is* a registered job but not yet a matrix
column is still carried forward, so adding a job stays safe (#2625). Both
prunes log a single line naming what was dropped.

Two host maps have no repo-side home and stay whole on the host:
`dependabotIgnoredAdvisories`' `"*"` global list (it describes the fleet, not a
repo), and `publicSnapshots` (see the audit below).

## Host-config audit (#2898)

Every per-repo-looking key in `~/.claws/config.json` was audited for whether it
belongs here instead. The decisions:

| Host key | Decision | Repo-side key | Precedence |
|---|---|---|---|
| `disabledJobsByRepo` | **Keep both** — the dashboard stays the operator override; entries for unmonitored repos, dead job names, and jobs the repo file already locks are pruned on Save (#2936) | `disabledJobs` | union; the file's entries are locked and uneditable in the dashboard |
| `macRunnerRepos` | **Moved** — "this repo's CI needs a Mac" is a property of the repo's workflows; the runner *hosts* (`macRunners`) stay on the host | `runners: ["macos"]` | union |
| `prodAlertWorkflows` | **Moved** — which of a repo's workflows page the prod-alerts channel is repo knowledge | `prodAlertWorkflows` | union per repo |
| `mainBuildMonitorIgnoreWorkflows` | **Moved** — same | `mainBuildIgnoreWorkflows` | union per repo |
| `dependabotIgnoredAdvisories` | **Moved**, except the `"*"` global list | `dependabotIgnoredAdvisories` | union of `"*"` + host repo entry + repo file |
| `publicSnapshots` | **Keep on host** — this file is published verbatim into the public target, so a repo-side `scrubPaths` would publish the very inventory of paths judged too sensitive to publish (`src/config.ts` is scrubbed from the claws pair precisely to avoid that). A pair is also joint state about two repos, only one of which is Claws-managed | — | — |
| `itemTimeoutOverrides` | **Keep on host** — per-item, not per-repo, and auto-written by timeout escalation at runtime | — | — |
| `skippedItems` / `prioritizedItems` | **Keep on host** — per-item operator state mutated live by the dashboard and MCP; a PR round-trip per skip is the wrong loop | — | — |
| `selfRepo`, `fleetInfraRepo`, `prodK8sRepo`, `homeAssistantConfigRepo` | **Keep on host** — bootstrap ordering. These are read at server start, before discovery has populated the `claws.json` cache, and `selfRepo` gates discovery itself, so a repo-side `role` would be unreadable at the moment it is needed | — | — |
| `forgejoRepos` | **Keep on host** — an emergency override for a set that is otherwise discovered from Forgejo; a repo-side key could not exclude a repo Claws has not yet read (#2952) | — | — |

Out of scope throughout: host/operator state (tokens, runner hosts, intervals,
schedules, provider settings, Slack/email wiring, `allowedActors`).

## `claws.json` is not published

`claws.json` is in `public-snapshot-sync`'s `SCRUB_PATHS`, so it is removed
from every public mirror before publishing. It is Claws development-process
metadata, and — since it is the mandatory discovery gate — a published copy
would opt the mirror into automation if its owner were ever added to
`githubOwners`.

## How Claws reads it

Read at repo discovery (`fetchRepos()` in `src/github.ts`), through the same
`fetchRepoFileContent` that routes by forge, four repos at a time.

- **Present** — cached for 30 minutes.
- **Absent** — a definitive 404 on the default branch. Re-checked at every
  discovery (~5 minutes), not held for the TTL: an unmonitored repo is usually
  a repo someone is mid-way through onboarding, and it must not have to wait
  half an hour.
- **Unreadable** — a transport error, or JSON/schema that does not parse. Both
  fail **open**: a malformed file is treated as defaults, and a failed fetch
  leaves the previous decision standing (or, if there is none, leaves the repo
  monitored). Only a definitive 404 ever unmonitors a repo, so one flaky API
  call cannot take the fleet dark.

Every discovery logs a single aggregated warning naming each repo it dropped
and why (`no claws.json` vs `claws.json "enabled": false`).

`listPublicReposIncludingArchived()` — the public-repo hygiene scan — is
deliberately exempt: it is not the automation set and does not require the
file.

# Per-repo `claws.json`

**Reference.** Read this when you're onboarding a repo or adding a per-repo
setting. For host-level config keys and env vars, read configuration.md
instead.

Product requirements: [product/automation-lifecycle.md](product/automation-lifecycle.md)

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
| `runners` | string[] | `[]` | Runner labels this repo's CI needs. `"macos"` enrols the repo in `mac-runner-waker`'s polling, which wakes a sleeping Mac when one of its jobs queues. Unioned with the host's `macRunnerRepos` (#2898). Needs `forgejoAdminToken` configured on the host, since the runner/job reads require org-Owner access (#3099). |
| `prodAlertWorkflows` | string[] | `[]` | Workflow names whose default-branch failure also pages the prod-alerts Slack channel, on top of the usual alert issue. Case-sensitive. Unioned with the host's `prodAlertWorkflows` entry for this repo (#2898). |
| `mainBuildIgnoreWorkflows` | string[] | `[]` | Workflow names `main-build-monitor` must never file build-failure issues for. Case-sensitive. Unioned with the host's `mainBuildMonitorIgnoreWorkflows` entry for this repo (#2898). |
| `incidentLabels` | string[] | `[]` | Labels that mark an issue as a live incident. Such an issue takes the `Priority` claim slot in the work queue and the reserved priority-only express worker, so its first plan starts within one dispatcher cycle. `grafana-alert` is always included. Case-sensitive; unioned across every enabled repo. |
| `notes` | string | — | Free text for humans. Claws never parses it. |
| `description` | string | — | One-line "what this repo is", used by the WhatsApp voice-note router to choose a repository. First line only, capped at 200 characters. |
| `autoPromote` | `{ bugsAndAlerts?: boolean }` | `{}` | `bugsAndAlerts` covers an issue whose requirements record is `kind: bug`, or that carries the `alert`/`grafana-alert` label (or an imported alert-bridge body) — such an issue is promoted from Drafting or Requirements review to Planning as soon as its first requirements version exists, regardless of source, unless `bugsAndAlerts: false` puts it back under the source default (default: `true`). There is no per-source setting (`attended`/`unattended` were removed; stale keys are ignored). A per-issue choice — the New issue form's Requirements radio, or `claws_create_issue`'s `autoPromote` — overrides it. See [issue-tracker.md#requirements](issue-tracker.md#requirements). |
| `issuePreviewSummaryUrl` | string | — | Template for a PR-less issue preview's summary JSON, with `{issue}` and `{sha8}` placeholders. Must start with `https://`; an invalid value is dropped with a warning. Optional: when unset and the fleet pages host is configured, it defaults to `<CLAWS_PAGES_BASE_URL>/<lowercase repo name>/issue/{issue}/{sha8}/preview-summary.json`; set it only to publish elsewhere. Drives `issue-preview-sync`'s branch-only preview path for a repository whose preview step pushes `claws/preview-issue-<ref>` without opening a PR. Example (3d-models, its own public bucket): `https://www.bstjohn.net/3d-models/issue-preview/{issue}/{sha8}/preview-summary.json`. See [jobs/issue-preview-sync.md](jobs/issue-preview-sync.md). |
| `avatar` | string | — | Repo-relative path of an image on the default branch that the dashboard shows beside the repo, e.g. `"docs/avatar.png"`. Must not start with `/`, contain a `..` segment or be a URL, and must end in `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` or `.svg`; an invalid value is dropped with a warning. Images over 1 MB are not shown. Until it is set, [`repo-avatar-scanner`](jobs/repo-avatar-scanner.md) keeps one issue open asking the repo to choose one. |
| `deploys` | `{ repo: string, path: string, relation?: "deploys" \| "configures" \| "provisions" }[]` | `[]` | Cross-repo relationships this repo declares: it deploys, configures or provisions the managed repo `repo`, at `path` in this repo (default relation `deploys`). The most authoritative evidence for the doc-maintainer's generated Related repositories section; use it for a relationship the scan cannot see. A malformed entry, an unmanaged `repo` or a missing `path` is dropped with a warning. Example (bstjohn-blog): `{"repo":"St-John-Software/production-infra","path":"tofu/zone.tf","relation":"provisions"}`. See [jobs/doc-maintainer.md#cross-repo-links](jobs/doc-maintainer.md#cross-repo-links). |
| `mergeWithoutChecks` | boolean | `false` | Lets the auto-merger (and `claws_merge_pr`) merge an approved PR whose head has no CI result at all. Without it, a repo with any `.yml`/`.yaml` under `.forgejo/workflows/` or `.github/workflows/` is assumed to run CI on pull requests, and a PR with no statuses or check runs holds with `checks-missing`. Set it only when the repo's workflows never report on PR heads — deploy-, release- or schedule-only CI. A repo with no workflow files needs no setting. See [jobs/auto-merger.md](jobs/auto-merger.md#no-ci-result-on-the-head-statusnone). |
| `maxPushFileBytes` | integer | `5242880` (5 MiB) | Largest file, in bytes, an agent run may push when the file is new — absent from both the PR branch and the default branch on the remote. A larger new file makes Claws refuse the push, naming the file in a `## Push refused` comment and failing the run; a file the remote already tracks commits as before at any size. Core dumps (`core`, `core.<pid>`) are refused at any size, whatever this says. Must be a positive integer; an invalid value is dropped with a warning, leaving the default. Raise it in a repo that legitimately adds large assets. |
| `longRunningJobs` | `{ workflow: string, job?: string, maxMinutes: integer, silentMinutes?: integer }[]` | `[]` | Workflows, or single jobs in them, that normally run past runner-monitor's 45-minute threshold. `workflow` is the workflow file name; `job` matches the Forgejo job name case-insensitively, and omitting it covers every job in the workflow (a job-specific entry beats a workflow-wide one). `maxMinutes` (integer 46–1440) is the job's allowance; `silentMinutes` (integer 10–240, default 20) is how long its log may stop growing, once past 45 minutes, before it is listed as possibly wedged. A marked job is listed only past `maxMinutes` or once silent; nothing is ever cancelled. A malformed entry is dropped alone with a warning. Example (fleet-infra): `{"workflow":"image-cve-scan.yml","job":"scan","maxMinutes":130,"silentMinutes":40}`. See [jobs/runner-monitor.md](jobs/runner-monitor.md). |
| `alertBridge` | `{ label: string, title: string, tokenSha256: string }` | — | The repo's alert bridge: the one consolidated alert issue it keeps, filed with exactly this `title` and `label`, and the SHA-256 (64 lowercase hex characters) of the bearer token it sends to `/api/alert-bridge/<repo>/…`. The token itself lives only in the repo's SOPS-encrypted secret; the hash is safe to commit. A rotated hash takes effect within about a minute of merging, not after the 30-minute TTL. A malformed entry is dropped with a warning, which leaves the bridge answered 401. Example (production-infra): `{"label":"alert","title":"[Alert] production-infra alerts firing","tokenSha256":"<hex>"}`. See [issue-tracker.md#alert-bridges](issue-tracker.md#alert-bridges). |
| `issueFiler` | `{ tokenSha256: string, dedupeKeyPrefix: string }` | — | Lets one external service file issues into this repo through `/api/issue-filer/<repo>/…`, look one up by dedupe key (adopting an unkeyed issue filed under a given title on a miss), update its body, close it, and attach a PNG screenshot. `tokenSha256` is the SHA-256 (64 lowercase hex characters) of its bearer token; mint both with `t=$(openssl rand -hex 32); printf '%s' "$t" \| sha256sum \| cut -d' ' -f1` and keep the token itself only in the service's SOPS-encrypted Secret. `dedupeKeyPrefix` is 2–50 characters of `a-z`, `0-9`, `.`, `_` or `-`, starting with a letter or digit and not with `alert-`; every key the filer uses must start with it. Filed issues are automation-sourced and are held in Drafting with no requirements record, and are planned from their text once the owner promotes them. A rotated hash takes effect within about a minute of merging. A malformed entry is dropped with a warning, which leaves the routes answering 401. Examples: growth-engine `{"tokenSha256":"<hex>","dedupeKeyPrefix":"site-review-"}`, production-infra `{"tokenSha256":"<hex>","dedupeKeyPrefix":"prod-report-"}`. See [issue-tracker.md#issue-filers](issue-tracker.md#issue-filers). |
| `contentModeration` | `{ endpoint: string }` | — | Opts the app this repo runs into the [content-moderator](jobs/content-moderator.md) job. `endpoint` is an `https://` URL: Claws `GET`s `<endpoint>?state=pending&limit=10` for `{ requests, guidelines }` and `POST`s `{ decision, reason, model }` to `<endpoint>/<id>`, authenticating with a 5-minute Claws JWT (`aud: content-moderation:<owner>/<repo>`) the app verifies against the Claws JWKS. A trailing `/` is trimmed. A malformed entry is dropped with a warning. |
| `completion` | `{ tokenSha256: string }` | — | Lets one service this repo runs request one-shot LLM completions through `POST /api/completion/<repo>`, attributed to this repo. `tokenSha256` is the SHA-256 (64 lowercase hex characters) of its bearer token, minted the same way as `issueFiler`'s. It must be a new token: a hash equal to this repo's `issueFiler` or `alertBridge` hash is ignored with a warning. A rotated hash takes effect within about a minute of merging. A malformed entry is dropped with a warning, which leaves the route answering 401. See [completion-api.md](completion-api.md). |

Unknown keys are **ignored, not rejected**, so a repo can adopt a key a newer
Claws understands without breaking discovery on an older one.

Planner diagnostic capabilities are maintained in Claws' own
`PLANNER_CAPABILITIES_BY_REPO` map in `src/capabilities.ts`, not in `claws.json`.
Repository configuration cannot grant credentials. The map applies to fresh
plans, refinements, follow-ups and step-back runs only; it does not change
implementers, reviewers, CI fixers or interactive-session defaults.

| Planner repos (`St-John-Software/`) | Diagnostic capability | Reason |
|---|---|---|
| `fleet-infra`, `bin-scraper`, `claws` | Fleet observability (Grafana) | Read-only fleet metrics, logs and alerts; Claws runs in this cluster. |
| `production-infra`, `namey`, `bonkus` | Prod observability (Grafana) | Read-only prod metrics, logs and alerts. |
| Every other repo (default) | Fleet observability (Grafana) | A Loki, Prometheus or alert check is run while planning, never left as an operator step. |

The Kubernetes cluster capabilities were removed (#clw_01M3EW1TJ5FPD17N8JQSHDJXAJ),
so planners hold no Kubernetes credentials; diagnostics go through Grafana.

Repos not in the map get the fleet observability default. Unconfigured capabilities are
ignored. SSH, Home Assistant control tokens, browser sessions, Forgejo admin
and provider-auth capabilities are excluded from these unattended grants.
Existing cross-repo access and repo-scoped Home Assistant MCP access remain
unchanged.

Adding a repo or capability requires a Claws code review.

Jobs listed in `disabledJobs` are disabled *by the repo*, so they render greyed
out and locked on the `/jobs` matrix and the dashboard cannot re-enable them.
The two never fight: the file wins for the jobs it names, and the dashboard's
`disabledJobsByRepo` still covers everything else. The effective disable set is
the union of the two.

A renamed job keeps its former name as an alias: `logging-conventions-scanner`
in either list still disables `observability-contract-scanner`, and the `/jobs`
matrix shows that cell disabled (or locked). Saving the matrix rewrites a
dashboard entry under the current name.

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

`publicSnapshots` has no repo-side home and stays whole on the host (see the
audit below).

## Host-config audit (#2898)

Every per-repo-looking key in `~/.claws/config.json` was audited for whether it
belongs here instead. The decisions:

| Host key | Decision | Repo-side key | Precedence |
|---|---|---|---|
| `disabledJobsByRepo` | **Keep both** — the dashboard stays the operator override; entries for unmonitored repos, dead job names, and jobs the repo file already locks are pruned on Save (#2936) | `disabledJobs` | union; the file's entries are locked and uneditable in the dashboard |
| `macRunnerRepos` | **Moved** — "this repo's CI needs a Mac" is a property of the repo's workflows; the runner *hosts* (`macRunners`) stay on the host | `runners: ["macos"]` | union |
| `prodAlertWorkflows` | **Moved** — which of a repo's workflows page the prod-alerts channel is repo knowledge | `prodAlertWorkflows` | union per repo |
| `mainBuildMonitorIgnoreWorkflows` | **Moved** — same | `mainBuildIgnoreWorkflows` | union per repo |
| `publicSnapshots` | **Keep on host** — this file is published verbatim into the public target, so a repo-side `scrubPaths` (or `publishPaths` allowlist) would publish the very inventory of paths judged too sensitive to publish (`src/config.ts` is scrubbed from the claws pair precisely to avoid that). A pair is also joint state about two repos, only one of which is Claws-managed | — | — |
| `itemTimeoutOverrides` | **Keep on host** — per-item, not per-repo, and auto-written by timeout escalation at runtime | — | — |
| `skippedItems` / `prioritizedItems` | **Keep on host** — per-item operator state mutated live by the dashboard and MCP; a PR round-trip per skip is the wrong loop | — | — |
| `selfRepo`, `fleetInfraRepo`, `homeAssistantConfigRepo` | **Keep on host** — bootstrap ordering. These are read at server start, before discovery has populated the `claws.json` cache, and `selfRepo` gates discovery itself, so a repo-side `role` would be unreadable at the moment it is needed | — | — |
| `forgejoRepos` | **Keep on host** — an emergency override for a set that is otherwise discovered from Forgejo; a repo-side key could not exclude a repo Claws has not yet read (#2952) | — | — |

Out of scope throughout: host/operator state (tokens, runner hosts, intervals,
schedules, provider settings, Slack/email wiring, `allowedActors`).

## `claws.json` is not published

`claws.json` is in `public-snapshot-sync`'s `SCRUB_PATHS`, so it is removed
from every public mirror before publishing. It is Claws development-process
metadata and the mandatory discovery gate, so it stays out of every public
copy.

## How Claws reads it

Read at repo discovery (`fetchRepos()` in `src/github.ts`), through the same
`fetchRepoFileContent`, four repos at a time.

- **Present** — cached for 30 minutes. The alert-bridge, issue-filer and
  completion APIs can re-read a present file early when a bearer token does not
  match the cached `alertBridge`, `issueFiler` or `completion`, at most once a minute per repo; a
  failed re-read keeps the cached copy.
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

# Owner requirements & constraints

This is the home for the repo owner's (@stjohnb's) stated requirements that map
to no single feature doc — cross-cutting product direction, process rules, and
explicit "do not automate this" constraints. Requirements that *do* belong to a
subsystem live in the relevant `docs/jobs/*.md` or topic doc instead, recorded
there as a constraint with its rationale.

This captures *why*, not *what changed*; see git history and
`docs/OVERVIEW.md` for the latter. Sections are grouped by subject and record
the **current** position: when a later statement supersedes an earlier one, the
newer position is stated and the supersession noted, rather than keeping a
chronological journal of both.

Maintained automatically by the `doc-maintainer` job from human-authored
issue/PR bodies and comments (bot- and Claws-authored content excluded) — see
[jobs/doc-maintainer.md](jobs/doc-maintainer.md) for how this file is
populated.

## Where subsystem requirements live

Requirements that map to a subsystem are recorded in that subsystem's own doc, as
an **Owner requirements** section (or an inline note in the module entry) next to
the behaviour they constrain — a planner working on that subsystem reads that doc,
so the requirement is in context rather than one link away. Current homes:

| Subsystem | Doc |
|---|---|
| Public-repo snapshot publishing | [jobs/public-snapshot-sync.md](jobs/public-snapshot-sync.md) |
| Dependabot alerts & remediation | [jobs/dependabot-alert-monitor.md](jobs/dependabot-alert-monitor.md) |
| Dependency-update coverage | [jobs/dependabot-config-scanner.md](jobs/dependabot-config-scanner.md) |
| Self-hosted runner OS policy | [jobs/runner-os-scanner.md](jobs/runner-os-scanner.md) |
| Waking sleeping self-hosted Macs | [modules.md](modules.md) — `jobs/mac-runner-waker.ts` |
| Actions storage/minutes quota | [modules.md](modules.md) — `jobs/actions-storage-monitor.ts` |
| Issue lifecycle & triage | [jobs/issue-dispatcher.md](jobs/issue-dispatcher.md) |
| "Process all issues" mode | [modules.md](modules.md) — `jobs/sequential-issue-processor.ts` |
| PR review, labels, and merging | [jobs/pr-dispatcher.md](jobs/pr-dispatcher.md) |
| Per-repo standards & lifecycle docs | [jobs/repo-standards.md](jobs/repo-standards.md), [jobs/doc-maintainer.md](jobs/doc-maintainer.md) |
| Dashboard & queue views | [modules.md](modules.md) — `server.ts` routes, `pages/lists.ts` |
| Home Assistant integrations | [home-assistant.md](home-assistant.md) |
| Prompt capture for analysis | [dspy-prompt-analysis.md](dspy-prompt-analysis.md) |
| Blog-post editing | [modules.md](modules.md) — `pages/blog.ts` |
| Dashboard styling, motion, mobile | [DESIGN.md](DESIGN.md) |
| Damp meter tracking & reminders | [modules.md](modules.md) — `pages/damp.ts`, `jobs/damp-reminder.ts` |
| Voice-note transcription | [whatsapp-setup.md](whatsapp-setup.md) |
| Postmortem process | [postmortem-process.md](postmortem-process.md) |

What follows is what is left: requirements that constrain Claws as a whole, or
several subsystems at once, rather than any single feature doc.

## Sessions, terminal UX, and Claude CLI operations

- Support launching a Claude session with multiple repos at once (e.g. an
  infra repo + an app repo) via a UI checkbox list (#1699).
- Session resume was broken — worktrees were deleted but conversation history
  should survive so `/resume` (or a UI resume action) works; important
  worktrees get pushed as branches anyway so deleting them is fine as long as
  history isn't lost (#1704).
- Session summaries were stuck on "Pending…" — prefer a single summary
  generated at session start over continuously regenerating one (#1706,
  explicitly rejecting the more complex continuously-updated approach); they
  should also be more informative than a generic "Idle at…" given limited
  screen space (#1882), and the list should show one row per session even
  when a session spans multiple repos (#1881); provide a way to view/resume
  session history from the UI (#1883).
- **Sessions page layout**: only *currently active* sessions belong at the top
  of the page — **"I only wanted currently active sessions at the top, not
  expired ones. Just active ones at the top, and at the bottom but active and
  expired and also give some functionality to filter them"** (#2214). This
  *supersedes* #2172's simpler "move the one combined table above the forms"
  framing. Landed as: an active-only table at the top, the create forms in
  the middle, and a combined active+ended table at the bottom with a status
  filter (All/Active/Ended) and a text search box.
- Claude's own memory (in the home directory) is fragile — losing the host
  loses the memories (#1708); needs a durable-storage answer.
- Mobile terminal usability: can't select/copy text (#1671, #1822) — fixed by
  using xterm.js's own selection/copy path instead of relying on native DOM
  copy, which was nearly invisible on the canvas-rendered terminal.
- An iOS app to interface with Claws was requested (#1818) — PWA support
  (manifest, home-screen icons) was the concrete step taken.
- `claude`'s OAuth re-login flow is painful over a narrow browser terminal —
  needed a server-side flow that surfaces the OAuth URL as easily-copyable
  text in the web UI (#2082) — landed as `/claude-auth` (the "Reauth" page).
- Explicit per-capability access model wanted (#1727): sessions should know
  which capabilities are granted, but *not* be told about ones that weren't
  ("no need to inform claude of capabilities that were not granted, that
  will just be noise"). `fleet-infra` needed its own kubectl capability,
  distinct from the existing prod-infra one, since there are two separate
  k8s clusters (#1782). SSH capabilities should be derived from a hardcoded
  list read from `.ssh/config` at refinement time, not read at runtime — and
  trimmed to the hosts that actually matter: `nas, homeassistant, k3s,
  hetzner-actions-runner, hetzner-beefy-actions, ryzen, k3s-nas, proxmox`
  (#1982).
  The `truenas` host was rebuilt as NixOS and renamed `nas` on 2026-07-27
  (#2242) — same IP, so the alias is the only change here; *supersedes* the
  `truenas` name in that list. `k3s-nas` is kept as a second alias for the
  same machine because the Kubernetes node name is load-bearing for
  `fleet-infra` volume affinity (`dot-files#272`).
  Capability checkboxes shown at session-create time should be
  filtered by which repo is selected, using an explicit
  repo→capability/SSH-host mapping (#2095), with a "view all" escape hatch
  for capabilities outside the default set. The `namey-db` capability was
  later found to be dead (pointed at a retired public DB) and removed
  entirely (#2098) — *supersedes* any earlier assumption that `namey-db` is
  one of the standard capability bundles; `docs/database-schema.md` and
  `capabilities.ts` examples were updated accordingly.

## Mis-filed issues and cross-repo routing

- #2215 ("Awtrix temperature" — a Home Assistant clock display reporting the
  wrong reading) was raised against `claws`, but Claws has no Awtrix/MQTT
  code at all — the report belonged in `home-assistant-config`. This
  prompted #2216: **"I raised #2215 in the wrong project. It would be good
  if claws could move issues that are obviously in the wrong project."**
  Landed as an issue-dispatcher/issue-refiner feature: the planner can emit a
  same-owner transfer verdict during fresh planning, which stamps a hop-guard
  marker and calls `gh issue transfer`. A step-back review caught a
  correctness bug in the first draft before merge — the transfer routing
  comment must not carry the `## Implementation Plan` header, since GitHub
  carries comments across a transfer and every "has this been planned?" check
  in the pipeline keys off that header; using it would have silently
  stranded every transferred issue as permanently unplanned in its new home.

## Agent pipeline

- **Claude Agent SDK adoption (approved, unbuilt)** (#719): asked about
  `pi-mono`/custom-agent-framework approaches and whether adopting the
  Claude Agent SDK would improve the project. The owner said yes — *"lets
  adopt the claude agent sdk. Behind a feature flag makes sense until it has
  been confirmed to work. The flag should be updatable at runtime via the UI
  without a restart of the service."* Not implemented — there is no Agent
  SDK dependency or usage anywhere in `src/`, and no such feature flag
  exists. Claws still drives Claude/Codex/OpenCode as CLI subprocesses
  (`claude.ts`'s `runCliProcess()`), not via the SDK. Treat this as
  approved-but-not-started rather than rejected if revisited.
- A reviewer/implementer deadlock was reported via a linked PR in another
  repo (vr-rooms#668) with just "Reviewer/implementer stuck" (#2128) — landed
  as a bounded rebuttal handshake in the pr-reviewer/review-addresser loop to
  escalate rather than loop forever when the two agents disagree.
- An empty repository (no commits) must never be treated as an error
  condition during refinement or implementation — the planner should continue
  refining the issue with explicit knowledge that the repo is currently
  empty, and the implementer should initialise the repo as part of the PR
  when the plan calls for it, because a freshly-created managed repo with no
  commits is a valid starting state, not a fault (#1207). No handling for
  this exists in `issue-refiner.ts`/`issue-worker.ts` today — this is an open
  gap, not yet landed.
- **Goal mode (proposed, unbuilt)**: some work (e.g. in `production-infra`)
  spans many issues/PRs before it's functional. The requested design is a
  higher-level "goal" the operator states once, with Claws managing however
  many issues/PRs are required to reach it, including monitoring deployments
  and issues opened from failed builds along the way. If this is ever built,
  goals must be created and stored via the Claws web UI and the Claws DB,
  **never** as GitHub issues — GitHub issues should stay the lower-level unit
  of work that a goal orchestrates, not become an ad hoc goal-tracking system
  themselves (#1241).
- **Backlog prioritisation (proposed, unbuilt)** (#790): with many open issues
  across repos and a finite Claude budget, the owner wants issue priority
  tracked in the Claws DB (not GitHub, whose UI isn't suited to this) —
  reorderable per-repo and globally, with per-repo reordering composing
  sensibly with the global order ("keep the solution simple"). The DB-tracked
  priority would then gate which `Refined` issues actually get implemented
  (2-3 in parallel, not all at once), and `[ci-unrelated]`-flagged issues
  should get a pass through prioritisation so PRs already blocked on CI
  issues don't deadlock waiting for their turn. What exists today is
  narrower: `config.prioritizedItems`/`skippedItems` (per-item allow/skip
  lists, not a ranked backlog) and `sequential-issue-processor.ts`'s own
  LLM-ranked ordering, scoped to its own opt-in "process all issues" mode
  (#2103) for a single repo at a time — not the general cross-repo ranking
  requested here.
- **Per-repo view and auto-process mode (built)** (#2356): with too many
  issues open to make sense of at the org level, the owner wants to look at
  one repo's open issues and PRs on their own (`/repos/:owner/:name`), and to
  flip that repo into an "auto-process mode" where an agent reviews the whole
  open backlog, identifies what is priority/duplicate/obsolete, and makes as
  much progress through it as possible — overseeing refinement, PR merging
  and deployment monitoring where it is confident. Crucially, **needing human
  input must not stop the rest of the backlog**: "if human input is required
  then it's fine to stop but try to make progress where possible while in
  this mode", which is why the processor excludes `Manual Action` issues from
  its candidate set rather than halting the repo. When input *is* awaited,
  the page carrying the toggle must make that obvious and point the owner at
  exactly where they are needed — the "Needs your input" panel. Deployment
  monitoring during the cycle was deliberately left to the existing
  `main-build-monitor-scanner` / CI alert issues rather than duplicated here,
  and cross-repo grouping remains unbuilt (see the bullet above).
- **Merge-conflict-aware parallel processing (proposed, unbuilt)** (#785):
  when multiple issues for the same repo are refined and implemented
  concurrently, they risk generating merge conflicts with each other. The
  owner wants Claws to pipeline same-repo work — start a new implementation
  once a prior one completes, or continue processing in parallel when two
  changes are unlikely to conflict — rather than a strict global queue.
  `sequential-issue-processor.ts` is *not* this feature: it's a
  fully-serialized opt-in mode for incident-heavy repos (#2103), not a
  general conflict-likelihood-aware scheduler, and `issue-dispatcher.ts`
  today only prevents duplicate dispatch of the *same* item — it has no
  cross-item conflict prediction.
- **Job health scoring with automatic circuit-breaking (proposed, unbuilt)**
  (#482): track a rolling success/failure rate per job over the last 24
  hours from the existing SQLite task data, and auto-pause a job (distinct
  from manual pause, shown differently on the dashboard) with a Slack alert
  when its failure rate exceeds a configurable threshold — the goal is to
  stop a broken job (e.g. CI fundamentally broken on a repo, so ci-fixer
  keeps failing; or a GitHub API change breaking issue-refiner) from
  burning Claude quota on repeated failures, with auto-pause lifting after a
  cooldown to retry. Not implemented — `scheduler.ts` has no failure-rate
  tracking or auto-pause path; only the manual `pausedJobs` config list and
  the unrelated per-PR `ci-fixer` circuit breaker (which pauses auto-fix on
  one PR, not the job globally) exist today.
- **Phone/voice call interface (proposed, unbuilt)** (#275): hands-free,
  conversational review and triage of open PRs and issues via a phone call —
  Claws summarises what's open, discusses priorities, and optionally updates
  labels/priorities based on the call outcome. Not implemented — the only
  voice feature that exists is one-way WhatsApp voice-note transcription
  (see [WhatsApp Setup](whatsapp-setup.md)), not a conversational call.

## Claude/provider usage limits and cost monitoring

- **Usage-threshold Slack alerts (proposed, unbuilt)** (#675): when Claude
  usage approaches the plan limit, and issues are already planned but not
  yet implemented, further planning is wasted work — the owner wants Slack
  notifications at 50%/80%/90% of usage to enable manual intervention (e.g.
  pausing further planning). `pages/usage.ts` and `db.ts`'s
  `getUsageStats()`/`getTotalUsage()` provide the raw token/cost dashboard
  this would read from, but no threshold check or alert exists yet, and
  nothing currently throttles planning based on usage level.
- Usage-limit errors ("You've hit your limit · resets ...") were spamming
  Slack and being misread as review-addressed or otherwise mishandled
  (#673, #813, #817) — classification should be robust (not brittle regex)
  and the operator asked for Ollama-based classification specifically, with
  regex only as a fallback (#826 comment). Landed as
  `ollama-rate-limit-classifier.ts` (`isRateLimitError()`, local Ollama
  classification with a regex fallback and its own circuit breaker), used by
  `claude.ts`'s provider-fallback loop to skip a rate-limited provider
  rather than fail the task. `error-reporter.ts`'s `USAGE_LIMIT_RE` downgrades
  usage-limit errors to `log.warn` (never `log.error`), which is why they no
  longer reach Slack. Note: the "pause until reset" part of the ask was
  simplified in the implementation — providers get a fixed cooldown
  (`PROVIDER_RATE_LIMIT_COOLDOWN_MS`, default 5 min) rather than the actual
  reset time parsed out of the error text.

## Infra monitoring, incidents, and postmortems

- Recurring `prod-k8s-monitor` kubeconfig alerts (#1686, #1694, #1703) traced
  to a stale kubeconfig after cluster/Tailscale node rebuilds — Claws should
  be able to refresh the kubeconfig itself via SSH (discoverable via
  Tailscale), and a multi-occurrence issue that was only ever planned once
  (at its first occurrence) needs its plan reassessed as occurrences
  accumulate, not left stale (#1703).
- A 6-hour production Flux reconciliation wedge produced **zero** Flux
  alerts despite the underlying Pod-Failed alerts firing (#1989) — root cause
  was a 2-minute grace-period suppression that a fast-failing Job flapped
  around every ~1 minute, permanently resetting the suppression window.
- A failed Node-version-mismatch deploy + failed rollback caused a ~23h
  outage (postmortem in PR #2057); action items: verify Node ABI
  compatibility before swapping in a new release (#2054, "prevent"), back up
  and restore `node_modules` alongside `dist` on rollback (#2055,
  "mitigate"), and keep re-alerting on Slack while the service stays
  unhealthy after a failed rollback, since Claws's own error-escalation path
  can't fire when Claws itself is down (#2056, "detect").
- Reduce Slack notification noise for routine UI-driven actions (issue
  refined, session created, etc.) — no human needs to be paged for those
  (#1896).
- Infrastructure (OpenTofu/Terraform) changes must always be merged by a
  conscious human action (#2275). Prod infra PRs must also be obvious in the
  Claws UI so they aren't blindly merged — never inferred solely from a
  spoofable, fail-open plan-comment signal.
- **Vercel prod log access for triage (proposed, unbuilt)** (#456): several
  repos (Kwyjibo, Namey, Perudo, Pupil Path) deploy to Vercel, and triage
  jobs would benefit from reading their prod/preview logs when investigating
  a failure. Not implemented — the only existing Vercel integration is
  `github.ts`'s PR-comment scrape for a preview deployment URL (used by
  `qa-phase` to find where to point Playwright), not log access, and no
  triage job (e.g. `triage-claws-errors`) reads Vercel logs.

## Alerting escalation & false positives

Standing expectation: alert false positives get **root-caused and fixed**, not
dismissed as noise — and an alert whose entire content is "a human should do
something", with no information the existing signals don't already carry,
should not be filed at all.

- k3s-monitor Priority alerts were detected fast but sat for hours before a
  human engaged, because the refine→implement pipeline waited for a manual
  `Refined` label and no notification reached the operator (#2088, sourced
  from a production-infra postmortem: full outage 11:39–17:01 UTC, root cause
  fixed in 12 minutes once a human noticed). Proposed auto-entering the
  pipeline and/or notifying immediately; the owner's actual direction was
  narrower than either raw option — **"I'm not sure about this. We would want
  to at least wait for the plan to be posted. Have another agent review the
  plan and if it's low risk high reward, then proceed"** — landed as
  `escalation-reviewer.ts`, a review gate that reads the posted plan and only
  auto-applies `Refined` when it judges the fix small/mechanical/revertible
  on an active incident; otherwise it holds and pings a human. This
  *narrows* the original ask in #2088 and should be treated as the
  authoritative version of that request.
- A k3s-degraded screenshot was reported with the question "Was an issue
  logged? It should be to trigger triage" (#2133) — the underlying
  expectation is that any observed cluster degradation always results in a
  filed alert issue, even for causes (like muted-node downtime) that don't
  cleanly fit the primary detection path. Landed as splitting `nodesNotReady`
  from muted-node downtime so `Degraded` status always corresponds to a filed
  alert.
- Dependabot updater run failures were going unmonitored the same way regular
  Actions job failures on `main` are monitored (#2135, prompted by a silent
  failure on another repo): "Can we monitor for errors from dependabot jobs
  like that and auto create issues as we do for all actions jobs on main
  etc." Landed as the `dependabot-run-monitor` job.
- A `main-build-monitor-scanner` alert on production-infra was reported as a
  possible false positive with the question "if it is a false positive, is
  there a fix to be made here for that?" (#2153) — confirmed false positive
  (the scanner string-matched `gh issue create`, which production-infra's
  monitor never emits since it calls a sourced shell helper); fixed to detect
  monitor workflows structurally instead of by output-string matching.
- The mac-runner-waker-ssh fingerprint recurred yet again (#2160); root cause
  was a transient mDNS resolution failure while the Mac was asleep, with a
  secondary contributing factor — the runner had lost its `tempo` custom
  label on a 2026-07-23 re-registration — confirmed and explained by the
  owner directly in the issue rather than left to automated diagnosis. A
  companion feature (PR #2162) now also alerts when a *woken* Mac's runner
  never comes back online in GitHub's registry (catching exactly this
  lost-label scenario), separately from the plain host-unreachable case.
  Validated against the real TempoStatusBar run that sat queued ~12h. Note: a
  design to stop filing `[claws-error]` issues for the structurally
  unactionable "Mac genuinely off the network" case (SSH resolver failure)
  was proposed twice (issues #2143 and #2160) but neither implementation
  merged — the fingerprint may recur again until that lands.
- #2205 ("Bad dependabot alert" — **"Sounds like it should not have been
  raised"**, linking `perudo#206`): the alert was for a Dependabot ecosystem
  entry (`terraform`) that had already been deliberately removed from
  `perudo`'s `dependabot.yml`, but GitHub retains a retired ecosystem's last
  (failing) run as the permanent "latest" for 30 days. Fixed by
  cross-checking each failing group against the repo's live config before
  reporting.
- #2218 ("Bad Ci issues" — **"Stop creating issues like this if nothing can
  be done about them"**, linking `bonkus#1652`, filed 7 times): a
  not-rerunnable CI run was already labelled `Manual Action` on the PR (the
  durable, actionable signal auto-merger honours) but *also* got a
  standalone alert issue whose entire content was "a human should push a
  commit or close/reopen the PR" — pure duplication with no new information.
  Fixed by moving the notice into the PR body's existing manual-action
  section instead of a separate issue, plus closing a second code path that
  bypassed the dead-run guard.

## Security posture and credential handling

- The security reviewer was over-flagging attacker-controlled-issue-text
  concerns given Claws is already restricted to private repos — needs to be
  told that context so it doesn't focus disproportionately on that class of
  finding (#1874).
- An OIDC-allowlist finding was rejected (#1792) because the assumed
  default-allow IdP behaviour doesn't hold here — Authentik already enforces
  group-policy bindings upstream, so a parallel in-app allowlist would
  duplicate authorization logic across two systems for no real gain; a
  documentation comment at the callback site was preferred over new code.
  Similarly, client-supplied `X-Forwarded-For` for audit-log attribution was
  judged not worth trusting or even keeping if it's unreliable and only used
  for logging (#1988) — simplest fix is to drop it, not harden it.
- `github-app`'s in-memory installation-token cache could get poisoned and
  serve a bad value for the lifetime of the process, and `assertSafeToken`
  had two latent guard bugs: `null`/`undefined` passed validation and got
  interpolated into the credential helper as literal text, and an empty
  token was misreported as "unsafe characters" rather than "empty" (#2137).
  Notably, the issue's own initial diagnosis (blaming the regex for
  rejecting a JWT) was **wrong and explicitly corrected by the owner** after
  a structural probe showed the mint path was healthy — the real defect was
  process state (the cache), not the validation regex. When re-reading this
  issue for context, prefer the correction comment over the original body.
  Net assessment: not an active outage, but the
  silent-fallback-to-ambient-credentials behavior was flagged as still worth
  fixing. Landed as PR #2141 (self-healing poisoned cache, stop splicing
  tokens into shell source).
- The Home Assistant long-lived access token was passed as a literal argv
  string when spawning a session's tmux server, world-readable via
  `/proc/<pid>/cmdline` to any local user or via `ps`/`systemctl status`
  output — inconsistent with every other secret in the same spawn command,
  which are explicitly scrubbed with `env -u` (#2138). Token treated as
  compromised and flagged for rotation (rotation is an out-of-band manual
  step, not something Claws should automate). Landed as PR #2140 (capability
  credentials moved to a session env file instead of argv).
- **Pre-push diff safety scanning (proposed, unbuilt)** (#667): before
  `pushBranch()` (`claude.ts`) sends a task's commits to GitHub, the owner
  wants a safety pass over the diff — secrets/credentials, unexpected
  modifications to infra files (`.github/workflows/`, `deploy/`,
  `Dockerfile`) when the task was scoped to application code, new outbound
  network calls to domains not already present in the codebase, and large
  binary files — skipping the push and alerting on Slack for human review if
  any check trips. `pushBranch()` today does fetch/rebase/push with retry
  but no diff inspection of any kind; this would be defense-in-depth given
  Claude runs with `--dangerously-skip-permissions`.
- **Committed-secrets scanning coverage gap** (#669): the owner asked for a
  daily job scanning *all* cloned repos' tracked files plus the last 50
  commits of history for accidentally-committed secrets (AWS/GitHub keys,
  private keys, high-entropy `*_KEY`/`*_SECRET`/`*_TOKEN` values, `.env`
  files). What exists, `public-repo-scanner.ts`, only covers **public**
  repos (weekly, not daily) and only scans the current HEAD of the tracked
  working tree — it does not walk git history, and private repos have no
  secrets-scanning coverage at all. (`public-snapshot-sync.ts`'s
  `scanTreeForSecrets`/`scanTextsForSecrets` is a separate, narrower
  fail-closed check that runs only when publishing a private→public
  snapshot, not a general private-repo scanner.)

## Capturing owner requirements for future agents

- The purpose of capturing human-authored issue/PR content at all is stated
  plainly (#2227): *"I just want a good capture of my requirements to be
  available to future agents planning features."* The **full history** must
  contribute, not just a recent window — the original #2090 instruction to
  process all available issues and PRs on the initial pass was capped in
  practice, leaving everything before 2026-06-13 unscanned.
- The capture must live in **the standard feature docs a planning agent
  already reads**, not a parallel artifact: *"Maybe the scheduled job just
  becomes a scanner that ensures that any human comments, if relevant, are
  reflected in the standard feature docs."* This *supersedes* the earlier
  `docs/intent-log.md` chronological-journal design (#2090), which has been
  retired — a journal forced a planner to resolve it into current truth, and
  it was one link among many in `OVERVIEW.md`. Subsystem requirements now
  belong in the doc that owns the subsystem; cross-cutting ones belong here.

## Other

- The `idea-suggester` job repeatedly logged "Slack bot not configured" even
  though "Slack" (the incoming-webhook integration) was configured — asked
  whether the separate, unconfigured "Slack Bot" integration could be
  decommissioned in favour of the one already in use everywhere (#1071).
  When "Openrouter is out of credits" caused an `email-monitor` failure,
  fall back to Claude for that task instead of failing (#1764).
- Bookmark-based PR searches broke after Claws switched from a personal
  `gh auth login` account to GitHub App installation tokens for its own `gh`/
  `git` calls (#2104) — PRs are now authored by the App's bot identity
  (`clawsstjohn[bot]`, i.e. `app/clawsstjohn`), which GitHub's involvement-
  scoped dashboard search doesn't match under a `user:` filter. No code
  defect; the resolution is to filter by `author:app/clawsstjohn` instead.
- **Dashboard mutation audit trail — partial coverage** (#668): the ask was
  for every mutating dashboard action (config changes, job pause/resume,
  item skip/prioritize, PR merges, task cancellations, WhatsApp unpair) to
  Slack-notify with actor IP and old/new values, as a lightweight audit
  trail. What's built (`config.notifyDashboardActions`, default on, gating
  `notify()` calls in `server.ts`) covers job pause/resume, activation-state
  changes, the job-toggle matrix, config field updates (with redacted
  old→new diffs for sensitive keys), and WhatsApp pair/unpair — but not
  queue actions (`/queue/skip`, `/queue/unskip`, `/queue/prioritize`,
  `/queue/deprioritize`, `/queue/merge`), `/cancel`, or actor IP (no request
  IP is captured anywhere in `server.ts`). If the queue/cancel gap or IP
  attribution is ever raised again, treat it as still open rather than
  already satisfied by `notifyDashboardActions`.
- Explicitly rejected feature ideas (pr-341, no rationale given beyond not
  wanting them): per-repository job configuration, Slack slash commands for
  remote control, and a configurable retry policy for failed tasks. Treat
  these as declined unless raised again with a concrete driving case.

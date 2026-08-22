# Claws — Overview

Claws is a self-hosted
GitHub automation service. It polls GitHub repositories on configurable timers,
identifies work items via comment analysis, reactions, and PR state, and
delegates tasks to the Claude CLI in isolated git worktrees. It runs as a
Linux systemd service.

## Architecture

> **See also:** [ARCHITECTURE.md](ARCHITECTURE.md) for visual Mermaid diagrams of the same architecture (system overview, module layering, dispatcher fan-out, issue/PR lifecycles, Claude invocation path). [modules.md](modules.md) is the full per-file module reference (exports, gotchas, design rationale) that this doc's Architecture tree summarizes. [patterns.md](patterns.md) is the full detail (code examples, edge cases, rationale) behind this doc's Key Patterns index. [configuration.md](configuration.md) is the full config key / env var / default reference behind this doc's compact Configuration table. [claws-automation.md](claws-automation.md) describes how Claws automates this repository's issue/PR lifecycle (maintained automatically — do not edit). [postmortem-process.md](postmortem-process.md) describes how to run a blameless postmortem after an incident in any managed repo. [requirements.md](requirements.md) records the repo owner's cross-cutting requirements and constraints (subsystem-specific ones live in the relevant job/topic doc). [capabilities-scala3.md](capabilities-scala3.md) answers issue #2556 — how Claws' session capability model maps onto Scala 3's capture-checking system (analysis only; no Scala is built or shipped).

Full per-file detail (exports, gotchas, design rationale) lives in [modules.md](modules.md); the tree below is a compact map of the entire `src/` directory.

```
src/
├── main.ts                          Entry point — PID lock, DB init, crash/work-queue recovery, job registration, shutdown
├── config.ts                        Configuration loading (env > config.json > defaults), INTERNAL_MCP_TOKEN, live reload
├── scheduler.ts                     Interval/schedule-based job runner — skip-if-busy, triggers chains, pause/resume
├── smart-schedule.ts                Smart-scheduling gate — staleness-based per-repo selection with SLO escape valve; shared daily-repo-loop helpers
├── github.ts                        gh CLI wrapper — retry, rate-limit circuit breaker, queue cache, Zod-validated parsing
├── github-app.ts                    GitHub App auth — JWT signing, per-owner installation tokens, git credential env
├── claude.ts                        Claude/Codex/OpenCode CLI runner — worktree helpers, env sanitization, push/rebase
├── db.ts                            SQLite database (better-sqlite3) — 19 tables for tasks, queue, sessions, usage, etc.
├── server.ts                        HTTP server (Hono) — dashboard, health, status, manual triggers, WebSocket bridge
├── capabilities.ts                  Session capability registry — gated capability bundles, ssh:<alias> capabilities, env stripping for sessions, browser (Playwright MCP) capability
├── sessions.ts                      Interactive PTY session manager — tmux-backed, capability-gated env, multi-worktree
├── log.ts                           Timestamped logging (four levels) + Slack error escalation
├── slack.ts                         Slack incoming-webhook + Bot API (ideas, notifications)
├── model-selector.ts                Provider-aware model selection (Claude/Codex/OpenCode, cheap/sonnet/opus tiers, config override)
├── classify-complexity.ts           Lightweight Claude call classifying whether a task warrants opus-level reasoning
├── ollama-rate-limit-classifier.ts  Ollama-based rate-limit error classification with regex fallback
├── error-reporter.ts                Deduplicating GitHub issue-based error reporter (30 min cooldown, filters transient errors)
├── agent-auth-state.ts              Latched "claude CLI credentials expired" state — one Slack alert + one [claws-error] issue per episode instead of one per task; cleared by the next successful claude run or a web re-auth
├── images.ts                        Image/attachment extraction, SSRF-guarded download, for issue/PR context
├── whatsapp.ts                      WhatsApp Web client (Baileys) — QR pairing, message routing, Slack pairing alerts
├── transcribe.ts                    Voice-note transcription — local/remote Whisper with circuit breakers, OpenAI fallback
├── format.ts                        Duration formatting (formatMs: milliseconds → human-readable)
├── version.ts                       Build-time injected version string
├── plan-parser.ts                   Parses structured implementation plan comments into phases
├── timeout-handler.ts               Central per-item Claude timeout escalation and auto-skip
├── outcome.ts                       Task outcome builders (success/failure metadata, failure categorization)
├── occurrence-tracking.ts           Shared helpers for recurring alert issues (ensureAlertIssue, closeAlertIssueIfResolved, etc.)
├── prompt-guard.ts                  Prompt injection detection and content redaction for untrusted GitHub text
├── mcp-server.ts                    Standalone stdio MCP server exposing Claws state to Claude sessions
├── ha-mcp.ts                        Standalone HA MCP handler — ha_list_entities/ha_api_request with strict path validation
├── worker.ts                        SQLite-backed work queue — worker fibers, registered handlers, crash recovery
├── work-handlers.ts                 Registers per-kind work handlers with worker.ts; wires auto-merger sweep chain
├── retry.ts                         retryWithBackoff() — generic exponential-backoff retry helper extracted from gh()/git()
├── rate-limit.ts                    GitHub API rate-limit circuit breaker — RateLimitError, cooldown state, shared by github.ts/github-app.ts
├── github-status.ts                 GitHub-wide incident state — polls githubstatus.com summary.json; gates error-reporter suppression and ci-fixer's incident pause; records recent incident windows for agent prompts
├── claude-auth.ts                   Server-side orchestration of the claude setup-token OAuth flow via node-pty
├── json-extract.ts                  Multi-strategy JSON extraction/repair for LLM outputs; isCompleteJson() truncation detection
├── util.ts                          sleep(), resolveIdentityFile(), mapWithConcurrency()/mapSettledWithConcurrency() bounded-concurrency helpers
├── sensitive-env.ts                 Exports SENSITIVE_ENV_KEYS — zero-dependency leaf module for capabilities.ts
├── session-env-file.ts              Per-session capability env files — writes/prunes 0600 credential files for spawned sessions; also owns the per-session MCP-config/browser-profile dir
├── session-uploads.ts               Per-session upload dir — sanitized writes, 10 MB inline / 1 GB streamed, per-session quota
├── ssh.ts                           Shared SSH/scp helpers — buildSshArgs, execCapture, isSafeAbsolutePath path validation
├── home-assistant.ts                Home Assistant REST API client — listStates, callService, update installation; plus a WebSocket registry client (withHaWebSocket, area/entity registry read + entity area update)
├── mcp-result.ts                    Shared MCP tool-result helpers (ToolResult, textResult, errorResult)
├── shutdown.ts                      Graceful shutdown flag + ShutdownError class (shared across modules)
├── test-helpers.ts                  Test factories (mockRepo, mockIssue, mockPR)
├── pwa.ts                           PWA support — manifest, inline SVG icon, PNG rasterization; no service worker
├── resources/
│   ├── claws-info.ts                  Exports CLAWS_AUTOMATION_DOC — canonical claws-automation.md content (lifecycle, labels, PRs-only convention), synced by doc-maintainer
│   ├── marketing.ts                   Marketing knowledge resource for idea-suggester prompts
│   ├── alpinejs.ts                    Exports ALPINE_JS_SOURCE — Alpine.js bundle served at /static/alpine.js
│   ├── chartjs.ts                     Exports CHARTJS_SOURCE — vendored Chart.js v4.5.1 UMD served at /static/chart.js
│   ├── tailwind-css.generated.ts      Exports TAILWIND_STYLESHEET — generated Tailwind CSS link tag
│   ├── error-handler.generated.ts     esbuild bundle of client/error-handler.ts — ERROR_HANDLER_SCRIPT
│   ├── auth-watch.generated.ts        esbuild bundle of client/auth-watch.ts — AUTH_WATCH_SCRIPT
│   ├── queue.generated.ts             esbuild bundle of client/queue.ts — QUEUE_SCRIPT
│   ├── sessions-list.generated.ts     esbuild bundle of client/sessions-list.ts — SESSIONS_LIST_SCRIPT
│   ├── session-terminal.generated.ts  esbuild bundle of client/session-terminal.ts — SESSION_TERMINAL_SCRIPT
│   └── damp-chart.generated.ts        esbuild bundle of client/damp-chart.ts — DAMP_CHART_SCRIPT
├── client/
│   ├── error-handler.ts     Client-side window.onerror + unhandledrejection handler, POSTs to /api/client-error
│   ├── auth-watch.ts        Stale-session detection and automatic OIDC re-login on page restore
│   ├── queue.ts             Client-side queue page interactions — skip/prioritize/refresh buttons
│   ├── sessions-list.ts     Client-side sessions list page interactions
│   ├── session-terminal.ts  xterm.js terminal — WebSocket PTY bridge, custom copy/paste handling, mobile keys
│   └── damp-chart.ts        Interactive Chart.js /damp readings chart — tap a line/legend entry to isolate one series (#2566/#2567)
├── pages/
│   ├── dashboard.ts    Main status page HTML builder
│   ├── queue.ts        Work queue page HTML builder
│   ├── logs.ts         Log list, detail, and issue logs page HTML builders
│   ├── config.ts       Config editor page HTML builder
│   ├── topology.ts     Pipeline topology visualization page (SVG diagram, live status)
│   ├── whatsapp.ts     WhatsApp status/pairing page HTML builder
│   ├── sessions.ts     Session list + terminal page HTML builders; mobile-friendly layout
│   ├── jobs-matrix.ts  Per-repo job enable/disable matrix page HTML builder
│   ├── ha-upgrader.ts  Home Assistant update state page HTML builder
│   ├── damp.ts         Damp meter reading page (/damp) — 15 fixed points, interactive Chart.js chart, mobile logging form
│   ├── k8s.ts          Kubernetes integrations page — monitor status for k3s and prod-k8s clusters
│   ├── repo.ts         Per-repo detail page HTML builder — recent tasks, open queue items, auto-process toggle, needs-input panel; repo list page with open PR/issue counts and sortable columns
│   ├── lists.ts        Cross-repo aggregate list pages (/prs, /issues) with shared Actions column
│   ├── claude-auth.ts  Reauth page HTML builder (/claude-auth) driving the OAuth login flow
│   ├── runners.ts      Self-hosted runner utilization page HTML builder (/runners)
│   ├── usage.ts        Token/cost usage dashboard HTML builder (/usage) by repo/job/provider+model
│   ├── verify.ts       Connectivity verification report page HTML builder (/verify)
│   ├── blog.ts         Blog post editor page HTML builder (/blog) — plain CRUD over GitHub content
│   └── layout.ts       Shared layout — header, theme, nav, mobile data-cards CSS, PWA head meta
├── agents/
│   ├── issue-refiner.ts             Per-item planning functions (fresh plan, refinement, follow-up); opus-tier, step-back critique, occurrence markers
│   ├── issue-worker.ts              Per-item implementation functions (create PR, continue phases); diff-derived PR titles
│   ├── ci-fixer.ts                  Per-item CI fix functions (identify, fix, conflicts, unrelated); major-bump tracking issues
│   ├── review-addresser.ts          Per-item review addressing functions; edits summary comment in place, stamps rebuttals
│   ├── pr-reviewer.ts               Per-item PR review functions; edits review comment in place, escalates after 8 rounds
│   ├── auto-merger.ts               Per-item merge function (tryMerge); LGTM-exempt categories for dependabot/docs/bump PRs; never auto-merges infra (tofu/terraform) PRs; re-reads live PR state (labels, head SHA, check rollup) uncached immediately before merging and pins the merge with `--match-head-commit` (#2354)
│   ├── problematic-pr-diagnoser.ts  One-shot deep-diagnosis pass for PRs flagged Claws Problematic
│   ├── escalation-reviewer.ts       Auto-escalation gate for Priority cluster-monitor alerts; proceed/hold verdict
│   └── agent-context.ts             Shared tool-context strings + formatIssueCommentsForPrompt() for agent prompts
└── jobs/
    ├── issue-dispatcher.ts              Unified issue dispatcher — orchestrates planner + implementer agents
    ├── sequential-issue-processor.ts    Opt-in "auto-process" mode for incident-heavy repos; serializes via Refined label, marks duplicates, closes obsolete issues
    ├── pr-dispatcher.ts                 Unified PR dispatcher — orchestrates CI fixer + review addresser + reviewer + merger
    ├── superseded-dependabot-sweep.ts   Closes Problematic dependabot PRs once their major-bump tracking issue is closed and every bump re-verifies against the base branch's lockfile (#2427)
    ├── scanner-runner.ts                Shared scanner runner (per-repo fan-out, max 4 concurrent); renderViolationTable(), walkRepoTree()/DEFAULT_SKIP_DIRS bounded-depth repo walker, and exact-title dedup helpers
    ├── workflow-parser.ts               YAML workflow parser utility — parseWorkflow(), listParsedWorkflows(), listWorkflowFiles()
    ├── connectivity-verifier.ts         On-demand connectivity checker for verify-only mode (DB, GitHub App, CLIs, Slack, etc.)
    ├── triage-claws-errors.ts           Investigates internal Claws errors ([claws-error] issues)
    ├── doc-maintainer.ts                Nightly documentation generation/update; syncs claws-automation.md; folds human intent into the feature docs
    ├── repo-standards.ts                Syncs labels and cleans legacy labels for each managed repo
    ├── improvement-identifier.ts        Reviews codebases for security issues/improvements; files issues, conditional Web/SEO suggestions
    ├── public-repo-scanner.ts           Daily scan of public repos for accidentally-committed sensitive data
    ├── idea-suggester.ts                Suggests new ideas per repo and files the top-scoring ones as GitHub issues
    ├── issue-auditor.ts                 Daily audit ensuring no issues fall between the cracks
    ├── whatsapp-handler.ts              Interprets WhatsApp messages via Claude, creates GitHub issues; isolated scratch dir
    ├── runner-monitor.ts                Monitors self-hosted GH Actions runners via SSH
    ├── host-disk-monitor.ts             Monitors the disk of Claws' own host locally; non-Docker cleanup + container-runtime tripwire
    ├── mac-runner-waker.ts              Wakes sleeping self-hosted Macs over SSH via caffeinate; verifies runner comes online
    ├── scanner-dispatcher.ts            Runs scanners sequentially (ubuntu-latest, concurrency, migration, and 8 more)
    ├── ubuntu-latest-scanner.ts         Scans workflows for non-self-hosted runners, creates alert issues
    ├── concurrency-scanner.ts           Scans workflows for missing/misconfigured concurrency groups
    ├── migration-scanner.ts             Scans repos for incrementally-numbered migrations, recommends date stamps
    ├── main-build-monitor-scanner.ts    Scans workflows for main-branch builds/scheduled jobs lacking failure monitoring
    ├── cache-on-self-hosted-scanner.ts  Scans workflows for unnecessary caching steps on self-hosted runners
    ├── issue-comment-spam-scanner.ts    Scans workflows for comment-spam pattern instead of editing issue body
    ├── runner-os-scanner.ts             Flags self-hosted runner jobs missing a linux/macos OS label
    ├── claude-config-scanner.ts         Scans repos for missing CLAUDE.md and named subagents
    ├── gitignore-scanner.ts             Scans repos for a missing .mcp-claws.json entry in .gitignore
    ├── dependabot-config-scanner.ts     Flags dependency manifests uncovered by dependabot.yml/Renovate config
    ├── design-guidelines-scanner.ts     Scans UI repos for missing design guidelines doc
    ├── dynamic-workflow-runner-scanner.ts  Detects file-less dynamic workflows (Dependabot updater, CodeQL) executing on billed GitHub-hosted runners
    ├── stale-branch-cleaner.ts          Deletes stale claws/* remote branches after PR merge/close
    ├── email-monitor.ts                 Polls Gmail for veg box emails, generates recipes via Claude; isolated scratch dir
    ├── k3s-monitor.ts                   Monitors k3s cluster pod/node health and Flux reconciliation failures
    ├── kubeconfig-refresh.ts            Kubeconfig auto-refresh via SSH; used by k3s-monitor and prod-k8s-monitor
    ├── prod-k8s-monitor.ts              Same detection as k3s-monitor but targets the prod cluster
    ├── runner-metrics-sync.ts           Adaptive sync of GitHub Actions workflow runs to SQLite for utilization analytics
    ├── ha-upgrader.ts                   Home Assistant update manager — installs updates within dwell windows
    ├── ha-deploy-watcher.ts             Home Assistant deploy failure notifications — Slack post on a failed/warning config check, plus a GitHub alert issue when the config check fails
    ├── ha-area-reconciler.ts            Enforces registry/areas.yaml entity → area assignments over the HA WebSocket API
    ├── datasette-export.ts              Exports the SQLite database to a remote host via scp
    ├── worktree-cleaner.ts              Daily prune of stale ~/.claws/worktrees/ directories
    ├── ha-monitor-common.ts             Shared entry guard and byte-diff alert upsert for Home Assistant monitors (resolveHaMonitorContext, upsertAlertIssue)
    ├── bin-day-monitor.ts               Polls HA for bin_scraper entities; maintains a running availability log issue
    ├── ha-battery-monitor.ts            Polls HA for low battery sensors; creates/auto-closes a Priority issue
    ├── ha-backup-monitor.ts             Polls HA backup event/overdue entities; creates/auto-closes Priority issues for failed or overdue backups
    ├── ha-deploy-stall-monitor.ts       Polls binary_sensor.deploy_pipeline_stalled; creates/auto-closes a Priority issue when the core_git_pull self-heal fails
    ├── damp-reminder.ts                 Weekly reminder to log damp meter readings if none logged by Monday 9am
    ├── dependabot-alert-monitor.ts      Polls Dependabot Alerts API; auto-dismisses stale alerts, files Priority alert issue
    ├── dependabot-run-monitor.ts        Polls dynamic Dependabot updater Actions runs; files/auto-closes alert per repo
    ├── actions-storage-monitor.ts       Daily scan of GitHub Actions cache/artifact storage usage across repos
    ├── domain-posture-scanner.ts        Daily WHOIS/RDAP, DNS and TLS/header posture check of every org domain (docs/domains.yaml)
    ├── public-snapshot-sync.ts          Daily private→public snapshot sync of PUBLIC_SNAPSHOTS repo pairs
    ├── reminder-monitor.ts              Daily scan of docs/scheduled-reminders/ across repos; files reminder issues
    ├── blog-draft-scanner.ts            Daily scan for draft blog posts left in other repos; files a port issue in bstjohn-blog
    ├── shopping-sourcer.ts              Daily phase-gated hardware sourcing from docs/shopping/*.yaml; per-manifest tracking issue
    └── shopping-comment-processor.ts    Turns comments on a [shopping] tracking issue into validated manifest mutations committed to the default branch

deploy/
├── claws.service           systemd service unit (KillMode=process preserves tmux sessions across restarts; cgroup limits: MemoryHigh=4G, MemoryMax=5G, TasksMax=800, CPUWeight=80, OOMScoreAdjust=200 — raised from 2.5G/3G for browser-driving session capability headroom, #2510)
├── claws-updater.service   systemd updater service
├── claws-updater.timer     systemd timer (every 60s)
├── install.sh              One-shot bootstrap installer
├── deploy.sh               Auto-update with Node ABI gate, health check, and rollback (see [Auto-Update & Rollback](#auto-update--rollback))
├── install-skills.sh       Installs bundled `.claude/skills/*` (e.g. `/postmortem`) into `$CLAWS_HOME/.claude/skills/`; run by both install.sh and deploy.sh on every deploy
├── whisper.service         systemd unit for the self-hosted faster-whisper transcription server (see whisper-server.py)
├── whisper-server.py       Self-contained PEP-723 script (`uv run --script`) — minimal OpenAI-compatible `/v1/audio/transcriptions` server via faster-whisper; replaced an un-installable Speaches unit (#2122) — see [Voice-note transcription](whatsapp-setup.md#step-2--voice-note-transcription-on-by-default)
└── uninstall.sh            Service removal
```

## Jobs

Thirty-nine registered jobs run on timers or schedules, plus one event-driven handler.
See [Jobs](jobs/README.md) for detailed behavior of each.

| Job | Trigger | Interval | Summary |
|-----|---------|----------|---------|
| `issue-dispatcher` | All open issues per repo | 5 min | Unified dispatcher — classifies issues and delegates to planner (issue-refiner) and implementer (issue-worker) agents; the planner may also transfer an obviously mis-filed issue to another same-owner managed repo (#2216); the routing comment deliberately avoids the `## Implementation Plan` header so the destination re-plans |
| `sequential-issue-processor` | Opt-in per repo (`/jobs` matrix or the per-repo page's "Auto-process mode" toggle) | 10 min (`sequentialIssueProcessorMs`) | "Auto-process" mode (#2103, #2356) for backlog-heavy repos — a single LLM pass ranks the whole open backlog and classifies each issue `auto`/`needs_human`/`out_of_scope`/`duplicate`/`obsolete`; duplicates get the `Duplicate` label plus a root-cause back-reference (both issues stay open), confident-obsolete issues are commented and closed `not_planned` (never when labelled `Priority` or when a PR is already open), and the top `auto` issue is refined one at a time. An issue awaiting human input (`Manual Action`) is excluded from the candidate set rather than halting the repo (#2356) and is surfaced under "Needs your input" on `/repos/:owner/:name`. The ranking call is skipped while the backlog signature (issue numbers + `updatedAt`) is unchanged |
| `pr-dispatcher` | All open PRs per repo | 5 min | Unified dispatcher — classifies PRs and delegates to CI fixer, review addresser, reviewer (pr-reviewer), and merger (auto-merger) agents; closes empty PRs (0 changed files) and superseded dependabot PRs (Problematic + closed major-bump tracking issue + base-branch version re-check) before dispatching |
| `triage-claws-errors` | `[claws-error]` issues in `SELF_REPO` | 10 min | Investigates internal Claws errors, deduplicates by fingerprint, posts report |
| [`doc-maintainer`](jobs/doc-maintainer.md) | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Updates `docs/` to reflect current codebase; also ensures human-authored issue/PR requirements are reflected in the feature docs, with cross-cutting ones recorded in `docs/requirements.md` (#2090, #2227); posts one Slack summary per scheduler tick covering the repos processed in that tick (PRs opened with plan titles, skipped repos, errors); silent on fully-quiet runs |
| `repo-standards` | Daily at 2 AM (+ on startup) | Scheduled | Syncs labels and cleans legacy labels for each managed repo; removes stale local clones |
| `improvement-identifier` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos; paused Fri 18:00 → Sun 18:00 local so issues don't pile up over the weekend (manual trigger bypasses) | Smart-scheduled | Reviews codebase via Claude for security issues and improvements; files improvement issues when no security work is queued; no longer opens PRs; skips fork-PR hardening findings on private repos (uses `isRepoPrivate()`); conditionally adds Web/SEO and JSON-LD guidance for repos that serve user-facing HTML |
| `public-repo-scanner` | Daily at 4 AM (`publicRepoScannerHour`); 7-day per-repo throttle | Scheduled | Enumerates all public repos for all owners (including archived, via `listPublicReposIncludingArchived()`); asks Claude to scan each for live secrets, private keys, and credentials; files alert issues via `ensureAlertIssue()`; does NOT write MCP config (text-only, no tool use needed); findings on a `PUBLIC_SNAPSHOTS` target repo are filed to `SELF_REPO`, never the private source (#1875, #1962) |
| `idea-suggester` | Manual trigger only | — | Suggests ideas per repo and files the top-scoring ones directly as GitHub issues |
| `issue-auditor` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Reconciles issue states, manages Ready and In Review labels |
| `whatsapp-handler` | WhatsApp message | Event-driven | Interprets messages via Claude, creates GitHub issues |
| `runner-monitor` | Self-hosted GH Actions runners | 10 min | SSHes to runners, checks service health, restarts dead services, tiered disk cleanup (>85% tier 1, >90% tier 2), files issue when disk stays critical post-cleanup; supports both self-installed `svc.sh` runners and NixOS `systemd` units |
| [`host-disk-monitor`](jobs/host-disk-monitor.md) | Claws' own host (`openclaw`) | 10 min | Local (no SSH) disk check on the filesystem holding `WORK_DIR`; tiered cleanup with **no `docker` commands** — npm/npx caches, `/tmp` scratch reclamation (Claude CLI session output, leaked `nix-shell` TMPDIRs, node/jest compile caches; 24 h file-age gate, #2535), aggressive (24 h) worktree reaping, journal/apt at tier 1 (>80%), `nix-collect-garbage -d` plus browser and tool caches at tier 2 (>88%, or >80% when tier 1 fails to recover, 6 h cooldown); files a deduped issue when cleanup doesn't recover space, and a separate tripwire issue if a container runtime appears on this plan-only host (#2386) |
| `mac-runner-waker` | Queued jobs in `bonkus`, `namey`, `TempoStatusBar` | 1 min | Wakes sleeping self-hosted Macs over SSH when a macOS CI job has been queued for >60 s, selecting the Mac by `runs-on` label match; SSH wake failures raise a per-host `[claws-error]` alert issue, except failures where the Mac never answered (unresolvable hostname, no route, network unreachable, connect timeout), which log a warning and send one Slack notice per absence episode instead — only failures proving a live host (connection refused, auth, host-key) raise an issue; a runner still offline in GitHub's registry 3 min after its wake raises `mac-runner-offline:<host>` |
| `scanner-dispatcher` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Runs twelve scanners sequentially (one failure doesn't block others): ubuntu-latest, concurrency, migration, main-build-monitor, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, gitignore, dependabot-config, design-guidelines, [dynamic-workflow-runner](jobs/dynamic-workflow-runner-scanner.md) |
| `stale-branch-cleaner` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Deletes stale `claws/*` remote branches whose PRs have been merged or closed for 7+ days |
| `email-monitor` | Unread emails in configured Gmail inbox | 5 min | Polls Gmail via IMAP, extracts veg box contents via Claude, generates recipes, emails results |
| [`k3s-monitor`](jobs/k3s-monitor.md) | k3s cluster pods/nodes | 15 min | Monitors cluster health via `kubectl`, detects failing pods, unhealthy nodes, and Flux Kustomization/HelmRelease failures; raises alert issues to `FLEET_INFRA_REPO` with the `Priority` label and occurrence tracking |
| `github-status` | All GitHub API/git work | 2 min | Polls `githubstatus.com` summary.json for the components Claws depends on (Git Operations, API Requests, Webhooks, Issues, Pull Requests, Actions); surfaces the result on the dashboard's Integrations panel and Slack-notifies once per incident transition; while a depended-on component is non-operational, `error-reporter` downgrades gh/git CLI failures to warnings instead of filing `[claws-error]` issues, `ci-fixer` pauses fix attempts and breaker trips for incident-shaped failures (no repo step reached, missing log, or a GitHub-side error signature — `isPreRepoStepFailure`/`looksLikeGitHubOutageFailure`), `[ci-unrelated]` occurrences logged in the window are tagged as incident fallout rather than recurring flakiness, and the diagnosis/planning prompts (ci-fixer classify + fix, problematic-PR diagnoser, issue-refiner plan + refine) carry a `<github_incident_status>` block built by `gitHubIncidentContext()` from the snapshot plus `getRecentDegradedWindows()` (24 h, in-memory) |
| `prod-k8s-monitor` | Prod k8s cluster pods/nodes | 15 min (configurable) | Same detection as `k3s-monitor` but for the prod cluster via `prodK8sKubeconfigPath`; files alerts to `prodK8sRepo` (default `St-John-Software/production-infra`); disabled by default — enable via `prodK8sMonitorEnabled: true` |
| `runner-metrics-sync` | GitHub Actions workflow runs | 2 min (adaptive) | Syncs recent workflow runs to the `workflow_runs` SQLite table; skips API calls when Claws is idle and last sync was <15 min ago; reconciles stale `queued`/`in_progress` rows via `fetchWorkflowRunById()` (deletes runs that GitHub no longer knows about); backs off to zero cost at rest |
| `datasette-export` | Local SQLite DB | Configurable interval | Exports a copy of `claws.db` to a remote host via scp for Datasette-based data exploration |
| `ha-upgrader` | Home Assistant `update.*` entities | 24 h | Polls Home Assistant for pending updates, applies device and HA core/supervisor/OS updates within configurable dwell windows (24 h device, 48 h high-risk), raises alert issues for failures; Slack notified only on actual installs, user-excluded alerts, or install failures (not on routine dwell-deferred waits) |
| `ha-deploy-watcher` | git-pull addon logs | 5 min | Polls git-pull addon logs via HA Supervisor API; posts Slack notification with commit list (`listCompareCommits`), compare link, and diffstat only when the config check for a detected `Updating <old>..<new>` reports an `ERROR:` or `WARNING:`; clean deploys advance state silently with no Slack post and no `listCompareCommits` call (#2544); commit-list fetch failures fall back to compare link only; first run baselines silently; on an `ERROR:` config check it also files/updates a fixed-title alert issue `[ha-deploy-watcher] home-assistant-config deploy failed on the Home Assistant host` in `HOME_ASSISTANT_CONFIG_REPO` via `ensureAlertIssue` (`Priority` label, `refreshBody: true`), and closes it via `closeAlertIssueIfResolved` when a later deploy passes; `WARNING:` lines stay Slack-only; GitHub failures are logged and never block the state advance |
| `ha-area-reconciler` | `registry/areas.yaml` in `home-assistant-config` | 30 min | Reads the version-controlled entity → area manifest via the contents API and reconciles Home Assistant to match over the WebSocket API (`config/area_registry/list` → `config/entity_registry/list` → `config/entity_registry/update`); partial authority (only listed entities are managed) and enforcing (a manual UI area change is reverted on the next tick); no-ops silently when the manifest is absent; retries 3× at 60 s so a just-deployed entity has time to appear, then files a `Priority` alert issue in the config repo for unknown entities or area ids (auto-closed when the manifest matches); an HA outage warns without alerting; Slack is notified only when an area was actually overwritten |
| `worktree-cleaner` | All `~/.claws/worktrees/` directories | 24 h | Removes worktrees >7 days old that aren't in any running task or persisted session; uses `git worktree remove --force` with `rm -rf` + `git worktree prune` fallback; logs removed count and freed bytes |
| `bin-day-monitor` | Home Assistant bin-day sensors | 15 min | Polls `sensor.bin_scraper_*` entities; maintains a single persistent GitHub issue as a running availability log; records status transitions (HEALTHY ↔ MISSING) in an embedded history table; never closes the issue on recovery; disabled by default (`homeAssistantBinDayMonitorEnabled`) |
| `ha-battery-monitor` | Home Assistant battery sensors | 1 h | Polls HA entities with `device_class=battery` and `unit_of_measurement=%`; creates a `Priority` issue listing all devices at or below `homeAssistantBatteryThresholdPercent` (default 10%); auto-closes the issue when all devices recover; body is rebuilt in-place each tick without posting comments; disabled by default (`homeAssistantBatteryMonitorEnabled`) |
| `ha-backup-monitor` | `event.backup_automatic_backup`, `binary_sensor.backup_overdue`, `sensor.backup_last_successful_automatic_backup` | 1 h | Three independent static-title `Priority` alerts, each created/edited via `findIssueByExactTitle`/`createIssue`/`editIssue` (skipping the edit when the body is byte-identical) and auto-closed via `closeAlertIssueIfResolved`: `[ha-backup-monitor] Home Assistant automatic backup failed` when the event entity's `attributes.event_type` is `failed` (closes on `completed`; an `in_progress` event type is inert — neither raises nor closes); `[ha-backup-monitor] Home Assistant backups are overdue` when `binary_sensor.backup_overdue` is `on` (closes on `off`); and `[ha-backup-monitor] Home Assistant backup monitor is blind — binary_sensor.backup_overdue unavailable` when that same sensor has been absent or `unavailable`/`unknown` for over 48 h — tracked via the `ha_entity_unavailable` DB table since a template entity's `last_changed` resets on every HA Core restart — auto-closed once the sensor reads `on`/`off` again. Either entity being absent or `unavailable`/`unknown` is still a no-op (debug log only) for the failed-backup alert and within the 48 h window for the overdue sensor, so a Core-restart blip can't auto-close a real alert or file a bogus one; disabled by default (`homeAssistantBackupMonitorEnabled`) |
| `ha-deploy-stall-monitor` | `binary_sensor.deploy_pipeline_stalled` | 15 min | Single static-title `Priority` alert, created/edited via `findIssueByExactTitle`/`createIssue`/`editIssue` and auto-closed via `closeAlertIssueIfResolved`: `[ha-deploy-stall-monitor] Home Assistant deploy pipeline stalled — core_git_pull did not self-heal` when the sensor is `on` (it only goes `on` after a 45 min unhealthy `core_git_pull` add-on state survives an automatic restart), closes on `off`; the entity being absent, `unavailable`, or `unknown` is a no-op (debug log only); body embeds `sensor.git_pull_addon_state` and is a pure function of that state (no timestamp), so a persistent stall skips the edit every tick instead of an `editIssue` per tick; enabled by default (`homeAssistantDeployStallMonitorEnabled`) |
| `actions-storage-monitor` | All repos | Daily at 5 AM (`actionsStorageMonitorHour`) | Scans GitHub Actions cache + artifact storage per repo; files per-repo alert when a repo uses ≥ 50 MB of Actions **cache** or has artifacts older than 7 days (high retention); org-level roll-up alert when total usage ≥ 80% of 2 GB account quota |
| `domain-posture-scanner` | Org-wide (`docs/domains.yaml`) | Daily at 6 AM (`domainPostureScannerHour`) | Passive posture check per domain — RDAP WHOIS-privacy/transfer-lock/DNSSEC/expiry, CAA/SPF/DMARC, and TLS validity plus HSTS/CSP headers for hostnames under `web:`; one `Claws Ignore`-labelled alert issue per domain in `SELF_REPO`, closed when the domain comes clean |
| `dependabot-alert-monitor` | All repos | Smart-scheduled | Polls `GET /repos/{owner}/{repo}/dependabot/alerts?state=open` per repo; auto-dismisses stale alerts in two passes — SBOM-based (gated by `dependabotAutoDismissStale`, default on) then manifest-pin-based for pip packages with `==` pins (handles SBOM lag); files a Priority `ensureAlertIssue` listing the remaining open alerts sorted by severity, with an embedded `REMEDIATION_GUIDANCE` block ordering remediation steps (remove unneeded deps, classify dev vs runtime, bump direct deps, use `>=` ranges in overrides); auto-closes the issue once alerts clear; leaves repos with scanning disabled as-is; if the App lacks `dependabot_alerts: read`, files a remediation issue on `SELF_REPO` (throttled hourly) |
| `dependabot-run-monitor` | All repos | Smart-scheduled | Polls the *dynamic* Dependabot updater runs (`GET /repos/{owner}/{repo}/actions/runs?event=dynamic`, filtered on `path == "dynamic/dependabot/dependabot-updates"`), keeps the latest completed run per ecosystem group from the last 30 days, cross-checks each failing group against the repo's live `.github/dependabot.yml` and drops groups whose `package-ecosystem`/`directory` entry has been removed (GitHub retains a retired ecosystem's last failing run as the permanent "latest", which otherwise re-alerts for 30 days — #2205)…also drops groups whose job log contains only runner/infrastructure abort lines (runner shutdown, operation cancelled), which GitHub records as conclusion "failure" rather than "cancelled" (#2571); fails open and reports everything when the config is unreadable or unparsable, scrapes the failed job log tail for the error, and files/auto-closes one unlabelled `ensureAlertIssue` when the updater is failing — the only coverage for a workflow that has no repo file and so cannot be watched by `on.workflow_run` |
| `damp-reminder` | N/A | 15 min (`dampReminderMs`) | Checks `hasDampReadingLoggedSince(weekStart)` and auto-closes the open reminder once readings are logged this week (once per week via an in-memory guard); on Monday local time ≥ 9 AM with no readings yet, files a single deduplicated `Priority` issue in `SELF_REPO` (via `findIssueByExactTitle`/`createIssue`, not `ensureAlertIssue` — a one-shot-per-period reminder must not have its body rewritten on every tick) reminding readings be logged on the `/damp` dashboard page |
| `public-snapshot-sync` | `PUBLIC_SNAPSHOTS` source→target pairs | Daily at 3 AM (`publicSnapshotSyncHour`, #2106 — was weekly via `publicSnapshotSyncMs`; chosen to slot between `repo-standards` (2 AM) and `public-repo-scanner` (4 AM), outside UK office hours) | Rebuilds each public `stjohnb/*` target from its private source via `git archive` (tracked files only, #1833), scrubbing `.claude`, `.plans`, `ideas/`, MCP config, dependabot files, `BLOG_IDEAS.md`, `HOMELAB_IDEAS.md`, and any pair-specific `scrubPaths` (#1962); publishes `.github/workflows` but disabled — `disableWorkflowTriggers()` rewrites each workflow's `on:` block to `workflow_dispatch:` only (#1835); runs a fail-closed secret scan against a path+pattern `SCAN_ALLOWLIST` for known-safe placeholders (#1833/#1836), now also covering credential-bearing webhook URLs (#2445) and modern Anthropic/OpenAI/OpenRouter key formats (#2550); disables Dependabot; pushes exactly one commit summarising features since the last sync (tracked via `.claws-snapshot.json`), or — for a `scrubPaths` pair — force-pushes a single squashed root commit every sync so a scrubbed path can't survive in ancestor history (#1962, mutually exclusive with `mirrorReleases`); for pairs with `mirrorReleases: true` (TempoStatusBar), also mirrors the latest stable GitHub release's assets to the target (#1851); the DMG is fetched from the pair's `releaseAssetUrl` (public S3) when the source release has no `.dmg` asset, because TempoStatusBar's release workflow moved DMG storage off GitHub Releases to S3 (#2115); idempotent via the stored source SHA, so a daily no-op run (no new source commits) is fast; never un-archives a target — a missing/archived target alerts on `SELF_REPO` and is skipped; commit subject and body are derived from the change summary and never name the private source repo, and a target whose published history still names the source is force-resynced once, rewriting historical messages on branches and tags (#2362) |
| [`reminder-monitor`](jobs/reminder-monitor.md) | All repos | Daily at 8 AM (`reminderMonitorHour`, #2355) | Reads `docs/scheduled-reminders/*.md` from each repo's default branch, parses YAML frontmatter, and files a GitHub issue once local `today >= notify_on`; dedup key is `(repo, reminder id, notify_on)` in SQLite so a human closing the issue doesn't cause a re-file; malformed files raise a single per-repo `ensureAlertIssue` instead of one issue per file |
| [`blog-draft-scanner`](jobs/blog-draft-scanner.md) | All repos except `bstjohn-blog` (opt-out per repo via the `/jobs` matrix) | Daily at 9 AM (`blogDraftScannerHour`, #2560) | Scans `docs/`, `ideas/`, `drafts/`, `docs/blog-drafts/`, `blog-drafts/` in each repo for draft blog posts (by filename/heading/frontmatter heuristics and a prose-paragraph threshold), and files a port issue in `bstjohn-blog` for any draft not already published there (matched by normalized title or slug); dedup key is `(repo, path)` in SQLite so editing a draft after the port issue is filed doesn't re-file it; skips the run entirely if the published-post listing comes back empty, to avoid spurious re-filing |
| [`shopping-sourcer`](jobs/shopping-sourcer.md) | `docs/shopping/*.yaml` in managed repos | Daily at 7 AM (`shoppingSourcerHour`) | Phase-gated hardware sourcing (#2463) — parses each manifest, selects items with `status: sourcing` in an unlocked phase whose `recheck_days` cadence has elapsed, and runs one tool-restricted Playwright agent (no Bash/Edit/Write, scratch dir, strict JSON out) to find marketplace listings. Candidates are guarded, URL-validated and stored in SQLite, then rendered into a per-manifest `[shopping]` tracking issue labelled `Claws Ignore` whose table lists only outstanding items (`delivered`/`skip` are hidden behind a count); the issue auto-closes when nothing is sourcing. Purchases are made manually. Lists are created and managed through ordinary issues — the planner/implementer prompts carry `SHOPPING_MANIFEST_CONTEXT` |
| [`shopping-comment-processor`](jobs/shopping-comment-processor.md) | Open `[shopping]` tracking issues in managed repos | 10 min (`shoppingCommentProcessorMs`) | Primary shopping-list update flow (#2546) — reads unprocessed comments on a `[shopping]` tracking issue (skipping Claws' own, bot logins, and anything already carrying a self-authored 👀/🚀/😕; **gated on `isAllowedActor`**, since a comment rewrites a file on the default branch), reacts 👀 as a durable at-most-once claim *before* the agent call, and has one text-only agent turn the batch into a JSON mutation list (`set_field`/`add_item`/`remove_item`/`set_active_phases`). Mutations are validated in TypeScript and applied through the `yaml` `Document` API so manifest comments and formatting survive; the serialized result is re-parsed with `parseManifest` and **not committed if it fails**. Commits to the default branch with the fetched blob `sha` (compare-and-swap, never retried), refreshes the tracking issue immediately, reacts 🚀 and replies with a TypeScript-built summary of what applied and what didn't |

### Naming Convention

- **Jobs** (`src/jobs/`): Top-level units registered with the scheduler. Each job runs on a timer or schedule and is referenced by name in the DB, config (`pausedJobs`), and dashboard.
- **Agents** (`src/agents/`): Task-specific modules called by dispatcher jobs. Each handles a specific concern (planning, implementing, CI fixing, etc.) and typically invokes Claude in an isolated worktree.
- Agent display names (`Planner`, `Implementer`, `CI Fixer`, etc.) are short labels for GitHub comment headers and `disabledAgents` config. Filenames are more descriptive (e.g., `issue-refiner.ts`, `ci-fixer.ts`).

## Key Patterns

Full detail (code examples, edge cases, rationale) lives in [patterns.md](patterns.md); this is a compact index.

### Content-Based State Machine

Issues and PRs are discovered by analysing comments, reactions, and PR state — not labels. Eleven labels (`Refined`, `Ready`, `In Review`, `Priority`, `Duplicate`, `Claws Ignore`, `Claws Problematic`, `Billing`, `Plan: Fable`, `Manual Action`, `Automerge`) drive dispatcher transitions for issues (issue-dispatcher) and PRs (pr-dispatcher); a human 👍 gates Claws-authored suggestions while human review comments are auto-processed. Labels outside those eleven (GitHub defaults, Dependabot ecosystem labels, repo-local ad-hoc labels) are inventoried in [label-audit.md](label-audit.md).

### SQLite-Backed Work Queue

Dispatcher jobs enqueue classified work into the `work_queue` SQLite table; up to `MAX_WORK_WORKERS` fibers claim rows and invoke handlers, with idempotency enforced by a unique partial index. Claude processes get configurable timeout/liveness/memory watchdogs, and `runClaude` retries once on specific transient failure classes.

### Model Selection

`model-selector.ts` provides three tiers (`cheap`/`sonnet`/`opus`) per provider (Claude/Codex/OpenCode), with some text-only workflows pinned to `provider: "claude"` for output-quality/auth reasons and others defaulting to the `claude` provider via `TEXT_ONLY_PROVIDER_FALLBACK_ORDER`. The planner defaults to `opus` (or `claude-fable-5` for `Plan: Fable`-labelled issues).

### Skip-If-Busy Scheduling

Jobs that fire while a prior instance is still running are silently dropped — no queue pile-up; distinct from the separate Claude task queue.

### Smart Scheduling

Seven low-priority background jobs use staleness-based per-repo selection (`smart-schedule.ts`) instead of fixed intervals: due repos (age ≥ `targetStalenessMs`), a busy gate, an SLO escape valve (`sloStalenessMs`) that forces processing of badly-stale repos even when busy, and a concurrency cap. Manual triggers bypass the busy/enabled gate but not staleness selection. `main.ts`'s generic `smartScheduledJob<T>()` wrapper accepts an optional `postSummary(results: T[])` callback (#2319) — run once per scheduler tick after all due repos in that tick settle, over just the fulfilled results (a `processRepo` rejection is logged and excluded, not passed through) — so a job can post one aggregated Slack summary per tick instead of one message per repo; `doc-maintainer` is the current user.

### Worktree Isolation

Each task runs in its own git worktree under `~/.claws/worktrees/<owner>/<repo>/<job>/<branch>`, namespaced by work-queue kind to prevent path collisions. Read-only jobs use `--detach`; write jobs use a namespace-scoped local branch; `withNewWorktree`/`withExistingWorktree` helpers own create+cleanup lifecycle.

### Graceful Shutdown

On SIGINT/SIGTERM, `main.ts` cancels queued tasks, drains running jobs (5 min timeout), terminates in-flight Claude processes, and closes the database; cancelled tasks throw a suppressed `ShutdownError`.

### Crash Recovery

At startup, any task still marked `running` in the database from a previous crash has its worktree cleaned up and is marked `failed`.

### Auto-Update & Rollback

`deploy/deploy.sh` runs every 60s via a systemd timer (independent of the Node process): a Node-ABI gate checks compatibility before touching anything, then backs up and swaps `dist`/`node_modules`, health-checks the restarted service, and rolls back with a skip-list + throttled Slack alerts on failure; a successful deploy posts nothing to Slack (#2561). It also chmod-normalises (never chowns — that tree runs as root every tick) the deployed `deploy/` dir on every tick and self-heals a crash-looped `whisper.service` (`reset-failed` + restart, alerting hourly only if that doesn't hold) — added after release tarballs left `whisper-server.py` unreadable by the service user and silently pushed transcription onto an unfunded OpenAI fallback (#2407).

### Transient Retry & Rate Limit Circuit Breaker

`gh` and `git` calls retry up to 3 times with exponential backoff on a broad set of transient network/HTTP errors. Rate-limit errors instead trip a 60-second circuit breaker (`RateLimitError`) that short-circuits all API calls, with a single Slack notification per trip/recovery.

### WhatsApp Pairing Notifications

The WhatsApp module Slack-notifies once per pairing state transition (not per event), using a `lastNotifiedState` guard; auth state is cleared only on status 401 (logged out) or 500 (bad session) — every other disconnect (including 515 restart-required and 440 connection-replaced) retries indefinitely with backoff capped at 5 minutes instead of forcing a re-pair (#2274). Status **408 emitted after a QR code** is not a transient disconnect at all: in Baileys it comes from exactly one site ("QR refs attempts ended" in the `pair-device` handler), so it means a pairing QR expired unscanned and the device is unpaired. That case is split out before the failure counter — it records an `awaiting-qr-scan` event, leaves `consecutiveFailures` at zero (so the misleading "auth state preserved; still retrying" alert can't fire for a device no retry can fix), and when no browser is on the `/whatsapp` pairing page it posts the QR to Slack as a monospace code block, throttled to one per 15 minutes and giving up after 12 unscanned cycles (#2393). `hasAuthState()` correspondingly requires a registered `creds.me.id`, not merely the existence of `creds.json`, matching how Baileys itself chooses login over QR registration. Incoming messages are accepted from **both** `messages.upsert` types: Baileys tags a stanza `append` rather than `notify` whenever it carries WhatsApp's `offline` attribute, i.e. it was queued by the server while Claws was down, so the old `type !== "notify"` filter silently dropped every message sent during an outage — never read, never filed (#2424). Offline replays are handled identically to live messages and recorded as `offline-message-received`.

### Error Reporting & Investigation Pipeline

Errors flow through `error-reporter.ts` (30-min cooldown per fingerprint, edits an existing `[claws-error]` issue via `ensureAlertIssue()`, filters known-transient error types, and — via `agent-auth-state.ts` — latches an expired agent CLI OAuth session so every task failing with the same "Failed to authenticate" message raises one Slack alert and one `[claws-error] agent-auth-expired` issue per episode instead of per task, clearing on the next successful agent run or a web re-auth) and then `triage-claws-errors.ts` (dedup by fingerprint then root cause, posts an investigation report, retries once on a truncated response).

### CI-Fixer Circuit Breaker

Merge-conflict resolution is checked before the CI-fix breaker and tracked under its own `maxConflictAttempts` budget (default 3 unproductive attempts per window), so a breaker tripped by CI failures does not block conflict resolution; conflict tasks (`ci-fixer:merge-conflict`) are excluded from the CI-fix attempt count (#2389). For the remaining, non-conflicting PRs: after `maxAttempts`/`maxConsecutiveFailures` CI-fix attempts within a rolling window **and while there is still a failing check to dispatch against**, a PR is marked `Claws Problematic`, further auto-fix attempts stop, and a one-shot deeper-diagnosis pass (`problematic-pr-diagnoser.ts`, up to 3 rounds) runs before a final report comment; recovery clears the label automatically. The breaker deliberately does not trip (or re-apply the label) on a green, mergeable PR — the attempt budget only gates dispatching new work, and re-labelling a PR with nothing left to fix fought the diagnoser's stale-label clearing in an endless add/remove loop (#2390). The diagnoser's clearing rule is the mirror image: it only treats the label as stale when CI is green **and** the PR isn't `CONFLICTING`, so a conflict-triggered trip escalates to a human instead of being cleared on the next pass. A new head commit pushed by a human or another agent (i.e. one Claws did not push itself) grants the PR a fresh, bounded attempt budget — up to `maxCommitGrants` times — rather than leaving it frozen until someone removes the label by hand. A PR labelled `Manual Action` because GitHub refused to re-run a dead CI run is cleared the same way: once `gh pr checks` reports every check passing and the `claws:not-rerunnable-run` note is the only live reason for the label, pr-dispatcher strips the note and removes the label so auto-merger can proceed (#2462). While `isGitHubDegraded()` is true, an incident-shaped failure — one whose jobs never reached a repo-owned step, whose log is missing, or whose log carries a GitHub-side error signature — neither dispatches a fix nor spends an attempt, and a PR already over budget is skipped instead of being labelled `Claws Problematic`, so an outage cannot burn the budget and then trip the breaker with the attempts it burned (#2497). This is deliberately fail-open: `isGitHubDegraded()` returns false the moment the status snapshot goes stale (>15 min) or the poll errors, so a wedged poller resumes normal breaker behaviour on the next sweep rather than pausing the ci-fixer forever, and a real repo-step failure that merely coincides with an incident is still fixed as usual. "Only live reason" spans both label producers: another agent's manual-action section in the PR body (issue-worker), and pr-reviewer's escalations — a refuted blocking finding or a review loop past `MAX_REVIEW_ITERATIONS` — which label the PR but write only a review comment, so they are detected via `hasEscalatedReview` rather than from the body. A GitHub `403 Resource not accessible by integration` (the App installation missing `Actions: write`) is distinguished from a genuine `"cannot be rerun"` refusal (#2514, `isActionsPermissionDenied`) — the former is a global, fixable settings problem, so it files one deduplicated `[claws-config]` alert on `SELF_REPO` instead of marking the run dead or labelling the PR `Manual Action`, leaving it retryable once the permission is granted.

### CI-Fixer Two-Phase Design

The ci-fixer identifies all PR work items first (typed `conflict`/`rerun`/`unrelated`/`fix` variants), then processes them — grouping unrelated failures per repo to avoid duplicate-issue race conditions from concurrent classification.

### No-Commit Feedback

When the implementer produces zero commits, a cheap Claude call diagnoses why (`diagnoseNoCommits`) and the result is posted as a deduplicated `## No changes produced` comment, with the `Refined` label removed to block re-entry.

### Multi-Phase Plan Validation

After each phase's PR merges, `validateAndUpdatePlan()` compares the plan text against the actual diff and updates the plan comment in place on significant deviation; phase-overflow guards prevent processing past `totalPhases`.

### CI & Codebase Infrastructure Monitoring

`runner-monitor` (SSH health/disk checks on self-hosted runners) runs independently, with `host-disk-monitor` covering the same disk-pressure ground for Claws' own host locally (no SSH, no Docker cleanup, plus a container-runtime tripwire); twelve scanners (ubuntu-latest, concurrency, migration, main-build-monitor, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, gitignore, dependabot-config, design-guidelines, dynamic-workflow-runner) run sequentially via `scanner-dispatcher`, each filing a deduped alert issue per repo for its class of violation. `ubuntu-latest-scanner` and `dynamic-workflow-runner-scanner` both enforce the self-hosted-only runner policy but from different signals — file-based `runs-on:` scanning vs. run-history runner identity — because dynamic workflows (Dependabot's updater, CodeQL default setup) have no workflow file for the former to read (#2322). `k3s-monitor` separately watches cluster pod/node health and Flux reconciliation, with grace periods, ignored-node suppression, and same-run dedup.

### GitHub Actions Concurrency & Runner Priorities

GitHub Actions has no native job-priority system; Claws mitigates queue/cancellation cascades via per-branch concurrency groups in its own workflows, throttled/priority-ordered ci-fixer reruns, and a scanner that flags misconfigured concurrency groups repo-wide. A group also holds only one running + one pending job — a group shared by 3+ jobs that trigger together silently evicts the older pending one even with cancel-in-progress: false, which surfaces as a check cancelled seconds in with zero steps.

### Image & Attachment Context

`images.ts` extracts embedded images and GitHub file attachments from issue/PR text, downloads them (SSRF-guarded), and appends prompt sections so Claude can view images and read attached files; used by issue-refiner, issue-worker, and review-addresser.

### Parallel Repo Processing

`issue-dispatcher` and `pr-dispatcher` process repos concurrently via `Promise.allSettled`; a rate-limit short-circuit or failure in one repo doesn't block others.

### Fast-Checks Guidance

Shared prompt constants (`FAST_CHECKS_GUIDANCE`, `CI_FIXER_FAST_CHECKS_GUIDANCE`, `RUNNER_POLICY_CONTEXT`) tell agents to prefer fast local checks over slow CI-only ones and to never suggest GitHub-hosted runners, applied proactively at plan/implement/review time.

### Documentation as Context

Several agent prompts (issue-refiner, issue-worker, improvement-identifier, idea-suggester, triage-claws-errors) instruct Claude to read `docs/OVERVIEW.md` and linked docs before starting work.

### Client TypeScript Pipeline

Client-side code is authored as TypeScript in `src/client/*.ts`, esbuild-bundled by `scripts/build-client.mjs` into `src/resources/*.generated.ts` string constants that page builders interpolate directly; generated files are checked into the repo so no extra build step is needed in CI/production. `client/auth-watch.ts` is injected on every page by `buildPageHeader`: when a page is restored from the bfcache, a suspended tab, or a PWA resume with an expired `claws_session` cookie — or when any same-origin `fetch` returns 401 — it probes the public `GET /api/auth/status` and, on `authenticated: false`, recovers with `location.replace("/login?next=…")` so the OIDC round trip returns to the same URL with a fresh cookie (a page with unsaved input or a repeat attempt within 30 s gets a manual sign-in banner instead).

**Owner requirement — no SPA framework rewrite.** Growing pains with inline `<script>` blocks in TypeScript template literals (live polling, theme toggling, log-level filtering) prompted repeated requests to modernize the frontend (#1005, #1016, #1019), including an explicit preference for React/Next (#1124) after a particularly large inline JS function shipped for client-side error reporting (#1120). The stack that actually landed is lighter than that: Alpine.js (`resources/alpinejs.ts`, declarative `x-data`/`@click` attributes in server-rendered HTML) plus Tailwind CSS (`resources/tailwind-css.generated.ts`), *not* React — preserving server-side rendering with no page-markup build pipeline, per the original least-disruption framing in #1005. The Client TypeScript Pipeline above is what actually answers #1120/#1124's underlying complaint (large, error-prone JS with nothing catching mistakes at compile time): genuinely complex client logic (the session terminal, queue/session-list interactions, the client error handler) is real compiled TypeScript, not a JS string; Alpine is reserved for simple declarative page interactivity.

### Prompt Resource Injection

Reference material (e.g. marketing knowledge for idea-suggester, `FRONTEND_AESTHETICS_CONTEXT` for UI-touching tickets) is inlined as TypeScript string constants and injected into relevant agent prompts rather than read from disk at runtime.

### Branch Naming

Each agent/job uses a fixed branch-name pattern (e.g. `claws/plan-<N>-<hex4>` for the planner, `claws/issue-<N>-<hex4>` for the implementer, `claws/docs-<YYYYMMDD>-<hex4>` for doc-maintainer) — see the table in [patterns.md](patterns.md) for the full list.

### PR Title Conventions

Claws-created PR titles follow fixed prefixes per source (`fix: resolve #N — <title>`, `fix(#N): <phase title> (X/Y)`, `docs: update documentation for <repo>`, etc.).

### Issue Title Conventions (Claws-created)

Claws-created issue titles follow fixed prefixes per originating job (e.g. `security: <title>` for improvement-identifier findings, `[claws-error] <fingerprint>` for internal errors, `[disallowed-actor] @<login> is blocked...` for gated actors).

### Duplicate PR Guards

PR-creating jobs (doc-maintainer, improvement-identifier, ci-fixer) each check for an existing open PR/issue before creating a new one, to prevent pile-up across ticks.

### Item Skip & Prioritize

Individual issues/PRs can be skipped or prioritized via `skippedItems`/`prioritizedItems` config lists or dashboard queue buttons; both are hot-reloadable and checked by `isItemSkipped()`/`isItemPrioritized()`.

### Per-Repo Job Disabling

Jobs can be disabled per repo via `disabledJobsByRepo` (or the `/jobs` matrix UI); a small set of opt-in-only jobs (`OPT_IN_JOB_NAMES`, currently just `main-build-monitor-scanner`) instead require explicit `enabledJobsByRepo` inclusion.

### Job Pause/Resume

Jobs can be paused/resumed from the dashboard or via `pausedJobs` config; paused jobs skip scheduled ticks but remain manually triggerable.

### Disabled Agents

Individual agents within `issue-dispatcher`/`pr-dispatcher` (planner, implementer, ci-fixer, review-addresser, reviewer, merger, empty-pr-closer, superseded-pr-closer) can be disabled via `disabledAgents` config; a disabled agent's phase is silently skipped.

### Push Branch Concurrency

`pushBranch()` uses a fetch-rebase-push retry loop (with a defensive `refs/heads/` refspec prefix against git option injection) to handle concurrent pushes to the same PR branch, falling back to a merge and finally a suppressed `PushConflictError`; the pr-dispatcher also defensively skips review-addresser for PRs with active ci-fixer work in the same cycle.

### Commit Tag

Doc-maintainer commits include `[doc-maintainer]` in the message, used by `getLastDocMaintainerSha()` to detect whether docs are already current.

### Per-Item Timeout Escalation

`timeout-handler.ts` counts recent per-item Claude timeouts (2h window); under 3 it escalates the item's timeout by 1.5x (persisted in `itemTimeoutOverrides`), at 3+ it auto-skips the item and posts an explanatory comment.

### Plain-Text Markers (No HTML Comments)

Claws never uses HTML comments as machine-readable markers — all structured state (`review-addressed: <SHA>`, `Reviewed commit:`, `recommended-model:`, `CLAWS_PLAN_OCCURRENCES: N`, `CLAWS_NO_CODE_CHANGES`, `CLAWS_TRANSFER_TO:`, `CLAWS_TRANSFERRED_FROM:`, etc.) is plain text so it survives GitHub's Markdown rendering and is easy to grep.

### Zod Runtime Validation

All external data (gh CLI output, POST bodies, Slack API responses, AI-extracted JSON, config file contents) is validated with Zod schemas rather than cast with `as T`, so shape mismatches throw a readable `ZodError` instead of producing silent type-unsafe values.

### GitHub App Authentication

Claws requires GitHub App auth for all its own GitHub/git operations; `ensureGitHubAppConfigured()` validates global or per-owner credentials at startup, and short-lived installation tokens (RS256 JWT → GitHub API) are minted per-owner and injected into `gh`/`git` subprocess env.

### Security Model

Because Claude runs with `--dangerously-skip-permissions`, all user-supplied input must be guarded upstream: query-param escaping on dashboard pages, a configured-repo allowlist (`isConfiguredRepo()`) on dashboard routes that mutate GitHub state via a client-supplied `repo` string (#2221), fork-PR filtering across all PR-processing jobs, `isAllowedActor()` gating (with a `[disallowed-actor]` tracking issue) applied at issue-dispatcher, issue-refiner, and triage layers, and a detected prompt injection is both redacted before reaching the model and posted back as a visible comment on the originating issue/PR, not just logged/Slacked (#1275) (#2526: for duplicate-candidate bodies the originating issue is the *candidate*, not the issue being refined).

### PR Review Comment Protocol

Every terminal pr-reviewer code path posts a comment with the `## PR Review` header and a `Reviewed commit:` marker, which `hasNewCommitsSinceLastReview()` uses to avoid infinite re-review loops; large diffs fall back to a per-file two-phase review strategy, and context is dynamically budgeted against the model's input-token limit.

### MCP Server Context

Claude sessions access Claws operational state via a built-in MCP server (`claws_status`, `claws_task_history`, `claws_open_prs`, `claws_config`), plus `ha_list_entities`/`ha_api_request` when Home Assistant is configured **and** the call site explicitly opts in for the HA config repo (default-deny elsewhere).

## Configuration

Full config key / env var / default reference lives in [configuration.md](configuration.md); this is a compact table of the most commonly-used keys. Configuration is resolved per-field: env vars > `~/.claws/config.json` > defaults.

| Config key | Env variable | Default |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` |
| `port` | `PORT` | `3000` |
| `dashboardUrl` | `CLAWS_DASHBOARD_URL` | *(derived from `oidcRedirectUri`'s origin — base URL for dashboard links in Slack alerts)* |
| `smartScheduling.enabled` | — | `true` (kill-switch for smart-scheduled jobs) |
| `runners` | — | Self-hosted GitHub Actions runner hosts monitored by `runner-monitor` |
| `macRunners` | — | Self-hosted macOS runner hosts woken by `mac-runner-waker` |
| `allowedActors` | — | `["stjohnb"]` (issue authors dispatched into refine/implement; see [Content-Based State Machine](#content-based-state-machine)) |
| `disabledJobsByRepo` / `enabledJobsByRepo` | — | `{}` / `{}` (per-repo job disable / opt-in lists) |
| `disabledAgents` | — | `[]` (agent names to disable within issue/PR dispatchers) |
| `pausedJobs` | — | `[]` (job names paused on startup) |
| `skippedItems` / `prioritizedItems` | — | `[]` / `[]` (per-item `{repo, number}` skip/priority overrides) |
| `githubAppId` / `githubAppPrivateKeyPath` | `CLAWS_GITHUB_APP_ID` / `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | `0` (disabled) / *(empty)* |
| `homeAssistantBaseUrl` / `homeAssistantToken` | `CLAWS_HOME_ASSISTANT_BASE_URL` / `CLAWS_HOME_ASSISTANT_TOKEN` | *(empty — HA integration disabled)* |
| `k3sMonitorEnabled` | — | `true` |
| `openrouterApiKey` | `CLAWS_OPENROUTER_API_KEY` | *(empty — required for the OpenCode backend)* |

Config changes made via the web UI (`POST /config`) take effect immediately
at runtime — no restart required. The config module uses ESM live bindings
(`export let`) so all consumers see updated values on their next access.
Interval and schedule changes are propagated to the scheduler via
`onConfigChange()` listeners that call `updateInterval()` /
`updateScheduledHour()`. The only exceptions are `port` (requires socket
re-bind), `whatsappEnabled` (requires QR pairing), and `emailEnabled`
(requires restart), which are shown as read-only in the UI.

Env vars always take priority over `config.json`. Fields set via env var
are shown as disabled in the config UI with a note indicating the override.

External tools `gh` and `claude` must be authenticated separately — Claws does
not manage their credentials.

`kubectl` is also available on the production host, configured with read-only
access to the k3s cluster. This provides Claws with the ability to inspect
cluster state (pods, logs, events, resources) when working on issues in the
`fleet-services` and `fleet-infrastructure` repositories. Access is read-only —
Claws cannot apply, delete, or modify cluster resources.

When `homeAssistantBaseUrl` and `homeAssistantToken` are configured, and the
call site opts in via `includeHomeAssistant: true`, the MCP server exposes two
HA tools: `ha_list_entities` (discovers entity IDs, current state, and
friendly names, filterable by domain or search substring) and
`ha_api_request` (generic GET/POST passthrough to any `/api/…` endpoint, able
to invoke any HA service). Every fleet call site gates that opt-in on
`isHomeAssistantConfigRepo(fullName)` (default-deny since #2064), so these
tools are only wired in when the agent is working on the
`home-assistant-config` repo — see [MCP Server Context](#mcp-server-context)
above. See [Home Assistant Integration](home-assistant.md) for the manual
HA-side setup runbook (what can/can't be GitOps'd, initial repo and token
setup) that is a prerequisite for this integration.

The WhatsApp gateway requires a one-time QR-code pairing step. See
[WhatsApp Setup](whatsapp-setup.md) for the full walkthrough.

## Technology Stack

- **Runtime**: Node.js 22
- **Language**: TypeScript (strict mode, ES2022 target, Node16 modules, ESM)
- **Database**: SQLite via better-sqlite3 (WAL mode)
- **Testing**: Vitest — co-located test files, heavy mocking of external boundaries. `vitest.config.ts` excludes `dist/**`: Vitest 4 dropped that from its default excludes, and CI's `npm run build` (tsc) emits compiled `dist/**/*.test.js` copies of every co-located test before `npm test` runs, so without the explicit exclude the whole suite silently runs twice — once from `src/`, once from the stale compiled copy (#2505)
- **CI**: GitHub Actions on self-hosted runner — build + test on every push
- **History cleanup**: Workflow-dispatch action for branch cleanup and `git-filter-repo` to audit/scrub git secrets
- **Releases**: Date-based version tags (`v<YYYY-MM-DD>.<N>`), tarball attached to GitHub Release. `release.yml`'s own build/test steps run under `nix develop` like `ci.yml` (#2343 — a bare `npm ci`/`node` step dies with exit 127 on a NixOS runner), but `node_modules` for the shipped tarball is built inside a `node:<major>-bookworm-slim` **Docker container** instead of the nix devShell, so the bundled `node-pty` native module links against Debian glibc and loads on the non-nix Ubuntu deploy host (#2348, after release `v2026-08-05.5` crash-looped and was rolled back); a release-time gate rejects any `.node` containing a `/nix/store` path or failing to `require()` under plain glibc. The container steps stream the workspace in over `tar | docker run -i` and copy results back out with `docker cp` — never `docker run -v "$PWD":...` — because a self-hosted runner's workspace bind mount is private to the runner unit's own mount namespace, so the docker daemon resolves that path in *its* namespace and mounts an empty directory instead (#2351; same failure class as the general [Docker-on-NixOS-runner pattern](patterns.md#docker-on-nixos-runners)). Inside that container, installing the `python3`/`make`/`g++`/`ca-certificates` toolchain (needed because `better-sqlite3`/`node-pty` fall back to `node-gyp rebuild`) retries `apt-get update && apt-get install` up to 3 times with a 15s backoff, clearing `apt-get clean`/`/var/lib/apt/lists` between attempts — added after a transient Debian-mirror outage failed a release outright, since `apt-get update` exits 0 even when index fetches fail and the existing `npm ci` retry loop didn't cover the `apt-get` pair at all (#2438).
- **Auto-updates**: systemd timer checks for new releases every 60s, downloads + swaps + health checks with automatic rollback

## Filesystem Layout (Runtime)

```
~/.claws/
├── config.json          Configuration file
├── env                  Environment overrides (loaded by systemd)
├── claws.db             SQLite database
├── whatsapp-auth/       Baileys auth state (created on first QR pairing)
├── repos/
│   └── <owner>/<repo>/  Main clone per repository
└── worktrees/
    └── <owner>/<repo>/
        └── <job>/
            └── <branch>/   Isolated worktree per task
```

## Kubernetes Deployment

Claws ships a container image for running on a Kubernetes cluster alongside
or in place of the systemd deployment. Plain-YAML manifests live in the
fleet-infra repo. The app remains a hard single-instance service — the
manifests encode that invariant rather than relaxing it.

**Shape.** A `StatefulSet` with `replicas: 1` and `podManagementPolicy:
OrderedReady`, a 50 Gi `ReadWriteOnce` PVC at `/home/claws/.claws` (SQLite
WAL needs real local storage), `terminationGracePeriodSeconds: 360` to cover
the 300 s scheduler drain in `src/main.ts`, and liveness/readiness probes on
`GET /health`. The container runs as the non-root `claws` user (uid 1000);
`fsGroup: 1000` fixes PVC ownership on first mount.

**Verify-only rollout.** A fresh pod boots with `activationState:
"verify-only"`. In this mode:

- The job scheduler is started with an empty job set.
- The WhatsApp gateway does not pair (so it doesn't claim the single device
  slot belonging to the systemd instance).
- GitHub App config is not required at startup.
- `runConnectivityVerification()` fires once and records a report into
  `verification_reports`.

A `/verify` page renders the latest report — database, GitHub App, every
CLI (`gh`, `claude`, `codex`, `opencode`), OpenRouter, Slack webhook (DNS
only — no POST), IMAP login/logout, per-runner SSH, datasette SSH, Ollama,
WhatsApp auth. Each check is wrapped in a 30 s timeout.
A red verify-only banner appears on every page of the dashboard.

Flipping to `active` is explicit: either click **Activate** on the Config
page (writes `activationState: "active"` and prompts for a pod restart) or
set `CLAWS_ACTIVATION_STATE=active` in the secret and restart. The loader
also auto-selects `active` if `claws.db` already exists on the data volume
at startup — so copying a populated PV from the systemd host does not
accidentally re-enter verify-only.

**Image.** `ghcr.io/st-john-software/claws:<tag>` plus `:latest`, built and
pushed by the `docker` job in `.github/workflows/release.yml` on every
release tag.

**Concurrency guard.** `src/main.ts` writes `claws.pid` into the data dir at
startup and refuses to start if a live sibling holds the lock (checked via
`process.kill(pid, 0)`). This is belt-and-braces on top of the StatefulSet's
single-replica guarantee: if a rolling update ever double-schedules the
pod, the newcomer crash-loops instead of corrupting the WAL.

See the fleet-infra repo for the operator playbook (secrets, cutover from
systemd, troubleshooting).

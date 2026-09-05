# Claws — Overview

Claws is a self-hosted
GitHub automation service. It polls GitHub repositories on configurable timers,
identifies work items via comment analysis, reactions, and PR state, and
delegates tasks to the Claude CLI in isolated git worktrees. It runs either as
a Linux systemd service or as a Kubernetes pod — see
[Kubernetes Deployment](#kubernetes-deployment).

## Doc map

| Doc | Read this when | Depth |
|---|---|---|
| [OVERVIEW.md](OVERVIEW.md) | You're starting work on this repo and need to route to the right doc | Entry point |
| [ARCHITECTURE.md](ARCHITECTURE.md) | You want the same picture as this doc, as Mermaid diagrams | Entry point |
| [modules.md](modules.md) | You already know which `src/` file you're changing and need its exports, gotchas and rationale | Reference |
| [patterns.md](patterns.md) | You need a pattern's edge cases or rationale, not just its name | Reference |
| [configuration.md](configuration.md) | You need a config key/env var/default not in this doc's compact table | Reference |
| [database-schema.md](database-schema.md) | You're adding or migrating a SQLite table | Deep dive |
| [requirements.md](requirements.md) | You need a cross-cutting owner requirement or constraint | Reference |
| [claws-automation.md](claws-automation.md) | You need this repo's issue/PR lifecycle rules (synced automatically — never hand-edit) | Reference |
| [jobs/README.md](jobs/README.md) | You're changing a job and need the shared lifecycle plus the per-job doc index | Reference |
| [DESIGN.md](DESIGN.md) | You're touching dashboard HTML/CSS and need the styling rules | Reference |
| [agent-notes.md](agent-notes.md) | You hit an operator/host gotcha that doesn't belong to one subsystem doc | Reference |
| [postmortem-process.md](postmortem-process.md) | You're writing up an incident in any managed repo | Deep dive |
| [harness-landscape.md](harness-landscape.md) | You're about to propose adopting a coding-harness project (records why Claws adopts none, so it isn't re-proposed) | Deep dive |
| [tool-evaluations.md](tool-evaluations.md) | You're about to propose adopting a third-party tool/framework (records prior decisions, so they aren't re-proposed) | Deep dive |
| [capabilities-scala3.md](capabilities-scala3.md) | You're curious how Claws' session capability model maps onto Scala 3 capture-checking (#2556, analysis only) | Deep dive |
| [label-audit.md](label-audit.md) | You need real usage counts for a GitHub label before adding/removing one | Deep dive |
| [home-assistant.md](home-assistant.md) | You're setting up or debugging the Home Assistant integration's manual HA-side steps | Deep dive |
| [whatsapp-setup.md](whatsapp-setup.md) | You're setting up or debugging the WhatsApp gateway pairing flow | Deep dive |
| [dspy-prompt-analysis.md](dspy-prompt-analysis.md) | You're evaluating DSPy for analysing Claws' agent prompts (#1828) | Deep dive |
| [blog-post.md](blog-post.md) | You want the published blog post about this project, not a technical doc | Deep dive |
| [k8s-cutover.md](k8s-cutover.md) | You're cutting the k8s deployment over from the systemd host, or operating it afterward (#2752) | Deep dive |

**Start here:** planning a feature — [requirements.md](requirements.md), [ARCHITECTURE.md](ARCHITECTURE.md); changing a job — [jobs/README.md](jobs/README.md); debugging GitHub automation — [claws-automation.md](claws-automation.md), [patterns.md](patterns.md); changing config — [configuration.md](configuration.md); reviewing UI work — [DESIGN.md](DESIGN.md).

## Architecture

Full per-file detail (exports, gotchas, design rationale) lives in [modules.md](modules.md); the tree below is a compact map of the entire `src/` directory.

```
src/
├── main.ts                          Entry point — PID lock, DB init, crash/work-queue recovery, job registration, shutdown
├── config.ts                        Configuration loading (env > config.json > defaults), INTERNAL_MCP_TOKEN, live reload
├── scheduler.ts                     Interval/schedule-based job runner — skip-if-busy, triggers chains, pause/resume
├── smart-schedule.ts                Smart-scheduling gate — staleness-based per-repo selection with SLO escape valve; shared daily-repo-loop helpers
├── github.ts                        gh CLI wrapper — retry, rate-limit circuit breaker, queue cache, Zod-validated parsing
├── github-app.ts                    GitHub App auth — JWT signing, per-owner installation tokens, git credential env
├── forgejo.ts                       Forgejo/Gitea REST client — mirrors github.ts's shapes so github.ts can route Forgejo repos
├── claude.ts                        Claude/Codex/OpenCode CLI runner — worktree helpers, env sanitization, push/rebase
├── db.ts                            SQLite database (better-sqlite3) — 20 tables for tasks, queue, sessions, usage, etc.
├── server.ts                        HTTP server (Hono) — dashboard, health, status, manual triggers, WebSocket bridge
├── capabilities.ts                  Session capability registry — gated capability bundles, ssh:<alias> capabilities, env stripping for sessions, browser (Playwright MCP) capability
├── sessions.ts                      Interactive PTY session manager — tmux-backed, capability-gated env, strict Claude MCP config, isolated Codex homes, multi-worktree
├── log.ts                           Timestamped logging (four levels) + Slack error escalation
├── slack.ts                         Slack incoming-webhook + Bot API (ideas, notifications)
├── model-selector.ts                Provider-aware model selection (Claude/Codex/OpenCode, cheap/sonnet/opus tiers, config override)
├── classify-complexity.ts           Lightweight Claude call classifying whether a task warrants opus-level reasoning
├── ollama-rate-limit-classifier.ts  Ollama-based rate-limit error classification with regex fallback
├── error-reporter.ts                Deduplicating GitHub issue-based error reporter (30 min cooldown, filters transient errors)
├── agent-auth-state.ts              Per-provider latched "agent CLI credentials expired" state — one Slack alert + one [claws-error] issue per episode instead of one per task; cleared by the next successful run on that provider or a web re-auth
├── agent-memory.ts                  Reads agent memories from the `claude-memories` branch (all host slugs per repo) for doc-maintainer to fold into docs/ (#2666, #2757)
├── images.ts                        Image/attachment extraction, SSRF-guarded download, for issue/PR context
├── whatsapp.ts                      WhatsApp Web client (Baileys) — QR pairing, message routing, Slack pairing alerts
├── transcribe.ts                    Voice-note transcription — local/remote Whisper with circuit breakers, OpenAI fallback
├── dmarc.ts                         Pure DMARC aggregate-report parser — zip/gzip decompression, minimal XML reader, per-row verdict classifier
├── format.ts                        Duration formatting (formatMs: milliseconds → human-readable)
├── version.ts                       Build-time injected version string
├── plan-parser.ts                   Parses structured implementation plan comments into phases
├── phase-coverage.ts                Multi-PR phase coverage — which plan steps are already covered by an open/merged PR or an explicit claim
├── timeout-handler.ts               Central per-item Claude timeout escalation and auto-skip
├── outcome.ts                       Task outcome builders (success/failure metadata, failure categorization)
├── occurrence-tracking.ts           Shared helpers for recurring alert issues (ensureAlertIssue, closeAlertIssueIfResolved, etc.)
├── prompt-guard.ts                  Prompt injection detection and content redaction for untrusted GitHub text
├── mcp-server.ts                    Standalone stdio MCP server exposing Claws state to Claude sessions
├── ha-mcp.ts                        Standalone HA MCP handler — ha_list_entities/ha_api_request with strict path validation
├── worker.ts                        SQLite-backed work queue — worker fibers, registered handlers, crash recovery
├── work-handlers.ts                 Registers per-kind work handlers with worker.ts; wires auto-merger sweep chain
├── retry.ts                         retryWithBackoff() — generic exponential-backoff retry helper extracted from gh()/git()
├── ttl-cache.ts                     TTLCache — shared TTL/dedupe cache class used by github.ts and forgejo.ts
├── rate-limit.ts                    GitHub API rate-limit circuit breaker — RateLimitError, cooldown state, shared by github.ts/github-app.ts
├── github-status.ts                 GitHub-wide incident state — polls githubstatus.com summary.json; gates error-reporter suppression and ci-fixer's incident pause; records recent incident windows for agent prompts
├── claude-auth.ts                   Server-side orchestration of the claude setup-token OAuth flow via node-pty
├── codex-auth.ts                    Server-side orchestration of the codex login --device-auth device-code flow via node-pty
├── json-extract.ts                  Multi-strategy JSON extraction/repair for LLM outputs; isCompleteJson() truncation detection
├── util.ts                          sleep(), resolveIdentityFile(), mapWithConcurrency()/mapSettledWithConcurrency() bounded-concurrency helpers
├── sensitive-env.ts                 Exports SENSITIVE_ENV_KEYS — zero-dependency leaf module for capabilities.ts
├── host-policy.ts                   HOST_EXECUTION_POLICY/HOST_POLICY_MARKDOWN/HOST_POLICY_RULES — zero-dependency leaf module shared by prompt injection and host-policy-scanner
├── session-env-file.ts              Per-session capability env files — writes/prunes 0600 credential files for spawned sessions; also owns the per-session MCP-config/browser-profile/Codex-home dir
├── session-uploads.ts               Per-session upload dir — sanitized writes, 10 MB inline / 1 GB streamed, per-session quota; audio uploads are transcribed via transcribe.ts and typed into the PTY
├── ssh.ts                           Shared SSH/scp helpers — buildSshArgs, execCapture, isSafeAbsolutePath path validation
├── home-assistant.ts                Home Assistant REST API client — listStates, callService, update installation; plus a WebSocket registry client (withHaWebSocket, area/entity registry read + entity area update)
├── mcp-result.ts                    Shared MCP tool-result helpers (ToolResult, textResult, errorResult)
├── shutdown.ts                      Graceful shutdown flag + ShutdownError class (shared across modules)
├── test-helpers.ts                  Test factories (mockRepo, mockIssue, mockPR)
├── pwa.ts                           PWA support — manifest, inline SVG icon, PNG rasterization; no service worker
├── resources/  11 files — generated/vendored asset constants (Alpine.js, Chart.js, Tailwind CSS, esbuild bundles of client/*.ts); see modules.md
├── client/      6 files — client-side TypeScript, esbuild-bundled into resources/*.generated.ts; see modules.md
├── pages/      21 files — dashboard HTML page builders, one per route; see modules.md
├── agents/      9 files — per-item planning/implementing/reviewing functions invoked by dispatcher jobs; see modules.md
└── jobs/       60 files — registered jobs plus shared job-runner utilities (scanner-runner, workflow-parser); behavior of every job is in the [Jobs](#jobs) table below and [jobs/README.md](jobs/README.md), per-file detail in modules.md

deploy/
├── claws.service           systemd service unit (Restart=always so an unexpected clean exit (stray SIGTERM) is restarted, #2638; KillMode=process preserves tmux sessions across restarts; cgroup limits: MemoryHigh=4G, MemoryMax=5G, TasksMax=800, CPUWeight=80, OOMScoreAdjust=200 — raised from 2.5G/3G for browser-driving session capability headroom, #2510)
├── claws-updater.service + claws-updater.timer   systemd updater service + its 60s timer
├── install.sh              One-shot bootstrap installer
├── deploy.sh               Auto-update with Node ABI gate, health check, and rollback (see [Auto-Update & Rollback](#auto-update--rollback))
├── install-skills.sh       Installs bundled repo-local skills (e.g. `/postmortem`, `/ship`) from `deploy/skills` / `.skills` into both `$CLAWS_HOME/.claude/skills/` and `${CODEX_HOME:-$CLAWS_HOME/.codex}/skills`; run by both install.sh and deploy.sh on every deploy
├── whisper.service         systemd unit for the self-hosted faster-whisper transcription server (see whisper-server.py)
├── whisper-server.py       Self-contained PEP-723 script (`uv run --script`) — minimal OpenAI-compatible `/v1/audio/transcriptions` server via faster-whisper; replaced an un-installable Speaches unit (#2122) — see [Voice-note transcription](whatsapp-setup.md#step-2--voice-note-transcription-on-by-default)
└── uninstall.sh            Service removal
```

## Jobs

Forty-one registered jobs run on timers or schedules, plus one event-driven handler.
See [Jobs](jobs/README.md) for detailed behavior of each.

| Job | Trigger | Interval | Summary |
|-----|---------|----------|---------|
| `issue-dispatcher` | All open issues per repo | 5 min | Unified dispatcher — classifies issues and delegates to planner (issue-refiner) and implementer (issue-worker) agents; the planner may also transfer an obviously mis-filed issue to another same-owner managed repo (#2216); the routing comment deliberately avoids the `## Implementation Plan` header so the destination re-plans; the implementer honours a plan's `CLAWS_TARGET_PR: #N` directive by committing onto that PR's branch instead of opening a stacked PR (#2720) |
| `pr-dispatcher` | All open PRs per repo | 5 min | Unified dispatcher — classifies PRs and delegates to CI fixer, review addresser, reviewer (pr-reviewer), and merger (auto-merger) agents; closes empty PRs (0 changed files) and superseded dependabot PRs (Problematic + closed major-bump tracking issue + base-branch version re-check) before dispatching |
| `triage-claws-errors` | `[claws-error]` issues in `SELF_REPO` | 10 min | Investigates internal Claws errors, deduplicates by fingerprint, posts report |
| [`doc-maintainer`](jobs/doc-maintainer.md) | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Updates `docs/` to reflect current codebase; also ensures human-authored issue/PR requirements are reflected in the feature docs, with cross-cutting ones recorded in `docs/requirements.md` (#2090, #2227); also folds durable facts from each AI provider's memory store (`~/.claude/projects/<slug>/memory`, `~/.codex/memories`) into the repo's docs so they reach agents on any provider (#2666); also creates/refines per-role agent guidance (`.agents/issue-refiner.md`, `.agents/issue-implementer.md`, `.agents/pr-reviewer.md`) and repo-local `.skills/**/SKILL.md`, exempting the skip gate when a role document is missing (#2713) |
| `repo-standards` | Daily at 2 AM (+ on startup) | Scheduled | Syncs labels and cleans legacy labels for each managed repo; removes stale local clones |
| `improvement-identifier` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos; paused Fri 18:00 → Sun 18:00 local so issues don't pile up over the weekend (manual trigger bypasses) | Smart-scheduled | Reviews codebase via OpenCode/OpenRouter (`improvementIdentifierModel`, default `openrouter/z-ai/glm-5.3`; falls back to Claude) for security issues and important-only improvements (correctness bugs, reliability failures, measured performance/cost problems, recurring operational burden — no refactors/dedup/dead-code/TODOs); files improvement issues tagged `severity: high` (fail-closed) when no security work is queued and fewer than 3 of its own improvement issues are still open, up to 2 per run; no longer opens PRs; skips fork-PR hardening findings on private repos (uses `isRepoPrivate()`); conditionally adds Web/SEO and JSON-LD guidance for repos that serve user-facing HTML |
| `public-repo-scanner` | Daily at 4 AM (`publicRepoScannerHour`); 7-day per-repo throttle | Scheduled | Enumerates all public repos for all owners (including archived, via `listPublicReposIncludingArchived()`); asks Claude to scan each for live secrets, private keys, and credentials; files alert issues via `ensureAlertIssue()`; does NOT write MCP config (no MCP config written); findings on a `PUBLIC_SNAPSHOTS` target repo are filed to `SELF_REPO`, never the private source (#1875, #1962) |
| `idea-suggester` | Manual trigger only | — | Suggests ideas per repo and files the top-scoring ones directly as GitHub issues |
| `issue-auditor` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Reconciles issue states, manages Ready and In Review labels |
| `whatsapp-handler` | WhatsApp message | Event-driven | Interprets messages via Claude, creates GitHub issues |
| `runner-monitor` | Self-hosted GH Actions runners | 10 min | SSHes to runners, checks service health, restarts dead services, tiered disk cleanup (>85% tier 1, >90% tier 2), files issue when disk stays critical post-cleanup; supports both self-installed `svc.sh` runners and NixOS `systemd` units |
| [`host-disk-monitor`](jobs/host-disk-monitor.md) | Claws' own host (`openclaw`) | 10 min | Local (no SSH) disk check on the filesystem holding `WORK_DIR`; tiered cleanup with **no `docker` commands** — npm/npx caches, `/tmp` scratch reclamation (Claude CLI session output, leaked `nix-shell` TMPDIRs, node/jest compile caches; 24 h file-age gate, #2535), aggressive (24 h) worktree reaping, journal/apt at tier 1 (>80%), `nix-collect-garbage -d` plus browser and tool caches at tier 2 (>88%, or >80% when tier 1 fails to recover, 6 h cooldown); files a deduped issue when cleanup doesn't recover space, and a separate tripwire issue if a container runtime appears on this plan-only host (#2386) |
| `mac-runner-waker` | Queued jobs in `bonkus`, `namey`, `TempoStatusBar` | 1 min | Wakes sleeping self-hosted Macs over SSH when a macOS CI job has been queued for >60 s, selecting the Mac by `runs-on` label match; SSH wake failures raise a per-host `[claws-error]` alert issue, except failures where the Mac never answered (unresolvable hostname, no route, network unreachable, connect timeout), which log a warning and send one Slack notice per absence episode instead — only failures proving a live host (connection refused, auth, host-key) raise an issue; a runner still offline in GitHub's registry 3 min after its wake raises `mac-runner-offline:<host>` |
| `scanner-dispatcher` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Runs eleven scanners sequentially (one failure doesn't block others): ubuntu-latest, concurrency, migration, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, dependabot-config, design-guidelines, [dynamic-workflow-runner](jobs/dynamic-workflow-runner-scanner.md), host-policy |
| `stale-branch-cleaner` | Hourly; selects repos stalest-first (age ≥ 24h); skips when Claws busy unless SLO (48h) breached; max 4 concurrent repos | Smart-scheduled | Deletes stale `claws/*` remote branches whose PRs have been merged or closed for 7+ days |
| `email-monitor` | Unread emails in configured Gmail inbox | 5 min | Polls Gmail via IMAP, extracts veg box contents via Claude, generates recipes, emails results |
| `dmarc-monitor` | Called by `email-monitor` per message (not scheduled) | — | Ingests DMARC aggregate reports into SQLite, classifies each row, alerts on spoofs/unaligned senders/policy drift; no Claude call |
| [`k3s-monitor`](jobs/k3s-monitor.md) | k3s cluster pods/nodes | 15 min | Monitors cluster health via `kubectl`, detects failing pods, unhealthy nodes, and Flux Kustomization/HelmRelease failures; raises alert issues to `FLEET_INFRA_REPO` with the `Priority` label and occurrence tracking |
| `github-status` | All GitHub API/git work | 2 min | Polls `githubstatus.com` summary.json for the components Claws depends on (Git Operations, API Requests, Webhooks, Issues, Pull Requests, Actions); surfaces the result on the dashboard's Integrations panel and Slack-notifies once per incident transition; while a depended-on component is non-operational, `error-reporter` downgrades gh/git CLI failures to warnings instead of filing `[claws-error]` issues, `ci-fixer` pauses fix attempts and breaker trips for incident-shaped failures (no repo step reached, missing log, or a GitHub-side error signature — `isPreRepoStepFailure`/`looksLikeGitHubOutageFailure`), `[ci-unrelated]` occurrences logged in the window are tagged as incident fallout rather than recurring flakiness, and the diagnosis/planning prompts (ci-fixer classify + fix, problematic-PR diagnoser, issue-refiner plan + refine) carry a `<github_incident_status>` block built by `gitHubIncidentContext()` from the snapshot plus `getRecentDegradedWindows()` (24 h, in-memory) |
| `prod-k8s-monitor` | Prod k8s cluster pods/nodes | 15 min (configurable) | Same detection as `k3s-monitor` but for the prod cluster via `prodK8sKubeconfigPath`; files alerts to `prodK8sRepo` (default `St-John-Software/production-infra`); disabled by default — enable via `prodK8sMonitorEnabled: true` |
| `runner-metrics-sync` | GitHub Actions workflow runs | 2 min (adaptive) | Syncs recent workflow runs to the `workflow_runs` SQLite table; skips API calls when Claws is idle and last sync was <15 min ago; reconciles stale `queued`/`in_progress` rows via `fetchWorkflowRunById()` (deletes runs that GitHub no longer knows about); backs off to zero cost at rest |
| [`claude-memory-backup`](jobs/claude-memory-backup.md) | Local `~/.claude/projects/*/memory/*.md` | 1 h | Commits and pushes Claude memory files to the orphan `claude-memories` branch of the private self-repo; skips entirely when the scan finds no files — this is `doc-maintainer`'s memory feed, not just a backup |
| [`auth-secret-sync`](jobs/auth-secret-sync.md) | `~/.codex/auth.json`, `~/.claws/env` | 10 min | Writes rotated Codex/Claude credentials back into the `claws-auth` Secret via the pod's ServiceAccount so a restart does not revert to the bootstrap token; silent no-op off-cluster |
| `ha-upgrader` | Home Assistant `update.*` entities | 24 h | Installs pending Core/Supervisor/OS and device/integration updates within configurable dwell windows; raises alert issues on failure. Full detail: [home-assistant.md](home-assistant.md#automated-upgrades-ha-upgrader-job) |
| `ha-deploy-watcher` | git-pull addon logs | 5 min | Polls git-pull addon logs; posts a Slack notification (commit list, compare link, diffstat) only when the config check errors/warns, and files/closes a `Priority` alert issue on error. Full detail: [home-assistant.md](home-assistant.md#deployment-notifications-ha-deploy-watcher-job) |
| `ha-area-reconciler` | `registry/areas.yaml` in `home-assistant-config` | 30 min | Reconciles the manifest's `entities:` and `devices:` blocks to the live area/device registries over the WebSocket API (enforcing — a manual UI change is reverted); `floors:`/`areas:` stay report-only. Full detail: [home-assistant.md](home-assistant.md#entity-area-assignments-registryareasyaml) |
| `ha-energy-reconciler` | `registry/energy.yaml` in `home-assistant-config` | 30 min | Reconciles the manifest to the live Energy dashboard prefs (`energy/get_prefs` → `energy/save_prefs`, full authority); refuses to save an empty `energy_sources`. Full detail: [home-assistant.md](home-assistant.md#energy-dashboard-configuration-registryenergyyaml) |
| `worktree-cleaner` | All `~/.claws/worktrees/` directories | 24 h | Removes worktrees >7 days old that aren't in any running task or persisted session; uses `git worktree remove --force` with `rm -rf` + `git worktree prune` fallback; logs removed count and freed bytes |
| `bin-day-monitor` | Home Assistant bin-day sensors | 15 min | Polls `sensor.bin_scraper_*` entities; maintains a single persistent GitHub issue as a running availability log; records status transitions (HEALTHY ↔ MISSING) in an embedded history table; never closes the issue on recovery; disabled by default (`homeAssistantBinDayMonitorEnabled`) |
| `ha-battery-monitor` | Home Assistant battery sensors | 1 h | Polls HA entities with `device_class=battery` and `unit_of_measurement=%`; creates a `Priority` issue listing all devices at or below `homeAssistantBatteryThresholdPercent` (default 10%); auto-closes the issue when all devices recover; body is rebuilt in-place each tick without posting comments; disabled by default (`homeAssistantBatteryMonitorEnabled`) |
| `ha-backup-monitor` | `event.backup_automatic_backup`, `binary_sensor.backup_overdue`, `sensor.backup_last_successful_automatic_backup` | 1 h | Three independent static-title `Priority` alerts, each created/edited via `findIssueByExactTitle`/`createIssue`/`editIssue` (skipping the edit when the body is byte-identical) and auto-closed via `closeAlertIssueIfResolved`: `[ha-backup-monitor] Home Assistant automatic backup failed` when the event entity's `attributes.event_type` is `failed` (closes on `completed`; an `in_progress` event type is inert — neither raises nor closes); `[ha-backup-monitor] Home Assistant backups are overdue` when `binary_sensor.backup_overdue` is `on` (closes on `off`); and `[ha-backup-monitor] Home Assistant backup monitor is blind — binary_sensor.backup_overdue unavailable` when that same sensor has been absent or `unavailable`/`unknown` for over 48 h — tracked via the `ha_entity_unavailable` DB table since a template entity's `last_changed` resets on every HA Core restart — auto-closed once the sensor reads `on`/`off` again. Either entity being absent or `unavailable`/`unknown` is still a no-op (debug log only) for the failed-backup alert and within the 48 h window for the overdue sensor, so a Core-restart blip can't auto-close a real alert or file a bogus one; disabled by default (`homeAssistantBackupMonitorEnabled`) |
| `ha-deploy-stall-monitor` | `binary_sensor.deploy_pipeline_stalled` | 15 min | Single static-title `Priority` alert, created/edited via `findIssueByExactTitle`/`createIssue`/`editIssue` and auto-closed via `closeAlertIssueIfResolved`: `[ha-deploy-stall-monitor] Home Assistant deploy pipeline stalled — core_git_pull did not self-heal` when the sensor is `on` (it only goes `on` after a 45 min unhealthy `core_git_pull` add-on state survives an automatic restart), closes on `off`; the entity being absent, `unavailable`, or `unknown` is a no-op (debug log only); body embeds `sensor.git_pull_addon_state` and is a pure function of that state (no timestamp), so a persistent stall skips the edit every tick instead of an `editIssue` per tick; enabled by default (`homeAssistantDeployStallMonitorEnabled`) |
| `ha-repairs-monitor` | Home Assistant repairs (`repairs/list_issues`, WebSocket-only) | 1 h | Reads the un-ignored repairs list, then applies the `homeAssistantRepairsIgnore` suppression list (domain + translation key + placeholders) on top of HA's own `ignored` filter, and the `frontend/get_translations` resources needed to render each repair's title; maintains a single static-title `Priority` alert via `upsertAlertIssue`, `[ha-repairs-monitor] Home Assistant repairs need attention`, listing every open repair sorted by severity then domain then `issue_id` for a byte-stable body, and auto-closed via `closeAlertIssueIfResolved` once no un-ignored repairs remain; a failed or unauthorised WebSocket read warns and returns without touching GitHub, never closing the alert on a blind spot; a translation-lookup failure degrades to a backticked `translation_key`/`issue_id` title rather than aborting the run; enabled by default when HA is configured (`homeAssistantRepairsMonitorEnabled`) |
| `actions-storage-monitor` | All repos | Daily at 5 AM (`actionsStorageMonitorHour`) | Scans GitHub Actions cache + artifact storage per repo; files per-repo alert when a repo uses ≥ 50 MB of Actions **cache** or has artifacts older than 7 days (high retention); org-level roll-up alert when total usage ≥ 80% of 2 GB account quota |
| `dependabot-alert-monitor` | All repos | Smart-scheduled | Polls `GET /repos/{owner}/{repo}/dependabot/alerts?state=open` per repo; auto-dismisses stale alerts in two passes — SBOM-based (gated by `dependabotAutoDismissStale`, default on) then manifest-pin-based for pip packages with `==` pins (handles SBOM lag); files an `ensureAlertIssue` listing the remaining open alerts sorted by severity, with an embedded `REMEDIATION_GUIDANCE` block ordering remediation steps (remove unneeded deps, classify dev vs runtime, bump direct deps, use `>=` ranges in overrides); classifies the remaining alert set as routine (npm, patched version available, no breaking version jump, ≤10 alerts) or needs-review, applying/removing `Automerge` on the alert issue accordingly and explaining any blockers in the body (`dependabotAutoRemediate`, default on); the issue body is refreshed each tick; auto-closes the issue once alerts clear; leaves repos with scanning disabled as-is; if the App lacks `dependabot_alerts: read`, files a remediation issue on `SELF_REPO` (throttled hourly) |
| `dependabot-run-monitor` | All repos | Smart-scheduled | Polls the *dynamic* Dependabot updater runs (`GET /repos/{owner}/{repo}/actions/runs?event=dynamic`, filtered on `path == "dynamic/dependabot/dependabot-updates"`), keeps the latest completed run per ecosystem group from the last 30 days, cross-checks each failing group against the repo's live `.github/dependabot.yml` and drops groups whose `package-ecosystem`/`directory` entry has been removed (GitHub retains a retired ecosystem's last failing run as the permanent "latest", which otherwise re-alerts for 30 days — #2205)…also drops groups whose job log contains only runner/infrastructure abort lines (runner shutdown, operation cancelled), which GitHub records as conclusion "failure" rather than "cancelled" (#2571); fails open and reports everything when the config is unreadable or unparsable, scrapes the failed job log tail for the error, and files/auto-closes one unlabelled `ensureAlertIssue` when the updater is failing — the only coverage for a workflow that has no repo file and so cannot be watched by `on.workflow_run` |
| [`main-build-monitor`](jobs/main-build-monitor.md) | All repos (GitHub + Forgejo) | 5 min (`mainBuildMonitorMs`) | Reads the completed `push`/`schedule` runs `runner-metrics-sync` already stores for each GitHub repo's default branch (a `forge: "forgejo"` repo instead fetches directly via `forgejo.listDefaultBranchActionRuns()`, since Forgejo Actions history is never synced), keeps the latest run per workflow, and for a new `failure` re-runs the failed jobs exactly once when the run is still on the branch tip (`head_sha` equality — re-running a superseded run would republish a stale artefact), is on its first attempt, is under 4 h old, and classifies as transient (`isInfrastructureOutage`/`isPreRepoStepFailure`, or a `TRANSIENT_LOG_PATTERNS` match on the failed job's log when exactly one job failed); a retry that fails again — or a failure that never looked transient — files/bumps an unlabelled `ensureAlertIssue` titled `Build failure: <workflow>` (renaming production-infra's legacy `[main] <workflow> failed on main` rather than forking a duplicate) and pages `notifyProdAlert` for `PROD_ALERT_WORKFLOWS`; a later green run of the same workflow comments and closes the issue unless it carries `Refined`/`In Review`/`Claws Ignore`. Forgejo repos never take the retry path (`rerunFailedJobs` is a documented no-op there, and there is no rerun endpoint), so every Forgejo failure goes straight to the issue. Replaces the eleven per-repo `notify-failures.yml` copies, which never retried — `St-John-Software/namey#1881` was a pure `ECONNRESET` against `registry.npmjs.org` that went green unchanged on the next push, after costing a full planner run |
| [`dependabot-tofu-unblocker`](jobs/dependabot-tofu-unblocker.md) | `St-John-Software/bstjohn-blog` `dependabot/terraform/*` PRs | 15 min (`dependabotTofuUnblockerMs`) | Pushes an empty `ci: run tofu plan` commit (Git Data API, no force) onto a Dependabot `terraform` PR whose diff is confined to `tofu/versions.tf` and `tofu/.terraform.lock.hcl`, so bstjohn-blog's Tofu Plan gate sees a non-Dependabot actor and produces a real plan instead of hard-failing; a PR touching any other file is left red with a decline comment for a human; ci-fixer is excluded from these PRs so it can't independently try to "fix" the check |
| `damp-reminder` | N/A | 15 min (`dampReminderMs`) | Checks `hasDampReadingLoggedSince(weekStart)` and auto-closes the open reminder once readings are logged this week (once per week via an in-memory guard); on Monday local time ≥ 9 AM with no readings yet, files a single deduplicated `Priority` issue in `SELF_REPO` (via `findIssueByExactTitle`/`createIssue`, not `ensureAlertIssue` — a one-shot-per-period reminder must not have its body rewritten on every tick) reminding readings be logged on the `/damp` dashboard page |
| `public-snapshot-sync` | `PUBLIC_SNAPSHOTS` source→target pairs | Daily at 3 AM (`publicSnapshotSyncHour`, #2106 — was weekly via `publicSnapshotSyncMs`; chosen to slot between `repo-standards` (2 AM) and `public-repo-scanner` (4 AM), outside UK office hours) | Rebuilds each public `stjohnb/*` target from its private source via `git archive` (tracked files only, #1833), scrubbing `.claude`, `.plans`, `ideas/`, MCP config, dependabot files, `BLOG_IDEAS.md`, `HOMELAB_IDEAS.md`, and any pair-specific `scrubPaths` (#1962); publishes `.github/workflows` but disabled — `disableWorkflowTriggers()` rewrites each workflow's `on:` block to `workflow_dispatch:` only (#1835); runs a fail-closed secret scan against a path+pattern `SCAN_ALLOWLIST` for known-safe placeholders (#1833/#1836), now also covering credential-bearing webhook URLs (#2445) and modern Anthropic/OpenAI/OpenRouter key formats (#2550); files over 2 MB are scanned in bounded 2 MB chunks rather than skipped (#2599); disables Dependabot; pushes exactly one commit summarising features since the last sync (tracked via `.claws-snapshot.json`), or — for a `scrubPaths` pair — force-pushes a single squashed root commit every sync so a scrubbed path can't survive in ancestor history (#1962, mutually exclusive with `mirrorReleases`); for pairs with `mirrorReleases: true` (TempoStatusBar), also mirrors the latest stable GitHub release's assets to the target (#1851) — all assets on the source release are mirrored, and the `releaseAssetUrl` S3 fallback (public S3, #2115) applies only to `v1.2.3`-shaped mac tags with no `.dmg` on the GitHub Release, not the `linux-v*` line (#2813); idempotent via the stored source SHA, so a daily no-op run (no new source commits) is fast; never un-archives a target — a missing/archived target alerts on `SELF_REPO` and is skipped; commit subject and body are derived from the change summary and never name the private source repo, and a target whose published history still names the source is force-resynced once, rewriting historical messages on branches and tags (#2362) |
| [`reminder-monitor`](jobs/reminder-monitor.md) | All repos | Daily at 8 AM (`reminderMonitorHour`, #2355) | Reads `docs/scheduled-reminders/*.md` from each repo's default branch, parses YAML frontmatter, and files a GitHub issue once local `today >= notify_on`; dedup key is `(repo, reminder id, notify_on)` in SQLite so a human closing the issue doesn't cause a re-file; malformed files raise a single per-repo `ensureAlertIssue` instead of one issue per file |
| [`upstream-watcher`](jobs/upstream-watcher.md) | `docs/upstream-watches/*.yaml` in `SELF_REPO` | Daily at 10 AM (`upstreamWatcherHour`, #2617) | Polls the upstream PRs/issues/releases each watch file declares, and once every condition is met (`require: all`, or one with `require: any`) removes `Blocked` (and any legacy `Claws Ignore`) from the parked target issue, adds `Ready`, and comments listing what fired — the documented re-plan signal, so the normal refine/implement pipeline picks the issue up. External repos are read via `getUpstreamPRStatus`/`listReleases` with an installation token (authenticated, so off the 60 req/hr anonymous bucket); upstream titles and tags are `guardContent()`-ed before they enter the comment, since a self-authored comment is never re-guarded when read back. Posts nothing while conditions are unmet (a watch may sit for months). Dedup key is `(watch id, repo, issue)` in SQLite, so re-applying `Blocked` (or the legacy `Claws Ignore`) by hand doesn't re-fire; a closed target issue is skipped without recording, so reopening re-arms it. A PR closed unmerged raises a `Claws Ignore`-labelled "can never fire" alert instead of firing; malformed files raise a single `ensureAlertIssue` carrying the schema |
| [`blog-draft-scanner`](jobs/blog-draft-scanner.md) | All repos except `bstjohn-blog` (opt-out per repo via the `/jobs` matrix) | Daily at 9 AM (`blogDraftScannerHour`, #2560) | Scans `docs/`, `ideas/`, `drafts/`, `docs/blog-drafts/`, `blog-drafts/` in each repo for draft blog posts (by filename/heading/frontmatter heuristics and a prose-paragraph threshold), and files a port issue in `bstjohn-blog` for any draft not already published there (matched by normalized title or slug); dedup key is `(repo, path)` in SQLite so editing a draft after the port issue is filed doesn't re-file it; skips the run entirely if the published-post listing comes back empty, to avoid spurious re-filing |
| [`site-promoter`](jobs/site-promoter.md) | `docs/promotion/*.yaml` in managed repos (opt-out per repo via the `/jobs` matrix) | Daily at 11 AM (`sitePromoterHour`, #2854) | Website promotion (#2854) — parses each repo-owned manifest, resolves each active site's channels against the `PROMOTION_CHANNELS` catalogue (16 channels, cadences 14–180 days), and for the sites whose channels are due runs one OpenCode/OpenRouter `plan` agent (`strictProvider`, so an outage fails the site rather than silently falling back to the Claude CLI) **inside a worktree of that site's own repo**, so proposals name real files instead of being written from the manifest's pitch string. Filed actions are capped hard because code-mode issues are auto-implemented with no human triage: ≤3 channels and ≤2 actions per site, ≤4 sites per run, score ≥7/10. `code` channels (SEO content, AEO, free tools, share cards, guest blog) file **unlabelled** into the manifest's own repo — or a channel's `target_repo` — so the normal pipeline builds them; `manual` channels (Reddit, X, Bluesky, Instagram, TikTok, Shorts, Pinterest, HN, Product Hunt, directories, newsletter) file with **`Claws Ignore`** and carry the final ready-to-post copy, which is the only thing stopping an implementer being dispatched to "post to TikTok". Cadence lives in `promotion_actions`, so a closed action is not re-filed even though title dedup only sees open issues. The worktree is read-only — nothing is committed or pushed. Repos without `docs/promotion/` are a no-op; manifests are created through ordinary issues via `PROMOTION_MANIFEST_CONTEXT` |
| [`shopping-sourcer`](jobs/shopping-sourcer.md) | `docs/shopping/*.yaml` in managed repos | Daily at 7 AM (`shoppingSourcerHour`) | Phase-gated hardware sourcing (#2463) — parses each manifest, selects items with `status: sourcing` in an unlocked phase whose `recheck_days` cadence has elapsed, and runs one tool-restricted Playwright agent per manifest (no Bash/Edit/Write, scratch dir, strict JSON out) to find marketplace listings. Candidates are guarded, URL-validated and stored in SQLite, then rendered into **one consolidated `[shopping] Sourcing & tracking — all projects` issue in `SELF_REPO`** labelled `Claws Ignore` (#2647): a Projects section linking each manifest at `blob/HEAD` with its sourcing/outstanding counts, then Baskets-by-store grouping every candidate by URL hostname ordered by how many projects each store unblocks, so one order moves several projects on. Manifests stay in their own repos; legacy per-manifest issues are auto-closed on migration. Every list in the body is explicitly sorted and a run in which any repo failed leaves the issue untouched, since `upsertAlertIssue` byte-compares the body (#2611) and partial data would silently drop projects. Stores already supplying two or more manifests are named in the sourcing prompt so equivalent listings converge. The issue auto-closes when nothing is sourcing anywhere. Purchases are made manually. Lists are created through ordinary issues — the planner/implementer prompts carry `SHOPPING_MANIFEST_CONTEXT` |
| [`shopping-comment-processor`](jobs/shopping-comment-processor.md) | The consolidated `[shopping]` issue in `SELF_REPO`; manifests in all managed repos | 10 min (`shoppingCommentProcessorMs`) | Primary shopping-list update flow (#2546) — finds the consolidated tracking issue by exact title and reads its unprocessed comments (skipping Claws' own, bot logins, and anything already carrying a self-authored 👀/🚀/😕; **gated on `isAllowedActor`**, since a comment rewrites a file on a default branch), leaves no reaction until the work is done, so a failed run (rate-limited provider, timeout) is retried on the next tick rather than silently dropped, bounded at 6 consecutive failures before it answers 😕 (#2793), loads every `docs/shopping/*.yaml` across all repos, and has one agent turn the batch into a JSON mutation list — embedded images are downloaded through `images.ts` first, and when at least one downloads the run is allowed `Read` so the agent can see them, with any undownloadable images called out in the reply instead of silently dropped (#2674). Every op is **manifest-qualified** with an `<owner>/<repo>:<path>` key quoted from the prompt (#2647); an op naming an unknown key is rejected rather than guessed at. Mutations are grouped per manifest, validated in TypeScript and applied through the `yaml` `Document` API so manifest comments and formatting survive; each serialized result is re-parsed with `parseManifest` and **not committed if it fails**. Each changed manifest commits to its own repo's default branch with the fetched blob `sha` (compare-and-swap, never retried); one repo's commit failure never aborts the others. Then refreshes the consolidated issue, reacts 🚀 and replies with a TypeScript-built per-manifest summary of what applied and what didn't |

### Naming Convention

- **Jobs** (`src/jobs/`): Top-level units registered with the scheduler. Each job runs on a timer or schedule and is referenced by name in the DB, config (`pausedJobs`), and dashboard.
- **Agents** (`src/agents/`): Task-specific modules called by dispatcher jobs. Each handles a specific concern (planning, implementing, CI fixing, etc.) and typically invokes Claude in an isolated worktree.
- Agent display names (`Planner`, `Implementer`, `CI Fixer`, etc.) are short labels for GitHub comment headers and `disabledAgents` config. Filenames are more descriptive (e.g., `issue-refiner.ts`, `ci-fixer.ts`).

## Key Patterns

Full detail (code examples, edge cases, rationale) lives in [patterns.md](patterns.md); this is a compact index.

### Content-Based State Machine

Issues and PRs are discovered by analysing comments, reactions, and PR state — not labels. Fourteen labels (`Refined`, `Ready`, `In Review`, `Priority`, `Duplicate`, `Blocked`, `Claws Ignore`, `Claws Problematic`, `Billing`, `Plan: Deep`, `Use Codex`, `Use Claude`, `Manual Action`, `Automerge`) drive dispatcher transitions for issues (issue-dispatcher) and PRs (pr-dispatcher); a human 👍 gates Claws-authored suggestions while human review comments are auto-processed. Labels outside those fourteen (GitHub defaults, Dependabot ecosystem labels, repo-local ad-hoc labels) are inventoried in [label-audit.md](label-audit.md).

### SQLite-Backed Work Queue

Dispatcher jobs enqueue classified work into the `work_queue` SQLite table; up to `MAX_WORK_WORKERS` fibers claim rows and invoke handlers, with idempotency enforced by a unique partial index. Claude processes get configurable timeout/liveness/memory watchdogs, and `runClaude` retries once on specific transient failure classes.

### Model Selection

`model-selector.ts` provides three tiers (`cheap`/`sonnet`/`opus`) per provider (Claude/Codex/OpenCode), with some workflows pinned to `provider: "claude"` for output-quality/auth reasons and others defaulting to the `claude` provider via `PROVIDER_FALLBACK_ORDER`. The planner defaults to `opus` (or, for `Plan: Deep`-labelled issues, the selected provider's best model at maximum reasoning effort — the Claude CLI's `fable` alias, `CODEX_DEFAULT_MODEL` with `model_reasoning_effort=xhigh`, or `OPENCODE_BEST_MODEL`). The global default provider is the first entry in that fallback order; the `Use Codex`/`Use Claude` labels let a single issue or PR pin its agent runs to that provider via `getProviderSelectionForItem()`, overriding the global fallback order with `strictProvider: true` (see [Content-Based State Machine](#content-based-state-machine) and [configuration.md](configuration.md)).

### Skip-If-Busy Scheduling

Jobs that fire while a prior instance is still running are silently dropped — no queue pile-up; distinct from the separate Claude task queue.

### Smart Scheduling

Seven low-priority background jobs use staleness-based per-repo selection (`smart-schedule.ts`) instead of fixed intervals: due repos (age ≥ `targetStalenessMs`), a busy gate, an SLO escape valve (`sloStalenessMs`) that forces processing of badly-stale repos even when busy, and a concurrency cap. Manual triggers bypass the busy/enabled gate but not staleness selection.

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

Errors flow through `error-reporter.ts` (30-min cooldown per fingerprint, edits an existing `[claws-error]` issue via `ensureAlertIssue()`, filters known-transient error types, and — via `agent-auth-state.ts` — latches an expired agent CLI OAuth session, per provider, so every task failing with the same "Failed to authenticate" message raises one Slack alert and one `[claws-error] agent-auth-expired` issue per episode instead of per task, clearing on the next successful run on that provider or a web re-auth) and then `triage-claws-errors.ts` (dedup by fingerprint then root cause, posts an investigation report, retries once on a truncated response). `USAGE_LIMIT_RE` (`src/claude.ts`) matches the CLI's usage-exhausted message regardless of the qualifier between "your" and "limit" (`weekly`, `5-hour`, none) — a literal match on one wording let weekly-limit errors escalate to Slack/`[claws-error]` per task instead of being downgraded to a warning (#2590); the same regex also short-circuits the provider-fallback loop's rate-limit detection without an Ollama round-trip. When every provider in the fallback order is already inside its rate-limit cooldown, `runClaudeInner` throws `AllProvidersRateLimitedError` (not a bare `Error`) so `error-reporter.ts` recognizes it as expected/transient and downgrades to a warning rather than filing an issue.

### CI-Fixer Circuit Breaker

Merge-conflict resolution is checked before the CI-fix breaker and tracked under its own `maxConflictAttempts` budget (default 3 unproductive attempts per window), so a breaker tripped by CI failures does not block conflict resolution; conflict tasks (`ci-fixer:merge-conflict`) are excluded from the CI-fix attempt count (#2389). For the remaining, non-conflicting PRs: after `maxAttempts`/`maxConsecutiveFailures` CI-fix attempts within a rolling window **and while there is still a failing check to dispatch against**, a PR is marked `Claws Problematic`, further auto-fix attempts stop, and a one-shot deeper-diagnosis pass (`problematic-pr-diagnoser.ts`, up to 3 rounds) runs before a final report comment; recovery clears the label automatically. The breaker deliberately does not trip (or re-apply the label) on a green, mergeable PR — the attempt budget only gates dispatching new work, and re-labelling a PR with nothing left to fix fought the diagnoser's stale-label clearing in an endless add/remove loop (#2390). The diagnoser's clearing rule is the mirror image: it only treats the label as stale when CI is green **and** the PR isn't `CONFLICTING`, so a conflict-triggered trip escalates to a human instead of being cleared on the next pass. A new head commit pushed by a human or another agent (i.e. one Claws did not push itself) grants the PR a fresh, bounded attempt budget — up to `maxCommitGrants` times — rather than leaving it frozen until someone removes the label by hand. A PR labelled `Manual Action` because GitHub refused to re-run a dead CI run is cleared the same way: once `gh pr checks` reports every check passing and the `claws:not-rerunnable-run` note is the only live reason for the label, pr-dispatcher strips the note and removes the label so auto-merger can proceed (#2462). While `isGitHubDegraded()` is true, an incident-shaped failure — one whose jobs never reached a repo-owned step, whose log is missing, or whose log carries a GitHub-side error signature — neither dispatches a fix nor spends an attempt, and a PR already over budget is skipped instead of being labelled `Claws Problematic`, so an outage cannot burn the budget and then trip the breaker with the attempts it burned (#2497). This is deliberately fail-open: `isGitHubDegraded()` returns false the moment the status snapshot goes stale (>15 min) or the poll errors, so a wedged poller resumes normal breaker behaviour on the next sweep rather than pausing the ci-fixer forever, and a real repo-step failure that merely coincides with an incident is still fixed as usual. "Only live reason" spans both label producers: another agent's manual-action section in the PR body (issue-worker), and pr-reviewer's escalations — a refuted blocking finding or a review loop past `MAX_REVIEW_ITERATIONS` — which label the PR but write only a review comment, so they are detected via `hasEscalatedReview` rather than from the body. A GitHub `403 Resource not accessible by integration` (the App installation missing `Actions: write`) is distinguished from a genuine `"cannot be rerun"` refusal (#2514, `isActionsPermissionDenied`) — the former is a global, fixable settings problem, so it files one deduplicated `[claws-config]` alert on `SELF_REPO` instead of marking the run dead or labelling the PR `Manual Action`, leaving it retryable once the permission is granted.

### CI-Fixer Two-Phase Design

The ci-fixer identifies all PR work items first (typed `conflict`/`rerun`/`unrelated`/`fix` variants), then processes them — grouping unrelated failures per repo to avoid duplicate-issue race conditions from concurrent classification.

### No-Commit Feedback

When the implementer produces zero commits, a cheap Claude call diagnoses why (`diagnoseNoCommits`) and the result is posted as a deduplicated `## No changes produced` comment, with the `Refined` label removed to block re-entry.

### Multi-Phase Plan Validation

After each phase's PR merges, `validateAndUpdatePlan()` compares the plan text against the actual diff and updates the plan comment in place on significant deviation; phase-overflow guards prevent processing past `totalPhases`. The current phase is derived by `phase-coverage.ts`'s `loadPhaseCoverage()` from a covered-phase set — not a merged-PR count — so a step completed out-of-band (by a human or an interactive session) is recognized instead of being re-implemented; see [Multi-PR Phase Coverage](#multi-pr-phase-coverage) below.

### Multi-PR Phase Coverage

`phase-coverage.ts` (#2594) computes which steps of a multi-PR plan are already covered by *any* PR that cross-references the issue (any author, any branch) and carries a phase marker — a `(N/M)` PR-title suffix or a `## PR N of M:` body header — unioned with `claws-phase-done: <numbers>` claim comments for steps that produce no PR at all (a manual apply, a workflow dispatch). Phase markers are honoured from any PR author (the PR is inspectable and can't merge unreviewed); claims are honoured only from `gh.isAllowedActor` logins, since a claim asserts work happened somewhere unreviewable. `done` (merged PR or claim) is distinct from `covered` (includes still-open PRs) — anything irreversible, like whether the current PR may carry `Closes #<issue>`, must gate on `done`; `pendingPhases` (covered only by an open PR) blocks starting the next phase, since worktrees branch off the default branch and would be missing an unmerged prerequisite. A legacy `claws/issue-<N>-`-branch merged-PR count is kept as a fallback so behavior is unchanged when no marker or claim is present, and any lookup failure degrades to that fallback rather than throwing. Interactive sessions normally monitor and steer the pipeline rather than executing phases themselves, but they are taught the same conventions via `SESSION_WORKFLOW_PROMPT` and `CLAWS_AUTOMATION_DOC` for the cases where they explicitly take a step by hand, and can query current coverage via the `claws_issue_phases` MCP tool before doing so — see [MCP Server Context](#mcp-server-context). A merged PR whose `(N/M)` marker names *more* phases than the plan currently has is recorded in `markerMismatches` — a re-plan dropped `### PR N:` headers that already-shipped PRs were numbered against. An open issue whose every plan phase is covered gets a one-time `CLAWS_ALL_PHASES_COVERED` notice plus `Ready`, and issue-dispatcher checks coverage before auto-applying `Refined`, so `Automerge`/`[ci-unrelated]` issues can't ping-pong the label against the implementer's all-covered guard (#2821).

### CI & Codebase Infrastructure Monitoring

`runner-monitor` (SSH health/disk checks on self-hosted runners) runs independently, with `host-disk-monitor` covering the same disk-pressure ground for Claws' own host locally (no SSH, no Docker cleanup, plus a container-runtime tripwire); eleven scanners (ubuntu-latest, concurrency, migration, cache-on-self-hosted, issue-comment-spam, runner-os, claude-config, dependabot-config, design-guidelines, dynamic-workflow-runner, host-policy) run sequentially via `scanner-dispatcher`, each filing a deduped alert issue per repo for its class of violation. `ubuntu-latest-scanner` and `dynamic-workflow-runner-scanner` both enforce the self-hosted-only runner policy but from different signals — file-based `runs-on:` scanning vs. run-history runner identity — because dynamic workflows (Dependabot's updater, CodeQL default setup) have no workflow file for the former to read (#2322). `k3s-monitor` separately watches cluster pod/node health and Flux reconciliation, with grace periods, ignored-node suppression, and same-run dedup.

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

Client-side code is authored as TypeScript in `src/client/*.ts`, esbuild-bundled by `scripts/build-client.mjs` into `src/resources/*.generated.ts` string constants that page builders interpolate directly; generated files are checked into the repo so no extra build step is needed in CI/production. `client/auth-watch.ts` is injected on every page by `buildPageHeader` (and, for the header-less full-bleed terminal page, directly by `buildSessionTerminalPage`): when a page is restored from the bfcache, a suspended tab, or a PWA resume with an expired `claws_session` cookie — or when any same-origin `fetch` returns 401 — it probes the public `GET /api/auth/status` and, on `authenticated: false`, recovers with `location.replace("/login?next=…")` so the OIDC round trip returns to the same URL with a fresh cookie (a page with unsaved input or a repeat attempt within 30 s gets a manual sign-in banner instead).

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

Jobs can be disabled per repo via `disabledJobsByRepo` (or the `/jobs` matrix UI). Every job gated by `isJobDisabledForRepo()` must be listed in `pages/jobs-matrix.ts`'s `REPO_JOB_NAMES` (enforced by `jobs-matrix.test.ts`) — a name missing from that list gets no UI checkbox, and `POST /jobs` carries forward any out-of-list config entry instead of silently dropping it on Save (#2625; 15 jobs were found missing and added).

### Job Pause/Resume

Jobs can be paused/resumed from the dashboard or via `pausedJobs` config; paused jobs skip scheduled ticks but remain manually triggerable.

### Disabled Agents

Individual agents within `issue-dispatcher`/`pr-dispatcher` (planner, implementer, ci-fixer, review-addresser, reviewer, merger, empty-pr-closer, superseded-pr-closer) can be disabled via `disabledAgents` config; a disabled agent's phase is silently skipped.

### Push Branch Concurrency

`pushBranch()` uses a fetch-rebase-push retry loop (with a defensive `refs/heads/` refspec prefix against git option injection) to handle concurrent pushes to the same PR branch, falling back to a merge and finally a suppressed `PushConflictError`; the pr-dispatcher also defensively skips both review-addresser and pr-reviewer for PRs with active ci-fixer work in the same cycle (#2667), and the pr-reviewer work handler re-checks at claim time via `db.hasActiveWorkForPR` so a pr-reviewer row queued in an earlier cycle can't run against a head a ci-fixer, problematic-diagnoser, or review-addresser is currently rewriting.

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

Repo discovery (`listRepos()` in `github.ts`) enumerates each owner's App installation repositories, keeping only private, non-archived repos. Repos listed in `forgejoRepos` are dropped from GitHub discovery: their canonical home has migrated to Forgejo and the GitHub copy is a read-only push mirror, so automating it would file issues and open PRs nobody reads (#2650). See [Forgejo repos](#forgejo-repos).

### Forgejo repos

A repo listed in `forgejoRepos` is automated against Forgejo (the Gitea 1.22 REST API at `<forgejoBaseUrl>/api/v1`) instead of GitHub. Its GitHub twin stays in the App installation as a push mirror and is filtered out of discovery forever — every DB key (work queue, tasks, tokens) is the repo full name, so the two copies must never both be live. Credential setup — the mandatory `clawsstjohn` bot account, its `claws-service` token and scopes, how to mint/rotate it, and how to grant Claws access to a newly migrated repo — lives in [configuration.md](configuration.md#forgejo-repos); do not duplicate it here.

- **Discovery.** `fetchRepos()` appends one entry per `forgejoRepos` name from `forgejo.getRepo()`, tagged `forge: "forgejo"` — but only when `forgejoToken` is configured; with no token the loop is skipped entirely (and `config.ts` warns at load) so an unconfigured host does not file a recurring `[claws-error]` alert for a static misconfiguration (#2670). If that fetch fails, the previous cache entry is reused, and otherwise the repo is skipped — never automated against a guessed default branch.
- **Routing.** `src/github.ts` stays the single choke point: each function with a Forgejo equivalent begins `if (isForgejoRepo(repo)) return forgejo.<fn>(...)`, with identical parameters and return shapes. The ~72 modules that import `github.ts` are unchanged. `src/forgejo.ts` never value-imports `github.ts` (that would close the cycle) and never touches the process-global GitHub rate-limit breaker — a GitHub rate limit must not stall Forgejo work. Use `getSelfLoginForRepo(repo)` rather than `getSelfLogin(owner)` wherever a repo full name is in hand: a Forgejo repo has no App installation, so its bot login comes from the Forgejo token's own account.
- **Git auth.** `buildEnvForGhGit` injects a *second* inline credential helper keyed `credential.<forgejoBaseUrl>.helper` (username `oauth2`, password from `forgejoToken`). Git picks a helper by URL, so every existing fetch/rebase/push path works unchanged; `ensureClone` clones from Forgejo and repoints a stale `origin`.
- **Agents.** `forgeContext(repo)` in `agents/agent-context.ts` tells the planner, implementer, ci-fixer, reviewer and review-addresser that the GitHub mirror is stale, that `gh` must not be used for this repo, and that CI lives in `.forgejo/workflows/`. Claws still owns the push and the PR, exactly as on GitHub.
- **Degraded surfaces.** Forgejo has no equivalent for GitHub Actions log/annotation APIs, so `getFailedRunLog`/`getRunAnnotations`/`getRunJobSummaries` return empty and `rerunWorkflow`/`rerunFailedJobs` are no-ops (a pushed fix commit re-triggers CI anyway); `runCIFix` branches on the forge so a log-less Forgejo failure builds the fix prompt from the failing check name and its `target_url` rather than entering GitHub's log-expiry recovery, which would spend the circuit-breaker budget without ever attempting a fix. Issue transfer is impossible in either direction, so a Forgejo repo is neither a transfer source nor a target. `getIssueBodyHtml` returns `""` and `images.ts` allowlists GitHub hosts only, so images attached to Forgejo issue bodies are not extracted. `hasValidLGTM` accepts an approving review at the head SHA or the usual LGTM comment, but cannot check resolved review threads. Gitea's issue timeline carries no `cross-referenced` event, so `listPRsCrossReferencingIssue` returns `[]` and phase coverage degrades to `claws/issue-<N>-` branch accounting; `listPRStatuses` has no bulk equivalent and is assembled per PR from the routed Forgejo calls. Every one of these must be *routed*, not left on the `gh` path: the GitHub mirror keeps the same full name and issue/PR numbering, so an unrouted call silently answers from stale mirror data instead of failing loudly. GitHub-only jobs (Actions storage, runner metrics, both Dependabot monitors, the dynamic-workflow and main-build scanners) skip `forge: "forgejo"` repos outright, and the functions they call are backstopped by `assertGitHubOnly(repo, feature)` in `github.ts` — a missed call-site filter throws instead of quietly reading the mirror. `cancelWorkflow` throws for the same reason: Forgejo Actions has no run-cancel API, and a silent no-op would tell the dashboard's Cancel button a still-running job had stopped.

  Two comparison helpers need the repo threaded in, because Claws' Forgejo identity is not its GitHub App bot: `isAllowedActor(login, repo)` (without `repo` it compares against the App bot and reads Claws' own Forgejo comments as untrusted) and `getSelfLoginForRepo(repo)`. Web links must come from `webUrlForRepo`/`issueUrl`/`prUrl` in `config.ts` — note Forgejo's PR path is `/pulls/<n>`, not GitHub's `/pull/<n>` — never a hand-built `https://github.com/...` string.

### Security Model

Because Claude runs with `--dangerously-skip-permissions`, all user-supplied input must be guarded upstream: query-param escaping on dashboard pages, a configured-repo allowlist (`isConfiguredRepo()`) on dashboard routes that mutate GitHub state via a client-supplied `repo` string (#2221), fork-PR filtering across all PR-processing jobs, `isAllowedActor()` gating (with a `[disallowed-actor]` tracking issue) applied at issue-dispatcher, issue-refiner, and triage layers, and a detected prompt injection is both redacted before reaching the model and posted back as a visible comment on the originating issue/PR, not just logged/Slacked (#1275) (#2526: for duplicate-candidate bodies the originating issue is the *candidate*, not the issue being refined). Not every input-trust gap is closed this way: `dmarc-monitor`'s ingestion of DMARC aggregate reports off a public `rua=` mailbox remains unauthenticated by accepted decision (#2763), but is bounded by decompression-bomb caps, ingest/alert rate limits and a sender denylist (#2838) — see [Known risk: unauthenticated ingestion (accepted)](jobs/dmarc-monitor.md#known-risk-unauthenticated-ingestion-accepted).

### PR Review Comment Protocol

Every terminal pr-reviewer code path posts a comment with the `## PR Review` header and a `Reviewed commit:` marker, which `hasNewCommitsSinceLastReview()` uses to avoid infinite re-review loops; large diffs fall back to a per-file two-phase review strategy, and context is dynamically budgeted against the model's input-token limit.

### MCP Server Context

Plain interactive Claude sessions access Claws operational state via a Claws-owned strict MCP config (`--mcp-config --strict-mcp-config`) that exposes the built-in MCP server (`claws_status`, `claws_task_history`, `claws_open_prs`, `claws_config`, `claws_issue_phases` — lists a multi-PR issue's plan steps and which are already covered, per [Multi-PR Phase Coverage](#multi-pr-phase-coverage)). Claude sessions granted the `browser` capability remain Playwright-only and deliberately do **not** also expose `claws-state`. Other Claws call sites can opt into `ha_list_entities`/`ha_api_request` for the Home Assistant config repo, but interactive sessions do not currently expose those HA tools. Codex interactive sessions do not get Claws MCP tools; instead Claws isolates them from ambient `~/.codex` plugins/MCP servers with a per-session `CODEX_HOME`, which suppresses host-level plugin startup noise such as the GitHub MCP warning from issue #2684.

## Configuration

Full config key / env var / default reference lives in [configuration.md](configuration.md); this is a compact table of the most commonly-used keys. Configuration is resolved per-field: env vars > `~/.claws/config.json` > defaults.

| Config key | Env variable | Default |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` |
| `forgejoRepos` | `CLAWS_FORGEJO_REPOS` | `["St-John-Software/perudo"]` (repos whose canonical home is Forgejo; excluded from GitHub discovery) |
| `forgejoBaseUrl` | `CLAWS_FORGEJO_BASE_URL` | `https://git.home.bstjohn.net` |
| `forgejoToken` | `CLAWS_FORGEJO_TOKEN` | *(empty — Forgejo API access token; never rendered on the config page — with it empty, `forgejoRepos` are skipped entirely at discovery and never automated)* |
| `port` | `PORT` | `3000` |
| `dashboardUrl` | `CLAWS_DASHBOARD_URL` | *(derived from `oidcRedirectUri`'s origin — base URL for dashboard links in Slack alerts)* |
| `smartScheduling.enabled` | — | `true` (kill-switch for smart-scheduled jobs) |
| `runners` | — | Self-hosted GitHub Actions runner hosts monitored by `runner-monitor` |
| `macRunners` | — | Self-hosted macOS runner hosts woken by `mac-runner-waker` |
| `allowedActors` | — | `["stjohnb"]` (issue authors dispatched into refine/implement; see [Content-Based State Machine](#content-based-state-machine)) |
| `disabledJobsByRepo` | — | `{}` (per-repo job disable list) |
| `disabledAgents` | — | `[]` (agent names to disable within issue/PR dispatchers) |
| `pausedJobs` | — | `[]` (job names paused on startup) |
| `skippedItems` / `prioritizedItems` | — | `[]` / `[]` (per-item `{repo, number}` skip/priority overrides) |
| `githubAppId` / `githubAppPrivateKeyPath` | `CLAWS_GITHUB_APP_ID` / `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | `0` (disabled) / *(empty)* |
| `homeAssistantBaseUrl` / `homeAssistantToken` | `CLAWS_HOME_ASSISTANT_BASE_URL` / `CLAWS_HOME_ASSISTANT_TOKEN` | *(empty — HA integration disabled)* |
| `k3sMonitorEnabled` | — | `true` |
| `openrouterApiKey` | `CLAWS_OPENROUTER_API_KEY` | *(empty — required for the OpenCode backend)* |
| `improvementIdentifierModel` | `CLAWS_IMPROVEMENT_IDENTIFIER_MODEL` | `openrouter/z-ai/glm-5.3` (OpenRouter model ID for improvement-identifier's repo analysis via OpenCode) |

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

External tools `gh`, `claude`, `codex`, and `opencode` must be authenticated
separately — Claws does not manage their credentials.

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
manifests encode that invariant rather than relaxing it. See
[k8s-cutover.md](k8s-cutover.md) for the full cutover runbook (current
fleet-infra state, paste-ready manifest diffs, the Secret schema, data
migration, activation and traffic cutover, and known limitations); this
section covers the shape of the deployment itself.

**Shape.** A `StatefulSet` with `replicas: 1` and `podManagementPolicy:
OrderedReady`, a 50 Gi `ReadWriteOnce` PVC at `/home/claws/.claws` (SQLite
WAL needs real local storage — repos and worktrees also live here, so 1 Gi is
not enough), `terminationGracePeriodSeconds: 420`, and liveness/readiness
probes on `GET /health`. The container runs as the non-root `claws` user
(uid 1000); `fsGroup: 1000` fixes PVC ownership on first mount.

**Only `~/.claws` persists.** It is the sole volume. Everything else under
`$HOME` — `~/.claude`, `~/.codex`, `~/.ssh`, `~/.kube` — is ephemeral and
rebuilt from scratch on every boot by `deploy/container-entrypoint.sh`,
driven entirely by Secret-sourced env vars (`CLAWS_SSH_PRIVATE_KEY`,
`CLAWS_KUBECONFIG`, `CLAWS_CODEX_AUTH_JSON`, `CLAWS_CLAUDE_SETTINGS_JSON`)
plus the bundled skills — deliberately no PVC and no symlink for either
provider home, so there is no hidden state to reason about beyond the
Secret. The entrypoint unsets all four once written, and they are in
`SENSITIVE_ENV_KEYS`, so no agent child or interactive session inherits
them. `CLAWS_CODEX_AUTH_JSON` is still re-materialised every boot, but the
`claws-auth` Secret it comes from is now kept current by
[`auth-secret-sync`](jobs/auth-secret-sync.md), which writes Codex's rotated
`~/.codex/auth.json` back into the Secret via the pod's own ServiceAccount
(#2794). One consequence: `~/.claude` starts empty on every boot and Claude
agent memories are **never restored** into it. `src/main.ts`'s `shutdown()`
flushes memories to the `claude-memories` branch of this repo before the pod
exits (one `claudeMemoryBackup.run()` call, gated on `isActive()` and capped
at 60 s — see [claude-memory-backup.md](jobs/claude-memory-backup.md#shutdown-flush)),
on top of the job's own hourly push, so at most an in-progress hour of
memory writes is at risk on an unplanned kill. `terminationGracePeriodSeconds`
is 420, not 360, to cover 300 s scheduler drain + 5 s task cancel + 60 s
memory flush plus headroom — the two numbers move together. The durable
path for memories is the `claude-memories` branch → `doc-maintainer`, which
folds every host's memories into each repo's `docs/` (#2757); the pod itself
never reads that branch back.

Also because a container has no systemd `EnvironmentFile=`, `config.ts`
loads `~/.claws/env` itself at import time (`loadEnvFile()`,
`src/env-file.ts`) before `loadConfig()` runs, so a `CLAUDE_CODE_OAUTH_TOKEN`
refreshed via `/reauth` and persisted to the PVC by `persistToken()`
survives a pod restart and wins over the Secret's copy on the next boot.

`isContainer()` (`src/runtime-env.ts`) detects the container runtime —
`CLAWS_RUNTIME=container` (set unconditionally in the `Dockerfile`), or
`KUBERNETES_SERVICE_HOST`, or `/.dockerenv` as a fallback. `host-disk-monitor`
uses it to skip cleanup tiers that only make sense on the bare systemd host:
`sudo -n journalctl`/`sudo -n apt-get clean` (tier 1), `nix-collect-garbage`
(tier 2), the `sudo -n du` root-directory breakdown, and the container-runtime
tripwire itself (a pod reporting a container runtime present is not news) —
all of those fail noisily as uid 1000 under `capabilities.drop: [ALL]`
otherwise. npm/npx cache clearing, `/tmp` sweeping and worktree reaping are
unguarded since a PVC can still fill up.

**Why tmux, not a container per session.** Interactive sessions
(`src/sessions.ts`) stay tmux-backed inside the pod rather than getting their
own container per session. Container-per-session would need a k8s API
client, a service account with pod-create rights (the manifests deliberately
set `automountServiceAccountToken: false`), per-session storage carved out of
the shared worktree tree, and a rewrite of the attach/recover path — a much
larger change than this deployment mode needs. The one behavioural loss
versus systemd is that `KillMode=process` preserved tmux sessions across a
service restart, whereas a pod restart kills them along with the container;
`recoverSessions()` already treats that as an ordinary cold start, so nothing
new needs handling.

**Verify-only rollout.** A fresh pod boots with `activationState:
"verify-only"`. In this mode:

- The job scheduler is started with an empty job set.
- The WhatsApp gateway does not pair (so it doesn't claim the single device
  slot belonging to the systemd instance).
- GitHub App config is not required at startup.
- `runConnectivityVerification()` fires once and records a report into
  `verification_reports`.

A `/verify` page renders the latest report — database, GitHub App, every
CLI (`gh`, `claude`, `codex`, `opencode`, `tmux`, `kubectl`), OpenRouter,
Slack webhook (DNS only — no POST), IMAP login/logout, per-runner SSH,
Ollama, WhatsApp auth. `kubectl` runs `--client`-only, so it never contacts
an API server and a down cluster cannot redden this row — cluster
reachability is `k3s-monitor`'s job, not `/verify`'s. In `verify-only`, an
unpaired or unregistered WhatsApp session is reported as informational
rather than failed because the pod intentionally does not claim the active
instance's device slot; once the instance is `active`, the same missing
registration is a real failure. Each check is wrapped in a 30 s timeout.
A red verify-only banner appears on every page of the dashboard.

Flipping to `active` is explicit: either click **Activate** on the Config
page (writes `activationState: "active"` and prompts for a pod restart) or
set `CLAWS_ACTIVATION_STATE=active` in the secret and restart. The loader
also auto-selects `active` if `claws.db` already exists on the data volume
at startup — so copying a populated PV from the systemd host does not
accidentally re-enter verify-only.

**Image.** `ghcr.io/st-john-software/claws:<tag>` plus `:latest`, built and
pushed by the `docker` job in `.github/workflows/release.yml` on every
release tag. Once the push succeeds, the same job dispatches fleet-infra's
`update-claws-staging.yml` (`gh workflow run`, `FLEET_INFRA_VERSION_BUMP`
secret) with the new tag, which opens a bump PR on
`automation/bump-claws-staging` that the auto-merger merges once fleet-infra
CI passes — see fleet-infra#1034 for the receiving side. A run where both
image-push attempts fail skips the dispatch.

**Concurrency guard.** `src/main.ts` writes `claws.pid` into the data dir at
startup and refuses to start if a live sibling holds the lock (checked via
`process.kill(pid, 0)`). This is belt-and-braces on top of the StatefulSet's
single-replica guarantee: if a rolling update ever double-schedules the
pod, the newcomer crash-loops instead of corrupting the WAL. It does not
help across hosts, which is why the systemd-to-k8s cutover runbook requires
`claws.service` and `claws-updater.timer` to both stay stopped on the old
host during the rollback window.

See [k8s-cutover.md](k8s-cutover.md) for the operator playbook (secrets,
cutover from systemd, troubleshooting).

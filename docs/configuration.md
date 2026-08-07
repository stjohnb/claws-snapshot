# Configuration

Full config key / env var / default reference for the claws codebase — see [OVERVIEW.md](OVERVIEW.md) for the high-level architecture and a compact table of the most commonly-used keys.

Configuration is resolved per-field: env vars > `~/.claws/config.json` >
defaults.

| Config key | Env variable | Default |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* |
| `slackBotToken` | `CLAWS_SLACK_BOT_TOKEN` | *(empty — needed for idea threads)* |
| `slackIdeasChannel` | `CLAWS_SLACK_IDEAS_CHANNEL` | *(empty — needed for idea threads)* |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` |
| `port` | `PORT` | `3000` |
| `intervals.issueDispatcherMs` | — | `300000` (5 min) |
| `intervals.prDispatcherMs` | — | `300000` (5 min) |
| `intervals.triageClawsErrorsMs` | — | `600000` (10 min) |
| `intervals.ideaCollectorMs` | — | `1800000` (30 min) |
| `intervals.runnerMonitorMs` | — | `600000` (10 min) |
| `intervals.qaPhaseMs` | — | `600000` (10 min) |
| `intervals.emailMonitorMs` | — | `300000` (5 min) |
| `intervals.k3sMonitorMs` | — | `900000` (15 min) |
| `intervals.runnerMetricsSyncMs` | — | `120000` (2 min) |
| `intervals.publicSnapshotSyncMs` | — | `604800000` (7 days) |
| `schedules.repoStandardsHour` | — | `2` (2 AM local time) |
| `schedules.publicRepoScannerHour` | — | `4` (4 AM local time) |
| `schedules.actionsStorageMonitorHour` | — | `5` (5 AM local time) |
| `schedules.reminderMonitorHour` | — | `8` (8 AM local time) |
| `intervals.dampReminderMs` | — | `900000` (15 min; `damp-reminder` still only creates the issue on Mondays ≥ 9 AM local) |
| `smartScheduling.enabled` | — | `true` |
| `smartScheduling.quietHourStart` | — | `19` (accepted but unused — off-hours gating was removed) |
| `smartScheduling.quietHourEnd` | — | `7` (accepted but unused — off-hours gating was removed) |
| `smartScheduling.tickIntervalMs` | — | `3600000` (1 hour) |
| `smartScheduling.jobs` | — | `{ "idea-suggester": {}, "improvement-identifier": {}, "doc-maintainer": {}, "issue-auditor": {}, "scanner-dispatcher": {}, "stale-branch-cleaner": {}, "idea-reconciler": {}, "dependabot-alert-monitor": {}, "dependabot-run-monitor": {} }` — set of jobs that use smart scheduling |
| `smartScheduling.targetStalenessMs` | — | `86400000` (24h — repos not processed within this window are "due") |
| `smartScheduling.sloStalenessMs` | — | `172800000` (48h — repos past this threshold force processing even when Claws is busy) |
| `smartScheduling.maxConcurrentJobTasks` | — | `4` (max concurrent repo processing slots via `withSmartJobSlot`) |
| `smartScheduling.ignoreBusyKinds` | — | `["ci-fixer", "ci-fixer:conflict", "ci-fixer:rerun", "ci-fixer:problematic", "review-addresser", "pr-reviewer", "auto-merger:sweep", "doc-maintainer", "improvement-identifier", "idea-suggester", "issue-auditor"]` — agent kinds excluded from the busy check |
| `runners` | — | Two default self-hosted runner hosts (see config). Each entry is either an svc runner (`actionsDir`) or a NixOS systemd runner (`serviceUnit` + `workDir` + `toolDir`) — see `docs/jobs/runner-monitor.md` |
| `macRunners` | — | Two default `MacRunner` entries (`{name, host, user?, port?, identityFile?, labels, enabled?}`): `Brendans-MacBook-Pro` (`brendans-macbook-pro.local`, labels `macos`+`tempo`) and `Brendans-MacBook-Pro-3` (`brendans-macbook-pro-3.local`, `user: "brendanstjohn"`, labels `macos`+`xcode26`) — woken by `mac-runner-waker`; kept separate from `runners`/`RUNNER_HOSTS` since `runner-monitor` cannot manage macOS hosts. `enabled` (optional, default `true`) is togglable per-Mac from the config UI (#1984) — set `false` to stop `mac-runner-waker` from SSHing to or alerting on a Mac that's been taken off the LAN |
| `macRunnerRepos` | — | `["St-John-Software/bonkus", "St-John-Software/namey", "St-John-Software/TempoStatusBar"]` (repos `mac-runner-waker` polls for queued macOS jobs) |
| `intervals.macRunnerWakerMs` | — | `60000` (1 min) |
| `publicSnapshots` | — | Four `{ source, target, mirrorReleases?, scrubPaths?, releaseAssetUrl? }` pairs (#1826): `St-John-Software/claws` → `stjohnb/claws-snapshot` (`scrubPaths: [".github/workflows/history-cleanup.yml"]`, #2009 — added after that workflow leaked a personal email into the public mirror), `St-John-Software/3d-models` → `stjohnb/3d-models`, `St-John-Software/TempoStatusBar` → `stjohnb/TempoStatusBar` (`mirrorReleases: true` — the only pair with release mirroring enabled, #1851 — and `releaseAssetUrl: "https://tempo-statusbar-releases.s3.us-east-1.amazonaws.com/releases/TempoStatusBarApp-{version}.dmg"`, an HTTPS fallback the DMG mirror fetches when the source release has no `.dmg` asset; `{version}` is the tag with a leading `v` stripped, #2115), `St-John-Software/fleet-infra` → `stjohnb/homelab` (`scrubPaths: ["apps/authentik/configmap-blueprints.yaml"]`, #1962). Any pair with a non-empty `scrubPaths` republishes as a squashed, force-pushed single-commit history every sync (there is no way to remove a path from ancestor commits without discarding history) and is mutually exclusive with `mirrorReleases` (enforced by a zod refinement in `config.ts`) |
| `logRetentionDays` | — | `14` |
| `logRetentionPerJob` | — | `20` |
| `emailEnabled` | `CLAWS_EMAIL_ENABLED` | `true` |
| `emailUser` | `CLAWS_EMAIL_USER` | `""` (empty — must be set in env or config) |
| `emailAppPassword` | `BRENDAN_SERVER_GMAIL_APP_PASSWORD` | *(empty)* |
| `emailRecipient` | `CLAWS_EMAIL_RECIPIENT` | `""` (empty — must be set in env or config) |
| `emailAllowedSenders` | `CLAWS_EMAIL_ALLOWED_SENDERS` | `[]` (comma-separated in env, lower-cased; empty = allow all senders. When non-empty, `email-monitor` skips messages whose `From` address isn't in the list — #2068) |
| `whatsappEnabled` | `WHATSAPP_ENABLED` | `false` |
| `whatsappAllowedNumbers` | `WHATSAPP_ALLOWED_NUMBERS` | `[]` |
| `openaiApiKey` | `OPENAI_API_KEY` | *(empty)* |
| `maxWorkWorkers` | `CLAWS_MAX_WORK_WORKERS` | `2` (`maxClaudeWorkers` / `CLAWS_MAX_CLAUDE_WORKERS` are deprecated aliases) |
| `claudeTimeoutMs` | `CLAWS_CLAUDE_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `claudeLivenessTimeoutMs` | `CLAWS_CLAUDE_LIVENESS_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `claudeWorkerMemoryMaxBytes` | `CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES` | `2147483648` (2 GiB; 0 disables) |
| `worktreeStaleMs` | — | `604800000` (7 days — worktrees older than this are pruned by worktree-cleaner) |
| `reviewModelTier` | `CLAWS_REVIEW_MODEL_TIER` | `"sonnet"` (global default model tier for PR reviews; `"opus"` raises all reviews to the opus tier) |
| `openrouterApiKey` | `CLAWS_OPENROUTER_API_KEY` | *(empty — required for the OpenCode backend)* |
| `toolUseProviderFallbackOrder` | `CLAWS_TOOL_USE_PROVIDER_FALLBACK_ORDER` | `["claude"]` (provider order for tool-use `runClaude` calls that aren't pinned) |
| `textOnlyProviderFallbackOrder` | `CLAWS_TEXT_ONLY_PROVIDER_FALLBACK_ORDER` | `["claude"]` (provider order for text-only `runClaude` calls that aren't pinned, e.g. idea-suggester, qa-phase — see [Model Selection](patterns.md#model-selection)) |
| `providerRateLimitCooldownMs` | `CLAWS_PROVIDER_RATE_LIMIT_COOLDOWN_MS` | `300000` (5 min — fixed cooldown a provider is skipped for after a classified rate-limit error, applied by the fallback loop in `claude.ts`; not the actual reset time parsed from the error text) |
| `codexDefaultModel` | `CLAWS_CODEX_DEFAULT_MODEL` | `"o3"` (Codex tool-use tier default) |
| `codexLightModel` | `CLAWS_CODEX_LIGHT_MODEL` | `"o4-mini"` |
| `codexCheapModel` | `CLAWS_CODEX_CHEAP_MODEL` | `"o4-mini"` |
| `claudeCheapModel` | `CLAWS_CLAUDE_CHEAP_MODEL` | `"claude-haiku-4-5-20251001"` |
| `opencodeBestModel` / `opencodeAdequateModel` / `opencodeCheapModel` | `CLAWS_OPENCODE_BEST_MODEL` / `CLAWS_OPENCODE_ADEQUATE_MODEL` / `CLAWS_OPENCODE_CHEAP_MODEL` | `"openrouter/anthropic/claude-opus-4"` / `"openrouter/anthropic/claude-sonnet-4.5"` / `"openrouter/google/gemini-2.5-flash"` — opencode routes through OpenRouter, so model IDs must carry the `openrouter/` prefix and match opencode's own model registry (dots not hyphens, e.g. `claude-sonnet-4.5`), not the raw Anthropic/OpenRouter catalog names (#905, #907) |
| `opencodeTextBestModel` / `opencodeTextAdequateModel` / `opencodeTextCheapModel` | `CLAWS_OPENCODE_TEXT_BEST_MODEL` / `..._TEXT_ADEQUATE_MODEL` / `..._TEXT_CHEAP_MODEL` | `"openrouter/google/gemini-2.5-flash"` / same / `"openrouter/google/gemini-2.5-flash-lite"` — separate tier from the tool-use opencode models above because opencode's `run` command always sends tool schemas, so the underlying OpenRouter model must support function calling; not every model does |
| `ollamaBaseUrl` | `CLAWS_OLLAMA_BASE_URL` | Local Ollama instance used by `ollama-rate-limit-classifier.ts` to classify Claude/Codex/OpenCode usage-limit errors, with a regex fallback when Ollama is unreachable |
| `ollamaTimeoutMs` | `CLAWS_OLLAMA_TIMEOUT_MS` | `60000` (1 min — generous to tolerate a cold-started local Ollama) |
| `ollamaConsecutiveFailuresBeforeDisable` | `CLAWS_OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE` | `3` (consecutive Ollama failures before a 5-minute circuit breaker falls back to regex-only classification) |
| `whisperBaseUrl` / `whisperLocalUrl` | `CLAWS_WHISPER_BASE_URL` / `CLAWS_WHISPER_LOCAL_URL` | Self-hosted faster-whisper transcription server endpoints — see [Voice-note transcription](whatsapp-setup.md#step-2--voice-note-transcription-on-by-default) |
| `whisperModel` | `CLAWS_WHISPER_MODEL` | `"Systran/faster-whisper-base"` |
| `bindHost` | `CLAWS_BIND_HOST` | `"0.0.0.0"` |
| `activationState` | `CLAWS_ACTIVATION_STATE` | `"active"` (or `"verify-only"` for the Kubernetes verify-only rollout mode — see [Kubernetes Deployment](OVERVIEW.md#kubernetes-deployment) in OVERVIEW.md) |
| `datasetteExport` | — | *(empty — disables the job)* `{ host, user?, port?, identityFile?, remotePath }` — remote SSH target `datasette-export` scp's a copy of `claws.db` to for Datasette-based data exploration |
| `intervals.datasetteExportMs` | — | `21600000` (6 hours) |
| `oidcClientId` | `CLAWS_OIDC_CLIENT_ID` | *(empty)* |
| `oidcClientSecret` | `CLAWS_OIDC_CLIENT_SECRET` | *(empty)* |
| `oidcBaseUrl` | `CLAWS_OIDC_BASE_URL` | *(empty — e.g. `https://auth.example.com`)* |
| `oidcApplicationSlug` | `CLAWS_OIDC_APPLICATION_SLUG` | *(empty — authentik application slug)* |
| `oidcRedirectUri` | `CLAWS_OIDC_REDIRECT_URI` | *(empty — defaults to `http://localhost:<port>/auth/callback`)* |
| `githubAppId` | `CLAWS_GITHUB_APP_ID` | `0` (disabled) |
| `githubAppPrivateKeyPath` | `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | *(empty)* |
| `githubAppInstallationIds` | — | `{}` (owner → installation ID overrides) |
| `githubOwnerAppCredentials` | — | `{}` (per-owner App credentials — `Record<string, {appId, privateKeyPath, installationId?}>` — overrides global credentials per owner; also listed in `SENSITIVE_KEYS`) |
| `nameyDbUrl` | `NAMEY_DB_URL` | *(empty — namey DB access disabled)* |
| `pausedJobs` | — | `[]` (job names to pause on startup) |
| `disabledJobsByRepo` | — | `{}` (map of repo full name → array of job names to disable for that repo) |
| `enabledJobsByRepo` | — | `{}` (map of repo full name → array of opt-in job names to enable for that repo; currently `main-build-monitor-scanner` is the only opt-in job, disabled by default for all repos) |
| `disabledAgents` | — | `[]` (agent names to disable: `planner`, `implementer`, `ci-fixer`, `review-addresser`, `reviewer`, `merger`, `empty-pr-closer`) |
| `skippedItems` | — | `[]` (array of `{repo, number}` excluded from processing) |
| `prioritizedItems` | — | `[]` (array of `{repo, number}` processed first) |
| `itemTimeoutOverrides` | — | `[]` (array of `{repo, number, timeoutMs}` — auto-managed by timeout escalation) |
| `homeAssistantBaseUrl` | `CLAWS_HOME_ASSISTANT_BASE_URL` | *(empty — HA REST API integration disabled)* |
| `homeAssistantToken` | `CLAWS_HOME_ASSISTANT_TOKEN` | *(empty — required when homeAssistantBaseUrl is set)* |
| `homeAssistantConfigRepo` | — | *(empty — e.g. `St-John-Software/home-assistant-config`)* |
| `homeAssistantUpgraderEnabled` | `CLAWS_HOME_ASSISTANT_UPGRADER_ENABLED` | Defaults to whether HA is configured (`homeAssistantBaseUrl` + `homeAssistantToken` both set); set `false` to disable the `ha-upgrader` job without unconfiguring HA |
| `homeAssistantUpgraderExcludePatterns` | `CLAWS_HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS` | `[]` (comma-separated in env; entity IDs/patterns `ha-upgrader` should never install updates for) |
| `homeAssistantDeployWatcherEnabled` | `CLAWS_HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-deploy-watcher` job |
| `homeAssistantGitPullAddonSlug` | `CLAWS_HOME_ASSISTANT_GIT_PULL_ADDON_SLUG` | `"core_git_pull"` (HA Supervisor addon slug `ha-deploy-watcher` polls for `Updating <old>..<new>` log lines) |
| `allowedActors` | — | `["stjohnb"]` (issue authors whose issues are dispatched into the refine/implement pipeline; see [Content-Based State Machine](#content-based-state-machine)) |
| `dependabotIgnoredAdvisories` | — | `{}` (map of repo full name, or `"*"` for all repos, → array of `GHSA-...` IDs to suppress before filing the `dependabot-alert-monitor` alert issue) |
| `notifyDashboardActions` | — | `true` (send Slack notifications for all dashboard mutations) |
| `dependabotAutoDismissStale` | — | `true` (auto-dismiss Dependabot alerts whose patched version is already present in the dependency-graph SBOM; set to `false` to disable) |
| `k3sMonitorEnabled` | — | `true` (set to `false` to disable the k3s-monitor job) |
| `k3sIgnoredNodes` | — | `["k3s-nas", "ryzen"]` (nodes to suppress alerts for — applies to both node and pod alerts) |
| `fleetInfraRepo` | `CLAWS_FLEET_INFRA_REPO` | `St-John-Software/fleet-infra` (repo where k3s-monitor files alert issues) |
| `prodK8sMonitorEnabled` | `CLAWS_PROD_K8S_MONITOR_ENABLED` | `false` (enable prod cluster monitoring) |
| `prodK8sKubeconfigPath` | `CLAWS_PROD_K8S_KUBECONFIG_PATH` | *(empty — uses default kubeconfig when empty)* |
| `fleetKubeconfigPath` | `CLAWS_FLEET_KUBECONFIG_PATH` | `"~/.kube/config"` (kubeconfig path for fleet/k3s cluster; `~` is expanded to an absolute path via `resolveIdentityFile` at session-create time; granted to sessions with the `fleet-infra` capability; set to `""` to hide the capability from the sessions UI) |
| `prodK8sKubeconfigRefresh` | — | *(empty — when set, enables automatic kubeconfig refresh for the prod cluster; object with fields: `tailscaleHostname`, `host`, `user`, `port`, `identityFile`, `remotePath`, `serverPort`, `serverOverride`)* |
| `prodK8sIgnoredNodes` | — | `[]` (nodes to suppress alerts for in the prod cluster) |
| `prodK8sRepo` | `CLAWS_PROD_K8S_REPO` | `St-John-Software/production-infra` (repo where prod-k8s-monitor files alert issues) |
| `intervals.prodK8sMonitorMs` | — | `900000` (15 min) |
| `ciFixerCircuitBreaker.maxAttempts` | — | `5` (max CI fix attempts per PR within window) |
| `ciFixerCircuitBreaker.windowMs` | — | `86400000` (24h window for attempt counting) |
| `ciFixerCircuitBreaker.maxConsecutiveFailures` | — | `3` (consecutive failures before tripping) |
| `homeAssistantBinDayMonitorEnabled` | `CLAWS_HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED` | `false` (enable bin-day sensor monitoring) |
| `homeAssistantBinDaySensorPrefix` | `CLAWS_HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX` | `"sensor.bin_scraper_"` (HA entity ID prefix to monitor) |
| `intervals.binDayMonitorMs` | — | `900000` (15 min) |
| `homeAssistantBatteryMonitorEnabled` | `CLAWS_HOME_ASSISTANT_BATTERY_MONITOR_ENABLED` | `false` (enable battery-level sensor monitoring) |
| `homeAssistantBatteryThresholdPercent` | `CLAWS_HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT` | `10` (alert threshold — devices at or below this percent are reported; `<=` comparison so exactly-10% devices are included) |
| `intervals.batteryMonitorMs` | — | `3600000` (1 hour) |

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

When `nameyDbUrl` is configured, the MCP server exposes a `namey_query` tool
that runs read-only SQL queries against the namey production PostgreSQL
database. This lets Claude sessions query user stats, name popularity trends,
and other production data during planning and implementation. Queries are
enforced read-only via `BEGIN TRANSACTION READ ONLY`, capped at
500 rows, and subject to a 30-second timeout.

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


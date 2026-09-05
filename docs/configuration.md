# Configuration

**Reference.** Exhaustive config key / env var / default table. For the dozen
keys you actually touch, OVERVIEW's Configuration section is enough.

Configuration is resolved per-field: env vars > `~/.claws/config.json` >
defaults.

| Config key | Env variable | Default |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* |
| `slackProdAlertsWebhook` | `CLAWS_SLACK_PROD_ALERTS_WEBHOOK` | *(empty — falls back to `slackWebhook`; used by `notifyProdAlert` for prod-down pages; never rendered on the config page)* |
| `slackBotToken` | `CLAWS_SLACK_BOT_TOKEN` | *(empty — needed for idea threads)* |
| `slackIdeasChannel` | `CLAWS_SLACK_IDEAS_CHANNEL` | *(empty — needed for idea threads)* |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` |
| `forgejoRepos` | `CLAWS_FORGEJO_REPOS` | `["St-John-Software/perudo"]` (repos whose canonical home is Forgejo; excluded from GitHub discovery) |
| `forgejoBaseUrl` | `CLAWS_FORGEJO_BASE_URL` | `https://git.home.bstjohn.net` |
| `forgejoToken` | `CLAWS_FORGEJO_TOKEN` | *(empty — Forgejo API access token; never rendered on the config page)* |
| `port` | `PORT` | `3000` |
| `intervals.issueDispatcherMs` | — | `300000` (5 min) |
| `intervals.prDispatcherMs` | — | `300000` (5 min) |
| `intervals.triageClawsErrorsMs` | — | `600000` (10 min) |
| `intervals.shoppingCommentProcessorMs` | — | `600000` (10 min) |
| `intervals.runnerMonitorMs` | — | `600000` (10 min) |
| `intervals.hostDiskMonitorMs` | — | `600000` (10 min) |
| `intervals.emailMonitorMs` | — | `300000` (5 min) |
| `intervals.k3sMonitorMs` | — | `900000` (15 min) |
| `intervals.githubStatusMs` | — | `120000` (2 min) |
| `intervals.runnerMetricsSyncMs` | — | `120000` (2 min) |
| `intervals.mainBuildMonitorMs` | — | `300000` (5 min) |
| `intervals.publicSnapshotSyncMs` | — | `604800000` (7 days) |
| `intervals.claudeMemoryBackupMs` | — | `3600000` (1 hour) |
| `intervals.authSecretSyncMs` | — | `600000` (10 min) |
| `schedules.repoStandardsHour` | — | `2` (2 AM local time) |
| `schedules.publicRepoScannerHour` | — | `4` (4 AM local time) |
| `schedules.actionsStorageMonitorHour` | — | `5` (5 AM local time) |
| `schedules.reminderMonitorHour` | — | `8` (8 AM local time) |
| `schedules.upstreamWatcherHour` | — | `10` (10 AM local time) |
| `schedules.shoppingSourcerHour` | — | `7` (7 AM local time) |
| `schedules.blogDraftScannerHour` | — | `9` (9 AM local time) |
| `schedules.sitePromoterHour` | — | `11` (11 AM local time) |
| `intervals.dampReminderMs` | — | `900000` (15 min; `damp-reminder` still only creates the issue on Mondays ≥ 9 AM local) |
| `smartScheduling.enabled` | — | `true` |
| `smartScheduling.quietHourStart` | — | `19` (accepted but unused — off-hours gating was removed) |
| `smartScheduling.quietHourEnd` | — | `7` (accepted but unused — off-hours gating was removed) |
| `smartScheduling.tickIntervalMs` | — | `3600000` (1 hour) |
| `smartScheduling.jobs` | — | `{ "improvement-identifier": {}, "doc-maintainer": {}, "issue-auditor": {}, "scanner-dispatcher": {}, "stale-branch-cleaner": {}, "dependabot-alert-monitor": {}, "dependabot-run-monitor": {} }` — set of jobs that use smart scheduling |
| `smartScheduling.targetStalenessMs` | — | `86400000` (24h — repos not processed within this window are "due") |
| `smartScheduling.sloStalenessMs` | — | `172800000` (48h — repos past this threshold force processing even when Claws is busy) |
| `smartScheduling.maxConcurrentJobTasks` | — | `4` (max concurrent repo processing slots via `withSmartJobSlot`) |
| `smartScheduling.ignoreBusyKinds` | — | `["ci-fixer", "ci-fixer:conflict", "ci-fixer:rerun", "ci-fixer:problematic", "review-addresser", "pr-reviewer", "auto-merger:sweep", "doc-maintainer", "improvement-identifier", "issue-auditor"]` — agent kinds excluded from the busy check |
| `runners` | — | No default runner hosts (empty array) since `hetzner-beefy-actions` was decommissioned (#2770). Each entry is either an svc runner (`actionsDir`) or a NixOS systemd runner (`serviceUnit` + `workDir` + `toolDir`) — see `docs/jobs/runner-monitor.md` |
| `macRunners` | — | Two default `MacRunner` entries (`{name, host, user?, port?, identityFile?, labels, enabled?}`): `Brendans-MacBook-Pro` (`brendans-macbook-pro.local`, labels `macos`+`tempo`) and `Brendans-MacBook-Pro-3` (`brendans-macbook-pro-3.local`, `user: "brendanstjohn"`, labels `macos`+`xcode26`) — woken by `mac-runner-waker`; kept separate from `runners`/`RUNNER_HOSTS` since `runner-monitor` cannot manage macOS hosts. `enabled` (optional, default `true`) is togglable per-Mac from the config UI (#1984) — set `false` to stop `mac-runner-waker` from SSHing to or alerting on a Mac that's been taken off the LAN |
| `macRunnerRepos` | — | `["St-John-Software/bonkus", "St-John-Software/namey", "St-John-Software/TempoStatusBar"]` (repos `mac-runner-waker` polls for queued macOS jobs) |
| `intervals.macRunnerWakerMs` | — | `60000` (1 min) |
| `publicSnapshots` | — | Four `{ source, target, mirrorReleases?, scrubPaths?, releaseAssetUrl? }` pairs (#1826): `St-John-Software/claws` → `stjohnb/claws-snapshot` (`scrubPaths: [".github/workflows/history-cleanup.yml", "src/config.ts", "src/jobs/runner-monitor.test.ts"]` — the workflow file was added first (#2009, leaked a personal email into the public mirror), then `src/config.ts` (#2094 — the file embeds infra-specific config, including these very `publicSnapshots` entries), then `src/jobs/runner-monitor.test.ts` (#2716 — a fixture in that test file hard-coded a real runner host IP and SSH username; there is no line-level scrub, so the whole file is excluded)), `St-John-Software/3d-models` → `stjohnb/3d-models`, `St-John-Software/TempoStatusBar` → `stjohnb/TempoStatusBar` (`mirrorReleases: true` — the only pair with release mirroring enabled, #1851 — and `releaseAssetUrl: "https://tempo-statusbar-releases.s3.us-east-1.amazonaws.com/releases/TempoStatusBarApp-{version}.dmg"`, an HTTPS fallback the mirror fetches only for semver tags carrying no `.dmg` asset; `{version}` is the tag with a leading `v` stripped, #2115, #2813), `St-John-Software/fleet-infra` → `stjohnb/homelab` (`scrubPaths: ["apps/authentik/configmap-blueprints.yaml"]`, #1962). Any pair with a non-empty `scrubPaths` republishes as a squashed, force-pushed single-commit history every sync (there is no way to remove a path from ancestor commits without discarding history) and is mutually exclusive with `mirrorReleases` (enforced by a zod refinement in `config.ts`) |
| `logRetentionDays` | — | `14` |
| `logRetentionPerJob` | — | `20` |
| `emailEnabled` | `CLAWS_EMAIL_ENABLED` | `true` |
| `emailUser` | `CLAWS_EMAIL_USER` | `""` (empty — must be set in env or config) |
| `emailAppPassword` | `BRENDAN_SERVER_GMAIL_APP_PASSWORD` | *(empty)* |
| `emailRecipient` | `CLAWS_EMAIL_RECIPIENT` | `""` (empty — must be set in env or config) |
| `emailAllowedSenders` | `CLAWS_EMAIL_ALLOWED_SENDERS` | `[]` (comma-separated in env, lower-cased; empty = allow all senders. When non-empty, `email-monitor` skips messages whose `From` address isn't in the list — #2068) |
| `dmarcBlockedSenders` | `CLAWS_DMARC_BLOCKED_SENDERS` | `[]` (comma-separated in env, lower-cased; an entry with `@` matches a full address, an entry without matches a domain and its subdomains. `dmarc-monitor` drops matching messages before parsing or storing — #2838) |
| `whatsappEnabled` | `WHATSAPP_ENABLED` | `false` |
| `whatsappAllowedNumbers` | `WHATSAPP_ALLOWED_NUMBERS` | `[]` |
| `openaiApiKey` | `OPENAI_API_KEY` | *(empty)* |
| `maxWorkWorkers` | `CLAWS_MAX_WORK_WORKERS` | `2` (`maxClaudeWorkers` / `CLAWS_MAX_CLAUDE_WORKERS` are deprecated aliases) |
| `claudeTimeoutMs` | `CLAWS_CLAUDE_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `claudeLivenessTimeoutMs` | `CLAWS_CLAUDE_LIVENESS_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `claudeWorkerMemoryMaxBytes` | `CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES` | `2147483648` (2 GiB; 0 disables). Browser-driving jobs (shopping-sourcer) raise this per call via `runClaude`'s `memoryMaxBytes` option, so this value is a floor for them, not a ceiling. |
| `worktreeStaleMs` | — | `604800000` (7 days — worktrees older than this are pruned by worktree-cleaner) |
| `reviewModelTier` | `CLAWS_REVIEW_MODEL_TIER` | `"sonnet"` (global default model tier for PR reviews; `"opus"` raises all reviews to the opus tier) |
| `openrouterApiKey` | `CLAWS_OPENROUTER_API_KEY` | *(empty — required for the OpenCode backend)* |
| `providerFallbackOrder` | `CLAWS_PROVIDER_FALLBACK_ORDER` | `["claude"]` (provider order for `runClaude` calls that aren't pinned — see [Model Selection](patterns.md#model-selection)). A config written before #2688 carries the legacy `toolUseProviderFallbackOrder`; it is read once as a migration source when `providerFallbackOrder` is absent |
| `providerRateLimitCooldownMs` | `CLAWS_PROVIDER_RATE_LIMIT_COOLDOWN_MS` | `300000` (5 min — fixed cooldown a provider is skipped for after a classified rate-limit error, applied by the fallback loop in `claude.ts`; not the actual reset time parsed from the error text) |
| `codexDefaultModel` | `CLAWS_CODEX_DEFAULT_MODEL` | `"gpt-5.4"` (Codex opus-tier default). Retired Codex model IDs found in config (e.g. from before #2694) are auto-substituted by `resolveCodexModel()` in `src/model-selector.ts` with a `[model-selector]` warning; on a ChatGPT-account Codex install only `gpt-5.4` and `gpt-5.4-mini` are accepted |
| `codexLightModel` | `CLAWS_CODEX_LIGHT_MODEL` | `"gpt-5.4"` |
| `codexCheapModel` | `CLAWS_CODEX_CHEAP_MODEL` | `"gpt-5.4-mini"` |
| `claudeCheapModel` | `CLAWS_CLAUDE_CHEAP_MODEL` | `"claude-haiku-4-5-20251001"` |
| `opencodeBestModel` / `opencodeAdequateModel` / `opencodeCheapModel` | `CLAWS_OPENCODE_BEST_MODEL` / `CLAWS_OPENCODE_ADEQUATE_MODEL` / `CLAWS_OPENCODE_CHEAP_MODEL` | `"openrouter/anthropic/claude-opus-4"` / `"openrouter/anthropic/claude-sonnet-4.5"` / `"openrouter/google/gemini-2.5-flash"` — opencode routes through OpenRouter, so model IDs must carry the `openrouter/` prefix and match opencode's own model registry (dots not hyphens, e.g. `claude-sonnet-4.5`), not the raw Anthropic/OpenRouter catalog names (#905, #907) |
| `improvementIdentifierModel` | `CLAWS_IMPROVEMENT_IDENTIFIER_MODEL` | `"openrouter/z-ai/glm-5.3"` (OpenRouter model ID used for improvement-identifier's whole-repo analysis phase via OpenCode; same `openrouter/` prefix requirement as the `opencode*Model` keys above) |
| `ollamaBaseUrl` | `CLAWS_OLLAMA_BASE_URL` | Local Ollama instance used by `ollama-rate-limit-classifier.ts` to classify Claude/Codex/OpenCode usage-limit errors, with a regex fallback when Ollama is unreachable |
| `ollamaTimeoutMs` | `CLAWS_OLLAMA_TIMEOUT_MS` | `60000` (1 min — generous to tolerate a cold-started local Ollama) |
| `ollamaConsecutiveFailuresBeforeDisable` | `CLAWS_OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE` | `3` (consecutive Ollama failures before a 5-minute circuit breaker falls back to regex-only classification) |
| `whisperBaseUrl` / `whisperLocalUrl` | `CLAWS_WHISPER_BASE_URL` / `CLAWS_WHISPER_LOCAL_URL` | Self-hosted faster-whisper transcription server endpoints — see [Voice-note transcription](whatsapp-setup.md#step-2--voice-note-transcription-on-by-default) |
| `whisperModel` | `CLAWS_WHISPER_MODEL` | `"Systran/faster-whisper-base"` |
| `bindHost` | `CLAWS_BIND_HOST` | `"0.0.0.0"` |
| `activationState` | `CLAWS_ACTIVATION_STATE` | `"active"` (or `"verify-only"` for the Kubernetes verify-only rollout mode — see [Kubernetes Deployment](OVERVIEW.md#kubernetes-deployment) in OVERVIEW.md) |
| `oidcClientId` | `CLAWS_OIDC_CLIENT_ID` | *(empty)* |
| `oidcClientSecret` | `CLAWS_OIDC_CLIENT_SECRET` | *(empty)* |
| `oidcBaseUrl` | `CLAWS_OIDC_BASE_URL` | *(empty — e.g. `https://auth.example.com`)* |
| `oidcApplicationSlug` | `CLAWS_OIDC_APPLICATION_SLUG` | *(empty — authentik application slug)* |
| `oidcRedirectUri` | `CLAWS_OIDC_REDIRECT_URI` | *(empty — defaults to `http://localhost:<port>/auth/callback`)* |
| `oidcHostMap` | `CLAWS_OIDC_HOST_MAP` | *(empty — comma-separated `host=authBaseUrl` pairs, e.g. `claws.ext.bstjohn.net=https://auth.ext.bstjohn.net`; when the request's `X-Forwarded-Host`/`Host` matches a key, `/login` and `/logout` use that Authentik base URL and derive `redirect_uri` as `https://<host>/auth/callback`, so an externally-reached dashboard doesn't bounce to an internal-only auth host — #2841. Set it alongside the other `CLAWS_OIDC_*` values: an unmapped host that isn't the `oidcRedirectUri` host logs a once-per-host `[oidc]` warning and falls back to `oidcBaseUrl`)* |
| `dashboardUrl` | `CLAWS_DASHBOARD_URL` | *(derived from `oidcRedirectUri`'s origin — public base URL used for dashboard links in Slack alerts)* |
| `githubAppId` | `CLAWS_GITHUB_APP_ID` | `0` (disabled) |
| `githubAppPrivateKeyPath` | `CLAWS_GITHUB_APP_PRIVATE_KEY_PATH` | *(empty)* |
| `githubAppInstallationIds` | — | `{}` (owner → installation ID overrides) |
| `githubOwnerAppCredentials` | — | `{}` (per-owner App credentials — `Record<string, {appId, privateKeyPath, installationId?}>` — overrides global credentials per owner; also listed in `SENSITIVE_KEYS`) |
| `pausedJobs` | — | `[]` (job names to pause on startup) |
| `disabledJobsByRepo` | — | `{}` (map of repo full name → array of job names to disable for that repo) |
| `prodAlertWorkflows` | — | `{"St-John-Software/production-infra": ["Tofu Apply", "Flux Bootstrap"]}` (map of repo full name → workflow names whose default-branch failure also pages `slackProdAlertsWebhook`; deliberately non-empty so paging survives deleting the repo's own `notify-failures.yml`) |
| `mainBuildMonitorIgnoreWorkflows` | — | `{}` (map of repo full name → workflow names `main-build-monitor` must never file issues for) |
| `disabledAgents` | — | `[]` (agent names to disable: `planner`, `implementer`, `ci-fixer`, `review-addresser`, `reviewer`, `merger`, `empty-pr-closer`, `superseded-pr-closer`) |
| `skippedItems` | — | `[]` (array of `{repo, number}` excluded from processing) |
| `prioritizedItems` | — | `[]` (array of `{repo, number}` processed first) |
| `itemTimeoutOverrides` | — | `[]` (array of `{repo, number, timeoutMs}` — auto-managed by timeout escalation) |
| `homeAssistantBaseUrl` | `CLAWS_HOME_ASSISTANT_BASE_URL` | *(empty — HA REST API integration disabled)* |
| `homeAssistantToken` | `CLAWS_HOME_ASSISTANT_TOKEN` | *(empty — required when homeAssistantBaseUrl is set)* |
| `homeAssistantConfigRepo` | — | *(empty — e.g. `St-John-Software/home-assistant-config`)* |
| `homeAssistantUpgraderEnabled` | `CLAWS_HOME_ASSISTANT_UPGRADER_ENABLED` | Defaults to whether HA is configured (`homeAssistantBaseUrl` + `homeAssistantToken` both set); set `false` to disable the `ha-upgrader` job without unconfiguring HA |
| `homeAssistantUpgraderExcludePatterns` | `CLAWS_HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS` | `[]` (comma-separated in env; entity IDs/patterns `ha-upgrader` should never install updates for) |
| `homeAssistantDeployWatcherEnabled` | `CLAWS_HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-deploy-watcher` job |
| `homeAssistantAreaReconcilerEnabled` | `CLAWS_HOME_ASSISTANT_AREA_RECONCILER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-area-reconciler` job (which enforces `registry/areas.yaml` in `homeAssistantConfigRepo` against the live entity registry) |
| `homeAssistantEnergyReconcilerEnabled` | `CLAWS_HOME_ASSISTANT_ENERGY_RECONCILER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-energy-reconciler` job (which enforces `registry/energy.yaml` in `homeAssistantConfigRepo` against the live Energy dashboard prefs) |
| `homeAssistantGitPullAddonSlug` | `CLAWS_HOME_ASSISTANT_GIT_PULL_ADDON_SLUG` | `"core_git_pull"` (HA Supervisor addon slug `ha-deploy-watcher` polls for `Updating <old>..<new>` log lines) |
| `allowedActors` | — | `["stjohnb"]` (issue authors whose issues are dispatched into the refine/implement pipeline; see [Content-Based State Machine](#content-based-state-machine)) |
| `dependabotIgnoredAdvisories` | — | `{}` (map of repo full name, or `"*"` for all repos, → array of `GHSA-...` IDs to suppress before filing the `dependabot-alert-monitor` alert issue) |
| `notifyDashboardActions` | — | `true` (send Slack notifications for all dashboard mutations) |
| `dependabotAutoDismissStale` | — | `true` (auto-dismiss Dependabot alerts whose patched version is already present in the dependency-graph SBOM; set to `false` to disable) |
| `dependabotAutoRemediate` | `CLAWS_DEPENDABOT_AUTO_REMEDIATE` | `true` (apply `Automerge` to a Dependabot alert issue whose alerts are all routine, so the plan auto-refines and the PR auto-merges; set to `false` to require a human `Refined`) |
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
| `ciFixerCircuitBreaker.maxConflictAttempts` | — | `3` (unproductive conflict-resolution attempts before leaving for manual resolution) |
| `ciFixerCircuitBreaker.maxCommitGrants` | — | `3` (lifetime fresh-budget grants per PR for commits pushed after the breaker tripped) |
| `homeAssistantBinDayMonitorEnabled` | `CLAWS_HOME_ASSISTANT_BIN_DAY_MONITOR_ENABLED` | `false` (enable bin-day sensor monitoring) |
| `homeAssistantBinDaySensorPrefix` | `CLAWS_HOME_ASSISTANT_BIN_DAY_SENSOR_PREFIX` | `"sensor.bin_scraper_"` (HA entity ID prefix to monitor) |
| `intervals.binDayMonitorMs` | — | `900000` (15 min) |
| `homeAssistantBatteryMonitorEnabled` | `CLAWS_HOME_ASSISTANT_BATTERY_MONITOR_ENABLED` | `false` (enable battery-level sensor monitoring) |
| `homeAssistantBatteryThresholdPercent` | `CLAWS_HOME_ASSISTANT_BATTERY_THRESHOLD_PERCENT` | `10` (alert threshold — devices at or below this percent are reported; `<=` comparison so exactly-10% devices are included) |
| `intervals.batteryMonitorMs` | — | `3600000` (1 hour) |
| `homeAssistantBackupMonitorEnabled` | `CLAWS_HOME_ASSISTANT_BACKUP_MONITOR_ENABLED` | `false` (enable automatic-backup failure/overdue monitoring) |
| `intervals.backupMonitorMs` | — | `3600000` (1 hour) |
| `homeAssistantDeployStallMonitorEnabled` | — | `true`; set `false` in the config file to disable deploy-pipeline stall monitoring |
| `intervals.deployStallMonitorMs` | — | `900000` (15 min) |
| `homeAssistantRepairsMonitorEnabled` | `CLAWS_HOME_ASSISTANT_REPAIRS_MONITOR_ENABLED` | defaults to whether HA is configured |
| `homeAssistantRepairsIgnore` | — | `[{domain:"hassio",translationKey:"issue_mount_mount_failed",placeholders:{reference:"nas_backup"}}]` (rules suppressing `ha-repairs-monitor` alerts; matched on domain + translation key + placeholders because Supervisor mount repairs get a fresh uuid daily) |
| `intervals.repairsMonitorMs` | — | `3600000` (1 hour) |
| `intervals.haAreaReconcilerMs` | — | `1800000` (30 min) |
| `intervals.haEnergyReconcilerMs` | — | `1800000` (30 min) |

### Provider parity

Codex runs are not identical to Claude runs. `runClaude` invokes
`codex exec --json`, so the agent's answer is the final `agent_message` event
rather than the human transcript, and the `turn.completed` usage event is
recorded via `onTokensUsed` — but Codex reports no price, so the cost column on
`/usage` is **0** for every Codex run while the token counts are real.
`/usage` can be filtered by repo, job, provider and model via query params.
Codex
also gets no MCP tools (`mcpConfig` is ignored; jobs that need MCP are forced
onto Claude by `model-selector.ts`) and has no `--append-system-prompt`, so the
repo's `.agents/<role>.md` document is inlined into the prompt inside an
`<agent-role>` block. The repo's own instructions are inlined the same way
inside `<repository-instructions>`, read from `AGENTS.md` (Codex's native file)
falling back to `CLAUDE.md`, capped at 32 KiB — the Claude CLI auto-loads
`CLAUDE.md` itself, Codex does not.

Interactive sessions differ too. Plain Claude sessions run with a Claws-owned
`--mcp-config --strict-mcp-config`, so ambient user-level MCP/plugins are
ignored and the built-in `claws-state` server is present. Claude sessions with
the `browser` capability deliberately switch to a Playwright-only config and do
not also expose `claws-state`. Codex interactive sessions still get no Claws
MCP tools, but they run inside a per-session `CODEX_HOME` seeded only with
minimal config (plus `~/.codex/auth.json` when present) so ambient
`~/.codex/config.toml` plugins/MCP servers do not leak into Claws sessions.

The Config page sets the global default provider (and its fallbacks) for all agent runs; the first provider in the order is the global default. On an individual GitHub issue or PR, apply **Use Codex** or **Use Claude** to override that global default; applying both leaves the item on the global default. Explicit provider labels are pinned to that provider and do not silently fall back to another provider.

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

External tools `gh`, `claude`, and `codex` must be authenticated separately — Claws does
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

## Forgejo repos

`forgejoRepos` lists the repos whose canonical home is Forgejo rather than
GitHub. Each is automated against `forgejoBaseUrl`'s Gitea-compatible API, and
its GitHub twin — which stays in the App installation as a push mirror — is
excluded from discovery permanently. See
[Forgejo repos](OVERVIEW.md#forgejo-repos) for how routing works.

The token is used both for the API (`Authorization: token <tok>`) and for git
over HTTPS, where `buildEnvForGhGit` injects it via a second inline credential
helper keyed on the Forgejo host with username `oauth2`. It is never rendered
on the config page and never written inside a worktree. Without it, every
Forgejo call throws and the repo is skipped at discovery, so Claws degrades to
doing nothing on that repo rather than automating a stale mirror.

### The bot account (`clawsstjohn`)

Claws authenticates to `git.home.bstjohn.net` as the dedicated bot user
**`clawsstjohn`** (created 2026-08-28). As of that date it is a collaborator
with write permission on `St-John-Software/perudo` only.

A dedicated bot account is **mandatory, not a convenience**. `hasValidLGTM` in
`src/forgejo.ts` treats an approval as human only when the approver's login is
*not* Claws' own login (`forgejoSelfLogin()`, i.e. the token's account) and *is*
in `allowedActors`. Put the token on the owner's personal account and Claws
becomes its own reviewer: the owner's approvals and `LGTM` comments are
discarded as self-approval, and no Claws PR on a Forgejo repo can ever merge.

For the same reason, confirm the owner's *Forgejo* login is in `allowedActors`
— actor gating on these repos compares Forgejo logins, not GitHub ones. Today
`allowedActors` contains `brendan` (the Forgejo login) alongside `stjohnb` (the
GitHub login).

### The token

Name `claws-service`, scopes `write:repository,write:issue,read:user`. That is
the minimum: every Claws call is under `/repos/...` except
`forgejoSelfLogin()`'s `GET /user`, which needs `read:user` and which
`hasValidLGTM` and `isAllowedActor` both depend on. Store it as `forgejoToken`
in `~/.claws/config.json` (or export `CLAWS_FORGEJO_TOKEN`).

Forgejo runs as the `forgejo` deployment in the `default` namespace of the home
cluster; its admin CLI is reached by `kubectl exec` into the pod:

```bash
kubectl exec -n default deploy/forgejo -- \
  forgejo admin user generate-access-token \
    -u clawsstjohn -t claws-service \
    --scopes write:repository,write:issue,read:user --raw
```

Then set `forgejoToken` in `~/.claws/config.json` and
`sudo systemctl restart claws.service`. The restart is safe for in-flight agent
sessions: the unit sets `KillMode=process`, so tmux sessions survive it.

**Gotcha — tokens can only be revoked in the web UI.** Forgejo's
token-management endpoints (`DELETE /api/v1/users/{user}/tokens/{name}` and
friends) accept *password* basic auth only; token auth and basic-auth-with-a-
token both return `auth method not allowed`. So a token minted by mistake
cannot be cleaned up programmatically — it has to be deleted by hand in Forgejo
→ Settings → Applications, as the account that owns it. Mint carefully, and
don't script token cleanup.

### Granting Claws access to a repo

**Recommended — an org-level team (covers future repos automatically).** In the
`St-John-Software` Forgejo org, create a team named `bots` with write
permission and "all repositories" (which includes repositories created later),
and add `clawsstjohn` to it. Once that team exists, onboarding a newly migrated
repo is just: create/migrate the repo into the org, add its full name to
`forgejoRepos` in `~/.claws/config.json`, and restart `claws.service`. No
per-repo permission step. The existing per-repo collaborator grant on
`St-John-Software/perudo` should be migrated into that team so there is one
place granting Claws access.

Creating the team is a one-time manual step in the Forgejo UI (Organisation →
Teams → New Team); Claws has no code path for it.

**Fallback — per-repo collaborator (for repos outside the org).** Add
`clawsstjohn` as a collaborator with write permission:

```
PUT /api/v1/repos/{owner}/{repo}/collaborators/clawsstjohn
{"permission":"write"}
```

This call must be made as a user who administers the repo, so it needs a token
on *that* account, not on `clawsstjohn`'s — which is why the temporary setup
tokens minted for the perudo grant then had to be revoked by hand in the UI.
Prefer the team route and avoid minting throwaway tokens.

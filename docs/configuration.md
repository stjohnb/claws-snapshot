# Configuration

**Reference.** Exhaustive config key / env var / default table. For the dozen
keys you actually touch, OVERVIEW's Configuration section is enough.

Product requirements: [product/operations-and-safety.md](product/operations-and-safety.md)

Configuration is resolved per-field: env vars > `~/.claws/config.json` >
defaults.

| Config key | Env variable | Default |
|---|---|---|
| `slackWebhook` | `CLAWS_SLACK_WEBHOOK` | *(empty — must be set)* |
| `slackProdAlertsWebhook` | `CLAWS_SLACK_PROD_ALERTS_WEBHOOK` | *(empty — falls back to `slackWebhook`; used by `notifyProdAlert` for prod-down pages; never rendered on the config page)* |
| `slackBotToken` | `CLAWS_SLACK_BOT_TOKEN` | *(empty — needed for idea threads)* |
| `slackIdeasChannel` | `CLAWS_SLACK_IDEAS_CHANNEL` | *(empty — needed for idea threads)* |
| `githubOwners` | `CLAWS_GITHUB_OWNERS` | `["stjohnb","St-John-Software"]` |
| `selfRepo` | `CLAWS_SELF_REPO` | `St-John-Software/claws` **Stays on the host** (#2898): a role assignment read at server start, before discovery has populated the `claws.json` cache — and `selfRepo` gates discovery itself, so a repo-side `role` would be unreadable at the moment it is needed. |
| *(none — discovered)* | `CLAWS_FORGEJO_REPOS` | Forgejo discovery (`GET /user/repos` as the bot account) is the only source; there is no checked-in list and no config.json key (#2952). `CLAWS_FORGEJO_REPOS` is an emergency additive override: it adds repos discovery can't currently see (or fetches a name directly when discovery is down); it does not replace or disable discovery. **Stays on the host** (#2898). |
| `forgejoBaseUrl` | `CLAWS_FORGEJO_BASE_URL` | `https://git.home.bstjohn.net` |
| `forgejoToken` | `CLAWS_FORGEJO_TOKEN` | *(empty — Forgejo API access token; never rendered on the config page)* |
| `forgejoReadToken` | `CLAWS_FORGEJO_READ_TOKEN` | *(empty — least-privilege Forgejo code-read + issue-write token for the implicit `cross-repo` capability; env var wins over the config-file key; never rendered on the config page; exposed to agents only as `CLAWS_FORGEJO_READ_TOKEN`)* |
| `forgejoAdminToken` | `CLAWS_FORGEJO_ADMIN_TOKEN` | *(empty — optional org-Owner token for the opt-in `forgejo-admin` session capability; env var wins over the config-file key; never rendered on the config page, never given to a headless agent. The service also uses it in-process, read-only, for the Actions runner registry and waiting-jobs endpoints on behalf of `mac-runner-waker` — without it, Forgejo repos are never woken and never get a `mac-runner-offline` alert (#3099))* |
| *(none — env only)* | `CLAWS_GIT_AUTHOR_NAME` | `clawsstjohn[bot]` — author/committer identity for every git commit Claws or its agents make, because the service host has no global git identity (#3206). |
| *(none — env only)* | `CLAWS_GIT_AUTHOR_EMAIL` | `276932287+clawsstjohn[bot]@users.noreply.github.com` — see `CLAWS_GIT_AUTHOR_NAME` above. |
| *(none — env only)* | `CLAWS_PR_STORE_FACADE` | off — only `true` turns it on. Read at call time, so it can be flipped back without a deploy. When on, `listPRs` and `getPRMergeGate` serve the six PR state labels from `claws_prs` instead of the forge ([database-schema.md](database-schema.md#claws_prs-table)). Do not enable until the issue auditor's `pr-store` comparison has swept clean for about a week ([jobs/issue-auditor.md](jobs/issue-auditor.md#pr-state-store-comparison)). |
| `port` | `PORT` | `3000` |
| `intervals.issueDispatcherMs` | — | `300000` (5 min) |
| `intervals.prDispatcherMs` | — | `300000` (5 min) |
| `intervals.autoMergerMs` | — | `180000` (3 min) |
| `intervals.triageClawsErrorsMs` | — | `600000` (10 min) |
| `intervals.issueShadowSyncMs` | — | `300000` (5 min) |
| `intervals.issuePreviewSyncMs` | — | `300000` (5 min) — the [issue-preview-sync](jobs/issue-preview-sync.md) timer |
| `intervals.issueImporterMs` | — | `1800000` (30 min) — the [issue-importer](jobs/issue-importer.md) timer |
| `intervals.shoppingCommentProcessorMs` | — | `600000` (10 min) |
| `intervals.runnerMonitorMs` | — | `600000` (10 min) |
| `intervals.hostDiskMonitorMs` | — | `600000` (10 min) |
| `intervals.emailMonitorMs` | — | `300000` (5 min) |
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
| `runners` | — | No default runner hosts (empty array) since `hetzner-beefy-actions` was decommissioned (#2770). Each entry is either an svc runner (`actionsDir`) or a NixOS systemd runner (`serviceUnit` + `workDir` + `toolDir`) — see `docs/jobs/runner-monitor.md`. Forgejo runners are not configured here: `runner-monitor` discovers them from the Forgejo org runner registry (#2863) |
| `macRunners` | — | Two default `MacRunner` entries (`{name, host, user?, port?, identityFile?, labels, enabled?}`): `Brendans-MacBook-Pro` (`brendans-macbook-pro.local`, labels `macos`+`tempo`) and `Brendans-MacBook-Pro-3` (`brendans-macbook-pro-3.local`, `user: "brendanstjohn"`, labels `macos`+`xcode26`) — woken by `mac-runner-waker`; kept separate from `runners`/`RUNNER_HOSTS` since `runner-monitor` cannot manage macOS hosts. `enabled` (optional, default `true`) is togglable per-Mac from the config UI (#1984) — set `false` to stop `mac-runner-waker` from SSHing to or alerting on a Mac that's been taken off the LAN. Each enabled entry also becomes an `ssh:<slug>` session capability (#3138) — not pre-ticked for any repo, reachable via "Show all capabilities" or the live-grant dropdown like `forgejo-admin`; disabling or removing a Mac here hides its capability immediately, but a Mac *added* here only gets one once the service restarts |
| `macRunnerRepos` | — | `["St-John-Software/bonkus", "St-John-Software/namey", "St-John-Software/TempoStatusBar"]` (repos `mac-runner-waker` polls for queued macOS jobs) **Operator override** — unioned with each repo's `claws.json`; see [repo-config.md](repo-config.md). A repo can enrol itself with `"runners": ["macos"]` in its own `claws.json` (#2898). Pruned on every config Save: an entry for an enabled repo whose `claws.json` declares `runners: ["macos"]` is redundant and is removed (#2936). |
| `intervals.macRunnerWakerMs` | — | `60000` (1 min) |
| `publicSnapshots` | — | Four `{ source, target, mirrorReleases?, scrubPaths?, releaseAssetUrl? }` pairs (#1826): `St-John-Software/claws` → `stjohnb/claws-snapshot` (`scrubPaths: [".github/workflows/history-cleanup.yml", "src/config.ts", "src/jobs/runner-monitor.test.ts"]` — the workflow file was added first (#2009, leaked a personal email into the public mirror), then `src/config.ts` (#2094 — the file embeds infra-specific config, including these very `publicSnapshots` entries), then `src/jobs/runner-monitor.test.ts` (#2716 — a fixture in that test file hard-coded a real runner host IP and SSH username; there is no line-level scrub, so the whole file is excluded)), `St-John-Software/3d-models` → `stjohnb/3d-models` (`scrubPaths: ["power-workshop/images/photos/IMG_2823.jpg", "power-workshop/images/photos/IMG_2824.jpg", "power-workshop/images/photos/IMG_2825.jpg", "power-workshop/images/photos/IMG_2826.jpg", "power-workshop/images/photos/IMG_2827.jpg"]` — #3118, GPS EXIF coordinates in workshop reference photos; only these five of the nineteen photos in that directory carry GPS, and the rest are embedded in `docs/blog-post.md`, so the directory is not scrubbed wholesale), `St-John-Software/TempoStatusBar` → `stjohnb/TempoStatusBar` (`mirrorReleases: true` — the only pair with release mirroring enabled, #1851 — and `releaseAssetUrl: "https://tempo-statusbar-releases.s3.us-east-1.amazonaws.com/releases/TempoStatusBarApp-{version}.dmg"`, an HTTPS fallback the mirror fetches only for semver tags carrying no `.dmg` asset; `{version}` is the tag with a leading `v` stripped, #2115, #2813), `St-John-Software/fleet-infra` → `stjohnb/homelab` (`scrubPaths: ["apps/authentik/configmap-blueprints.yaml"]`, #1962). Any pair with a non-empty `scrubPaths` republishes as a squashed, force-pushed single-commit history every sync (there is no way to remove a path from ancestor commits without discarding history) and is mutually exclusive with `mirrorReleases` (enforced by a zod refinement in `config.ts`) **Stays on the host** (#2898): `claws.json` is published verbatim into the public target, so a repo-side `scrubPaths` would publish the very inventory of paths judged too sensitive to publish; a pair is also joint state about two repos, and the target is not Claws-managed. |
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
| `maxWorkWorkers` | `CLAWS_MAX_WORK_WORKERS` | `2` (`maxClaudeWorkers` / `CLAWS_MAX_CLAUDE_WORKERS` are deprecated aliases). One extra priority-only express fiber always runs on top of this count. |
| `claudeTimeoutMs` | `CLAWS_CLAUDE_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `claudeLivenessTimeoutMs` | `CLAWS_CLAUDE_LIVENESS_TIMEOUT_MS` | `21600000` (6 hours, minimum 60s) |
| `agentWorkerMemoryMaxBytes` | `CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES` | `2147483648` (2 GiB; 0 disables the watchdog and derived admission). Deprecated aliases: `claudeWorkerMemoryMaxBytes` / `CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES`. The neutral name wins at the same precedence level (env vs env, file vs file), but env still beats the config file — so a `CLAWS_CLAUDE_WORKER_MEMORY_MAX_BYTES` env var overrides a neutral `agentWorkerMemoryMaxBytes` config-file key. Claws logs a one-time `[config]` warning when the cap comes from a deprecated name, so that migration is visible. Browser-driving jobs (shopping-sourcer) raise this per call via `runClaude`'s `memoryMaxBytes` option, so this value is a floor for them, not a ceiling. The raised browser cap applies only to the local-Chromium fallback: with `CLAWS_BROWSER_CDP_ENDPOINT` set, Chromium runs in the shared service and shopping-sourcer uses this cap. The current Kubernetes policy is a 4 GiB cap with `CLAWS_MAX_WORK_WORKERS=2` under a 10 GiB service container, using shared memory admission to serialize unsafe overlaps: the derived 8960 MiB budget admits both full-cap workers plus the auxiliary lane, and a third full-cap run waits. The cap is *per run*, and a run that declares the auxiliary workload class is capped at that smaller slice instead — the reservation and the watchdog cap are always the same number. A run is auxiliary when it passes a positive `admissionBytes`, or when it sets neither `memoryMaxBytes` nor `mcpConfig` and either runs under a 10-minute own timeout or denies the whole text-only tool set; a browser-driving or MCP-driving run is therefore always agent-scale. The smaller cap is applied only while shared admission is active. This setting, and the other two `agentWorkerMemory*` keys below, apply to the service process only — an agent pod's launcher strips them from both its env and its shipped `config.json` and derives its own watchdog cap from `CLAWS_AGENT_POD_MEMORY_LIMIT` instead; see that row. |
| `agentWorkerMemoryHeadroomBytes` | `CLAWS_AGENT_WORKER_MEMORY_HEADROOM_BYTES` | `1342177280` (1.25 GiB). Bytes withheld from the cgroup memory limit for the Claws service itself (dashboard, scheduler, pollers, page cache) — everything that never passes through admission. The shared headless-agent budget is `containerLimit - headroom`, and the auxiliary lane is carved out of that budget, not out of this headroom. Size it by how many concurrent full-cap runs the budget should admit: `budget >= n * cap + AUXILIARY_AGENT_ADMISSION_BYTES` admits `n` overlapping agent runs plus a bookkeeping call. At the deployed 10 GiB container / 4 GiB cap the default leaves 8960 MiB, i.e. `n = 2`. A headroom at or above the container limit no longer disables admission: the derived budget is clamped to the cap (strict one-at-a-time) and a `[claws]` warning says so. |
| `agentWorkerMemorySharedBudgetBytes` | `CLAWS_AGENT_WORKER_MEMORY_SHARED_BUDGET_BYTES` | *(unset)*. Explicit shared budget for headless-agent admission. Unset derives from the cgroup limit. An invalid value (unparseable, negative, or below the 64 MiB floor) is rejected with a `[config]` warning and falls back to the *derived* budget, never to `0` — only an operator literally writing `0` disables admission. An explicit budget keeps admission active even when `agentWorkerMemoryMaxBytes=0` — uncapped runs then reserve the whole budget and run one at a time; otherwise `0` disables both the watchdog and derived admission. All three `agentWorkerMemory*` keys are plain byte counts with **no unit suffixes**: `parseInt` stops at the first non-digit, so `4.5GiB` would parse as `4` bytes. An unparseable, negative, or non-zero-below-64-MiB value is rejected with a `[config]` warning; `agentWorkerMemoryMaxBytes` and `agentWorkerMemoryHeadroomBytes` then use their defaults, and `agentWorkerMemorySharedBudgetBytes` falls back to the derived budget. |
| `worktreeStaleMs` | — | `604800000` (7 days — worktrees older than this are pruned by worktree-cleaner) |
| `reviewModelTier` | `CLAWS_REVIEW_MODEL_TIER` | `"sonnet"` (global default model tier for PR reviews, used when neither the plan nor the PR body names one). Accepts any tier — `"fable"`, `"opus"`, `"sonnet"`, `"haiku"` — plus the legacy `"cheap"`, which reads as `"haiku"`; an unrecognised value falls back to `"sonnet"`. Editable on `/config` — see [model-selection.md](model-selection.md) |
| `openrouterApiKey` | `CLAWS_OPENROUTER_API_KEY` | *(empty — required for the OpenCode backend)* |
| `aiProviders` | `CLAWS_CLAUDE_ENABLED`, `CLAWS_CODEX_ENABLED`, `CLAWS_OPENCODE_ENABLED`, `CLAWS_CLAUDE_WEIGHT`, `CLAWS_CODEX_WEIGHT`, `CLAWS_OPENCODE_WEIGHT` | `{ claude: { enabled: true, weight: 4 }, codex: { enabled: true, weight: 2 }, opencode: { enabled: true, weight: 1 } }` (enabled providers are selected randomly per eligible task using positive finite weights; disabled, zero-weight, negative, `NaN`, or infinite weights are excluded with a warning). Existing `providerFallbackOrder` / `toolUseProviderFallbackOrder` are read only as migration inputs when `aiProviders` is absent: valid providers in the old array are treated as preference order for descending weights, and omitted providers remain enabled unless explicitly disabled by `aiProviders` or env. |
| `providerRateLimitCooldownMs` | `CLAWS_PROVIDER_RATE_LIMIT_COOLDOWN_MS` | `300000` (5 min — fixed cooldown a provider is skipped for after a classified rate-limit error, applied by provider reselection in `claude.ts`; not the actual reset time parsed from the error text). A cooldown already in effect ends early on a successful web re-auth for that provider on `/reauth`, or when an operator clicks "Clear cooldown" in that page's Provider cooldowns section — both assume the rate-limited credential has been replaced or the limit has reset, so Claws tries the provider again on the next dispatch |
| `codexDefaultModel` | `CLAWS_CODEX_DEFAULT_MODEL` | `"gpt-5.5"` (Codex opus-tier and deep-planning default). Non-empty Codex IDs are validated against `codex debug models` when available; stale non-mini aliases are repaired to `gpt-5.5`, stale mini/cheap aliases are repaired to `gpt-5.6-luna`, and repairs emit a `[model-selector]` warning |
| `codexLightModel` | `CLAWS_CODEX_LIGHT_MODEL` | `"gpt-5.6-terra"` (balanced everyday Codex model for sonnet-tier tasks; set to `""` for the Codex CLI account-supported default) |
| `codexCheapModel` | `CLAWS_CODEX_CHEAP_MODEL` | `"gpt-5.6-luna"` (fast, affordable Codex model for cheap-tier tasks; set to `""` for the Codex CLI account-supported default) |
| `claudeCheapModel` | `CLAWS_CLAUDE_CHEAP_MODEL` | `"claude-haiku-4-5-20251001"` (the haiku tier for Claude; `""` falls back to the `haiku` CLI alias) |
| `claudeFableModel` | `CLAWS_CLAUDE_FABLE_MODEL` | `"fable"` — the Claude CLI *alias*, not a pinned ID, so the fable tier tracks the newest model in it with no code change; `""` falls back to the same alias |
| `codexFableModel` | `CLAWS_CODEX_FABLE_MODEL` | defaults to whatever `codexDefaultModel` resolves to (`"gpt-5.5"` out of the box). Same stale-alias repair and `codex debug models` validation as the other Codex keys |
| `opencodeFableModel` | `CLAWS_OPENCODE_FABLE_MODEL` | defaults to whatever `opencodeBestModel` resolves to (`"openrouter/anthropic/claude-opus-4"` out of the box); same `openrouter/` prefix requirement as the other `opencode*Model` keys |
| `opencodeBestModel` / `opencodeAdequateModel` / `opencodeCheapModel` | `CLAWS_OPENCODE_BEST_MODEL` / `CLAWS_OPENCODE_ADEQUATE_MODEL` / `CLAWS_OPENCODE_CHEAP_MODEL` | `"openrouter/anthropic/claude-opus-4"` / `"openrouter/anthropic/claude-sonnet-4.5"` / `"openrouter/google/gemini-2.5-flash"` — opencode routes through OpenRouter, so model IDs must carry the `openrouter/` prefix and match opencode's own model registry (dots not hyphens, e.g. `claude-sonnet-4.5`), not the raw Anthropic/OpenRouter catalog names (#905, #907) |
| `improvementIdentifierModel` | `CLAWS_IMPROVEMENT_IDENTIFIER_MODEL` | `"openrouter/z-ai/glm-5.3"` (OpenRouter model ID used for improvement-identifier's whole-repo analysis phase via OpenCode; same `openrouter/` prefix requirement as the `opencode*Model` keys above) |
| `ollamaBaseUrl` | `CLAWS_OLLAMA_BASE_URL` | Local Ollama instance used by `ollama-rate-limit-classifier.ts` to classify Claude/Codex/OpenCode usage-limit errors, with a regex fallback when Ollama is unreachable |
| `ollamaTimeoutMs` | `CLAWS_OLLAMA_TIMEOUT_MS` | `60000` (1 min — generous to tolerate a cold-started local Ollama) |
| `ollamaConsecutiveFailuresBeforeDisable` | `CLAWS_OLLAMA_CONSECUTIVE_FAILURES_BEFORE_DISABLE` | `3` (consecutive Ollama failures before a 5-minute circuit breaker falls back to regex-only classification) |
| `whisperBaseUrl` / `whisperLocalUrl` | `CLAWS_WHISPER_BASE_URL` / `CLAWS_WHISPER_LOCAL_URL` | Self-hosted faster-whisper transcription server endpoints — see [Voice-note transcription](whatsapp-setup.md#step-2--voice-note-transcription-on-by-default) |
| `whisperModel` | `CLAWS_WHISPER_MODEL` | `"Systran/faster-whisper-base"` |
| `bindHost` | `CLAWS_BIND_HOST` | `"0.0.0.0"` |
| `activationState` | `CLAWS_ACTIVATION_STATE` | `"active"` (use `"verify-only"` for the dashboard and its `/config` connectivity checks with no jobs, or `"staging"` for only the `Claws Staging` issue/PR pipeline — see [Kubernetes Deployment](OVERVIEW.md#kubernetes-deployment) in OVERVIEW.md) |
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
| `disabledJobsByRepo` | — | `{}` (map of repo full name → array of job names to disable for that repo) **Operator override** — unioned with each repo's `claws.json`; see [repo-config.md](repo-config.md). Pruned on every `/jobs` Save: entries for unmonitored repos, job names that are neither a matrix column nor a registered job, and jobs the repo's own `claws.json` already locks (#2936). |
| `prodAlertWorkflows` | — | `{"St-John-Software/production-infra": ["Tofu Apply", "Flux Bootstrap"]}` (map of repo full name → workflow names whose default-branch failure also pages `slackProdAlertsWebhook`; deliberately non-empty so paging survives deleting the repo's own `notify-failures.yml`) **Operator override** — unioned with each repo's `claws.json`; see [repo-config.md](repo-config.md). |
| `mainBuildMonitorIgnoreWorkflows` | — | `{}` (map of repo full name → workflow names `main-build-monitor` must never file issues for) **Operator override** — unioned with each repo's `claws.json`; see [repo-config.md](repo-config.md). |
| `disabledAgents` | — | `[]` (agent names to disable: `planner`, `implementer`, `ci-fixer`, `review-addresser`, `reviewer`, `merger`, `empty-pr-closer`, `superseded-pr-closer`) |
| `skippedItems` | — | `[]` (array of `{repo, number}` excluded from processing; `number` is an issue *reference* — a forge number, or a Claws-native `clw_…` id) **Stays on the host** (#2898): per-item operator state, mutated live by the dashboard and MCP — a PR round-trip per skip is the wrong loop. |
| `prioritizedItems` | — | `[]` (array of `{repo, number}` processed first; `number` is an issue reference, as for `skippedItems`) **Stays on the host** (#2898): per-item operator state, mutated live by the dashboard and MCP. |
| `itemTimeoutOverrides` | — | `[]` (array of `{repo, number, timeoutMs}` — auto-managed by timeout escalation; `number` is an issue reference, as for `skippedItems`) **Stays on the host** (#2898): per-item, and auto-written by timeout escalation at runtime. |
| `homeAssistantBaseUrl` | `CLAWS_HOME_ASSISTANT_BASE_URL` | *(empty — HA REST API integration disabled)* |
| `homeAssistantToken` | `CLAWS_HOME_ASSISTANT_TOKEN` | *(empty — required when homeAssistantBaseUrl is set)* |
| `homeAssistantConfigRepo` | — | *(empty — e.g. `St-John-Software/home-assistant-config`)* **Stays on the host** (#2898): a role assignment read at server start, before discovery has populated the `claws.json` cache — and `selfRepo` gates discovery itself, so a repo-side `role` would be unreadable at the moment it is needed. |
| `homeAssistantUpgraderEnabled` | `CLAWS_HOME_ASSISTANT_UPGRADER_ENABLED` | Defaults to whether HA is configured (`homeAssistantBaseUrl` + `homeAssistantToken` both set); set `false` to disable the `ha-upgrader` job without unconfiguring HA |
| `homeAssistantUpgraderExcludePatterns` | `CLAWS_HOME_ASSISTANT_UPGRADER_EXCLUDE_PATTERNS` | `[]` (comma-separated in env; entity IDs/patterns `ha-upgrader` should never install updates for) |
| `homeAssistantDeployWatcherEnabled` | `CLAWS_HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-deploy-watcher` job |
| `homeAssistantAreaReconcilerEnabled` | `CLAWS_HOME_ASSISTANT_AREA_RECONCILER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-area-reconciler` job (which enforces `registry/areas.yaml` in `homeAssistantConfigRepo` against the live entity registry) |
| `homeAssistantEnergyReconcilerEnabled` | `CLAWS_HOME_ASSISTANT_ENERGY_RECONCILER_ENABLED` | Defaults to whether HA is configured; set `false` to disable the `ha-energy-reconciler` job (which enforces `registry/energy.yaml` in `homeAssistantConfigRepo` against the live Energy dashboard prefs) |
| `homeAssistantGitPullAddonSlug` | `CLAWS_HOME_ASSISTANT_GIT_PULL_ADDON_SLUG` | `"core_git_pull"` (HA Supervisor addon slug `ha-deploy-watcher` polls for `Updating <old>..<new>` log lines) |
| `allowedActors` | — | `["stjohnb"]` (issue authors whose issues are dispatched into the refine/implement pipeline; see [Content-Based State Machine](#content-based-state-machine)) |
| `dependabotIgnoredAdvisories` | — | `{}` (map of repo full name, or `"*"` for all repos, → array of `GHSA-...` IDs to suppress before filing the `dependabot-alert-monitor` alert issue) **Operator override** — unioned with each repo's `claws.json`; see [repo-config.md](repo-config.md). The `"*"` global list has no repo-side home and stays here. |
| `notifyDashboardActions` | — | `true` (send Slack notifications for configuration, activation and pairing mutations; issue operations never notify) |
| `dependabotAutoDismissStale` | — | `true` (auto-dismiss Dependabot alerts whose patched version is already present in the dependency-graph SBOM; set to `false` to disable) |
| `dependabotAutoRemediate` | `CLAWS_DEPENDABOT_AUTO_REMEDIATE` | `true` (apply `Claws Auto-Refine` and `Automerge` to a Dependabot alert issue whose alerts are all routine, so the plan auto-refines and the PR auto-merges; set to `false` to require a human `Refined`) |
| `fleetInfraRepo` | `CLAWS_FLEET_INFRA_REPO` | `St-John-Software/fleet-infra` (fallback repo for Home Assistant monitor alert issues when `homeAssistantConfigRepo` is unset) **Stays on the host** (#2898): a role assignment read at server start, before discovery has populated the `claws.json` cache — and `selfRepo` gates discovery itself, so a repo-side `role` would be unreadable at the moment it is needed. |
| `prodK8sKubeconfigPath` | `CLAWS_PROD_K8S_KUBECONFIG_PATH` | *(empty — uses default kubeconfig when empty; used by the `prod-infra` session capability. Kubernetes deployment should set `/home/claws/.kube/prod-config`, written from `CLAWS_PROD_KUBECONFIG` by the container entrypoint)* |
| `fleetKubeconfigPath` | `CLAWS_FLEET_KUBECONFIG_PATH` | `"~/.kube/config"` (kubeconfig path for fleet/k3s cluster; `~` is expanded to an absolute path via `resolveIdentityFile` at session-create time; granted to sessions with the `fleet-infra` capability; set to `""` to hide the capability from the sessions UI) |
| `ciFixerCircuitBreaker.maxAttempts` | — | `5` (max CI fix attempts per PR within window) |
| `ciFixerCircuitBreaker.windowMs` | — | `86400000` (24h window for attempt counting) |
| `ciFixerCircuitBreaker.maxConsecutiveFailures` | — | `3` (consecutive failures before tripping) |
| `ciFixerCircuitBreaker.maxConflictAttempts` | — | `3` (unproductive conflict-resolution attempts that actually reached the agent before leaving for manual resolution — attempts that failed before the agent ran, e.g. a provider outage, don't count, #2977) |
| `ciFixerCircuitBreaker.maxCommitGrants` | — | `3` (lifetime fresh-budget grants per PR for commits pushed after the breaker tripped) |
| `thirdPartyUpdateWindow` | — | `{ "enabled": true, "start": "22:00", "end": "07:00", "timezone": "Europe/London" }` (out-of-hours window for third-party update PRs — Renovate, Dependabot, or a `renovate/*`/`dependabot/*` branch. Outside it `pr-dispatcher` enqueues no work for them and `auto-merger` does not merge them; own-app `auto-bump` PRs are never deferred. `start > end` wraps midnight; times are evaluated in `timezone`, never host time. `dependabot-config-scanner` also alerts on update schedules outside it. An invalid `start`/`end` (not `HH:MM`) or `timezone` falls back to its default with a warning. `enabled: false` turns off both the gate and the scanner check; a repo opts out with `dependencyUpdateWindow: false` in its `claws.json`) |
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

## Interactive session backend

Where interactive sessions run (#3026) is set by env-only variables. None of
them has a `config.json` key, and all of them need a restart. Runbook and
fleet-infra dependencies:
[k8s-cutover.md § Cutover prerequisite](k8s-cutover.md#cutover-prerequisite-pod-per-session-interactive-sessions-3026).

| Env variable | Default |
|---|---|
| `CLAWS_SESSION_BACKEND` | `local-tmux`. Set `k8s-pod` for one Kubernetes Pod per session. Any other value fails config load. |
| `CLAWS_SESSION_NAMESPACE` | `claws-sessions` |
| `CLAWS_SESSION_IMAGE` | `ghcr.io/st-john-software/claws:<VERSION>`. Empty on a `dev` build (one not produced by `release.yml`, which passes the release tag as the `CLAWS_VERSION` build arg), where creating a pod session returns 503. |
| `CLAWS_SESSION_IMAGE_PULL_SECRETS` | `ghcr-pull` (comma-separated) |
| `CLAWS_SESSION_STORAGE_CLASS` | `local-path` |
| `CLAWS_SESSION_STORAGE_SIZE` | `20Gi` |
| `CLAWS_SESSION_NODE_SELECTOR` | *(empty)*; `k=v[,k=v]`, malformed entries fail config load |
| `CLAWS_SESSION_PRIORITY_CLASS` | *(empty)* |
| `CLAWS_SESSION_CPU_REQUEST` | `250m` |
| `CLAWS_SESSION_MEMORY_REQUEST` | `1Gi` |
| `CLAWS_SESSION_MEMORY_LIMIT` | `6Gi` |
| `CLAWS_SESSION_CLAUDE_THEME` | `auto`. Claude Code `theme` written to a new Claude pod session's `~/.claude/settings.json` when it has none, so the first-run wizard is skipped (#3131). A theme changed inside a session is kept on resume. |
| `CLAWS_SESSION_MCP_URL` | *(empty)*. The Claws base URL as session pods reach it, e.g. `http://claws.default.svc.cluster.local:3000`; a trailing `/` is stripped. When set, Kubernetes agent pods get the `claws-state` MCP server at `<url>/mcp/sessions/<id>`, authenticated by a per-session token, and every session pod reports its process's exit code and last output to `<url>/session-pods/<id>/exit` (#3311). Empty means they get neither. |
| `CLAWS_SESSION_AUTO_COMPACT_IDLE_MINUTES` | `30`. Minutes a Claude session whose last turn used at least 100k context tokens sits idle before Claws types `/compact` into it (#3090), on both backends. `0` disables; an invalid value warns and uses `30`. |

Selection is explicit opt-in: `KUBERNETES_SERVICE_HOST` is never consulted, so
a container with the variable unset still runs `local-tmux`. The `/config` connectivity checks'
`session-backend` row FAILs that combination, because every rollout kills
those sessions. New sessions use the image of the Claws version that created
them; running pods keep theirs.

On `k8s-pod`, four extra capabilities appear on the create form: `claude-auth`,
`codex-auth`, `openrouter-auth` and `github-auth`. Each copies one of the
service's own credentials into that session's pod: `CLAUDE_CODE_OAUTH_TOKEN`,
the Codex `auth.json` (`$CODEX_HOME`, else `~/.codex`), `OPENROUTER_API_KEY`,
or a GitHub App installation token. Each is available only when its source
credential exists, or for `github-auth` when a GitHub App is configured. The
chosen agent's login is pre-ticked, and `github-auth` is pre-ticked for a
GitHub-hosted repo and can also be granted to a running session (#3131). They own no env
keys and do not exist on `local-tmux`, so local sessions' strip lists are
unchanged.

The create-form checkboxes and the live-grant dropdown group capabilities into
labelled sections in a fixed order — Agent logins, Forge access,
Infrastructure, SSH hosts, Tools (#3138). This is presentation only: it does
not change what is granted, validated or pre-ticked.

## Headless work backend

Where claimed work-queue rows run (#clw_01M34R5RECDPPXVXBJZS1DA6C1) is set by
env-only variables. None of them has a `config.json` key, and all of them need
a restart.

| Env variable | Default |
|---|---|
| `CLAWS_WORK_BACKEND` | `in-process`: each row runs in a worker fiber of the service, so a service restart interrupts it and the next boot re-queues it. Set `k8s-pod` to run each row in its own pod, `claws-agent-<rowId>`, which a restart leaves running; the pod holds no database credentials and records everything through the service's agent-pod ops API. Any other value fails config load, and so does `k8s-pod` with no image (a `dev` build without `CLAWS_SESSION_IMAGE`) or no `CLAWS_SESSION_MCP_URL`. |
| `CLAWS_AGENT_POD_CPU_REQUEST` | `500m` |
| `CLAWS_AGENT_POD_MEMORY_REQUEST` | `2Gi` |
| `CLAWS_AGENT_POD_MEMORY_LIMIT` | `6Gi`. On `k8s-pod` this per-pod limit is the run's memory bound. The pod's own in-pod watchdog cap is derived from this limit minus a 2 GiB margin (floor 2 GiB) — `agentPodWatchdogCapBytes()` in `agent-memory-budget.ts` — and set as `CLAWS_AGENT_WORKER_MEMORY_MAX_BYTES` in the pod's own env; the service's `agentWorkerMemory*` settings do not reach pods. |
| `CLAWS_AGENT_POD_EPHEMERAL_STORAGE_LIMIT` | `24Gi` |
| `CLAWS_AGENT_POD_HOME_SIZE` | `20Gi`. `sizeLimit` of the pod's `emptyDir` HOME; a run's clone and caches go when the pod ends. |

Agent pods reuse the [session backend](#interactive-session-backend)'s
namespace, image, pull secrets, node selector and priority class
(`CLAWS_SESSION_NAMESPACE`, `CLAWS_SESSION_IMAGE`, …). Inside the pod,
`CLAWS_SESSION_MCP_URL` is the base URL the `claws-state` MCP server and the
agent-pod ops API client (`db-remote.ts`) use to reach the service; neither
`CLAWS_DATABASE_URL` nor `CLAWS_DATABASE_PASSWORD` is copied into the pod. It authenticates with the pod's own token from the
`mcp-token` key of its Secret, not the service's per-boot internal token, and
the service accepts it while the row is running, across service restarts.
Claude memories a run writes in the pod's HOME are not backed up. Scheduler
jobs that spawn agents themselves stay in-process on both settings.
The `/config` connectivity checks' `work-backend` row FAILs `in-process` inside
a container, and checks the image, `CLAWS_SESSION_MCP_URL` and the Pod/Secret
RBAC on `k8s-pod`. See `docs/k8s-cutover.md` for the pod's objects and lifecycle.

## Database backend

Claws runs on SQLite or PostgreSQL from the same schema, selected by two
env-only variables. Neither has a `config.json` key: the password must never be
written to disk or rendered on the config page, and both are pod environment on
the Kubernetes deployment. Both are in `SENSITIVE_ENV_KEYS`, so neither reaches
an agent or interactive session.

| Env variable | Default |
|---|---|
| `CLAWS_DATABASE_URL` | *(empty — SQLite at `~/.claws/claws.db`)* |
| `CLAWS_DATABASE_PASSWORD` | *(empty — supply out-of-band when the URL carries no password)* |

Set `CLAWS_DATABASE_URL` and Claws connects to Postgres instead: pool of 10
connections, 30 s idle timeout, 10 s connect timeout. The **first** connection
is retried with backoff for about 63 s (1 s→32 s, six attempts), because k3s
admits a new pod's IP to the NetworkPolicy roughly a second after the pod
starts and the first connect is expected to be refused. The chosen backend is
logged at startup and named in the `/config` connectivity checks as host/database (`PostgreSQL (host:port/dbname)`) — never the URL, which carries the password. `CLAWS_DATABASE_PASSWORD` is merged into the URL before the
pool is built and takes precedence over any password the URL already carries;
passing it to `pg` as a separate option cannot work, because `pg` overwrites
it with the empty password parsed out of the URL (#2974).

The MCP server is a separate process that reads the database directly, so
`writeClawsMcpConfig()` forwards both variables into its environment when they
are set; without them a Postgres-backed pod's MCP child would look for a
`claws.db` that does not exist.

Selection keys on the variables, never on `isContainer()` — a container without
`CLAWS_DATABASE_URL` still runs on its own SQLite file. `CLAWS_TEST_PGLITE=1`
selects the in-process PGlite backend and is for the test lane only.

### Shared browser service

| Env variable | Default |
|---|---|
| `CLAWS_BROWSER_CDP_ENDPOINT` | *(empty — every Playwright MCP server launches a local headless Chromium)* |

A `ws://` or `wss://` URL for the shared in-cluster browserless service
(fleet-infra#1383), with the browserless token in its query string. It is
env-only (no `config.json` key) and in `SENSITIVE_ENV_KEYS`, so strict-mode
agents never inherit it. A value that is not a `ws://`/`wss://` URL is ignored
with a warning that does not echo it.

When set, every Playwright MCP server Claws builds connects to that endpoint
instead of spawning Chromium (#3102): `local-tmux` and `k8s-pod` `browser`
sessions and the `shopping-sourcer` job. The URL reaches `@playwright/mcp` as
`PLAYWRIGHT_MCP_CDP_ENDPOINT` — in the 0600 MCP config's server `env` on the
host, or in the sourced-then-deleted session env file in a session pod — and
never on argv, in a Pod spec or in a log line. On this path there is no
`--headless` and no `--user-data-dir` profile, and shopping-sourcer runs under
the ordinary `agentWorkerMemoryMaxBytes` cap. Before its browser run,
shopping-sourcer probes the service's `/pressure` endpoint and waits 30 s, 60 s
and 120 s while the queue is full, then records a sourcing error. The `/config` connectivity checks'
`browser-service` row reports whether the endpoint is configured and, when it
is, its running and queued counts (host, port and path only).

### Provider parity

Codex runs are not identical to Claude runs. `runClaude` invokes
`codex exec --json`, so the agent's answer is the final `agent_message` event
rather than the human transcript, and the `turn.completed` usage event is
recorded via `onTokensUsed` — but Codex reports no price, so the cost column on
`/usage` is **0** for every Codex run while the token counts are real.
`/usage` can be filtered by repo, job, provider and model via query params.
By default Claws omits `-m` for Codex and lets the CLI choose the authenticated
account's supported default. If a Codex model key is set, Claws validates it
against `codex debug models` when that catalogue is available, repairs stale
aliases onto the shipped Codex family, follows visible upgrade mappings, and
falls back to the CLI default for hidden IDs.
Automated Codex runs receive MCP tools through a private per-run `CODEX_HOME`
whose `config.toml` is generated from `mcpConfig`, with MCP env values kept out
of argv. Codex has no `--append-system-prompt`, so the
repo's `.agents/<role>.md` document is inlined into the prompt inside an
`<agent-role>` block. The repo's own instructions are inlined the same way
inside `<repository-instructions>`, read from `AGENTS.md` — the repo's only root
instructions file, with no `CLAUDE.md` fallback (#3224) — capped at 32 KiB.

Automated OpenCode runs receive MCP tools through `OPENCODE_CONFIG_CONTENT`,
merged with the full-permission config Claws already supplies. Interactive
Codex/OpenCode local sessions also receive the read-only `claws-state`
diagnostics server by default. On `k8s-pod`, Codex CLI `0.154.0` was verified
to support remote MCP through `url` plus `bearer_token_env_var`; Claws writes
the per-session endpoint to `~/.codex/config.toml` and puts only the
session-scoped `CLAWS_SESSION_MCP_TOKEN` in `session.env`. OpenCode `1.18.31`
was verified to support remote MCP through `type: "remote"`, `url`, and
`headers`; Claws writes the per-session bearer header into the 0600
session-owned OpenCode config. Neither path injects service database
credentials or `INTERNAL_MCP_TOKEN` into the pod.

Interactive sessions differ too. Plain Claude sessions run with a Claws-owned
`--mcp-config --strict-mcp-config`, so ambient user-level MCP/plugins are
ignored and the built-in `claws-state` server is present. Claude sessions with
the `browser` capability deliberately switch to a Playwright-only config and do
not also expose `claws-state`. With `CLAWS_BROWSER_CDP_ENDPOINT` set, that
Playwright server uses the shared browser service: the per-session
`browser-profile` directory is dropped, so browser login state does not persist
between sessions (the service gives each connection a fresh browser). Codex
sessions run inside a per-session `CODEX_HOME` seeded with minimal config, the
read-only `claws-state` MCP server, and `~/.codex/auth.json` when present, so
ambient `~/.codex/config.toml` plugins/MCP servers do not leak into Claws
sessions; that private config also carries Claws workflow/capability guidance
as Codex `developer_instructions`. The session-local config also sets
`check_for_update_on_startup = false`: the image's Codex install is
root-owned, so its self-update prompt can never succeed and used to crash
the session (#3312).

The Config page enables or disables each AI provider and sets its selection weight. Eligible unpinned agent runs choose randomly among enabled providers with positive finite weights. On an individual GitHub issue or PR, apply **Use Claude**, **Use Codex**, or **Use OpenCode** to pin that provider when it is eligible; conflicting provider labels are ignored and weighted selection is used. A label naming a disabled or non-positive-weight provider is ignored with an attribution note. Automated MCP-required prompts use the same provider-label and weighted-selection semantics because all automated backends receive `mcpConfig`.

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
`CLAWS_PROD_KUBECONFIG` is env-only and sensitive: the container entrypoint
writes it to `~/.kube/prod-config` mode 0600, unsets it before Node starts, and
expects `CLAWS_PROD_K8S_KUBECONFIG_PATH` to point at that file when
`prod-infra` access is enabled.

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

Forgejo repos are **discovered**, not listed: at each repo-cache refresh Claws
enumerates `GET /user/repos` as its bot account and automates every repo it can
write to (non-archived, not a pull mirror, non-empty, private or internal, not
bot-owned) against `forgejoBaseUrl`'s Gitea-compatible API. Each one's GitHub
twin — which stays in the App installation as a push mirror — is excluded from
GitHub discovery permanently. See [Forgejo repos](OVERVIEW.md#forgejo-repos)
for how routing works.

The set is discovered from the bot account's accessible repos, so onboarding a
Forgejo repo is an org `bots`-team grant plus a root `claws.json` — no edit to
this repo, no config edit, no restart. Repo mirroring to GitHub has been
decommissioned, so there is no longer a checked-in exclusion floor; a GitHub
copy of a migrated repo should be archived, and `fetchRepos()` already skips
archived repos. `CLAWS_FORGEJO_REPOS` remains as an emergency additive
override, and a name in it that the bot cannot see on Forgejo (404/403) is
logged once and skipped rather than filing a `[claws-error]` (#2921).

Discovery is not sufficient on its own: like every repo on either forge, a
Forgejo repo also needs a [`claws.json`](repo-config.md) at the root of its
default branch, or it is not monitored.

The token is used both for the API (`Authorization: token <tok>`) and for git
over HTTPS, where `buildEnvForGhGit` injects it via a second inline credential
helper keyed on the Forgejo host with username `oauth2`. It is never rendered
on the config page and never written inside a worktree. Without it, every
Forgejo call throws and the repo is skipped at discovery, so Claws degrades to
doing nothing on that repo rather than automating a stale mirror.

### The bot account (`clawsstjohn`)

Claws authenticates to `git.home.bstjohn.net` as the dedicated bot user
**`clawsstjohn`** (created 2026-08-28). As of 2026-09-10 it is a member of the
org-level `bots` team with write permission on all `St-John-Software` repos on
Forgejo — `perudo`, `bin-scraper`, `whyrr` and the `forgejo` fork — so newly
created repos are discovered automatically.

A dedicated bot account is **mandatory, not a convenience**. The token *is* the
account: whichever account holds it, every prompt-injectable agent that reaches
the token inherits that account's reach. On the owner's personal account that
means repo deletion, team membership and every org secret — far more than any
Claws flow needs — and #2672 already tracks unrevokable leftovers there, with
Forgejo token deletion being UI-only. A purpose-made bot in the `bots` team
carries only the write access the automation actually uses.

The 👍 gate on Claws' own suggestions (`isAllowedHumanActor` in
`src/forgejo.ts` and `src/github.ts`) now requires an `allowedActors` login
that is neither Claws' own account nor a bot on both forges (#3225 Forgejo,
#3232 GitHub), so a session holding the service token can no longer
thumbs-up a Claws suggestion into review-addresser work by itself.

Note this is *not* about `isAllowedActor`: that gate already returns true for
Claws' own login by design (#2650, so Claws' Forgejo comments are not read as
untrusted), and Claws' own comments are excluded from the instruction stream by
the `isClawsComment()` marker rather than by login — they never come back as a
human's instruction either way.

Separately, confirm the owner's *Forgejo* login is in `allowedActors` — actor
gating on these repos compares Forgejo logins, not GitHub ones. Today
`allowedActors` contains `brendan` (the Forgejo login) alongside `stjohnb` (the
GitHub login).

### The token

Name `claws-service`, scopes `write:repository,write:issue,read:user`. That is
the minimum: every Claws call is under `/repos/...` except
`forgejoSelfLogin()`'s `GET /user`, which needs `read:user` and which
`isAllowedActor` depends on. Store it as `forgejoToken`
in `~/.claws/config.json` (or export `CLAWS_FORGEJO_TOKEN`).

### The read/issue token (implicit cross-repo access)

The implicit `cross-repo` capability uses a separate Forgejo account/token for
agents that only need to inspect another managed repo or file a companion
issue there (#3152). Provision the account as a non-site-admin bot such as
`claws-reader`; do not put it in `allowedActors`. It should have repo code read
and issue write only, with token scopes `read:repository,write:issue,read:user`.
It must not have `write:repository`, `write:organization`, owner, admin or git
push access, and it must not be used as a git credential-helper token.

Store the token as `forgejoReadToken` or `CLAWS_FORGEJO_READ_TOKEN`. Sessions
and shell-capable headless runs receive it only under that env var name, plus
`CLAWS_FORGEJO_BASE_URL`; they never receive `CLAWS_FORGEJO_TOKEN`,
`CLAWS_FORGEJO_GIT_TOKEN` or `GIT_CONFIG_*` from this capability. Until it is
configured, GitHub cross-repo reads still work through `gh`, while Forgejo
cross-repo reads/issues fail closed instead of widening the push-capable
service token.

Claws resolves this account's own login from the token (`GET /user`, cached for
the process lifetime) and treats it as Claws' own login for issue/comment
authorship on Forgejo repos, exactly like the service account — so a companion
issue or comment an agent files with this token is dispatched and read as
trusted input, not skipped as an untrusted actor. It is never treated as a
human approver: the 👍 human-approval gate checks `allowedActors` membership
only, which this account must never have. The token's scopes must include
`read:user` for this lookup to succeed; without it `GET /user` returns
401/403, Claws logs one warning and keeps treating the account's issues and
comments as untrusted (fail closed) until the scope is fixed.

### The admin token (opt-in, Actions secrets)

**Why a second credential.** `clawsstjohn` has push, not admin
(`permissions.admin: false`). Forgejo's `reqOwner()` middleware answers
`GET/PUT /repos/St-John-Software/<repo>/actions/secrets[/{name}]` with 403
`user should be the owner of the repo`, and `GET /orgs/St-John-Software/actions/secrets`
with 403 `token does not have at least one of required scope(s): [read:organization]`.
Only an org-Owners member or a site admin can write Actions secrets/variables;
there is no narrower Forgejo role.

**Why not promote `clawsstjohn`.** Its token is implicit in every Forgejo
session and reaches headless agents through the git credential helper while
they process untrusted issue/PR content; as an owner, a prompt-injected agent
could delete repos, rewrite team membership or read every org secret.

**Why not a token on `brendan`.** It is the owner account, so its reach over
the org and its repos is far wider than any Claws flow needs. #2672 already
tracks unrevokable leftovers on that account and token deletion is UI-only.

**Provisioning — gitops (primary).** Migration `0034-claws-forgejo-accounts.sh`
in `St-John-Software/fleet-infra` (fleet-infra#1289) creates `claws-admin` (not
a site admin), adds it to the `St-John-Software` **Owners** team, mints a
`write:repository,write:organization` token and stores it in the Secret
`claws-forgejo-tokens` under key `admin-token` (with `clawsstjohn`'s token
under `service-token`). The claws StatefulSets inject them as
`CLAWS_FORGEJO_ADMIN_TOKEN` and `CLAWS_FORGEJO_TOKEN` via `secretKeyRef`, the
same shape as `CLAWS_DATABASE_PASSWORD`; `claws-config` is not involved. A
from-scratch cluster needs **no** hand step — the migration is the whole
provisioning path.

**Fallback — non-cluster host.** For a host running from
`~/.claws/config.json`, the same account and token can be made by hand:

```bash
kubectl exec -n default deploy/forgejo -- \
  forgejo admin user create --username claws-admin \
    --email claws-admin@home.bstjohn.net --password '<generated>' \
    --must-change-password false
# Then in the Forgejo web UI: add claws-admin to the St-John-Software "Owners" team.
kubectl exec -n default deploy/forgejo -- \
  forgejo admin user generate-access-token \
    -u claws-admin -t claws-admin \
    --scopes write:repository,write:organization --raw
```

`write:repository` is needed as well as `write:organization`: the repo secret
routes sit under the repository scope category. Then export
`CLAWS_FORGEJO_ADMIN_TOKEN` (preferred — the env var takes precedence) or set
`forgejoAdminToken` in `~/.claws/config.json`, and
`sudo systemctl restart claws.service` — safe for in-flight sessions because
the unit sets `KillMode=process`.

**Security invariants.** `claws-admin` must **not** be a site admin and must
**never** appear in `allowedActors`, so its comments and reviews can never
drive Claws. See the "tokens can only be revoked in the web UI" gotcha
below — the same applies to this token.

### Interactive sessions

The `cross-repo` capability is implicit for every session. It tells agents they
may read any Claws-managed repo and file companion issues when the task depends
on another repo's manifests, CI or conventions. For GitHub, sessions use the
authenticated `gh` CLI. For Forgejo, the capability grants only
`CLAWS_FORGEJO_READ_TOKEN` and `CLAWS_FORGEJO_BASE_URL` when
`forgejoReadToken` is configured.

Sessions are default-deny for secrets, but the `forgejo` capability
(`capabilities.ts`) is granted **automatically** to any session — single-repo,
multi-repo, or resumed — that includes a Forgejo-hosted repo (`isForgejoRepo`,
i.e. discovered on Forgejo, or named in `CLAWS_FORGEJO_REPOS`). It grants
`CLAWS_FORGEJO_TOKEN`, `CLAWS_FORGEJO_BASE_URL` and the `GIT_CONFIG_*`
credential-helper vars for the Forgejo host. On the session-create form it
renders as a checked, disabled checkbox — "auto: Forgejo-hosted repo" —
whenever the selected repo(s) force it, so an operator can see the grant
before creating the session; a disabled checkbox never posts, so the union in
`capabilities.ts` is what actually grants it. For a selection that doesn't
force it (no Forgejo-hosted repo picked), it's an ordinary opt-in checkbox
instead. It is silently absent when `forgejoToken` is unset, in which case the
session gets no half-working credential. Because the set is discovered, a
session created in the seconds between server start and the first discovery
pass does not get the capability; retry after a repo-cache refresh. Inside a
granted session, read and write issues/PRs/comments with
`curl -H "Authorization: token $CLAWS_FORGEJO_TOKEN" "$CLAWS_FORGEJO_BASE_URL/api/v1/..."`
— `gh` never works for these repos, since the GitHub twin is a stale mirror.

`forgejo-admin` is a normal opt-in capability — a create-form checkbox, off by
default, absent entirely when no admin token is configured. On the single-repo
form it is revealed by ticking "Show all capabilities" (it is deliberately
absent from `REPO_CAPABILITY_DEFAULTS`, because that map also pre-ticks), until
the operator has submitted it for a repo, after which it is remembered and pre-ticked
for that repo like any other capability; on the multi-repo form it is always listed. When granted, use it only for
`/actions/secrets` and `/actions/variables` paths and keep using
`CLAWS_FORGEJO_TOKEN` for issues, PRs, comments and git.

The Claws service itself also uses this token in-process, read-only, for the
Actions runner registry and waiting-jobs endpoints on behalf of
`mac-runner-waker` (#3099) — separately from, and not widened by, the opt-in
session capability above. Without `forgejoAdminToken` configured, Forgejo
repos that declare a `"macos"` runner are never woken and never get a
`mac-runner-offline` alert. The owner account's name must never appear in
anything Claws writes, whether from a session or from this in-process use.

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
repo is just: create/migrate the repo into the org, and commit a
[`claws.json`](repo-config.md) to the root of its default branch. No per-repo
permission step, no config edit and no restart — Claws discovers the repo
within one repo-cache TTL (5 minutes). The per-repo collaborator grants have
been migrated into that team, so there is one place granting Claws access.

The two steps that matter, in either arrangement, are: **grant the bot write
access** (read-only access is logged with a warning naming the repo and the
repo is skipped — Claws cannot open a PR without push), and **commit a
`claws.json`**.

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

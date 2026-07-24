# Home Assistant Integration — Setup Runbook

This document covers the manual HA-side steps that are prerequisites for the
Claws integration to function. The Claws-side code (REST wrapper, config keys,
agent context injection) ships with the code; this runbook is what a human must
do once before Claws can use it.

## What Claws can and cannot manage

**Can be GitOps'd (lives in `home-assistant-config` repo):**
- `automations.yaml` — automations authored in YAML
- `scripts.yaml` — scripts
- `scenes.yaml` — scenes
- `configuration.yaml` — core config, includes, templates
- Dashboard YAML (Lovelace in YAML mode)
- Custom templates and Jinja macros

**Cannot be GitOps'd (lives in `.storage/` and is UI-only):**
- Integration config entries created through the UI flow (e.g. Hue, Z-Wave,
  Google, cloud integrations) — these are stored in `.storage/` and are
  overwritten by HA itself, not by git-pull
- Device, entity, and area registries (`.storage/core.entity_registry`, etc.)
- Long-lived access tokens and user accounts (managed in HA Profile page)

For UI-only config, a human must use the HA UI. Claws can read and debug state
via the REST API but cannot change UI-managed integrations.

## Step 1: Create the GitHub repo

Create `St-John-Software/home-assistant-config` as a private repo. Add a
`.gitignore` that excludes secrets:

```
secrets.yaml
.storage/
*.db
*.db-shm
*.db-wal
```

Seed it with at minimum a `configuration.yaml` that includes:

```yaml
automation: !include automations.yaml
script: !include scripts.yaml
scene: !include scenes.yaml
```

Create empty `automations.yaml`, `scripts.yaml`, and `scenes.yaml` files.

## Step 2: Deploy key for git-pull addon

Generate a read-only deploy key for the repo:

```sh
ssh-keygen -t ed25519 -C "ha-git-pull" -f ~/.ssh/ha_git_pull -N ""
```

Add `~/.ssh/ha_git_pull.pub` as a **read-only** deploy key on the GitHub repo
(Settings → Deploy keys → Add deploy key).

## Step 3: Install the git-pull addon

On the HA VM, install `hassio-addons/addon-git-pull`:

1. Supervisor → Add-on Store → "⋮ Repositories" → add
   `https://github.com/hassio-addons/addon-git-pull`
2. Install "Git pull"
3. Configure:

```yaml
repository: git@github.com:St-John-Software/home-assistant-config.git
auto_restart: true
repeat:
  active: true
  interval: 300    # pull every 5 minutes
deployment_key: |
  -----BEGIN OPENSSH PRIVATE KEY-----
  <contents of ~/.ssh/ha_git_pull>
  -----END OPENSSH PRIVATE KEY-----
```

4. Start the addon and verify a successful pull in the addon logs.

> **Warning:** Once git-pull is active, any automation edited through the HA UI
> will be overwritten on the next pull. Always edit automations in the repo, not
> the UI, after this point. The only exception is integrations backed by
> `.storage/` (see above) — those are not touched by git-pull.

## Step 4: Convert existing UI-managed automations to YAML

For each automation currently managed via the UI:

1. Open the automation in the HA UI → YAML editor.
2. Copy the YAML block.
3. Paste into `automations.yaml` in the repo with a proper `id:` field.
4. Delete the automation from the UI after verifying the YAML version works.

Alternatively, export via the REST API:

```sh
curl -s -H "Authorization: Bearer $CLAWS_HOME_ASSISTANT_TOKEN" \
  https://homeassistant.home.bstjohn.net/api/config/automation/config \
  | jq .
```

## Step 5: Create a long-lived access token for Claws

1. Log in to HA as an admin account.
2. Go to **Profile** (bottom-left avatar) → **Long-Lived Access Tokens**.
3. Create a new token named `claws`.
4. Copy the token — it is only shown once.
5. The user that owns this token must be an HA Administrator (Settings → People → user → Administrator toggle). This is **necessary but not always sufficient** — HA also enforces per-addon access in some versions, and Supervisor-side permissions can go stale after role changes. See the Troubleshooting subsection below if `/api/hassio/...` returns 401 despite an admin user.

Store it in the Claws systemd EnvironmentFile (preferred for secrets, same
pattern as `OPENAI_API_KEY`):

```sh
# In /etc/systemd/system/claws.service or the EnvironmentFile it references:
CLAWS_HOME_ASSISTANT_TOKEN=<the token>
CLAWS_HOME_ASSISTANT_BASE_URL=https://homeassistant.home.bstjohn.net
```

Alternatively, add to `~/.claws/config.json`:

```json
{
  "homeAssistantToken": "<the token>",
  "homeAssistantBaseUrl": "https://homeassistant.home.bstjohn.net"
}
```

> **Security note:** `homeAssistantToken` is in `SENSITIVE_KEYS` — the Claws
> dashboard masks it. Never commit it to any repo or echo it in shell output.
> The LLAT grants full HA API access including service calls (lights, locks,
> etc.).

## Step 6: Configure the config repo (optional)

If you want Claws to mention the repo name in agent context, set:

```sh
CLAWS_HOME_ASSISTANT_CONFIG_REPO=St-John-Software/home-assistant-config
```

Or in `~/.claws/config.json`:

```json
{
  "homeAssistantConfigRepo": "St-John-Software/home-assistant-config"
}
```

Omitting this is fine — the agent context defaults to the expected repo name.
Do not set the default until the repo actually exists, to avoid Claws trying to
query a 404 repo during its periodic job iterations.

## Verifying the integration

After configuring the token and URL, test from the Claws host:

```sh
# List all entity states
curl -s -H "Authorization: Bearer $CLAWS_HOME_ASSISTANT_TOKEN" \
  $CLAWS_HOME_ASSISTANT_BASE_URL/api/states | jq '.[0]'

# Check a specific entity
curl -s -H "Authorization: Bearer $CLAWS_HOME_ASSISTANT_TOKEN" \
  $CLAWS_HOME_ASSISTANT_BASE_URL/api/states/sun.sun | jq .

# Check the error log
curl -s -H "Authorization: Bearer $CLAWS_HOME_ASSISTANT_TOKEN" \
  $CLAWS_HOME_ASSISTANT_BASE_URL/api/error_log
```

Restart Claws after updating the config and verify the HA integration is shown
as configured in the dashboard.

## MCP tools for Claude sessions

When `CLAWS_HOME_ASSISTANT_BASE_URL` and `CLAWS_HOME_ASSISTANT_TOKEN` are configured, two tools register on the `claws-state` MCP server — but only for a Claude session working on the `homeAssistantConfigRepo` (checked via `isHomeAssistantConfigRepo(fullName)` in `src/home-assistant.ts`). Every other fleet agent call site now defaults `includeHomeAssistant` to `false` (#2064 — `ha_api_request` can invoke arbitrary HA services, so it is scoped to agents actually working on the HA config repo rather than wired into every session):

- **`ha_list_entities`** — lists entity IDs, current state, and friendly name. Supports optional `domain` (e.g. `"light"`) and `search` (substring) filters. Returns a projected, capped list (max 500 entities) to avoid token bloat. For full attributes of a single entity, use `ha_api_request` with `/api/states/{entity_id}`.
- **`ha_api_request`** — generic GET/POST passthrough to any HA REST endpoint. Handles Bearer auth and truncates responses at 50k chars. Useful for `/api/states/{entity_id}`, `/api/services`, `/api/config`, `/api/template` (POST to render Jinja), `/api/history/...`, `/api/logbook/...`, `/api/error_log`, and service calls via `POST /api/services/{domain}/{service}`.

`ha_api_request` grants full read/write API access, including service calls (lights, locks, etc.) — the same authority as the long-lived access token used by curl. The token is never included in tool output.

## Automated upgrades (ha-upgrader job)

Claws runs the `ha-upgrader` job every 24h (configurable via
`intervals.haUpgraderMs`). It calls the HA REST API to list pending
updates and:

- **Auto-installs Core/Supervisor/OS** updates (one per run, in priority order:
  supervisor → core → OS) with a pre-install backup when the entity advertises
  backup capability (`supported_features & 8`). A **48-hour minimum availability
  window** must elapse before installation — so hotfix releases (e.g. `2024.2.1`
  shortly after `2024.2.0`) have time to land before automation kicks in.
- **Auto-installs device/integration firmware** updates (e.g. Z-Wave, Zigbee,
  HACS) where `state == "on"` and `auto_update != true`, capped at 5 per run,
  after a **24-hour minimum availability window**.
- **Raises a GitHub issue** in `homeAssistantConfigRepo` (or `fleetInfraRepo` as
  fallback) for any entity matching `homeAssistantUpgraderExcludePatterns` —
  these are never auto-installed.

**Availability windows are persisted** to `~/.claws/claws.db` in the
`ha_upgrader_state` table, so dwell timers survive Claws restarts. First-seen
is recorded on the first run after a new version appears; the timer resets
automatically when a newer version supersedes it.

To exclude additional entities from auto-install, add regex strings to
`homeAssistantUpgraderExcludePatterns` in `~/.claws/config.json` — user-exclude
takes precedence over the Core/Supervisor/OS auto-install path; matching
entities still raise a GitHub issue instead.

To disable the job entirely, set `homeAssistantUpgraderEnabled: false`.

Failed installs are retried up to 3 times (across runs); on the third failure
Claws raises a GitHub issue with details.

> **Risk note:** Core, Supervisor, and OS updates are now applied automatically
> once they have been available for 48 hours. When the entity supports it, a
> pre-install backup is taken via the HA `update.install` service's `backup: true`
> flag before each installation. Device firmware updates (Z-Wave, Zigbee, etc.)
> are applied after 24 hours, capped at 5 per run, and always serialised (never
> concurrent). To gate a specific problematic release, add its entity_id or
> version pattern to `homeAssistantUpgraderExcludePatterns` — it will be raised
> as an issue requiring manual review instead of being auto-installed.

## Deployment notifications (ha-deploy-watcher job)

Claws runs the `ha-deploy-watcher` job every 5 minutes (configurable via
`intervals.haDeployWatcherMs`). It polls the git-pull addon's log via the
HA Supervisor API (`/api/hassio/addons/<slug>/logs`) and scans for `Updating
<old>..<new>` lines that indicate a new commit was pulled from the
`home-assistant-config` repo and applied to the local filesystem.

When a new deploy is detected, Claws posts a Slack notification containing:
- A commit-subject list between the old and new SHA (via `listCompareCommits`;
  falls back to "commit list unavailable — see compare link" if the GitHub API
  call fails)
- A GitHub compare link
- The git diffstat block from the pull output
- If the git-pull addon log includes a config-check error or warning for that
  deploy, an additional block quoting it — the message header icon and text
  also change (`:rocket:` deployed / `:warning:` deployed with warnings /
  `:x:` deploy failed) depending on whether a config-check error or warning
  was detected

**First run is silent.** On the very first poll after enabling the job, Claws
records the latest observed SHA as a baseline without sending a notification.
This prevents a blast of historical deploy events from the existing log buffer.

**State is persisted** to `~/.claws/claws.db` in the `ha_deploy_watcher_state`
table (keyed by addon slug), so the baseline and last-notified SHA survive
Claws restarts.

**Configurable fields:**

- `homeAssistantDeployWatcherEnabled` (default: `true` when HA is configured) —
  set to `false` to disable.
- `homeAssistantGitPullAddonSlug` (default: `core_git_pull`) — the addon slug
  as shown in the HA UI URL. Override via env `CLAWS_HOME_ASSISTANT_GIT_PULL_ADDON_SLUG`
  or the config field if your addon uses a different slug.
- `intervals.haDeployWatcherMs` (default: `300000`, 5 min) — poll interval.
  Do not set below 5 minutes; the git-pull addon itself pulls every 5 minutes,
  so faster polling adds no benefit.

A 404 response from the addon logs endpoint is non-fatal — Claws logs a warning
and skips the cycle. This handles the case where the addon slug is wrong or the
addon is not installed.


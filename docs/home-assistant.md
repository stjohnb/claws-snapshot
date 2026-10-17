# Home Assistant Integration — Setup Runbook

**Deep dive.** Read this when you're setting up or debugging the Home
Assistant integration's manual HA-side steps (Matter Server, area/energy
reconcilers). For the Claws-side job behavior, see
OVERVIEW's Jobs table or the relevant `docs/jobs/*.md` instead.

Product requirements: [product/dashboard-and-integrations.md](product/dashboard-and-integrations.md)

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
- Energy dashboard sources and individual devices, via `registry/energy.yaml`,
  enforced by `ha-energy-reconciler`

**Cannot be GitOps'd (lives in `.storage/` and is UI-only):**
- Integration config entries created through the UI flow (e.g. Hue, Z-Wave,
  Google, cloud integrations) — these are stored in `.storage/` and are
  overwritten by HA itself, not by git-pull
- Device, entity, and area registries (`.storage/core.entity_registry`, etc.) —
  with one exception: entity **and device** area assignments listed in
  `registry/areas.yaml` are version-controlled and enforced by the
  `ha-area-reconciler` job (see
  [Entity area assignments](#entity-area-assignments-registryareasyaml) below)
- The Energy dashboard's preferences (`.storage/energy`) — same exception:
  `registry/energy.yaml` is version-controlled and enforced by the
  `ha-energy-reconciler` job (see
  [Energy dashboard configuration](#energy-dashboard-configuration-registryenergyyaml)
  below)
- Long-lived access tokens and user accounts (managed in HA Profile page)

For UI-only config, a human must use the HA UI. Claws can read and debug state
via the REST API but cannot change UI-managed integrations.
Claws does not monitor Home Assistant (see [Monitoring](#monitoring)).

## Entity area assignments (`registry/areas.yaml`)

Areas live in the gitignored entity registry and have no YAML equivalent —
helper, template and `utility_meter` definitions in `configuration.yaml` have no
`area:` field. So a restore from the repo recreates every YAML entity with a
blank area, and the registry's deleted-entity snapshots do not preserve
`area_id`, making lost assignments unrecoverable.

`registry/areas.yaml` in `home-assistant-config` closes that gap. Claws'
`ha-area-reconciler` job reads it every 30 minutes and reconciles the live
instance over the HA WebSocket API (`config/entity_registry/update` — the same
command the UI issues).

```yaml
---
entities:
  sensor.daily_house_energy: hall
  sensor.daily_office_energy: hall
```

Keys are entity ids, values are **area ids** (the slug, e.g. `hall`, not the
display name `Hall`).

- **Partial authority.** Only entities listed in the file are managed; every
  other entity is left alone. The manifest exists for device-less YAML entities
  (helpers, template sensors, utility meters). Device-backed entities (Shelly
  channels, ZHA, ESPHome) inherit their device's area and must **not** be listed
  — setting `area_id` on one pins a per-entity override that then diverges from
  the device if the device is ever moved.
- **Enforcing.** Changing a listed entity's area in the HA UI is reverted within
  30 minutes. To move an entity, change the manifest.
- **Typo guard.** An entity id that is not in the registry, or an area id that
  does not exist, raises a `Priority` alert issue in `home-assistant-config`
  listing the offenders (and the valid area ids). A newly merged entity is
  retried for a couple of minutes first, since `core_git_pull` polls every
  ≤5 minutes and HA may still need to restart. The issue auto-closes once the
  manifest matches.
- The job is a silent no-op while the file does not exist, and an HA outage
  produces a warning rather than an alert issue. Slack is notified only when an
  area was actually overwritten.
- **`devices:`** keys are canonical device keys (see `deviceKey()`), values are
  area ids. Device rows are enforced the same way entities are: a device moved
  in the HA UI is moved back within 30 minutes, over
  `config/device_registry/update`. Per-entity `area_id` overrides on that
  device's entities are untouched by a device-area write, which is why
  device-backed entities must not be listed under `entities:`.

## Energy dashboard configuration (`registry/energy.yaml`)

The Energy dashboard's preferences (sources, individual devices) live in
`.storage/energy` with no YAML schema of their own — there is nothing in
`configuration.yaml` to include. `registry/energy.yaml` in
`home-assistant-config` closes that gap the same way `registry/areas.yaml`
does for entity areas: Claws' `ha-energy-reconciler` job reads it every 30
minutes and reconciles the live instance over the HA WebSocket API
(`energy/get_prefs` → `energy/save_prefs`). The file's shape mirrors
`energy/get_prefs`'s result 1:1 — `energy_sources`, `device_consumption`,
`device_consumption_water`.

- **Full authority, not partial.** Unlike the area manifest, the whole prefs
  object is replaced on every save — there is no per-entry merge. Live-only
  entries (added through the HA UI) are never merged back in, so a UI edit is
  reverted within 30 minutes. To change the Energy dashboard, edit the
  manifest.
- **Empty-sources guard.** Saving an empty `energy_sources` would wipe the
  dashboard's grid configuration and cost-history view. If the file's
  `energy_sources` is empty while HA has configured sources, the job refuses
  to save and raises a `Priority` alert issue instead.
- A missing or unparseable file is a warn-level skip — Claws never alerts on a
  parse failure, since the config repo's own CI blocks a malformed file from
  reaching `main`.

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

## Monitoring

Home Assistant currently has no Claws monitoring, by operator decision
(2026-10-15). The deploy-watcher, deploy-stall, backup, battery, repairs and
bin-day monitors were removed (#clw_01M504VV1NB5YB9QNP4KAMQKK7) and nothing
replaces them for now; a window without monitoring is accepted. Replacement
monitoring (Prometheus/Grafana alerts in fleet-infra) is deferred to
#clw_01M5034BWAT7379RB9THG0KJCR. The area and energy reconcilers move into
home-assistant-config's deploy (#clw_01M504V87DDSKQFN9694J0H0SF).

## Matter Server (Thread network)

Since add-on 9.x, the Home Assistant Matter Server add-on is built from
[`matter-js/matterjs-server`](https://github.com/matter-js/matterjs-server)
(matter.js) — **not** `home-assistant-libs/python-matter-server`, whose last
release (8.1.2) predates the switch. File Matter/Thread upstream bugs against
matter.js, not python-matter-server.

- A Thread mesh topology graph already ships in the add-on's own dashboard:
  Settings → Add-ons → Matter Server → Open Web UI → Thread tab (needs
  >768px width). HA's native Matter map ("Show map" on the Matter integration
  page) arrived separately with Core 2026.9.0. Check both before building or
  planning any bespoke Thread-topology tooling in `home-assistant-config`.
- The config-entry diagnostics JSON (`/api/diagnostics/config_entry/<matter
  entry>`) carries exact 64-bit `extAddress` integers. Apparent rounding
  (trailing `000`) is a `jq`/JS number-precision artifact on the reader side,
  not a precision loss in HA's data — parse with a 64-bit-safe reader (e.g.
  Python's `json` module) if exactness matters.

## Owner requirements

Constraints the repo owner stated directly for planning work on the HA config repo.

- **Planning agents need live HA access** (#1814): the HA config repo's planner had
  no way to query real entities during refinement, which is why the `ha_list_entities`
  / `ha_api_request` MCP tools above are registered for sessions working on
  `homeAssistantConfigRepo` — scoped to that repo only (#2064).

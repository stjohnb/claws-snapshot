# wall-explorer

**Deep dive.** Read this when you're changing the daily look at the office
wall dashboards, the screenshots it takes, or the issues it files.

**Source**: `src/jobs/wall-explorer.ts` (run, prompt, filing) and `src/wall-explorer.ts` (playlist, capture, agent browser config)
**Trigger**: Daily at 5 AM local time (`schedules.wallExplorerHour`), with `weekendPause`; a manual trigger on `/jobs` always runs
**Targets**: every dashboard in the home-Grafana playlist `Wall` (no per-repo toggle; pausing the job on `/jobs` turns it off)
**Tier**: the `wall-explorer` default tier (`opus` as shipped), editable on `/config` (#clw_01M7Q9Q20W7AQ7XT6C8RJBWWF4)

The dashpi office wall plays the `Wall` playlist all day, but nobody looks at it
closely, so a problem the wall shows plainly can go unnoticed when no alert
covers it. This job looks at it once a day the way a person at the wall would,
and files what it finds.

## Sign-in

Claws signs in to Grafana only as the Authentik service account
`claws-service`, a Grafana Viewer through its access list, with the Basic
header from `grafanaAuthorization()` (`src/grafana-auth.ts`). The same header
goes on every API read, on every Grafana-origin request of the capture browser
(through `context.route`, which aborts every other origin) and in the agent's
Playwright browser (`extraHTTPHeaders`). There is no other credential and no
fallback. See [observability-access.md](../observability-access.md).

- No credentials mounted, no `fleetGrafanaUrl`, or no `CLAWS_BROWSER_CDP_ENDPOINT`:
  the run ends `skipped-unconfigured` at `warn` and files nothing. It never
  launches a local Chromium.
- The first dashboard lands on an Authentik sign-in page (another host, a
  `/login` path or a password form): the run fails with `outcome: auth-redirect`
  through `reportError` and files nothing. The fix is the service account's
  access list, not a workaround here.

## Each run

1. **Playlist.** `GET /api/playlists`, the entry named `Wall`, then its items'
   `dashboard_by_uid` values. If Grafana fails, fleet-infra
   `migrations/grafana-wall-playlist.txt` (one uid per line, `#` comments). New
   walls are covered with no Claws change. Each dashboard's title, folder and
   panels come from `GET /api/dashboards/uid/<uid>`.
2. **Capture.** One dashboard at a time on the shared browserless service
   (`playwright-core` over CDP): browserless runs at most two sessions and kills
   one after five minutes, so each dashboard waits for capacity
   (`waitForBrowserCapacity`) and opens its own short session. Each renders at
   1920×1080, device pixel ratio 1, dark, at `/d/<uid>?kiosk&theme=dark` with the
   dashboard's own time range. After `networkidle` and no panel loading bar
   (capped at 60 s) plus 2 s, Claws takes the wall view, one crop per
   `[data-viz-panel-key]` panel, the panel's visible title, "No data" and error
   text, and a full-page screenshot when the page is taller than the wall.
   Everything goes in `scratch/wall-explorer/` with a `manifest.json`; the dir is
   emptied at the start of every run, so screenshots last only until the next
   run unless attached to an issue.
3. **Known state.** Home Grafana's managed alerts in every state but `Normal`
   (`/api/prometheus/grafana/api/v1/alerts`), prod Alertmanager's active alerts
   (`alertmanager-prod`, through `fetchActiveAlerts`), and every open Claws
   issue that could cover a wall finding (one naming fleet-infra or
   production-infra, holding a `wall-explorer-` key, or an alert issue) with
   its dedupe keys. An unreadable alert source is named in the prompt
   so the agent checks it live.
4. **Agent.** One headless Claude run (no provider fallback, 60-minute
   timeout, `Edit`/`Write`/`NotebookEdit`/`Task` denied) in the scratch dir,
   recorded as a `wall-explorer` task with its tokens. It gets:
   - the manifest and screenshots, which it reads first;
   - a Playwright MCP browser (`@playwright/mcp@0.0.85`, pinned, `--isolated`,
     restricted to the Grafana origin) to hover, open `viewPanel` or inspect a
     panel when it suspects something;
   - the planner Grafana grant (`fleet-observability`) to run a read-only query
     or read alerts live;
   - the alert lists and open issues to check findings against.

   The browser's config file holds the long-lived app password, so it is
   written with mode 0600 to the job's agent MCP dir (never a worktree) and
   deleted when the run ends. The agent replies with JSON findings; `browserOk:
   false` logs a `warn` and the run carries on from the screenshots.
5. **Filing.** Claws, not the agent, files each finding in order, as a native
   issue (source `automation`, not an alert issue). It is filed held and
   promoted to Planning once its screenshots are embedded, so planning never
   reads it without them; a failed screenshot edit logs a `warn` and the issue
   still counts as filed. Each finding goes through these steps:
   - Dedupe key `wall-explorer-<dashboard-uid>-<panel-id|dashboard>-<kind>`.
     Operational kinds: `no-data`, `error`, `threshold`, `trend`, `flatline`,
     `anomaly`. Presentation kinds: `title`, `legend`, `units`, `readability`,
     `layout`, `colour`, `misleading`, `unexplained`. A finding naming a
     dashboard or kind outside the manifest is dropped with a `warn`; a panel
     id the manifest lacks (a row, library or repeated panel) is filed as a
     dashboard-level finding with a `warn`.
   - An open issue with the key is left untouched (`already-filed`): a comment
     would re-plan it.
   - A key closed as not planned in the last 30 days, in any repo, is
     `dismissed`: the key already names the dashboard, panel and kind, so the
     repo the agent names that day does not matter.
   - At most 5 issues a run; the rest count as `over-cap`.
   - Repo: the agent's, for either category, when Claws manages it. Otherwise
     a presentation finding goes to fleet-infra, which owns the walls, and an
     operational one to production-infra for a dashboard in the `Prod` folder
     and fleet-infra for the rest.
   - The body gives the category and kind, the dashboard and a
     `?viewPanel=panel-<id>` link, the panel, what the wall shows, why nothing
     covers it (operational), the alerting gap and the suggested fix. The panel
     crop and the whole-dashboard screenshot are stored as issue attachments and
     embedded.

A clean day files nothing.

## Observability

Log component `wall-explorer`; the Authorization header is never logged.

- `info` `wall explorer started`.
- `debug` `wall dashboard captured` per dashboard, with `duration_ms`.
- `info` `wall explorer issue filed` per issue, with `issue`, `repo`, `dedupe_key`.
- `warn` `wall explorer finding dropped` (unknown dashboard or kind) and
  `wall explorer panel not in manifest` (filed at dashboard level), with
  `dashboard_uid`, `panel_id` and `kind`.
- `warn` `wall explorer screenshots not embedded` and `wall explorer issue not
  promoted`, with `issue`, when a filed issue's follow-up step fails.
- `info` `wall explorer finished` (`warn` when skipped) with `outcome`
  (`ok`, `skipped-unconfigured`, `auth-redirect`, `error`), `dashboards`,
  `panels`, `capture_errors`, `findings_filed`, the `suppressed_*` counts by
  reason, `over_cap` and `duration_ms`.

There is no metric or dashboard panel: a daily job is covered by these lines,
its `/jobs` task history, and `reportError("wall-explorer:run", …)` for an auth
redirect, an unreadable playlist and fallback, a run where every capture
failed, an agent failure or an unparseable reply. None of these files an issue.

## Cost

About 20 screenshots and 60 turns a day: roughly $3 a day on `opus` and $1.50
on `sonnet` at API rates.

## Risks

- A panel captured mid-load looks like "No data"; the settle wait and the
  prompt's instruction to re-check before reporting guard against it.
- Playwright `route` does not intercept websockets, so Grafana Live panels may
  not stream; wall panels query over HTTP.
- Renumbering a panel changes its dedupe key; the agent's check against open
  issue titles is the backstop.

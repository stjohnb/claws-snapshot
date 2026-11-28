# Observability access for agents

The `fleet-observability` session capability gives an agent read-only access to the home
(fleet) Grafana HTTP API (Prometheus and Loki datasource proxy, alerts, dashboards), and to the
same Grafana in the session's Playwright browser, signed in as Claws' Authentik service account
`claws-service`, a Grafana Viewer (#clw_01M7QFE3ZDE06M6JW202445NPX). The grant carries the full
`Authorization` header value as `CLAWS_FLEET_GRAFANA_AUTH`. Prod no longer needs its own
Grafana: home pulls prod metrics (`/federate`) and pod logs over the tailnet into fleet
Grafana's `prometheus-prod`, `loki-prod` and `alertmanager-prod` datasources
(#clw_01M7A7J69WPV7WHXW1EESEWQH1), and the capability's description names those three uids
and the `cluster="prod"` label prod series carry, so the one capability covers both clusters.
Claws files no alerts from this data; cluster alerting is owned by Prometheus/Grafana/Alertmanager.

The former `prod-observability` capability is retired as an alias of `fleet-observability`
(#clw_01M7Q9T4AQAGSG48Z3P7B273HR): a stored grant, remembered default or capability request
naming it resolves to `fleet-observability`. It sets only `CLAWS_FLEET_GRAFANA_URL` and
`CLAWS_FLEET_GRAFANA_AUTH`, and is unavailable while the `claws-service` credentials are not
mounted. The former JWT-valued `CLAWS_FLEET_GRAFANA_TOKEN` is retired with the Claws-signed
Grafana token (#clw_01M7QFE3ZDE06M6JW202445NPX); the name stays on the strip list.

The capability is auto-approve (#clw_01M77K5B15JHY1N6JMGRZDFQ0D): an agent's
`claws_request_capability` for it is granted at once, with no operator click, and both
the agent's "Requestable capabilities" prompt block and the tool's description tell it to
request it whenever it is diagnosing production or fleet behaviour, before guessing. The
operator can revoke it from the session page; that removes it from new shells only, so
a credential the agent already read stays valid until the `claws-service` app password is
rotated.

## How access works

Claws signs in to fleet Grafana as the blueprint-declared Authentik service account
`claws-service` (#clw_01M7QFE3ZDE06M6JW202445NPX). fleet-infra declares it, its one `grafana`
binding (Viewer through `grafana-role-scope-mapping`'s default branch) and its app password; the
convention and the list of every tool Claws reaches are in fleet-infra
[`docs/service-accounts.md`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/docs/service-accounts.md#claws-access)
and [`docs/authentik.md`](https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/docs/authentik.md#claws-service-account).

- **Credential.** A non-expiring app password, sent as HTTP Basic
  (`Authorization: Basic base64(claws-service:<password>)`). fleet-infra mounts Secret
  `claws-authentik-service-account` (keys `username`, `app-password`) read-only at
  `/etc/claws/authentik` and sets `CLAWS_AUTHENTIK_CREDENTIALS_DIR` to it. It is a file, not
  env, because agent pods inherit the Claws pod's env. `grafanaServiceAccount()` in
  `src/grafana-auth.ts` re-reads and trims both files on every call; `grafanaAuthorization()`
  returns that Basic header, or null when the variable is unset or either file is missing or
  empty. There is no other credential: without the mount Claws cannot sign in to Grafana.
  Claws never logs the header.
- **Sign-in path.** On `grafana.home.bstjohn.net` the request goes through Traefik's
  `authentik-auth-basic` middleware chain: client `X-authentik-*` headers are stripped, the
  Authentik outpost validates the Basic credential as an app password, then `Authorization` is
  stripped before Grafana, which trusts the `X-authentik-*` headers ForwardAuth adds. Grafana
  sees the login `claws-service` with `isGrafanaAdmin: false`.
- **Who uses it.** The `fleet-observability` grant (`CLAWS_FLEET_GRAFANA_AUTH`), headless
  planners (granted it via `PLANNER_CAPABILITIES`), the 15-minute sign-in probe and the
  `alertmanager-poller` job all send `grafanaAuthorization()`. The daily
  [`wall-explorer`](jobs/wall-explorer.md) job is a `claws-service` consumer too, through the API
  (playlist, dashboards, alerts) and in the browser: its capture browser adds the header to every
  Grafana-origin request and aborts every other origin, and its agent's Playwright browser gets it
  through `extraHTTPHeaders` from a 0600 config file deleted after each run. A planner on the `k8s-pod` work
  backend runs in an agent pod, which has no mount: the launcher copies `username` and
  `app-password` from the service's mount into that pod's launch spec (`~/.claws/authentik`)
  and points `CLAWS_AUTHENTIK_CREDENTIALS_DIR` there, for `issue-refiner:*` rows only. No other
  agent pod gets either file or the variable.
- **Browser.** In the session's Playwright browser the agent adds the same `Authorization`
  header to requests for the Grafana host only, never to another origin; that is the same
  header-on-every-request sign-in dashpi's Chromium kiosk uses.
- **Rotation.** One fleet-infra PR (`nix develop -c task secrets:share
  NAME=claws-service-app-password`) updates both Secret copies; the kubelet refreshes the mount
  and Claws picks up the new file within about a minute, with no adopt step and no restart. A
  session keeps the password it was granted, so after a rotation it loses Grafana until it is
  resumed or re-granted.
- **Alerting.** Every 15 minutes Claws calls `GET /api/user` on fleet Grafana (`GRAFANA_CLUSTERS`
  in `src/grafana-jwt.ts`) with `grafanaAuthorization()` and exports
  `claws_grafana_auth_ok{cluster="fleet"}` (see [metrics.md](metrics.md)). It is 1 only on 200
  with `isGrafanaAdmin: false` and `login` equal to the mounted username; with no credentials
  mounted (`authMode: unconfigured`) the probe sends nothing and fails with `unconfigured`. Fleet
  Grafana's rule `claws-grafana-auth-failing` ("Claws Grafana observability auth failing") files
  an alert issue after an hour at 0. The usual causes are the app password and Authentik
  disagreeing, the Authentik worker not having re-applied the blueprint, the `grafana` binding
  missing, the Grafana ingress no longer using `authentik-auth-basic`, or the
  `claws-authentik-service-account` mount missing. A failed probe logs a warn line (component
  `grafana-auth`) with `context.auth_mode`, `context.probe_reason` (`unconfigured`, `status`,
  `admin_user`, `wrong_user`, `timeout` or `fetch_error`), `context.http_status`, `context.probe_error` and
  `context.duration_ms`; a `timeout` means nothing answered (e.g. a firewall dropping the
  connection). Startup logs one `info` line (component `grafana-auth`) naming the auth mode.
- **The Alertmanager poller.** The `alertmanager-poller` job reads, once a minute for each repo
  with an `alertBridge.poll`, the Alertmanager its `datasourceUid` names through fleet Grafana's
  datasource proxy (`/api/datasources/proxy/uid/<datasourceUid>/api/v2/alerts`, e.g.
  `alertmanager-prod` for prod) as the same Viewer. It never passes the header to an agent.
  With no credentials mounted it sends nothing and records a failed poll
  (`probe_error: unconfigured`). A broken poll shows as `claws_alertmanager_poll_ok{cluster,repo} == 0`; see
  [issue-tracker.md#alert-bridges](issue-tracker.md#alert-bridges).

The base URL can be overridden with `fleetGrafanaUrl` / `CLAWS_FLEET_GRAFANA_URL` (default
`https://grafana.home.bstjohn.net`); the `fleet-observability` capability uses it for both its
URL variables.

### The Claws JWT signing key is not a Grafana credential

Claws no longer signs Grafana tokens: the Claws-signed Grafana JWT (`aud=grafana-fleet`,
#clw_01M5AW39TVQ6KX2WRDZGHSN2TZ) and the operator's `/api/grafana-auth/token/:cluster` route are
retired (#clw_01M7QFE3ZDE06M6JW202445NPX). The signing key (config key `grafanaJwtSigningKey`) and
its public JWKS at `/.well-known/claws-jwks.json` stay, for the
[content-moderator](jobs/content-moderator.md) job's tokens and the derived pages and Home
Assistant read-token keys; see [configuration.md](configuration.md).

## Status per cluster

| Cluster | Grafana | Auth path | Status |
|---|---|---|---|
| Prod | `grafana.bstjohn.net` (Grafana 11.3.1), being retired | Not used by Claws | No longer probed; read prod through fleet's `prometheus-prod`, `loki-prod` and `alertmanager-prod` |
| Fleet | `grafana.home.bstjohn.net` | `claws-service` Basic through `authentik-auth-basic` | Works |

Do not point Claws at the in-cluster Grafana Service: Grafana trusts `X-authentik-username` from
any pod in `10.42.0.0/16`.

## Verify access

Run these in your own shell, never in an agent session. Read the app password from the
`claws-authentik-service-account` Secret (key `app-password`) or SOPS, and pass it with `-u` so
it stays out of shell history. Check `/api/user` first: a `302` or an HTML Authentik page means
Authentik refused the sign-in.

```sh
U=https://grafana.home.bstjohn.net   # prod data is here too
read -rs P                           # paste the app password; keeps it out of argv and shell history
A="claws-service:$P"
curl -s -u "$A" "$U/api/user"        # login claws-service, isGrafanaAdmin false
curl -s -u "$A" "$U/api/datasources/proxy/uid/prometheus/api/v1/query" --data-urlencode 'query=count(up)' -G
curl -s -u "$A" "$U/api/datasources/proxy/uid/loki/loki/api/v1/query_range" --data-urlencode 'query={app="claws"}' --data-urlencode 'limit=5' -G
# prod, through fleet Grafana
curl -s -u "$A" "$U/api/datasources/proxy/uid/prometheus-prod/api/v1/query" --data-urlencode 'query=up{job="prod-federate"}' -G
curl -s -u "$A" "$U/api/datasources/proxy/uid/alertmanager-prod/api/v2/alerts"
# alerts: fleet
curl -s -u "$A" "$U/api/prometheus/grafana/api/v1/alerts"
curl -s -u "$A" "$U/api/access-control/user/permissions"
```

Expected: `200` JSON for each; `/api/user` shows `claws-service` with `isGrafanaAdmin: false`, and
the user is a Viewer in Administration → Users; the permissions list contains no
`dashboards:write`, `alert.rules:write` or `datasources:write`. `claws_grafana_auth_ok` should
agree.

## Known gap: dashboard annotations

Grafana's Viewer role includes `fixed:annotations.dashboard:writer` and OSS Grafana cannot strip it,
so an agent could technically `POST /api/annotations`. The capability prompt forbids it, and
annotations are visible and reversible in Grafana. Everything else (dashboards, alert rules,
datasources) is enforced read-only server-side by the Viewer role.

## Read-only contract and cheat-sheet

Only read-only query endpoints (GET, plus `POST /api/ds/query` as the one permitted POST); never write (POST/PUT/PATCH/DELETE) to dashboards, alert rules, annotations or datasources, and never print the header.
Datasource uids are pinned to `prometheus` and `loki` for fleet data, and to `prometheus-prod`,
`loki-prod` and `alertmanager-prod` for prod data, all on fleet Grafana.

| Need | Path under the Grafana URL |
|---|---|
| PromQL | `/api/datasources/proxy/uid/prometheus/api/v1/query` (also `query_range`, `series`, `labels`); prod: uid `prometheus-prod` |
| LogQL | `/api/datasources/proxy/uid/loki/loki/api/v1/query_range` with `start`, `end`, `limit`; prod: uid `loki-prod` |
| Alerts (prod) | `/api/datasources/proxy/uid/alertmanager-prod/api/v2/alerts` (home `alertmanager-prod`, which evaluates the ported prod rules) |
| Alerts (fleet) | `/api/prometheus/grafana/api/v1/alerts` (Grafana-managed rules) |
| Dashboards | `/api/search`, `/api/dashboards/uid/<uid>` |
| Fallback | `POST /api/ds/query` |

Claws services log JSON, so use `{app="…"} | json | level="error"` (see [observability-contract.md](observability-contract.md)).

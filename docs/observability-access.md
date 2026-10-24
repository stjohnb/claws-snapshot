# Observability access for agents

The `prod-observability` and `fleet-observability` session capabilities give an agent read-only
access to each cluster's Grafana HTTP API (Prometheus and Loki datasource proxy, alerts,
dashboards) using a short-lived Claws-signed JWT sent as `Authorization: Bearer`. Claws files no
alerts from this data; cluster alerting is owned by Prometheus/Grafana/Alertmanager.

## How access works

Claws holds no Grafana service account, token or admin credential, and Grafana holds no state
Claws depends on (#clw_01M5AW39TVQ6KX2WRDZGHSN2TZ).

- **Signing key.** Claws generates an RSA-2048 key on first start and stores it in the config
  store as the sensitive key `grafanaJwtSigningKey` (PKCS8 PEM). It is never exported, logged or
  passed to an agent. See [configuration.md](configuration.md).
- **JWKS.** The public half is served unauthenticated at `/.well-known/claws-jwks.json`
  (`Cache-Control: max-age=300`). Fleet Grafana fetches
  `https://claws.home.bstjohn.net/.well-known/claws-jwks.json`; prod Grafana fetches
  `https://claws.ext.bstjohn.net/.well-known/claws-jwks.json` over the tailnet. Both cache it for
  15 minutes. `claws.ext.bstjohn.net` is a prod-only record: home Traefik serves just
  `/api/alert-bridge/*` and this JWKS path on it and returns 404 for everything else. People reach
  the dashboard at `claws.home.bstjohn.net` over the tailnet via split DNS.
- **Tokens.** Each grant of `prod-observability` or `fleet-observability` mints a fresh RS256 JWT
  valid for 7 days with `iss=claws`, `sub=claws-observability`,
  `email=claws-observability@bstjohn.net`, a random `jti` and a per-cluster `aud`:
  `grafana-prod` or `grafana-fleet`. Each Grafana pins `iss` and its own `aud` with
  `auth.jwt.expect_claims`, so a prod token is rejected on fleet and the other way round.
- **Role.** `auth.jwt.auto_sign_up` creates the `claws-observability` user on its first request
  with `users.auto_assign_org_role: Viewer`. The JWT carries no role claim and
  `allow_assign_grafana_admin` is false.
- **Nothing to recreate.** After a Grafana PVC rebuild the next request recreates the Viewer
  user. A rotated signing key reaches Grafana within the JWKS cache TTL. No StatefulSet restart is
  needed for either.
- **Grafana config** lives in fleet-infra `apps/monitoring/kube-prometheus-stack.yaml` and
  production-infra `infrastructure/prod/observability/kube-prometheus-stack.yaml` (`grafana.ini`
  `auth.jwt` and `users`).
- **Alerting.** Every 15 minutes Claws calls `GET /api/user` on each Grafana with a fresh
  5-minute token and exports `claws_grafana_auth_ok{cluster}` (1 only on 200 with
  `isGrafanaAdmin: false`; see [metrics.md](metrics.md)). Fleet Grafana's rule
  `claws-grafana-auth-failing` ("Claws Grafana observability auth failing") files an inbox issue
  after an hour at 0. The usual causes are `auth.jwt` misconfigured, the JWKS URL unreachable from
  Grafana, the fleet Bearer route regexp, or a changed Claws signing key.

The base URLs can still be overridden with `CLAWS_PROD_GRAFANA_URL` / `CLAWS_FLEET_GRAFANA_URL`
(defaults `https://grafana.bstjohn.net` and `https://grafana.home.bstjohn.net`).

## Status per cluster

| Cluster | Grafana | Auth path | Status |
|---|---|---|---|
| Prod | `grafana.bstjohn.net` (Grafana 11.3.1) | Native Grafana auth; `auth.jwt` verifies the Claws JWT directly | Works, stateless |
| Fleet | `grafana.home.bstjohn.net` | Traefik IngressRoute `grafana-bearer` (fleet-infra `apps/monitoring/grafana-bearer-ingressroute.yaml`) matches `Authorization: ^Bearer (glsa_\|eyJ)` at priority 100, skips Authentik ForwardAuth and still strips `X-authentik-*`; `auth.jwt` then verifies the token | Works, stateless |

Do not point Claws at the in-cluster Grafana Service: Grafana trusts `X-authentik-username` from
any pod in `10.42.0.0/16`.

## Verify access

Run these in your own shell, never in an agent session. Get a 1-hour token from the dashboard
while signed in: open `/api/grafana-auth/token/prod` or `/api/grafana-auth/token/fleet` and copy
`token` from the `{ token, expiresAt }` JSON. The route takes only the dashboard session; agent
bearer tokens get `401`, and the token is never logged. Check `/api/user` first: on fleet, a
`302` or an HTML page means the request missed the Bearer route.

```sh
U=https://grafana.bstjohn.net        # fleet: https://grafana.home.bstjohn.net
read -rs T                           # paste the token; keeps it out of argv and shell history
H="Authorization: Bearer $T"
curl -s -H "$H" "$U/api/user"        # login claws-observability, isGrafanaAdmin false
curl -s -H "$H" "$U/api/datasources/proxy/uid/prometheus/api/v1/query" --data-urlencode 'query=count(up)' -G
curl -s -H "$H" "$U/api/datasources/proxy/uid/loki/loki/api/v1/query_range" --data-urlencode 'query={app="claws"}' --data-urlencode 'limit=5' -G
# alerts: prod
curl -s -H "$H" "$U/api/datasources/proxy/uid/alertmanager/api/v2/alerts"
# alerts: fleet
curl -s -H "$H" "$U/api/prometheus/grafana/api/v1/alerts"
curl -s -H "$H" "$U/api/access-control/user/permissions"
```

Expected: `200` JSON for each; `/api/user` shows `claws-observability` with
`isGrafanaAdmin: false`, and the user is a Viewer in Administration → Users; the permissions list
contains no `dashboards:write`, `alert.rules:write` or `datasources:write`. A `401` JSON
reply means Grafana rejected the JWT: check that `/.well-known/claws-jwks.json` is reachable from
that cluster and that `claws_grafana_auth_ok` agrees.

To prove a rebuild heals itself, delete the `claws-observability` user in one Grafana, re-run
the `/api/user` curl and confirm the user reappears as a Viewer.

## Cleanup

The service-account setup from 2026-10-19 (#clw_01M5AAHN2B36VTJS0WBND838C6) is now inert. You
may delete it at leisure; nothing breaks if it stays:

- the `CLAWS_PROD_GRAFANA_TOKEN` / `CLAWS_FLEET_GRAFANA_TOKEN` keys in the `claws-config`
  Secret. Claws no longer reads them and still strips them from agent pods.
- `prodGrafanaToken` / `fleetGrafanaToken` in `config.json`. They are retired keys, dropped on
  the next config save.
- the `claws-observability` service accounts: prod id 2, fleet id 5.

## Known gap: dashboard annotations

Grafana's Viewer role includes `fixed:annotations.dashboard:writer` and OSS Grafana cannot strip it,
so an agent could technically `POST /api/annotations`. The capability prompt forbids it, and
annotations are visible and reversible in Grafana. Everything else (dashboards, alert rules,
datasources) is enforced read-only server-side by the Viewer role.

## Read-only contract and cheat-sheet

Only read-only query endpoints (GET, plus `POST /api/ds/query` as the one permitted POST); never write (POST/PUT/PATCH/DELETE) to dashboards, alert rules, annotations or datasources, and never print the token.
Datasource uids are pinned to `prometheus` and `loki` on both clusters.

| Need | Path under the Grafana URL |
|---|---|
| PromQL | `/api/datasources/proxy/uid/prometheus/api/v1/query` (also `query_range`, `series`, `labels`) |
| LogQL | `/api/datasources/proxy/uid/loki/loki/api/v1/query_range` with `start`, `end`, `limit` |
| Alerts (prod) | `/api/datasources/proxy/uid/alertmanager/api/v2/alerts` (Alertmanager datasource, uid `alertmanager`, the kube-prometheus-stack default), `/api/alertmanager/grafana/api/v2/alerts` |
| Alerts (fleet) | `/api/prometheus/grafana/api/v1/alerts` (Grafana-managed rules) |
| Dashboards | `/api/search`, `/api/dashboards/uid/<uid>` |
| Fallback | `POST /api/ds/query` |

Claws services log JSON, so use `{app="…"} | json | level="error"` (see [logging-conventions.md](logging-conventions.md)).

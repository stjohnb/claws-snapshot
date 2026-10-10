# Observability access for agents

The `prod-observability` and `fleet-observability` session capabilities give an agent read-only
access to each cluster's Grafana HTTP API (Prometheus and Loki datasource proxy, alerts,
dashboards) using a Grafana service-account token sent as `Authorization: Bearer`. Claws files no
alerts from this data; cluster alerting is owned by Prometheus/Grafana/Alertmanager.

## Setup (operator)

1. In each Grafana (Administration → Service accounts) create a service account with the **Viewer**
   role and add a token. Service accounts are runtime DB state: recreate them after a PVC rebuild.
2. Put the token where Claws reads it:
   - Kubernetes: `CLAWS_PROD_GRAFANA_TOKEN` / `CLAWS_FLEET_GRAFANA_TOKEN` in the `claws-config`
     Secret (see [k8s-cutover.md](k8s-cutover.md)).
   - Local install: `prodGrafanaToken` / `fleetGrafanaToken` in `config.json`.
3. Optionally override the base URLs with `CLAWS_PROD_GRAFANA_URL` / `CLAWS_FLEET_GRAFANA_URL`
   (defaults `https://grafana.bstjohn.net` and `https://grafana.home.bstjohn.net`).

An empty token hides the capability from the session form. See [configuration.md](configuration.md).

## Per-cluster access

- **Prod:** `grafana.bstjohn.net` uses Grafana's native auth, so Bearer tokens work directly.
- **Fleet:** `grafana.home.bstjohn.net` is behind Authentik ForwardAuth, so Bearer tokens only work
  once fleet-infra adds a Bearer-only route, tracked by #clw_01M48T0TFVDX2XQVEPAGCQB5K6
  (https://claws.home.bstjohn.net/issues/clw_01M48T0TFVDX2XQVEPAGCQB5K6). Until then requests
  redirect to Authentik or return an HTML page. Do not point Claws at the in-cluster Grafana
  Service: Grafana trusts `X-authentik-username` from any pod in `10.42.0.0/16`.

## Read-only contract and cheat-sheet

Only read-only query endpoints (GET, plus `POST /api/ds/query` as the one permitted POST); never write (POST/PUT/PATCH/DELETE) to dashboards, alert rules, annotations or datasources, and never print the token.
Datasource uids are pinned to `prometheus` and `loki` on both clusters.

| Need | Path under the Grafana URL |
|---|---|
| PromQL | `/api/datasources/proxy/uid/prometheus/api/v1/query` (also `query_range`, `series`, `labels`) |
| LogQL | `/api/datasources/proxy/uid/loki/loki/api/v1/query_range` with `start`, `end`, `limit` |
| Alerts (prod) | `/api/alertmanager/grafana/api/v2/alerts`, `/api/datasources/proxy/uid/alertmanager/api/v2/alerts` |
| Alerts (fleet) | `/api/prometheus/grafana/api/v1/alerts` |
| Dashboards | `/api/search`, `/api/dashboards/uid/<uid>` |
| Fallback | `POST /api/ds/query` |

Claws services log JSON, so use `{app="…"} | json | level="error"` (see [logging-conventions.md](logging-conventions.md)).

# dependabot-alert-monitor

**Source**: `src/jobs/dependabot-alert-monitor.ts`
**Trigger**: Smart-scheduled (see [OVERVIEW.md](../OVERVIEW.md) "Smart Scheduling")

Polls the GitHub Dependabot Alerts API (`GET /repos/{owner}/{repo}/dependabot/alerts?state=open`)
per repo and auto-dismisses stale alerts in two passes:

1. **SBOM-based pass** (gated by `dependabotAutoDismissStale`, default on) — fetches the repo's
   SPDX dependency graph via `fetchRepoSbomPackages` and dismisses alerts whose fixed version is
   already present in the graph.
2. **Manifest-pin pass** via `dismissAlreadyPinnedAlerts()` — reads the committed manifest file
   (`fetchRepoFileContent` in `github.ts`) for pip `==`-pinned packages using
   `parsePinnedRequirement()` + `manifestSatisfiesPatch()` (which strips pre-release suffixes via
   `versionCore()` before comparing). This handles the common case where the SBOM lags behind a
   committed version bump that the first pass would otherwise miss.

## Suppression sources

Before filing, alerts are suppressed by merging two sources:

- The central `dependabotIgnoredAdvisories` config (keyed by repo full name, or `"*"` for a global
  list, matched case-insensitively).
- A repo-local deferral manifest at `.claws/dependabot-deferrals.json` — a PR-reviewable committed
  file that lets teams consciously defer unfixable alerts (e.g. a major-version bump that breaks
  the build). Read via `fetchRepoFileContent` and parsed by the exported
  `parseDeferredAdvisories(content)` helper, which accepts either a flat `["GHSA-..."]` array or a
  `{ deferrals: [{ ghsa, reason, reviewAfter }] }` object; `reason`/`reviewAfter` are
  documentation-only and never enforced.

When all alerts on a repo are suppressed via either source, the alert issue is closed — giving an
agent-authored deferral PR a durable effect instead of no-op churn.

## Alert issue

Files an occurrence-tracked (`ensureAlertIssue()`) Priority alert issue listing the remaining open
alerts. The body includes a `REMEDIATION_GUIDANCE` block with ordered steps: prefer removing
unnecessary deps, classify dev vs runtime, bump direct deps before adding overrides, use `>=`
ranges (not exact pins) in overrides. Auto-closes the issue once all alerts clear.

## Edge cases

- Leaves repos with Dependabot scanning disabled as-is.
- If the GitHub App lacks the `dependabot_alerts: read` permission, files a remediation issue on
  `SELF_REPO` instead (the permission check runs before the 404/"disabled" swallow, so a permission
  failure is never misclassified as "no alerts").

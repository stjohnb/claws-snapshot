/**
 * Alert-issue detection, shared by promotion (`claws-issues.ts`'s
 * `shouldAutoPromote`) and the planner's stale-body stripping
 * (`agents/issue-refiner.ts`'s `stripVolatileBody`). Kept in its own leaf
 * module — no service imports — so `claws-issues.ts` and
 * `agents/issue-refiner.ts` can both depend on it without a cycle between
 * them.
 */

/**
 * True for a consolidated alert-bridge body (fleet-infra's and production-infra's
 * grafana-github-alerts bridge): one issue per repo, one `### <alertname>` section per
 * alert, fully re-rendered on every firing/resolve. Detected structurally by the two
 * section headings the bridge always emits, so it doesn't depend on the bridge's wording
 * or name.
 */
export function isConsolidatedAlertBody(body: string): boolean {
  return /^## Currently firing[ \t]*$/m.test(body) && /^## Alerts[ \t]*$/m.test(body);
}

/**
 * Labels either alert bridge attaches: production-infra's `alert-issue-bridge`
 * defaults to `alert`, and fleet-infra's `grafana-github-alerts` deployment
 * sets `grafana-alert`.
 */
export const ALERT_ISSUE_LABELS = ["alert", "grafana-alert"];

/**
 * True when `issue` is an alert issue: it carries one of {@link ALERT_ISSUE_LABELS}
 * exactly, or its body matches {@link isConsolidatedAlertBody} — a bridge issue
 * imported or shadowed without its label.
 */
export function isAlertIssue(issue: { labels: readonly string[]; body: string }): boolean {
  return issue.labels.some((label) => ALERT_ISSUE_LABELS.includes(label)) || isConsolidatedAlertBody(issue.body);
}

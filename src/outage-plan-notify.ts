/**
 * The down-service page (#clw_01M7VZZYSAGW87NV1HVZJXEE4F): after each
 * successful Alertmanager poll, when a bridge repo's service has a down-signal
 * alert firing and an open alert issue for that service holds a plan awaiting
 * the operator's review, or is Blocked on the operator
 * (#clw_01M8AG9RS0KT92NKD1F93CXHHJ), post one urgent Slack message per issue
 * per window.
 * See docs/issue-tracker.md "Alert bridges".
 *
 * Must not import the poller or `alert-bridge.ts`: the poller calls in here.
 */
import { isAutomationParkReason, plainBlockedReasonText } from "./blocked-reason.js";
import { alertGroupKey, alertGroupKeyPrefix, splitAlertGroupName } from "./alert-issue.js";
import * as clawsIssues from "./claws-issues.js";
import * as db from "./db.js";
import { atLeast, stopsAtFor } from "./issue-approval.js";
import { isWhatChangesTitle, parsePlanSections } from "./plan-parser.js";
import { notify, notifyProdAlert } from "./slack.js";
import * as log from "./log.js";
import type { RepoAlertBridgeDownNotify } from "./repo-config.js";

/** Alertnames that always mean a service is down. */
export const BUILT_IN_DOWN_ALERTNAMES: readonly string[] = ["KubeDeploymentReplicasMismatch", "TargetDown", "KubePodCrashLooping"];

/** The longest plan line the page quotes. */
const PLAN_LINE_MAX = 300;

/** One alert group of a poll, as the notifier sees it. */
export interface OutageGroup {
  /** `<service> / <alert>`, or a bare alertname. */
  name: string;
  /** True when any instance of the group carries the `page: "true"` label. */
  page: boolean;
}

/**
 * True when `group` signals its service is down: its alert part is a built-in
 * down alertname or one of `extraAlertnames` (exact match), or it is labelled
 * `page: "true"`.
 */
export function isDownSignal(group: OutageGroup, extraAlertnames: readonly string[] = []): boolean {
  if (group.page) return true;
  const { alert } = splitAlertGroupName(group.name);
  return BUILT_IN_DOWN_ALERTNAMES.includes(alert) || extraAlertnames.includes(alert);
}

/**
 * The first non-empty line of the plan's What changes section, list marker
 * stripped, whitespace collapsed and cut to 300 characters; `see the plan`
 * when the plan has no such line.
 */
export function planHeadline(planText: string): string {
  const section = parsePlanSections(planText).find((s) => isWhatChangesTitle(s.title));
  const line = section?.markdown.split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (!line) return "see the plan";
  const text = line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").split(/\s+/).filter(Boolean).join(" ");
  if (!text) return "see the plan";
  return capLine(text);
}

/** `text` cut to {@link PLAN_LINE_MAX} characters, ending in `…` when cut. */
function capLine(text: string): string {
  return text.length > PLAN_LINE_MAX ? `${text.slice(0, PLAN_LINE_MAX - 1)}…` : text;
}

/**
 * True when a current Blocked reason means the issue waits on the operator:
 * a reason naming a PR (``PR ` ``), open PRs to merge (``Waiting on ` ``) or
 * another open issue (``Depends on #``) waits on automation instead
 * ({@link isAutomationParkReason}).
 */
export function blockedOnOperator(reason: string | undefined): reason is string {
  if (reason === undefined) return false;
  return !isAutomationParkReason(reason);
}

/**
 * A Blocked reason as the page quotes it: marker line dropped, flattened to
 * one plain line ({@link plainBlockedReasonText}) and cut to 300 characters.
 */
export function pageBlockedReason(reason: string): string {
  return capLine(plainBlockedReasonText(reason).split(/\s+/).filter(Boolean).join(" "));
}

/** Second-precision ISO time, the format `now` arrives in. */
function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Page Slack for every open alert issue in `bridge.repo` whose service is down
 * in this poll and which holds a plan awaiting review or is Blocked on the
 * operator ({@link blockedOnOperator}), at most once per issue
 * per `downNotify.windowMinutes`. A dry run sends and stamps nothing and logs
 * `would send outage plan notification` instead.
 */
export async function notifyOutagePlans(
  bridge: { repo: string; downNotify: RepoAlertBridgeDownNotify },
  groups: readonly OutageGroup[],
  opts: { dryRun: boolean; now: string },
): Promise<void> {
  const { downNotify } = bridge;
  const down = groups.filter((g) => isDownSignal(g, downNotify.alertnames));
  if (down.length === 0) return;

  const open = await db.listOpenClawsIssues({ repo: bridge.repo, repoMatch: "primary" });
  // Issue id → its service and every down alert of that service in this poll.
  const matches = new Map<string, { issue: db.ClawsIssueRecord; service: string; alerts: string[] }>();
  for (const group of down) {
    const { service, alert } = splitAlertGroupName(group.name);
    const holds = service
      ? (key: string) => key.startsWith(alertGroupKeyPrefix(service))
      : (key: string) => key === alertGroupKey(group.name);
    for (const issue of open) {
      if (!issue.dedupe_keys.some(holds)) continue;
      const entry = matches.get(issue.id) ?? { issue, service: service || alert, alerts: [] };
      if (!entry.alerts.includes(alert)) entry.alerts.push(alert);
      matches.set(issue.id, entry);
    }
  }

  const cutoff = isoSeconds(Date.parse(opts.now) - downNotify.windowMinutes * 60_000);
  const blockedIds = [...matches.values()].filter((m) => m.issue.lifecycle === "blocked").map((m) => m.issue.id);
  const blockedReasons = blockedIds.length > 0 ? await db.getIssueBlockedReasons(blockedIds) : new Map<string, string>();
  for (const { issue, service, alerts } of matches.values()) {
    const base = { issue: issue.id, bridge_repo: bridge.repo, service, alerts: alerts.join(", "), channel: downNotify.channel };
    const tag = downNotify.channel === "prod" ? "[prod]" : "[fleet]";
    const link = `${issue.title} ${clawsIssues.dashboardIssueUrl(issue.id)}`;
    let fields: typeof base & { waiting_on: "plan_review" | "blocked" };
    let text: string;
    if (issue.lifecycle === "blocked") {
      fields = { ...base, waiting_on: "blocked" };
      const reason = blockedReasons.get(issue.id);
      if (!blockedOnOperator(reason)) {
        log.debug("outage plan notification skipped", { ...fields, reason: reason === undefined ? "no_blocked_reason" : "blocked_on_automation" });
        continue;
      }
      text = [
        `:rotating_light: ${tag} ${service} is down and its issue is blocked on you: ${link}`,
        `Down alerts: ${alerts.join(", ")}`,
        `Blocked: ${pageBlockedReason(reason)}`,
      ].join("\n");
    } else {
      fields = { ...base, waiting_on: "plan_review" };
      if (issue.lifecycle !== "awaiting-plan-review") {
        log.debug("outage plan notification skipped", { ...fields, reason: "not_awaiting_plan_review", lifecycle: issue.lifecycle });
        continue;
      }
      if (atLeast(issue.approved_through, "plan")) {
        log.debug("outage plan notification skipped", { ...fields, reason: "plan_approved" });
        continue;
      }
      const plan = (await clawsIssues.listPlans(issue.id)).at(-1);
      if (!plan) {
        log.debug("outage plan notification skipped", { ...fields, reason: "no_plan" });
        continue;
      }
      text = [
        `:rotating_light: ${tag} ${service} is down and a fix plan is waiting for you: ${link}`,
        `Down alerts: ${alerts.join(", ")}`,
        `Plan: ${planHeadline(plan.body)}`,
        `${stopsAtFor("plan")}. Review and approve the plan to ship it.`,
      ].join("\n");
    }
    if (opts.dryRun) {
      log.info("would send outage plan notification", fields);
      continue;
    }
    if (!(await db.claimClawsIssueOutageNotice(issue.id, opts.now, cutoff))) {
      log.debug("outage plan notification skipped", { ...fields, reason: "within_window" });
      continue;
    }
    await (downNotify.channel === "prod" ? notifyProdAlert(text) : notify(text));
    log.info("outage plan notification sent", fields);
  }
}

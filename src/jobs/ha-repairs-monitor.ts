import { HOME_ASSISTANT_REPAIRS_IGNORE, HOME_ASSISTANT_REPAIRS_MONITOR_ENABLED, LABELS, type HaRepairIgnoreRule } from "../config.js";
import * as ha from "../home-assistant.js";
import type { HaRepairIssue } from "../home-assistant.js";
import * as log from "../log.js";
import { resolveHaMonitorRepo } from "./ha-monitor-common.js";
import { upsertAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { guardContent } from "../prompt-guard.js";

const LOG_PREFIX = "ha-repairs-monitor";
const ALERT_TITLE = "[ha-repairs-monitor] Home Assistant repairs need attention";
const SEVERITY_RANK: Record<string, number> = { critical: 0, error: 1, warning: 2 };

export function applyPlaceholders(template: string, placeholders: Record<string, string>): string {
  return template.replace(/\{([^{}]+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(placeholders, key) ? placeholders[key]! : match,
  );
}

export function renderRepairTitle(issue: HaRepairIssue, resources: Record<string, string>): string {
  const key = issue.translation_key;
  if (key) {
    const template = resources[`component.${issue.domain}.issues.${key}.title`];
    if (template) return applyPlaceholders(template, issue.translation_placeholders ?? {});
    return `\`${key}\``;
  }
  return `\`${issue.issue_id}\``;
}

export function sortRepairs(issues: HaRepairIssue[]): HaRepairIssue[] {
  return [...issues].sort((a, b) => {
    const rankA = SEVERITY_RANK[a.severity ?? ""] ?? 3;
    const rankB = SEVERITY_RANK[b.severity ?? ""] ?? 3;
    if (rankA !== rankB) return rankA - rankB;
    const domainCmp = a.domain.localeCompare(b.domain);
    if (domainCmp !== 0) return domainCmp;
    return a.issue_id.localeCompare(b.issue_id);
  });
}

export function matchesIgnoreRule(issue: HaRepairIssue, rule: HaRepairIgnoreRule): boolean {
  if (issue.domain !== rule.domain) return false;
  if (rule.translationKey !== undefined && issue.translation_key !== rule.translationKey) return false;
  if (rule.placeholders !== undefined) {
    for (const [k, v] of Object.entries(rule.placeholders)) {
      if (issue.translation_placeholders?.[k] !== v) return false;
    }
  }
  return true;
}

export function partitionRepairs(
  issues: HaRepairIssue[],
  rules: readonly HaRepairIgnoreRule[],
): { active: HaRepairIssue[]; suppressed: HaRepairIssue[] } {
  const active: HaRepairIssue[] = [];
  const suppressed: HaRepairIssue[] = [];
  for (const issue of issues) {
    if (rules.some((r) => matchesIgnoreRule(issue, r))) {
      suppressed.push(issue);
    } else {
      active.push(issue);
    }
  }
  return { active, suppressed };
}

export function describeSuppressed(issue: HaRepairIssue): string {
  const base = `${issue.domain} / ${issue.translation_key ?? issue.issue_id}`;
  const placeholders = issue.translation_placeholders;
  if (placeholders && Object.keys(placeholders).length > 0) {
    const parts = Object.entries(placeholders)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    return `${base} (${parts.join(", ")})`;
  }
  return base;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

export function buildBody(
  issues: HaRepairIssue[],
  resources: Record<string, string>,
  repo: string,
  suppressed: HaRepairIssue[] = [],
): string {
  const rows = issues.map((issue, i) => {
    const rawTitle = renderRepairTitle(issue, resources);
    const guarded = guardContent(rawTitle, { repo, source: "ha-repair", itemNumber: 0 });
    const escapedName = escapeCell(guarded);
    const url = issue.learn_more_url;
    const name =
      typeof url === "string" && /^https?:\/\//.test(url) ? `[${escapedName}](${url})` : escapedName;
    let severity = escapeCell(issue.severity ?? "unknown");
    if (typeof issue.breaks_in_ha_version === "string" && issue.breaks_in_ha_version.length > 0) {
      severity += ` — breaks in HA ${escapeCell(issue.breaks_in_ha_version)}`;
    }
    const fixable = issue.is_fixable === true ? "yes" : "no";
    const raised = issue.created?.slice(0, 10) ?? "unknown";
    return `| ${name} | \`${escapeCell(issue.domain)}\` | ${severity} | ${fixable} | ${raised} |`;
  });

  return [
    `Automated Home Assistant repairs monitor. Home Assistant is reporting ${issues.length} open repair(s)`,
    "(Settings → System → Repairs). Repairs you dismiss in Home Assistant (\"Ignore\") drop off",
    "this list. This issue auto-closes when no un-ignored repairs remain.",
    "",
    "| Repair | Domain | Severity | Fixable in HA | Raised |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "Fix these in Home Assistant under **Settings → System → Repairs**; Claws cannot dismiss",
    "or resolve a repair on your behalf.",
    ...(suppressed.length > 0
      ? [
          "",
          `Suppressed by Claws config (\`homeAssistantRepairsIgnore\`), not shown above: ${guardContent(
            sortRepairs(suppressed).map(describeSuppressed).join(", "),
            { repo, source: "ha-repair", itemNumber: 0 },
          )}`,
        ]
      : []),
  ].join("\n");
}

export async function run(): Promise<void> {
  const repo = resolveHaMonitorRepo(HOME_ASSISTANT_REPAIRS_MONITOR_ENABLED, LOG_PREFIX);
  if (!repo) return;

  let active: HaRepairIssue[];
  let suppressed: HaRepairIssue[];
  let resources: Record<string, string>;
  try {
    ({ active, suppressed, resources } = await ha.withHaWebSocket(async (s) => {
      const all = await ha.listRepairIssues(s);
      const unignored = all.filter((i) => i.ignored !== true);
      const { active: act, suppressed: sup } = partitionRepairs(unignored, HOME_ASSISTANT_REPAIRS_IGNORE);
      let res: Record<string, string> = {};
      if (act.length > 0) {
        const domains = [...new Set(act.map((i) => i.domain).filter(Boolean))];
        try {
          res = await ha.getIssueTranslations(s, domains);
        } catch (err) {
          log.warn(`[${LOG_PREFIX}] Could not fetch repair translations: ${(err as Error).message}`);
        }
      }
      return { active: act, suppressed: sup, resources: res };
    }));
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] Could not read HA repairs: ${(err as Error).message}`);
    return;
  }

  if (suppressed.length > 0) {
    log.debug(`[${LOG_PREFIX}] ${suppressed.length} repair(s) suppressed by config: ${suppressed.map(describeSuppressed).join(", ")}`);
  }

  try {
    if (active.length === 0) {
      const closed = await closeAlertIssueIfResolved({
        repo,
        title: ALERT_TITLE,
        logPrefix: LOG_PREFIX,
        reason: "no open Home Assistant repairs remain",
      });
      if (closed === null) {
        log.debug(`[${LOG_PREFIX}] no repairs and no open issue — nothing to do`);
      }
    } else {
      await upsertAlertIssue({
        repo,
        title: ALERT_TITLE,
        body: buildBody(sortRepairs(active), resources, repo, suppressed),
        labels: [LABELS.priority],
        logPrefix: LOG_PREFIX,
        createdDetail: `${active.length} repair(s) open`,
      });
    }
  } catch (err) {
    log.warn(`[${LOG_PREFIX}] GitHub operation failed: ${(err as Error).message}`);
  }
}

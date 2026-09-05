import {
  HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED,
  HOME_ASSISTANT_GIT_PULL_ADDON_SLUG,
  HOME_ASSISTANT_CONFIG_REPO,
  LABELS,
} from "../config.js";
import * as ha from "../home-assistant.js";
import * as log from "../log.js";
import { notify } from "../slack.js";
import {
  getHaDeployWatcherState,
  upsertHaDeployWatcherState,
} from "../db.js";
import { listCompareCommits } from "../github.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";
import { guardContent } from "../prompt-guard.js";

const ALERT_TITLE =
  "[ha-deploy-watcher] home-assistant-config deploy failed on the Home Assistant host";

export interface DeployEvent {
  oldSha: string;
  newSha: string;
  diffstat: string;
  configError?: string;
}

export type DeploySeverity = "error" | "warning" | null;

export function deploySeverity(evt: DeployEvent): DeploySeverity {
  if (!evt.configError) return null;
  return evt.configError.includes("] WARNING:") ? "warning" : "error";
}

export function buildDeployFailureBody(
  evt: DeployEvent,
  repo: string,
  commits: { sha: string; subject: string }[] | null,
  detectedAt: string,
): string {
  const compareUrl = `https://github.com/${repo}/compare/${evt.oldSha}...${evt.newSha}`;

  const commitsBlock =
    commits === null
      ? `_(commit list unavailable — see compare link)_`
      : commits.length === 0
        ? `_(no commits between ${evt.oldSha} and ${evt.newSha})_`
        : commits
            .map(
              (c) =>
                `- \`${c.sha.slice(0, 7)}\` ${guardContent(c.subject, { repo, source: "commit-subject", itemNumber: 0 })}`,
            )
            .join("\n");

  const guardedConfigError = guardContent(evt.configError ?? "", { repo, source: "ha-addon-log", itemNumber: 0 });
  const guardedDiffstat = guardContent(evt.diffstat, { repo, source: "ha-addon-log", itemNumber: 0 });

  return [
    `Home Assistant's \`core_git_pull\` add-on pulled \`${evt.oldSha}..${evt.newSha}\` into \`/config\`, but the`,
    `\`ha core check\` that follows failed — **Home Assistant Core was not restarted, and the host is`,
    `still running the previous configuration.**`,
    ``,
    `**Config check error:**`,
    "```",
    guardedConfigError,
    "```",
    ``,
    `**Commits:**`,
    commitsBlock,
    ``,
    `**Compare:** ${compareUrl}`,
    ``,
    `**Diffstat:**`,
    "```",
    guardedDiffstat,
    "```",
    ``,
    `**Detected at:** ${detectedAt}`,
    ``,
    `---`,
    `Filed automatically by Claws' \`ha-deploy-watcher\`. It closes itself once a later deploy passes the`,
    `config check. If the fix is host-side only (e.g. a key missing from the gitignored`,
    `\`/config/secrets.yaml\`), the add-on only re-runs the check when something changes, so push a commit`,
    `to this repo to confirm the deploy is healthy again.`,
  ].join("\n");
}

export function parseDeployEvents(logs: string): DeployEvent[] {
  const lines = logs.split("\n");
  const events: DeployEvent[] = [];
  const UPDATING_RE = /^Updating ([0-9a-f]{7,40})\.\.([0-9a-f]{7,40})$/;
  const TIMESTAMP_RE = /^\[\d\d:\d\d:\d\d\]/;
  const ERROR_RE = /^\[\d\d:\d\d:\d\d\] (ERROR|WARNING):/;
  // eslint-disable-next-line no-control-regex
  const ANSI_RE = /\x1b\[[0-9;]*m/g;

  for (let i = 0; i < lines.length; i++) {
    const m = UPDATING_RE.exec(lines[i]!);
    if (!m) continue;

    const oldSha = m[1]!;
    const newSha = m[2]!;
    const diffstatLines: string[] = [];
    let j = i + 1;

    for (; j < lines.length; j++) {
      if (TIMESTAMP_RE.test(lines[j]!)) break;
      diffstatLines.push(lines[j]!);
    }

    // Trim trailing blank lines
    while (diffstatLines.length > 0 && diffstatLines[diffstatLines.length - 1]!.trim() === "") {
      diffstatLines.pop();
    }

    const diffstat = diffstatLines.join("\n");

    // Scan for the first ERROR/WARNING line after this deploy's diffstat and before
    // the next Updating line — captures HA config check failures.
    let configError: string | undefined;
    for (let k = j; k < lines.length; k++) {
      if (UPDATING_RE.exec(lines[k]!)) break;
      if (ERROR_RE.test(lines[k]!)) {
        configError = lines[k]!.replace(ANSI_RE, "").trim();
        break;
      }
    }

    // Deduplicate by newSha — keep last occurrence
    const existing = events.findIndex((e) => e.newSha === newSha);
    if (existing !== -1) {
      events.splice(existing, 1);
    }
    events.push({ oldSha, newSha, diffstat, configError });
  }

  return events;
}

export async function run(): Promise<void> {
  if (!HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED) {
    log.debug("[ha-deploy-watcher] Disabled — skipping");
    return;
  }
  if (!ha.isConfigured()) {
    log.debug("[ha-deploy-watcher] HA token/URL not configured — skipping");
    return;
  }

  const slug = HOME_ASSISTANT_GIT_PULL_ADDON_SLUG ?? "core_git_pull";
  let logsText: string;
  try {
    logsText = await ha.getAddonLogs(slug);
  } catch (err) {
    log.warn(`[ha-deploy-watcher] Could not fetch addon logs for "${slug}": ${(err as Error).message}`);
    return;
  }

  const events = parseDeployEvents(logsText);
  if (events.length === 0) {
    log.debug("[ha-deploy-watcher] No deploy events found in addon logs");
    return;
  }

  const state = getHaDeployWatcherState(slug);
  const latest = events[events.length - 1]!;

  // First-run baselining — record the latest SHA without notifying, so we don't
  // blast historical events the operator never asked about.
  if (state === null) {
    upsertHaDeployWatcherState(slug, latest.newSha, Date.now());
    log.info(`[ha-deploy-watcher] First run — baselined at ${latest.newSha} (no notification sent)`);
    return;
  }

  // Find events newer than the last notified SHA (order: oldest → newest).
  const lastIdx = events.findIndex((e) => e.newSha === state.lastNotifiedSha);
  const newEvents = lastIdx === -1 ? events : events.slice(lastIdx + 1);
  if (newEvents.length === 0) return;

  const repo = HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config";
  let latestFailure: { evt: DeployEvent; commits: { sha: string; subject: string }[] | null } | null = null;

  for (const evt of newEvents) {
    const evtSeverity = deploySeverity(evt);

    // Clean deploys are not announced to Slack (#2544 — failures only). Still clear
    // any pending failure so a later clean deploy in the same batch supersedes an
    // earlier error and the alert issue gets closed rather than re-filed.
    if (evtSeverity === null) {
      latestFailure = null;
      log.debug(`[ha-deploy-watcher] Clean deploy ${evt.oldSha}..${evt.newSha} — no Slack notification`);
      continue;
    }

    const compareUrl = `https://github.com/${repo}/compare/${evt.oldSha}...${evt.newSha}`;

    let commits: { sha: string; subject: string }[] | null = null;
    try {
      commits = await listCompareCommits(repo, evt.oldSha, evt.newSha);
    } catch (err) {
      log.warn(`[ha-deploy-watcher] Could not fetch commits ${evt.oldSha}..${evt.newSha}: ${(err as Error).message}`);
    }
    const commitsBlock =
      commits === null
        ? `_(commit list unavailable — see compare link)_`
        : commits.length === 0
          ? `_(no commits between ${evt.oldSha} and ${evt.newSha})_`
          : commits.map((c) => `• \`${c.sha.slice(0, 7)}\` ${c.subject}`).join("\n");

    const isWarning = evtSeverity === "warning";
    const header = isWarning
      ? `:warning: home-assistant-config deployed with warnings`
      : `:x: home-assistant-config deploy failed`;

    const msgLines = [
      header,
      `*Commits:*`,
      commitsBlock,
      `*Compare:* ${compareUrl}`,
      "```",
      evt.diffstat,
      "```",
      `${isWarning ? ":warning:" : ":x:"} ${isWarning ? "*Config check warning:*" : "*Config check error:*"}`,
      "```",
      evt.configError ?? "",
      "```",
    ];
    notify(msgLines.join("\n"));
    log.info(
      `[ha-deploy-watcher] Notified for ${evt.oldSha}..${evt.newSha} (config check ${isWarning ? "warning" : "error"})`,
    );

    latestFailure = evtSeverity === "error" ? { evt, commits } : null;
  }

  try {
    if (latestFailure) {
      const result = await ensureAlertIssue({
        repo,
        title: ALERT_TITLE,
        body: buildDeployFailureBody(latestFailure.evt, repo, latestFailure.commits, new Date().toISOString()),
        labels: [LABELS.priority],
        logPrefix: "ha-deploy-watcher",
        refreshBody: true,
      });
      log.info(
        `[ha-deploy-watcher] ${result.outcome === "created" ? "Filed" : "Updated"} deploy-failure issue #${result.issueNumber} for ${latestFailure.evt.newSha}`,
      );
    } else {
      await closeAlertIssueIfResolved({
        repo,
        title: ALERT_TITLE,
        logPrefix: "ha-deploy-watcher",
        reason: `deploy ${latest.newSha} passed the config check`,
      });
    }
  } catch (err) {
    log.warn(`[ha-deploy-watcher] Could not update the deploy-failure alert issue: ${err}`);
  }

  upsertHaDeployWatcherState(slug, latest.newSha, Date.now());
}

import {
  HOME_ASSISTANT_DEPLOY_WATCHER_ENABLED,
  HOME_ASSISTANT_GIT_PULL_ADDON_SLUG,
  HOME_ASSISTANT_CONFIG_REPO,
} from "../config.js";
import * as ha from "../home-assistant.js";
import * as log from "../log.js";
import { notify } from "../slack.js";
import {
  getHaDeployWatcherState,
  upsertHaDeployWatcherState,
} from "../db.js";
import { listCompareCommits } from "../github.js";

export interface DeployEvent {
  oldSha: string;
  newSha: string;
  diffstat: string;
  configError?: string;
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

  for (const evt of newEvents) {
    const repo = HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config";
    const compareUrl = `https://github.com/${repo}/compare/${evt.oldSha}...${evt.newSha}`;

    let commitsBlock: string;
    try {
      const commits = await listCompareCommits(repo, evt.oldSha, evt.newSha);
      if (commits.length === 0) {
        commitsBlock = `_(no commits between ${evt.oldSha} and ${evt.newSha})_`;
      } else {
        commitsBlock = commits
          .map((c) => `• \`${c.sha.slice(0, 7)}\` ${c.subject}`)
          .join("\n");
      }
    } catch (err) {
      log.warn(`[ha-deploy-watcher] Could not fetch commits ${evt.oldSha}..${evt.newSha}: ${(err as Error).message}`);
      commitsBlock = `_(commit list unavailable — see compare link)_`;
    }

    const header = evt.configError?.includes('] WARNING:')
      ? `:warning: home-assistant-config deployed with warnings`
      : evt.configError
        ? `:x: home-assistant-config deploy failed`
        : `:rocket: home-assistant-config deployed`;

    const msgLines = [
      header,
      `*Commits:*`,
      commitsBlock,
      `*Compare:* ${compareUrl}`,
      "```",
      evt.diffstat,
      "```",
    ];
    if (evt.configError) {
      const isWarning = evt.configError.includes('] WARNING:');
      const label = isWarning ? '*Config check warning:*' : '*Config check error:*';
      const icon = isWarning ? ':warning:' : ':x:';
      msgLines.push(`${icon} ${label}`, "```", evt.configError, "```");
    }
    notify(msgLines.join("\n"));
    const severity = evt.configError
      ? (evt.configError.includes('] WARNING:') ? " (config check warning)" : " (config check error)")
      : "";
    log.info(`[ha-deploy-watcher] Notified for ${evt.oldSha}..${evt.newSha}${severity}`);
  }

  upsertHaDeployWatcherState(slug, latest.newSha, Date.now());
}

/** Shared tool-context strings injected into agent prompts. */

import { HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_CONFIG_REPO } from "../config.js";
import * as gh from "../github.js";
import { guardContent, type makeGuardCtx } from "../prompt-guard.js";

export const KUBECTL_CONTEXT = `\`kubectl\` is available on this host with read-only access to the k3s cluster. Use it to inspect pod status, logs, and cluster resources when relevant to the issue (especially for fleet-services and fleet-infrastructure repositories).`;

export const NAMEY_DB_CONTEXT = `The \`namey_query\` MCP tool is available to run read-only SQL queries against the namey production PostgreSQL database. Use it when you need production data (user counts, name popularity stats, usage patterns, etc.) to inform your analysis.`;

export const FAST_CHECKS_GUIDANCE = `When verifying your changes, prefer fast local checks (type-check, lint, unit tests) over slow ones. Do NOT run integration tests, end-to-end tests, anything that requires Docker, or anything that requires external services or network access — CI will run those after the PR is opened. Skipping slow checks here keeps Claws throughput high; CI is the source of truth for the slow stuff.`;

/** Variant for ci-fixer: the PR is already open, so CI reruns automatically rather than "after the PR is opened". */
export const CI_FIXER_FAST_CHECKS_GUIDANCE = `When verifying your changes, prefer fast local checks (type-check, lint, unit tests) over slow ones. Do NOT run integration tests, end-to-end tests, anything that requires Docker, or anything that requires external services or network access — CI will rerun automatically once you push your fix. Skipping slow checks here keeps Claws throughput high; CI is the source of truth for the slow stuff.`;

export const RUNNER_POLICY_CONTEXT = `When working with GitHub Actions workflows, do NOT suggest or add GitHub-hosted runners (e.g. \`ubuntu-latest\`, \`ubuntu-22.04\`, \`windows-latest\`, \`windows-2022\`). This organization uses only self-hosted runners due to cost. The only exception is macOS jobs, which may use GitHub-hosted macOS runners (e.g. \`macos-latest\`, \`macos-14\`). Always use \`self-hosted\` (or the existing self-hosted runner labels already present in the repository's workflows) for Linux and Windows jobs. When using \`self-hosted\` runners, always include an OS label so jobs are scheduled onto the right runner: \`runs-on: [self-hosted, linux]\` for Linux jobs and \`runs-on: [self-hosted, macos]\` for macOS jobs. A bare \`runs-on: self-hosted\` is not acceptable.`;

export function homeAssistantContext(): string {
  return `The home-assistant-config repo (${HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config"}) is version-controlled YAML that the HA instance pulls via the hassio-addons/addon-git-pull addon — automations, scripts, scenes, dashboards, and templates live there. To inspect live entity state, recent events, or trigger services for debugging, use the Home Assistant REST API at ${HOME_ASSISTANT_BASE_URL}/api/ with a Bearer token from the CLAWS_HOME_ASSISTANT_TOKEN env var (already set on this host). Read-only endpoints: GET /api/states, GET /api/states/{entity_id}, GET /api/logbook, GET /api/error_log. Use curl with the token; do NOT echo the token in logs or commit it. When this MCP server is configured you also have two structured tools: \`ha_list_entities\` (discover entity IDs/state, filterable by domain or search) and \`ha_api_request\` (call any HA REST endpoint — states, services, config, template render, history, logbook, error_log, or POST a service call). Prefer these over raw curl; they handle auth and truncation for you.`;
}

/**
 * Formats issue/PR comments into prompt lines for an agent. Self-authored Claws
 * comments are stripped of their marker but NOT guarded (guarding produces false
 * positives on Claws-generated security/plan content); all other comments have
 * their body passed through guardContent to neutralise prompt-injection.
 * Returns flat prompt lines suitable for spreading into a `[...].join("\n")` array.
 */
export function formatIssueCommentsForPrompt(
  comments: gh.IssueComment[],
  selfLogin: string,
  guardCtx: ReturnType<typeof makeGuardCtx>,
): string[] {
  return comments.flatMap((c) => {
    const isClaws = c.login === selfLogin && gh.isClawsComment(c.body);
    const label = isClaws
      ? `Comment by @${c.login} (automated by Claws):`
      : `Comment by @${c.login}:`;
    const stripped = gh.stripClawsMarker(c.body);
    // Self-authored Claws comments are not an injection risk; guarding produces false positives.
    const body = isClaws ? stripped : guardContent(stripped, guardCtx("issue-comment"));
    return [`---`, label, body, ``];
  });
}

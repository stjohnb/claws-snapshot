/** Shared tool-context strings injected into agent prompts. */

import { HOME_ASSISTANT_CONFIG_REPO } from "../config.js";
import * as gh from "../github.js";
import { guardContent, type makeGuardCtx } from "../prompt-guard.js";

export const KUBECTL_CONTEXT = `\`kubectl\` is available on this host with read-only access to the k3s cluster. Use it to inspect pod status, logs, and cluster resources when relevant to the issue (especially for fleet-services and fleet-infrastructure repositories).`;

export const NAMEY_DB_CONTEXT = `The \`namey_query\` MCP tool is available to run read-only SQL queries against the namey production PostgreSQL database. Use it when you need production data (user counts, name popularity stats, usage patterns, etc.) to inform your analysis.`;

export const FAST_CHECKS_GUIDANCE = `When verifying your changes, prefer fast local checks (type-check, lint, unit tests) over slow ones. Do NOT run integration tests, end-to-end tests, anything that requires Docker, or anything that requires external services or network access — CI will run those after the PR is opened. Skipping slow checks here keeps Claws throughput high; CI is the source of truth for the slow stuff.`;

/** Variant for ci-fixer: the PR is already open, so CI reruns automatically rather than "after the PR is opened". */
export const CI_FIXER_FAST_CHECKS_GUIDANCE = `When verifying your changes, prefer fast local checks (type-check, lint, unit tests) over slow ones. Do NOT run integration tests, end-to-end tests, anything that requires Docker, or anything that requires external services or network access — CI will rerun automatically once you push your fix. Skipping slow checks here keeps Claws throughput high; CI is the source of truth for the slow stuff.`;

export const RUNNER_POLICY_CONTEXT = `When working with GitHub Actions workflows, do NOT suggest or add GitHub-hosted runners (e.g. \`ubuntu-latest\`, \`ubuntu-22.04\`, \`windows-latest\`, \`windows-2022\`, \`macos-latest\`, \`macos-14\`). This organization uses only self-hosted runners due to cost — this now includes macOS. Always use \`self-hosted\` runners (or the existing self-hosted runner labels already present in the repository's workflows) with an OS label so jobs are scheduled onto the right runner: \`runs-on: [self-hosted, linux]\` for Linux/Windows jobs and \`runs-on: [self-hosted, macos]\` for macOS jobs. A bare \`runs-on: self-hosted\` is not acceptable.`;

export const REVIEW_VERIFICATION_CONTEXT = `You are running inside the PR's own git worktree with full tool access (Bash, Read, Grep). The file contents pre-loaded above are the POST-CHANGE state — this PR's diff is ALREADY applied to them, so seeing the change present in a file is expected and does NOT mean it is redundant, already committed, or already merged. Before you assert ANY claim about git history — that a change is already merged, what commit is at the tip of the base branch, commit SHAs, or ancestry — you MUST verify it with git in this worktree (e.g. \`git rev-parse origin/<base-branch>\`, \`git log --oneline origin/<base-branch> -5\`, \`git merge-base --is-ancestor <sha> origin/<base-branch>\`). Never state a SHA or merge fact you have not just checked; confidently-wrong "this is already merged, close it" reviews have come from guessing instead of checking. This is a READ-ONLY review: use git/read to inspect, but do NOT modify, stage, commit, or push any file — your only output is the review text.`;

export function homeAssistantContext(): string {
  return `The home-assistant-config repo (${HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config"}) is version-controlled YAML that the HA instance pulls via the hassio-addons/addon-git-pull addon — automations, scripts, scenes, dashboards, and templates live there. To inspect live entity state, recent events, config, render templates, or trigger services for debugging, use the two Home Assistant MCP tools available in this session: \`ha_list_entities\` (discover entity IDs with current state and friendly name, filterable by domain such as 'sensor'/'light' or a search substring) and \`ha_api_request\` (call any HA REST endpoint under /api/ — e.g. GET /api/states/{entity_id}, GET /api/logbook, GET /api/error_log, POST /api/template, or POST a service call). These tools authenticate automatically; the MCP server holds the HA credentials out-of-band. Do NOT expect a Home Assistant token in your shell environment and do NOT try to curl the HA API with an env-var token — the token is deliberately withheld from the shell for security, so a curl-based approach fails with a missing token. Always use \`ha_list_entities\` / \`ha_api_request\` instead. Never print or commit any credential.`;
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

/** Shared tool-context strings injected into agent prompts. */

import fs from "node:fs";
import path from "node:path";
import { HOME_ASSISTANT_CONFIG_REPO } from "../config.js";
import * as gh from "../github.js";
import { guardContent, type makeGuardCtx } from "../prompt-guard.js";

export const KUBECTL_CONTEXT = `\`kubectl\` is available on this host with read-only access to the k3s cluster. Use it to inspect pod status, logs, and cluster resources when relevant to the issue (especially for fleet-services and fleet-infrastructure repositories).`;

export const NAMEY_DB_CONTEXT = `The \`namey_query\` MCP tool is available to run read-only SQL queries against the namey production PostgreSQL database. Use it when you need production data (user counts, name popularity stats, usage patterns, etc.) to inform your analysis.`;

export const FAST_CHECKS_GUIDANCE = `Verify with fast local checks (type-check, lint, unit tests). Leave anything slow to CI — integration and end-to-end tests, Docker, and anything needing network or external services. CI is the source of truth for those and runs after the PR is opened.`;

/** Variant for ci-fixer: the PR is already open, so CI reruns automatically rather than "after the PR is opened". */
export const CI_FIXER_FAST_CHECKS_GUIDANCE = `Verify with fast local checks (type-check, lint, unit tests). Leave anything slow to CI — integration and end-to-end tests, Docker, and anything needing network or external services. CI is the source of truth for those and reruns automatically once you push your fix.`;

export const RUNNER_LABEL_POLICY = `This organisation runs only self-hosted runners. Any GitHub Actions job you add or edit must use \`runs-on: [self-hosted, linux]\` (Linux and Windows work) or \`runs-on: [self-hosted, macos]\` — an OS label is always required, and a bare \`runs-on: self-hosted\` is not acceptable. GitHub-hosted labels (\`ubuntu-latest\`, \`windows-latest\`, \`macos-latest\`, and friends) are never acceptable.`;

/**
 * What the linux runner pool can and cannot do, and where CI dependencies come
 * from. The org model (2026-08-05): runners are self-hosted NixOS machines that
 * provide only a baseline, and each repo owns its CI dependencies via its own
 * flake.nix devShells — isolated in the nix store, so repos with conflicting
 * toolchains share the same runner machines. `St-John-Software/claws` is the
 * reference implementation.
 */
export const RUNNER_ENVIRONMENT_POLICY = `A job with \`runs-on: [self-hosted, linux]\` lands on a self-hosted NixOS runner (or an Ubuntu-with-nix box mid-conversion). There is no \`apt\`, no \`apt-get\`, no \`dpkg\`, no \`dpkg-query\` and no \`sudo\` on a NixOS runner, so a step using any of them dies with \`command not found\`. Making an install failure fatal ("add \`|| exit 1\` so it propagates") is not a fix; the step has to be deleted. Never propose or commit \`apt-get install\`, \`sudo\`, \`dpkg\`, \`nix-env -i\`, or a hard-coded \`/nix/store/...\` path glob in a workflow.
CI dependencies are REPO-OWNED. Beyond the runner baseline (\`nix\`, \`git\`, \`docker\`), every tool a workflow shells out to must come from the repo's own \`flake.nix\` devShell, with run steps executed inside it via \`nix develop --command ...\` (or a job-level \`defaults.run.shell\` of \`nix develop <workspace>#<shell> --command bash -euo pipefail {0}\`). Put the runner's nix on PATH first and don't assume flakes are enabled in its nix.conf — copy the \`.github/actions/setup-nix\` composite action and the \`NIX_FLAGS\` env from \`St-John-Software/claws\`, the reference implementation. Do not use \`actions/setup-node\` or other setup-* actions that download prebuilt dynamically-linked binaries; take the toolchain from the devShell instead. If CI lacks a tool, add it to that repo's devShell in the same PR — never ask for it to be installed on the runner, and in a repo with no \`flake.nix\` yet, create one following claws' pattern. Only a broken runner baseline (no working \`nix\` on the box) is an issue for \`St-John-Software/nixos-config\` (https://github.com/St-John-Software/nixos-config/issues).
During the transition the runner hosts still carry a wider legacy package set (plus \`nix-ld\`, under which downloaded browser binaries — headless Chrome, Playwright, Cypress/Electron — resolve their shared libraries with no system-dependency step). Do not add new dependencies on that legacy set; it is being retired as repos convert to their own flakes. If a workflow must probe for a tool, probe with \`command -v <tool>\` only — \`dpkg -s\`/\`dpkg-query -W\` return non-zero on NixOS even when the tool works, the probe-then-install misfire that broke \`dot-files\`, \`namey\` and \`3d-models\`.`;

export const RUNNER_POLICY_CONTEXT = `${RUNNER_LABEL_POLICY}\n\n${RUNNER_ENVIRONMENT_POLICY}`;

/**
 * Fallback frontend guidance, used only when the repo has no design doc of its
 * own. Prefer `frontendContext(wtPath)` at call sites — it swaps this whole
 * block for a one-line pointer when the repo already documents its design system.
 */
export const FRONTEND_AESTHETICS_CONTEXT = `<frontend_aesthetics>
Only if this task touches user-facing HTML/CSS/UI — otherwise ignore this section and restyle nothing.
This repo has no design guidelines, so make deliberate choices rather than the generic model defaults: a distinctive typeface (never Inter, Roboto, Open Sans, Lato, Arial, or a bare system stack) with strong weight and size contrast; one cohesive palette as CSS custom properties with a single accent, never purple gradients on white; a layered or patterned background rather than a flat fill; motion sparingly or not at all, CSS-only and behind a prefers-reduced-motion guard. Restyle only what the task asks for. Record the choices you make in \`docs/DESIGN.md\` in the same change.
</frontend_aesthetics>`;

/** Design docs checked, in priority order, by `frontendContext`. */
const DESIGN_DOC_CANDIDATES = ["docs/DESIGN.md", "DESIGN.md", ".claude/rules/frontend.md"];

/**
 * Progressive disclosure for frontend guidance: when the repo checked out at
 * `wtPath` already documents its design system, ship a short pointer at that
 * doc instead of the full anti-slop block. Falls back to
 * `FRONTEND_AESTHETICS_CONTEXT` when no design doc exists (including when
 * `wtPath` does not exist at all).
 */
export function frontendContext(wtPath: string): string {
  const found = DESIGN_DOC_CANDIDATES.find((rel) => fs.existsSync(path.join(wtPath, rel)));
  if (!found) return FRONTEND_AESTHETICS_CONTEXT;
  return `<frontend_aesthetics>
Only if this task touches user-facing HTML/CSS/UI: \`${found}\` is authoritative — read it and follow its typeface, colour tokens, spacing and motion rules. Do not introduce a competing style and do not restyle pages the task did not ask you to touch.
</frontend_aesthetics>`;
}

export const REVIEW_VERIFICATION_CONTEXT = `You are in the PR's own worktree with full tool access. The file contents above are the POST-CHANGE state — this PR's diff is already applied, so seeing the change present does not mean it is redundant or already merged. Verify every claim about git history with git before you make it (\`git rev-parse origin/<base>\`, \`git log --oneline origin/<base> -5\`, \`git merge-base --is-ancestor <sha> origin/<base>\`); confidently-wrong "this is already merged, close it" reviews have come from guessing. This review is read-only: inspect freely, but do not modify, stage, commit, or push anything.`;

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

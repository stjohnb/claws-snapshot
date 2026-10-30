/** Shared tool-context strings injected into agent prompts. */

import fs from "node:fs";
import path from "node:path";
import { HOME_ASSISTANT_CONFIG_REPO, forgejoRepoUrl, type Repo } from "../config.js";
import * as gh from "../github.js";
import { readRepoAgentDoc } from "../claude.js";
import * as log from "../log.js";
import { mapWithConcurrency } from "../util.js";
import { guardContent, type makeGuardCtx } from "../prompt-guard.js";
import { OBSERVABILITY_CONTEXT, OBSERVABILITY_DOC_PATHS, POLICY_VERIFICATION_CONTEXT, findObservabilitySection, missingObservabilityRules } from "../observability-contract.js";
export { HOST_EXECUTION_POLICY, REPO_DOCS_CONTEXT } from "../host-policy.js";

export const FAST_CHECKS_GUIDANCE = `Install and verify locally before you finish: \`npm ci\` (dev dependencies install with no extra flags; native modules build only for packages approved in \`package.json\` \`allowScripts\`), then the checks the repo itself defines — type-check/build and unit tests, plus lint only when the repo has a lint script — — the whole suite when it finishes in a few minutes, otherwise the tests covering the files you changed, named explicitly. In a repo with a Taskfile or flake run \`nix develop -c task validate\` or the repo's \`scripts/check-*.sh\`. Leave to CI: end-to-end and browser tests, container image builds, and anything needing a live app, a cluster or external services; CI is the source of truth for those.`;

/** Variant for ci-fixer: the PR is already open, so CI reruns automatically rather than "after the PR is opened". */
export const CI_FIXER_FAST_CHECKS_GUIDANCE = `Install and verify locally before you finish: \`npm ci\` (dev dependencies install with no extra flags; native modules build only for packages approved in \`package.json\` \`allowScripts\`), then the checks the repo itself defines — type-check/build and unit tests, plus lint only when the repo has a lint script — — the whole suite when it finishes in a few minutes, otherwise the tests covering the files you changed, named explicitly. In a repo with a Taskfile or flake run \`nix develop -c task validate\` or the repo's \`scripts/check-*.sh\`. Leave to CI: end-to-end and browser tests, container image builds, and anything needing a live app, a cluster or external services; CI is the source of truth for those and reruns automatically once you push your fix.`;

export const RUNNER_LABEL_POLICY = `This organisation runs only self-hosted runners. On Forgejo every job picks a runner family with an explicit label: \`runs-on: [container, linux]\` for the in-cluster container runners (the default for Linux work), or \`runs-on: [host, nixos, …]\` / \`[host, macos, …]\` for host-mode runners (tailnet access or Xcode only). Add \`ram-<N>g\`, \`disk-<N>g\` or \`gpu\` to a container job only when it needs it, at the smallest tier that fits; tiers above the always-on runner's wait for an on-demand host. Forgejo jobs never use \`self-hosted\` or \`beefy\`. The label families, each runner's tiers and how to choose labels are in https://git.home.bstjohn.net/St-John-Software/fleet-infra/src/branch/main/docs/runner-labels.md. GitHub-hosted labels (\`ubuntu-latest\`, \`windows-latest\`, \`macos-latest\`, and friends) are never acceptable. The single exception is a workflow whose entire purpose requires GitHub's own infrastructure — e.g. provisioning a self-hosted runner while the self-hosted pool is down, where a self-hosted job would queue behind the very outage it exists to end. Such a file must carry a \`# claws-allow-github-hosted-runner: <reason>\` comment line, and Claws' scanner then skips it. Never add that marker to work around a self-hosted job that merely fails or is slow, and never change a \`runs-on:\` in a file that already carries the marker.`;

/**
 * What the linux runner pool can and cannot do, and where CI dependencies come
 * from. The org model (2026-08-05): runners are self-hosted NixOS machines that
 * provide only a baseline, and each repo owns its CI dependencies via its own
 * flake.nix devShells — isolated in the nix store, so repos with conflicting
 * toolchains share the same runner machines. `St-John-Software/claws` is the
 * reference implementation.
 */
export const RUNNER_ENVIRONMENT_POLICY = `A Linux job (\`runs-on: [container, linux]\` or \`[host, nixos, …]\`) lands on a self-hosted NixOS runner (or an Ubuntu-with-nix box mid-conversion). There is no \`apt\`, no \`apt-get\`, no \`dpkg\`, no \`dpkg-query\` and no \`sudo\` on a NixOS runner, so a step using any of them dies with \`command not found\`. Making an install failure fatal ("add \`|| exit 1\` so it propagates") is not a fix; the step has to be deleted. Never propose or commit \`apt-get install\`, \`sudo\`, \`dpkg\`, \`nix-env -i\`, or a hard-coded \`/nix/store/...\` path glob in a workflow.
CI dependencies are REPO-OWNED. Beyond the runner baseline (\`nix\`, \`git\`, \`docker\`), every tool a workflow shells out to must come from the repo's own \`flake.nix\` devShell, with run steps executed inside it via \`nix develop --command ...\` (or a job-level \`defaults.run.shell\` of \`nix develop <workspace>#<shell> --command bash -euo pipefail {0}\`). Put the runner's nix on PATH first and don't assume flakes are enabled in its nix.conf — copy the \`.github/actions/setup-nix\` composite action (https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/.github/actions/setup-nix) and the \`NIX_FLAGS\` env from \`.forgejo/workflows/ci.yml\` (https://git.home.bstjohn.net/St-John-Software/claws/src/branch/main/.forgejo/workflows/ci.yml) in \`St-John-Software/claws\` on Forgejo, the reference implementation. Do not use \`actions/setup-node\` or other setup-* actions that download prebuilt dynamically-linked binaries; take the toolchain from the devShell instead. If CI lacks a tool, add it to that repo's devShell in the same PR — never ask for it to be installed on the runner, and in a repo with no \`flake.nix\` yet, create one following claws' pattern. Only a broken runner baseline (no working \`nix\` on the box) is an issue for \`St-John-Software/nixos-config\`, filed with \`claws_create_issue\`.
During the transition the runner hosts still carry a wider legacy package set (plus \`nix-ld\`, under which downloaded browser binaries — headless Chrome, Playwright, Cypress/Electron — resolve their shared libraries with no system-dependency step). Do not add new dependencies on that legacy set; it is being retired as repos convert to their own flakes. If a workflow must probe for a tool, probe with \`command -v <tool>\` only — \`dpkg -s\`/\`dpkg-query -W\` return non-zero on NixOS even when the tool works, the probe-then-install misfire that broke \`dot-files\`, \`namey\` and \`3d-models\`.`;

export const RUNNER_POLICY_CONTEXT = `${RUNNER_LABEL_POLICY}\n\n${RUNNER_ENVIRONMENT_POLICY}`;

/**
 * Claws never stacks PRs (#2720). A PR whose base is another PR's branch carries
 * that PR's whole diff, so the reviewer sees a duplicate and the merge order is
 * fragile. Injected into every agent that could otherwise open or retarget a PR.
 */
export const NO_STACKED_PRS_POLICY = `Claws never stacks pull requests. Every PR Claws opens targets the repository's default branch, and the base branch of an existing PR must never be changed — do NOT retarget it, and do NOT suggest retargeting a PR's base as a remedy. If a change belongs on an already-open PR's branch, the correct action is to commit it onto that branch so the existing PR picks it up; if it stands alone, it targets the default branch. There is no third option.`;

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

/**
 * Progressive disclosure for observability guidance, mirroring
 * `frontendContext`: when the repo checked out at `wtPath` declares an
 * observability policy, ship a short pointer at it instead of the fallback
 * block. Checks `OBSERVABILITY_DOC_PATHS` in the order the
 * `observability-contract-scanner` uses: `docs/observability.md` counts
 * whenever it exists (the whole file is the policy); `AGENTS.md` and
 * `docs/logging.md` count when they have a policy section (an observability,
 * telemetry, monitoring or logging heading) or are compliant outright (e.g. a
 * fenced verbatim paste of the template). Falls back to
 * `OBSERVABILITY_CONTEXT` otherwise (including when `wtPath` does not exist).
 */
export function observabilityContext(wtPath: string): string {
  const found = OBSERVABILITY_DOC_PATHS.find((doc) => {
    const abs = path.join(wtPath, doc.path);
    if (!fs.existsSync(abs)) return false;
    if (doc.wholeDocument) return true;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf-8");
    } catch {
      return false;
    }
    return findObservabilitySection(text) !== null || missingObservabilityRules(text).length === 0;
  });
  if (!found) return OBSERVABILITY_CONTEXT;
  return `<observability>
This repo's observability policy is in \`${found.path}\`. Consult it before adding an HTTP route, DB query, background job, external call or log line. A plan names the logs, metrics, spans, latency budget and alert the policy requires for each such change; an implementation adds them in the same PR; a review flags any such change that skips them. Log output is structured JSON lines on stdout through the repo's shared logger, never a new bare \`console.log\`.
${POLICY_VERIFICATION_CONTEXT}
</observability>`;
}

/**
 * Tells an agent that its repo, like every repo Claws manages, lives on
 * Forgejo. Claws itself does every forge write (push, PR, comments) through
 * the `github.ts` façade, so the agent never needs a forge CLI — it just needs
 * to stop reaching for `gh` (#2650).
 */
export function forgeContext(repo: Repo): string {
  return `<forge>
This repository is hosted on Forgejo at ${forgejoRepoUrl(repo.fullName)}. Forgejo owns issues, pull requests, CI, and \`main\`; Claws manages no work on GitHub, and any GitHub copy of this repo is archived or a public snapshot that must never be treated as authoritative.

- Do NOT use \`gh\` to read or write anything about this repo — issues, PRs, checks, runs, or comments. The issue, PR, review, and CI context in this prompt is the authoritative state.
- CI runs on Forgejo Actions from workflows in \`.forgejo/workflows/\`, not \`.github/workflows/\`.
- To read a Forgejo Actions run's log, call the \`claws_forgejo_job_logs\` tool with \`repo\` and \`run\` (the number in \`/actions/runs/<n>\`); it returns the failed steps of the failed jobs.
- Forgejo Actions run state: \`GET $CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/actions/runs?status=waiting&limit=50\` with \`$CLAWS_FORGEJO_READ_TOKEN\`; each run carries \`index_in_repo\`, \`status\`, \`created\` and \`started\` (\`0001-01-01…\` until it starts). Runner-registry routes are admin-only; read job logs with \`claws_forgejo_job_logs\`.
- Do not add a GitHub remote and do not push anywhere yourself. Claws pushes your branch and opens the pull request on Forgejo for you; \`origin\` already points at Forgejo.
- Never commit a core dump (\`core\`, \`core.<pid>\`) or a new file over a few MB. Claws refuses to push such a commit and the run fails.
</forge>`;
}

export const REVIEW_VERIFICATION_CONTEXT = `You are in the PR's own worktree with full tool access. The file contents above are the POST-CHANGE state — this PR's diff is already applied, so seeing the change present does not mean it is redundant or already merged. Verify every claim about git history with git before you make it (\`git rev-parse origin/<base>\`, \`git log --oneline origin/<base> -5\`, \`git merge-base --is-ancestor <sha> origin/<base>\`); confidently-wrong "this is already merged, close it" reviews have come from guessing. This review is read-only: inspect freely, but do not modify, stage, commit, or push anything. The CI state at review time is supplied in this prompt: never wait for, poll, sleep on, \`--watch\`, or start a background task to observe checks. If CI is pending, report it as pending and write the review now — Claws gates the merge — approved or not — on CI separately.`;

export function homeAssistantContext(): string {
  return `The home-assistant-config repo (${HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config"}) is version-controlled YAML that the HA instance pulls via the hassio-addons/addon-git-pull addon — automations, scripts, scenes, dashboards, and templates live there. To inspect live entity state, recent events, config, render templates, or trigger services for debugging, use the two Home Assistant MCP tools available in this session: \`ha_list_entities\` (discover entity IDs with current state and friendly name, filterable by domain such as 'sensor'/'light' or a search substring) and \`ha_api_request\` (call any HA REST endpoint under /api/ — e.g. GET /api/states/{entity_id}, GET /api/logbook, GET /api/error_log, POST /api/template, or POST a service call). These tools authenticate automatically; the MCP server holds the HA credentials out-of-band. Do NOT expect a Home Assistant token in your shell environment and do NOT try to curl the HA API with an env-var token — the token is deliberately withheld from the shell for security, so a curl-based approach fails with a missing token. Always use \`ha_list_entities\` / \`ha_api_request\` instead. Never print or commit any credential.`;
}

/**
 * Formats issue/PR comments into prompt lines for an agent. Self-authored Claws
 * comments are stripped of their marker but NOT guarded (guarding produces false
 * positives on Claws-generated security/plan content); all other comments have
 * their body passed through guardContent to neutralise prompt-injection.
 * Returns flat prompt lines suitable for spreading into a `[...].join("\n")` array.
 *
 * Only the newest MAX_PROMPT_COMMENTS comments are rendered — `getIssueComments`
 * paginates, so a long thread would otherwise balloon the prompt. Callers that need
 * a specific older comment (`findPlanComment`, `loadPhaseCoverage`) read the raw array.
 */
export async function formatIssueCommentsForPrompt(
  comments: gh.IssueComment[],
  selfLogin: string,
  guardCtx: ReturnType<typeof makeGuardCtx>,
): Promise<string[]> {
  const MAX_PROMPT_COMMENTS = 60;
  const trimmed = comments.length > MAX_PROMPT_COMMENTS;
  const kept = trimmed ? comments.slice(-MAX_PROMPT_COMMENTS) : comments;
  const prefix = trimmed
    ? [`--- [${comments.length - MAX_PROMPT_COMMENTS} earlier comment(s) omitted]`]
    : [];
  const rendered = await mapWithConcurrency(kept, 4, async (c) => {
    const isClaws = c.login === selfLogin && gh.isClawsComment(c.body);
    const label = isClaws
      ? `Comment by @${c.login} (automated by Claws):`
      : `Comment by @${c.login}:`;
    const stripped = gh.stripClawsMarker(c.body);
    // Self-authored Claws comments are not an injection risk; guarding produces false positives.
    const body = isClaws ? stripped : await guardContent(stripped, guardCtx("issue-comment"));
    return [`---`, label, body, ``];
  });
  return prefix.concat(rendered.flat());
}

/**
 * Load a repo's role document for injection via `RunClaudeOptions.appendSystemPrompt`,
 * logging which document a run picked up and warning when there is none.
 *
 * The canonical location is `.agents/<role>.md` in the repository itself; when it is
 * absent — or present but empty, which `readRepoAgentDoc` reports identically — the
 * agent runs with no repo-specific guidance, and this log line is what makes that
 * readable off a past run.
 *
 * Alerting is deliberately left to `jobs/claude-config-scanner.ts`, which scans every
 * repo daily and files one per-repo issue naming exactly which `.agents/<role>.md`
 * files it is missing. A missing role document is persistent state, not an episodic
 * failure, so reporting it from here would alert at dispatcher cadence forever.
 */
export function loadRepoAgentDoc(
  wtPath: string,
  repoFullName: string,
  role: string,
): string | undefined {
  const relPath = `.agents/${role}.md`;
  const body = readRepoAgentDoc(wtPath, role);
  if (body) {
    log.info(`[agent-doc] ${repoFullName}: loaded ${relPath} (${body.length} chars)`);
    return body;
  }
  log.warn(
    `[agent-doc] ${repoFullName}: no usable ${relPath} (missing or empty) — running without repo-specific guidance`,
  );
  return undefined;
}

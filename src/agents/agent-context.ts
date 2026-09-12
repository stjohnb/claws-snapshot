/** Shared tool-context strings injected into agent prompts. */

import fs from "node:fs";
import path from "node:path";
import { HOME_ASSISTANT_CONFIG_REPO, forgejoRepoUrl, type Repo } from "../config.js";
import * as gh from "../github.js";
import {
  getGitHubStatusSnapshot,
  getRecentDegradedWindows,
  isGitHubDegraded,
} from "../github-status.js";
import { guardContent, type makeGuardCtx } from "../prompt-guard.js";
export { HOST_EXECUTION_POLICY } from "../host-policy.js";

export const KUBECTL_CONTEXT = `\`kubectl\` is available on this host with read-only access to the k3s cluster. Use it to inspect pod status, logs, and cluster resources when relevant to the issue (especially for fleet-services and fleet-infrastructure repositories).`;

export const FAST_CHECKS_GUIDANCE = `Verify with fast local checks (type-check, lint, unit tests). Leave anything slow to CI — integration and end-to-end tests, Docker, and anything needing network or external services. CI is the source of truth for those and runs after the PR is opened.`;

/** Variant for ci-fixer: the PR is already open, so CI reruns automatically rather than "after the PR is opened". */
export const CI_FIXER_FAST_CHECKS_GUIDANCE = `Verify with fast local checks (type-check, lint, unit tests). Leave anything slow to CI — integration and end-to-end tests, Docker, and anything needing network or external services. CI is the source of truth for those and reruns automatically once you push your fix.`;

export const RUNNER_LABEL_POLICY = `This organisation runs only self-hosted runners. Any GitHub Actions job you add or edit must use \`runs-on: [self-hosted, linux]\` (Linux and Windows work) or \`runs-on: [self-hosted, macos]\` — an OS label is always required, and a bare \`runs-on: self-hosted\` is not acceptable. GitHub-hosted labels (\`ubuntu-latest\`, \`windows-latest\`, \`macos-latest\`, and friends) are never acceptable. The single exception is a workflow whose entire purpose requires GitHub's own infrastructure — e.g. provisioning a self-hosted runner while the self-hosted pool is down, where a \`[self-hosted, linux]\` job would queue behind the very outage it exists to end. Such a file must carry a \`# claws-allow-github-hosted-runner: <reason>\` comment line, and Claws' scanner then skips it. Never add that marker to work around a self-hosted job that merely fails or is slow, and never change a \`runs-on:\` in a file that already carries the marker.`;

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
 * Claws never stacks PRs (#2720). A PR whose base is another PR's branch carries
 * that PR's whole diff, so the reviewer sees a duplicate and the merge order is
 * fragile. Injected into every agent that could otherwise open or retarget a PR.
 */
export const NO_STACKED_PRS_POLICY = `Claws never stacks pull requests. Every PR Claws opens targets the repository's default branch, and the base branch of an existing PR must never be changed — do NOT run \`gh pr edit --base\`, and do NOT suggest retargeting a PR's base as a remedy. If a change belongs on an already-open PR's branch, the correct action is to commit it onto that branch so the existing PR picks it up; if it stands alone, it targets the default branch. There is no third option.`;

/** Canonical documentation for the shopping-sourcer manifest format. */
export const SHOPPING_MANIFEST_DOC_URL =
  "https://github.com/St-John-Software/claws/blob/main/docs/jobs/shopping-sourcer.md";

/**
 * Annotated \`docs/shopping/<slug>.yaml\` schema. Single source of truth — the
 * planner/implementer prompts embed it via SHOPPING_MANIFEST_CONTEXT and the
 * shopping-sourcer job embeds it in its malformed-manifest alert.
 */
export const SHOPPING_MANIFEST_TEMPLATE = `project: NAS expansion            # display title, required
active_phases: [1]                # phases currently unlocked for sourcing; default [1]
items:
  - id: hba-9207-8e               # stable slug, required, unique within the file
    name: LSI SAS 9207-8e HBA (IT mode)   # required
    phase: 1                      # default 1; items in a phase not listed in active_phases are not searched
    status: sourcing              # sourcing|found|ordered|delivered|skip; default sourcing
    max_price: "£40"              # optional free-text budget
    notes: >-                     # optional search hints for the sourcing agent
      Must be SAS2308 / 9207-8e, not 9200-8e. UK sellers preferred.
    recheck_days: 1               # optional, integer >= 1, default 1`;

/**
 * Teaches the planner and implementer that hardware purchasing/sourcing/tracking
 * issues are implemented as manifest edits, not as new automation. Injected
 * unconditionally (like KUBECTL_CONTEXT); its own text makes it conditional on
 * the issue's subject matter.
 */
export const SHOPPING_MANIFEST_CONTEXT = `<shopping_manifests>
Claws has a built-in hardware-shopping feature. A daily \`shopping-sourcer\` job reads \`docs/shopping/*.yaml\` manifests in this repository, searches marketplaces (with a real browser, so eBay-style sites work) for every item with \`status: sourcing\` in an unlocked phase, and maintains a single consolidated \`[shopping]\` tracking issue in the claws repo covering every repo's manifests, listing candidates for human approval; purchases and payment are made manually by the owner.

**If this issue is about acquiring, purchasing, sourcing, or tracking hardware/equipment — or about changing purchasing state (unlocking a phase, marking items ordered/delivered, adding or removing items) — the correct implementation is to create or edit a \`docs/shopping/<kebab-slug>.yaml\` manifest, NOT to build sourcing scripts, scrapers, or new automation.** Claws already does the sourcing.

Carry budgets into \`max_price\`, constraints and model-number caveats into \`notes\`, and staged purchasing into \`phase\`/\`active_phases\` (a phase not listed in \`active_phases\` stays gated and is never searched). Set \`status\` to \`ordered\`/\`delivered\` when the owner reports buying or receiving an item, and to \`found\`/\`skip\` to stop searching for it. For a plan whose only change is adding or editing a manifest, recommend the \`cheap\` implementation model and embed the exact final YAML content in the plan.

Schema:

\`\`\`yaml
${SHOPPING_MANIFEST_TEMPLATE}
\`\`\`

Full documentation: ${SHOPPING_MANIFEST_DOC_URL}
</shopping_manifests>`;

/** Canonical documentation for the site-promoter manifest format. */
export const PROMOTION_MANIFEST_DOC_URL =
  "https://github.com/St-John-Software/claws/blob/main/docs/jobs/site-promoter.md";

/**
 * Annotated \`docs/promotion/<slug>.yaml\` schema. Single source of truth — the
 * planner/implementer prompts embed it via PROMOTION_MANIFEST_CONTEXT, the
 * site-promoter job embeds it in its malformed-manifest alert, and
 * \`docs/jobs/site-promoter.md\` reproduces it verbatim.
 */
export const PROMOTION_MANIFEST_TEMPLATE = `project: Namey                    # display title, required
sites:
  - id: namey-baby                # stable slug, required, unique within the file
    name: Namey (baby names)      # required
    url: https://namey.baby/      # required, must be a full URL
    status: active                # active|paused; default active
    audience: >-                  # optional — who you are trying to reach
      Expectant parents shortlisting baby names.
    pitch: >-                     # optional — what the site is, in one or two sentences
      Baby-name discovery and shortlisting app.
    channels:                     # channels this site is marketed on
      - seo-content               # a bare id uses the built-in cadence
      - bluesky
      - id: reddit                # or an object to override
        cadence_days: 30          # optional, integer >= 1
        notes: >-                 # optional — the owner's rules for this channel
          Only r/namenerds; no link in the post body.
      - id: guest-blog
        target_repo: St-John-Software/bstjohn-blog   # optional; default is this repo`;

/**
 * Teaches the planner and implementer that "promote/market this website" issues
 * are implemented as promotion-manifest edits, not as new marketing automation.
 * Injected unconditionally (like SHOPPING_MANIFEST_CONTEXT); its own text makes
 * it conditional on the issue's subject matter.
 */
export const PROMOTION_MANIFEST_CONTEXT = `<promotion_manifests>
Claws has a built-in website-promotion feature. A daily \`site-promoter\` job reads \`docs/promotion/*.yaml\` manifests in this repository and, for each site whose channels are due, runs a growth-marketing agent inside a worktree of this repo and files at most two issues: code-implementable channels file unlabelled (the normal Claws pipeline builds them), and manual channels file with \`Claws Ignore\` and contain ready-to-post copy for a human.

**If this issue is about promoting or marketing this project's website — or about adding, removing or adjusting a marketing channel, its cadence, or its posting rules — the correct implementation is to create or edit a \`docs/promotion/<kebab-slug>.yaml\` manifest, NOT to build promotion scripts, posting bots, or new automation.** Claws already does the promotion.

Valid channel ids: \`seo-content\`, \`aeo\`, \`free-tool\`, \`share-cards\`, \`guest-blog\` (implemented as code changes), and \`reddit\`, \`x\`, \`bluesky\`, \`instagram\`, \`tiktok\`, \`youtube-shorts\`, \`pinterest\`, \`hacker-news\`, \`product-hunt\`, \`directories\`, \`newsletter\` (drafted for a human to post). A channel is listed either as a bare id (built-in cadence) or as an object with optional \`cadence_days\`, \`notes\` (the owner's rules for that channel, passed to the agent verbatim) and \`target_repo\` (file that channel's issues into another repo — it must be a Claws-managed repo, or the channel is skipped). Set a site's \`status\` to \`paused\` to stop promoting it without deleting it. For a plan whose only change is adding or editing a manifest, recommend the \`cheap\` implementation model and embed the exact final YAML content in the plan.

Schema:

\`\`\`yaml
${PROMOTION_MANIFEST_TEMPLATE}
\`\`\`

Full documentation: ${PROMOTION_MANIFEST_DOC_URL}
</promotion_manifests>`;

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
 * Tells an agent working in a Forgejo-hosted repo that GitHub is a stale
 * read-only mirror. Empty for GitHub repos, so call sites can append it
 * unconditionally. Claws itself does every forge write (push, PR, comments)
 * through `github.ts`'s Forgejo routing, so the agent never needs a forge CLI —
 * it just needs to stop reaching for `gh` (#2650).
 */
export function forgeContext(repo: Repo): string {
  if (repo.forge !== "forgejo") return "";
  return `<forge>
This repository is hosted on Forgejo at ${forgejoRepoUrl(repo.fullName)}, not on GitHub. Forgejo owns issues, pull requests, CI, and \`main\`; the GitHub repo of the same name is a read-only push mirror that lags behind and must never be treated as authoritative.

- Do NOT use \`gh\` to read or write anything about this repo — issues, PRs, checks, runs, or comments. It would show you the stale mirror. The issue, PR, review, and CI context in this prompt is the authoritative state.
- CI runs on Forgejo Actions from workflows in \`.forgejo/workflows/\`, not \`.github/workflows/\`.
- Do not add a GitHub remote and do not push anywhere yourself. Claws pushes your branch and opens the pull request on Forgejo for you; \`origin\` already points at Forgejo.
</forge>`;
}

export const REVIEW_VERIFICATION_CONTEXT = `You are in the PR's own worktree with full tool access. The file contents above are the POST-CHANGE state — this PR's diff is already applied, so seeing the change present does not mean it is redundant or already merged. Verify every claim about git history with git before you make it (\`git rev-parse origin/<base>\`, \`git log --oneline origin/<base> -5\`, \`git merge-base --is-ancestor <sha> origin/<base>\`); confidently-wrong "this is already merged, close it" reviews have come from guessing. This review is read-only: inspect freely, but do not modify, stage, commit, or push anything.`;

export function homeAssistantContext(): string {
  return `The home-assistant-config repo (${HOME_ASSISTANT_CONFIG_REPO ?? "St-John-Software/home-assistant-config"}) is version-controlled YAML that the HA instance pulls via the hassio-addons/addon-git-pull addon — automations, scripts, scenes, dashboards, and templates live there. To inspect live entity state, recent events, config, render templates, or trigger services for debugging, use the two Home Assistant MCP tools available in this session: \`ha_list_entities\` (discover entity IDs with current state and friendly name, filterable by domain such as 'sensor'/'light' or a search substring) and \`ha_api_request\` (call any HA REST endpoint under /api/ — e.g. GET /api/states/{entity_id}, GET /api/logbook, GET /api/error_log, POST /api/template, or POST a service call). These tools authenticate automatically; the MCP server holds the HA credentials out-of-band. Do NOT expect a Home Assistant token in your shell environment and do NOT try to curl the HA API with an env-var token — the token is deliberately withheld from the shell for security, so a curl-based approach fails with a missing token. Always use \`ha_list_entities\` / \`ha_api_request\` instead. Never print or commit any credential.`;
}

export interface GitHubIncidentDescription {
  /** Raw poll result: true only when the underlying snapshot itself is currently degraded. */
  active: boolean;
  /**
   * True when `isGitHubDegraded()` is true only because of the post-recovery grace
   * window — the underlying snapshot has already recovered (403s/429s can still linger
   * for a few minutes). Mutually exclusive with `active`.
   */
  graceWindow: boolean;
  description: string;
  components: string;
  incidentName: string | null;
  url: string | null;
}

/**
 * Guards and shapes the current GitHub status for embedding in a prompt or comment.
 * Returns null when `isGitHubDegraded()` is false — nothing incident-related to say.
 * Distinguishes `active` (the raw poll is currently degraded) from `graceWindow`
 * (`isGitHubDegraded()` is still true only via the recovery grace period) so callers
 * never render a "CURRENTLY reporting an incident" message sourced from an
 * already-recovered snapshot. githubstatus.com strings are third-party text reaching
 * an agent prompt or a public comment, so every field here is guarded.
 */
export function describeGitHubIncident(
  guardCtx: ReturnType<typeof makeGuardCtx>,
): GitHubIncidentDescription | null {
  if (!isGitHubDegraded()) return null;

  const snapshot = getGitHubStatusSnapshot();
  const description = guardContent(snapshot.description ?? "degraded service", guardCtx("github-status"));
  const components =
    snapshot.degradedComponents.length > 0
      ? guardContent(snapshot.degradedComponents.join(", "), guardCtx("github-status"))
      : "unknown";
  const incidentName = snapshot.incident
    ? guardContent(snapshot.incident.name, guardCtx("github-status"))
    : null;
  const url = snapshot.incident?.url
    ? guardContent(snapshot.incident.url, guardCtx("github-status"))
    : null;

  return {
    active: snapshot.degraded,
    graceWindow: !snapshot.degraded,
    description,
    components,
    incidentName,
    url,
  };
}

/**
 * Prompt block describing GitHub's incident state. Returns null when GitHub is healthy
 * and no incident window overlaps the last 24h, so healthy-day prompts are unchanged.
 */
export function gitHubIncidentContext(guardCtx: ReturnType<typeof makeGuardCtx>): string | null {
  const windows = getRecentDegradedWindows();
  const incident = describeGitHubIncident(guardCtx);
  if (!incident && windows.length === 0) return null;

  const lines = ["<github_incident_status>"];

  if (incident?.active) {
    const incidentName = incident.incidentName ? ` Incident: ${incident.incidentName}.` : "";
    const url = incident.url ? ` ${incident.url}` : "";
    lines.push(
      `GitHub is CURRENTLY reporting an incident: ${incident.description}. Affected components: ${incident.components}.${incidentName}${url}`,
    );
  } else if (incident?.graceWindow) {
    const incidentName = incident.incidentName ? ` Incident: ${incident.incidentName}.` : "";
    const url = incident.url ? ` ${incident.url}` : "";
    lines.push(
      `GitHub reported an incident within the last few minutes and status may still be settling — last known status was "${incident.description}".${incidentName}${url} Treat GitHub-side failures with the same caution as an active incident until this window passes.`,
    );
  } else {
    lines.push(`GitHub is currently reporting normal service.`);
  }

  if (windows.length > 0) {
    lines.push(``, `Incident windows Claws observed recently (UTC):`);
    for (const w of windows) {
      lines.push(`- ${w.startedAt} → ${w.endedAt ?? "ongoing"}`);
    }
  }

  lines.push(
    ``,
    `During these windows GitHub-wide failures look like code or permission problems but are not — jobs dying in "Set up job", checkout/codeload 429s, \`Resource not accessible by integration\` 403s, sporadic 5xx from api.github.com, and intermittent auth failures. If a failure timestamp falls inside a window above, the correct conclusion is "GitHub incident — re-run once it clears", NOT a code fix, a workflow hardening change, or a permanent permission-model diagnosis. Only diagnose a permanent cause when the evidence is inconsistent with an incident (e.g. it reproduces deterministically outside the window).`,
    `</github_incident_status>`,
  );

  return lines.join("\n");
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
export function formatIssueCommentsForPrompt(
  comments: gh.IssueComment[],
  selfLogin: string,
  guardCtx: ReturnType<typeof makeGuardCtx>,
): string[] {
  const MAX_PROMPT_COMMENTS = 60;
  const trimmed = comments.length > MAX_PROMPT_COMMENTS;
  const kept = trimmed ? comments.slice(-MAX_PROMPT_COMMENTS) : comments;
  const prefix = trimmed
    ? [`--- [${comments.length - MAX_PROMPT_COMMENTS} earlier comment(s) omitted]`]
    : [];
  return prefix.concat(kept.flatMap((c) => {
    const isClaws = c.login === selfLogin && gh.isClawsComment(c.body);
    const label = isClaws
      ? `Comment by @${c.login} (automated by Claws):`
      : `Comment by @${c.login}:`;
    const stripped = gh.stripClawsMarker(c.body);
    // Self-authored Claws comments are not an injection risk; guarding produces false positives.
    const body = isClaws ? stripped : guardContent(stripped, guardCtx("issue-comment"));
    return [`---`, label, body, ``];
  }));
}

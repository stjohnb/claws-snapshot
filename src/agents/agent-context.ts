/** Shared tool-context strings injected into agent prompts. */

import fs from "node:fs";
import path from "node:path";
import { HOME_ASSISTANT_CONFIG_REPO } from "../config.js";
import * as gh from "../github.js";
import {
  getGitHubStatusSnapshot,
  getRecentDegradedWindows,
  isGitHubDegraded,
} from "../github-status.js";
import { guardContent, type makeGuardCtx } from "../prompt-guard.js";

export const KUBECTL_CONTEXT = `\`kubectl\` is available on this host with read-only access to the k3s cluster. Use it to inspect pod status, logs, and cluster resources when relevant to the issue (especially for fleet-services and fleet-infrastructure repositories).`;

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
Claws has a built-in hardware-shopping feature. A daily \`shopping-sourcer\` job reads \`docs/shopping/*.yaml\` manifests in this repository, searches marketplaces (with a real browser, so eBay-style sites work) for every item with \`status: sourcing\` in an unlocked phase, and maintains a \`[shopping]\` tracking issue listing candidates for human approval; purchases and payment are made manually by the owner.

**If this issue is about acquiring, purchasing, sourcing, or tracking hardware/equipment — or about changing purchasing state (unlocking a phase, marking items ordered/delivered, adding or removing items) — the correct implementation is to create or edit a \`docs/shopping/<kebab-slug>.yaml\` manifest, NOT to build sourcing scripts, scrapers, or new automation.** Claws already does the sourcing.

Carry budgets into \`max_price\`, constraints and model-number caveats into \`notes\`, and staged purchasing into \`phase\`/\`active_phases\` (a phase not listed in \`active_phases\` stays gated and is never searched). Set \`status\` to \`ordered\`/\`delivered\` when the owner reports buying or receiving an item, and to \`found\`/\`skip\` to stop searching for it. For a plan whose only change is adding or editing a manifest, recommend the \`cheap\` implementation model and embed the exact final YAML content in the plan.

Schema:

\`\`\`yaml
${SHOPPING_MANIFEST_TEMPLATE}
\`\`\`

Full documentation: ${SHOPPING_MANIFEST_DOC_URL}
</shopping_manifests>`;

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

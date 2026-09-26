import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HOME_ASSISTANT_BASE_URL,
  HOME_ASSISTANT_TOKEN,
  PROD_K8S_KUBECONFIG_PATH,
  FLEET_KUBECONFIG_PATH,
  FORGEJO_BASE_URL,
  FORGEJO_TOKEN,
  FORGEJO_READ_TOKEN,
  FORGEJO_ADMIN_TOKEN,
  isForgejoRepo,
  SESSION_BACKEND,
  OPENROUTER_API_KEY,
  GITHUB_APP_ID,
  GITHUB_OWNER_APP_CREDENTIALS,
  MAC_RUNNERS,
  type MacRunner,
} from "./config.js";
import { resolveIdentityFile } from "./util.js";
import { SENSITIVE_ENV_KEYS } from "./sensitive-env.js";
import type { SessionMode, SessionProvider } from "./sessions.js";

/**
 * A session capability bundles a set of credentials/environment variables that
 * can be explicitly granted to an interactive Claude session. Sessions are
 * default-deny: unless a capability is ticked, its env keys are stripped from
 * the spawned process.
 */
export const BROWSER_CAPABILITY_ID = "browser";

/** Mirrors `FORGEJO_GIT_CREDENTIAL_TOKEN_VAR` / `FORGEJO_GIT_CREDENTIAL_HELPER`
 *  in `github-app.ts` (lines 521-523). Duplicated deliberately: this module is
 *  kept to a tiny import surface (config, util, sensitive-env) so
 *  `capabilities.test.ts` can mock only `./config.js`. Keep the two in sync. */
const FORGEJO_GIT_CREDENTIAL_TOKEN_VAR = "CLAWS_FORGEJO_GIT_TOKEN";
const FORGEJO_GIT_CREDENTIAL_HELPER =
  '!f() { echo "username=oauth2"; echo "password=$CLAWS_FORGEJO_GIT_TOKEN"; }; f';
export const FORGEJO_CAPABILITY_ID = "forgejo";
export const CROSS_REPO_CAPABILITY_ID = "cross-repo";

/** How to call the Forgejo API with the granted token. Shared by the `forgejo`
 *  capability description and the headless-run guidance (#3067). */
const FORGEJO_API_USAGE =
  "Read and write issues, PRs, labels and comments with curl against the Gitea-compatible API at $CLAWS_FORGEJO_BASE_URL/api/v1, sending the header 'Authorization: token '$CLAWS_FORGEJO_TOKEN — e.g. curl -sH \"Authorization: token $CLAWS_FORGEJO_TOKEN\" \"$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/issues\".";
export const FORGEJO_ADMIN_CAPABILITY_ID = "forgejo-admin";

export const CROSS_REPO_ACCESS_GUIDANCE =
  "Agents may read any Claws-managed repo on GitHub or Forgejo and file issues there when work depends on deployment manifests, provisioning config, CI workflows or conventions; read the real file instead of guessing. " +
  "Work that spans repositories is one issue: file it with the `claws_create_issue` MCP tool, naming every repo it touches — it always files natively regardless of which forge hosts them, and returns the `clw_…` id and dashboard URL to cite in your PR body. The alphabetically first repo owns planning, and the plan lists the PRs it needs in each. File a separate issue in another repo only when the issue you are working does not name that repo and you cannot add it yourself — only the dashboard's Repositories form can — citing its `#clw_…` id in your PR body. " +
  "GitHub: `gh` is authenticated; list with `gh api repos/OWNER/NAME/contents/DIR --jq '.[].path'`, read with `gh api repos/OWNER/NAME/contents/PATH --jq .content | base64 -d`, search with `gh search code 'QUERY' --owner OWNER`, and file with `gh issue create --repo OWNER/NAME` only when `claws_create_issue` is unavailable or fails. " +
  "Forgejo: never use `gh`; use `curl -sH \"Authorization: token $CLAWS_FORGEJO_READ_TOKEN\" \"$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/contents/DIR\"`, read files by replacing `contents` with `raw`, and, only as that same fallback, file issues by POSTing JSON to `.../issues`. " +
  "If `gh` 404s on a managed repo that exists, retry Forgejo. Reading and filing issues need no approval; changing code in another repo does, so open a PR there or file an issue. Never print or commit tokens. Forgejo reads/issues require $CLAWS_FORGEJO_READ_TOKEN when configured.";

/** UI grouping only (#3138) — never affects what is granted, validated or
 *  pre-ticked. Fixed display order: see `CAPABILITY_GROUPS`. */
export type CapabilityGroup = "agent" | "forge" | "infra" | "ssh" | "tools";

/** Grouping sections for the create-form checkboxes and the live-grant
 *  dropdown, in fixed display order (#3138). */
export const CAPABILITY_GROUPS: ReadonlyArray<{ id: CapabilityGroup; label: string }> = [
  { id: "agent", label: "Agent logins" },
  { id: "forge", label: "Forge access" },
  { id: "infra", label: "Infrastructure" },
  { id: "ssh", label: "SSH hosts" },
  { id: "tools", label: "Tools" },
];

export interface SessionCapability {
  id: string;
  label: string;
  description: string;
  /** Env keys this capability owns; stripped when not granted. */
  envKeys: string[];
  /** Resolve the env vars to inject, or null when unavailable (unconfigured). */
  resolve: () => Record<string, string> | null;
  /** Granted automatically by `withImplicitCapabilities` server-side whenever
   *  it applies to a session's repos. The create form still renders it: when
   *  `autoGrantedRepos` forces the grant for the selected repo(s) it is a
   *  checked, disabled checkbox with the reason; otherwise (e.g. `forgejo` for
   *  a GitHub-only selection) it is an ordinary opt-in checkbox. */
  implicit?: boolean;
  /** Set on the provider-auth capabilities (#3026): the agent CLI whose login
   *  it carries, or `"github"`. The create form keys its pre-ticking on it. */
  provider?: SessionProvider | "github";
  /** Safe to grant to unattended issue planners for read-only diagnostics. */
  headlessPlannerDiagnostic?: boolean;
  /** UI section (#3138); see `capabilityGroup` for the fallback when unset. */
  group?: CapabilityGroup;
}

/** `cap.group` when set, else `"ssh"` for an `ssh:*` id, else `"tools"`. */
export function capabilityGroup(cap: SessionCapability): CapabilityGroup {
  if (cap.group) return cap.group;
  return cap.id.startsWith("ssh:") ? "ssh" : "tools";
}

export const CAPABILITIES: SessionCapability[] = [
  {
    id: "home-assistant",
    label: "Home Assistant",
    group: "infra",
    description: "Read/control the Home Assistant instance via its REST API.",
    envKeys: ["HOME_ASSISTANT_BASE_URL", "HOME_ASSISTANT_TOKEN", "CLAWS_HOME_ASSISTANT_TOKEN"],
    resolve: () =>
      !HOME_ASSISTANT_TOKEN
        ? null
        : {
            HOME_ASSISTANT_BASE_URL,
            HOME_ASSISTANT_TOKEN,
            CLAWS_HOME_ASSISTANT_TOKEN: HOME_ASSISTANT_TOKEN,
          },
  },
  {
    id: "prod-infra",
    label: "Prod infra (kubectl)",
    group: "infra",
    description: "kubectl access to the production Kubernetes cluster.",
    envKeys: ["KUBECONFIG"],
    headlessPlannerDiagnostic: true,
    resolve: () =>
      !PROD_K8S_KUBECONFIG_PATH ? null : { KUBECONFIG: resolveIdentityFile(PROD_K8S_KUBECONFIG_PATH) },
  },
  {
    id: "fleet-infra",
    label: "Fleet infra (kubectl)",
    group: "infra",
    description: "kubectl access to the fleet Kubernetes cluster.",
    envKeys: ["KUBECONFIG"],
    headlessPlannerDiagnostic: true,
    resolve: () =>
      !FLEET_KUBECONFIG_PATH ? null : { KUBECONFIG: resolveIdentityFile(FLEET_KUBECONFIG_PATH) },
  },
  {
    id: CROSS_REPO_CAPABILITY_ID,
    label: "Cross-repo (read + issues)",
    implicit: true,
    group: "forge",
    description: CROSS_REPO_ACCESS_GUIDANCE,
    envKeys: ["CLAWS_FORGEJO_READ_TOKEN", "CLAWS_FORGEJO_BASE_URL"],
    resolve: (): Record<string, string> => {
      if (!FORGEJO_READ_TOKEN || !FORGEJO_READ_TOKEN.trim()) return {};
      return {
        CLAWS_FORGEJO_READ_TOKEN: FORGEJO_READ_TOKEN,
        CLAWS_FORGEJO_BASE_URL: FORGEJO_BASE_URL.replace(/\/+$/, ""),
      };
    },
  },
  {
    id: FORGEJO_CAPABILITY_ID,
    label: "Forgejo (git + API)",
    implicit: true,
    group: "forge",
    description:
      "This repository is hosted on Forgejo, not GitHub. The GitHub repo of the same name is a stale read-only push mirror: never use `gh` for its issues, PRs, checks, runs or comments. " +
      FORGEJO_API_USAGE +
      " git fetch and git push against the Forgejo host are already authenticated in this shell via a credential helper, and `origin` already points at Forgejo — do not add a GitHub remote. CI runs on Forgejo Actions from workflows in .forgejo/workflows/, not .github/workflows/. Never print or commit the token.",
    envKeys: [
      "CLAWS_FORGEJO_TOKEN",
      "CLAWS_FORGEJO_BASE_URL",
      "CLAWS_FORGEJO_GIT_TOKEN",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ],
    resolve: () => {
      if (!FORGEJO_TOKEN || !FORGEJO_TOKEN.trim()) return null;
      const base = FORGEJO_BASE_URL.replace(/\/+$/, "");
      return {
        CLAWS_FORGEJO_TOKEN: FORGEJO_TOKEN,
        CLAWS_FORGEJO_BASE_URL: base,
        [FORGEJO_GIT_CREDENTIAL_TOKEN_VAR]: FORGEJO_TOKEN,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `credential.${base}.helper`,
        GIT_CONFIG_VALUE_0: FORGEJO_GIT_CREDENTIAL_HELPER,
      };
    },
  },
  {
    id: FORGEJO_ADMIN_CAPABILITY_ID,
    label: "Forgejo admin (Actions secrets)",
    group: "forge",
    description:
      "An org-owner Forgejo token in $CLAWS_FORGEJO_ADMIN_TOKEN. Use it ONLY for Forgejo Actions secrets and variables — the API paths $CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/actions/secrets, .../actions/variables, $CLAWS_FORGEJO_BASE_URL/api/v1/orgs/OWNER/actions/secrets and .../actions/variables — which the ordinary token cannot write (Forgejo answers 403 'user should be the owner of the repo'). For everything else, including issues, pull requests, comments, labels, reviews and all git operations, keep using $CLAWS_FORGEJO_TOKEN: the admin token belongs to a separate owner account whose name must never appear on anything this session writes. Never print or commit either token. The Claws service itself also reads the Actions runner registry and runner-jobs endpoints with this token, in-process and read-only, for mac-runner-waker; that does not widen what this session may use it for.",
    envKeys: ["CLAWS_FORGEJO_ADMIN_TOKEN", "CLAWS_FORGEJO_BASE_URL"],
    resolve: () => {
      if (!FORGEJO_ADMIN_TOKEN || !FORGEJO_ADMIN_TOKEN.trim()) return null;
      return {
        CLAWS_FORGEJO_ADMIN_TOKEN: FORGEJO_ADMIN_TOKEN,
        CLAWS_FORGEJO_BASE_URL: FORGEJO_BASE_URL.replace(/\/+$/, ""),
      };
    },
  },
  {
    id: BROWSER_CAPABILITY_ID,
    label: "Browser (Playwright)",
    group: "tools",
    description:
      "Drive a real headless Chromium (which may be a shared browser service) through the Playwright MCP tools (mcp__playwright__*). " +
      "Use these for sites that block plain HTTP fetches — eBay, Facebook Marketplace, Gumtree — " +
      "instead of WebFetch or curl, which such sites answer with a bot-challenge page. " +
      "Close tabs you have finished reading; an unbounded tab count exhausts the host's memory budget. " +
      "The browser may be shared with other work: the first browser tool call can take a while because the run is waiting in a queue — that is not a failure. " +
      "If a browser tool call reports that the connection was refused or the queue is full, wait about 30 seconds and retry once before abandoning the task. " +
      "Browser sessions are ephemeral; do not rely on logins persisting between sessions.",
    envKeys: [],
    resolve: () => ({}),
  },
];

/**
 * SSH hosts from the operator's ~/.ssh/config (hardcoded — the box running
 * Claws already has the keys + config on disk, so an interactive session can
 * already SSH to these; this just surfaces them as grantable capabilities and
 * tells the model what each host is for). No env var is needed (auth is via
 * on-disk keys), so envKeys is empty and resolve() returns an empty (non-null)
 * object — the capability is always "available" and injects/strips nothing.
 * Source of truth is this list: adding/removing a host requires a code edit.
 * The two macOS Actions runners are NOT in this list (#3138): they come from
 * `MAC_RUNNERS` (config.ts) below, the same config `mac-runner-waker` uses.
 */
const SSH_HOST_CAPABILITIES: SessionCapability[] = (
  [
    ["nas", "NixOS NAS: ZFS pool, NFS/SMB exports, and the k3s storage node (Kubernetes node name `k3s-nas`)"],
    ["homeassistant", "Home Assistant host OS"],
    ["k3s", "k3s Kubernetes cluster node"],
    ["ryzen", "NixOS workstation / build machine: k3s GPU node, GNOME desktop, and a self-hosted Actions runner. Built from `St-John-Software/nixos-config` (`hosts/ryzen/`) — configuration changes go in that flake, not in ad-hoc edits on the box"],
    ["proxmox", "Proxmox virtualization host"],
  ] as [string, string][]
).map(([alias, desc]) => ({
  id: `ssh:${alias}`,
  label: `SSH: ${alias}`,
  description: `SSH into ${alias}. ${desc}`,
  envKeys: [],
  resolve: () => ({}),
}));

CAPABILITIES.push(...SSH_HOST_CAPABILITIES);

/** `(runner.name ?? runner.host)` lowercased, trailing `.local` stripped,
 *  every character outside `[a-z0-9-]` replaced with `-` (#3138). */
function macRunnerSlug(runner: MacRunner): string {
  return (runner.name ?? runner.host)
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]/g, "-");
}

/** The exact `ssh` invocation for a Mac runner, for the capability description.
 *  Uses the config-file (space, not `=`) form of `-o` so the text never
 *  contains a literal `=` (#2138: descriptions are concatenated into
 *  `--append-system-prompt`, and a `=` there would look like a leaked
 *  KEY=value assignment to the #2138 argv checks). */
function macRunnerSshCommand(runner: MacRunner): string {
  const parts = ["ssh", "-o", '"StrictHostKeyChecking accept-new"'];
  if (runner.identityFile) parts.push("-i", runner.identityFile);
  if (runner.port && runner.port !== 22) parts.push("-p", String(runner.port));
  parts.push(runner.user ? `${runner.user}@${runner.host}` : runner.host);
  return parts.join(" ");
}

/**
 * SSH capabilities for the macOS Actions runners in `MAC_RUNNERS` (#3138),
 * built from that config rather than hardcoded like `SSH_HOST_CAPABILITIES`
 * above, so Claws and `mac-runner-waker` share one source of truth for Mac
 * hosts. Read via `safeRead` (defined below, but a hoisted function
 * declaration so it is callable here) because `capabilities.test.ts` mocks
 * `./config.js` with a partial object and accessing a missing export throws.
 * `resolve()` re-reads `MAC_RUNNERS` at call time, so disabling or removing a
 * Mac from the config hides its capability without a restart; a Mac *added*
 * after boot only appears once the capability list is rebuilt at the next
 * restart, since this list itself is only built once, at module load.
 * Deliberately excluded from `REPO_CAPABILITY_DEFAULTS` (#3138 decision 5):
 * on `k8s-pod`, granting any `ssh:*` copies the service's private keys into
 * the session pod's Secret, so these are opt-in via "Show all capabilities"
 * or the live-grant dropdown, like `forgejo-admin`.
 */
function macRunnerCapabilities(): SessionCapability[] {
  const runners = safeRead(() => MAC_RUNNERS, [] as readonly MacRunner[]);
  const seenIds = new Set(CAPABILITIES.map((c) => c.id));
  const out: SessionCapability[] = [];
  for (const runner of runners) {
    const id = `ssh:${macRunnerSlug(runner)}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const name = runner.name ?? runner.host;
    const host = runner.host;
    out.push({
      id,
      label: `SSH: ${name}`,
      group: "ssh",
      description:
        `SSH into ${name}, a macOS self-hosted Actions runner (labels: ${runner.labels.join(", ")}). ` +
        `Connect with: ${macRunnerSshCommand(runner)}. ` +
        "The Mac sleeps when idle; the first connection may time out — Claws' mac-runner-waker wakes it, so retry once after ~30 s before concluding it is unreachable. Do not change its runner registration.",
      envKeys: [],
      resolve: () => {
        const current = safeRead(() => MAC_RUNNERS, [] as readonly MacRunner[]).find((r) => r.host === host);
        return current && current.enabled !== false ? {} : null;
      },
    });
  }
  return out;
}

CAPABILITIES.push(...macRunnerCapabilities());

export const CLAUDE_AUTH_CAPABILITY_ID = "claude-auth";
export const CODEX_AUTH_CAPABILITY_ID = "codex-auth";
export const OPENROUTER_AUTH_CAPABILITY_ID = "openrouter-auth";
export const GITHUB_AUTH_CAPABILITY_ID = "github-auth";

/** Read a config binding, tolerating a test's partial `config.js` mock. */
function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read() ?? fallback;
  } catch {
    return fallback;
  }
}

/** Provider-auth capabilities only exist on the `k8s-pod` session backend. */
function isPodBackend(): boolean {
  return safeRead(() => SESSION_BACKEND, "local-tmux") === "k8s-pod";
}

/** The service's Codex `auth.json`: `$CODEX_HOME/auth.json`, else `~/.codex/auth.json` (same lookup as `claude.ts`). */
export function serviceCodexAuthPath(): string {
  return path.join(process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex"), "auth.json");
}

/** True when a GitHub App is configured globally or for any owner. */
function isGitHubAppConfigured(): boolean {
  if (safeRead(() => GITHUB_APP_ID, 0)) return true;
  const perOwner = safeRead(() => GITHUB_OWNER_APP_CREDENTIALS, {});
  return Object.values(perOwner).some((c) => !!c?.appId && !!c?.privateKeyPath);
}

/**
 * Provider auth for `k8s-pod` sessions (#3026): each grant copies one of the
 * service's own credentials into the session pod's Secret. On `local-tmux`
 * they resolve to null, so they are never offered and `validCapabilityIds`
 * drops them. `envKeys` is deliberately empty — listing e.g.
 * `CLAUDE_CODE_OAUTH_TOKEN` would add it to every local session's strip list
 * and log local Claude sessions out. `resolve()` injects nothing either: the
 * pod launcher (`session-pod-launch.ts`) gathers the material itself.
 */
const PROVIDER_AUTH_CAPABILITIES: SessionCapability[] = [
  {
    id: CLAUDE_AUTH_CAPABILITY_ID,
    label: "Claude login",
    provider: "claude",
    group: "agent",
    description: "The Claude CLI is logged in with the Claws service's Claude token (CLAUDE_CODE_OAUTH_TOKEN). Never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && !!process.env["CLAUDE_CODE_OAUTH_TOKEN"] ? {} : null),
  },
  {
    id: CODEX_AUTH_CAPABILITY_ID,
    label: "Codex login",
    provider: "codex",
    group: "agent",
    description: "The Codex CLI is logged in with a copy of the Claws service's Codex auth.json in CODEX_HOME. Never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && fs.existsSync(serviceCodexAuthPath()) ? {} : null),
  },
  {
    id: OPENROUTER_AUTH_CAPABILITY_ID,
    label: "OpenRouter key",
    provider: "opencode",
    group: "agent",
    description: "OPENROUTER_API_KEY holds the Claws service's OpenRouter key, so OpenCode can use OpenRouter models. Never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && !!safeRead(() => OPENROUTER_API_KEY, "") ? {} : null),
  },
  {
    id: GITHUB_AUTH_CAPABILITY_ID,
    label: "GitHub (gh + git)",
    provider: "github",
    group: "forge",
    description: "`gh` and git push/fetch against github.com are authenticated as the Claws GitHub App installation. The token is refreshed in place about hourly — do not copy it into files or env vars, and never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && isGitHubAppConfigured() ? {} : null),
  },
];

CAPABILITIES.push(...PROVIDER_AUTH_CAPABILITIES);

/**
 * Provider-auth capability pre-ticked on the create form for `provider` in
 * `mode`: the agent's own login only, and nothing for `repo-zsh`. The
 * `repo-zsh` exclusion covers agent logins only — they are useless with no
 * agent CLI running to use them. `github-auth` follows the selected repo
 * instead (see `defaultCapabilitiesForRepo`) and is deliberately still
 * pre-ticked in `repo-zsh`: a human shell uses `gh` and `git` directly, and
 * unlike an agent session it has no `claws_request_capability` tool to ask
 * for it mid-session (#3136). Not filtered by availability — the form only
 * renders available capabilities.
 */
export function defaultProviderAuthCapabilities(provider: SessionProvider, mode: SessionMode): string[] {
  if (mode === "repo-zsh") return [];
  const cap = PROVIDER_AUTH_CAPABILITIES.find((c) => c.provider === provider);
  return cap ? [cap.id] : [];
}

/** True for an agent-login capability (`claude-auth`, `codex-auth`,
 *  `openrouter-auth`): one whose `provider` is an agent CLI rather than
 *  `"github"`. These follow the Agent select, not the repo, so they are never
 *  remembered as a repo combination's default. */
export function isAgentLoginCapability(id: string): boolean {
  const provider = CAPABILITIES.find((c) => c.id === id)?.provider;
  return !!provider && provider !== "github";
}

/** True for a capability that may be stored as a repo combination's
 *  remembered default: not an agent login (those follow the Agent select)
 *  and not `cross-repo` (always forced, never submitted, so remembering it
 *  would be meaningless). An explicit `forgejo` tick for a repo selection it
 *  is not forced on IS remembered like any other capability; a forced tick
 *  is never submitted by the browser (disabled checkboxes don't post) so it
 *  is never recorded either way. */
export function isRememberableCapability(id: string): boolean {
  if (isAgentLoginCapability(id)) return false;
  return id !== CROSS_REPO_CAPABILITY_ID;
}

/** Display label for a capability id, for the id alone (e.g. a session's stored
 *  capability list) without the full `SessionCapability` record. Falls back to
 *  the raw id for one no longer in the registry — deliberately not filtered by
 *  availability, since a label must still render for a capability whose
 *  `resolve()` now returns null. */
export function capabilityLabel(id: string): string {
  return CAPABILITIES.find((c) => c.id === id)?.label ?? id;
}

/** True if the capability exists in the registry and is currently configured. */
export function isCapabilityAvailable(id: string): boolean {
  const cap = CAPABILITIES.find((c) => c.id === id);
  return !!cap && cap.resolve() !== null;
}

/** Capabilities that are configured (resolve() != null) right now. */
export function availableCapabilities(): SessionCapability[] {
  return CAPABILITIES.filter((c) => c.resolve() !== null);
}

/**
 * Default capability associations per repo (full "owner/name"). The
 * session-create UI uses this to pre-filter the capability checkboxes to those
 * relevant to the selected repo, and to pre-tick those boxes at session-create
 * time (#2755). UI convenience ONLY, not a security boundary: the "Show all
 * capabilities" toggle reveals every available capability, pre-ticking is
 * still only a form default the user can untick before submitting, and the
 * server still accepts any available capability the user explicitly ticks
 * (default-deny + availability check in validCapabilityIds remain the gate).
 * Repos absent from this map have no default capabilities.
 */
export const REPO_CAPABILITY_DEFAULTS: Record<string, string[]> = {
  "St-John-Software/production-infra": ["prod-infra", "ssh:ryzen"],
  "St-John-Software/fleet-infra": ["fleet-infra", "ssh:k3s", "ssh:ryzen", "ssh:nas", "ssh:proxmox"],
  "St-John-Software/bin-scraper": ["fleet-infra"],
  "St-John-Software/namey": ["prod-infra"],
  "St-John-Software/bonkus": ["prod-infra"],
  "St-John-Software/home-assistant-config": ["home-assistant", "ssh:homeassistant"],
  "St-John-Software/ha-carlink": ["home-assistant"],
  "St-John-Software/nixos-config": ["ssh:nas", "ssh:ryzen"],
};

/**
 * Claws-owned grants for unattended planners, separate from interactive defaults.
 * Cluster associations follow REPO_CAPABILITY_DEFAULTS; Claws itself runs in
 * fleet-infra. Only kubectl diagnostics are granted: SSH, HA control, browser,
 * admin and provider-auth capabilities are not unattended diagnostic access.
 * Keep keys lowercase; unlisted repos get no additional credentials.
 */
const PLANNER_CAPABILITIES_BY_REPO: ReadonlyMap<string, readonly string[]> = new Map([
  ["st-john-software/production-infra", ["prod-infra"]],
  ["st-john-software/namey", ["prod-infra"]],
  ["st-john-software/bonkus", ["prod-infra"]],
  ["st-john-software/fleet-infra", ["fleet-infra"]],
  ["st-john-software/bin-scraper", ["fleet-infra"]],
  ["st-john-software/claws", ["fleet-infra"]],
]);

/** Planner grants only; availability and diagnostic eligibility are checked at launch. */
export function plannerCapabilitiesForRepo(fullName: string): string[] {
  return [...(PLANNER_CAPABILITIES_BY_REPO.get(fullName.toLowerCase()) ?? [])];
}

/** Full repo names for which `capId` is a default-relevant capability.
 *  `github-auth` is relevant to every repo in `allRepos` (#3131, #3152). */
export function reposForCapability(capId: string, allRepos: string[] = []): string[] {
  if (capId === GITHUB_AUTH_CAPABILITY_ID) return allRepos;
  const out: string[] = [];
  for (const [repo, ids] of Object.entries(REPO_CAPABILITY_DEFAULTS)) {
    if (ids.includes(capId)) out.push(repo);
  }
  return out;
}

/** Capability IDs pre-ticked on the session-create form for `fullName`
 *  (#2755), plus `github-auth` for any repo (#3131, #3152). Unavailable
 *  ones are dropped, since they are never rendered. */
export function defaultCapabilitiesForRepo(fullName: string | null): string[] {
  if (!fullName) return [];
  const ids = [...(REPO_CAPABILITY_DEFAULTS[fullName] ?? [])];
  ids.push(GITHUB_AUTH_CAPABILITY_ID);
  return validCapabilityIds(ids);
}

/** Intersect requested ids with the registry, dedupe, and drop unavailable ones. */
export function validCapabilityIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    if (out.includes(id)) continue;
    if (isCapabilityAvailable(id)) out.push(id);
  }
  return out;
}

/** Which of `allRepos` force `capId`'s grant server-side, for the create
 *  form's disabled/checked rendering: `"all"` for `cross-repo` (unconditional
 *  for every session), the Forgejo-hosted subset of `allRepos` for `forgejo`,
 *  `null` for any other id (never forced, an ordinary checkbox). */
export function autoGrantedRepos(capId: string, allRepos: string[]): "all" | string[] | null {
  if (capId === CROSS_REPO_CAPABILITY_ID) return "all";
  if (capId === FORGEJO_CAPABILITY_ID) return allRepos.filter((r) => isForgejoRepo(r));
  return null;
}

/** Union of the operator's explicit selection with the capabilities a
 *  session's repos require unconditionally. A Forgejo-hosted repo has no
 *  forge credential of any kind without this, so it is granted automatically
 *  (#2871) — the create form renders the grant as a forced, disabled
 *  checkbox (`autoGrantedRepos`) rather than relying on this union alone to
 *  make it visible. Ids that are unavailable (no token configured) still
 *  drop out via `validCapabilityIds`. */
export function withImplicitCapabilities(
  selected: string[],
  repos: Array<string | null | undefined>,
): string[] {
  const ids = [...selected];
  ids.push(CROSS_REPO_CAPABILITY_ID);
  if (repos.some((r) => !!r && isForgejoRepo(r))) ids.push(FORGEJO_CAPABILITY_ID);
  return validCapabilityIds(ids);
}

/**
 * Forgejo access for a headless, repo-scoped agent run (#3067): the `forgejo`
 * capability's env plus system-prompt guidance. The caller decides whether the
 * run needs it (working repo on Forgejo, or its owner has Forgejo repos).
 * `workingRepoIsForgejo` picks the wording: the capability text verbatim for a
 * Forgejo working repo, a cross-forge variant for a GitHub one. Returns null
 * when no Forgejo token is configured. The prompt names env vars only, never
 * their values.
 */
export function resolveHeadlessForgejoAccess(
  workingRepoIsForgejo: boolean,
): { env: Record<string, string>; prompt: string } | null {
  const cap = CAPABILITIES.find((c) => c.id === FORGEJO_CAPABILITY_ID);
  const env = cap?.resolve();
  if (!cap || !env) return null;
  const body = workingRepoIsForgejo
    ? cap.description
    : "Some repositories of this owner are hosted on Forgejo, not GitHub; the GitHub repos of the same name are stale read-only push mirrors. For those Forgejo-hosted repos only, never use `gh`: " +
      FORGEJO_API_USAGE +
      " Keep using `gh` for GitHub-hosted repos, including this one. Never print or commit the token.";
  return { env, prompt: `## Forgejo access\n\n${body}` };
}

export function resolveHeadlessCrossRepoAccess(): { env: Record<string, string>; prompt: string } | null {
  const cap = CAPABILITIES.find((c) => c.id === CROSS_REPO_CAPABILITY_ID);
  const env = cap?.resolve();
  if (!cap || !env) return null;
  return { env, prompt: `## Cross-repo access\n\n${CROSS_REPO_ACCESS_GUIDANCE}` };
}

function isHeadlessPlannerCapabilityAllowed(cap: SessionCapability): boolean {
  return cap.headlessPlannerDiagnostic === true && cap.envKeys.length > 0;
}

/** Every environment variable owned by a registered capability. */
export function capabilityEnvKeys(): string[] {
  const keys: string[] = [];
  for (const cap of CAPABILITIES) {
    for (const key of cap.envKeys) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * Resolve explicit Claws-owned diagnostic grants for headless issue planners.
 * This is intentionally narrower than interactive session capabilities:
 * planners get only configured, env-backed capabilities positively marked safe
 * for unattended read-only diagnostics, and the prompt names usage guidance but
 * never secret values.
 */
export function resolveHeadlessPlannerCapabilityAccess(
  ids: string[],
): { env: Record<string, string>; prompt: string; grantedIds: string[] } | null {
  const grantedIds = validCapabilityIds(ids).filter((id) => {
    const cap = CAPABILITIES.find((c) => c.id === id);
    return !!cap && isHeadlessPlannerCapabilityAllowed(cap);
  });
  if (grantedIds.length === 0) return null;

  const env: Record<string, string> = {};
  const grantedCaps: SessionCapability[] = [];
  for (const id of grantedIds) {
    const cap = CAPABILITIES.find((c) => c.id === id);
    if (!cap) continue;
    const resolved = cap.resolve();
    if (!resolved) continue;
    grantedCaps.push(cap);
    for (const [k, v] of Object.entries(resolved)) {
      if (k === "KUBECONFIG" && env.KUBECONFIG) {
        env.KUBECONFIG = `${env.KUBECONFIG}:${v}`;
      } else {
        env[k] = v;
      }
    }
  }
  if (grantedCaps.length === 0 || Object.keys(env).length === 0) return null;

  const hasKubernetes = grantedCaps.some((c) => c.envKeys.includes("KUBECONFIG"));
  const lines = [
    "## Planner diagnostic capabilities",
    "",
    "Claws grants this repo’s planner these capabilities for read-only diagnosis before writing the implementation plan. Use them only to inspect current state and logs; do not mutate infrastructure, secrets, repositories, or external services.",
    "",
    ...grantedCaps.map((c) => `- ${c.label}: ${c.description}`),
  ];
  if (hasKubernetes) {
    lines.push(
      "",
      "For Kubernetes diagnostics, you may run read-only commands such as `kubectl get`, `kubectl describe`, `kubectl logs`, `kubectl top`, and event inspection. Do not run mutating commands including `kubectl apply`, `delete`, `patch`, `edit`, `exec`, `scale`, `rollout restart`, `rollout undo`, or other rollout mutations.",
    );
  }
  return { env, prompt: lines.join("\n"), grantedIds };
}

/**
 * `/bin/sh -c` script that delivers granted capability values without putting
 * them on argv. Invariant: `$0` is `claws-session`, `$1` is the env file, and
 * `$2…` is the real command. The file is sourced, deleted immediately, then
 * `shift` drops the path so `exec "$@"` runs the command.
 */
export const ENV_FILE_PRELUDE = '. "$1"; rm -f "$1"; shift; exec "$@"';

/**
 * Resolve a capability selection into the env vars to grant and the env keys to
 * strip. `vars` merges every granted capability's `resolve()` output, with
 * KUBECONFIG colon-joined when more than one cluster is granted. `stripKeys` is
 * every gated key across the registry plus the baseline `SENSITIVE_ENV_KEYS`
 * (the same set stripped from automated `runClaude` child processes) — granted
 * keys included, so a session can never silently inherit an ambient value; the
 * granted ones are re-set out-of-band by the sourced env file.
 */
export function resolveCapabilityEnv(
  selected: string[],
): { vars: Record<string, string>; stripKeys: string[] } {
  const granted = validCapabilityIds(selected);

  const allKeys = capabilityEnvKeys();

  const merged: Record<string, string> = {};
  for (const id of granted) {
    const cap = CAPABILITIES.find((c) => c.id === id);
    if (!cap) continue;
    const resolved = cap.resolve();
    if (!resolved) continue;
    for (const [k, v] of Object.entries(resolved)) {
      if (k === "KUBECONFIG" && merged.KUBECONFIG) {
        merged.KUBECONFIG = `${merged.KUBECONFIG}:${v}`;
      } else {
        merged[k] = v;
      }
    }
  }

  const stripKeys: string[] = [];
  for (const key of [...allKeys, ...SENSITIVE_ENV_KEYS]) {
    if (!stripKeys.includes(key)) stripKeys.push(key);
  }

  return { vars: merged, stripKeys };
}

/** The env vars a capability selection grants: `resolveCapabilityEnv`'s
 *  merged `vars`, KUBECONFIG colon-joined. Empty for e.g. `ssh:*` alone. */
export function grantedEnvVars(caps: string[]): Record<string, string> {
  return resolveCapabilityEnv(caps).vars;
}

/** How a capability relates to a session that is already running (#3322). */
export type LiveGrantState = "held" | "grantable" | "fixed";

export interface LiveGrantEntry {
  cap: SessionCapability;
  state: LiveGrantState;
  /** Why a `fixed` capability cannot be granted now, or (for `held`) why it
   *  is always held — set on the `cross-repo` baseline as "always granted";
   *  unset for an ordinary already-granted `held` entry. */
  reason?: string;
}

/** Reason shown for capabilities only a fresh launch can deliver (#3322). */
export const FIXED_AT_LAUNCH_REASON = "fixed at launch — start a new session";

/**
 * Every configured capability with its state for a running session (#3072,
 * #3322). `held`: already granted, or the unconditional `cross-repo` baseline
 * (carrying `reason: "always granted"`). `fixed` (with a reason): provider
 * auth other than the pre-made `github-auth` slot (#3131), and `browser`,
 * whose MCP wiring is chosen at spawn. `grantable`: everything else —
 * `implicit` only means server-side auto-grant when `autoGrantedRepos` forces
 * it, so Forgejo can still be requested or granted live when it wasn't, and
 * `ssh:*` is grantable on both backends (on `k8s-pod` it takes effect on the
 * next resume when no SSH key slot was mounted at launch). Unconfigured
 * capabilities are omitted. `backend` is a plain string so this module never
 * imports `session-backend.ts`; no rule depends on it today.
 */
export function classifyLiveGrants(
  granted: string[],
  _backend: "local-tmux" | "k8s-pod",
): LiveGrantEntry[] {
  return availableCapabilities().map((cap): LiveGrantEntry => {
    if (cap.id === CROSS_REPO_CAPABILITY_ID) return { cap, state: "held", reason: "always granted" };
    if (granted.includes(cap.id)) return { cap, state: "held" };
    if ((cap.provider && cap.id !== GITHUB_AUTH_CAPABILITY_ID) || cap.id === BROWSER_CAPABILITY_ID) {
      return { cap, state: "fixed", reason: FIXED_AT_LAUNCH_REASON };
    }
    return { cap, state: "grantable" };
  });
}

/**
 * Capabilities that can be granted to a session that is already running
 * (#3072): the `grantable` entries of `classifyLiveGrants`.
 */
export function liveGrantableCapabilities(
  granted: string[],
  backend: "local-tmux" | "k8s-pod",
): SessionCapability[] {
  return classifyLiveGrants(granted, backend).filter((e) => e.state === "grantable").map((e) => e.cap);
}

/**
 * Build `env`-prefix argv that enforces the capability grant: every gated env
 * key and every baseline sensitive key is stripped with `-u`, so an empty
 * selection is default-deny and a granted session never inherits ambient
 * values. Granted values are NOT placed on argv — argv is world-readable via
 * `/proc/<pid>/cmdline` (#2138). Instead the caller writes them to a 0600 file
 * and passes its path as `envFilePath`; this appends a `/bin/sh` prelude that
 * sources and deletes the file before `exec`ing the real command, so argv
 * carries key names and a path only. Pass `envFilePath: null` when there is
 * nothing to grant.
 */
export function buildCapabilityEnvArgs(selected: string[], envFilePath: string | null): string[] {
  const { stripKeys } = resolveCapabilityEnv(selected);
  const args = [
    "env",
    ...stripKeys.flatMap((k) => ["-u", k]),
    // claws_wait_for_change blocks up to 270 s; the MCP SDK's default per-request
    // timeout is 60 s and would abort it. 300 s covers the longest wait with margin
    // — the trade-off is that a genuinely wedged MCP server now blocks a session
    // tool call for 5 minutes instead of 1.
    "MCP_TOOL_TIMEOUT=300000",
  ];
  if (envFilePath) {
    args.push("/bin/sh", "-c", ENV_FILE_PRELUDE, "claws-session", envFilePath);
  }
  return args;
}

/**
 * Build the `--append-system-prompt` text that makes a Claude session aware of
 * the capabilities it has been granted. Lists ONLY granted capabilities (the
 * ones whose credentials are present). Returns "" when nothing is granted, in
 * which case callers must skip the `--append-system-prompt` flag entirely.
 */
export function buildCapabilityPrompt(selected: string[]): string {
  const granted = validCapabilityIds(selected);
  const grantedCaps = CAPABILITIES.filter((c) => granted.includes(c.id));
  if (grantedCaps.length === 0) return "";
  const lines = [
    "## Session capabilities",
    "",
    "You have been explicitly granted these capabilities (their credentials are present in your environment):",
  ];
  for (const c of grantedCaps) lines.push(`- ${c.label}: ${c.description}`);
  return lines.join("\n");
}

/**
 * The compact block naming the capabilities a session may request mid-session
 * with the `claws_request_capability` MCP tool (#3072): ids and labels only,
 * never descriptions — the tool returns a capability's usage guidance once the
 * operator approves it. Returns "" when nothing is requestable. Only for
 * sessions that have the `claws-state` MCP server; the caller decides that.
 */
export function buildRequestableCapabilityPrompt(
  granted: string[],
  backend: "local-tmux" | "k8s-pod",
): string {
  const requestable = liveGrantableCapabilities(granted, backend);
  if (requestable.length === 0) return "";
  const lines = [
    "## Requestable capabilities",
    "",
    "If a task needs one of these capabilities, call `claws_request_capability` with its id and a short reason; the user must approve the request before you get access.",
  ];
  for (const group of CAPABILITY_GROUPS) {
    const caps = requestable.filter((c) => capabilityGroup(c) === group.id);
    if (caps.length === 0) continue;
    lines.push(`${group.label}: ${caps.map((c) => `\`${c.id}\` (${c.label})`).join(", ")}`);
  }
  if (backend === "k8s-pod" && requestable.some((c) => c.id.startsWith("ssh:"))) {
    lines.push("An SSH host granted to this session may only take effect after the operator resumes the session; the tool's response says whether it is live now.");
  }
  return lines.join("\n");
}

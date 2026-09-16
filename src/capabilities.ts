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
  FORGEJO_ADMIN_TOKEN,
  isForgejoRepo,
  SESSION_BACKEND,
  OPENROUTER_API_KEY,
  GITHUB_APP_ID,
  GITHUB_OWNER_APP_CREDENTIALS,
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

/** How to call the Forgejo API with the granted token. Shared by the `forgejo`
 *  capability description and the headless-run guidance (#3067). */
const FORGEJO_API_USAGE =
  "Read and write issues, PRs, labels and comments with curl against the Gitea-compatible API at $CLAWS_FORGEJO_BASE_URL/api/v1, sending the header 'Authorization: token '$CLAWS_FORGEJO_TOKEN — e.g. curl -sH \"Authorization: token $CLAWS_FORGEJO_TOKEN\" \"$CLAWS_FORGEJO_BASE_URL/api/v1/repos/OWNER/NAME/issues\".";
export const FORGEJO_ADMIN_CAPABILITY_ID = "forgejo-admin";

export interface SessionCapability {
  id: string;
  label: string;
  description: string;
  /** Env keys this capability owns; stripped when not granted. */
  envKeys: string[];
  /** Resolve the env vars to inject, or null when unavailable (unconfigured). */
  resolve: () => Record<string, string> | null;
  /** Granted automatically by `withImplicitCapabilities`, never offered as a
   *  create-form checkbox — the session is unusable without it (#2871). */
  implicit?: boolean;
  /** Set on the provider-auth capabilities (#3026): the agent CLI whose login
   *  it carries, or `"github"`. The create form keys its pre-ticking on it. */
  provider?: SessionProvider | "github";
}

export const CAPABILITIES: SessionCapability[] = [
  {
    id: "home-assistant",
    label: "Home Assistant",
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
    description: "kubectl access to the production Kubernetes cluster.",
    envKeys: ["KUBECONFIG"],
    resolve: () =>
      !PROD_K8S_KUBECONFIG_PATH ? null : { KUBECONFIG: PROD_K8S_KUBECONFIG_PATH },
  },
  {
    id: "fleet-infra",
    label: "Fleet infra (kubectl)",
    description: "kubectl access to the fleet Kubernetes cluster.",
    envKeys: ["KUBECONFIG"],
    resolve: () =>
      !FLEET_KUBECONFIG_PATH ? null : { KUBECONFIG: resolveIdentityFile(FLEET_KUBECONFIG_PATH) },
  },
  {
    id: FORGEJO_CAPABILITY_ID,
    label: "Forgejo (git + API)",
    implicit: true,
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
    description: "The Claude CLI is logged in with the Claws service's Claude token (CLAUDE_CODE_OAUTH_TOKEN). Never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && !!process.env["CLAUDE_CODE_OAUTH_TOKEN"] ? {} : null),
  },
  {
    id: CODEX_AUTH_CAPABILITY_ID,
    label: "Codex login",
    provider: "codex",
    description: "The Codex CLI is logged in with a copy of the Claws service's Codex auth.json in CODEX_HOME. Never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && fs.existsSync(serviceCodexAuthPath()) ? {} : null),
  },
  {
    id: OPENROUTER_AUTH_CAPABILITY_ID,
    label: "OpenRouter key",
    provider: "opencode",
    description: "OPENROUTER_API_KEY holds the Claws service's OpenRouter key, so OpenCode can use OpenRouter models. Never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && !!safeRead(() => OPENROUTER_API_KEY, "") ? {} : null),
  },
  {
    id: GITHUB_AUTH_CAPABILITY_ID,
    label: "GitHub (gh + git)",
    provider: "github",
    description: "`gh` and git push/fetch against github.com are authenticated as the Claws GitHub App installation. The token is refreshed in place about hourly — do not copy it into files or env vars, and never print it.",
    envKeys: [],
    resolve: () => (isPodBackend() && isGitHubAppConfigured() ? {} : null),
  },
];

CAPABILITIES.push(...PROVIDER_AUTH_CAPABILITIES);

/**
 * Provider-auth capability pre-ticked on the create form for `provider` in
 * `mode`: the agent's own login only, never `github-auth` (the operator ticks
 * that explicitly) and nothing for `repo-zsh`, which runs no agent. Not
 * filtered by availability — the form only renders available capabilities.
 */
export function defaultProviderAuthCapabilities(provider: SessionProvider, mode: SessionMode): string[] {
  if (mode === "repo-zsh") return [];
  const cap = PROVIDER_AUTH_CAPABILITIES.find((c) => c.provider === provider);
  return cap ? [cap.id] : [];
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

/** Full repo names for which `capId` is a default-relevant capability. */
export function reposForCapability(capId: string): string[] {
  const out: string[] = [];
  for (const [repo, ids] of Object.entries(REPO_CAPABILITY_DEFAULTS)) {
    if (ids.includes(capId)) out.push(repo);
  }
  return out;
}

/** Capability IDs pre-ticked on the session-create form for `fullName`
 *  (#2755). Unavailable ones are dropped, since they are never rendered. */
export function defaultCapabilitiesForRepo(fullName: string | null): string[] {
  if (!fullName) return [];
  return validCapabilityIds(REPO_CAPABILITY_DEFAULTS[fullName] ?? []);
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

/** Union of the operator's explicit selection with the capabilities a
 *  session's repos require unconditionally. A Forgejo-hosted repo has no
 *  forge credential of any kind without this, so it is granted automatically
 *  rather than offered as a checkbox (#2871). Ids that are unavailable
 *  (no token configured) still drop out via `validCapabilityIds`. */
export function withImplicitCapabilities(
  selected: string[],
  repos: Array<string | null | undefined>,
): string[] {
  const ids = [...selected];
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

  const allKeys: string[] = [];
  for (const cap of CAPABILITIES) {
    for (const key of cap.envKeys) {
      if (!allKeys.includes(key)) allKeys.push(key);
    }
  }

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

/**
 * Capabilities that can be granted to a session that is already running
 * (#3072): available, not yet granted, not `implicit`, not provider auth (those
 * are wired into the pod at launch), and not `browser` (its MCP server is fixed
 * at spawn). `ssh:*` only on `local-tmux`: a pod gets its SSH files at launch
 * only. `backend` is a plain string so this module never imports
 * `session-backend.ts`.
 */
export function liveGrantableCapabilities(
  granted: string[],
  backend: "local-tmux" | "k8s-pod",
): SessionCapability[] {
  return availableCapabilities().filter((c) =>
    !granted.includes(c.id)
    && !c.implicit
    && !c.provider
    && c.id !== BROWSER_CAPABILITY_ID
    && (backend === "local-tmux" || !c.id.startsWith("ssh:")),
  );
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
  return [
    "## Requestable capabilities",
    "",
    "If a task needs one of these capabilities, call `claws_request_capability` with its id and a short reason; the user must approve the request before you get access.",
    requestable.map((c) => `\`${c.id}\` (${c.label})`).join(", "),
  ].join("\n");
}

import {
  HOME_ASSISTANT_BASE_URL,
  HOME_ASSISTANT_TOKEN,
  PROD_K8S_KUBECONFIG_PATH,
  FLEET_KUBECONFIG_PATH,
} from "./config.js";
import { resolveIdentityFile } from "./util.js";
import { SENSITIVE_ENV_KEYS } from "./sensitive-env.js";

/**
 * A session capability bundles a set of credentials/environment variables that
 * can be explicitly granted to an interactive Claude session. Sessions are
 * default-deny: unless a capability is ticked, its env keys are stripped from
 * the spawned process.
 */
export const BROWSER_CAPABILITY_ID = "browser";

export interface SessionCapability {
  id: string;
  label: string;
  description: string;
  /** Env keys this capability owns; stripped when not granted. */
  envKeys: string[];
  /** Resolve the env vars to inject, or null when unavailable (unconfigured). */
  resolve: () => Record<string, string> | null;
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
    id: BROWSER_CAPABILITY_ID,
    label: "Browser (Playwright)",
    description:
      "Drive a real headless Chromium through the Playwright MCP tools (mcp__playwright__*). " +
      "Use these for sites that block plain HTTP fetches — eBay, Facebook Marketplace, Gumtree — " +
      "instead of WebFetch or curl, which such sites answer with a bot-challenge page. " +
      "Close tabs you have finished reading; an unbounded tab count exhausts the host's memory budget.",
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
    ["hetzner-beefy-actions", "NixOS Hetzner Cloud vServer; the org's `tailnet`-labelled self-hosted Actions runner. Built from `St-John-Software/nixos-config` (`hosts/beefy-actions/`) — configuration changes go in that flake, not in ad-hoc edits on the box"],
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
 * relevant to the selected repo. UI convenience ONLY, not a security boundary:
 * the "Show all capabilities" toggle reveals every available capability, and
 * the server still accepts any available capability the user explicitly ticks
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
  "St-John-Software/nixos-config": ["ssh:nas", "ssh:ryzen", "ssh:hetzner-beefy-actions"],
};

/** Full repo names for which `capId` is a default-relevant capability. */
export function reposForCapability(capId: string): string[] {
  const out: string[] = [];
  for (const [repo, ids] of Object.entries(REPO_CAPABILITY_DEFAULTS)) {
    if (ids.includes(capId)) out.push(repo);
  }
  return out;
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
  const args = ["env", ...stripKeys.flatMap((k) => ["-u", k])];
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

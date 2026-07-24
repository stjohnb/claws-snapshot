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
    ["truenas", "TrueNAS storage server"],
    ["homeassistant", "Home Assistant host OS"],
    ["k3s", "k3s Kubernetes cluster node"],
    ["hetzner-actions-runner", "Hetzner GitHub Actions self-hosted runner"],
    ["hetzner-beefy-actions", "Hetzner high-powered GitHub Actions runner"],
    ["ryzen", "Ryzen workstation / build machine"],
    ["k3s-nas", "k3s node on the NAS"],
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
  "St-John-Software/fleet-infra": ["fleet-infra", "ssh:k3s", "ssh:ryzen", "ssh:k3s-nas", "ssh:proxmox"],
  "St-John-Software/bin-scraper": ["fleet-infra"],
  "St-John-Software/namey": ["prod-infra"],
  "St-John-Software/bonkus": ["prod-infra"],
  "St-John-Software/home-assistant-config": ["home-assistant", "ssh:homeassistant"],
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
 * Build `env`-prefix argv that enforces the capability grant: every gated env
 * key not covered by a granted capability is stripped with `-u`, and the
 * granted capabilities' resolved vars are injected as discrete `KEY=value`
 * argv elements (never shell-quoted). Empty selection → default-deny: `env`
 * followed only by `-u` flags for every gated key. The baseline
 * `SENSITIVE_ENV_KEYS` (same set stripped from automated `runClaude` child
 * processes) are always stripped in addition to any ungranted capability
 * keys, so interactive sessions never inherit provider/API credentials.
 */
export function buildCapabilityEnvArgs(selected: string[]): string[] {
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

  const grantedKeys = Object.keys(merged);
  const args = ["env"];
  const stripped = new Set<string>();
  for (const key of [...allKeys, ...SENSITIVE_ENV_KEYS]) {
    if (grantedKeys.includes(key)) continue;
    if (stripped.has(key)) continue;
    stripped.add(key);
    args.push("-u", key);
  }
  for (const [k, v] of Object.entries(merged)) {
    args.push(`${k}=${v}`);
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

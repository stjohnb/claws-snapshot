import {
  NAMEY_DB_URL,
  HOME_ASSISTANT_BASE_URL,
  HOME_ASSISTANT_TOKEN,
  PROD_K8S_KUBECONFIG_PATH,
  FLEET_KUBECONFIG_PATH,
} from "./config.js";
import { resolveIdentityFile } from "./util.js";

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
    id: "namey-db",
    label: "Namey database",
    description: "Read-only access to the Namey PostgreSQL database.",
    envKeys: ["NAMEY_DB_URL", "CLAWS_NAMEY_DB_URL"],
    resolve: () =>
      !NAMEY_DB_URL ? null : { NAMEY_DB_URL, CLAWS_NAMEY_DB_URL: NAMEY_DB_URL },
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

/** True if the capability exists in the registry and is currently configured. */
export function isCapabilityAvailable(id: string): boolean {
  const cap = CAPABILITIES.find((c) => c.id === id);
  return !!cap && cap.resolve() !== null;
}

/** Capabilities that are configured (resolve() != null) right now. */
export function availableCapabilities(): SessionCapability[] {
  return CAPABILITIES.filter((c) => c.resolve() !== null);
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
 * followed only by `-u` flags for every gated key.
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
  for (const key of allKeys) {
    if (!grantedKeys.includes(key)) args.push("-u", key);
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

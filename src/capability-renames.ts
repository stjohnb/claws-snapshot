/**
 * Capability ids that were renamed, old id -> current id. Kept as an alias so a
 * stored grant, remembered form default or stale post naming the old id still
 * resolves (`validCapabilityIds`), and migrated at boot (`db.ts`
 * `migrateRenamedCapabilities`). Zero imports so db.ts can use it without
 * pulling in the capability registry.
 *
 * `ssh:k3s` -> `ssh:thinkcentre`: the machine is `thinkcentre`; `k3s` is only
 * its Kubernetes node (#clw_01M5KVM1ERWWP2FZQPW8J1WZ1K).
 *
 * `ssh:homeassistant` -> `ssh:thinkcentre`: the second address 192.168.0.89 was
 * retired, so the one host has one capability (#clw_01M5KVX6JJD2TT6K6KTXGMZ8RD).
 *
 * `prod-observability` -> `fleet-observability`: prod data is read through the
 * same fleet Grafana, so the one capability covers both clusters
 * (#clw_01M7Q9T4AQAGSG48Z3P7B273HR).
 */
export const CAPABILITY_RENAMES: Readonly<Record<string, string>> = {
  "ssh:k3s": "ssh:thinkcentre",
  "ssh:homeassistant": "ssh:thinkcentre",
  "prod-observability": "fleet-observability",
};

/** Maps each id through {@link CAPABILITY_RENAMES} and dedupes, keeping order. */
export function renameCapabilityIds(ids: string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const next = Object.hasOwn(CAPABILITY_RENAMES, id) ? CAPABILITY_RENAMES[id]! : id;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

/**
 * Capability ids that were retired, id -> the message a session asking for one
 * gets. The capability-request routes answer a request for one with a clean
 * denial carrying this message, so a pod on an older image that still asks for
 * it sees why; `db.ts` `migrateRetiredCapabilities` strips the id from stored
 * grants and remembered defaults and denies its pending requests at every boot.
 *
 * `infra-merge`: an approved infra PR whose verified plan destroys or replaces
 * nothing merges like any other PR, so the session stand-in for the human
 * merge is gone (#clw_01M7NKT2H402M07VGCAE1TBX8G).
 */
export const RETIRED_CAPABILITIES: Readonly<Record<string, string>> = {
  "infra-merge": "The infra-merge capability is retired: an approved infrastructure PR whose verified Tofu plan destroys or replaces nothing now merges like any other approved PR (claws_merge_pr), and a destructive, unverifiable or tofu-workflow change needs the operator's infra approval on the board.",
};

/** Whether `id` is a retired capability id ({@link RETIRED_CAPABILITIES}). */
export function isRetiredCapability(id: string): boolean {
  return Object.hasOwn(RETIRED_CAPABILITIES, id);
}

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
 */
export const CAPABILITY_RENAMES: Readonly<Record<string, string>> = {
  "ssh:k3s": "ssh:thinkcentre",
  "ssh:homeassistant": "ssh:thinkcentre",
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

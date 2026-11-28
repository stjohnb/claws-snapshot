// Kubernetes node renames (#clw_01M7RBFFEM2C6DQD1C3Z3EAEZ8). `CLAWS_NODE_ALIASES`
// (`old=new[,old=new]`) maps a node's previous hostname to its current one, so
// Claws accepts either while a node is renamed and stores only the new name:
// config lists, pod `nodeName`s and Node objects are read through
// `canonicalNode`, and every `kubernetes.io/hostname In` list Claws builds
// names the node under all its names (`nodeNames`). Env-only and restart-only;
// a malformed value throws, failing config load. A leaf module: config.ts and
// the db layer import it.

/** Old hostname → current hostname. */
export type NodeAliases = ReadonlyMap<string, string>;

const HOSTNAME_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i;

/**
 * Parse `CLAWS_NODE_ALIASES` from `env`. Each entry is `old=new` with both
 * sides node hostnames; an old name may appear once, may not equal its new
 * name, and may not itself be some other entry's new name (no chains).
 */
export function parseNodeAliases(env: NodeJS.ProcessEnv): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const entry of (env["CLAWS_NODE_ALIASES"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = entry.indexOf("=");
    const from = eq > 0 ? entry.slice(0, eq).trim() : "";
    const to = eq > 0 ? entry.slice(eq + 1).trim() : "";
    if (!HOSTNAME_RE.test(from) || !HOSTNAME_RE.test(to)) {
      throw new Error(`Invalid CLAWS_NODE_ALIASES entry "${entry}" — expected old=new with both node hostnames`);
    }
    if (from === to) throw new Error(`Invalid CLAWS_NODE_ALIASES entry "${entry}" — the old and new names are the same`);
    if (aliases.has(from)) throw new Error(`Invalid CLAWS_NODE_ALIASES entry "${entry}" — "${from}" is aliased twice`);
    aliases.set(from, to);
  }
  for (const [from, to] of aliases) {
    if (aliases.has(to)) throw new Error(`Invalid CLAWS_NODE_ALIASES entry "${from}=${to}" — "${to}" is itself an old name`);
  }
  return aliases;
}

/** `name`'s current name under `aliases`: its new name when it is an old one, else `name`. */
export function canonicalNodeIn(aliases: NodeAliases, name: string): string {
  return aliases.get(name) ?? name;
}

/** Every name of the node `canonical` under `aliases`: `canonical` first, then its old names in config order. */
export function nodeNamesIn(aliases: NodeAliases, canonical: string): string[] {
  const names = [canonical];
  for (const [from, to] of aliases) if (to === canonical) names.push(from);
  return names;
}

let processAliases: NodeAliases | null = null;

/**
 * This process's `CLAWS_NODE_ALIASES`, parsed on first use (after config.ts has
 * loaded `~/.claws/env`) and then fixed until restart.
 */
export function nodeAliases(): NodeAliases {
  processAliases ??= parseNodeAliases(process.env);
  return processAliases;
}

/** `name`'s current name: its new name when `CLAWS_NODE_ALIASES` lists it as an old one, else `name`. */
export function canonicalNode(name: string): string {
  return canonicalNodeIn(nodeAliases(), name);
}

/** Every name of the node `canonical`: `canonical` followed by its old names. */
export function nodeNames(canonical: string): string[] {
  return nodeNamesIn(nodeAliases(), canonical);
}

/** Every name of each node in `canonicals`, in order and without duplicates: a `kubernetes.io/hostname In` list. */
export function hostnameValues(canonicals: readonly string[]): string[] {
  return [...new Set(canonicals.flatMap((n) => nodeNames(n)))];
}

/** Replace (or, with null, re-read from `process.env` on next use) this process's aliases. Tests only. */
export function setNodeAliasesForTest(aliases: NodeAliases | null): void {
  processAliases = aliases;
}

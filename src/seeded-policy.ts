/**
 * The seed note `claws_create_repo` writes into the observability and
 * security policies it seeds before a repo has any code, and the check for
 * whether that repo has since gained code. While the note is present and
 * `firstNonSeedFile` finds a file, the `seeded-policy` drift rule in both
 * contracts asks for the real policy on the per-contract follow-up issue, and
 * `contract-audit` skips a policy that still carries the note.
 *
 * Leaf module: imports only the shared tree walker, never the contract,
 * drift or seed modules.
 */
import { walkRepoTree } from "./jobs/scanner-runner.js";

/**
 * One visible sentence on its own line in a seeded policy. The first pull
 * request that adds code rewrites the policy and deletes this line.
 */
export const SEEDED_POLICY_MARKER =
  "Claws seeded this policy when it created the repository, before the repository had any code. The first pull request that adds code must rewrite this policy for what the repository then ships, runs and exposes, and delete this line.";

/** Root files the seed (or a bare repo) holds, which are not code. */
const SEED_ROOT_FILES = new Set(["claws.json", "AGENTS.md", "README.md", ".gitignore", ".gitattributes"]);
/** Top-level directories that hold docs and agent configuration, not code. */
const SEED_DIRS = new Set(["docs", ".agents", ".claws", ".claude", ".skills", "ideas"]);

const MAX_DEPTH = 3;

function isSeedPath(rel: string): boolean {
  const slash = rel.indexOf("/");
  if (slash < 0) return SEED_ROOT_FILES.has(rel) || rel.startsWith("LICENSE");
  return SEED_DIRS.has(rel.slice(0, slash));
}

/**
 * The first repo-relative file (sorted) outside the seed set, so a repo that
 * has gained code or config to describe; null while the repo holds only what
 * Claws seeds, a README, a licence, git attributes and docs.
 */
export function firstNonSeedFile(repoDir: string): string | null {
  const found: string[] = [];
  walkRepoTree(repoDir, {
    maxDepth: MAX_DEPTH,
    onDirectory: ({ relPath, entries }) => {
      if (relPath !== "" && SEED_DIRS.has(relPath.split("/")[0]!)) return;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const rel = relPath === "" ? entry.name : `${relPath}/${entry.name}`;
        if (!isSeedPath(rel)) found.push(rel);
      }
    },
  });
  found.sort();
  return found[0] ?? null;
}

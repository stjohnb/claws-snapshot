/**
 * Vitest `setupFiles` entry: runs before each test file's imports and removes
 * the agent pod's own environment (Claws config, Forgejo/GitHub tokens, the
 * git-config credential helper, Claude Code settings) so unit tests see the
 * same blank environment on a laptop, in CI and inside a Claws agent pod.
 * Kubernetes service discovery (`KUBERNETES_SERVICE_HOST`) goes too, since it
 * flips `isContainer()`. A test that needs one of these variables sets it itself.
 */

/** Kept so `npm run test:pg` still selects the PGlite lane. */
const KEEP = new Set(["CLAWS_TEST_PGLITE"]);

const EXACT = new Set(["GIT_CONFIG_COUNT", "GH_TOKEN", "GITHUB_TOKEN", "KUBECONFIG"]);

const PREFIXES = ["CLAWS_", "CLAUDE_CODE_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_", "KUBERNETES_"];

/** True when `key` is pod environment a unit test must not inherit. */
export function isScrubbedEnvKey(key: string): boolean {
  if (KEEP.has(key)) return false;
  return EXACT.has(key) || PREFIXES.some((p) => key.startsWith(p));
}

for (const key of Object.keys(process.env)) {
  if (isScrubbedEnvKey(key)) delete process.env[key];
}

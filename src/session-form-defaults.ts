import {
  defaultCapabilitiesForRepo,
  defaultProviderAuthCapabilities,
  GITHUB_AUTH_CAPABILITY_ID,
  isAgentLoginCapability,
  isCapabilityAvailable,
  validCapabilityIds,
  withImplicitCapabilities,
} from "./capabilities.js";
import { sessionCapabilityDefaultsKey } from "./db.js";
import type { SessionMode, SessionProvider } from "./sessions.js";

/**
 * The capabilities the New session form on `/sessions` would pre-tick for
 * `repos` with `provider` selected, plus the automatic and forced grants it
 * shows as checked (`cross-repo`, `forgejo` for a Forgejo-hosted repo).
 * Mirrors `buildSessionsListPage` and the client's remembered-combination
 * re-tick in `client/sessions-list.ts`, so the board's Start session button
 * starts a session with exactly what the form would have submitted.
 *
 * `remembered` is `getAllSessionCapabilityDefaults()`: a combination's last
 * submitted set (even an empty one) beats the static seed. Agent-login
 * capabilities follow `provider`, never the remembered set.
 */
export function preselectedSessionCapabilities(
  repos: string[],
  remembered: Map<string, string[]>,
  provider: SessionProvider,
): string[] {
  const stored = repos.length > 0 ? remembered.get(sessionCapabilityDefaultsKey(repos)) : undefined;
  let repoDefaults: string[];
  if (repos.length === 0) {
    repoDefaults = [];
  } else if (stored) {
    repoDefaults = stored.filter((id) => !isAgentLoginCapability(id));
  } else if (repos.length === 1) {
    repoDefaults = defaultCapabilitiesForRepo(repos[0]!);
  } else {
    repoDefaults = isCapabilityAvailable(GITHUB_AUTH_CAPABILITY_ID) ? [GITHUB_AUTH_CAPABILITY_ID] : [];
  }
  const mode: SessionMode = repos.length === 0 ? "home-claude" : repos.length === 1 ? "worktree-claude" : "multi-worktree-claude";
  const ids = validCapabilityIds([...repoDefaults, ...defaultProviderAuthCapabilities(provider, mode)]);
  return withImplicitCapabilities(ids, repos);
}

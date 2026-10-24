import type { ResolveHookSync } from "node:module";

// The agent pod's `db.js` → `db-remote.js` redirect (#clw_01M386P9KPDEVV33TKY512HHBC),
// installed by `agent-pod/main.ts` with `module.registerHooks` before any
// service module loads. Every import that resolves to the real `db.js` gets the
// pod's ops-API client instead, except `db-remote.js`'s own, which re-exports
// the real module. Pure — no service imports, since it runs before them.

export function createDbRedirectResolve(dbUrl: string, remoteUrl: string): ResolveHookSync {
  return (specifier, context, nextResolve) => {
    const resolved = nextResolve(specifier, context);
    if (resolved.url === dbUrl && context.parentURL !== remoteUrl) return { ...resolved, url: remoteUrl };
    return resolved;
  };
}

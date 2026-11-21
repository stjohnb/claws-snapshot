import { describe, it, expect, vi } from "vitest";
import type { ResolveHookContext } from "node:module";
import { createDbRedirectResolve } from "./db-redirect.js";

const DB = "file:///opt/claws/dist/db.js";
const REMOTE = "file:///opt/claws/dist/db-remote.js";

function context(parentURL: string | undefined): ResolveHookContext {
  return { conditions: ["node", "import"], importAttributes: {}, parentURL };
}

describe("createDbRedirectResolve", () => {
  const resolve = createDbRedirectResolve(DB, REMOTE);

  it("rewrites an import of db.js to db-remote.js", () => {
    const next = vi.fn(() => ({ url: DB, format: "module" }));
    const out = resolve("./db.js", context("file:///opt/claws/dist/worker.js"), next);
    expect(out).toEqual({ url: REMOTE, format: "module" });
    expect(next).toHaveBeenCalledWith("./db.js", context("file:///opt/claws/dist/worker.js"));
  });

  it("rewrites a relative import from a nested module too", () => {
    const out = resolve("../db.js", context("file:///opt/claws/dist/agents/ci-fixer.js"), () => ({ url: DB }));
    expect(out.url).toBe(REMOTE);
  });

  it("leaves db-remote.js's own import of the real db.js alone", () => {
    const out = resolve("./db.js", context(REMOTE), () => ({ url: DB }));
    expect(out.url).toBe(DB);
  });

  it("leaves other modules alone", () => {
    const out = resolve("./db-driver-pg.js", context("file:///opt/claws/dist/db.js"), () => ({ url: "file:///opt/claws/dist/db-driver-pg.js" }));
    expect(out.url).toBe("file:///opt/claws/dist/db-driver-pg.js");
  });
});

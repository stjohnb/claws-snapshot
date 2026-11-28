import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `src/db.ts` is the only door to the database modules under `src/db/`
// (#clw_01M8A3RZ47A1W7E28W43TAFJ3G). Over a hundred test files mock
// `./db.js`, and the agent pod's resolve hook (src/agent-pod/db-redirect.ts)
// redirects only `db.js` to `db-remote.js`, so a service module importing
// `src/db/*` directly would slip past both. The other way round, a `src/db/*`
// module importing `../db.js` is a cycle through the façade, and in the agent
// pod that import resolves to `db-remote.js` instead of the real module.
const srcRoot = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.join(srcRoot, "db") + path.sep;
const facade = path.join(srcRoot, "db.ts");

// `src/db/*` modules that still import code not yet split out of the façade.
// Each later step of #clw_01M8A3RZ47A1W7E28W43TAFJ3G moves those names into a
// sibling module and drops its entry here; the list ends empty.
const NOT_YET_SPLIT = new Set(["schema.ts", "migrations.ts", "pr-reviews.ts"].map((f) => path.join(dbDir, f)));

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Relative import specifiers in `file`, resolved to `.ts` paths under src/. */
function relativeImports(file: string): string[] {
  const text = fs.readFileSync(file, "utf8");
  const specifiers = [
    ...text.matchAll(/\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g),
    ...text.matchAll(/\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g),
    ...text.matchAll(/^\s*import\s+["'](\.{1,2}\/[^"']+)["']/gm),
  ].map((m) => m[1]!);
  return specifiers.map((s) => path.resolve(path.dirname(file), s).replace(/\.js$/, ".ts"));
}

const files = walk(srcRoot);

describe("src/db.ts façade", () => {
  it("is the only module outside src/db/ that imports a src/db/* module", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === facade || file.startsWith(dbDir)) continue;
      for (const target of relativeImports(file)) {
        if (target.startsWith(dbDir)) offenders.push(`${path.relative(srcRoot, file)} -> ${path.relative(srcRoot, target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("is never imported by a src/db/* module", () => {
    const offenders: string[] = [];
    const stillImporting = new Set<string>();
    for (const file of files.filter((f) => f.startsWith(dbDir))) {
      if (!relativeImports(file).includes(facade)) continue;
      if (NOT_YET_SPLIT.has(file)) stillImporting.add(file);
      else offenders.push(path.relative(srcRoot, file));
    }
    expect(offenders).toEqual([]);
    // A stale entry would let a module that has stopped importing the façade start again unnoticed.
    expect([...NOT_YET_SPLIT].filter((f) => !stillImporting.has(f)).map((f) => path.relative(srcRoot, f))).toEqual([]);
  });
});

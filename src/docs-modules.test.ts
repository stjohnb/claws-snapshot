import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, relative, sep } from "path";

const srcDir = dirname(fileURLToPath(import.meta.url));
const modulesDocPath = join(srcDir, "../docs/modules.md");

/** Every non-test, non-declaration `.ts` file under `src/`, relative to `src/` with `/` separators. */
function listSourceModules(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceModules(full));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(relative(srcDir, full).split(sep).join("/"));
    }
  }
  return out;
}

/**
 * Paths named in entry headings: a line starting with `**` whose part before
 * the first em dash names one or more backticked paths.
 */
function headingPaths(markdown: string): Set<string> {
  const paths = new Set<string>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("**")) continue;
    const dash = line.indexOf("—");
    const head = dash === -1 ? line : line.slice(0, dash);
    for (const m of head.matchAll(/`([^`]+\.ts)`/g)) paths.add(m[1]);
  }
  return paths;
}

const modules = listSourceModules(srcDir).sort();
const documented = headingPaths(readFileSync(modulesDocPath, "utf-8"));

describe("docs/modules.md", () => {
  it("has an entry heading for every src module", () => {
    expect(modules.filter((m) => !documented.has(m))).toEqual([]);
  });

  it("names only modules that exist under src/", () => {
    const stale = [...documented].filter((p) => !existsSync(join(srcDir, p))).sort();
    expect(stale).toEqual([]);
  });
});

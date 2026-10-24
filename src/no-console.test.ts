import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every service log line goes through log.ts / log-core.ts so it carries the
// structured shape in docs/logging-conventions.md. The exemptions: CLI tools
// (their output is for a human at a terminal), browser code and vendored
// browser bundles, and the two modules that do the actual write.
const srcRoot = path.dirname(fileURLToPath(import.meta.url));

const EXEMPT_DIRS = ["tools", "client", "resources"].map((d) => path.join(srcRoot, d) + path.sep);
const EXEMPT_FILES = new Set(["log-core.ts", path.join("session-pod", "log.ts")].map((f) => path.join(srcRoot, f)));

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.includes(full + path.sep)) files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !EXEMPT_FILES.has(full)) {
      files.push(full);
    }
  }
  return files;
}

describe("no direct console.* in src/", () => {
  it("routes every log line through the logger", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (/\bconsole\.\w+\s*\(/.test(line)) {
          offenders.push(`${path.relative(srcRoot, file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

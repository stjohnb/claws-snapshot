import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `safeRead` wrapped config reads in `try { return read() } catch { return
// fallback }` so tests could mock ./config.js partially. In production it hid
// the temporal-dead-zone ReferenceError from the config.ts → … →
// capabilities.ts import cycle, so the Mac SSH capabilities silently never
// registered (#clw_01M70191MPKP6VW93C1XE8NQG2). Read config bindings directly
// and complete partial test mocks with `completeConfigMock` instead.
const srcRoot = path.dirname(fileURLToPath(import.meta.url));

const EXEMPT_DIRS = ["tools", "client", "resources"].map((d) => path.join(srcRoot, d) + path.sep);

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXEMPT_DIRS.includes(full + path.sep)) files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("no catch-and-fallback config-read helper in src/", () => {
  it("has no safeRead and no try { return read() } wrapper", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const text = fs.readFileSync(file, "utf8");
      const rel = path.relative(srcRoot, file);
      text.split("\n").forEach((line, i) => {
        if (/\bsafeRead\b/.test(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
      if (/try\s*\{\s*return\s+read\(\)/.test(text)) offenders.push(`${rel}: try { return read() } wrapper`);
    }
    expect(offenders).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A fault Claws files itself (reportError, ensureAlertIssue, upsertAlertIssue)
// must not also log an untagged `error` line: the fleet `Claws Error Logs`
// rule would raise a second issue. reportError already logs the tagged line,
// so a `log.error` right before it is redundant. See docs/observability.md.
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

describe("log.error before reportError", () => {
  it("never logs an untagged error line for a fault reportError files", () => {
    const offenders: string[] = [];
    for (const file of walk(srcRoot)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/\blog\.error\(/.test(line) || line.includes("alert_issue")) return;
        const next = lines.slice(i + 1).filter((l) => l.trim() !== "").slice(0, 3);
        if (next.some((l) => l.includes("reportError("))) {
          offenders.push(`${path.relative(srcRoot, file)}:${i + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});

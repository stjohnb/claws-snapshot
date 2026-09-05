import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_JOB_NAMES } from "./jobs-matrix.js";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

const files = walk(srcRoot);

function readFile(relativePath: string): string {
  return fs.readFileSync(path.join(srcRoot, relativePath), "utf-8");
}

describe("REPO_JOB_NAMES drift guard", () => {
  it("contains every job name gated via isJobDisabledForRepo(...)", () => {
    const found = new Set<string>();
    const gateRe = /isJobDisabledForRepo\(\s*"([^"]+)"/g;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf-8");
      for (const m of content.matchAll(gateRe)) found.add(m[1]);
    }

    const mainTs = readFile("main.ts");
    const smartScheduledRe = /smartScheduled(?:Batch)?Job\(\s*"([^"]+)"/g;
    for (const m of mainTs.matchAll(smartScheduledRe)) found.add(m[1]);

    const scannerDispatcherTs = readFile("jobs/scanner-dispatcher.ts");
    const scannerRe = /\{\s*name:\s*"([^"]+)",\s*run:/g;
    for (const m of scannerDispatcherTs.matchAll(scannerRe)) found.add(m[1]);

    const nameConstRe = /^const NAME = "([^"]+)"/m;
    const publicRepoScannerMatch = readFile("jobs/public-repo-scanner.ts").match(nameConstRe);
    if (publicRepoScannerMatch) found.add(publicRepoScannerMatch[1]);
    const actionsStorageMonitorMatch = readFile("jobs/actions-storage-monitor.ts").match(nameConstRe);
    if (actionsStorageMonitorMatch) found.add(actionsStorageMonitorMatch[1]);

    const known = new Set<string>(REPO_JOB_NAMES);
    const missing = [...found].filter((name) => !known.has(name));
    expect(missing).toEqual([]);
  });
});

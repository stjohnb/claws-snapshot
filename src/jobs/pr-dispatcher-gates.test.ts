import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { PR_DISPATCHER_GATES } from "./pr-dispatcher.js";
import { isSubScannerName } from "./scanner-dispatcher.js";

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("isJobDisabledForRepo literal names", () => {
  it("every literal is a scheduler job, sub-scanner or pr-dispatcher gate", () => {
    const main = readFileSync("src/main-controller.ts", "utf8");
    const gates = new Set<string>(PR_DISPATCHER_GATES);
    const unknown: string[] = [];
    for (const file of walk("src")) {
      for (const m of readFileSync(file, "utf8").matchAll(/isJobDisabledForRepo\(\s*"([^"]+)"/g)) {
        const name = m[1];
        // Scheduler jobs are registered by name in main-controller.
        const registered = main.includes(`"${name}"`);
        if (!registered && !gates.has(name) && !isSubScannerName(name)) unknown.push(`${file}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });
});

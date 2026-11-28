import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// New log lines keep `msg` constant and pass ids and values as fields (see
// docs/observability.md). Add a file here once it has been converted.
const CONVERTED = ["session-move.ts", "issue-filer.ts"];
const srcRoot = path.dirname(fileURLToPath(import.meta.url));

describe("converted files keep log messages constant", () => {
  for (const file of CONVERTED) {
    it(`${file} interpolates nothing into msg`, () => {
      const text = fs.readFileSync(path.join(srcRoot, file), "utf8");
      const offenders = text
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => /\blog\.(debug|info|warn|error)\(\s*`[^`]*\$\{/.test(line))
        .map(({ line, n }) => `${file}:${n}: ${line.trim()}`);
      expect(offenders).toEqual([]);
    });
  }
});

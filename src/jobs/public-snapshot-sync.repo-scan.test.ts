import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSecretPatternHits } from "./public-snapshot-sync.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function trackedFiles(): string[] | null {
  try {
    return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
      .toString("utf-8")
      .split("\0")
      .filter(Boolean);
  } catch {
    return null;
  }
}

describe("public snapshot secret scan over this repo", () => {
  it("no tracked file in this repo trips the snapshot secret scan", () => {
    const files = trackedFiles();
    if (!files) return; // no git checkout (e.g. tarball) — CI has one
    const hits: string[] = [];
    // Files over 5 MB or with a NUL in the first 8 KB are skipped here, though the nightly job
    // still scans oversized files in chunks; unlikely for tracked source, so accepted.
    for (const rel of files) {
      const abs = path.join(repoRoot, rel);
      let buf: Buffer;
      try {
        const st = fs.statSync(abs);
        if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
        buf = fs.readFileSync(abs);
      } catch {
        continue;
      }
      if (buf.subarray(0, 8192).includes(0)) continue;
      for (const name of findSecretPatternHits(rel, buf.toString("utf-8"))) hits.push(`${rel} (${name})`);
    }
    expect(hits).toEqual([]);
  });
});

import fs from "node:fs";
import path from "node:path";

/**
 * Well-known directories where CLI tools are commonly installed by language-
 * specific installers (cargo, go install, pip/pipx, bun, opencode installer,
 * etc.). These are often added to PATH via shell profiles (~/.zshrc) which
 * are not sourced by systemd services.
 */
const EXTRA_BIN_DIRS: string[] = (() => {
  const home = process.env["HOME"] ?? "/root";
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(home, "go", "bin"),
    path.join(home, ".bun", "bin"),
    "/usr/local/bin",
  ];
})();

/**
 * Return a PATH string with well-known bin directories prepended to the
 * base PATH. Only directories that actually exist on disk are added.
 */
export function enrichedPath(basePath: string | undefined): string {
  const existing = basePath ?? "";
  const parts = existing.split(path.delimiter).filter(Boolean);
  const partsSet = new Set(parts);
  const prepend: string[] = [];
  for (const dir of EXTRA_BIN_DIRS) {
    if (!partsSet.has(dir) && fs.existsSync(dir)) {
      prepend.push(dir);
    }
  }
  if (prepend.length === 0) return existing;
  return [...prepend, ...parts].join(path.delimiter);
}

/**
 * Returns true if the named CLI binary is findable in the enriched PATH.
 * If the binary is present we assume it is usable; runtime failures still
 * surface through the normal error path.
 */
export function isCliBinaryAvailable(binary: string): boolean {
  const dirs = enrichedPath(process.env["PATH"]).split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      if (fs.existsSync(path.join(dir, binary))) return true;
    } catch {
      // ignore permission / stat errors on individual dirs
    }
  }
  return false;
}

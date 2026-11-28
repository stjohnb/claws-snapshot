import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A test that replaces `config.js` with a hand-written stub breaks as soon as
// any module it loads reads a new `config.ts` export (#clw_01M7TVFPVA2WDSBHXZY089PD2N).
// Every config mock starts from the real module via `importOriginal` and
// `completeConfigMock` in `src/test-helpers.ts`, overriding only what it needs.
const srcRoot = path.dirname(fileURLToPath(import.meta.url));

// config.ts ↔ github-app.ts import each other; these tests run the real
// buildForgejoGitAuthEnv, which would bind to the real config instead of the mock.
const ALLOWLIST = ["claude.test.ts", "session-pod-launch.test.ts"];

// Built from parts so this file's own text does not match the pattern.
const MOCK_CALL = new RegExp(["vi\\.(?:do)?", "[mM]ock\\(\\s*", "[\"'`]\\.\\.?/config\\.js[\"'`]"].join(""), "g");

const TARGET_FORM =
  'vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), MOCK));';

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

describe("no wholesale config.js mock in tests", () => {
  it("mocks config.js only on top of importOriginal", () => {
    const offenders = new Set<string>();
    for (const file of walk(srcRoot)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(MOCK_CALL)) {
        const from = m.index;
        const eol = text.indexOf("\n", from);
        const lineEnd = eol === -1 ? text.length : eol;
        const window = text.slice(from, Math.max(lineEnd, from + m[0].length + 200));
        if (!window.includes("importOriginal")) offenders.add(path.relative(srcRoot, file).split(path.sep).join("/"));
      }
    }
    expect(
      [...offenders].sort(),
      `Mock config.js with completeConfigMock from src/test-helpers.ts on top of importOriginal, e.g.\n  ${TARGET_FORM}\nso a new config.ts export needs no test edits.`,
    ).toEqual(ALLOWLIST);
  });
});

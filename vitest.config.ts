import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Every test worker gets one empty, throwaway HOME, so nothing reads the real
// ~/.claws/config.json (runtime-paths.ts derives CONFIG_PATH from
// os.homedir()). In an agent pod that file carries model overrides that made
// src/model-selector-defaults.test.ts fail on unmodified main. A test that
// needs a file under ~ creates it, as on a clean CI runner.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "claws-test-home-"));
process.on("exit", () => fs.rmSync(testHome, { recursive: true, force: true }));

// Both lanes run with a 30s per-test and per-hook budget. The PGlite lane
// (`npm run test:pg`) boots an in-process Postgres (wasm) on first database use,
// ~3.5s on a healthy runner. In the default lane the budget absorbs CPU
// starvation on shared Forgejo runners (fast tests timed out at 5s while the
// node ran at full CPU under concurrent jobs). A hung test still fails in 30s.
export default defineConfig({
  test: {
    // Vitest 4 dropped **/dist/** from its default `exclude`. Because CI runs
    // `npm run build` (tsc emits dist/**/*.test.js from the co-located tests)
    // before `npm test`, the whole suite would otherwise run twice — once from
    // src/, once from a stale compiled copy — doubling runtime and log volume.
    // The TypeScript sources under src/ are the suite.
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
    // Strips the agent pod's own CLAWS_*, GIT_CONFIG_*, CLAUDE_CODE_* and
    // token variables before each file's imports, so the suite passes
    // inside a Claws agent pod as it does in CI.
    setupFiles: ["./src/test-env-scrub.ts"],
    env: { HOME: testHome },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

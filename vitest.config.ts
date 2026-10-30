import { defineConfig } from "vitest/config";

// The PGlite lane (`npm run test:pg`) boots an in-process Postgres (wasm) the
// first time each test file touches the database. That startup costs roughly
// 3.4–3.6s on a healthy Forgejo runner, so the first test of each file can
// approach Vitest's 5s default `testTimeout` and fail on a slow runner. The wider budget applies only to that lane; a hung test still
// fails within 30s. The default `npm test` lane keeps Vitest's defaults.
const pgliteLane = process.env["CLAWS_TEST_PGLITE"] === "1";

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
    ...(pgliteLane ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
  },
});

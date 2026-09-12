import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest 4 dropped **/dist/** from its default `exclude`. Because CI runs
    // `npm run build` (tsc emits dist/**/*.test.js from the co-located tests)
    // before `npm test`, the whole suite would otherwise run twice — once from
    // src/, once from a stale compiled copy — doubling runtime and log volume.
    // The TypeScript sources under src/ are the suite.
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
  },
});

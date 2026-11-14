import { describe, expect, it } from "vitest";
import { isScrubbedEnvKey } from "./test-env-scrub.js";

describe("test-env-scrub", () => {
  it("leaves no pod environment in the test process", () => {
    const leaked = Object.keys(process.env).filter(isScrubbedEnvKey);
    expect(leaked).toEqual([]);
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "KUBECONFIG", "GIT_CONFIG_COUNT"]) {
      expect(process.env[key]).toBeUndefined();
    }
  });

  it("scrubs Claws, Claude Code and git-config keys but keeps the PGlite switch", () => {
    for (const key of [
      "CLAWS_FORGEJO_READ_TOKEN",
      "CLAWS_POD_ROW",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "KUBECONFIG",
      "KUBERNETES_SERVICE_HOST",
      "KUBERNETES_PORT_443_TCP",
    ]) {
      expect(isScrubbedEnvKey(key), key).toBe(true);
    }
    expect(isScrubbedEnvKey("CLAWS_TEST_PGLITE")).toBe(false);
    expect(isScrubbedEnvKey("PATH")).toBe(false);
    expect(isScrubbedEnvKey("HOME")).toBe(false);
  });
});

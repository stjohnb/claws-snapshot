import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SENSITIVE_ENV_KEYS } from "./sensitive-env.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("SENSITIVE_ENV_KEYS", () => {
  it("contains the six container-injected / config secrets added for #2837", () => {
    for (const key of [
      "CLAWS_SSH_PRIVATE_KEY",
      "CLAWS_KUBECONFIG",
      "CLAWS_CODEX_AUTH_JSON",
      "CLAWS_CLAUDE_SETTINGS_JSON",
      "CLAWS_FORGEJO_TOKEN",
      "CLAWS_SLACK_PROD_ALERTS_WEBHOOK",
    ]) {
      expect(SENSITIVE_ENV_KEYS).toContain(key);
    }
  });

  it("still contains the pre-existing sensitive keys", () => {
    for (const key of ["CLAWS_AUTH_TOKEN", "CLAWS_OIDC_CLIENT_SECRET", "OPENAI_API_KEY"]) {
      expect(SENSITIVE_ENV_KEYS).toContain(key);
    }
  });

  it("does not strip keys agents legitimately need", () => {
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "KUBECONFIG",
      "HOME",
      "PATH",
    ]) {
      expect(SENSITIVE_ENV_KEYS).not.toContain(key);
    }
  });

  it("has no duplicate entries", () => {
    expect(new Set(SENSITIVE_ENV_KEYS).size).toBe(SENSITIVE_ENV_KEYS.length);
  });

  it("deploy/container-entrypoint.sh unsets the four disk-materialised secrets before exec node", () => {
    const script = readFileSync(join(repoRoot, "deploy/container-entrypoint.sh"), "utf8");
    const execIdx = script.indexOf("exec node");
    const unsetIdx = script.indexOf("unset ");
    expect(execIdx).toBeGreaterThan(-1);
    expect(unsetIdx).toBeGreaterThan(-1);
    expect(unsetIdx).toBeLessThan(execIdx);
    for (const key of [
      "CLAWS_SSH_PRIVATE_KEY",
      "CLAWS_KUBECONFIG",
      "CLAWS_CODEX_AUTH_JSON",
      "CLAWS_CLAUDE_SETTINGS_JSON",
    ]) {
      const line = script.split("\n").find((l) => l.startsWith("unset ") && l.includes(key));
      expect(line, `expected an unset line naming ${key}`).toBeDefined();
    }
  });
});

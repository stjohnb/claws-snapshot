import { describe, it, expect } from "vitest";
import { extractOwnerFromGhArgs, base64UrlEncodeString, buildEnvForGh, buildEnvForGhGit, isRetryableFetchError } from "./github-app.js";

describe("extractOwnerFromGhArgs", () => {
  it("extracts owner from --repo flag", () => {
    expect(extractOwnerFromGhArgs(["pr", "view", "42", "--repo", "stjohnb/claws"])).toBe("stjohnb");
  });

  it("extracts owner from repo clone", () => {
    expect(extractOwnerFromGhArgs(["repo", "clone", "stjohnb/claws", "/tmp/wt"])).toBe("stjohnb");
  });

  it("extracts owner from repo list", () => {
    expect(extractOwnerFromGhArgs(["repo", "list", "stjohnb", "--json", "name"])).toBe("stjohnb");
  });

  it("extracts owner from api repos/<owner>/<name>/...", () => {
    expect(extractOwnerFromGhArgs(["api", "repos/stjohnb/claws/issues"])).toBe("stjohnb");
    expect(extractOwnerFromGhArgs(["api", "/repos/stjohnb/claws/pulls/1"])).toBe("stjohnb");
  });

  it("extracts owner from api orgs/<owner>/...", () => {
    expect(extractOwnerFromGhArgs(["api", "orgs/St-John-Software/installation"])).toBe("St-John-Software");
  });

  it("extracts owner from api users/<owner>/...", () => {
    expect(extractOwnerFromGhArgs(["api", "users/stjohnb/installation"])).toBe("stjohnb");
  });

  it("returns null when no owner is present", () => {
    expect(extractOwnerFromGhArgs(["auth", "status"])).toBeNull();
    expect(extractOwnerFromGhArgs(["api", "rate_limit"])).toBeNull();
    expect(extractOwnerFromGhArgs([])).toBeNull();
  });

  it("handles --repo without a following argument", () => {
    expect(extractOwnerFromGhArgs(["pr", "list", "--repo"])).toBeNull();
  });

  it("ignores malformed repo slugs", () => {
    expect(extractOwnerFromGhArgs(["pr", "view", "--repo", "no-slash"])).toBeNull();
  });
});

describe("base64UrlEncodeString", () => {
  it("encodes without padding", () => {
    expect(base64UrlEncodeString("hi")).toBe("aGk");
  });

  it("uses base64url alphabet (no +/ and no =)", () => {
    // "??>" in base64 is "Pz8+" (contains +); ensure replacement
    const raw = Buffer.from("??>", "utf-8").toString("base64");
    expect(raw).toContain("+");
    const encoded = base64UrlEncodeString("??>");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("encodes JWT header deterministically", () => {
    // {"alg":"RS256","typ":"JWT"} — a common JWT header
    expect(base64UrlEncodeString('{"alg":"RS256","typ":"JWT"}')).toBe("eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9");
  });
});

describe("buildEnvForGh", () => {
  it("returns process.env clone when token is null", () => {
    const env = buildEnvForGh(null);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("sets GH_TOKEN and GITHUB_TOKEN when token provided", () => {
    const env = buildEnvForGh("ghs_testtoken123");
    expect(env.GH_TOKEN).toBe("ghs_testtoken123");
    expect(env.GITHUB_TOKEN).toBe("ghs_testtoken123");
  });
});

describe("isRetryableFetchError", () => {
  it("returns false for non-Error values", () => {
    expect(isRetryableFetchError("string error")).toBe(false);
    expect(isRetryableFetchError(null)).toBe(false);
    expect(isRetryableFetchError({ message: "fetch failed" })).toBe(false);
  });

  it("returns true for bare 'fetch failed' message", () => {
    expect(isRetryableFetchError(new Error("fetch failed"))).toBe(true);
  });

  it("returns true for listInstallationRepositories HTTP 5xx errors", () => {
    expect(isRetryableFetchError(new Error("[github-app] listInstallationRepositories HTTP 503: Service Unavailable"))).toBe(true);
    expect(isRetryableFetchError(new Error("[github-app] listInstallationRepositories HTTP 500: Internal Server Error"))).toBe(true);
    expect(isRetryableFetchError(new Error("[github-app] listInstallationRepositories HTTP 502: Bad Gateway"))).toBe(true);
    expect(isRetryableFetchError(new Error("[github-app] listInstallationRepositories HTTP 504: Gateway Timeout"))).toBe(true);
  });

  it("returns true for token-minting HTTP 5xx errors", () => {
    expect(isRetryableFetchError(new Error("[github-app] HTTP 503 Service Unavailable for https://api.github.com/app/installations/123/access_tokens: body"))).toBe(true);
    expect(isRetryableFetchError(new Error("[github-app] HTTP 500 Internal Server Error for https://api.github.com/app/installations/456/access_tokens: body"))).toBe(true);
  });

  it("returns false for non-retryable HTTP errors (401, 403, 404)", () => {
    expect(isRetryableFetchError(new Error("[github-app] listInstallationRepositories HTTP 401: Unauthorized"))).toBe(false);
    expect(isRetryableFetchError(new Error("[github-app] HTTP 403 Forbidden for https://api.github.com/app/installations/123/access_tokens: body"))).toBe(false);
    expect(isRetryableFetchError(new Error("[github-app] listInstallationRepositories HTTP 404: Not Found"))).toBe(false);
  });

  it("returns true for errors with retryable cause codes", () => {
    const econnreset = Object.assign(new Error("socket hang up"), { cause: new Error("ECONNRESET") });
    expect(isRetryableFetchError(econnreset)).toBe(true);

    const etimedout = Object.assign(new Error("network error"), { cause: new Error("ETIMEDOUT") });
    expect(isRetryableFetchError(etimedout)).toBe(true);
  });

  it("returns false for errors with non-retryable cause", () => {
    const err = Object.assign(new Error("some error"), { cause: new Error("EACCES: permission denied") });
    expect(isRetryableFetchError(err)).toBe(false);
  });
});

describe("buildEnvForGhGit", () => {
  it("configures an inline credential helper via GIT_CONFIG_* env vars", () => {
    const env = buildEnvForGhGit("ghs_abcDEF_123");
    expect(env.GH_TOKEN).toBe("ghs_abcDEF_123");
    expect(env.GITHUB_TOKEN).toBe("ghs_abcDEF_123");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("x-access-token");
    expect(env.GIT_CONFIG_VALUE_0).toContain("ghs_abcDEF_123");
  });

  it("rejects tokens containing shell metacharacters", () => {
    expect(() => buildEnvForGhGit("abc; rm -rf /")).toThrow(/unsafe/i);
    expect(() => buildEnvForGhGit("abc$(whoami)")).toThrow(/unsafe/i);
    expect(() => buildEnvForGhGit("abc'quote")).toThrow(/unsafe/i);
  });
});

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

vi.mock("node:fs", () => ({
  default: { readFileSync: vi.fn(() => privateKey) },
  readFileSync: vi.fn(() => privateKey),
}));

// FORGEJO_TOKEN is a live `export let` binding in config.ts, so the mock exposes
// it through a getter that tests can flip between the token-set and token-unset
// shapes of buildEnvForGhGit.
const forgejoCfg = vi.hoisted(() => ({
  token: undefined as string | undefined,
  baseUrl: "https://git.home.bstjohn.net",
}));

vi.mock("./config.js", () => ({
  GITHUB_APP_ID: 0,
  GITHUB_APP_PRIVATE_KEY_PATH: "",
  GITHUB_APP_INSTALLATION_IDS: {},
  GITHUB_OWNERS: ["test-owner"],
  GITHUB_OWNER_APP_CREDENTIALS: {
    "test-owner": { appId: 123, privateKeyPath: "/fake/key.pem", installationId: 456 },
  },
  get FORGEJO_BASE_URL() {
    return forgejoCfg.baseUrl;
  },
  get FORGEJO_TOKEN() {
    return forgejoCfg.token;
  },
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock("./slack.js", () => ({
  notify: vi.fn(),
}));

import { extractOwnerFromGhArgs, describeGhCallShape, GH_API_VALUE_FLAGS, GH_COMMAND_VALUE_FLAGS, GH_COMMAND_BOOLEAN_FLAGS, base64UrlEncodeString, buildEnvForGh, buildEnvForGhGit, buildGitAuthEnv, isRetryableFetchError, listInstallationRepositories, fetchRateLimitResetMs, getInstallationCoreRateLimit, describeTokenShape, invalidateInstallationToken, buildGitEnvForOwner, resetGitHubAppState } from "./github-app.js";
import { RateLimitError, isRateLimited, setRateLimited, clearRateLimitState } from "./rate-limit.js";
import * as log from "./log.js";

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

  it("extracts owner from api graphql -f owner=<owner>", () => {
    expect(extractOwnerFromGhArgs(["api", "graphql", "-f", "owner=acme", "-f", "name=repo", "-f", "query=..."])).toBe("acme");
  });

  it("extracts owner when flags precede the api endpoint (#3126)", () => {
    expect(extractOwnerFromGhArgs(["api", "--method", "PATCH", "repos/acme/claws/issues/comments/1", "-f", "body=x"])).toBe("acme");
    expect(extractOwnerFromGhArgs(["api", "-X", "DELETE", "repos/acme/claws/git/refs/heads/b"])).toBe("acme");
    expect(extractOwnerFromGhArgs(["api", "--paginate", "-H", "Accept: application/json", "/repos/acme/claws/pulls"])).toBe("acme");
  });

  it("does not mistake a flag value for the api endpoint", () => {
    expect(extractOwnerFromGhArgs(["api", "-f", "path=repos/evil/x", "rate_limit"])).toBeNull();
    expect(extractOwnerFromGhArgs(["api", "--method", "PATCH"])).toBeNull();
  });

  it("extracts owner from api graphql -f owner=<owner> after leading flags", () => {
    expect(extractOwnerFromGhArgs(["api", "-H", "X: y", "graphql", "-f", "owner=acme", "-f", "query=..."])).toBe("acme");
  });

  it("returns null for graphql with the owner inlined in the query", () => {
    expect(extractOwnerFromGhArgs(["api", "graphql", "-f", `query=query { repository(owner: "acme", name: "x") { id } }`])).toBeNull();
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

  it("does not misread a --repo appearing as another flag's value", () => {
    expect(extractOwnerFromGhArgs(["issue", "create", "--title", "--repo", "--repo", "acme/x"])).toBe("acme");
  });

  it("extracts owner from the -R alias", () => {
    expect(extractOwnerFromGhArgs(["pr", "view", "-R", "acme/x"])).toBe("acme");
  });

  it("does not misread a -R appearing as another flag's value", () => {
    expect(extractOwnerFromGhArgs(["issue", "create", "--title", "-R", "-R", "acme/x"])).toBe("acme");
  });

  it("extracts owner from the --repo=<owner>/<name> inline form", () => {
    expect(extractOwnerFromGhArgs(["pr", "view", "42", "--repo=acme/x"])).toBe("acme");
  });
});

describe("describeGhCallShape", () => {
  it("redacts a flag-first api call to endpoint + flag names, dropping values", () => {
    expect(describeGhCallShape(["api", "--method", "PATCH", "repos/acme/claws/issues/comments/1", "-f", "body=SECRET"]))
      .toBe("api repos/acme/claws/issues/comments/1 [--method -f]");
  });

  it("falls back to (no endpoint) when the api call has none", () => {
    expect(describeGhCallShape(["api", "--method", "PATCH"])).toBe("api (no endpoint) [--method]");
  });

  it("describes a non-api call as <subcommand> <sub-subcommand> [flag names]", () => {
    expect(describeGhCallShape(["issue", "edit", "123", "--repo", "acme/x", "--add-label", "Refined"]))
      .toBe("issue edit [--repo --add-label]");
  });

  it("truncates --flag=value forms to the flag name only", () => {
    expect(describeGhCallShape(["pr", "view", "42", "--repo=acme/x"])).toBe("pr view [--repo]");
  });
});

// The value-flag allowlists are what stops a flag *value* (a label description,
// a release notes body) from being misread as a `--repo`, so they must not
// drift out of sync with the call sites they protect.
describe("gh flag allowlists vs src/github.ts call sites", () => {
  it("classifies every flag literal src/github.ts passes to gh()", async () => {
    // node:fs is mocked at the top of this file for the App private key, so
    // read through the (unmocked) promises API instead.
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./github.ts", import.meta.url), "utf8");
    const known = new Set([
      ...GH_API_VALUE_FLAGS,
      ...GH_COMMAND_VALUE_FLAGS,
      ...GH_COMMAND_BOOLEAN_FLAGS,
      // Read by extractOwnerFromGhArgs' own scan, not the generic walker.
      "--repo", "-R",
    ]);
    const flags = new Set(
      [...source.matchAll(/"(--?[A-Za-z][A-Za-z0-9-]*)"/g)].map((m) => m[1]),
    );
    expect([...flags].filter((f) => !known.has(f))).toEqual([]);
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
  beforeEach(() => {
    forgejoCfg.token = undefined;
    forgejoCfg.baseUrl = "https://git.home.bstjohn.net";
  });

  it("configures an inline credential helper via GIT_CONFIG_* env vars", () => {
    const env = buildEnvForGhGit("ghs_abcDEF_123");
    expect(env.GH_TOKEN).toBe("ghs_abcDEF_123");
    expect(env.GITHUB_TOKEN).toBe("ghs_abcDEF_123");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("x-access-token");
    expect(env.GIT_CONFIG_VALUE_0).toContain("$CLAWS_GIT_CREDENTIAL_TOKEN");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("ghs_abcDEF_123");
    expect(env.CLAWS_GIT_CREDENTIAL_TOKEN).toBe("ghs_abcDEF_123");
  });

  it("never places token bytes into the credential helper source", () => {
    const env = buildEnvForGhGit("ghs_abc$(whoami)'x`y");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("whoami");
    expect(env.GIT_CONFIG_VALUE_0).toBe(buildEnvForGhGit("ghs_plain").GIT_CONFIG_VALUE_0);
  });

  it("accepts a realistic ghs_ token", () => {
    expect(() => buildEnvForGhGit("ghs_" + "a".repeat(36))).not.toThrow();
  });

  it("accepts a legacy v1.<hex> token", () => {
    expect(() => buildEnvForGhGit("v1." + "0123456789abcdef".repeat(2) + "01234567")).not.toThrow();
  });

  it("rejects empty and whitespace-only tokens", () => {
    expect(() => buildEnvForGhGit("")).toThrow(/empty token/i);
    expect(() => buildEnvForGhGit("   ")).toThrow(/empty token/i);
  });

  it("rejects null and undefined", () => {
    expect(() => buildEnvForGhGit(undefined as unknown as string)).toThrow(/missing token/i);
    expect(() => buildEnvForGhGit(null as unknown as string)).toThrow(/missing token/i);
  });

  it("never includes the token value in a rejection message", () => {
    try {
      buildEnvForGhGit("ghs_secret value");
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("emits exactly one helper when no Forgejo token is configured", () => {
    const env = buildEnvForGhGit("ghs_abcDEF_123");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_1).toBeUndefined();
    expect(env.CLAWS_FORGEJO_GIT_TOKEN).toBeUndefined();
  });

  it("appends a second helper for the Forgejo host when a token is configured", () => {
    forgejoCfg.token = "forgejo-tok";
    const env = buildEnvForGhGit("ghs_abcDEF_123");
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    // The GitHub helper is untouched, so existing push/fetch paths are unchanged.
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_KEY_1).toBe("credential.https://git.home.bstjohn.net.helper");
    expect(env.GIT_CONFIG_VALUE_1).toContain("oauth2");
    expect(env.GIT_CONFIG_VALUE_1).toContain("$CLAWS_FORGEJO_GIT_TOKEN");
    expect(env.GIT_CONFIG_VALUE_1).not.toContain("forgejo-tok");
    expect(env.CLAWS_FORGEJO_GIT_TOKEN).toBe("forgejo-tok");
  });

  it("strips a trailing slash from the Forgejo base URL in the helper key", () => {
    forgejoCfg.token = "forgejo-tok";
    forgejoCfg.baseUrl = "https://forge.example.com//";
    expect(buildEnvForGhGit("ghs_abcDEF_123").GIT_CONFIG_KEY_1).toBe(
      "credential.https://forge.example.com.helper",
    );
  });

  it("ignores a blank Forgejo token", () => {
    forgejoCfg.token = "   ";
    const env = buildEnvForGhGit("ghs_abcDEF_123");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.CLAWS_FORGEJO_GIT_TOKEN).toBeUndefined();
  });
});

describe("buildGitAuthEnv", () => {
  afterEach(() => {
    forgejoCfg.token = undefined;
  });

  it("returns only the auth vars, none of process.env", () => {
    forgejoCfg.token = "forgejo-tok";
    vi.stubEnv("CLAWS_DATABASE_URL", "postgres://secret");
    try {
      const env = buildGitAuthEnv("ghs_abcDEF_123");
      expect(Object.keys(env).sort()).toEqual([
        "CLAWS_FORGEJO_GIT_TOKEN",
        "CLAWS_GIT_CREDENTIAL_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_KEY_1",
        "GIT_CONFIG_VALUE_0",
        "GIT_CONFIG_VALUE_1",
        "GIT_TERMINAL_PROMPT",
      ]);
      expect(buildEnvForGhGit("ghs_abcDEF_123")).toEqual({ ...process.env, ...env });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects an unusable token", () => {
    expect(() => buildGitAuthEnv("")).toThrow(/empty token/i);
  });
});

describe("describeTokenShape", () => {
  it("describes null and undefined", () => {
    expect(describeTokenShape(undefined)).toBe("type=undefined");
    expect(describeTokenShape(null)).toBe("type=null");
  });

  it("describes a string without leaking the full value", () => {
    const desc = describeTokenShape("ghs_abcDEF_123");
    expect(desc).toContain("len=");
    expect(desc).toContain("prefix=ghs_");
    expect(desc).not.toContain("abcDEF_123");
  });
});

describe("buildGitEnvForOwner", () => {
  beforeEach(() => {
    resetGitHubAppState();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockFetchWithMintSequence(tokens: string[]) {
    let call = 0;
    return vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        const token = tokens[Math.min(call, tokens.length - 1)];
        call++;
        return {
          ok: true,
          status: 200,
          json: async () => ({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        } as Response;
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
  }

  it("evicts a poisoned cache entry and recovers on retry", async () => {
    vi.stubGlobal("fetch", mockFetchWithMintSequence(["bad token", "ghs_" + "a".repeat(36)]));

    const env = await buildGitEnvForOwner("test-owner");
    expect(env).toBeDefined();
    expect(env?.GIT_CONFIG_COUNT).toBe("1");
  });

  it("returns undefined and escalates once per owner when both attempts fail", async () => {
    vi.stubGlobal("fetch", mockFetchWithMintSequence(["bad token", "bad token"]));

    const first = await buildGitEnvForOwner("test-owner");
    expect(first).toBeUndefined();
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);

    invalidateInstallationToken("test-owner");
    const second = await buildGitEnvForOwner("test-owner");
    expect(second).toBeUndefined();
    expect(vi.mocked(log.error)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});

describe("listInstallationRepositories", () => {
  function mockFetchImpl(repoListResponse: {
    ok: boolean;
    status: number;
    body: string;
    headers?: Record<string, string>;
  }) {
    return vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: "test-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        } as Response;
      }
      return {
        ok: repoListResponse.ok,
        status: repoListResponse.status,
        text: async () => repoListResponse.body,
        headers: new Headers(repoListResponse.headers ?? {}),
      } as unknown as Response;
    });
  }

  afterEach(() => {
    clearRateLimitState();
    vi.unstubAllGlobals();
  });

  it("throws a RateLimitError and trips the circuit breaker on a 403 rate-limit response", async () => {
    vi.stubGlobal("fetch", mockFetchImpl({
      ok: false,
      status: 403,
      body: JSON.stringify({ message: "API rate limit exceeded for installation ID 124679342" }),
      headers: { "x-ratelimit-remaining": "0" },
    }));

    await expect(listInstallationRepositories("test-owner")).rejects.toBeInstanceOf(RateLimitError);
    expect(isRateLimited()).toBe(true);
  });

  it("throws a plain Error (not RateLimitError) on a non-rate-limit 404", async () => {
    vi.stubGlobal("fetch", mockFetchImpl({
      ok: false,
      status: 404,
      body: "Not Found",
    }));

    await expect(listInstallationRepositories("test-owner")).rejects.toThrow(/HTTP 404/);
    await expect(listInstallationRepositories("test-owner")).rejects.not.toBeInstanceOf(RateLimitError);
    expect(isRateLimited()).toBe(false);
  });

  it("refuses to call GitHub at all while the breaker is open (#3221)", async () => {
    // The guard lives in listInstallationRepositories itself so every caller —
    // fetchRepos and listPublicReposIncludingArchived — is covered.
    const fetchMock = mockFetchImpl({ ok: true, status: 200, body: "{}" });
    vi.stubGlobal("fetch", fetchMock);
    setRateLimited();

    await expect(listInstallationRepositories("test-owner")).rejects.toBeInstanceOf(RateLimitError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("derives the cooldown from x-ratelimit-reset instead of the flat 60s default", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const resetEpochMs = now + 30 * 60_000; // 30 minutes out
      vi.stubGlobal("fetch", mockFetchImpl({
        ok: false,
        status: 403,
        body: JSON.stringify({ message: "API rate limit exceeded for installation ID 124679342" }),
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(resetEpochMs / 1000)) },
      }));

      await expect(listInstallationRepositories("test-owner")).rejects.toBeInstanceOf(RateLimitError);

      // Past the old flat 60s cooldown, the breaker must still be open.
      vi.setSystemTime(now + 61_000);
      expect(isRateLimited()).toBe(true);

      // Past the header-derived reset (plus its buffer), it must have cleared.
      vi.setSystemTime(resetEpochMs + 6_000);
      expect(isRateLimited()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the default cooldown on a secondary rate limit, not the untouched primary reset (#3228 review 3/4)", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      const resetEpochMs = now + 30 * 60_000; // primary bucket's reset, 30 minutes out — untouched
      vi.stubGlobal("fetch", mockFetchImpl({
        ok: false,
        status: 403,
        body: JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }),
        headers: { "x-ratelimit-remaining": "4321", "x-ratelimit-reset": String(Math.floor(resetEpochMs / 1000)) },
      }));

      await expect(listInstallationRepositories("test-owner")).rejects.toBeInstanceOf(RateLimitError);

      // Must clear around the flat default cooldown, not the far-future primary reset.
      vi.setSystemTime(now + 61_000);
      expect(isRateLimited()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses retry-after when present on a secondary rate limit", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.now();
      vi.stubGlobal("fetch", mockFetchImpl({
        ok: false,
        status: 403,
        body: JSON.stringify({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }),
        headers: { "x-ratelimit-remaining": "4321", "retry-after": "120" },
      }));

      await expect(listInstallationRepositories("test-owner")).rejects.toBeInstanceOf(RateLimitError);

      vi.setSystemTime(now + 61_000);
      expect(isRateLimited()).toBe(true);

      vi.setSystemTime(now + 121_000);
      expect(isRateLimited()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("fetchRateLimitResetMs", () => {
  function mockRateLimitFetch(rateLimitResponse: { ok: boolean; status: number; body: unknown }) {
    return vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: "test-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        } as Response;
      }
      return {
        ok: rateLimitResponse.ok,
        status: rateLimitResponse.status,
        statusText: "",
        text: async () => JSON.stringify(rateLimitResponse.body),
        json: async () => rateLimitResponse.body,
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    resetGitHubAppState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the furthest reset across the exhausted resources, in epoch ms", async () => {
    const coreReset = 1_800_000_000;
    const searchReset = 1_800_000_600;
    vi.stubGlobal("fetch", mockRateLimitFetch({
      ok: true,
      status: 200,
      body: {
        resources: {
          core: { remaining: 0, reset: coreReset },
          search: { remaining: 0, reset: searchReset },
          graphql: { remaining: 4999, reset: 1_800_009_999 },
        },
      },
    }));

    await expect(fetchRateLimitResetMs("test-owner")).resolves.toBe(searchReset * 1000);
  });

  it("returns null when nothing is exhausted (e.g. a secondary rate limit)", async () => {
    vi.stubGlobal("fetch", mockRateLimitFetch({
      ok: true,
      status: 200,
      body: {
        resources: {
          core: { remaining: 4321, reset: 1_800_000_000 },
          search: { remaining: 30, reset: 1_800_000_060 },
        },
      },
    }));

    await expect(fetchRateLimitResetMs("test-owner")).resolves.toBeNull();
  });

  it("ignores buckets Claws' gh traffic never spends", async () => {
    vi.stubGlobal("fetch", mockRateLimitFetch({
      ok: true,
      status: 200,
      body: {
        resources: {
          core: { remaining: 4321, reset: 1_800_000_000 },
          // An exhausted bucket gh never touches must not pin the global
          // breaker to its reset, an hour out.
          source_import: { remaining: 0, reset: 1_800_003_600 },
          code_scanning_upload: { remaining: 0, reset: 1_800_003_600 },
        },
      },
    }));

    await expect(fetchRateLimitResetMs("test-owner")).resolves.toBeNull();
  });

  it("returns null rather than throwing on an HTTP error", async () => {
    vi.stubGlobal("fetch", mockRateLimitFetch({ ok: false, status: 503, body: { message: "unavailable" } }));

    await expect(fetchRateLimitResetMs("test-owner")).resolves.toBeNull();
  });

  it("returns null rather than throwing on a malformed body with no resources", async () => {
    vi.stubGlobal("fetch", mockRateLimitFetch({ ok: true, status: 200, body: { rate: { remaining: 0, reset: 1 } } }));

    await expect(fetchRateLimitResetMs("test-owner")).resolves.toBeNull();
  });

  it("returns null rather than throwing when the token cannot be minted", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch failed");
    }));

    await expect(fetchRateLimitResetMs("test-owner")).resolves.toBeNull();
  });
});

describe("getInstallationCoreRateLimit", () => {
  function mockRateLimitFetch(rateLimitResponse: { ok: boolean; status: number; body: unknown }) {
    return vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ token: "test-token", expires_at: new Date(Date.now() + 3600_000).toISOString() }),
        } as Response;
      }
      return {
        ok: rateLimitResponse.ok,
        status: rateLimitResponse.status,
        statusText: "",
        text: async () => JSON.stringify(rateLimitResponse.body),
        json: async () => rateLimitResponse.body,
      } as unknown as Response;
    });
  }

  beforeEach(() => {
    resetGitHubAppState();
    clearRateLimitState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses resources.core from the owner's /rate_limit response", async () => {
    const fetchMock = mockRateLimitFetch({
      ok: true,
      status: 200,
      body: {
        resources: {
          core: { limit: 5000, remaining: 1234, reset: 1_800_000_000 },
          graphql: { limit: 5000, remaining: 5000, reset: 1_800_000_000 },
        },
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getInstallationCoreRateLimit("test-owner")).resolves.toEqual({ remaining: 1234, limit: 5000, resetAt: 1_800_000_000 });
    const probe = fetchMock.mock.calls.find(([url]) => url === "https://api.github.com/rate_limit");
    expect(probe).toBeDefined();
  });

  it("shares one probe per owner within the memo window", async () => {
    const fetchMock = mockRateLimitFetch({
      ok: true,
      status: 200,
      body: { resources: { core: { limit: 5000, remaining: 4000, reset: 1_800_000_000 } } },
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([getInstallationCoreRateLimit("test-owner"), getInstallationCoreRateLimit("test-owner")]);
    await getInstallationCoreRateLimit("test-owner");

    expect(fetchMock.mock.calls.filter(([url]) => url === "https://api.github.com/rate_limit")).toHaveLength(1);
  });

  it("returns null on a non-OK response without tripping the breaker", async () => {
    vi.stubGlobal("fetch", mockRateLimitFetch({ ok: false, status: 403, body: { message: "API rate limit exceeded for installation ID 456" } }));

    await expect(getInstallationCoreRateLimit("test-owner")).resolves.toBeNull();
    expect(isRateLimited()).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Could not read the core rate limit for test-owner"));
  });

  it("returns null on a body without resources.core", async () => {
    vi.stubGlobal("fetch", mockRateLimitFetch({ ok: true, status: 200, body: { resources: { search: { remaining: 1, limit: 30, reset: 1 } } } }));

    await expect(getInstallationCoreRateLimit("test-owner")).resolves.toBeNull();
  });
});

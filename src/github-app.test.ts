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
// shapes of buildForgejoGitAuthEnv.
const forgejoCfg = vi.hoisted(() => ({
  token: undefined as string | undefined,
  baseUrl: "https://git.home.bstjohn.net",
}));

vi.mock("./config.js", () => ({
  GITHUB_APP_ID: 0,
  GITHUB_APP_PRIVATE_KEY_PATH: "",
  GITHUB_APP_INSTALLATION_IDS: { "id-owner": 789 },
  PUBLIC_SNAPSHOTS: [
    { source: "St-John-Software/claws", target: "test-owner/claws-snapshot" },
    { source: "St-John-Software/other", target: "snapshot-owner/other" },
  ],
  GITHUB_OWNER_APP_CREDENTIALS: {
    "test-owner": { appId: 123, privateKeyPath: "/fake/key.pem", installationId: 456 },
    "lookup-owner": { appId: 123, privateKeyPath: "/fake/key.pem" },
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

import { base64UrlEncodeString, buildEnvForGh, buildForgejoGitAuthEnv, buildEnvForForgejoGit, buildGitHubGitAuthEnv, buildEnvForGitHubGit, isRetryableFetchError, describeFetchFailure, describeTokenShape, getInstallationTokenForOwner, resetGitHubAppState, githubAppOwners } from "./github-app.js";
import * as log from "./log.js";

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

describe("githubAppOwners", () => {
  it("names the snapshot target owners plus owners with explicit credentials or installation ids", () => {
    expect(githubAppOwners()).toEqual(["test-owner", "snapshot-owner", "lookup-owner", "id-owner"]);
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

describe("buildForgejoGitAuthEnv", () => {
  beforeEach(() => {
    forgejoCfg.token = undefined;
    forgejoCfg.baseUrl = "https://git.home.bstjohn.net";
  });

  it("sets only the Forgejo credential helper, its token var and GIT_TERMINAL_PROMPT", () => {
    forgejoCfg.token = "forgejo-tok";
    vi.stubEnv("CLAWS_DATABASE_URL", "postgres://secret");
    try {
      const env = buildForgejoGitAuthEnv();
      expect(env).toEqual({
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "credential.https://git.home.bstjohn.net.helper",
        GIT_CONFIG_VALUE_0: expect.stringContaining("$CLAWS_FORGEJO_GIT_TOKEN"),
        CLAWS_FORGEJO_GIT_TOKEN: "forgejo-tok",
      });
      expect(env.GIT_CONFIG_VALUE_0).toContain("oauth2");
      expect(env.GIT_CONFIG_VALUE_0).not.toContain("forgejo-tok");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sets no GH_TOKEN, GITHUB_TOKEN or github.com helper", () => {
    forgejoCfg.token = "forgejo-tok";
    const env = buildForgejoGitAuthEnv();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(Object.values(env).join("\n")).not.toContain("github.com");
  });

  it("strips a trailing slash from the Forgejo base URL in the helper key", () => {
    forgejoCfg.token = "forgejo-tok";
    forgejoCfg.baseUrl = "https://forge.example.com//";
    expect(buildForgejoGitAuthEnv().GIT_CONFIG_KEY_0).toBe("credential.https://forge.example.com.helper");
  });

  it("sets no helper without a Forgejo token, or with a blank one", () => {
    expect(buildForgejoGitAuthEnv()).toEqual({ GIT_TERMINAL_PROMPT: "0" });
    forgejoCfg.token = "   ";
    expect(buildForgejoGitAuthEnv()).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("buildEnvForForgejoGit", () => {
  afterEach(() => {
    forgejoCfg.token = undefined;
    vi.unstubAllEnvs();
  });

  it("layers the Forgejo auth vars over process.env and strips an ambient GitHub token", () => {
    forgejoCfg.token = "forgejo-tok";
    vi.stubEnv("GH_TOKEN", "ambient-gh");
    vi.stubEnv("GITHUB_TOKEN", "ambient-gh");
    vi.stubEnv("SOME_OTHER_VAR", "kept");
    vi.stubEnv("GIT_CONFIG_COUNT", "2");
    vi.stubEnv("GIT_CONFIG_KEY_1", "credential.https://github.com.helper");
    const env = buildEnvForForgejoGit();
    expect(env.SOME_OTHER_VAR).toBe("kept");
    // An inherited second helper is past the count, so git ignores it.
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.CLAWS_FORGEJO_GIT_TOKEN).toBe("forgejo-tok");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://git.home.bstjohn.net.helper");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });

  it("without a Forgejo token strips GitHub tokens and neutralises an inherited git config helper", () => {
    forgejoCfg.token = undefined;
    vi.stubEnv("GH_TOKEN", "ambient-gh");
    vi.stubEnv("GITHUB_TOKEN", "ambient-gh");
    vi.stubEnv("CLAWS_GIT_CREDENTIAL_TOKEN", "ambient-gh");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "credential.https://github.com.helper");
    const env = buildEnvForForgejoGit();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.CLAWS_GIT_CREDENTIAL_TOKEN).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("0");
    expect(env.CLAWS_FORGEJO_GIT_TOKEN).toBeUndefined();
  });
});

describe("buildGitHubGitAuthEnv", () => {
  afterEach(() => {
    forgejoCfg.token = undefined;
  });

  it("configures only the github.com credential helper via GIT_CONFIG_* env vars", () => {
    forgejoCfg.token = "forgejo-tok";
    const env = buildGitHubGitAuthEnv("ghs_abcDEF_123");
    expect(env.GH_TOKEN).toBe("ghs_abcDEF_123");
    expect(env.GITHUB_TOKEN).toBe("ghs_abcDEF_123");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_CONFIG_VALUE_0).toContain("x-access-token");
    expect(env.GIT_CONFIG_VALUE_0).toContain("$CLAWS_GIT_CREDENTIAL_TOKEN");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("ghs_abcDEF_123");
    expect(env.CLAWS_GIT_CREDENTIAL_TOKEN).toBe("ghs_abcDEF_123");
    expect(env.CLAWS_FORGEJO_GIT_TOKEN).toBeUndefined();
  });

  it("never places token bytes into the credential helper source", () => {
    const env = buildGitHubGitAuthEnv("ghs_abc$(whoami)'x`y");
    expect(env.GIT_CONFIG_VALUE_0).not.toContain("whoami");
    expect(env.GIT_CONFIG_VALUE_0).toBe(buildGitHubGitAuthEnv("ghs_plain").GIT_CONFIG_VALUE_0);
  });

  it("rejects empty, whitespace-only, null and undefined tokens", () => {
    expect(() => buildGitHubGitAuthEnv("")).toThrow(/empty token/i);
    expect(() => buildGitHubGitAuthEnv("   ")).toThrow(/empty token/i);
    expect(() => buildGitHubGitAuthEnv(undefined as unknown as string)).toThrow(/missing token/i);
    expect(() => buildGitHubGitAuthEnv(null as unknown as string)).toThrow(/missing token/i);
  });

  it("never includes the token value in a rejection message", () => {
    try {
      buildGitHubGitAuthEnv("ghs_secret value");
      expect.fail("should throw");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });
});

describe("buildEnvForGitHubGit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetGitHubAppState();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("layers the owner's installation token and github.com helper over process.env", async () => {
    const token = "ghs_" + "c".repeat(36);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    }) as unknown as Response));
    const env = await buildEnvForGitHubGit("test-owner");
    expect(env.CLAWS_GIT_CREDENTIAL_TOKEN).toBe(token);
    expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  const tokenResponse = (token: string) => ({
    ok: true, status: 200,
    json: async () => ({ token, expires_at: new Date(Date.now() + 3600_000).toISOString() }),
  }) as unknown as Response;
  const forbidden = () => ({
    ok: false, status: 403, statusText: "Forbidden", text: async () => "nope",
  }) as unknown as Response;

  it("retries the mint once when the first attempt fails", async () => {
    const token = "ghs_" + "d".repeat(36);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(forbidden())
      .mockResolvedValue(tokenResponse(token));
    vi.stubGlobal("fetch", fetchMock);
    const env = await buildEnvForGitHubGit("test-owner");
    expect(env.CLAWS_GIT_CREDENTIAL_TOKEN).toBe(token);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.warn)).toHaveBeenCalledWith(expect.stringContaining("recovered on retry"));
  });

  it("throws when the retry fails too, so git never falls back to ambient credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => forbidden()));
    await expect(buildEnvForGitHubGit("test-owner")).rejects.toThrow(/HTTP 403/);
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

describe("isRetryableFetchError 422", () => {
  it("retries a 422 'unavailable' from token minting", () => {
    expect(isRetryableFetchError(new Error('[github-app] HTTP 422  for https://api.github.com/app/installations/1/access_tokens: {"message":"unavailable: unavailable","status":"422"}'))).toBe(true);
  });

  it("does not retry a 422 validation error", () => {
    expect(isRetryableFetchError(new Error('[github-app] HTTP 422 Unprocessable Entity for https://api.github.com/app/installations/123/access_tokens: {"message":"Validation Failed","errors":[]}'))).toBe(false);
  });
});

describe("fetchInstallationToken retry", () => {
  beforeEach(() => {
    resetGitHubAppState();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const unavailable = () => ({
    ok: false, status: 422, statusText: "",
    text: async () => '{"message":"unavailable: unavailable","status":"422"}',
  }) as unknown as Response;
  const good = () => ({
    ok: true, status: 200,
    json: async () => ({ token: "ghs_" + "a".repeat(36), expires_at: new Date(Date.now() + 3600_000).toISOString() }),
  }) as unknown as Response;

  it("retries a 422 unavailable then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(good());
    vi.stubGlobal("fetch", f);
    const p = getInstallationTokenForOwner("test-owner");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe("ghs_" + "a".repeat(36));
    expect(f).toHaveBeenCalledTimes(2);
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.error)).not.toHaveBeenCalled();
  });

  it("rejects after three consecutive 422 unavailable responses", async () => {
    const f = vi.fn(async () => unavailable());
    vi.stubGlobal("fetch", f);
    const p = getInstallationTokenForOwner("test-owner");
    const assertion = expect(p).rejects.toThrow(/HTTP 422[\s\S]*unavailable/);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 422 Validation Failed", async () => {
    const f = vi.fn(async () => ({
      ok: false, status: 422, statusText: "Unprocessable Entity",
      text: async () => '{"message":"Validation Failed","errors":[]}',
    }) as unknown as Response);
    vi.stubGlobal("fetch", f);
    await expect(getInstallationTokenForOwner("test-owner")).rejects.toThrow(/HTTP 422/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });
});

describe("installation lookup retry", () => {
  beforeEach(() => {
    resetGitHubAppState();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const netErr = () =>
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
  const install = () => ({ ok: true, status: 200, json: async () => ({ id: 99 }) }) as unknown as Response;
  const token = () => ({
    ok: true, status: 200,
    json: async () => ({ token: "ghs_" + "b".repeat(36), expires_at: new Date(Date.now() + 3600_000).toISOString() }),
  }) as unknown as Response;

  it("absorbs a single network blip on the /orgs lookup", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/access_tokens")) return token();
      return install();
    });
    f.mockRejectedValueOnce(netErr());
    vi.stubGlobal("fetch", f);
    const p = getInstallationTokenForOwner("lookup-owner");
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe("ghs_" + "b".repeat(36));
    expect(vi.mocked(log.warn)).toHaveBeenCalledTimes(1);
  });

  it("reports the underlying cause when the lookup keeps failing", async () => {
    const f = vi.fn(async () => { throw netErr(); });
    vi.stubGlobal("fetch", f);
    const p = getInstallationTokenForOwner("lookup-owner");
    const assertion = expect(p).rejects.toThrow(/Failed to resolve installation for lookup-owner[\s\S]*ECONNRESET/);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("falls back to /users on 404 without retrying", async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes("/orgs/")) {
        return { ok: false, status: 404, statusText: "Not Found", text: async () => "{}" } as unknown as Response;
      }
      if (url.includes("/access_tokens")) return token();
      return install();
    });
    vi.stubGlobal("fetch", f);
    await expect(getInstallationTokenForOwner("lookup-owner")).resolves.toBe("ghs_" + "b".repeat(36));
    expect(f.mock.calls.some(([u]) => String(u).includes("/users/"))).toBe(true);
    expect(vi.mocked(log.warn)).not.toHaveBeenCalled();
  });

  it("isRetryableFetchError walks the cause chain", () => {
    const wrapped = new Error("wrapped", { cause: new Error("mid", { cause: new TypeError("fetch failed") }) });
    expect(isRetryableFetchError(wrapped)).toBe(true);
    expect(isRetryableFetchError(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(true);
    expect(isRetryableFetchError(new Error("x", { cause: new Error("EACCES") }))).toBe(false);
  });

  it("describeFetchFailure renders nested code and message", () => {
    expect(describeFetchFailure(netErr())).toBe("fetch failed (read ECONNRESET [ECONNRESET])");
    expect(describeFetchFailure("boom")).toBe("boom");
  });
});

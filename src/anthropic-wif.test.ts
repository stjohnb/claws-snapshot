import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockConfig = vi.hoisted(() => ({
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_WIF_RULE_ID: "fdrl_rule",
  ANTHROPIC_WIF_ORGANIZATION_ID: "org-uuid",
  ANTHROPIC_WIF_SERVICE_ACCOUNT_ID: "svac_sa",
  ANTHROPIC_WIF_WORKSPACE_ID: "",
  ANTHROPIC_WIF_K8S_SERVICE_ACCOUNT: "claws-anthropic",
  ANTHROPIC_ACCESS_TOKEN: "",
  ANTHROPIC_ACCESS_TOKEN_EXPIRES_AT: "",
}));
const mockLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./config.js", () => mockConfig);
vi.mock("./log.js", () => mockLog);

import {
  anthropicCredentialState,
  getAnthropicAccessToken,
  isAnthropicWifConfigured,
  setAnthropicWifDepsForTests,
  ANTHROPIC_OAUTH_TOKEN_URL,
} from "./anthropic-wif.js";
import type { K8sClient, K8sResult, ServiceAccountToken } from "./k8s/api.js";

const HOUR = 3_600_000;
const JWT = "eyJ.minted.jwt";
const ACCESS = "sk-ant-oat01-access";

let saDir: string;
let now: number;
let mint: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function install(): void {
  setAnthropicWifDepsForTests({
    k8s: () => ({ createServiceAccountToken: mint } as unknown as K8sClient),
    fetch: fetchMock as unknown as typeof fetch,
    saDir,
    now: () => now,
  });
}

function allLogText(): string {
  return JSON.stringify([...mockLog.info.mock.calls, ...mockLog.warn.mock.calls]);
}

beforeEach(() => {
  saDir = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-wif-"));
  fs.writeFileSync(path.join(saDir, "token"), "sa-token");
  fs.writeFileSync(path.join(saDir, "namespace"), "default\n");
  now = Date.parse("2026-11-04T12:00:00Z");
  mint = vi.fn(async (): Promise<K8sResult<ServiceAccountToken>> => ({
    ok: true,
    value: { token: JWT, expirationTimestamp: new Date(now + 6 * HOUR).toISOString() },
  }));
  fetchMock = vi.fn(async () => jsonResponse(200, { access_token: ACCESS, expires_in: 43_200, token_type: "Bearer" }));
  Object.assign(mockConfig, {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_WIF_RULE_ID: "fdrl_rule",
    ANTHROPIC_WIF_ORGANIZATION_ID: "org-uuid",
    ANTHROPIC_WIF_SERVICE_ACCOUNT_ID: "svac_sa",
    ANTHROPIC_WIF_WORKSPACE_ID: "",
    ANTHROPIC_ACCESS_TOKEN: "",
    ANTHROPIC_ACCESS_TOKEN_EXPIRES_AT: "",
  });
  mockLog.info.mockClear();
  mockLog.warn.mockClear();
  install();
});

afterEach(() => {
  setAnthropicWifDepsForTests(null);
  fs.rmSync(saDir, { recursive: true, force: true });
});

describe("anthropic-wif", () => {
  it("is configured only when the rule, organisation and service-account IDs are all set", () => {
    expect(isAnthropicWifConfigured()).toBe(true);
    mockConfig.ANTHROPIC_WIF_ORGANIZATION_ID = "";
    expect(isAnthropicWifConfigured()).toBe(false);
  });

  it("mints a JWT and exchanges it for an access token", async () => {
    const token = await getAnthropicAccessToken();
    expect(token).toEqual({ token: ACCESS, expiresAt: now + 12 * HOUR });
    expect(mint).toHaveBeenCalledWith("default", "claws-anthropic", ["https://api.anthropic.com"], 21_600);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ANTHROPIC_OAUTH_TOKEN_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: JWT,
      federation_rule_id: "fdrl_rule",
      organization_id: "org-uuid",
      service_account_id: "svac_sa",
    });
    expect(mockLog.info).toHaveBeenCalledWith("anthropic token exchange", expect.objectContaining({ component: "anthropic-wif", outcome: "ok", expires_in: 43_200, duration_ms: expect.any(Number) }));
    expect(allLogText()).not.toContain(JWT);
    expect(allLogText()).not.toContain(ACCESS);
    expect(anthropicCredentialState()).toEqual({ mode: "wif", lastExchange: { ok: true, at: new Date(now).toISOString(), detail: "token expires in 12.0h" } });
  });

  it("sends workspace_id when set and mints in the pod's own namespace", async () => {
    mockConfig.ANTHROPIC_WIF_WORKSPACE_ID = "wrkspc_x";
    fs.writeFileSync(path.join(saDir, "namespace"), "claws\n");
    await getAnthropicAccessToken();
    expect(mint.mock.calls[0][0]).toBe("claws");
    expect(JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string).workspace_id).toBe("wrkspc_x");
  });

  it("serves the cache until under six hours remain, then refreshes", async () => {
    await getAnthropicAccessToken();
    now += 5 * HOUR;
    await getAnthropicAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 2 * HOUR; // 5 h left
    await getAnthropicAccessToken();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent callers into one exchange", async () => {
    const results = await Promise.all([getAnthropicAccessToken(), getAnthropicAccessToken(), getAnthropicAccessToken()]);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r?.token))).toEqual(new Set([ACCESS]));
  });

  it("throws the exchange error on a 401 with no cached token, without logging the body", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "secret-detail" } }));
    await expect(getAnthropicAccessToken()).rejects.toThrow("Anthropic workload identity token exchange failed: HTTP 401 authentication_error");
    expect(mockLog.warn).toHaveBeenCalledWith("anthropic token exchange failed", expect.objectContaining({ component: "anthropic-wif", outcome: "failed" }));
    expect(allLogText()).not.toContain("secret-detail");
    expect(allLogText()).not.toContain(JWT);
    expect(anthropicCredentialState().lastExchange).toMatchObject({ ok: false, detail: "HTTP 401 authentication_error" });
  });

  it("keeps serving a still-valid cached token when a refresh fails, but a forced refresh surfaces the failure", async () => {
    await getAnthropicAccessToken();
    now += 7 * HOUR; // 5 h left: refresh due
    fetchMock.mockImplementation(async () => jsonResponse(401, {}));
    expect((await getAnthropicAccessToken())?.token).toBe(ACCESS);
    await expect(getAnthropicAccessToken({ forceRefresh: true })).rejects.toThrow("HTTP 401");
  });

  it("names a failed TokenRequest", async () => {
    mint.mockImplementation(async () => ({ ok: false, kind: "forbidden", applied: "no", status: 403, message: "POST /api/v1/namespaces/default/serviceaccounts/claws-anthropic/token: HTTP 403" }));
    await expect(getAnthropicAccessToken()).rejects.toThrow(/token exchange failed: could not mint a claws-anthropic ServiceAccount token .*HTTP 403/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("warns when the API server grants a shorter JWT than requested", async () => {
    mint.mockImplementation(async () => ({ ok: true, value: { token: JWT, expirationTimestamp: new Date(now + HOUR).toISOString() } }));
    await getAnthropicAccessToken();
    expect(mockLog.warn).toHaveBeenCalledWith("anthropic wif jwt shorter than requested", expect.objectContaining({ granted_seconds: 3600 }));
  });

  it("returns null when federation is not configured", async () => {
    mockConfig.ANTHROPIC_WIF_RULE_ID = "";
    mockConfig.ANTHROPIC_API_KEY = "sk-ant-api-key";
    expect(await getAnthropicAccessToken()).toBeNull();
    expect(mint).not.toHaveBeenCalled();
    expect(anthropicCredentialState().mode).toBe("api-key");
  });

  describe("with no ServiceAccount token file (an agent pod)", () => {
    beforeEach(() => {
      fs.rmSync(path.join(saDir, "token"));
      mockConfig.ANTHROPIC_WIF_RULE_ID = "";
      mockConfig.ANTHROPIC_WIF_ORGANIZATION_ID = "";
      mockConfig.ANTHROPIC_WIF_SERVICE_ACCOUNT_ID = "";
    });

    it("returns the pre-minted env token and never mints", async () => {
      mockConfig.ANTHROPIC_ACCESS_TOKEN = "sk-ant-oat01-preminted";
      mockConfig.ANTHROPIC_ACCESS_TOKEN_EXPIRES_AT = new Date(now + 10 * HOUR).toISOString();
      expect(await getAnthropicAccessToken()).toEqual({ token: "sk-ant-oat01-preminted", expiresAt: now + 10 * HOUR });
      expect(mint).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(anthropicCredentialState().mode).toBe("wif");
    });

    it("never mints even when the federation IDs are set", async () => {
      Object.assign(mockConfig, { ANTHROPIC_WIF_RULE_ID: "fdrl_rule", ANTHROPIC_WIF_ORGANIZATION_ID: "org", ANTHROPIC_WIF_SERVICE_ACCOUNT_ID: "svac" });
      expect(await getAnthropicAccessToken()).toBeNull();
      expect(mint).not.toHaveBeenCalled();
    });

    it("rejects an expired pre-minted token with the exchange error", async () => {
      mockConfig.ANTHROPIC_ACCESS_TOKEN = "sk-ant-oat01-preminted";
      mockConfig.ANTHROPIC_ACCESS_TOKEN_EXPIRES_AT = new Date(now - HOUR).toISOString();
      await expect(getAnthropicAccessToken()).rejects.toThrow("Anthropic workload identity token exchange failed");
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mockConfig = vi.hoisted(() => ({
  GRAFANA_JWT_SIGNING_KEY: "",
  FLEET_GRAFANA_URL: "https://grafana.fleet.example",
  writeConfig: vi.fn(async (updates: { grafanaJwtSigningKey?: string }) => {
    if (updates.grafanaJwtSigningKey) mockConfig.GRAFANA_JWT_SIGNING_KEY = updates.grafanaJwtSigningKey;
  }),
}));
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), mockConfig));

import { derivedSecret, ensureSigningKey, GRAFANA_CLUSTERS, grafanaUrl, isGrafanaCluster, jwks, mintClawsJwt, probeGrafanaAuth, grafanaProbeFailureMessage, grafanaProbeLogContext } from "./grafana-jwt.js";

const STORED_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ format: "pem", type: "pkcs8" }).toString();

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}

describe("grafana-jwt", () => {
  beforeEach(() => {
    mockConfig.GRAFANA_JWT_SIGNING_KEY = STORED_KEY;
    mockConfig.writeConfig.mockClear();
  });

  it("knows only the fleet cluster", () => {
    expect(GRAFANA_CLUSTERS).toEqual(["fleet"]);
    expect(isGrafanaCluster("fleet")).toBe(true);
    expect(isGrafanaCluster("prod")).toBe(false);
    expect(isGrafanaCluster("staging")).toBe(false);
    expect(grafanaUrl("fleet")).toBe("https://grafana.fleet.example");
  });

  it("derivedSecret is a stable 32-byte key per info that changes with the signing key", () => {
    const a = derivedSecret("claws-pages-read");
    expect(a).toHaveLength(32);
    expect(derivedSecret("claws-pages-read").equals(a)).toBe(true);
    expect(derivedSecret("other").equals(a)).toBe(false);
    mockConfig.GRAFANA_JWT_SIGNING_KEY = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ format: "pem", type: "pkcs8" }).toString();
    expect(derivedSecret("claws-pages-read").equals(a)).toBe(false);
  });

  it("ensureSigningKey leaves a stored key alone", async () => {
    await ensureSigningKey();
    expect(mockConfig.writeConfig).not.toHaveBeenCalled();
    expect(mockConfig.GRAFANA_JWT_SIGNING_KEY).toBe(STORED_KEY);
  });

  it("ensureSigningKey generates and stores a PKCS8 RSA key when none is configured, then signs with it", async () => {
    mockConfig.GRAFANA_JWT_SIGNING_KEY = "";
    const before = jwks().keys[0]!.kid;
    await ensureSigningKey();
    expect(mockConfig.writeConfig).toHaveBeenCalledTimes(1);
    const pem = mockConfig.GRAFANA_JWT_SIGNING_KEY;
    const key = crypto.createPrivateKey(pem);
    expect(key.asymmetricKeyType).toBe("rsa");
    expect(key.export({ format: "pem", type: "pkcs8" })).toBe(pem);
    expect(crypto.createPrivateKey(pem).asymmetricKeyDetails?.modulusLength).toBe(2048);
    // The key minted with before the write is the one that was stored.
    expect(jwks().keys[0]!.kid).toBe(before);
    await ensureSigningKey();
    expect(mockConfig.writeConfig).toHaveBeenCalledTimes(1);
  });

  it("jwks publishes the public half of the stored key with a SHA-256 kid", () => {
    const publicKey = crypto.createPublicKey(STORED_KEY);
    const expected = publicKey.export({ format: "jwk" });
    const kid = crypto.createHash("sha256").update(publicKey.export({ format: "der", type: "spki" })).digest("hex").slice(0, 16);
    expect(jwks()).toEqual({ keys: [{ kty: "RSA", n: expected.n, e: expected.e, alg: "RS256", use: "sig", kid }] });
    expect(JSON.stringify(jwks())).not.toMatch(/"d"/);
  });

  it("mintClawsJwt sets the given aud and sub, signs with an RS256 signature that verifies against the JWKS", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const token = mintClawsJwt({ aud: "content-moderation:Owner/app", sub: "claws-content-moderation", ttlMs: 5 * 60 * 1000 }, now);
    const [h, p, sig] = token.split(".");
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT", kid: jwks().keys[0]!.kid });
    const claims = decode(p!);
    expect(claims).toMatchObject({
      iss: "claws",
      aud: "content-moderation:Owner/app",
      sub: "claws-content-moderation",
      iat: now / 1000,
      exp: now / 1000 + 300,
    });
    expect(claims).not.toHaveProperty("email");
    const verifier = crypto.createPublicKey({ key: jwks().keys[0]!, format: "jwk" });
    expect(crypto.verify("sha256", Buffer.from(`${h}.${p}`), verifier, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  it("mintClawsJwt never lets extra claims override iat, exp or jti", () => {
    const now = Date.UTC(2026, 9, 29, 12, 0, 0);
    const claims = decode(mintClawsJwt({ aud: "a", sub: "s", ttlMs: 60_000, extra: { exp: 1, iat: 1, jti: "x" } }, now).split(".")[1]!);
    expect(claims.iat).toBe(now / 1000);
    expect(claims.exp).toBe(now / 1000 + 60);
    expect(claims.jti).not.toBe("x");
  });
});

describe("probeGrafanaAuth", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mockConfig.GRAFANA_JWT_SIGNING_KEY = STORED_KEY;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mountServiceAccount("claws-service", "app-pass");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR;
    for (const dir of mounted.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const mounted: string[] = [];

  function mountServiceAccount(username: string, password: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-authentik-"));
    fs.writeFileSync(path.join(dir, "username"), username);
    fs.writeFileSync(path.join(dir, "app-password"), password);
    process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR = dir;
    mounted.push(dir);
    return dir;
  }

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const authOf = () => (fetchMock.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>;

  function expectLogged(cluster: "fleet", result: Awaited<ReturnType<typeof probeGrafanaAuth>>, fields: Record<string, unknown>) {
    const ctx = grafanaProbeLogContext(cluster, result);
    expect(Number.isInteger(result.durationMs) && result.durationMs >= 0).toBe(true);
    expect(ctx).toEqual({ cluster, authMode: result.authMode, durationMs: result.durationMs, ...fields });
    const credential = authOf()["Authorization"]!.split(" ")[1]!;
    const text = JSON.stringify(ctx) + grafanaProbeFailureMessage(cluster, result);
    expect(text).not.toContain(credential);
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("Basic");
  }

  it("is ok on 200 with the service account's non-admin login, and sends its Basic header to /api/user", async () => {
    fetchMock.mockResolvedValue(json(200, { login: "claws-service", isGrafanaAdmin: false }));
    const result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: true, authMode: "authentik" });
    expect(grafanaProbeLogContext("fleet", result)).toEqual({ cluster: "fleet", authMode: "authentik", durationMs: result.durationMs });
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://grafana.fleet.example/api/user");
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Basic ${Buffer.from("claws-service:app-pass").toString("base64")}`);
  });

  it("reports reason status with the code on a non-200 response", async () => {
    fetchMock.mockResolvedValue(json(401, { message: "invalid username or password" }));
    let result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, reason: "status", status: 401 });
    expectLogged("fleet", result, { probeReason: "status", httpStatus: 401 });
    expect(grafanaProbeFailureMessage("fleet", result)).toBe("fleet Grafana rejected the Claws sign-in probe (status)");
    fetchMock.mockResolvedValue(new Response("", { status: 302, headers: { Location: "/login" } }));
    result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, reason: "status", status: 302 });
    expectLogged("fleet", result, { probeReason: "status", httpStatus: 302 });
  });

  it("reports reason admin_user when Grafana reports an admin user or omits the flag", async () => {
    fetchMock.mockResolvedValue(json(200, { login: "claws-service", isGrafanaAdmin: true }));
    let result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, reason: "admin_user" });
    expectLogged("fleet", result, { probeReason: "admin_user" });
    fetchMock.mockResolvedValue(json(200, { login: "claws-service" }));
    result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, reason: "admin_user" });
  });

  it("reports reason timeout when the request is aborted by the timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, reason: "timeout", error: "TimeoutError" });
    expectLogged("fleet", result, { probeReason: "timeout", probeError: "TimeoutError" });
    expect(grafanaProbeFailureMessage("fleet", result)).toBe("fleet Grafana Claws sign-in probe failed (timeout)");
  });

  it.each(["ECONNREFUSED", "ENOTFOUND"])("reports reason fetch_error with %s", async (code) => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) }));
    const result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, reason: "fetch_error", error: code });
    expectLogged("fleet", result, { probeReason: "fetch_error", probeError: code });
  });

  it("signs in as the mounted service account with HTTP Basic, ok when Grafana reports that non-admin login", async () => {
    mountServiceAccount("claws-service\n", "app-pass\n");
    fetchMock.mockResolvedValue(json(200, { login: "claws-service", isGrafanaAdmin: false }));
    const result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: true, authMode: "authentik" });
    expect(authOf()["Authorization"]).toBe(`Basic ${Buffer.from("claws-service:app-pass").toString("base64")}`);
    expect(grafanaProbeLogContext("fleet", result)).toEqual({ cluster: "fleet", authMode: "authentik", durationMs: result.durationMs });
    expect(grafanaProbeFailureMessage("fleet", result)).toBe("fleet Grafana accepted the Claws sign-in probe");
  });

  it("reports reason wrong_user when Grafana signs the service account in as another login", async () => {
    mountServiceAccount("claws-service", "app-pass");
    fetchMock.mockResolvedValue(json(200, { login: "claws-observability", isGrafanaAdmin: false }));
    let result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, authMode: "authentik", reason: "wrong_user" });
    expectLogged("fleet", result, { probeReason: "wrong_user" });
    expect(grafanaProbeFailureMessage("fleet", result)).toBe("fleet Grafana rejected the Claws sign-in probe (wrong_user)");
    fetchMock.mockResolvedValue(json(200, { isGrafanaAdmin: false }));
    result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, reason: "wrong_user" });
  });

  it("checks admin before login in service-account mode", async () => {
    mountServiceAccount("claws-service", "app-pass");
    fetchMock.mockResolvedValue(json(200, { login: "claws-service", isGrafanaAdmin: true }));
    const result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, authMode: "authentik", reason: "admin_user" });
    expectLogged("fleet", result, { probeReason: "admin_user" });
  });

  it.each([
    ["a credential file is empty", () => mountServiceAccount("claws-service", "  \n")],
    ["no credentials directory is set", () => { delete process.env.CLAWS_AUTHENTIK_CREDENTIALS_DIR; }],
  ])("reports reason unconfigured, sending nothing, when %s", async (_label, setup) => {
    setup();
    const result = await probeGrafanaAuth("fleet");
    expect(result).toMatchObject({ ok: false, authMode: "unconfigured", reason: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(grafanaProbeLogContext("fleet", result)).toEqual({ cluster: "fleet", authMode: "unconfigured", durationMs: result.durationMs, probeReason: "unconfigured" });
    expect(grafanaProbeFailureMessage("fleet", result)).toBe("fleet Claws sign-in probe failed: no Authentik service-account credentials are mounted (unconfigured)");
  });
});

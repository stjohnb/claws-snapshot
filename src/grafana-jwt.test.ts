import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

const mockConfig = vi.hoisted(() => ({
  GRAFANA_JWT_SIGNING_KEY: "",
  PROD_GRAFANA_URL: "https://grafana.prod.example",
  FLEET_GRAFANA_URL: "https://grafana.fleet.example",
  writeConfig: vi.fn(async (updates: { grafanaJwtSigningKey?: string }) => {
    if (updates.grafanaJwtSigningKey) mockConfig.GRAFANA_JWT_SIGNING_KEY = updates.grafanaJwtSigningKey;
  }),
}));
vi.mock("./config.js", () => mockConfig);

import { derivedSecret, ensureSigningKey, jwks, mintClawsJwt, mintGrafanaJwt, probeGrafanaAuth, grafanaProbeFailureMessage, grafanaProbeLogContext } from "./grafana-jwt.js";

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

  it("mints an RS256 JWT that verifies against the JWKS and carries the expected claims", () => {
    const now = Date.UTC(2026, 9, 19, 12, 0, 0);
    const token = mintGrafanaJwt("prod", 7 * 24 * 60 * 60 * 1000, now);
    const [h, p, sig] = token.split(".");
    expect(token.startsWith("eyJ")).toBe(true);
    expect(decode(h!)).toEqual({ alg: "RS256", typ: "JWT", kid: jwks().keys[0]!.kid });
    const claims = decode(p!);
    expect(claims).toMatchObject({
      iss: "claws",
      aud: "grafana-prod",
      sub: "claws-observability",
      email: "claws-observability@bstjohn.net",
      iat: now / 1000,
      exp: now / 1000 + 7 * 24 * 60 * 60,
    });
    expect(claims.jti).toEqual(expect.any(String));
    expect(claims).not.toHaveProperty("role");
    expect(Object.keys(claims).sort()).toEqual(["aud", "email", "exp", "iat", "iss", "jti", "sub"]);

    const verifier = crypto.createPublicKey({ key: jwks().keys[0]!, format: "jwk" });
    expect(crypto.verify("sha256", Buffer.from(`${h}.${p}`), verifier, Buffer.from(sig!, "base64url"))).toBe(true);
    expect(crypto.verify("sha256", Buffer.from(`${h}.${p}x`), verifier, Buffer.from(sig!, "base64url"))).toBe(false);
  });

  it("pins a different audience per cluster and a fresh jti per token", () => {
    const a = decode(mintGrafanaJwt("fleet", 60_000).split(".")[1]!);
    const b = decode(mintGrafanaJwt("fleet", 60_000).split(".")[1]!);
    expect(a.aud).toBe("grafana-fleet");
    expect(a.jti).not.toBe(b.jti);
  });

  it("mintClawsJwt sets the given aud and sub, signs with the JWKS key and carries no Grafana email", () => {
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
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const authOf = () => (fetchMock.mock.calls.at(-1)![1] as RequestInit).headers as Record<string, string>;

  function expectLogged(cluster: "prod" | "fleet", result: Awaited<ReturnType<typeof probeGrafanaAuth>>, fields: Record<string, unknown>) {
    const ctx = grafanaProbeLogContext(cluster, result);
    expect(Number.isInteger(result.durationMs) && result.durationMs >= 0).toBe(true);
    expect(ctx).toEqual({ cluster, durationMs: result.durationMs, ...fields });
    const jwt = authOf()["Authorization"]!.slice(7);
    const text = JSON.stringify(ctx) + grafanaProbeFailureMessage(cluster, result);
    expect(text).not.toContain(jwt);
    expect(text).not.toContain("Bearer");
  }

  it("is ok on 200 with a non-admin user, and sends a short-lived JWT to /api/user", async () => {
    fetchMock.mockResolvedValue(json(200, { login: "claws-observability", isGrafanaAdmin: false }));
    const result = await probeGrafanaAuth("fleet");
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://grafana.fleet.example/api/user");
    const auth = (init.headers as Record<string, string>)["Authorization"]!;
    expect(auth).toMatch(/^Bearer eyJ/);
    const claims = decode(auth.slice(7).split(".")[1]!);
    expect(claims.aud).toBe("grafana-fleet");
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
  });

  it("reports reason status with the code on a non-200 response", async () => {
    fetchMock.mockResolvedValue(json(401, { message: "invalid JWT" }));
    let result = await probeGrafanaAuth("prod");
    expect(result).toMatchObject({ ok: false, reason: "status", status: 401 });
    expectLogged("prod", result, { probeReason: "status", httpStatus: 401 });
    expect(grafanaProbeFailureMessage("prod", result)).toContain("rejected");
    fetchMock.mockResolvedValue(new Response("", { status: 302, headers: { Location: "/login" } }));
    result = await probeGrafanaAuth("prod");
    expect(result).toMatchObject({ ok: false, reason: "status", status: 302 });
    expectLogged("prod", result, { probeReason: "status", httpStatus: 302 });
  });

  it("reports reason admin_user when Grafana reports an admin user or omits the flag", async () => {
    fetchMock.mockResolvedValue(json(200, { isGrafanaAdmin: true }));
    let result = await probeGrafanaAuth("prod");
    expect(result).toMatchObject({ ok: false, reason: "admin_user" });
    expectLogged("prod", result, { probeReason: "admin_user" });
    fetchMock.mockResolvedValue(json(200, {}));
    result = await probeGrafanaAuth("prod");
    expect(result).toMatchObject({ ok: false, reason: "admin_user" });
  });

  it("reports reason timeout when the request is aborted by the timeout", async () => {
    fetchMock.mockRejectedValue(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    const result = await probeGrafanaAuth("prod");
    expect(result).toMatchObject({ ok: false, reason: "timeout", error: "TimeoutError" });
    expectLogged("prod", result, { probeReason: "timeout", probeError: "TimeoutError" });
    expect(grafanaProbeFailureMessage("prod", result)).toContain("failed");
  });

  it.each(["ECONNREFUSED", "ENOTFOUND"])("reports reason fetch_error with %s", async (code) => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) }));
    const result = await probeGrafanaAuth("prod");
    expect(result).toMatchObject({ ok: false, reason: "fetch_error", error: code });
    expectLogged("prod", result, { probeReason: "fetch_error", probeError: code });
  });
});

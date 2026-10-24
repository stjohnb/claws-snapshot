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

import { ensureSigningKey, jwks, mintGrafanaJwt, probeGrafanaAuth } from "./grafana-jwt.js";

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

  it("is true on 200 with a non-admin user, and sends a short-lived JWT to /api/user", async () => {
    fetchMock.mockResolvedValue(json(200, { login: "claws-observability", isGrafanaAdmin: false }));
    expect(await probeGrafanaAuth("fleet")).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe("https://grafana.fleet.example/api/user");
    const auth = (init.headers as Record<string, string>)["Authorization"]!;
    expect(auth).toMatch(/^Bearer eyJ/);
    const claims = decode(auth.slice(7).split(".")[1]!);
    expect(claims.aud).toBe("grafana-fleet");
    expect((claims.exp as number) - (claims.iat as number)).toBe(300);
  });

  it("is false on a non-200 response", async () => {
    fetchMock.mockResolvedValue(json(401, { message: "invalid JWT" }));
    expect(await probeGrafanaAuth("prod")).toBe(false);
    fetchMock.mockResolvedValue(new Response("", { status: 302, headers: { Location: "/login" } }));
    expect(await probeGrafanaAuth("prod")).toBe(false);
  });

  it("is false when Grafana reports an admin user or omits the flag", async () => {
    fetchMock.mockResolvedValue(json(200, { isGrafanaAdmin: true }));
    expect(await probeGrafanaAuth("prod")).toBe(false);
    fetchMock.mockResolvedValue(json(200, {}));
    expect(await probeGrafanaAuth("prod")).toBe(false);
  });

  it("is false when the request throws", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await probeGrafanaAuth("prod")).toBe(false);
  });
});

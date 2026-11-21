import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

const ISSUER = "https://auth.example/application/o/claws-api/";
const AUDIENCE = "claws-api";

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return (await import("./test-helpers.js")).completeConfigMock(actual, {
    MACHINE_AUTH_ISSUER: ISSUER,
    MACHINE_AUTH_AUDIENCE: AUDIENCE,
    MACHINE_API_GRANTS: { "node-evacuation": ["nas-claws-evacuation"] },
  });
});

const { verifyMachineToken, machineMayDo, machineActionEnabled, resetMachineAuthForTest } = await import("./machine-auth.js");

const keyA = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyB = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (pub: crypto.KeyObject, kid: string) => ({ ...pub.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" });

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const NOW = Date.UTC(2026, 10, 18, 12, 0, 0);

function sign(claims: Record<string, unknown>, opts: { kid?: string; key?: crypto.KeyObject; alg?: string } = {}): string {
  const header = { alg: opts.alg ?? "RS256", typ: "JWT", kid: opts.kid ?? "a" };
  const data = `${b64(header)}.${b64(claims)}`;
  const sig = crypto.sign("RSA-SHA256", Buffer.from(data), opts.key ?? keyA.privateKey).toString("base64url");
  return `${data}.${sig}`;
}

const claims = (over: Record<string, unknown> = {}) => ({
  iss: ISSUER, aud: AUDIENCE, exp: Math.floor(NOW / 1000) + 300, sub: "abc123",
  preferred_username: "nas-claws-evacuation", groups: ["nas-claws-evacuation"], ...over,
});

let jwksKeys: unknown[] = [];
let fetchFails = false;
const fetchMock = vi.fn(async (url: string) => {
  expect(url).toBe(`${ISSUER}jwks/`);
  if (fetchFails) throw new Error("connect ECONNREFUSED");
  return new Response(JSON.stringify({ keys: jwksKeys }), { status: 200, headers: { "content-type": "application/json" } });
});

beforeEach(() => {
  resetMachineAuthForTest();
  jwksKeys = [jwk(keyA.publicKey, "a")];
  fetchFails = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verifyMachineToken", () => {
  it("accepts a good token and returns the caller", async () => {
    expect(await verifyMachineToken(sign(claims()), NOW)).toEqual({
      ok: true, caller: { sub: "abc123", preferredUsername: "nas-claws-evacuation", groups: ["nas-claws-evacuation"] },
    });
    // Cached: a second token needs no refetch.
    expect((await verifyMachineToken(sign(claims()), NOW + 1000)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts an aud array containing the audience", async () => {
    expect((await verifyMachineToken(sign(claims({ aud: ["other", AUDIENCE] })), NOW)).ok).toBe(true);
  });

  it("refuses a wrong iss or aud", async () => {
    expect(await verifyMachineToken(sign(claims({ iss: "https://auth.example/application/o/claws/" })), NOW)).toEqual({ ok: false, reason: "wrong-issuer" });
    expect(await verifyMachineToken(sign(claims({ aud: "claws" })), NOW)).toEqual({ ok: false, reason: "wrong-audience" });
  });

  it("refuses an expired token, allowing 30 s of skew", async () => {
    const exp = Math.floor(NOW / 1000) - 10;
    expect((await verifyMachineToken(sign(claims({ exp })), NOW)).ok).toBe(true);
    expect(await verifyMachineToken(sign(claims({ exp: exp - 60 })), NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("refuses alg none and HS256", async () => {
    const none = `${b64({ alg: "none", typ: "JWT" })}.${b64(claims())}.`;
    expect((await verifyMachineToken(none, NOW)).ok).toBe(false);
    const hsData = `${b64({ alg: "HS256", typ: "JWT", kid: "a" })}.${b64(claims())}`;
    const pem = keyA.publicKey.export({ format: "pem", type: "spki" });
    const hs = `${hsData}.${crypto.createHmac("sha256", pem).update(hsData).digest("base64url")}`;
    expect(await verifyMachineToken(hs, NOW)).toEqual({ ok: false, reason: "unsupported-alg" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a missing, malformed or badly signed token", async () => {
    expect(await verifyMachineToken("", NOW)).toEqual({ ok: false, reason: "missing" });
    expect(await verifyMachineToken("not-a-jwt", NOW)).toEqual({ ok: false, reason: "malformed" });
    expect(await verifyMachineToken(sign(claims(), { key: keyB.privateKey }), NOW)).toEqual({ ok: false, reason: "bad-signature" });
    const [h, , s] = sign(claims()).split(".");
    expect(await verifyMachineToken(`${h}.${b64(claims({ groups: ["admins"] }))}.${s}`, NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refetches on an unknown kid, at most once a minute", async () => {
    expect((await verifyMachineToken(sign(claims()), NOW)).ok).toBe(true);
    // Key rotated to b, but within the minute: no refetch.
    jwksKeys = [jwk(keyA.publicKey, "a"), jwk(keyB.publicKey, "b")];
    expect(await verifyMachineToken(sign(claims(), { kid: "b", key: keyB.privateKey }), NOW + 10_000)).toEqual({ ok: false, reason: "unknown-kid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A minute later the unknown kid refetches and verifies.
    expect((await verifyMachineToken(sign(claims(), { kid: "b", key: keyB.privateKey }), NOW + 60_000)).ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("answers no-keys when the first fetch fails, and retries after a minute", async () => {
    fetchFails = true;
    expect(await verifyMachineToken(sign(claims()), NOW)).toEqual({ ok: false, reason: "no-keys" });
    expect(await verifyMachineToken(sign(claims()), NOW + 1000)).toEqual({ ok: false, reason: "no-keys" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchFails = false;
    expect((await verifyMachineToken(sign(claims()), NOW + 61_000)).ok).toBe(true);
  });

  it("keeps the last good keys when a refetch fails", async () => {
    expect((await verifyMachineToken(sign(claims()), NOW)).ok).toBe(true);
    fetchFails = true;
    expect(await verifyMachineToken(sign(claims(), { kid: "b", key: keyB.privateKey }), NOW + 60_000)).toEqual({ ok: false, reason: "unknown-kid" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await verifyMachineToken(sign(claims()), NOW + 61_000)).ok).toBe(true);
  });

  it("keeps the last good keys when a refetch answers an error status", async () => {
    expect((await verifyMachineToken(sign(claims()), NOW)).ok).toBe(true);
    fetchMock.mockImplementationOnce(async () => new Response("bad gateway", { status: 502 }));
    expect(await verifyMachineToken(sign(claims(), { kid: "b", key: keyB.privateKey }), NOW + 60_000)).toEqual({ ok: false, reason: "unknown-kid" });
    expect((await verifyMachineToken(sign(claims()), NOW + 61_000)).ok).toBe(true);
  });
});

describe("machine grants", () => {
  it("machineMayDo is true when any group holds the action", () => {
    expect(machineMayDo("node-evacuation", ["x", "nas-claws-evacuation"])).toBe(true);
    expect(machineMayDo("node-evacuation", ["claws-service"])).toBe(false);
    expect(machineMayDo("other-action", ["nas-claws-evacuation"])).toBe(false);
  });

  it("machineActionEnabled needs a grant for the action", () => {
    expect(machineActionEnabled("node-evacuation")).toBe(true);
    expect(machineActionEnabled("other-action")).toBe(false);
  });
});

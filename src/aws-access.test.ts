import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SessionAwsGrantRow } from "./db.js";

const SSO = { startUrl: "https://example.awsapps.com/start", region: "us-east-1", accountId: "123456789012" };

vi.mock("./config.js", async (importOriginal) =>
  (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), {
    AWS_SSO: { startUrl: "https://example.awsapps.com/start", region: "us-east-1", accountId: "123456789012" },
  }));

const logs = vi.hoisted(() => ({ lines: [] as Array<{ level: string; msg: string; fields: unknown }> }));
vi.mock("./log.js", () => {
  const rec = (level: string) => vi.fn((msg: string, fields?: unknown) => { logs.lines.push({ level, msg, fields }); });
  return { info: rec("info"), warn: rec("warn"), debug: rec("debug"), error: vi.fn((msg: string, err?: unknown, fields?: unknown) => {
    // The error itself is kept too, so the "never logs a secret" check covers it.
    logs.lines.push({ level: "error", msg, fields: { fields, err: err instanceof Error ? { message: err.message, stack: err.stack } : err } });
  }) };
});

const requests = vi.hoisted(() => ({
  recordGrant: vi.fn(async () => true),
  deliverGrantNotice: vi.fn(async () => ({ agentPickedUp: false, agentNotified: true, notifyFailure: null, agentNoticeQueued: false })),
  clearCapabilityRequest: vi.fn(async () => {}),
}));
vi.mock("./capability-requests.js", () => requests);

/** A stand-in for `session_aws_grants`. */
const fakeDb = vi.hoisted(() => {
  const rows = new Map<string, SessionAwsGrantRow>();
  const clearSignIn = (r: SessionAwsGrantRow) => { r.verification_url = null; r.user_code = null; };
  const claim = async (id: string, at: number) => {
    const r = rows.get(id);
    if (!r || r.status !== "awaiting-signin") return false;
    Object.assign(r, { status: "granting", granted_at: at });
    clearSignIn(r);
    return true;
  };
  return {
    rows,
    claim,
    claimSessionAwsGrantForGranting: vi.fn(claim),
    failGrantingSessionAwsGrant: vi.fn(async (id: string, reason: string, at: number) => {
      const r = rows.get(id);
      if (!r || (r.status !== "granting" && r.status !== "revoking")) return false;
      Object.assign(r, { status: "failed", end_reason: r.end_reason ?? reason, ended_at: r.ended_at ?? at });
      return true;
    }),
    revokeGrantingSessionAwsGrant: vi.fn(async (id: string, reason: string, at: number) => {
      const r = rows.get(id);
      if (!r || r.status !== "granting") return false;
      Object.assign(r, { status: "revoking", end_reason: reason, ended_at: at });
      return true;
    }),
    markAwsGrantForTakeBack: vi.fn(async (id: string, reason: string, at: number) => {
      const r = rows.get(id);
      if (!r || !(r.status === "granting" || (r.status === "failed" && r.granted_at != null))) return false;
      Object.assign(r, { status: "revoking", end_reason: r.end_reason ?? reason, ended_at: r.ended_at ?? at });
      return true;
    }),
    listStaleGrantingAwsGrants: vi.fn(async (before: number) => [...rows.values()].filter((r) => (r.status === "granting" || r.status === "revoking") && r.granted_at != null && r.granted_at <= before).map((r) => ({ ...r }))),
    listSessionAwsGrants: vi.fn(async (sessionId: string) => [...rows.values()].filter((r) => r.session_id === sessionId).map((r) => ({ ...r }))),
    getActiveSessionAwsGrant: vi.fn(async (sessionId: string) => {
      const r = [...rows.values()].filter((x) => x.session_id === sessionId && x.status === "active").sort((a, b) => (b.granted_at ?? 0) - (a.granted_at ?? 0))[0];
      return r ? { ...r } : undefined;
    }),
    insertSessionAwsGrant: vi.fn(async (row: SessionAwsGrantRow) => { rows.set(row.id, { ...row }); }),
    getSessionAwsGrant: vi.fn(async (id: string) => { const r = rows.get(id); return r ? { ...r } : undefined; }),
    listOpenSignInAwsGrantsForSession: vi.fn(async (sessionId: string) => [...rows.values()].filter((r) => r.session_id === sessionId && (r.status === "awaiting-signin" || r.status === "granting")).map((r) => ({ ...r }))),
    markSessionAwsGrantActive: vi.fn(async (id: string, at: number, exp: number) => {
      const r = rows.get(id);
      if (!r || r.status !== "granting") return false;
      Object.assign(r, { status: "active", granted_at: at, credentials_expire_at: exp });
      clearSignIn(r);
      return true;
    }),
    failSessionAwsGrant: vi.fn(async (id: string, reason: string, at: number) => {
      const r = rows.get(id);
      if (!r || r.status !== "awaiting-signin") return false;
      Object.assign(r, { status: "failed", end_reason: reason, ended_at: at });
      clearSignIn(r);
      return true;
    }),
    endOpenSessionAwsGrants: vi.fn(async (sessionId: string, reason: string, at: number, opts: { capability?: string; activeOnly?: boolean; except?: string } = {}) => {
      const ended: SessionAwsGrantRow[] = [];
      for (const r of rows.values()) {
        if (r.session_id !== sessionId || (opts.capability && r.capability !== opts.capability)) continue;
        if (r.id === opts.except && r.status === "active") continue;
        if (r.status === "active") { ended.push({ ...r }); Object.assign(r, { status: "ended", end_reason: reason, ended_at: at }); }
        else if (r.status === "awaiting-signin" && !opts.activeOnly) { Object.assign(r, { status: "failed", end_reason: reason, ended_at: at }); clearSignIn(r); }
        else if (r.status === "granting" && !opts.activeOnly) Object.assign(r, { status: "revoking", end_reason: reason, ended_at: at });
      }
      return ended;
    }),
    listExpiredActiveAwsGrants: vi.fn(async (now: number) => [...rows.values()].filter((r) => r.status === "active" && r.credentials_expire_at != null && r.credentials_expire_at <= now).map((r) => ({ ...r }))),
    failExpiredAwaitingSignInAwsGrants: vi.fn(async (before: number, reason: string, at: number) => {
      const failed: SessionAwsGrantRow[] = [];
      for (const r of rows.values()) {
        if (r.status !== "awaiting-signin" || r.device_expires_at == null || r.device_expires_at > before) continue;
        failed.push({ ...r });
        Object.assign(r, { status: "failed", end_reason: reason, ended_at: at });
        clearSignIn(r);
      }
      return failed;
    }),
    endActiveSessionAwsGrant: vi.fn(async (id: string, reason: string, at: number) => {
      const r = rows.get(id);
      if (!r || r.status !== "active") return false;
      Object.assign(r, { status: "ended", end_reason: reason, ended_at: at });
      return true;
    }),
    restoreEndedSessionAwsGrant: vi.fn(async (id: string) => {
      const r = rows.get(id);
      if (!r || r.status !== "ended") return false;
      Object.assign(r, { status: "active", end_reason: null, ended_at: null });
      return true;
    }),
    setSessionAwsGrantEndReason: vi.fn(async (id: string, reason: string) => {
      const r = rows.get(id);
      if (r && r.status === "ended") r.end_reason = reason;
    }),
  };
});
vi.mock("./db.js", () => fakeDb);

const { awsCredentialsGrantId } = await import("./capabilities.js");
const { startSignIn, settleSignInsForTests, sweepExpiredAwsGrants, recordAwsGrantEnd, renderCredentialsFile, cancelAwsSignIns } = await import("./aws-access.js");
const metrics = await import("./metrics.js");

/** Every labelled value of one of the sweep's metrics, keyed by its label value (or "" when unlabelled). */
async function sweepMetric(name: string): Promise<Record<string, number>> {
  const metric = metrics.registry.getSingleMetric(name);
  if (!metric) throw new Error(`no metric ${name}`);
  const out: Record<string, number> = {};
  for (const v of (await metric.get()).values) out[String(Object.values(v.labels)[0] ?? "")] = v.value;
  return out;
}

type ScriptStep = { match: string; status?: number; body?: unknown; throws?: boolean };

/** Every stub a test made, checked after it: the code under test swallows fetch errors, so the stub keeps its own. */
const stubs: Array<{ assertDone: () => void }> = [];

/**
 * One scripted AWS answer per call, in order; records every call. A step with
 * `throws` makes fetch reject (a network error). A call the script did not
 * expect, or a step never used, fails the test in `afterEach`.
 */
function stubFetch(script: ScriptStep[]) {
  const calls: Array<{ url: string; method: string; body: unknown; bearer: string | null }> = [];
  const unexpected: string[] = [];
  let step = 0;
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: u, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null, bearer: headers["x-amz-sso_bearer_token"] ?? null });
    const next = script[step++];
    if (!next || !u.includes(next.match)) {
      const problem = `unexpected call ${u} (expected ${next?.match ?? "none"})`;
      unexpected.push(problem);
      throw new Error(problem);
    }
    if (next.throws) throw new TypeError("fetch failed");
    order.push(`fetch:${new URL(u).pathname}`);
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200, headers: { "Content-Type": "application/json" } });
  });
  const stub = {
    fn: fn as unknown as typeof fetch,
    calls,
    assertDone: () => {
      expect(unexpected, "unexpected AWS calls").toEqual([]);
      expect(step, "scripted AWS calls used").toBe(script.length);
    },
  };
  stubs.push(stub);
  return stub;
}

const order: string[] = [];
const REGISTER = { match: "/client/register", body: { clientId: "cid", clientSecret: "csecret" } };
const DEVICE = { match: "/device_authorization", body: { deviceCode: "dcode", userCode: "ABCD-EFGH", verificationUri: "https://device.sso.us-east-1.amazonaws.com/", verificationUriComplete: "https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH", expiresIn: 600, interval: 5 } };
const PENDING = { match: "/token", status: 400, body: { error: "authorization_pending" } };
const TOKEN = { match: "/token", body: { accessToken: "atoken", tokenType: "Bearer", expiresIn: 3600, refreshToken: "rtoken-never-used" } };
const NOW = 1_800_000_000_000;
const CREDS = { match: "/federation/credentials", body: { roleCredentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "sekret", sessionToken: "stoken", expiration: NOW + 3_600_000 } } };
const LOGOUT = { match: "/logout", body: {} };

/**
 * A session backend whose `aws-credentials` slot is `slots` (session id → the
 * grant id its file names): a successful grant fills it, and
 * `clearAwsCredentials` empties it only while it holds that grant, unless
 * `clear` scripts its answer.
 */
function fakeBackend(opts: { slot?: boolean; grant?: unknown; revoke?: unknown; clear?: unknown; notify?: string; slots?: Record<string, string>; noSlot?: boolean } = {}) {
  const slots = new Map<string, string>(Object.entries(opts.slots ?? {}));
  const backend = {
    slots,
    getLive: vi.fn(async (id: string) => ({ ok: true as const, session: { id, alive: true, capabilities: [] as string[] } })),
    awsCredentialsSlot: vi.fn(async () => ({ ok: true as const, present: opts.slot ?? true })),
    grantCapability: vi.fn(async (id: string, _cap: string, o?: { awsCredentials?: string }) => {
      order.push("grant");
      const result = (opts.grant ?? { ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false }) as { ok: boolean; reason?: string; detail?: string };
      const holder = o?.awsCredentials ? awsCredentialsGrantId(o.awsCredentials) : null;
      if (result.ok && holder) slots.set(id, holder);
      return result;
    }),
    clearAwsCredentials: vi.fn(async (id: string, grantId: string) => {
      if (opts.clear) return opts.clear;
      const holder = slots.get(id) ?? null;
      if (holder !== grantId) return { ok: true as const, cleared: false, holder };
      slots.delete(id);
      return { ok: true as const, cleared: true, holder };
    }),
    revokeCapability: vi.fn(async () => opts.revoke ?? { ok: true, live: true, keysRemoved: false, restarted: false }),
    notifyAgent: vi.fn(async () => opts.notify ?? "ok"),
  };
  // A backend with no credentials slot of its own: take-backs fall back to revokeCapability.
  if (opts.noSlot) delete (backend as Partial<typeof backend>).clearAwsCredentials;
  return backend;
}

const SECRETS = ["rtoken-never-used", "atoken", "dcode", "csecret", "ABCD-EFGH", "sekret", "stoken", "AKIAEXAMPLE"];

/** No log line so far carries a device code, token or credential. */
function expectNoSecretsLogged() {
  const logged = JSON.stringify(logs.lines);
  for (const secret of SECRETS) expect(logged, secret).not.toContain(secret);
}

/** The session's earlier, still-valid `aws-viewer` grant. */
function oldViewerGrant(): SessionAwsGrantRow {
  return { id: "old", session_id: "abc123", capability: "aws-viewer", permission_set: "Viewer", account_id: SSO.accountId, status: "active", verification_url: null, user_code: null, device_expires_at: null, granted_by: "operator", created_at: NOW - 60_000, granted_at: NOW - 60_000, credentials_expire_at: NOW + 3_000_000, ended_at: null, end_reason: null };
}

function deps(fetchFn: typeof fetch, backend: ReturnType<typeof fakeBackend>) {
  let id = 0;
  return {
    fetch: fetchFn,
    now: () => NOW,
    sleep: vi.fn(async (_ms: number) => {}),
    backend: () => backend as never,
    newId: () => `awsg_${++id}`,
    config: () => SSO,
  };
}

afterEach(async () => {
  // A poll a failed test left behind must not reach the next test.
  await settleSignInsForTests();
  const made = stubs.splice(0);
  for (const stub of made) stub.assertDone();
});

beforeEach(() => {
  fakeDb.rows.clear();
  order.length = 0;
  logs.lines.length = 0;
  // A reset (not a clear) also drops one-shot implementations a failed test left queued.
  vi.resetAllMocks();
});

describe("startSignIn", () => {
  it("registers a public device-code client, stores the link and code, then grants after the operator signs in", async () => {
    const f = stubFetch([REGISTER, DEVICE, PENDING, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    const started = await startSignIn("abc123", "aws-admin", "brendan", deps(f.fn, backend));

    expect(started).toEqual({ ok: true, grantId: "awsg_1", verificationUrl: DEVICE.body.verificationUriComplete, userCode: "ABCD-EFGH", expiresAt: NOW + 600_000 });
    expect(f.calls[0]!.body).toEqual({ clientName: expect.any(String), clientType: "public", grantTypes: ["urn:ietf:params:oauth:grant-type:device_code"], scopes: ["sso:account:access"] });
    expect(f.calls[1]!.body).toEqual({ clientId: "cid", clientSecret: "csecret", startUrl: SSO.startUrl });

    await settleSignInsForTests();
    // GetRoleCredentials asks for the capability's permission set in the configured account.
    expect(f.calls[4]!.url).toContain("account_id=123456789012");
    expect(f.calls[4]!.url).toContain("role_name=Admin");
    expect(f.calls[4]!.bearer).toBe("atoken");
    expect(f.calls[5]!.bearer).toBe("atoken");
    // Logout happens before the grant lands.
    expect(order.indexOf("fetch:/logout")).toBeLessThan(order.indexOf("grant"));
    expect(backend.grantCapability).toHaveBeenCalledWith("abc123", "aws-admin", {
      awsCredentials: "# claws-grant: awsg_1\n[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = sekret\naws_session_token = stoken\n",
    });
    const row = fakeDb.rows.get("awsg_1")!;
    expect(row).toMatchObject({ status: "active", granted_by: "brendan", permission_set: "Admin", account_id: "123456789012", credentials_expire_at: NOW + 3_600_000, verification_url: null, user_code: null });
    expect(requests.recordGrant).toHaveBeenCalledWith("abc123", "aws-admin", NOW);
    expect(requests.deliverGrantNotice).toHaveBeenCalled();
  });

  it("discards the refresh token and never logs a code, token or credential", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-ops", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    // No call after CreateToken carries the refresh token.
    for (const call of f.calls.slice(3)) expect(JSON.stringify(call)).not.toContain("rtoken-never-used");
    expectNoSecretsLogged();
    expect(f.calls[3]!.url).toContain("role_name=Ops");
  });

  it("marks the row failed as expired and grants nothing when the device code expires", async () => {
    const f = stubFetch([REGISTER, DEVICE, PENDING, { match: "/token", status: 400, body: { error: "expired_token" } }]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-viewer", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "expired", verification_url: null, user_code: null });
    expect(backend.grantCapability).not.toHaveBeenCalled();
    expect(requests.recordGrant).not.toHaveBeenCalled();
  });

  it("marks the row failed as declined when the operator declines", async () => {
    const f = stubFetch([REGISTER, DEVICE, { match: "/token", status: 400, body: { error: "access_denied" } }]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "declined" });
    expect(backend.grantCapability).not.toHaveBeenCalled();
  });

  it("still signs out, and grants nothing, when GetRoleCredentials fails", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, { match: "/federation/credentials", status: 403, body: { message: "No access" } }, LOGOUT]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(f.calls.map((c) => new URL(c.url).pathname)).toContain("/logout");
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed" });
    expect(fakeDb.rows.get("awsg_1")!.end_reason).toMatch(/^aws-error/);
    expect(backend.grantCapability).not.toHaveBeenCalled();
  });

  it("marks the row failed when the backend refuses the grant", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend({ grant: { ok: false, reason: "invalid", detail: "resume this session first" } });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "grant-failed: resume this session first" });
    expect(requests.recordGrant).not.toHaveBeenCalled();
  });

  it("leaves the earlier grant in the slot when the backend refuses the grant", async () => {
    fakeDb.rows.set("old", oldViewerGrant());
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend({ grant: { ok: false, reason: "invalid", detail: "resume this session first" } });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    // A refused grant wrote nothing, so there is nothing to take back.
    expect(backend.clearAwsCredentials).not.toHaveBeenCalled();
    expect(backend.revokeCapability).not.toHaveBeenCalled();
    expect(fakeDb.rows.get("old")).toMatchObject({ status: "active" });
  });

  it("takes back the credentials when the grant write itself throws", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    backend.grantCapability.mockRejectedValueOnce(new Error("api timeout"));
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.clearAwsCredentials).toHaveBeenCalledWith("abc123", "awsg_1");
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "internal error" });
    expect(requests.recordGrant).not.toHaveBeenCalled();
  });

  it("leaves a grant whose take-back failed where the sweep retries it, logging an error", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend({ clear: { ok: false, reason: "unavailable", detail: "api down" } });
    backend.grantCapability.mockImplementationOnce(async (id: string) => {
      // The write landed, then the call failed.
      backend.slots.set(id, "awsg_1");
      throw new Error("api timeout");
    });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "revoking", end_reason: "internal error" });
    const error = logs.lines.find((l) => l.level === "error")!;
    expect(error.msg).toBe("AWS grant could not be recorded or taken back; the sweep retries the take-back");
    expect((error.fields as { fields: { outcome: string } }).fields.outcome).toBe("unavailable");

    // Once the runtime answers, the sweep empties the slot and fails the row.
    const later = fakeBackend({ slots: { abc123: "awsg_1" } });
    expect(await sweepExpiredAwsGrants({ ...deps(stubFetch([]).fn, later), now: () => NOW + 11 * 60_000 })).toEqual({ ended: 0, retry: 0, failedSignIns: 1 });
    expect(later.clearAwsCredentials).toHaveBeenCalledWith("abc123", "awsg_1");
    expect(later.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "internal error" });
    expectNoSecretsLogged();
  });

  it("puts a late write back where the sweep takes it back after the sweep already failed the row", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend({ clear: { ok: false, reason: "unavailable", detail: "busy" } });
    backend.grantCapability.mockImplementationOnce(async (id: string) => {
      // The write outlasts the stale window: the sweep empties the (still empty) slot and fails the row.
      const sweeper = fakeBackend();
      await sweepExpiredAwsGrants({ ...deps(stubFetch([]).fn, sweeper), now: () => NOW + 11 * 60_000 });
      expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "interrupted" });
      // Then the write lands.
      backend.slots.set(id, "awsg_1");
      return { ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false };
    });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    // The take-back could not be confirmed, so the row is back where the sweep looks.
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "revoking", end_reason: "interrupted" });
    expect(requests.recordGrant).not.toHaveBeenCalled();

    const later = fakeBackend({ slots: { abc123: "awsg_1" } });
    expect(await sweepExpiredAwsGrants({ ...deps(stubFetch([]).fn, later), now: () => NOW + 11 * 60_000 })).toEqual({ ended: 0, retry: 0, failedSignIns: 1 });
    expect(later.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "interrupted" });
  });

  it("takes back through revokeCapability on a backend with no credentials slot of its own", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend({ noSlot: true });
    backend.grantCapability.mockRejectedValueOnce(new Error("api timeout"));
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.revokeCapability).toHaveBeenCalledWith("abc123", "aws-admin");
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "internal error" });
  });

  it("fails the sign-in and writes nothing when AWS returns credentials that already expired", async () => {
    const stale = { ...CREDS, body: { roleCredentials: { ...CREDS.body.roleCredentials, expiration: NOW - 1000 } } };
    const f = stubFetch([REGISTER, DEVICE, TOKEN, stale, LOGOUT]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.grantCapability).not.toHaveBeenCalled();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "aws-error: credentials already expired" });
  });

  it("caps credentials with no expiration at the hour", async () => {
    const none = { ...CREDS, body: { roleCredentials: { ...CREDS.body.roleCredentials, expiration: 0 } } };
    const f = stubFetch([REGISTER, DEVICE, TOKEN, none, LOGOUT]);
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, fakeBackend()));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active", credentials_expire_at: NOW + 3_600_000 });
  });

  it("retries a grant write the runtime could not take, then grants", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    backend.grantCapability.mockResolvedValueOnce({ ok: false, reason: "unavailable", detail: "a capability is being revoked from this session — try again shortly" });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.grantCapability).toHaveBeenCalledTimes(2);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active" });
    expect(backend.slots.get("abc123")).toBe("awsg_1");
  });

  it("takes back and fails a grant the runtime still could not take after its retries", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend({ grant: { ok: false, reason: "unavailable", detail: "api down" } });
    const d = deps(f.fn, backend);
    await startSignIn("abc123", "aws-admin", "operator", d);
    await settleSignInsForTests();
    expect(backend.grantCapability).toHaveBeenCalledTimes(4);
    // The poll's wait, then the write's 1 s, 2 s and 4 s backoff, all through deps.sleep.
    expect(d.sleep.mock.calls.map((c) => c[0])).toEqual([5000, 1000, 2000, 4000]);
    expect(backend.clearAwsCredentials).toHaveBeenCalledWith("abc123", "awsg_1");
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "grant-failed: unavailable: api down" });
  });

  it("stops retrying a grant write once a deny lands", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    backend.grantCapability.mockImplementationOnce(async () => {
      await cancelAwsSignIns("abc123", "aws-admin", "declined", { now: NOW });
      return { ok: false, reason: "unavailable", detail: "busy" };
    });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.grantCapability).toHaveBeenCalledTimes(1);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "declined" });
  });

  it("fails the sign-in and writes nothing when the claim throws", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    fakeDb.claimSessionAwsGrantForGranting.mockRejectedValueOnce(new Error("db down"));
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.grantCapability).not.toHaveBeenCalled();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "internal error" });
  });

  it("rides out a transient network error or 5xx while polling", async () => {
    const f = stubFetch([REGISTER, DEVICE, { match: "/token", throws: true }, { match: "/token", status: 503, body: { message: "busy" } }, PENDING, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active" });
    expect(backend.grantCapability).toHaveBeenCalledTimes(1);
    expect(logs.lines.filter((l) => l.msg.includes("poll failed")).map((l) => (l.fields as { code: string }).code)).toEqual(["network-error", "http-503"]);
  });

  it("backs off by the RFC 8628 step on slow_down", async () => {
    const f = stubFetch([REGISTER, DEVICE, { match: "/token", status: 400, body: { error: "slow_down" } }, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    const d = deps(f.fn, backend);
    await startSignIn("abc123", "aws-admin", "operator", d);
    await settleSignInsForTests();
    expect(d.sleep.mock.calls.map((c) => c[0])).toEqual([5000, 10000]);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active" });
  });

  it("ends the grant within the hour even when the permission set allows longer", async () => {
    const long = { ...CREDS, body: { roleCredentials: { ...CREDS.body.roleCredentials, expiration: NOW + 12 * 3_600_000 } } };
    const f = stubFetch([REGISTER, DEVICE, TOKEN, long, LOGOUT]);
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, fakeBackend()));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active", credentials_expire_at: NOW + 3_600_000 });
  });

  it("replaces the session's earlier grant, ending it and clearing its request", async () => {
    fakeDb.rows.set("old", oldViewerGrant());
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("old")).toMatchObject({ status: "ended", end_reason: "replaced" });
    expect(requests.clearCapabilityRequest).toHaveBeenCalledWith("abc123", "aws-viewer");
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active" });
    expect(backend.revokeCapability).not.toHaveBeenCalled();
    // Ending the replaced grant never empties the slot the new grant holds.
    expect(backend.clearAwsCredentials).not.toHaveBeenCalled();
    expect(backend.slots.get("abc123")).toBe("awsg_1");
  });

  it("grants nothing when the sign-in is ended after sign-out but before the claim", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    fakeDb.claimSessionAwsGrantForGranting.mockImplementationOnce(async (id: string, at: number) => {
      // A deny or a newer sign-in lands while GetRoleCredentials and Logout ran.
      await fakeDb.failSessionAwsGrant(id, "superseded", NOW);
      return fakeDb.claim(id, at);
    });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.grantCapability).not.toHaveBeenCalled();
    expect(backend.revokeCapability).not.toHaveBeenCalled();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "superseded" });
  });

  it("takes back the credentials when a deny lands while they are being written", async () => {
    fakeDb.rows.set("old", oldViewerGrant());
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    backend.grantCapability.mockImplementationOnce(async () => {
      // The operator's Deny arrives after the claim but before the write returns.
      expect(await cancelAwsSignIns("abc123", "aws-admin", "declined", { now: NOW })).toBe(1);
      backend.slots.set("abc123", "awsg_1");
      return { ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false };
    });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.clearAwsCredentials).toHaveBeenCalledWith("abc123", "awsg_1");
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "declined" });
    expect(backend.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("old")).toMatchObject({ status: "active" });
    expect(requests.recordGrant).not.toHaveBeenCalled();
    expect(requests.deliverGrantNotice).not.toHaveBeenCalled();
  });

  it("takes back the credentials when an operator revoke lands while they are being written", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    backend.grantCapability.mockImplementationOnce(async () => {
      await recordAwsGrantEnd("abc123", "aws-admin", "revoked", NOW);
      backend.slots.set("abc123", "awsg_1");
      return { ok: true, live: true, loadPath: null, marker: null, delayed: false, landed: true, restarted: false };
    });
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.clearAwsCredentials).toHaveBeenCalledWith("abc123", "awsg_1");
    expect(backend.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "revoked" });
    expect(requests.recordGrant).not.toHaveBeenCalled();
  });

  it("takes back credentials and leaves the replaced grant alone when the claim is lost after the write", async () => {
    fakeDb.rows.set("old", oldViewerGrant());
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    fakeDb.markSessionAwsGrantActive.mockResolvedValueOnce(false);
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.clearAwsCredentials).toHaveBeenCalledWith("abc123", "awsg_1");
    expect(backend.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "internal error" });
    // "replaced" runs only once the new grant is active.
    expect(fakeDb.rows.get("old")).toMatchObject({ status: "active" });
    expect(requests.recordGrant).not.toHaveBeenCalled();
  });

  it("still grants when the sign-out fails, logging a warning", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, { match: "/logout", throws: true }]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active" });
    expect(logs.lines.some((l) => l.level === "warn" && l.msg.startsWith("AWS sign-out failed"))).toBe(true);
  });

  it("keeps the grant and still tells the agent when recording it on the request fails", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    requests.recordGrant.mockRejectedValueOnce(new Error("db down"));
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "active" });
    expect(requests.deliverGrantNotice).toHaveBeenCalled();
    expect(logs.lines.some((l) => l.level === "warn" && l.msg.includes("request"))).toBe(true);
    expect(logs.lines.some((l) => l.level === "error")).toBe(false);
  });

  it("fails the sign-in after repeated transient poll errors", async () => {
    const err = { match: "/token", status: 502, body: { message: "bad gateway" } };
    const f = stubFetch([REGISTER, DEVICE, err, err, err, err, err]);
    const backend = fakeBackend();
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "aws-error: http-502" });
    expect(backend.grantCapability).not.toHaveBeenCalled();
  });

  it("revokes the credentials and fails the row when recording the grant throws", async () => {
    const f = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
    const backend = fakeBackend();
    fakeDb.markSessionAwsGrantActive.mockRejectedValueOnce(new Error("db down"));
    await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    await settleSignInsForTests();
    expect(backend.grantCapability).toHaveBeenCalledTimes(1);
    expect(backend.clearAwsCredentials).toHaveBeenCalledWith("abc123", "awsg_1");
    expect(backend.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "internal error" });
    expect(requests.recordGrant).not.toHaveBeenCalled();
  });

  it("refuses a pod launched before the credentials slot, before any AWS call", async () => {
    const f = stubFetch([]);
    const started = await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, fakeBackend({ slot: false })));
    expect(started).toMatchObject({ ok: false, reason: "invalid" });
    expect(started.ok ? "" : started.detail).toContain("resume this session first");
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a non-AWS capability and an unconfigured broker", async () => {
    const f = stubFetch([]);
    expect(await startSignIn("abc123", "home-assistant", "operator", deps(f.fn, fakeBackend()))).toMatchObject({ ok: false, reason: "invalid" });
    expect(await startSignIn("abc123", "aws-admin", "operator", { ...deps(f.fn, fakeBackend()), config: () => null })).toMatchObject({ ok: false, reason: "unconfigured" });
    expect(f.calls).toHaveLength(0);
  });

  it("supersedes an earlier sign-in still awaiting for the same session", async () => {
    const backend = fakeBackend();
    // The first poll is cancelled before it calls CreateToken.
    const first = stubFetch([REGISTER, DEVICE]);
    const d = deps(first.fn, backend);
    // Hold the first poll until the second sign-in has started.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    d.sleep = vi.fn(async () => { await gate; });
    try {
      await startSignIn("abc123", "aws-viewer", "operator", d);
      const second = stubFetch([REGISTER, DEVICE, TOKEN, CREDS, LOGOUT]);
      await startSignIn("abc123", "aws-admin", "operator", { ...deps(second.fn, backend), newId: () => "awsg_2" });
    } finally {
      release();
    }
    await settleSignInsForTests();
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "superseded" });
    expect(fakeDb.rows.get("awsg_2")).toMatchObject({ status: "active" });
    expect(backend.grantCapability).toHaveBeenCalledTimes(1);
  });

  it("gives up its own sign-in when a newer one for the session was stored at the same moment", async () => {
    const backend = fakeBackend();
    const f = stubFetch([REGISTER, DEVICE]);
    // A second approval stores its row (same moment, later id) between this one's insert and its supersede.
    fakeDb.listOpenSignInAwsGrantsForSession.mockImplementationOnce(async (sessionId: string) => {
      fakeDb.rows.set("awsg_9", { ...fakeDb.rows.get("awsg_1")!, id: "awsg_9" });
      return [...fakeDb.rows.values()].filter((r) => r.session_id === sessionId && r.status === "awaiting-signin").map((r) => ({ ...r }));
    });
    const started = await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, backend));
    expect(started).toMatchObject({ ok: false, reason: "unavailable" });
    expect(fakeDb.rows.get("awsg_1")).toMatchObject({ status: "failed", end_reason: "superseded" });
    // The newer sign-in survives: neither approval cancels the other's survivor.
    expect(fakeDb.rows.get("awsg_9")).toMatchObject({ status: "awaiting-signin" });
  });

  it("leaves the earlier sign-in in place when the new one cannot start", async () => {
    fakeDb.rows.set("earlier", { id: "earlier", session_id: "abc123", capability: "aws-viewer", permission_set: "Viewer", account_id: SSO.accountId, status: "awaiting-signin", verification_url: "https://x", user_code: "C", device_expires_at: NOW + 300_000, granted_by: "operator", created_at: NOW - 1000, granted_at: null, credentials_expire_at: null, ended_at: null, end_reason: null });
    const f = stubFetch([REGISTER, { match: "/device_authorization", status: 500, body: { message: "boom" } }]);
    expect(await startSignIn("abc123", "aws-admin", "operator", deps(f.fn, fakeBackend()))).toMatchObject({ ok: false, reason: "aws-error" });
    expect(fakeDb.rows.get("earlier")).toMatchObject({ status: "awaiting-signin" });
  });
});

describe("cancelAwsSignIns", () => {
  it("fails only the named capability's awaiting sign-ins for the session", async () => {
    const awaiting = (id: string, sessionId: string, capability: string): SessionAwsGrantRow => ({ id, session_id: sessionId, capability, permission_set: "Admin", account_id: SSO.accountId, status: "awaiting-signin", verification_url: "https://x", user_code: "C", device_expires_at: NOW + 300_000, granted_by: "operator", created_at: NOW, granted_at: null, credentials_expire_at: null, ended_at: null, end_reason: null });
    fakeDb.rows.set("a", awaiting("a", "abc123", "aws-admin"));
    fakeDb.rows.set("b", awaiting("b", "abc123", "aws-ops"));
    fakeDb.rows.set("c", awaiting("c", "def456", "aws-admin"));
    expect(await cancelAwsSignIns("abc123", "aws-admin", "declined", { now: NOW })).toBe(1);
    expect(fakeDb.rows.get("a")).toMatchObject({ status: "failed", end_reason: "declined", verification_url: null });
    expect(fakeDb.rows.get("b")).toMatchObject({ status: "awaiting-signin" });
    expect(fakeDb.rows.get("c")).toMatchObject({ status: "awaiting-signin" });
  });

  it("marks a sign-in that is mid-grant revoking, for its take-back", async () => {
    fakeDb.rows.set("g", { id: "g", session_id: "abc123", capability: "aws-admin", permission_set: "Admin", account_id: SSO.accountId, status: "granting", verification_url: null, user_code: null, device_expires_at: NOW + 300_000, granted_by: "operator", created_at: NOW, granted_at: NOW, credentials_expire_at: null, ended_at: null, end_reason: null });
    expect(await cancelAwsSignIns("abc123", "aws-admin", "declined", { now: NOW })).toBe(1);
    expect(fakeDb.rows.get("g")).toMatchObject({ status: "revoking", end_reason: "declined" });
  });
});

describe("sweepExpiredAwsGrants", () => {
  function activeRow(id: string, sessionId: string, exp: number | null): SessionAwsGrantRow {
    return { id, session_id: sessionId, capability: "aws-admin", permission_set: "Admin", account_id: SSO.accountId, status: "active", verification_url: null, user_code: null, device_expires_at: null, granted_by: "operator", created_at: NOW - 4_000_000, granted_at: NOW - 3_700_000, credentials_expire_at: exp, ended_at: null, end_reason: null };
  }
  const granting = (id: string, sessionId: string, claimedAt: number): SessionAwsGrantRow => ({ ...activeRow(id, sessionId, null), status: "granting", granted_at: claimedAt, credentials_expire_at: null });
  /** Claimed long enough ago that its process cannot still be writing. */
  const STALE = NOW - 11 * 60_000;

  it("empties an expired grant's slot, records it and tells the agent", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    fakeDb.rows.set("g2", activeRow("g2", "def456", NOW + 60_000));
    const backend = fakeBackend({ slots: { abc123: "g1", def456: "g2" } });
    const result = await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend));
    expect(result).toEqual({ ended: 1, retry: 0, failedSignIns: 0 });
    expect(backend.clearAwsCredentials.mock.calls).toEqual([["abc123", "g1"]]);
    expect(backend.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "ended", end_reason: "expired" });
    expect(fakeDb.rows.get("g2")).toMatchObject({ status: "active" });
    expect(backend.notifyAgent).toHaveBeenCalledWith("abc123", expect.stringContaining("request"));
    expect(requests.clearCapabilityRequest).toHaveBeenCalledWith("abc123", "aws-admin");
  });

  it("exports zero-seeded sweep metrics before any sweep", async () => {
    metrics.resetMetricsForTests();
    expect(await sweepMetric("claws_aws_grant_sweep_grants_total")).toEqual({ ended: 0, retry: 0, failed_signin: 0 });
    expect(await sweepMetric("claws_aws_grant_sweep_warnings_total")).toEqual({ revoke_retry: 0, end_failed: 0 });
  });

  it("counts an ended grant, a failed revoke and its warning, and stamps the finish time", async () => {
    metrics.resetMetricsForTests();
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    fakeDb.rows.set("g2", activeRow("g2", "def456", NOW - 1));
    const backend = fakeBackend({ slots: { abc123: "g1", def456: "g2" } });
    backend.clearAwsCredentials.mockResolvedValueOnce({ ok: false, reason: "unavailable", detail: "api down" });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 1, retry: 1, failedSignIns: 0 });
    expect(await sweepMetric("claws_aws_grant_sweep_grants_total")).toEqual({ ended: 1, retry: 1, failed_signin: 0 });
    expect(await sweepMetric("claws_aws_grant_sweep_warnings_total")).toEqual({ revoke_retry: 1, end_failed: 0 });
    expect(await sweepMetric("claws_aws_grant_sweep_last_finish_timestamp_seconds")).toEqual({ "": NOW / 1000 });
  });

  it("counts a take-back that threw as an end_failed warning", async () => {
    metrics.resetMetricsForTests();
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    const backend = fakeBackend({ slots: { abc123: "g1" } });
    backend.clearAwsCredentials.mockRejectedValueOnce(new Error("boom"));
    await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend));
    expect(await sweepMetric("claws_aws_grant_sweep_warnings_total")).toEqual({ revoke_retry: 0, end_failed: 1 });
  });

  it("closes the row as session-ended when the session is gone", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    const backend = fakeBackend({ clear: { ok: false, reason: "not-found" } });
    await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend));
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "ended", end_reason: "session-ended" });
    expect(backend.notifyAgent).not.toHaveBeenCalled();
  });

  it("leaves the row for the next sweep when the runtime cannot answer", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    const backend = fakeBackend({ clear: { ok: false, reason: "unavailable", detail: "api down" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 0, retry: 1, failedSignIns: 0 });
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "active", end_reason: null });
  });

  it("ends an expired grant at its expiry even while a renewal of the same capability awaits", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    fakeDb.rows.set("g2", { ...activeRow("g2", "abc123", null), status: "awaiting-signin", verification_url: "https://x", user_code: "C", device_expires_at: NOW + 300_000, granted_at: null, credentials_expire_at: null });
    const backend = fakeBackend({ slots: { abc123: "g1" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 1, retry: 0, failedSignIns: 0 });
    expect(backend.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "ended", end_reason: "expired" });
    expect(fakeDb.rows.get("g2")).toMatchObject({ status: "awaiting-signin" });
    expect(fakeDb.endOpenSessionAwsGrants).not.toHaveBeenCalled();
  });

  it("puts back a row whose take-back threw, and still sweeps the rest and the stale sign-ins", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    fakeDb.rows.set("g2", activeRow("g2", "def456", NOW - 1));
    fakeDb.rows.set("s1", { ...activeRow("s1", "ghi789", null), status: "awaiting-signin", verification_url: "https://x", user_code: "C", device_expires_at: NOW - 120_000, granted_at: null, credentials_expire_at: null });
    const backend = fakeBackend({ slots: { abc123: "g1", def456: "g2" } });
    backend.clearAwsCredentials.mockRejectedValueOnce(new Error("boom"));
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 1, retry: 1, failedSignIns: 1 });
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "active", end_reason: null });
    expect(fakeDb.rows.get("g2")).toMatchObject({ status: "ended", end_reason: "expired" });
    expect(fakeDb.rows.get("s1")).toMatchObject({ status: "failed", end_reason: "expired" });
  });

  it("skips a row that was ended between the list and the take-back", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    fakeDb.listExpiredActiveAwsGrants.mockImplementationOnce(async () => {
      const listed = [{ ...fakeDb.rows.get("g1")! }];
      Object.assign(fakeDb.rows.get("g1")!, { status: "ended", end_reason: "replaced" });
      return listed;
    });
    const backend = fakeBackend();
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 0, retry: 0, failedSignIns: 0 });
    expect(backend.clearAwsCredentials).not.toHaveBeenCalled();
    expect(fakeDb.rows.get("g1")).toMatchObject({ end_reason: "replaced" });
  });

  it("ends an expired grant a newer grant already replaced, without emptying the newer one", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    fakeDb.rows.set("g2", { ...activeRow("g2", "abc123", NOW + 3_000_000), granted_at: NOW - 60_000 });
    const backend = fakeBackend({ slots: { abc123: "g2" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 1, retry: 0, failedSignIns: 0 });
    expect(backend.slots.get("abc123")).toBe("g2");
    expect(backend.notifyAgent).not.toHaveBeenCalled();
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "ended", end_reason: "replaced" });
    expect(fakeDb.rows.get("g2")).toMatchObject({ status: "active" });
    expect(requests.clearCapabilityRequest).not.toHaveBeenCalled();
  });

  it("clears the request of an expired grant a different capability's grant replaced", async () => {
    fakeDb.rows.set("g1", activeRow("g1", "abc123", NOW - 1));
    fakeDb.rows.set("g2", { ...activeRow("g2", "abc123", NOW + 3_000_000), capability: "aws-ops", granted_at: NOW - 60_000 });
    const backend = fakeBackend({ slots: { abc123: "g2" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 1, retry: 0, failedSignIns: 0 });
    expect(backend.slots.get("abc123")).toBe("g2");
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "ended", end_reason: "replaced" });
    expect(requests.clearCapabilityRequest).toHaveBeenCalledWith("abc123", "aws-admin");
  });

  it("takes back a grant whose process died mid-write, leaving a later grant's credentials alone", async () => {
    fakeDb.rows.set("dead", granting("dead", "abc123", STALE));
    fakeDb.rows.set("covered", granting("covered", "def456", STALE));
    fakeDb.rows.set("newer", { ...activeRow("newer", "def456", NOW + 3_000_000), granted_at: NOW - 60_000 });
    // Claimed moments ago: its process may still be writing.
    fakeDb.rows.set("recent", granting("recent", "ghi789", NOW - 1000));
    const backend = fakeBackend({ slots: { abc123: "dead", def456: "newer", ghi789: "recent" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 0, retry: 0, failedSignIns: 2 });
    expect(backend.clearAwsCredentials.mock.calls).toEqual([["abc123", "dead"], ["def456", "covered"]]);
    expect([...backend.slots.entries()]).toEqual([["def456", "newer"], ["ghi789", "recent"]]);
    expect(fakeDb.rows.get("dead")).toMatchObject({ status: "failed", end_reason: "interrupted" });
    expect(fakeDb.rows.get("covered")).toMatchObject({ status: "failed", end_reason: "interrupted" });
    expect(fakeDb.rows.get("newer")).toMatchObject({ status: "active" });
    expect(fakeDb.rows.get("recent")).toMatchObject({ status: "granting" });
  });

  it("empties a stale grant's slot even when its capability never reached the stored list", async () => {
    // The process died between the Secret write and recording the capability: the slot is matched by grant id alone.
    fakeDb.rows.set("dead", granting("dead", "abc123", STALE));
    const backend = fakeBackend({ slots: { abc123: "dead" }, revoke: { ok: false, reason: "invalid", detail: "aws-admin cannot be revoked from this session" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 0, retry: 0, failedSignIns: 1 });
    expect(backend.slots.has("abc123")).toBe(false);
    expect(backend.revokeCapability).not.toHaveBeenCalled();
  });

  it("ends an older active grant whose credentials a stale grant's write replaced", async () => {
    fakeDb.rows.set("old", { ...activeRow("old", "abc123", NOW + 3_000_000), capability: "aws-viewer", granted_at: NOW - 900_000 });
    fakeDb.rows.set("dead", granting("dead", "abc123", STALE));
    const backend = fakeBackend({ slots: { abc123: "dead" } });
    await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend));
    expect(backend.clearAwsCredentials.mock.calls).toEqual([["abc123", "dead"]]);
    expect(fakeDb.rows.get("dead")).toMatchObject({ status: "failed", end_reason: "interrupted" });
    expect(fakeDb.rows.get("old")).toMatchObject({ status: "ended", end_reason: "replaced" });
    expect(requests.clearCapabilityRequest).toHaveBeenCalledWith("abc123", "aws-viewer");
  });

  it("finishes a stopped grant's take-back, keeping the reason it was stopped for", async () => {
    fakeDb.rows.set("stopped", { ...granting("stopped", "abc123", STALE), status: "revoking", end_reason: "declined", ended_at: STALE + 1 });
    const backend = fakeBackend({ slots: { abc123: "stopped" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 0, retry: 0, failedSignIns: 1 });
    expect(backend.slots.has("abc123")).toBe(false);
    expect(fakeDb.rows.get("stopped")).toMatchObject({ status: "failed", end_reason: "declined", ended_at: STALE + 1 });
  });

  it("fails a stale grant once a slot-less backend's revoke answers invalid, and keeps it while unavailable", async () => {
    fakeDb.rows.set("dead", granting("dead", "abc123", STALE));
    const busy = fakeBackend({ noSlot: true, revoke: { ok: false, reason: "unavailable", detail: "busy" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, busy))).toEqual({ ended: 0, retry: 1, failedSignIns: 0 });
    expect(fakeDb.rows.get("dead")).toMatchObject({ status: "granting" });
    const refused = fakeBackend({ noSlot: true, revoke: { ok: false, reason: "invalid", detail: "aws-admin is not held" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, refused))).toEqual({ ended: 0, retry: 0, failedSignIns: 1 });
    expect(refused.revokeCapability).toHaveBeenCalledWith("abc123", "aws-admin");
    expect(fakeDb.rows.get("dead")).toMatchObject({ status: "failed", end_reason: "interrupted" });
  });

  it("leaves an interrupted grant for the next sweep when the runtime cannot answer", async () => {
    fakeDb.rows.set("dead", granting("dead", "abc123", STALE));
    const backend = fakeBackend({ clear: { ok: false, reason: "unavailable", detail: "api down" } });
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, backend))).toEqual({ ended: 0, retry: 1, failedSignIns: 0 });
    expect(fakeDb.rows.get("dead")).toMatchObject({ status: "granting" });
  });

  it("fails a sign-in whose device code expired with no process left polling it", async () => {
    const awaiting = (id: string, deviceExpiresAt: number): SessionAwsGrantRow => ({ id, session_id: "abc123", capability: "aws-ops", permission_set: "Ops", account_id: SSO.accountId, status: "awaiting-signin", verification_url: "https://x", user_code: "C", device_expires_at: deviceExpiresAt, granted_by: "operator", created_at: NOW - 700_000, granted_at: null, credentials_expire_at: null, ended_at: null, end_reason: null });
    fakeDb.rows.set("g1", awaiting("g1", NOW - 120_000));
    // Within the grace margin: the process that started it may still be polling.
    fakeDb.rows.set("g2", awaiting("g2", NOW - 10_000));
    expect(await sweepExpiredAwsGrants(deps(stubFetch([]).fn, fakeBackend()))).toEqual({ ended: 0, retry: 0, failedSignIns: 1 });
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "failed", end_reason: "expired", verification_url: null, user_code: null });
    expect(fakeDb.rows.get("g2")).toMatchObject({ status: "awaiting-signin" });
  });
});

describe("grant ends", () => {
  it("records a revoke or release on the session's active grant only for aws-* ids", async () => {
    fakeDb.rows.set("g1", { id: "g1", session_id: "abc123", capability: "aws-ops", permission_set: "Ops", account_id: SSO.accountId, status: "active", verification_url: null, user_code: null, device_expires_at: null, granted_by: "operator", created_at: NOW, granted_at: NOW, credentials_expire_at: NOW + 1, ended_at: null, end_reason: null });
    await recordAwsGrantEnd("abc123", "home-assistant", "revoked", NOW);
    expect(fakeDb.endOpenSessionAwsGrants).not.toHaveBeenCalled();
    await recordAwsGrantEnd("abc123", "aws-ops", "released", NOW);
    expect(fakeDb.rows.get("g1")).toMatchObject({ status: "ended", end_reason: "released" });
  });

  it("renders a [default] shared credentials file", () => {
    expect(renderCredentialsFile({ accessKeyId: "A", secretAccessKey: "S", sessionToken: "T" })).toBe("[default]\naws_access_key_id = A\naws_secret_access_key = S\naws_session_token = T\n");
  });
});

import crypto from "node:crypto";
import { AWS_SSO, type AwsSsoConfig } from "./config.js";
import { awsCredentialsGrantLine, awsPermissionSet, capabilityLabel, isAwsCapabilityId, isCapabilityAvailable } from "./capabilities.js";
import {
  claimSessionAwsGrantForGranting,
  endActiveSessionAwsGrant,
  endOpenSessionAwsGrants,
  failExpiredAwaitingSignInAwsGrants,
  failGrantingSessionAwsGrant,
  failSessionAwsGrant,
  getSessionAwsGrant,
  insertSessionAwsGrant,
  listExpiredActiveAwsGrants,
  listOpenSignInAwsGrantsForSession,
  listStaleGrantingAwsGrants,
  markAwsGrantForTakeBack,
  markSessionAwsGrantActive,
  restoreEndedSessionAwsGrant,
  revokeGrantingSessionAwsGrant,
  setSessionAwsGrantEndReason,
  type SessionAwsGrantRow,
} from "./db.js";
import { clearCapabilityRequest, deliverGrantNotice, recordGrant } from "./capability-requests.js";
import * as log from "./log.js";
import { recordAwsGrantSweep, recordAwsGrantSweepWarning } from "./metrics.js";
import { getSessionBackend, type ClearAwsCredentialsResult, type GrantCapabilityResult, type SessionBackend } from "./session-backend.js";
import { sleep as defaultSleep } from "./util.js";

/**
 * Operator AWS access brokered as session capabilities
 * (#clw_01M8426RTMG1TWE224NXW1V02S). When the operator approves or grants an
 * `aws-*` capability, Claws runs the IAM Identity Center device sign-in
 * itself: it registers a public OIDC client for the device-code grant only,
 * starts a device authorization and stores an `awaiting-signin` grant row
 * whose link and code the dashboard shows. Once the operator signs in, Claws
 * fetches one-hour role credentials for the capability's permission set,
 * signs the SSO session out at once, forgets the client secret, device code
 * and access token, and writes the credentials into the session Secret's
 * `aws-credentials` slot through the normal `grantCapability` path. The file
 * opens with a comment naming its grant row (`awsCredentialsGrantLine`), so
 * every take-back empties the slot only while it still holds that grant's
 * credentials. No SSO token, refresh token or credential is ever stored or
 * logged.
 *
 * A grant ends at the credentials' expiry (`sweepExpiredAwsGrants`), on the
 * operator's revoke, on the session's own release, or when the session ends;
 * each end is recorded on the row. A sign-in that expires, is declined or hits
 * any AWS error marks the row `failed` and grants nothing, leaving the agent's
 * request pending so the operator can approve again. The device code lives
 * only in the web process that started the sign-in; a row whose poll died with
 * that process (a restart or a rolling update) is failed as `expired` by the
 * controller's sweep once its device code has expired.
 */

const COMPONENT = "aws-access";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SSO_SCOPE = "sso:account:access";
const CLIENT_NAME = "claws-session-capability";
const CALL_TIMEOUT_MS = 15_000;
/** Default poll interval when StartDeviceAuthorization names none (RFC 8628). */
const DEFAULT_POLL_INTERVAL_S = 5;
/** Longest a grant runs, whatever session duration the permission set allows. */
const MAX_GRANT_MS = 60 * 60 * 1000;
/** Added to the poll interval on `slow_down` (RFC 8628). */
const SLOW_DOWN_STEP_MS = 5_000;
/** Consecutive transient CreateToken failures (network error, 5xx) a sign-in rides out before failing. */
const MAX_TRANSIENT_POLL_ERRORS = 5;
/** Grace past a device code's expiry before the sweep fails a sign-in no process finished. */
const AWAITING_SIGNIN_SWEEP_MARGIN_MS = 60_000;
/**
 * Retries of a grant write the runtime answered `unavailable` (another
 * operation held the session's lock, or one Kubernetes call failed), 1 s, 2 s
 * and 4 s apart, so a brief blip never throws away a finished sign-in.
 */
const GRANT_WRITE_RETRIES = 3;
/**
 * A `granting` or `revoking` row claimed this long ago is the sweep's to take
 * back. It sits well past the slowest grant write: each of its
 * `1 + GRANT_WRITE_RETRIES` attempts is a handful of Kubernetes calls, each
 * capped at the client's 15 s request timeout, plus the pod's few-second
 * delivery wait. The write is not raced against a timeout of its own, since an
 * abandoned write could still land after its take-back.
 */
const STALE_GRANTING_MS = 10 * 60_000;

/** How often the controller ends expired grants. */
export const AWS_GRANT_SWEEP_MS = 30_000;

/** End reasons recorded on a grant row. */
export type AwsGrantEndReason = "expired" | "revoked" | "released" | "session-ended" | "replaced" | "relaunched";

export interface AwsAccessDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  backend: () => SessionBackend;
  newId: () => string;
  config: () => AwsSsoConfig | null;
}

const defaultDeps: AwsAccessDeps = {
  fetch: (input, init) => fetch(input, init),
  now: Date.now,
  sleep: defaultSleep,
  backend: getSessionBackend,
  newId: () => `awsg_${crypto.randomBytes(12).toString("hex")}`,
  config: () => AWS_SSO,
};

function withDefaults(deps: Partial<AwsAccessDeps>): AwsAccessDeps {
  return { ...defaultDeps, ...deps };
}

/** An AWS API answer that was not a success, with AWS's error code when it gave one. */
export class AwsCallError extends Error {
  constructor(readonly op: string, readonly status: number, readonly code: string | null, message: string) {
    super(message);
    this.name = "AwsCallError";
  }
}

/**
 * One unsigned HTTPS call to an Identity Center endpoint, logged with its
 * operation, target host, status and `duration_ms`. Never logs a body, a
 * header or a query string: they carry codes and tokens.
 */
async function awsCall(
  deps: AwsAccessDeps,
  op: string,
  url: string,
  init: { method: "GET" | "POST"; body?: unknown; bearer?: string },
  quiet = false,
): Promise<Record<string, unknown>> {
  const target = new URL(url).host;
  const started = performance.now();
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.bearer) headers["x-amz-sso_bearer_token"] = init.bearer;
  let status = 0;
  let parsed: Record<string, unknown> = {};
  try {
    const res = await deps.fetch(url, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    if (text.trim()) {
      try {
        const v = JSON.parse(text) as unknown;
        if (v && typeof v === "object") parsed = v as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }
  } catch (err) {
    const duration_ms = Math.round(performance.now() - started);
    log.warn("AWS call failed", { component: COMPONENT, op, target, duration_ms, outcome: "network-error", error: err instanceof Error ? err.message : String(err) });
    throw new AwsCallError(op, 0, null, `${op} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const duration_ms = Math.round(performance.now() - started);
  const ok = status >= 200 && status < 300;
  const code = ok ? null : typeof parsed["error"] === "string" ? parsed["error"] : typeof parsed["__type"] === "string" ? parsed["__type"] : null;
  const fields = { component: COMPONENT, op, target, status, duration_ms, ...(code ? { error_code: code } : {}) };
  if (quiet) log.debug("AWS call", fields);
  else if (ok) log.info("AWS call", fields);
  else log.warn("AWS call failed", fields);
  if (!ok) {
    const detail = typeof parsed["error_description"] === "string" ? parsed["error_description"] : typeof parsed["message"] === "string" ? parsed["message"] : `HTTP ${status}`;
    throw new AwsCallError(op, status, code, `${op} failed: ${code ?? `HTTP ${status}`} (${detail})`);
  }
  return parsed;
}

const oidcUrl = (region: string, path: string) => `https://oidc.${region}.amazonaws.com${path}`;
const portalUrl = (region: string, path: string) => `https://portal.sso.${region}.amazonaws.com${path}`;

function str(v: unknown, field: string, op: string): string {
  if (typeof v !== "string" || !v) throw new AwsCallError(op, 200, null, `${op} answered without ${field}`);
  return v;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : fallback;
}

interface OidcClient {
  clientId: string;
  clientSecret: string;
}

/** RegisterClient: a public client for the device-code grant only, scope `sso:account:access`. */
export async function registerClient(deps: AwsAccessDeps, sso: AwsSsoConfig): Promise<OidcClient> {
  const res = await awsCall(deps, "RegisterClient", oidcUrl(sso.region, "/client/register"), {
    method: "POST",
    body: { clientName: CLIENT_NAME, clientType: "public", grantTypes: [DEVICE_GRANT_TYPE], scopes: [SSO_SCOPE] },
  });
  return { clientId: str(res["clientId"], "clientId", "RegisterClient"), clientSecret: str(res["clientSecret"], "clientSecret", "RegisterClient") };
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInS: number;
  intervalS: number;
}

/** StartDeviceAuthorization for the configured start URL. */
export async function startDeviceAuthorization(deps: AwsAccessDeps, sso: AwsSsoConfig, client: OidcClient): Promise<DeviceAuthorization> {
  const res = await awsCall(deps, "StartDeviceAuthorization", oidcUrl(sso.region, "/device_authorization"), {
    method: "POST",
    body: { clientId: client.clientId, clientSecret: client.clientSecret, startUrl: sso.startUrl },
  });
  const userCode = str(res["userCode"], "userCode", "StartDeviceAuthorization");
  const complete = typeof res["verificationUriComplete"] === "string" && res["verificationUriComplete"] ? res["verificationUriComplete"] : null;
  return {
    deviceCode: str(res["deviceCode"], "deviceCode", "StartDeviceAuthorization"),
    userCode,
    verificationUrl: complete ?? str(res["verificationUri"], "verificationUri", "StartDeviceAuthorization"),
    expiresInS: num(res["expiresIn"], 600),
    intervalS: num(res["interval"], DEFAULT_POLL_INTERVAL_S),
  };
}

/**
 * One CreateToken poll: the access token once the operator has signed in, or
 * the pending/slow-down/terminal error code, with `transient` set for a
 * network error or a 5xx. A `refreshToken` in the answer is discarded unread.
 */
export async function createToken(
  deps: AwsAccessDeps,
  sso: AwsSsoConfig,
  client: OidcClient,
  deviceCode: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; code: string; message: string; transient: boolean }> {
  try {
    const res = await awsCall(deps, "CreateToken", oidcUrl(sso.region, "/token"), {
      method: "POST",
      body: { clientId: client.clientId, clientSecret: client.clientSecret, grantType: DEVICE_GRANT_TYPE, deviceCode },
    }, true);
    return { ok: true, accessToken: str(res["accessToken"], "accessToken", "CreateToken") };
  } catch (err) {
    if (err instanceof AwsCallError) {
      return { ok: false, code: err.code ?? (err.status === 0 ? "network-error" : `http-${err.status}`), message: err.message, transient: err.status === 0 || err.status >= 500 };
    }
    throw err;
  }
}

interface RoleCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** Expiry, ms since the epoch. */
  expiration: number;
}

/** GetRoleCredentials for `permissionSet` (the Identity Center role name) in the configured account. */
export async function getRoleCredentials(deps: AwsAccessDeps, sso: AwsSsoConfig, accessToken: string, permissionSet: string): Promise<RoleCredentials> {
  const q = new URLSearchParams({ account_id: sso.accountId, role_name: permissionSet });
  const res = await awsCall(deps, "GetRoleCredentials", portalUrl(sso.region, `/federation/credentials?${q.toString()}`), { method: "GET", bearer: accessToken });
  const rc = res["roleCredentials"];
  if (!rc || typeof rc !== "object") throw new AwsCallError("GetRoleCredentials", 200, null, "GetRoleCredentials answered without roleCredentials");
  const c = rc as Record<string, unknown>;
  return {
    accessKeyId: str(c["accessKeyId"], "accessKeyId", "GetRoleCredentials"),
    secretAccessKey: str(c["secretAccessKey"], "secretAccessKey", "GetRoleCredentials"),
    sessionToken: str(c["sessionToken"], "sessionToken", "GetRoleCredentials"),
    expiration: num(c["expiration"], 0),
  };
}

/** Logout: ends the SSO session the access token belongs to. */
export async function logout(deps: AwsAccessDeps, sso: AwsSsoConfig, accessToken: string): Promise<void> {
  await awsCall(deps, "Logout", portalUrl(sso.region, "/logout"), { method: "POST", bearer: accessToken });
}

/** The `[default]` shared credentials file written into the session's slot. */
export function renderCredentialsFile(creds: Pick<RoleCredentials, "accessKeyId" | "secretAccessKey" | "sessionToken">): string {
  return [
    "[default]",
    `aws_access_key_id = ${creds.accessKeyId}`,
    `aws_secret_access_key = ${creds.secretAccessKey}`,
    `aws_session_token = ${creds.sessionToken}`,
    "",
  ].join("\n");
}

// ── Sign-in flow ──

/**
 * Sign-ins this process is polling, by grant id. `cancelled` only stops the
 * poll at its next turn, before the row is claimed as `granting`; after the
 * claim the row's status is the guard (a cancel makes the `granting` row
 * `revoking`, so `markSessionAwsGrantActive` finds its claim lost and the
 * write is taken back, by this process or else by the sweep).
 */
const inflight = new Map<string, { cancelled: boolean; done: Promise<void> }>();

export type StartSignInResult =
  | { ok: true; grantId: string; verificationUrl: string; userCode: string; expiresAt: number }
  | { ok: false; reason: "unconfigured" | "invalid" | "not-found" | "unavailable" | "aws-error"; detail: string };

/**
 * Begin the device sign-in for an approved `aws-*` capability: register the
 * client, start the device authorization, store an `awaiting-signin` row and
 * return the link and code for the operator. The rest (polling, credentials,
 * sign-out and the grant itself) runs in the background in this process. Once
 * the new row is stored, any earlier sign-in still awaiting for the session is
 * failed as `superseded`; a start that fails leaves the earlier one in place.
 */
export async function startSignIn(
  sessionId: string,
  capId: string,
  grantedBy: string,
  partial: Partial<AwsAccessDeps> = {},
): Promise<StartSignInResult> {
  const deps = withDefaults(partial);
  const sso = deps.config();
  const permissionSet = awsPermissionSet(capId);
  if (!permissionSet) return { ok: false, reason: "invalid", detail: `${capId} is not an AWS capability` };
  if (!sso || !isCapabilityAvailable(capId)) return { ok: false, reason: "unconfigured", detail: "AWS access is not configured (CLAWS_AWS_SSO_START_URL, CLAWS_AWS_SSO_REGION, CLAWS_AWS_ACCOUNT_ID)" };
  const backend = deps.backend();
  const live = await backend.getLive(sessionId);
  if (!live.ok) return { ok: false, reason: live.reason, detail: live.detail ?? "Session not found" };
  if (!live.session.alive) return { ok: false, reason: "not-found", detail: "Session not found" };
  if (backend.awsCredentialsSlot) {
    const slot = await backend.awsCredentialsSlot(sessionId);
    if (!slot.ok) return { ok: false, reason: slot.reason, detail: slot.detail ?? "Session not found" };
    if (!slot.present) {
      return { ok: false, reason: "invalid", detail: "this session's pod was started before it could hold AWS credentials — resume this session first" };
    }
  }

  let client: OidcClient;
  let device: DeviceAuthorization;
  try {
    client = await registerClient(deps, sso);
    device = await startDeviceAuthorization(deps, sso, client);
  } catch (err) {
    log.warn("AWS sign-in could not start", { component: COMPONENT, session: sessionId, capability: capId, outcome: "failed", error: err instanceof Error ? err.message : String(err) });
    return { ok: false, reason: "aws-error", detail: err instanceof Error ? err.message : String(err) };
  }

  const createdAt = deps.now();
  const expiresAt = createdAt + device.expiresInS * 1000;
  const grant: SessionAwsGrantRow = {
    id: deps.newId(),
    session_id: sessionId,
    capability: capId,
    permission_set: permissionSet,
    account_id: sso.accountId,
    status: "awaiting-signin",
    verification_url: device.verificationUrl,
    user_code: device.userCode,
    device_expires_at: expiresAt,
    granted_by: grantedBy,
    created_at: createdAt,
    granted_at: null,
    credentials_expire_at: null,
    ended_at: null,
    end_reason: null,
  };
  try {
    await insertSessionAwsGrant(grant);
  } catch (err) {
    log.warn("Could not store the AWS sign-in", { component: COMPONENT, session: sessionId, capability: capId, outcome: "failed", error: String(err) });
    return { ok: false, reason: "unavailable", detail: `database: ${err}` };
  }
  log.info("AWS sign-in started", { component: COMPONENT, session: sessionId, capability: capId, grant: grant.id, permission_set: permissionSet, granted_by: grantedBy, outcome: "awaiting-signin" });
  // One sign-in per session at a time: the newest stored (by created_at, then
  // id) wins. Every caller keeps that same row, so two approvals racing for one
  // session never cancel each other: the older one gives itself up instead.
  let newest = grant.id;
  try {
    newest = newestOpenSignIn(await listOpenSignInAwsGrantsForSession(sessionId)) ?? grant.id;
  } catch (err) {
    log.warn("Could not list the session's open AWS sign-ins", { component: COMPONENT, session: sessionId, grant: grant.id, error: String(err) });
  }
  try {
    await cancelAwsSignIns(sessionId, null, "superseded", { except: newest, now: deps.now() });
  } catch (err) {
    log.warn("Could not supersede earlier AWS sign-ins", { component: COMPONENT, session: sessionId, grant: grant.id, error: String(err) });
  }
  if (newest !== grant.id) {
    // A newer sign-in started for this session while this one was stored.
    await failRow(deps, grant, "superseded");
    return { ok: false, reason: "unavailable", detail: "a newer AWS sign-in for this session superseded this one" };
  }

  const state = { cancelled: false, done: Promise.resolve() };
  const deviceCode = device.deviceCode;
  state.done = completeSignIn(deps, sso, grant, client, deviceCode, device.intervalS, expiresAt, state)
    .catch((err: unknown) => {
      log.error("AWS sign-in crashed", err, { component: COMPONENT, session: sessionId, grant: grant.id });
      return failRow(deps, grant, "internal error");
    })
    .finally(() => inflight.delete(grant.id));
  inflight.set(grant.id, state);
  return { ok: true, grantId: grant.id, verificationUrl: device.verificationUrl, userCode: device.userCode, expiresAt };
}

/** The id of the newest of a session's open sign-ins, by `created_at` then id. */
function newestOpenSignIn(rows: SessionAwsGrantRow[]): string | null {
  let newest: SessionAwsGrantRow | null = null;
  for (const row of rows) {
    if (!newest || row.created_at > newest.created_at || (row.created_at === newest.created_at && row.id > newest.id)) newest = row;
  }
  return newest?.id ?? null;
}

/**
 * Fail the session's sign-ins still awaiting the operator, and stop those
 * mid-grant (only `capId`'s when given, never `opts.except`), with `reason`,
 * stopping any poll this process runs for them, so none of them can still
 * grant: a `granting` row becomes `revoking`, and its credentials are taken
 * back by the process writing them or else by the sweep. Returns how many it
 * ended.
 */
export async function cancelAwsSignIns(
  sessionId: string,
  capId: string | null,
  reason: string,
  opts: { except?: string; now?: number } = {},
): Promise<number> {
  let failed = 0;
  for (const row of await listOpenSignInAwsGrantsForSession(sessionId)) {
    if (row.id === opts.except || (capId !== null && row.capability !== capId)) continue;
    const running = inflight.get(row.id);
    if (running) running.cancelled = true;
    const at = opts.now ?? Date.now();
    const ok = row.status === "granting" ? await revokeGrantingSessionAwsGrant(row.id, reason, at) : await failSessionAwsGrant(row.id, reason, at);
    if (ok) {
      failed++;
      log.info("AWS sign-in ended", { component: COMPONENT, session: sessionId, capability: row.capability, grant: row.id, outcome: reason });
    }
  }
  return failed;
}

/** Wait for every background sign-in of this process to finish (tests). */
export async function settleSignInsForTests(): Promise<void> {
  await Promise.all([...inflight.values()].map((s) => s.done));
}

async function failRow(deps: AwsAccessDeps, grant: SessionAwsGrantRow, reason: string): Promise<void> {
  try {
    if (await failSessionAwsGrant(grant.id, reason, deps.now())) {
      log.info("AWS sign-in failed", { component: COMPONENT, session: grant.session_id, capability: grant.capability, grant: grant.id, outcome: "failed", reason });
    }
  } catch (err) {
    log.warn("Could not record a failed AWS sign-in", { component: COMPONENT, session: grant.session_id, grant: grant.id, error: String(err) });
  }
}

/** True while the row is still `awaiting-signin` and this poll has not been cancelled. */
async function stillAwaiting(grantId: string, state: { cancelled: boolean }): Promise<boolean> {
  if (state.cancelled) return false;
  try {
    return (await getSessionAwsGrant(grantId))?.status === "awaiting-signin";
  } catch {
    // A database blip should not end the sign-in; the next turn reads again.
    return true;
  }
}

async function completeSignIn(
  deps: AwsAccessDeps,
  sso: AwsSsoConfig,
  grant: SessionAwsGrantRow,
  clientIn: OidcClient,
  deviceCodeIn: string,
  intervalS: number,
  expiresAt: number,
  state: { cancelled: boolean },
): Promise<void> {
  // Held only in these locals and dropped as soon as they are spent.
  let client: OidcClient | null = clientIn;
  let deviceCode: string | null = deviceCodeIn;
  let accessToken: string | null = null;
  let intervalMs = intervalS * 1000;
  let transientErrors = 0;
  try {
    for (;;) {
      await deps.sleep(intervalMs);
      if (!await stillAwaiting(grant.id, state)) return;
      if (deps.now() >= expiresAt) return await failRow(deps, grant, "expired");
      const res = await createToken(deps, sso, client, deviceCode);
      if (res.ok) {
        accessToken = res.accessToken;
        break;
      }
      if (res.transient) {
        // A dropped connection or an AWS 5xx should not end a sign-in the operator may be part-way through.
        if (++transientErrors < MAX_TRANSIENT_POLL_ERRORS) {
          log.warn("AWS sign-in poll failed; retrying", { component: COMPONENT, session: grant.session_id, grant: grant.id, code: res.code });
          continue;
        }
        return await failRow(deps, grant, `aws-error: ${res.code}`);
      }
      transientErrors = 0;
      if (res.code === "authorization_pending") continue;
      if (res.code === "slow_down") {
        intervalMs += SLOW_DOWN_STEP_MS;
        continue;
      }
      if (res.code === "expired_token") return await failRow(deps, grant, "expired");
      if (res.code === "access_denied") return await failRow(deps, grant, "declined");
      return await failRow(deps, grant, `aws-error: ${res.code}`);
    }
  } finally {
    client = null;
    deviceCode = null;
  }

  let credentials: RoleCredentials | null = null;
  let credentialsError: string | null = null;
  try {
    credentials = await getRoleCredentials(deps, sso, accessToken, grant.permission_set);
  } catch (err) {
    credentialsError = err instanceof Error ? err.message : String(err);
  } finally {
    // Sign out at once, whatever GetRoleCredentials did: Claws never holds a usable SSO token past this point.
    try {
      await logout(deps, sso, accessToken);
    } catch (err) {
      log.warn("AWS sign-out failed; the SSO session lapses on its own", { component: COMPONENT, session: grant.session_id, grant: grant.id, error: err instanceof Error ? err.message : String(err) });
    }
    accessToken = null;
  }
  if (!credentials) return await failRow(deps, grant, `aws-error: ${credentialsError ?? "no credentials"}`);
  if (state.cancelled) return;
  // An expiry already past (clock skew, a mis-set session duration) would grant
  // nothing usable; a missing one (0) is capped at the hour below.
  if (credentials.expiration > 0 && credentials.expiration <= deps.now()) {
    credentials = null;
    return await failRow(deps, grant, "aws-error: credentials already expired");
  }
  // Claim the row before touching the pod: a cancel, deny or expiry sweep acts
  // only on `awaiting-signin` rows, so none can race the write once this holds.
  let claimed: boolean;
  try {
    claimed = await claimSessionAwsGrantForGranting(grant.id, deps.now());
  } catch (err) {
    log.warn("Could not claim the AWS sign-in for its grant", { component: COMPONENT, session: grant.session_id, grant: grant.id, error: err instanceof Error ? err.message : String(err) });
    return await failRow(deps, grant, "internal error");
  }
  if (!claimed) return;

  // Claws ends the grant within the hour even when the permission set's session duration is longer.
  const now = deps.now();
  const expiration = Math.min(credentials.expiration > 0 ? credentials.expiration : Infinity, now + MAX_GRANT_MS);
  // The first line names this grant, so a take-back never empties a later grant's credentials.
  let file: string | null = `${awsCredentialsGrantLine(grant.id)}\n${renderCredentialsFile(credentials)}`;
  credentials = null;
  const backend = deps.backend();
  let result: GrantCapabilityResult;
  try {
    result = await writeGrant(deps, backend, grant, file);
  } catch (err) {
    // The write may have landed: take it back before failing the row.
    return await takeBackAndFail(deps, backend, grant, "internal error", err);
  } finally {
    file = null;
  }
  if (!result.ok) {
    const detail = result.reason === "invalid" ? result.detail : `${result.reason}${result.detail ? `: ${result.detail}` : ""}`;
    // `unavailable` may leave the write in the pod (its rollback failed too); `invalid` and `not-found` wrote nothing.
    if (result.reason === "unavailable") return await takeBackAndFail(deps, backend, grant, `grant-failed: ${detail}`, detail);
    return await failGranting(deps, grant, `grant-failed: ${detail}`);
  }
  const grantedAt = deps.now();
  // The credentials are in the pod now: until the row is `active` (where the
  // expiry sweep sees it), any failure takes them back before failing the row.
  try {
    if (!await markSessionAwsGrantActive(grant.id, grantedAt, expiration)) {
      throw new Error("the granting claim was lost");
    }
  } catch (err) {
    return await takeBackAndFail(deps, backend, grant, "internal error", err);
  }
  log.info("AWS grant started", {
    component: COMPONENT,
    session: grant.session_id,
    capability: grant.capability,
    grant: grant.id,
    permission_set: grant.permission_set,
    granted_by: grant.granted_by,
    credentials_expire_at: new Date(expiration).toISOString(),
    outcome: "active",
  });
  // The session's previous aws-* grant (if any) was replaced by this one in the pod.
  try {
    for (const old of await endOpenSessionAwsGrants(grant.session_id, "replaced", grantedAt, { activeOnly: true, except: grant.id })) {
      log.info("AWS grant ended", { component: COMPONENT, session: grant.session_id, capability: old.capability, grant: old.id, outcome: "replaced" });
      if (old.capability !== grant.capability) await clearCapabilityRequest(grant.session_id, old.capability);
    }
  } catch (err) {
    // The new grant holds the slot; a replaced row left `active` just ends at its own expiry.
    log.warn("Could not end the AWS grant this one replaced", { component: COMPONENT, session: grant.session_id, grant: grant.id, error: err instanceof Error ? err.message : String(err) });
  }
  try {
    await recordGrant(grant.session_id, grant.capability, grantedAt);
  } catch (err) {
    log.warn("Could not record the AWS grant on its capability request", { component: COMPONENT, session: grant.session_id, capability: grant.capability, grant: grant.id, error: err instanceof Error ? err.message : String(err) });
  }
  try {
    await deliverGrantNotice(grant.session_id, grant.capability, result);
  } catch (err) {
    log.warn("Could not tell the agent about its AWS grant", { component: COMPONENT, session: grant.session_id, capability: grant.capability, grant: grant.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Write the credentials into the session, retrying an `unavailable` answer
 * `GRANT_WRITE_RETRIES` times (1 s, 2 s, 4 s apart, through `deps.sleep`)
 * while the row is still claimed `granting`; a lost claim stops the retries
 * with the last answer. `invalid` and `not-found` are final. A throw may mean
 * the write landed.
 */
async function writeGrant(deps: AwsAccessDeps, backend: SessionBackend, grant: SessionAwsGrantRow, file: string): Promise<GrantCapabilityResult> {
  for (let attempt = 0; ; attempt++) {
    const result = await backend.grantCapability(grant.session_id, grant.capability, { awsCredentials: file });
    if (result.ok || result.reason !== "unavailable" || attempt >= GRANT_WRITE_RETRIES) return result;
    log.warn("AWS grant write could not land; retrying", { component: COMPONENT, session: grant.session_id, grant: grant.id, attempt: attempt + 1, detail: result.detail });
    await deps.sleep(1000 * 2 ** attempt);
    if ((await getSessionAwsGrant(grant.id))?.status !== "granting") return result;
  }
}

/**
 * Empty the session's credentials slot only while it holds `row`'s
 * credentials. A backend without `clearAwsCredentials` holds no slot of its
 * own: it falls back to revoking the capability.
 */
async function clearGrantSlot(backend: SessionBackend, row: SessionAwsGrantRow): Promise<ClearAwsCredentialsResult> {
  if (backend.clearAwsCredentials) return await backend.clearAwsCredentials(row.session_id, row.id);
  const revoked = await backend.revokeCapability(row.session_id, row.capability);
  if (revoked.ok) return { ok: true, cleared: true, holder: row.id };
  if (revoked.reason === "invalid") return { ok: true, cleared: false, holder: null };
  return revoked;
}

/** True when a take-back confirmed the pod holds none of the grant's credentials. */
function takeBackConfirmed(result: ClearAwsCredentialsResult): boolean {
  return result.ok || result.reason === "not-found";
}

/** A take-back's outcome for the log. */
function takeBackOutcome(result: ClearAwsCredentialsResult): string {
  if (!result.ok) return result.reason === "not-found" ? "session-ended" : result.reason;
  return result.cleared ? "revoked" : "not-held";
}

/**
 * Take back a grant whose write may have landed in the pod but could not be
 * made `active`, then fail its row with `reason` once the take-back is
 * confirmed. An unconfirmed take-back leaves the row `revoking`, where the
 * sweep retries it. Never throws.
 */
async function takeBackAndFail(deps: AwsAccessDeps, backend: SessionBackend, grant: SessionAwsGrantRow, reason: string, cause: unknown): Promise<void> {
  let outcome: string;
  let confirmed = false;
  try {
    const cleared = await clearGrantSlot(backend, grant);
    confirmed = takeBackConfirmed(cleared);
    outcome = takeBackOutcome(cleared);
  } catch (err) {
    outcome = `revoke-error: ${err instanceof Error ? err.message : String(err)}`;
  }
  const fields = { component: COMPONENT, session: grant.session_id, capability: grant.capability, grant: grant.id, outcome, cause: cause instanceof Error ? cause.message : String(cause) };
  if (confirmed) {
    log.warn("AWS grant could not be recorded; took it back", fields);
    return await failGranting(deps, grant, reason);
  }
  log.error("AWS grant could not be recorded or taken back; the sweep retries the take-back", undefined, fields);
  try {
    // Off the dashboard's "under way" list; still where the sweep looks.
    // A row the sweep already failed (this write outlasted its stale window)
    // goes back to `revoking` too, so the credentials that landed late are
    // still taken back.
    await markAwsGrantForTakeBack(grant.id, reason, deps.now());
  } catch (err) {
    log.warn("Could not mark an AWS grant for take-back; the sweep still sees it as granting", { component: COMPONENT, session: grant.session_id, grant: grant.id, error: err instanceof Error ? err.message : String(err) });
  }
}

async function failGranting(deps: AwsAccessDeps, grant: SessionAwsGrantRow, reason: string): Promise<void> {
  try {
    if (await failGrantingSessionAwsGrant(grant.id, reason, deps.now())) {
      log.info("AWS sign-in failed", { component: COMPONENT, session: grant.session_id, capability: grant.capability, grant: grant.id, outcome: "failed", reason });
    }
  } catch (err) {
    log.warn("Could not record a failed AWS sign-in", { component: COMPONENT, session: grant.session_id, grant: grant.id, error: String(err) });
  }
}

/**
 * Record the end of a session's `aws-*` grant after the backend revoked it
 * (operator revoke, the session's release, or expiry). Never throws.
 */
export async function recordAwsGrantEnd(sessionId: string, capId: string, reason: AwsGrantEndReason, now: number = Date.now()): Promise<void> {
  if (!isAwsCapabilityId(capId)) return;
  try {
    for (const row of await endOpenSessionAwsGrants(sessionId, reason, now, { capability: capId })) {
      log.info("AWS grant ended", { component: COMPONENT, session: sessionId, capability: capId, grant: row.id, outcome: reason });
    }
  } catch (err) {
    log.warn("Could not record the end of an AWS grant", { component: COMPONENT, session: sessionId, capability: capId, error: String(err) });
  }
}

/** The one-line notice typed to the agent when its grant expired. */
export function awsExpiryNotice(capId: string, permissionSet: string): string {
  return `[Claws] Your AWS capability ${capId} (${permissionSet}) reached its one-hour limit and was revoked; its credentials no longer work. `
    + `If you still need AWS access, call claws_request_capability with capability "${capId}" again.`;
}

/**
 * End every `active` grant past its credentials' expiry and tell each agent,
 * take back grants whose process died mid-write or whose take-back was not
 * confirmed (`granting`/`revoking` rows), and fail every `awaiting-signin` row
 * whose device code expired with no process left to finish it. Each expired
 * grant is claimed by id and its credentials slot emptied only while it still
 * holds that grant's credentials, so a newer grant is never emptied with it:
 * a grant a newer one already replaced in the slot is ended as `replaced`. A
 * session that has ended just has its row closed as `session-ended`; a runtime
 * that cannot answer puts the row back for the next sweep. A row that throws
 * is logged and skipped without stopping the sweep.
 */
export async function sweepExpiredAwsGrants(partial: Partial<AwsAccessDeps> = {}): Promise<{ ended: number; retry: number; failedSignIns: number }> {
  const deps = withDefaults(partial);
  const started = performance.now();
  log.debug("AWS grant expiry sweep started", { component: COMPONENT });
  let ended = 0;
  let retry = 0;
  const expired = await listExpiredActiveAwsGrants(deps.now());
  const backend = deps.backend();
  for (const row of expired) {
    let claimed = false;
    let revokedOk = false;
    try {
      if (!await endActiveSessionAwsGrant(row.id, "expired", deps.now())) continue;
      claimed = true;
      const cleared = await clearGrantSlot(backend, row);
      if (!takeBackConfirmed(cleared)) {
        claimed = false;
        await restoreEndedSessionAwsGrant(row.id);
        retry++;
        recordAwsGrantSweepWarning("revoke_retry");
        log.warn("Could not revoke an expired AWS grant; retrying next sweep", { component: COMPONENT, session: row.session_id, capability: row.capability, grant: row.id, detail: cleared.ok ? undefined : cleared.detail });
        continue;
      }
      revokedOk = true;
      // The slot holding another grant's credentials means that grant replaced this one.
      const reason: AwsGrantEndReason = !cleared.ok ? "session-ended" : !cleared.cleared && cleared.holder ? "replaced" : "expired";
      if (reason !== "expired") await setSessionAwsGrantEndReason(row.id, reason);
      log.info("AWS grant ended", { component: COMPONENT, session: row.session_id, capability: row.capability, grant: row.id, outcome: reason });
      ended++;
      if (!cleared.ok) continue;
      if (reason === "replaced") {
        const holder = cleared.holder ? await getSessionAwsGrant(cleared.holder) : undefined;
        if (holder?.capability !== row.capability) await clearCapabilityRequest(row.session_id, row.capability);
        continue;
      }
      await clearCapabilityRequest(row.session_id, row.capability);
      const sent = await backend.notifyAgent(row.session_id, awsExpiryNotice(row.capability, row.permission_set));
      if (sent !== "ok") log.warn("Could not tell the agent its AWS grant expired", { component: COMPONENT, session: row.session_id, capability: row.capability, outcome: sent });
    } catch (err) {
      // A claimed row whose revoke never finished goes back for the next sweep.
      if (claimed && !revokedOk) {
        try {
          if (await restoreEndedSessionAwsGrant(row.id)) retry++;
        } catch { /* the next sweep cannot see it; logged below */ }
      }
      recordAwsGrantSweepWarning("end_failed");
      log.warn("Could not end an expired AWS grant", { component: COMPONENT, session: row.session_id, capability: row.capability, grant: row.id, revoked: revokedOk, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const now = deps.now();
  let failedSignIns: SessionAwsGrantRow[] = [];
  try {
    failedSignIns = await failExpiredAwaitingSignInAwsGrants(now - AWAITING_SIGNIN_SWEEP_MARGIN_MS, "expired", now);
  } catch (err) {
    log.warn("Could not fail expired AWS sign-ins", { component: COMPONENT, error: err instanceof Error ? err.message : String(err) });
  }
  for (const row of failedSignIns) {
    log.info("AWS sign-in failed", { component: COMPONENT, session: row.session_id, capability: row.capability, grant: row.id, outcome: "failed", reason: "expired" });
  }
  const staleGrants = await sweepStaleGrantingAwsGrants(deps, backend);
  retry += staleGrants.retry;
  const failedCount = failedSignIns.length + staleGrants.failed;
  recordAwsGrantSweep({ ended, retry, failedSignIns: failedCount }, deps.now());
  const fields = { component: COMPONENT, ended, retry, failed_signins: failedCount, duration_ms: Math.round(performance.now() - started) };
  if (ended > 0 || retry > 0 || failedCount > 0) log.info("AWS grant expiry sweep finished", fields);
  else log.debug("AWS grant expiry sweep finished", fields);
  return { ended, retry, failedSignIns: failedCount };
}

/**
 * Take back each `granting` row whose process died mid-grant and each
 * `revoking` row whose take-back was never confirmed (claimed more than
 * `STALE_GRANTING_MS` ago): empty the slot if it still holds the row's
 * credentials, then fail the row (`interrupted` for a `granting` row, the
 * canceller's reason for a `revoking` one). The row's write replaced any older
 * grant still recorded `active`, so emptying it ends that grant as `replaced`.
 * A take-back that cannot be confirmed leaves the row for the next sweep.
 */
async function sweepStaleGrantingAwsGrants(deps: AwsAccessDeps, backend: SessionBackend): Promise<{ failed: number; retry: number }> {
  let failed = 0;
  let retry = 0;
  let stale: SessionAwsGrantRow[] = [];
  try {
    stale = await listStaleGrantingAwsGrants(deps.now() - STALE_GRANTING_MS);
  } catch (err) {
    log.warn("Could not list interrupted AWS grants", { component: COMPONENT, error: err instanceof Error ? err.message : String(err) });
    return { failed, retry };
  }
  for (const row of stale) {
    try {
      const cleared = await clearGrantSlot(backend, row);
      if (!takeBackConfirmed(cleared)) {
        retry++;
        log.warn("Could not revoke an interrupted AWS grant; retrying next sweep", { component: COMPONENT, session: row.session_id, capability: row.capability, grant: row.id, detail: cleared.ok ? undefined : cleared.detail });
        continue;
      }
      if (cleared.ok && cleared.cleared) {
        for (const old of await endOpenSessionAwsGrants(row.session_id, "replaced", deps.now(), { activeOnly: true, except: row.id })) {
          log.info("AWS grant ended", { component: COMPONENT, session: row.session_id, capability: old.capability, grant: old.id, outcome: "replaced" });
          await clearCapabilityRequest(row.session_id, old.capability);
        }
      }
      if (await failGrantingSessionAwsGrant(row.id, "interrupted", deps.now())) {
        failed++;
        log.info("AWS sign-in failed", { component: COMPONENT, session: row.session_id, capability: row.capability, grant: row.id, outcome: "failed", reason: row.end_reason ?? "interrupted", revoke: takeBackOutcome(cleared) });
      }
    } catch (err) {
      log.warn("Could not take back an interrupted AWS grant", { component: COMPONENT, session: row.session_id, capability: row.capability, grant: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { failed, retry };
}

/** The sign-in shown on the dashboard while a row is `awaiting-signin`. */
export interface AwsSignInView {
  grantId: string;
  capability: string;
  label: string;
  permissionSet: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: number | null;
}

export function awsSignInView(row: SessionAwsGrantRow): AwsSignInView | null {
  if (row.status !== "awaiting-signin" || !row.verification_url || !row.user_code) return null;
  return {
    grantId: row.id,
    capability: row.capability,
    label: capabilityLabel(row.capability),
    permissionSet: row.permission_set,
    verificationUrl: row.verification_url,
    userCode: row.user_code,
    expiresAt: row.device_expires_at,
  };
}

/** A row of the session page's AWS grant history. */
export interface AwsGrantHistoryView {
  capability: string;
  permissionSet: string;
  status: string;
  grantedBy: string;
  grantedAt: number | null;
  createdAt: number;
  endedAt: number | null;
  credentialsExpireAt: number | null;
  reason: string | null;
}

export function awsGrantHistoryView(row: SessionAwsGrantRow): AwsGrantHistoryView {
  return {
    capability: row.capability,
    permissionSet: row.permission_set,
    status: row.status,
    grantedBy: row.granted_by,
    grantedAt: row.granted_at,
    createdAt: row.created_at,
    endedAt: row.ended_at,
    credentialsExpireAt: row.credentials_expire_at,
    reason: row.end_reason,
  };
}

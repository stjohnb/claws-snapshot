/**
 * How Claws signs in to fleet Grafana (#clw_01M7QFE3ZDE06M6JW202445NPX).
 *
 * Claws signs in as the blueprint-declared Authentik service account
 * `claws-service`, a Grafana Viewer, with a non-expiring app password sent as
 * HTTP Basic through fleet-infra's `authentik-auth-basic` ForwardAuth. The
 * credentials come from the mounted `claws-authentik-service-account` Secret
 * at `CLAWS_AUTHENTIK_CREDENTIALS_DIR` and are re-read on every call, so a
 * rotation reaches Claws without a restart. There is no other credential:
 * without the mount Claws does not sign in to Grafana at all. The header is a
 * credential: never log it. See docs/observability-access.md.
 */
import fs from "node:fs";
import path from "node:path";

export interface GrafanaServiceAccount {
  username: string;
  /** `Basic <base64(username:password)>`. */
  authorization: string;
}

/** `unconfigured`: no service-account credentials are mounted, so Claws
 *  cannot sign in to Grafana. */
export type GrafanaAuthMode = "authentik" | "unconfigured";

function readTrimmed(dir: string, name: string): string {
  try {
    return fs.readFileSync(path.join(dir, name), "utf8").trim();
  } catch {
    return "";
  }
}

/** `CLAWS_AUTHENTIK_CREDENTIALS_DIR`: env-only, set by fleet-infra to the
 *  mount of Secret `claws-authentik-service-account`. Read here rather than
 *  through config.ts so the many tests that mock config.js wholesale need no
 *  new key; `""` when unset. */
export function authentikCredentialsDir(): string {
  return (process.env["CLAWS_AUTHENTIK_CREDENTIALS_DIR"] ?? "").trim();
}

/** The `claws-service` username and Basic header, read from
 *  `CLAWS_AUTHENTIK_CREDENTIALS_DIR` on every call and trimmed; null when the
 *  variable is unset or either file is missing or empty. */
export function grafanaServiceAccount(): GrafanaServiceAccount | null {
  const dir = authentikCredentialsDir();
  if (!dir) return null;
  const username = readTrimmed(dir, "username");
  const password = readTrimmed(dir, "app-password");
  if (!username || !password) return null;
  return { username, authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

/** Which credential {@link grafanaAuthorization} sends right now. */
export function grafanaAuthMode(): GrafanaAuthMode {
  return grafanaServiceAccount() ? "authentik" : "unconfigured";
}

/** The `Authorization` header value for fleet Grafana: the service account's
 *  Basic header, or null when its credentials are not mounted. */
export function grafanaAuthorization(): string | null {
  return grafanaServiceAccount()?.authorization ?? null;
}

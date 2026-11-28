/**
 * How an AWS sign-in's link and time left are shown
 * (#clw_01M8426RTMG1TWE224NXW1V02S). A dependency-free leaf:
 * `client/lib/aws-signin.ts` imports it and esbuild inlines it into the
 * session-page bundle, while `pages/sessions.ts` renders the Sessions list
 * with it, so the server-rendered block and the client-refreshed one accept
 * the same links and count down the same way.
 */

/** "N min left" for `expiresAt`, "expired" once it has passed, or "" without one. */
export function signInMinutesLeft(expiresAt: number | null, now: number = Date.now()): string {
  if (expiresAt === null || !Number.isFinite(expiresAt)) return "";
  if (expiresAt <= now) return "expired";
  const minutes = Math.ceil((expiresAt - now) / 60_000);
  return minutes <= 1 ? "under a minute left" : minutes + " min left";
}

/** The link to open, or null for anything but an https URL. */
export function safeSignInUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

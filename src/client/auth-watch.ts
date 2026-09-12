// Detects a stale dashboard session (expired `claws_session` cookie) on a page
// restored from the back/forward cache, a suspended mobile tab, or a PWA resume,
// and recovers by re-running the OIDC login flow for the same URL (#2479).
// Injected on every page by buildPageHeader (src/pages/layout.ts) next to
// ERROR_HANDLER_SCRIPT. Wire format must match GET /api/auth/status in
// src/server.ts.
(() => {
  const PROBE_PATH = "/api/auth/status";
  const RECOVERY_KEY = "claws.authRecoveryAt";
  const RECOVERY_COOLDOWN_MS = 30000;
  const CHECK_THROTTLE_MS = 3000;

  const originalFetch = window.fetch.bind(window);
  let recovering = false;
  let dirty = false;
  let lastCheckAt = 0;
  let expiryTimer = 0;

  // Any typed-but-unsaved input (e.g. the /config form) must never be thrown
  // away by an automatic navigation.
  document.addEventListener("input", () => { dirty = true; }, true);

  function loginUrl(): string {
    return "/login?next=" + encodeURIComponent(location.pathname + location.search);
  }

  function banner(text: string, href: string | null): void {
    const host = document.body || document.documentElement;
    let el = document.getElementById("claws-auth-banner");
    if (!el) {
      el = document.createElement("div");
      el.id = "claws-auth-banner";
      el.setAttribute("role", "status");
      el.style.cssText =
        "position:fixed;left:0;right:0;top:0;z-index:9999;padding:0.6rem 1rem;text-align:center;" +
        "font-family:var(--font-body,ui-sans-serif,sans-serif);font-size:0.9rem;" +
        "background:var(--warn-banner-bg,#2b2114);border-bottom:1px solid var(--warn-banner-border,#e0a44a);" +
        "color:var(--warning,#e0a44a)";
      host.appendChild(el);
    }
    el.textContent = text; // also clears any previously appended link
    if (href) {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = "Sign in again";
      a.style.cssText = "margin-left:0.5rem;color:var(--accent,#ff8a3d)";
      el.appendChild(a);
    }
  }

  function recentlyRecovered(): boolean {
    try {
      const raw = window.sessionStorage.getItem(RECOVERY_KEY);
      return !!raw && Date.now() - parseInt(raw, 10) < RECOVERY_COOLDOWN_MS;
    } catch { return false; }
  }

  function recover(): void {
    if (recovering) return;
    const url = loginUrl();
    // Two cases where an automatic navigation is the wrong move: unsaved input,
    // and a session that is still rejected right after a recovery attempt
    // (bouncing through the IdP in a loop). Offer a manual link instead.
    if (dirty || recentlyRecovered()) {
      banner("Your claws session expired — this page is out of date until you sign in again.", url);
      return;
    }
    recovering = true;
    banner("Session expired — signing you back in…", null);
    try { window.sessionStorage.setItem(RECOVERY_KEY, String(Date.now())); } catch { /* private mode */ }
    location.replace(url); // replace, not assign: the dead page must leave history
  }

  function scheduleExpiryCheck(expiresAt: number | null): void {
    if (expiryTimer) { clearTimeout(expiryTimer); expiryTimer = 0; }
    if (!expiresAt) return;
    const delay = expiresAt - Date.now() + 1000;
    if (delay <= 0 || delay > 25 * 60 * 60 * 1000) return;
    expiryTimer = window.setTimeout(() => { expiryTimer = 0; void check(); }, delay);
  }

  async function check(): Promise<void> {
    const now = Date.now();
    if (recovering || now - lastCheckAt < CHECK_THROTTLE_MS) return;
    lastCheckAt = now;
    let data: { authenticated?: boolean; oidcEnabled?: boolean; expiresAt?: number | null };
    try {
      const res = await originalFetch(PROBE_PATH, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) return; // server trouble, not a stale session
      data = (await res.json()) as typeof data;
    } catch {
      return; // offline or claws down — nothing /login can fix
    }
    if (data.oidcEnabled === false) return; // fail-closed mode; /login returns 503
    if (data.authenticated === false) { recover(); return; }
    scheduleExpiryCheck(typeof data.expiresAt === "number" ? data.expiresAt : null);
  }

  function sameOriginNonProbe(input: RequestInfo | URL): boolean {
    try {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const u = new URL(raw, location.href);
      return u.origin === location.origin && u.pathname !== PROBE_PATH;
    } catch { return false; }
  }

  // Every same-origin 401 means the cookie lapsed: authMiddleware answers with
  // an HTML meta-refresh body that page pollers silently discard.
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const res = await originalFetch(input as RequestInfo, init);
    try {
      if (res.status === 401 && sameOriginNonProbe(input)) recover();
    } catch { /* never break the caller's fetch */ }
    return res;
  };

  window.clawsAuthCheck = () => { void check(); };

  window.addEventListener("pageshow", (e: PageTransitionEvent) => { if (e.persisted) void check(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void check();
  });
  window.addEventListener("online", () => { void check(); });

  // One probe on load arms the expiry timer (and catches a history restore that
  // was served from the HTTP cache without a server round trip).
  void check();
})();

/** Web tier → controller proxy: the routes the web tier forwards to `CLAWS_CONTROLLER_URL` and the forwarding helper. */
import { bodyLimit } from "hono/body-limit";
import { COMPLETION_DEADLINE_MS, MAX_COMPLETION_BODY_BYTES } from "../completion-api.js";
import * as log from "../log.js";
import { type Ctx, htmlError, jsonOk } from "./http.js";

// ── Web tier → controller proxy (#clw_01M5APX7YF3AGWHV1S1WMHJDR6) ──
// The CLI login ptys and the WhatsApp gateway live in the controller, so on
// the web tier these routes are forwarded to it with the caller's cookies and
// body; the controller verifies the signed `claws_session` cookie itself.

/** Route patterns the web tier forwards to `CLAWS_CONTROLLER_URL`. */
export const CONTROLLER_PROXIED_ROUTES = ["/whatsapp", "/whatsapp/*", "/api/claude-auth/*", "/api/codex-auth/*", "/api/pi-auth/*"] as const;
export const CONTROLLER_RESTARTING_MESSAGE = "Background processing is restarting";
/**
 * Longest the proxy waits for the controller's response headers; the body (an
 * SSE stream) may then run on. It outlasts the slowest proxied handler — a
 * Claude login code submission waits up to 60 s on the CLI pty — so a slow
 * answer is never mistaken for a restarting controller. Connection failures
 * (refused, unresolvable, connect timeout) fail fast and answer 503.
 */
export const PROXY_HEADERS_TIMEOUT_MS = 90_000;
const PROXY_REQUEST_HEADERS = ["cookie", "content-type", "accept", "accept-language", "user-agent", "x-requested-with", "last-event-id"];
// Hop-by-hop, plus what fetch() already undid (it decompresses the body).
const PROXY_DROPPED_RESPONSE_HEADERS = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);

function controllerUnavailable(c: Ctx): Response {
  const detail = "pages stay available; try again once it is back.";
  if (c.req.path.startsWith("/api/")) return jsonOk(c, { error: CONTROLLER_RESTARTING_MESSAGE, detail }, 503);
  return htmlError(c, 503, CONTROLLER_RESTARTING_MESSAGE, `${CONTROLLER_RESTARTING_MESSAGE} — ${detail}`, {
    actions: [{ href: "/", label: "← Dashboard" }],
  });
}

/** Route the web tier forwards to the controller with its `Authorization` header — the caller's completion token. */
export const COMPLETION_PROXIED_ROUTE = "/api/completion/:owner/:name";
/** The completion route's proxy headers timeout: it outlasts the controller's own request deadline. */
export const COMPLETION_PROXY_HEADERS_TIMEOUT_MS = COMPLETION_DEADLINE_MS + 5_000;

/** The only request headers the completion proxy forwards: no session cookie reaches the controller. */
export const COMPLETION_PROXY_HEADERS = ["content-type", "accept", "authorization"] as const;

/** The completion body cap, shared by the web tier's proxy and the controller's handler so the two cannot drift. */
export const completionBodyLimit = bodyLimit({
  maxSize: MAX_COMPLETION_BODY_BYTES,
  onError: (c) => {
    c.header("Content-Type", "application/json");
    return c.body(JSON.stringify({ error: `Request body too large (max ${MAX_COMPLETION_BODY_BYTES / 1024} KiB)` }), 413);
  },
});

export async function proxyToController(
  c: Ctx,
  controllerUrl: string,
  headersTimeoutMs: number,
  /** Forward only these request headers instead of PROXY_REQUEST_HEADERS. */
  opts: { headers?: readonly string[] } = {},
): Promise<Response> {
  const url = new URL(c.req.url);
  const headers = new Headers();
  for (const name of opts.headers ?? PROXY_REQUEST_HEADERS) {
    const value = c.req.header(name);
    if (value) headers.set(name, value);
  }
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (host) headers.set("x-forwarded-host", host);
  const proto = c.req.header("x-forwarded-proto");
  if (proto) headers.set("x-forwarded-proto", proto);
  const method = c.req.method;
  const body = method === "GET" || method === "HEAD" ? undefined : await c.req.arrayBuffer();

  const abort = new AbortController();
  const onClientGone = () => abort.abort();
  c.req.raw.signal?.addEventListener("abort", onClientGone, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
  }, headersTimeoutMs);
  let res: Response;
  try {
    res = await fetch(`${controllerUrl}${url.pathname}${url.search}`, { method, headers, body, redirect: "manual", signal: abort.signal });
  } catch (err) {
    c.req.raw.signal?.removeEventListener("abort", onClientGone);
    if (timedOut) {
      // The controller accepted the request and is still working on it, so it
      // is up: not "restarting".
      const error = "The background controller did not answer in time";
      log.warn(`[web] The controller did not answer ${method} ${url.pathname} within ${headersTimeoutMs} ms`);
      if (c.req.path.startsWith("/api/")) return jsonOk(c, { error }, 504);
      return htmlError(c, 504, error, error, { actions: [{ href: "/", label: "← Dashboard" }] });
    }
    log.warn(`[web] Proxying ${method} ${url.pathname} to the controller failed: ${err}`);
    return controllerUnavailable(c);
  } finally {
    clearTimeout(timer);
  }
  const out = new Headers();
  for (const [name, value] of res.headers) {
    if (!PROXY_DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) out.append(name, value);
  }
  for (const cookie of res.headers.getSetCookie()) out.append("set-cookie", cookie);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
}

/** Dashboard server HTTP plumbing: the Hono `Env`/`Ctx` types, request body readers and response helpers. */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HttpBindings } from "@hono/node-server";
import * as log from "../log.js";
import { describeCreateSessionError } from "../sessions.js";
import { getSessionBackend, type SessionUploadResult } from "../session-backend.js";
import { buildErrorPage, type ErrorPageAction } from "../pages/error-page.js";
import type { SaveUploadResult } from "../session-uploads-core.js";
import { shutdownElapsedMs } from "../shutdown.js";
import { findPendingSessionAttachments } from "../session-attachments.js";
import { parseCookies, sessionSubject } from "./auth.js";

export type Env = { Bindings: HttpBindings };
export type Ctx = Context<Env>;

export function parseFormBody(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(pair.slice(0, eq));
      const value = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " "));
      params[key] = value;
    } catch {
      continue;
    }
  }
  return params;
}

/** Parse all values for a repeated form key (parseFormBody keeps only the last). */
export function parseFormBodyMulti(body: string, key: string): string[] {
  const out: string[] = [];
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    try {
      const k = decodeURIComponent(pair.slice(0, eq));
      if (k !== key) continue;
      out.push(decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, " ")));
    } catch {
      continue;
    }
  }
  return out;
}

export function getTheme(c: Ctx): "dark" | "light" | "system" {
  const cookies = parseCookies(c.req.header("cookie"));
  const value = cookies["claws_theme"];
  if (value === "dark" || value === "light") return value;
  return "system";
}

export async function readTextBody(c: Ctx, maxBytes = 1024 * 1024): Promise<string> {
  const contentLength = c.req.header("content-length");
  if (contentLength && parseInt(contentLength, 10) > maxBytes) {
    throw new Error("Request body too large");
  }
  const rawBody = c.req.raw.body;
  if (!rawBody) return "";
  const reader = rawBody.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel();
      throw new Error("Request body too large");
    }
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

// ── Response helpers (exact Content-Type without charset suffix to match legacy) ──

export function htmlOk(c: Ctx, body: string, status = 200) {
  c.header("Content-Type", "text/html");
  return c.body(body, status as ContentfulStatusCode);
}

export function jsonOk(c: Ctx, obj: unknown, status = 200) {
  c.header("Content-Type", "application/json");
  return c.body(JSON.stringify(obj), status as ContentfulStatusCode);
}

/** The ids a refused board action names in its log line; any may be unknown. */
export type BoardRefusalIds = { repo?: string; issue?: string; prRepo?: string; prNumber?: number };

/**
 * Answer a refused or failed board card action, and log it: one line, constant
 * `msg`, ids in fields, so a refused click can be found in Loki
 * (docs/observability.md). `info` for a 4xx, `warn` for a 5xx.
 */
export function boardRefusal(c: Ctx, route: string, status: number, body: { error: string } & Record<string, unknown>, ids: BoardRefusalIds) {
  const fields: Record<string, unknown> = { component: "board", route, status, reason: body.error, by: sessionSubject(c as Context<Env>) };
  if (ids.repo !== undefined) fields["repo"] = ids.repo;
  if (ids.issue !== undefined) fields["issue"] = ids.issue;
  if (ids.prRepo !== undefined) fields["pr_repo"] = ids.prRepo;
  if (ids.prNumber !== undefined) fields["pr_number"] = ids.prNumber;
  if (status >= 500) log.warn("board action refused", fields);
  else log.info("board action refused", fields);
  return jsonOk(c, body, status);
}

export function textPlain(c: Ctx, body: string, status = 200) {
  c.header("Content-Type", "text/plain");
  return c.body(body, status as ContentfulStatusCode);
}

export function htmlError(
  c: Ctx,
  status: number,
  heading: string,
  message: string,
  extra: { detail?: string; actions?: ErrorPageAction[] } = {},
) {
  c.header("Content-Type", "text/html");
  return c.body(
    buildErrorPage(getTheme(c), { status, heading, message, ...extra }),
    status as ContentfulStatusCode,
  );
}

export function shutdownRetryError(c: Ctx, heading: string, action: string, fields: Array<{ name: string; value: string }>) {
  c.header("Content-Type", "text/html");
  c.header("Cache-Control", "no-store");
  return c.body(buildErrorPage(getTheme(c), {
    status: 503,
    heading,
    message: "Claws is restarting — normally an auto-update deploy. It can't start new sessions until the restart finishes; shutdown waits up to 5 minutes for running jobs to drain.",
    actions: [{ href: "/sessions", label: "← Sessions" }],
    retry: { action, fields, elapsedMs: shutdownElapsedMs() },
  }), 503 as ContentfulStatusCode);
}

export function describeUploadError(result: Extract<SaveUploadResult, { ok: false }>, maxLabel: string): string {
  switch (result.reason) {
    case "too-large": return `File too large (max ${maxLabel})`;
    case "write-failed": return "Failed to save upload";
  }
}

/** JSON error response for a failed session upload: 404 / 409 / 503 from the backend, else the storage failure. */
export function uploadErrorResponse(c: Ctx, result: Extract<SessionUploadResult, { ok: false }>, maxLabel: string): Response {
  switch (result.reason) {
    case "not-found": return jsonOk(c, { error: "Session not found" }, 404);
    case "not-running": return jsonOk(c, { error: "Session is not running" }, 409);
    case "unavailable": return jsonOk(c, { error: "Session runtime unavailable" }, 503);
  }
  const status = result.reason === "too-large" ? 413 : 500;
  return jsonOk(c, { error: describeUploadError(result, maxLabel) }, status);
}

/** Pre-body liveness check for the upload routes: a response to return, or null when the session can take an upload. */
export async function checkUploadTarget(c: Ctx, id: string): Promise<Response | null> {
  const live = await getSessionBackend().getLive(id);
  if (!live.ok) return uploadErrorResponse(c, live, "");
  if (!live.session.alive) return uploadErrorResponse(c, { ok: false, reason: "not-running" }, "");
  return null;
}

/**
 * The error page for a create naming a staged attachment that is unknown or
 * already claimed (swept, removed, or used by another session), or null when
 * every id names a pending file.
 */
export async function checkSessionAttachments(c: Ctx, ids: string[]): Promise<Response | null> {
  if (ids.length === 0) return null;
  let pending: Awaited<ReturnType<typeof findPendingSessionAttachments>>;
  try {
    pending = await findPendingSessionAttachments(ids);
  } catch (err) {
    return htmlError(c, 503, "Cannot create session", `Could not read the attached files: ${err instanceof Error ? err.message : String(err)}`, {
      actions: [{ href: "/sessions", label: "← Sessions" }],
    });
  }
  if (pending) return null;
  return htmlError(c, 400, "Cannot create session", describeCreateSessionError({ reason: "attachment-unavailable" }), {
    actions: [{ href: "/sessions", label: "← Sessions" }],
  });
}

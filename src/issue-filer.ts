/**
 * The issue-filer API: `/api/issue-filer/:owner/:name/issues`, `…/issues/:id`
 * and `…/issues/:id/attachments` (docs/issue-tracker.md "Issue filers").
 *
 * An external service — growth-engine's site visits first — files one native
 * issue per site review run here, holding every finding from the run, keyed by
 * a dedupe key it chooses, and attaches the run's screenshots to it. The issue
 * is held in Drafting for the owner, and is planned from its text once promoted. production-infra's recurring
 * scans keep one report issue per key, rewriting its body each run and
 * closing it on a clean one.
 *
 * Auth mirrors the alert bridge's: a per-repo bearer token whose SHA-256 the
 * filing repo commits as `claws.json`'s `issueFiler.tokenSha256`. It is scoped
 * twice: the token only matches its own repo's path, and every route only
 * reads or writes native issues whose primary repo is that repo and whose
 * dedupe key starts with the configured `dedupeKeyPrefix`.
 */
import crypto from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import * as config from "./config.js";
import * as gh from "./github.js";
import type * as db from "./db.js";
import * as clawsIssues from "./claws-issues.js";
import * as log from "./log.js";
import { safeCompare } from "./internal-mcp-token.js";
import { withIssueActor, type IssueActor } from "./issue-history-actor.js";
import { forceRefreshRepoConfig, getRepoConfig, listRepoConfigs, type RepoIssueFiler } from "./repo-config.js";
import { DEDUPE_KEY_PATTERN, serialiseIssueCreate } from "./issue-create-lock.js";
import { attachmentUrl, storeIssueAttachment } from "./issue-attachments.js";

const NAME = "issue-filer";

/** How a write over a filer token reads in the issue's History. */
const ISSUE_FILER_ACTOR: IssueActor = { kind: "automation", name: "issue filer" };

export const MAX_TITLE_LENGTH = 256;
export const MAX_BODY_LENGTH = 65_536;
export const MAX_ATTACHMENT_NAME_LENGTH = 200;
/** A screenshot, not an archive. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Filer extends RepoIssueFiler {
  /** The repo's full name in its configured casing — what native issues record. */
  repo: string;
}

/** The path's repo and its `issueFiler` entry, or null when it has none. */
function filerFor(c: Context): Filer | null {
  const wanted = `${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`;
  const issueFiler = getRepoConfig(wanted)?.issueFiler;
  if (!issueFiler) return null;
  const repo = listRepoConfigs().find((r) => r.fullName.toLowerCase() === wanted.toLowerCase())?.fullName ?? wanted;
  return { ...issueFiler, repo };
}

/**
 * Admit only the bearer token whose SHA-256 is the path repo's
 * `issueFiler.tokenSha256`. Never `apiAuthMiddleware`'s tokens or an operator
 * session: they get a 401 here, and this token gets one everywhere else.
 */
export const issueFilerAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  let filer = filerFor(c);
  if (!filer || !safeCompare(hash, filer.tokenSha256)) {
    // The cached claws.json may predate a merged rotation or first opt-in:
    // re-read it (rate-limited per repo) before refusing.
    const wanted = `${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`;
    if (!(await forceRefreshRepoConfig(wanted, gh.fetchRepoFileContent))) return c.json({ error: "unauthorized" }, 401);
    filer = filerFor(c);
    if (!filer || !safeCompare(hash, filer.tokenSha256)) return c.json({ error: "unauthorized" }, 401);
    log.info(`[${NAME}] ${filer.repo}: re-read claws.json after a token mismatch; the new token is accepted`);
  }
  return withIssueActor(ISSUE_FILER_ACTOR, next);
};

/** The normalised key when it is well-formed and carries the filer's prefix, else an error message. */
function parseDedupeKey(filer: Filer, raw: unknown): { key: string } | { error: string } {
  const key = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!DEDUPE_KEY_PATTERN.test(key) || !key.startsWith(filer.dedupeKeyPrefix)) {
    return { error: `dedupeKey must start with ${filer.dedupeKeyPrefix} and be 2-100 characters of a-z, 0-9, '.', '_' or '-'` };
  }
  return { key };
}

function issueJson(record: Pick<db.ClawsIssueRecord, "id">): { id: string; ref: string; url: string } {
  return { id: record.id, ref: `#${record.id}`, url: clawsIssues.dashboardIssueUrl(record.id) };
}

async function readJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * `POST …/issues` with `{ title, body?, dedupeKey }`: file an issue in the
 * path repo, or return the open one already holding `dedupeKey` there. Dedupes
 * by key alone, never by title similarity. A new issue is automation-sourced
 * and not auto-promoted, so it is held in Drafting, with no requirements record, until the owner promotes it.
 * Answers `{ id, ref, url, deduplicated }`: 201 when created, 200 when deduplicated.
 */
export async function createFilerIssueHandler(c: Context): Promise<Response> {
  const filer = filerFor(c);
  if (!filer) return c.json({ error: "unauthorized" }, 401);
  const input = await readJson(c);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  const parsedKey = parseDedupeKey(filer, input.dedupeKey);
  if ("error" in parsedKey) return c.json({ error: parsedKey.error }, 400);
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) return c.json({ error: "title must be a non-empty string" }, 400);
  if (title.length > MAX_TITLE_LENGTH) return c.json({ error: `title must be at most ${MAX_TITLE_LENGTH} characters` }, 400);
  if (input.body !== undefined && typeof input.body !== "string") return c.json({ error: "body must be a string" }, 400);
  const body = (input.body as string | undefined) ?? "";
  if (body.length > MAX_BODY_LENGTH) return c.json({ error: `body must be at most ${MAX_BODY_LENGTH} characters` }, 400);

  const { key } = parsedKey;
  const result = await serialiseIssueCreate(async () => {
    const kept = await clawsIssues.findOpenIssueByDedupeKey(filer.repo, key);
    if (kept) return { ...issueJson(kept), deduplicated: true };
    const id = await clawsIssues.createIssue({
      title,
      body,
      authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
      repos: [filer.repo],
      source: "automation",
      autoPromote: false,
      dedupeKey: key,
    });
    log.info(`[${NAME}] ${filer.repo}: filed ${id} for ${key}`);
    return { ...issueJson({ id }), deduplicated: false };
  });
  return c.json(result, result.deduplicated ? 200 : 201);
}

/**
 * `GET …/issues?dedupeKey=…[&filedTitle=…]`: the open issue in the path repo
 * holding the key, or 404. On a miss with a `filedTitle`, adopt the newest
 * open, unkeyed issue in the path repo filed under exactly that title (before
 * any rename) by giving it the key — so a report the importer moved off the
 * forge keeps its one card.
 */
export async function lookupFilerIssueHandler(c: Context): Promise<Response> {
  const filer = filerFor(c);
  if (!filer) return c.json({ error: "unauthorized" }, 401);
  const parsedKey = parseDedupeKey(filer, c.req.query("dedupeKey"));
  if ("error" in parsedKey) return c.json({ error: parsedKey.error }, 400);
  const filedTitle = (c.req.query("filedTitle") ?? "").trim();
  if (filedTitle.length > MAX_TITLE_LENGTH) return c.json({ error: `filedTitle must be at most ${MAX_TITLE_LENGTH} characters` }, 400);
  const { key } = parsedKey;
  const kept = await clawsIssues.findOpenIssueByDedupeKey(filer.repo, key);
  if (kept) return c.json(issueJson(kept));
  if (!filedTitle) return c.json({ error: "not found" }, 404);
  const adopted = await serialiseIssueCreate(async () => {
    // A POST may have filed the key while this waited for the lock.
    const raced = await clawsIssues.findOpenIssueByDedupeKey(filer.repo, key);
    if (raced) return raced;
    const candidate = await clawsIssues.findOpenUnkeyedIssueByFiledTitle(filer.repo, filedTitle);
    if (!candidate || !(await clawsIssues.setClawsIssueDedupeKey(candidate.id, key))) return undefined;
    log.info(`[${NAME}] ${filer.repo}: adopted ${candidate.id} for ${key}`);
    return candidate;
  });
  if (!adopted) return c.json({ error: "not found" }, 404);
  return c.json(issueJson(adopted));
}

/**
 * `PATCH …/issues/:id` with `{ body?, state?: "closed" }`: rewrite one of this
 * filer's issues' body when it differs, and close it as completed. Posts no
 * comment; closing a closed issue is a no-op. Answers `{ id, ref, url, state }`.
 */
export async function updateFilerIssueHandler(c: Context): Promise<Response> {
  const filer = filerFor(c);
  if (!filer) return c.json({ error: "unauthorized" }, 401);
  const input = await readJson(c);
  if (!input) return c.json({ error: "Invalid JSON body" }, 400);
  if (input.body !== undefined && typeof input.body !== "string") return c.json({ error: "body must be a string" }, 400);
  const body = input.body as string | undefined;
  if (body !== undefined && body.length > MAX_BODY_LENGTH) return c.json({ error: `body must be at most ${MAX_BODY_LENGTH} characters` }, 400);
  if (input.state !== undefined && input.state !== "closed") return c.json({ error: `state must be "closed"` }, 400);
  const record = await getFilerIssue(filer, c.req.param("id") ?? "");
  if (!record) return c.json({ error: "not found" }, 404);

  if (body !== undefined && body !== record.body) {
    await clawsIssues.editIssue(record.id, body);
    log.info(`[${NAME}] ${filer.repo} ${record.id}: updated the body`);
  }
  let state = record.state;
  if (input.state === "closed" && record.state !== "closed") {
    await clawsIssues.closeIssue(filer.repo, record.id, "completed");
    state = "closed";
    log.info(`[${NAME}] ${filer.repo} ${record.id}: closed as completed`);
  }
  return c.json({ ...issueJson(record), state });
}

/** The native issue `id` when its primary repo is the filer's and its dedupe key carries the prefix, open or closed. */
async function getFilerIssue(filer: Filer, id: string): Promise<db.ClawsIssueRecord | undefined> {
  if (!gh.isNativeIssue(id)) return undefined;
  const record = await clawsIssues.getIssue(id);
  if (!record || record.kind !== "issue") return undefined;
  if (clawsIssues.primaryRepo(record) !== filer.repo) return undefined;
  if (!(record.dedupe_key ?? "").startsWith(filer.dedupeKeyPrefix)) return undefined;
  return record;
}

/**
 * `POST …/issues/:id/attachments?name=…` with a raw PNG body (≤ 5 MiB, the
 * route's body limit): store it on one of this filer's issues. Answers
 * `{ id, url }` with the attachment's absolute dashboard URL. Posts no
 * feedback comment and queues no re-plan.
 */
export async function uploadFilerAttachmentHandler(c: Context): Promise<Response> {
  const filer = filerFor(c);
  if (!filer) return c.json({ error: "unauthorized" }, 401);
  const name = (c.req.query("name") ?? "").trim();
  if (!name) return c.json({ error: "name must be a non-empty filename" }, 400);
  if (name.length > MAX_ATTACHMENT_NAME_LENGTH) return c.json({ error: `name must be at most ${MAX_ATTACHMENT_NAME_LENGTH} characters` }, 400);
  const contentType = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (contentType !== "image/png") return c.json({ error: "Content-Type must be image/png" }, 415);
  const record = await getFilerIssue(filer, c.req.param("id") ?? "");
  if (!record) return c.json({ error: "not found" }, 404);

  const data = Buffer.from(await c.req.arrayBuffer());
  if (data.byteLength > MAX_ATTACHMENT_BYTES) return c.json({ error: "File too large (max 5 MiB)" }, 413);
  if (data.byteLength <= PNG_SIGNATURE.length || !data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return c.json({ error: "body must be a PNG image" }, 415);
  }
  const result = await storeIssueAttachment(record.id, name, data, "image/png", clawsIssues.CLAWS_NATIVE_LOGIN);
  if (!result.ok) {
    if (result.reason === "too-large") return c.json({ error: "File too large (max 5 MiB)" }, 413);
    return c.json({ error: "attachment could not be stored", detail: result.detail ?? result.reason }, 500);
  }
  log.info(`[${NAME}] ${filer.repo} ${record.id}: stored attachment ${result.row.id} (${result.row.size} bytes)`);
  const base = (config.DASHBOARD_URL ?? "").replace(/\/+$/, "");
  return c.json({ id: result.row.id, url: `${base}${attachmentUrl(result.row)}` }, 201);
}

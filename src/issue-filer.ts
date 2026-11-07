/**
 * The issue-filer API: `/api/issue-filer/:owner/:name/issues`, `…/issues/:id`
 * and `…/issues/:id/attachments` (docs/issue-tracker.md "Issue filers").
 *
 * An external service — growth-engine's site visits first — files one native
 * issue per site review run here, holding every finding from the run, keyed by
 * a dedupe key it chooses, and attaches the run's screenshots to it. The issue
 * waits in Requirements review on its own text for the owner, and is planned
 * from that text once promoted.
 * sentinel's scheduled security findings keep one issue per key, rewriting its
 * body each run and closing it on recovery; they file with `alert: true`,
 * which sets the issue's `alert_kind` to `issue-filer` so `/alerts` lists it.
 * No label is applied (the `alert` label would make the dedupe lookup skip the
 * issue) and the issue still waits in Requirements review, never auto-planned.
 *
 * Auth mirrors the alert bridge's: a per-repo bearer token whose SHA-256 the
 * filing repo commits as `claws.json`'s `issueFiler.tokenSha256`. It is scoped
 * twice: the token only matches its own repo's path or a repo its
 * `issueFiler.repos` declares (`owner/name` or `owner/*`, a managed repo with
 * a present `claws.json`), and every route only reads or writes native issues
 * whose primary repo is the path repo and whose dedupe key starts with the
 * declaring filer's `dedupeKeyPrefix`. sentinel files CVE exception
 * escalations into recording repos this way.
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
import { forceRefreshRepoConfig, getRepoConfigState, listRepoConfigs, type RepoConfig, type RepoConfigState } from "./repo-config.js";
import { DEDUPE_KEY_PATTERN, serialiseIssueCreate } from "./issue-create-lock.js";
import { attachmentUrl, storeIssueAttachment } from "./issue-attachments.js";

const NAME = "issue-filer";
/** The `claws_issues.alert_kind` of an issue a filer flagged `alert: true`. */
const ALERT_KIND = "issue-filer";

/** How a write over a filer token reads in the issue's History. */
const ISSUE_FILER_ACTOR: IssueActor = { kind: "automation", name: "issue filer" };

export const MAX_TITLE_LENGTH = 256;
export const MAX_BODY_LENGTH = 65_536;
export const MAX_ATTACHMENT_NAME_LENGTH = 200;
/** A screenshot, not an archive. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The filer a request resolved to: the path repo, and the prefix and hash of the filer that declared it. */
export interface Filer {
  /** Hex SHA-256 of the matched token. */
  tokenSha256: string;
  /** The declaring filer's prefix; every key on this request must carry it. */
  dedupeKeyPrefix: string;
  /** The path repo's full name in its configured casing — what native issues record. */
  repo: string;
  /** The repo whose `claws.json` declared the matched filer; `repo` itself unless filing cross-repo. */
  declaredBy: string;
}

/** Whether an `issueFiler.repos` entry (`owner/name` or `owner/*`) covers `repo`, case-insensitively. */
function scopeCovers(entry: string, repo: string): boolean {
  const e = entry.toLowerCase();
  const r = repo.toLowerCase();
  if (e.endsWith("/*")) return r.startsWith(e.slice(0, -1)) && !r.slice(e.length - 1).includes("/");
  return e === r;
}

/**
 * The filer a token hash may act as on `pathRepo`'s routes, or null.
 * The path repo's own `issueFiler` wins when its hash matches. Otherwise a
 * filer declared in another repo's `claws.json` whose hash matches and whose
 * `repos` covers the path repo is used, with its own prefix. A cross-repo
 * match needs the path repo's `claws.json` to be present, is refused when
 * several matches disagree on prefix, and is refused when its prefix overlaps
 * the path repo's own filer prefix. Pure: `configs` is `listRepoConfigs()`.
 */
export function resolveIssueFiler(
  pathRepo: string,
  hash: string,
  configs: Array<{ fullName: string; config: RepoConfig }>,
  pathState: RepoConfigState,
): Filer | null {
  if (!hash || pathState !== "present") return null;
  const wanted = pathRepo.toLowerCase();
  const own = configs.find((r) => r.fullName.toLowerCase() === wanted);
  const repo = own?.fullName ?? pathRepo;
  const ownFiler = own?.config.issueFiler ?? null;
  if (ownFiler && safeCompare(hash, ownFiler.tokenSha256)) {
    return { tokenSha256: ownFiler.tokenSha256, dedupeKeyPrefix: ownFiler.dedupeKeyPrefix, repo, declaredBy: repo };
  }
  const matches = configs.filter((r) => {
    const filer = r.config.issueFiler;
    if (!filer || r.fullName.toLowerCase() === wanted) return false;
    return safeCompare(hash, filer.tokenSha256) && filer.repos.some((entry) => scopeCovers(entry, pathRepo));
  });
  if (matches.length === 0) return null;
  const prefixes = new Set(matches.map((m) => m.config.issueFiler!.dedupeKeyPrefix));
  if (prefixes.size > 1) {
    log.warn(`[${NAME}] cross-repo filer token matches filers with conflicting prefixes; refusing`, {
      repo,
      declaredBy: matches.map((m) => m.fullName).join(","),
    });
    return null;
  }
  const match = matches[0]!;
  const prefix = match.config.issueFiler!.dedupeKeyPrefix;
  if (ownFiler && (prefix.startsWith(ownFiler.dedupeKeyPrefix) || ownFiler.dedupeKeyPrefix.startsWith(prefix))) {
    log.warn(`[${NAME}] cross-repo filer prefix overlaps the path repo's own filer prefix; refusing`, {
      repo,
      declaredBy: match.fullName,
    });
    return null;
  }
  return { tokenSha256: match.config.issueFiler!.tokenSha256, dedupeKeyPrefix: prefix, repo, declaredBy: match.fullName };
}

function pathRepoOf(c: Context): string {
  return `${c.req.param("owner") ?? ""}/${c.req.param("name") ?? ""}`;
}

/** The bearer token's SHA-256, or "" when there is none. */
function bearerHash(c: Context): string {
  const authHeader = c.req.header("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : "";
  return token ? crypto.createHash("sha256").update(token).digest("hex") : "";
}

/** The filer this request's bearer token resolves to on the path repo, from the cached configs. */
function filerFor(c: Context, hash = bearerHash(c)): Filer | null {
  const wanted = pathRepoOf(c);
  return resolveIssueFiler(wanted, hash, listRepoConfigs(), getRepoConfigState(wanted));
}

/** ` (declared by X)` when a cross-repo filer acted, else "". */
function declaredBySuffix(filer: Filer): string {
  return filer.declaredBy === filer.repo ? "" : ` (declared by ${filer.declaredBy})`;
}

/**
 * Admit only a bearer token whose SHA-256 is the path repo's
 * `issueFiler.tokenSha256`, or another repo's whose `issueFiler.repos` covers
 * the path repo (`resolveIssueFiler`). Never `apiAuthMiddleware`'s tokens or
 * an operator session: they get a 401 here, and this token gets one everywhere else.
 */
export const issueFilerAuthMiddleware: MiddlewareHandler = async (c, next) => {
  const hash = bearerHash(c);
  if (!hash) return c.json({ error: "unauthorized" }, 401);
  let filer = filerFor(c, hash);
  if (!filer) {
    // The cached claws.json may predate a merged rotation or first opt-in:
    // re-read it (rate-limited per repo) before refusing. Only the path repo
    // is re-read, so a newly declared cross-repo scope waits for the TTL.
    if (!(await forceRefreshRepoConfig(pathRepoOf(c), gh.fetchRepoFileContent))) return c.json({ error: "unauthorized" }, 401);
    filer = filerFor(c, hash);
    if (!filer) return c.json({ error: "unauthorized" }, 401);
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
 * and not auto-promoted, so it waits in Requirements review on its own text, with no requirements record, until the owner promotes it.
 * An optional boolean `alert` marks the issue as an alert (a deduplicated
 * holder is marked once if it is not already). Answers `{ id, ref, url, deduplicated }`: 201 when created, 200 when deduplicated.
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

  if (input.alert !== undefined && typeof input.alert !== "boolean") return c.json({ error: "alert must be a boolean" }, 400);
  const alert = input.alert === true;

  const { key } = parsedKey;
  const result = await serialiseIssueCreate(async () => {
    const kept = await clawsIssues.findOpenIssueByDedupeKey(filer.repo, key);
    if (kept) {
      if (alert) {
        try {
          if (await clawsIssues.markAsAlert(kept.id, ALERT_KIND)) log.info(`[${NAME}] ${filer.repo} ${kept.id}: marked as an alert for ${key}`);
        } catch (err) {
          log.warn(`[${NAME}] ${filer.repo} ${kept.id}: could not mark as an alert for ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      return { ...issueJson(kept), deduplicated: true };
    }
    const id = await clawsIssues.createIssue({
      title,
      body,
      authorLogin: clawsIssues.CLAWS_NATIVE_LOGIN,
      repos: [filer.repo],
      source: "automation",
      autoPromote: false,
      dedupeKey: key,
      ...(alert ? { alertKind: ALERT_KIND } : {}),
    });
    log.info(`[${NAME}] ${filer.repo}: filed ${id} for ${key}${alert ? " as an alert" : ""}${declaredBySuffix(filer)}`);
    return { ...issueJson({ id }), deduplicated: false };
  });
  return c.json(result, result.deduplicated ? 200 : 201);
}

/**
 * `GET …/issues?dedupeKey=…[&filedTitle=…]`: the open issue in the path repo
 * holding the key as `{ id, ref, url, body }`, or 404. On a miss with a
 * `filedTitle`, adopt the newest open, unkeyed issue in the path repo filed
 * under exactly that title (before any rename) by giving it the key — so a
 * report the importer moved off the forge keeps its one card.
 *
 * `GET …/issues` with no `dedupeKey` lists this filer's open issues — primary
 * repo the path repo, dedupe key carrying the prefix — oldest first, as
 * `{ issues: [{ id, ref, url, dedupeKey, title }] }`, so a filer can close the
 * keys it no longer reports.
 */
export async function lookupFilerIssueHandler(c: Context): Promise<Response> {
  const filer = filerFor(c);
  if (!filer) return c.json({ error: "unauthorized" }, 401);
  if (c.req.query("dedupeKey") === undefined) {
    const issues = (await clawsIssues.listOpenIssues(filer.repo))
      .filter((issue) => (issue.dedupeKey ?? "").startsWith(filer.dedupeKeyPrefix))
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || String(a.number).localeCompare(String(b.number)))
      .map((issue) => ({ ...issueJson({ id: String(issue.number) }), dedupeKey: issue.dedupeKey!, title: issue.title }));
    return c.json({ issues });
  }
  const parsedKey = parseDedupeKey(filer, c.req.query("dedupeKey"));
  if ("error" in parsedKey) return c.json({ error: parsedKey.error }, 400);
  const filedTitle = (c.req.query("filedTitle") ?? "").trim();
  if (filedTitle.length > MAX_TITLE_LENGTH) return c.json({ error: `filedTitle must be at most ${MAX_TITLE_LENGTH} characters` }, 400);
  const { key } = parsedKey;
  const kept = await clawsIssues.findOpenIssueByDedupeKey(filer.repo, key);
  if (kept) return c.json({ ...issueJson(kept), body: kept.body });
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
  return c.json({ ...issueJson(adopted), body: adopted.body });
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
    log.info(`[${NAME}] ${filer.repo} ${record.id}: updated the body${declaredBySuffix(filer)}`);
  }
  let state = record.state;
  if (input.state === "closed" && record.state !== "closed") {
    await clawsIssues.closeIssue(filer.repo, record.id, "completed");
    state = "closed";
    log.info(`[${NAME}] ${filer.repo} ${record.id}: closed as completed${declaredBySuffix(filer)}`);
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
  log.info(`[${NAME}] ${filer.repo} ${record.id}: stored attachment ${result.row.id} (${result.row.size} bytes)${declaredBySuffix(filer)}`);
  const base = (config.DASHBOARD_URL ?? "").replace(/\/+$/, "");
  return c.json({ id: result.row.id, url: `${base}${attachmentUrl(result.row)}` }, 201);
}

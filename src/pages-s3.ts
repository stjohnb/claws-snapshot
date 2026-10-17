/**
 * A minimal S3 client for the fleet pages host (Garage), shared by the
 * service (reading issue-preview summaries) and the session-side
 * `tools/pages-publish.ts` CLI (#clw_01M3J52H0H9WSH3GTSY87ZY351).
 *
 * Implements AWS Signature Version 4 with `node:crypto` and `fetch` for the
 * four operations the pages host needs — GetObject, PutObject, ListObjectsV2
 * and DeleteObject — always path-style (`<endpoint>/<bucket>/<key>`), since
 * Garage does not support virtual-host addressing.
 *
 * Deliberately imports neither `config.ts` nor `log.ts`: the publish CLI runs
 * inside a session with nothing but its granted env, and must not load the
 * service's configuration or logger.
 */

import { createHash, createHmac } from "node:crypto";

export interface PagesS3Options {
  /** S3 API endpoint, e.g. `http://garage.default.svc.cluster.local:3900`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Per-request timeout; default 30 s. */
  timeoutMs?: number;
}

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 encoding as S3's canonical request requires: everything but `A-Za-z0-9-_.~`. */
export function s3Encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** An object key as a URI path: each segment encoded, `/` kept. */
export function encodeKeyPath(key: string): string {
  return key.split("/").map(s3Encode).join("/");
}

export interface SignInput {
  method: string;
  /** Host header value, including a non-default port. */
  host: string;
  /** Already-encoded canonical URI path. */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to sign besides `host`, `x-amz-date` and `x-amz-content-sha256`. */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  date: Date;
}

/** `20130524T000000Z` for `date`. */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Sorted, encoded `k=v&…` query string, identical for the URL and the canonical request. */
export function canonicalQuery(query: Record<string, string> = {}): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${s3Encode(k)}=${s3Encode(query[k]!)}`)
    .join("&");
}

/**
 * SigV4 request headers for `input`: `x-amz-date`, `x-amz-content-sha256`
 * and `Authorization`, plus any extra `headers` passed in. `host` is signed
 * but not returned — `fetch` sets it from the URL.
 */
export function signRequest(input: SignInput): Record<string, string> {
  const stamp = amzDate(input.date);
  const day = stamp.slice(0, 8);
  const toSign: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": input.payloadHash,
    "x-amz-date": stamp,
  };
  for (const [k, v] of Object.entries(input.headers ?? {})) toSign[k.toLowerCase()] = v;
  const names = Object.keys(toSign).sort();
  const canonicalHeaders = names.map((n) => `${n}:${toSign[n]!.trim()}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    input.method,
    input.path,
    canonicalQuery(input.query),
    canonicalHeaders,
    signedHeaders,
    input.payloadHash,
  ].join("\n");
  const scope = `${day}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const out: Record<string, string> = { ...(input.headers ?? {}) };
  out["x-amz-date"] = stamp;
  out["x-amz-content-sha256"] = input.payloadHash;
  out["Authorization"] = `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The keys, truncation flag and continuation token of one ListObjectsV2 page. */
export function parseListObjectsV2(xml: string): { keys: string[]; isTruncated: boolean; nextToken: string | null } {
  const keys = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((m) => xmlUnescape(m[1]!));
  const isTruncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml);
  const token = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
  return { keys, isTruncated, nextToken: token ? xmlUnescape(token[1]!) : null };
}

export class PagesS3Client {
  private readonly base: URL;
  private readonly basePath: string;

  constructor(private readonly opts: PagesS3Options) {
    this.base = new URL(opts.endpoint);
    this.basePath = this.base.pathname.replace(/\/+$/, "");
  }

  private async request(
    method: string,
    key: string | null,
    opts: { query?: Record<string, string>; body?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const path = `${this.basePath}/${s3Encode(this.opts.bucket)}${key === null ? "" : `/${encodeKeyPath(key)}`}`;
    const qs = canonicalQuery(opts.query);
    const headers = signRequest({
      method,
      host: this.base.host,
      path,
      query: opts.query,
      headers: opts.headers,
      payloadHash: opts.body ? sha256Hex(opts.body) : EMPTY_SHA256,
      region: this.opts.region,
      accessKeyId: this.opts.accessKeyId,
      secretAccessKey: this.opts.secretAccessKey,
      date: new Date(),
    });
    const url = `${this.base.protocol}//${this.base.host}${path}${qs ? `?${qs}` : ""}`;
    return fetch(url, {
      method,
      headers,
      body: opts.body ? new Uint8Array(opts.body) : undefined,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
  }

  private static async fail(res: Response, what: string): Promise<never> {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    throw new Error(`pages S3 ${what}: HTTP ${res.status}${text ? ` ${text}` : ""}`);
  }

  /** The object's status and body; a 404 is returned, not thrown. */
  async getObject(key: string): Promise<{ status: number; body: Buffer }> {
    const res = await this.request("GET", key);
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.request("PUT", key, { body, headers: { "content-type": contentType } });
    if (!res.ok) await PagesS3Client.fail(res, `PUT ${key}`);
  }

  /** Every key under `prefix`, paging ListObjectsV2 by continuation token. */
  async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | null = null;
    for (;;) {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token) query["continuation-token"] = token;
      const res = await this.request("GET", null, { query });
      if (!res.ok) await PagesS3Client.fail(res, `LIST ${prefix}`);
      const page = parseListObjectsV2(await res.text());
      keys.push(...page.keys);
      if (!page.isTruncated || !page.nextToken) return keys;
      token = page.nextToken;
    }
  }

  /** Deletes `key`; an already-missing key is not an error. */
  async deleteObject(key: string): Promise<void> {
    const res = await this.request("DELETE", key);
    if (!res.ok && res.status !== 404) await PagesS3Client.fail(res, `DELETE ${key}`);
  }
}

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  xml: "application/xml",
  pdf: "application/pdf",
  woff: "font/woff",
  woff2: "font/woff2",
  wasm: "application/wasm",
  stl: "model/stl",
};

/** The Content-Type to upload `filename` with, by extension. */
export function contentTypeFor(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 && dot > filename.lastIndexOf("/") ? filename.slice(dot + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/** The object key `url` names on the pages host rooted at `baseUrl`, or null when it is not under it. */
export function pagesKeyFromUrl(baseUrl: string, url: string): string | null {
  try {
    const base = new URL(`${baseUrl.replace(/\/+$/, "")}/`);
    const u = new URL(url);
    if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return null;
    const key = decodeURIComponent(u.pathname.slice(base.pathname.length));
    return key || null;
  } catch {
    return null;
  }
}

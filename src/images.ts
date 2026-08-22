import fs from "node:fs";
import path from "node:path";
import { promises as dns } from "node:dns";
import net from "node:net";
import sharp from "sharp";
import * as log from "./log.js";
import { getInstallationTokenForOwner, getAnyInstallationToken } from "./github-app.js";
import { commentOnIssue } from "./github.js";
import { reportFailedAttachments } from "./error-reporter.js";
import { guardContent, makeGuardCtx } from "./prompt-guard.js";

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
const DOWNLOAD_TIMEOUT = 30_000; // 30s
const IMAGE_DIR = ".claws-images";

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_SIZE = 1 * 1024 * 1024; // 1MB
const MAX_ATTACHMENT_CONTENT_LENGTH = 100_000; // 100K chars

const BADGE_PATTERNS = [
  /img\.shields\.io/i,
  /badge/i,
  /badgen\.net/i,
  /github\.com\/[^/]+\/[^/]+\/workflows\//i,
  /github\.com\/[^/]+\/[^/]+\/actions\/workflows\//i,
];

interface ImageRef {
  url: string;
  alt: string;
}

interface DownloadedImage {
  localPath: string;
  alt: string;
}

interface AttachmentRef {
  url: string;
  filename: string;
}

interface DownloadedAttachment {
  filename: string;
  content: string;
  truncated: boolean;
}

function stripCodeRegions(text: string, kind: "markdown" | "html"): string {
  if (kind === "markdown") {
    let result = text.replace(/```+[^\n]*\n[\s\S]*?\n```+/g, " ");
    result = result.replace(/~~~+[^\n]*\n[\s\S]*?\n~~~+/g, " ");
    result = result.replace(/`[^`\n]+`/g, " ");
    return result;
  } else {
    let result = text.replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, " ");
    result = result.replace(/<code[^>]*>[\s\S]*?<\/code>/gi, " ");
    return result;
  }
}

function isUsableImageUrl(url: string): boolean {
  if (url.startsWith("data:")) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function extractImageUrls(text: string, format: "markdown" | "html" = "markdown"): ImageRef[] {
  const seen = new Set<string>();
  const results: ImageRef[] = [];

  if (format === "markdown") {
    // Markdown: ![alt](url)
    const mdSafe = stripCodeRegions(text, "markdown");
    const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    let match: RegExpExecArray | null;
    while ((match = mdRegex.exec(mdSafe)) !== null) {
      const [, alt, url] = match;
      if (!shouldSkipUrl(url) && isUsableImageUrl(url) && !seen.has(url)) {
        seen.add(url);
        results.push({ url, alt });
      }
    }
  }

  // HTML: <img src="url" ...>
  const htmlSafe = stripCodeRegions(text, "html");
  const htmlRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = htmlRegex.exec(htmlSafe)) !== null) {
    const url = match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
    const altMatch = match[0].match(/alt=["']([^"']*?)["']/i);
    const alt = altMatch?.[1] ?? "";
    if (!shouldSkipUrl(url) && isUsableImageUrl(url) && !seen.has(url)) {
      seen.add(url);
      results.push({ url, alt });
    }
  }

  return results;
}

function shouldSkipUrl(url: string): boolean {
  if (url.startsWith("data:")) return true;
  return BADGE_PATTERNS.some((p) => p.test(url));
}

const MAX_IMAGE_DIMENSION = 2048;

async function resizeIfNeeded(buffer: Buffer, contentType: string): Promise<Buffer> {
  // SVGs are text-based; sharp cannot handle them
  if (contentType.includes("svg")) return buffer;

  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();
    const { width, height } = metadata;

    if (!width || !height || (width <= MAX_IMAGE_DIMENSION && height <= MAX_IMAGE_DIMENSION)) {
      return buffer;
    }

    log.info(`[images] Resizing ${width}x${height} image to fit within ${MAX_IMAGE_DIMENSION}px`);

    if (contentType.includes("png")) {
      return await image
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: "inside" })
        .png()
        .toBuffer();
    }
    return await image
      .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, { fit: "inside" })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch (err) {
    log.warn(`[images] Failed to check/resize image: ${err}`);
    return buffer;
  }
}

function getExtension(contentType: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
  };
  return map[type] ?? ".png";
}

async function getGitHubToken(owner?: string): Promise<string | null> {
  try {
    if (owner) return await getInstallationTokenForOwner(owner);
    return await getAnyInstallationToken();
  } catch (err) {
    log.warn(`[images] Failed to mint installation token${owner ? ` for ${owner}` : ""}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function shouldAttachGitHubToken(rawUrl: string, currentRepo?: { owner: string; name: string }): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  // Pre-signed private user image URLs already carry a JWT in the query string;
  // do NOT add the installation-token Authorization header on top of that.
  if (host === "private-user-images.githubusercontent.com") return false;
  const isGitHubHost =
    host === "github.com" ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com");
  if (!isGitHubHost) return false;

  // Installation tokens are owner-wide, not repo-scoped — only attach when the
  // URL positively identifies the repo currently being processed. A URL that
  // can't be mapped to a repo (e.g. user-attachments assets) is permitted, since
  // it can't be used to reach a different repo's private content this way.
  const urlRepo = extractRepoFromGitHubUrl(rawUrl);
  if (urlRepo && currentRepo) {
    const sameRepo =
      urlRepo.owner.toLowerCase() === currentRepo.owner.toLowerCase() &&
      urlRepo.repo.toLowerCase() === currentRepo.name.toLowerCase();
    if (!sameRepo) {
      log.warn(`[images] Not attaching installation token to ${rawUrl}: URL targets ${urlRepo.owner}/${urlRepo.repo}, current repo is ${currentRepo.owner}/${currentRepo.name}`);
      return false;
    }
  }
  return true;
}

// github.com's web frontend authenticates by session cookie and ignores the
// `Authorization: token` header, so /raw/ and /blob/ URLs in PRIVATE repos come
// back as HTTP 404 text/html. raw.githubusercontent.com honours the header, so
// rewrite to it before fetching. Public repos are unaffected — github.com 302s
// to exactly this URL anyway, so the rewrite just skips one hop.
export function normalizeGitHubBlobUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (parsed.protocol !== "https:") return rawUrl;
  if (parsed.hostname.toLowerCase() !== "github.com") return rawUrl;

  // pathname is "/owner/repo/raw/ref/path..." → ["", owner, repo, kind, ref, ...path]
  const segments = parsed.pathname.split("/");
  if (segments.length < 6) return rawUrl;
  const [, owner, repo, kind, ...rest] = segments;
  if (kind !== "raw" && kind !== "blob") return rawUrl;
  if (!owner || !repo || rest.some((s) => s === "")) return rawUrl;

  return `https://raw.githubusercontent.com/${owner}/${repo}/${rest.join("/")}${parsed.search}`;
}

// Positively identifies the owner/repo a GitHub-hosted URL targets, so a token
// minted for the current repo isn't attached to a URL pointing at a different
// repo under the same owner. Returns null (permissive) for any host/path that
// isn't repo-scoped — e.g. user-attachments assets, which are UUID-addressed.
export function extractRepoFromGitHubUrl(rawUrl: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  const segs = parsed.pathname.split("/").filter(Boolean);

  if (host === "github.com") {
    if (segs[0] === "user-attachments") return null;
    if (segs.length >= 2) return { owner: segs[0], repo: segs[1] };
    return null;
  }
  if (host === "raw.githubusercontent.com") {
    if (segs.length >= 2) return { owner: segs[0], repo: segs[1] };
    return null;
  }
  if (host === "media.githubusercontent.com") {
    if (segs[0] === "media" && segs.length >= 3) return { owner: segs[1], repo: segs[2] };
    return null;
  }
  return null;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts;
  // 0.0.0.0/8 "this network" / unspecified
  if (a === 0) return true;
  // 10.0.0.0/8 private
  if (a === 10) return true;
  // 100.64.0.0/10 carrier-grade NAT
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 loopback
  if (a === 127) return true;
  // 169.254.0.0/16 link-local
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 private
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 private
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 multicast
  if (a >= 224 && a <= 239) return true;
  // 240.0.0.0/4 reserved
  if (a >= 240) return true;
  return false;
}

function expandIpv6(ip: string): number[] | null {
  let s = ip;
  // Handle embedded IPv4 forms like ::ffff:127.0.0.1 by translating the trailing
  // dotted-quad to two hextets.
  const v4Tail = s.match(/^(.*:)((?:\d+\.){3}\d+)$/);
  if (v4Tail) {
    const [, prefix, v4] = v4Tail;
    const octets = v4.split(".").map((o) => parseInt(o, 10));
    if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
      return null;
    }
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    s = prefix + hi + ":" + lo;
  }
  let parts: string[];
  if (s.includes("::")) {
    const splits = s.split("::");
    if (splits.length !== 2) return null;
    const [head, tail] = splits;
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === "" ? [] : tail.split(":");
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    parts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  } else {
    parts = s.split(":");
  }
  if (parts.length !== 8) return null;
  const hextets = parts.map((p) => parseInt(p, 16));
  if (hextets.some((h) => Number.isNaN(h) || h < 0 || h > 0xffff)) return null;
  return hextets;
}

function isPrivateIpv6(ip: string): boolean {
  const hextets = expandIpv6(ip);
  if (!hextets) return false;

  // :: (unspecified) and ::1 (loopback)
  const zeroPrefix = hextets.slice(0, 7).every((h) => h === 0);
  if (zeroPrefix && (hextets[7] === 0 || hextets[7] === 1)) return true;

  const first = hextets[0];
  // fe80::/10 link-local
  if ((first & 0xffc0) === 0xfe80) return true;
  // fc00::/7 unique-local (covers fd00::/8)
  if ((first & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((first & 0xff00) === 0xff00) return true;

  // IPv4-mapped IPv6: ::ffff:0:0/96 — extract the embedded v4 and re-check.
  if (
    hextets[0] === 0 &&
    hextets[1] === 0 &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0xffff
  ) {
    const a = (hextets[6] >> 8) & 0xff;
    const b = hextets[6] & 0xff;
    const c = (hextets[7] >> 8) & 0xff;
    const d = hextets[7] & 0xff;
    return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
  }

  return false;
}

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return false;
}

// Pre-flight DNS check; undici will re-resolve at fetch time. Acceptable residual
// risk for now — TTL-bound rebinds against this bot are slow to exploit.
export async function assertPublicHost(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("blocked: invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`blocked: unsupported protocol ${parsed.protocol}`);
  }
  let host = parsed.hostname.toLowerCase();
  // Node's URL.hostname returns IPv6 literals wrapped in brackets (e.g. "[::1]").
  // Strip them so net.isIP / dns.lookup see a bare address.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "" || host === "localhost") {
    throw new Error("blocked: localhost");
  }
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) {
      throw new Error(`blocked: private address ${host}`);
    }
    return;
  }
  const resolved = await dns.lookup(host, { all: true, verbatim: true });
  for (const { address } of resolved) {
    if (isPrivateIp(address)) {
      throw new Error(`blocked: private address ${host} → ${address}`);
    }
  }
}

const MAX_REDIRECT_HOPS = 3;

async function fetchWithGuard(
  url: string,
  token: string | null,
  signal: AbortSignal,
  currentRepo?: { owner: string; name: string },
): Promise<Response> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    currentUrl = normalizeGitHubBlobUrl(currentUrl);
    await assertPublicHost(currentUrl);
    const headers: Record<string, string> = {};
    if (token && shouldAttachGitHubToken(currentUrl, currentRepo)) {
      headers["Authorization"] = `token ${token}`;
    }
    const resp = await fetch(currentUrl, {
      headers,
      signal,
      redirect: "manual",
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) {
        throw new Error(`redirect without Location at ${currentUrl}`);
      }
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error(`too many redirects (>${MAX_REDIRECT_HOPS}) starting at ${url}`);
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }
    return resp;
  }
  throw new Error(`too many redirects (>${MAX_REDIRECT_HOPS}) starting at ${url}`);
}

// Enforce the size cap while streaming so an oversized or Content-Length-lying
// response can't drive memory up before the check runs (mirrors downloadAudio()
// in whatsapp.ts). Returns null when the cap is exceeded.
async function readBodyWithLimit(resp: Response, maxSize: number): Promise<Buffer | null> {
  const body = resp.body as ReadableStream<Uint8Array> | null | undefined;
  if (!body || typeof body.getReader !== "function") {
    // No web stream on the response (empty body, or a test double). Fall back to
    // the buffered read plus a post-hoc check — real undici responses always
    // expose a ReadableStream body, so this path is never hit in production.
    const buffer = Buffer.from(await resp.arrayBuffer());
    return buffer.length > maxSize ? null : buffer;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const buf = Buffer.from(value); // copies; do not alias undici's chunk memory
      total += buf.length;
      if (total > maxSize) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(buf);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released by cancel() */ }
  }
  return Buffer.concat(chunks, total);
}

async function downloadEach<TRef extends { url: string }, TResult>(
  items: TRef[],
  maxItems: number,
  maxSize: number,
  label: string,
  token: string | null,
  shouldSkipContentType: (contentType: string) => string | null,
  buildResult: (ref: TRef, index: number, buffer: Buffer, contentType: string) => Promise<TResult | null>,
  currentRepo?: { owner: string; name: string },
): Promise<{ downloaded: TResult[]; failed: string[] }> {
  const toDownload = items.slice(0, maxItems);
  if (items.length > maxItems) {
    log.warn(`[images] Capping ${label} downloads at ${maxItems} (${items.length} found)`);
  }

  const results: TResult[] = [];
  const failed: string[] = [];

  for (let i = 0; i < toDownload.length; i++) {
    const item = toDownload[i];
    const { url } = item;
    try {
      let resp: Response;
      try {
        resp = await fetchWithGuard(url, token, AbortSignal.timeout(DOWNLOAD_TIMEOUT), currentRepo);
      } catch (err) {
        log.warn(`[images] Refusing to fetch ${label} ${url}: ${err instanceof Error ? err.message : String(err)}`);
        failed.push(url);
        continue;
      }

      if (!resp.ok) {
        log.warn(`[images] Failed to download ${label} ${url}: HTTP ${resp.status}`);
        failed.push(url);
        continue;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      const skipReason = shouldSkipContentType(contentType);
      if (skipReason !== null) {
        log.warn(`[images] Skipping ${label} ${url}: ${skipReason}`);
        continue;
      }

      // Fast path: reject before transferring anything when the host declares an
      // oversized body. The header is host-controlled, so it is only a shortcut —
      // readBodyWithLimit() below is the actual bound.
      const contentLength = resp.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > maxSize) {
        log.warn(`[images] Skipping ${label} ${url}: exceeds ${maxSize} byte limit`);
        continue;
      }

      const buffer = await readBodyWithLimit(resp, maxSize);
      if (buffer === null) {
        log.warn(`[images] Skipping ${label} ${url}: exceeds ${maxSize} byte limit`);
        continue;
      }

      const result = await buildResult(item, i, buffer, contentType);
      if (result !== null) {
        results.push(result);
      }
    } catch (err) {
      log.warn(`[images] Failed to download ${label} ${url}: ${err}`);
      failed.push(url);
    }
  }

  return { downloaded: results, failed };
}

export async function downloadImages(
  images: ImageRef[],
  destDir: string,
  repo?: { owner: string; name: string },
): Promise<{ downloaded: DownloadedImage[]; failed: string[] }> {
  if (images.length === 0) return { downloaded: [], failed: [] };

  fs.mkdirSync(destDir, { recursive: true });
  // Self-ignoring scratch dir: a `.gitignore` of `*` makes git ignore every file
  // in this directory including the .gitignore itself, so an agent's `git add -A`
  // can never sweep downloaded issue images into a commit (as happened in #1283,
  // which committed .claws-images/img-1.png to this repo). Works in every target
  // repo without touching that repo's own .gitignore.
  try {
    fs.writeFileSync(path.join(destDir, ".gitignore"), "*\n");
  } catch (err) {
    log.warn(`[images] Failed to write .claws-images/.gitignore: ${err}`);
  }
  const token = await getGitHubToken(repo?.owner);

  return downloadEach(
    images,
    MAX_IMAGES,
    MAX_IMAGE_SIZE,
    "image",
    token,
    (contentType) => contentType.startsWith("image/") ? null : `not an image (${contentType})`,
    async (img, i, buffer, contentType) => {
      const resized = await resizeIfNeeded(buffer, contentType);
      const ext = getExtension(contentType);
      const filename = `img-${i + 1}${ext}`;
      fs.writeFileSync(path.join(destDir, filename), resized);
      return { localPath: `${IMAGE_DIR}/${filename}`, alt: img.alt };
    },
    repo,
  );
}

export function buildImagePromptSection(images: DownloadedImage[]): string {
  if (images.length === 0) return "";

  const lines = [
    ``,
    `## Attached Images`,
    ``,
    `The issue/comments above contain embedded images. Use your Read tool to view each file for visual context:`,
    ``,
  ];
  for (const img of images) {
    const desc = img.alt ? ` — "${img.alt}"` : "";
    lines.push(`- ${img.localPath}${desc}`);
  }
  return lines.join("\n");
}

export function extractAttachmentUrls(text: string): AttachmentRef[] {
  const seen = new Set<string>();
  const results: AttachmentRef[] = [];

  // Match [filename](github-attachment-url) but NOT ![alt](url) (images)
  const safe = stripCodeRegions(text, "markdown");
  const regex = /(?<!!)\[([^\]]+)\]\((https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+)\)/g;
  let match;
  while ((match = regex.exec(safe)) !== null) {
    const [, filename, url] = match;
    if (!seen.has(url)) {
      seen.add(url);
      results.push({ url, filename });
    }
  }

  return results;
}

export function isBinaryContentType(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("image/")) return true;
  if (type.startsWith("video/")) return true;
  if (type.startsWith("audio/")) return true;
  return false;
}

export function truncateContent(content: string): { text: string; truncated: boolean } {
  if (content.length <= MAX_ATTACHMENT_CONTENT_LENGTH) {
    return { text: content, truncated: false };
  }
  const half = MAX_ATTACHMENT_CONTENT_LENGTH / 2;
  const text =
    content.slice(0, half) +
    "\n\n... [TRUNCATED — file too large] ...\n\n" +
    content.slice(-half);
  return { text, truncated: true };
}

export async function downloadAttachments(
  attachments: AttachmentRef[],
  repo?: { owner: string; name: string },
  guardCtx?: ReturnType<typeof makeGuardCtx>,
): Promise<{ downloaded: DownloadedAttachment[]; failed: string[] }> {
  if (attachments.length === 0) return { downloaded: [], failed: [] };

  const token = await getGitHubToken(repo?.owner);

  return downloadEach(
    attachments,
    MAX_ATTACHMENTS,
    MAX_ATTACHMENT_SIZE,
    "attachment",
    token,
    (contentType) => isBinaryContentType(contentType) ? `binary content type (${contentType})` : null,
    async (att, _i, buffer) => {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        log.warn(`[images] Skipping attachment ${att.url}: not valid UTF-8`);
        return null;
      }
      const guarded = guardCtx ? guardContent(text, guardCtx("attachment-content")) : text;
      const { text: content, truncated } = truncateContent(guarded);
      const filename = guardCtx
        ? guardContent(att.filename, guardCtx("attachment-filename"))
        : att.filename;
      return { filename, content, truncated };
    },
    repo,
  );
}

export function buildAttachmentPromptSection(attachments: DownloadedAttachment[]): string {
  if (attachments.length === 0) return "";

  const lines = [
    ``,
    `## Attached Files`,
    ``,
    `The issue/comments above contain attached text files. Their contents are included below:`,
    ``,
  ];

  for (const att of attachments) {
    const ext = att.filename.includes(".") ? att.filename.split(".").pop()! : "";
    // Use dynamic fence length to handle files containing triple backticks
    let fence = "```";
    while (att.content.includes(fence)) {
      fence += "`";
    }
    const truncNote = att.truncated ? " (truncated)" : "";
    lines.push(`### ${att.filename}${truncNote}`);
    lines.push(`${fence}${ext}`);
    lines.push(att.content);
    lines.push(fence);
    lines.push(``);
  }

  return lines.join("\n");
}

export async function processTextForImages(
  texts: string[],
  wtPath: string,
  repo?: { owner: string; name: string },
  posting?: { repo: string; issueNumber: number; agentName?: string },
  htmlBodies?: string[],
): Promise<string> {
  const combined = texts.filter(Boolean).join("\n");

  // Image pipeline — use htmlBodies if provided; body_html contains pre-signed private-user-images URLs
  const filteredHtmlBodies = (htmlBodies ?? []).filter(Boolean);
  const useHtmlBodies = filteredHtmlBodies.length > 0;
  const imageSourceText = useHtmlBodies ? filteredHtmlBodies.join("\n") : combined;
  const images = extractImageUrls(imageSourceText, useHtmlBodies ? "html" : "markdown");
  let imageSection = "";
  let failedImages: string[] = [];
  if (images.length > 0) {
    const destDir = path.join(wtPath, IMAGE_DIR);
    const { downloaded: downloadedImages, failed } = await downloadImages(images, destDir, repo);
    failedImages = failed;
    imageSection = buildImagePromptSection(downloadedImages);
  }

  // Guard context for every externally-sourced string this function inlines into a
  // prompt. When no posting target is known we still redact and alert; itemNumber 0
  // suppresses only the visible ⚠️ comment (see guardContent in prompt-guard.ts).
  const guardCtx = posting
    ? makeGuardCtx(posting.repo, posting.issueNumber)
    : makeGuardCtx(repo ? `${repo.owner}/${repo.name}` : "images", 0);

  // Attachment pipeline
  const attachments = extractAttachmentUrls(combined);
  let attachmentSection = "";
  let failedAttachments: string[] = [];
  if (attachments.length > 0) {
    const { downloaded: downloadedAttachments, failed } = await downloadAttachments(
      attachments,
      repo,
      guardCtx,
    );
    failedAttachments = failed;
    attachmentSection = buildAttachmentPromptSection(downloadedAttachments);
  }

  const allProblematic = [...failedImages, ...failedAttachments];

  if (allProblematic.length > 0 && posting) {
    const noun = allProblematic.length === 1 ? "file" : "files";
    const list = allProblematic
      .map((u) => `- \`${guardContent(u, guardCtx("failed-download-url"))}\``)
      .join("\n");
    const body = `⚠️ Could not download ${allProblematic.length} ${noun} — they will not be visible in my analysis:\n\n${list}`;
    try {
      await commentOnIssue(posting.repo, posting.issueNumber, body, { agentName: posting.agentName });
    } catch (err) {
      log.warn(`[images] Failed to post download-failure comment: ${err}`);
    }
  }

  if (allProblematic.length > 0 && posting) {
    try {
      await reportFailedAttachments({
        sourceRepo: posting.repo,
        sourceIssueNumber: posting.issueNumber,
        failedUrls: allProblematic,
        agentName: posting.agentName,
      });
    } catch (err) {
      log.warn(`[images] Failed to auto-create attachment-failure issue: ${err}`);
    }
  }

  return imageSection + attachmentSection;
}

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as log from "./log.js";

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

export function extractImageUrls(text: string): ImageRef[] {
  const seen = new Set<string>();
  const results: ImageRef[] = [];

  // Markdown: ![alt](url)
  const mdRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = mdRegex.exec(text)) !== null) {
    const [, alt, url] = match;
    if (!shouldSkipUrl(url) && !seen.has(url)) {
      seen.add(url);
      results.push({ url, alt });
    }
  }

  // HTML: <img src="url" ...>
  const htmlRegex = /<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi;
  while ((match = htmlRegex.exec(text)) !== null) {
    const url = match[1];
    const altMatch = match[0].match(/alt=["']([^"']*?)["']/i);
    const alt = altMatch?.[1] ?? "";
    if (!shouldSkipUrl(url) && !seen.has(url)) {
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

async function getGitHubToken(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token"], (err, stdout) => {
      if (err) {
        resolve(null);
      } else {
        resolve(stdout.trim() || null);
      }
    });
  });
}

export async function downloadImages(
  images: ImageRef[],
  destDir: string,
): Promise<DownloadedImage[]> {
  if (images.length === 0) return [];

  fs.mkdirSync(destDir, { recursive: true });
  const token = await getGitHubToken();

  const toDownload = images.slice(0, MAX_IMAGES);
  if (images.length > MAX_IMAGES) {
    log.warn(`[images] Capping image downloads at ${MAX_IMAGES} (${images.length} found)`);
  }

  const results: DownloadedImage[] = [];

  for (let i = 0; i < toDownload.length; i++) {
    const img = toDownload[i];
    try {
      const headers: Record<string, string> = {};
      if (token && (img.url.includes("githubusercontent.com") || img.url.includes("github.com"))) {
        headers["Authorization"] = `token ${token}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

      const resp = await fetch(img.url, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        log.warn(`[images] Failed to download ${img.url}: HTTP ${resp.status}`);
        continue;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        log.warn(`[images] Skipping ${img.url}: not an image (${contentType})`);
        continue;
      }

      const contentLength = resp.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_SIZE) {
        log.warn(`[images] Skipping ${img.url}: exceeds ${MAX_IMAGE_SIZE} byte limit`);
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > MAX_IMAGE_SIZE) {
        log.warn(`[images] Skipping ${img.url}: exceeds ${MAX_IMAGE_SIZE} byte limit`);
        continue;
      }

      const ext = getExtension(contentType);
      const filename = `img-${i + 1}${ext}`;
      const filePath = path.join(destDir, filename);
      fs.writeFileSync(filePath, buffer);

      results.push({ localPath: `${IMAGE_DIR}/${filename}`, alt: img.alt });
    } catch (err) {
      log.warn(`[images] Failed to download ${img.url}: ${err}`);
    }
  }

  return results;
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
  const regex = /(?<!!)\[([^\]]+)\]\((https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+)\)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
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
): Promise<DownloadedAttachment[]> {
  if (attachments.length === 0) return [];

  const token = await getGitHubToken();

  const toDownload = attachments.slice(0, MAX_ATTACHMENTS);
  if (attachments.length > MAX_ATTACHMENTS) {
    log.warn(`[images] Capping attachment downloads at ${MAX_ATTACHMENTS} (${attachments.length} found)`);
  }

  const results: DownloadedAttachment[] = [];

  for (const att of toDownload) {
    try {
      const headers: Record<string, string> = {};
      if (token) {
        headers["Authorization"] = `token ${token}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT);

      const resp = await fetch(att.url, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!resp.ok) {
        log.warn(`[images] Failed to download attachment ${att.url}: HTTP ${resp.status}`);
        continue;
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (isBinaryContentType(contentType)) {
        log.warn(`[images] Skipping attachment ${att.url}: binary content type (${contentType})`);
        continue;
      }

      const contentLength = resp.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > MAX_ATTACHMENT_SIZE) {
        log.warn(`[images] Skipping attachment ${att.url}: exceeds ${MAX_ATTACHMENT_SIZE} byte limit`);
        continue;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > MAX_ATTACHMENT_SIZE) {
        log.warn(`[images] Skipping attachment ${att.url}: exceeds ${MAX_ATTACHMENT_SIZE} byte limit`);
        continue;
      }

      // Validate UTF-8
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        log.warn(`[images] Skipping attachment ${att.url}: not valid UTF-8`);
        continue;
      }

      const { text: content, truncated } = truncateContent(text);
      results.push({ filename: att.filename, content, truncated });
    } catch (err) {
      log.warn(`[images] Failed to download attachment ${att.url}: ${err}`);
    }
  }

  return results;
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
): Promise<string> {
  const combined = texts.filter(Boolean).join("\n");

  // Image pipeline
  const images = extractImageUrls(combined);
  let imageSection = "";
  if (images.length > 0) {
    const destDir = path.join(wtPath, IMAGE_DIR);
    const downloaded = await downloadImages(images, destDir);
    imageSection = buildImagePromptSection(downloaded);
  }

  // Attachment pipeline
  const attachments = extractAttachmentUrls(combined);
  let attachmentSection = "";
  if (attachments.length > 0) {
    const downloaded = await downloadAttachments(attachments);
    attachmentSection = buildAttachmentPromptSection(downloaded);
  }

  return imageSection + attachmentSection;
}

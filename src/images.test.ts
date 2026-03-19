import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock execFile for gh auth token
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  extractImageUrls,
  downloadImages,
  buildImagePromptSection,
  processTextForImages,
  extractAttachmentUrls,
  downloadAttachments,
  buildAttachmentPromptSection,
  isBinaryContentType,
  truncateContent,
} from "./images.js";

describe("images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: gh auth token returns a token
    mockExecFile.mockImplementation((_cmd: string, _args: string[], cb: Function) => {
      cb(null, "ghp_testtoken123\n");
    });
  });

  describe("extractImageUrls", () => {
    it("parses markdown image syntax", () => {
      const text = "Here is a screenshot: ![error screenshot](https://example.com/img.png)";
      const result = extractImageUrls(text);
      expect(result).toEqual([
        { url: "https://example.com/img.png", alt: "error screenshot" },
      ]);
    });

    it("parses HTML img tags", () => {
      const text = '<img src="https://example.com/photo.jpg" alt="photo">';
      const result = extractImageUrls(text);
      expect(result).toEqual([
        { url: "https://example.com/photo.jpg", alt: "photo" },
      ]);
    });

    it("parses HTML img tags without alt", () => {
      const text = '<img src="https://example.com/photo.jpg">';
      const result = extractImageUrls(text);
      expect(result).toEqual([
        { url: "https://example.com/photo.jpg", alt: "" },
      ]);
    });

    it("skips data URIs", () => {
      const text = "![inline](data:image/png;base64,abc123)";
      const result = extractImageUrls(text);
      expect(result).toEqual([]);
    });

    it("skips badge/shield URLs", () => {
      const text = [
        "![build](https://img.shields.io/badge/build-passing-green)",
        "![ci](https://badgen.net/badge/ci/passing)",
        "![real](https://example.com/screenshot.png)",
      ].join("\n");
      const result = extractImageUrls(text);
      expect(result).toEqual([
        { url: "https://example.com/screenshot.png", alt: "real" },
      ]);
    });

    it("deduplicates identical URLs", () => {
      const text = [
        "![first](https://example.com/img.png)",
        "![second](https://example.com/img.png)",
      ].join("\n");
      const result = extractImageUrls(text);
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe("https://example.com/img.png");
    });

    it("returns empty array when no images found", () => {
      const text = "Just plain text with no images at all";
      const result = extractImageUrls(text);
      expect(result).toEqual([]);
    });

    it("handles mixed markdown and HTML images", () => {
      const text = [
        '![md image](https://example.com/md.png)',
        '<img src="https://example.com/html.jpg" alt="html image">',
      ].join("\n");
      const result = extractImageUrls(text);
      expect(result).toHaveLength(2);
      expect(result[0].url).toBe("https://example.com/md.png");
      expect(result[1].url).toBe("https://example.com/html.jpg");
    });
  });

  describe("downloadImages", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-img-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("downloads images and saves with correct extension", async () => {
      const imageData = Buffer.from("fake png data");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "image/png"],
          ["content-length", String(imageData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      const result = await downloadImages(
        [{ url: "https://example.com/img.png", alt: "test" }],
        tmpDir,
      );

      expect(result).toHaveLength(1);
      expect(result[0].localPath).toBe(".claws-images/img-1.png");
      expect(result[0].alt).toBe("test");
      expect(fs.existsSync(path.join(tmpDir, "img-1.png"))).toBe(true);
    });

    it("infers extension from content-type", async () => {
      const imageData = Buffer.from("fake jpg data");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "image/jpeg"],
          ["content-length", String(imageData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      const result = await downloadImages(
        [{ url: "https://example.com/photo", alt: "photo" }],
        tmpDir,
      );

      expect(result[0].localPath).toBe(".claws-images/img-1.jpg");
    });

    it("skips failed downloads gracefully", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      const result = await downloadImages(
        [{ url: "https://example.com/missing.png", alt: "" }],
        tmpDir,
      );

      expect(result).toHaveLength(0);
    });

    it("skips non-image content types", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "text/html"],
        ]),
      });

      const result = await downloadImages(
        [{ url: "https://example.com/page.html", alt: "" }],
        tmpDir,
      );

      expect(result).toHaveLength(0);
    });

    it("respects max image count", async () => {
      const images = Array.from({ length: 15 }, (_, i) => ({
        url: `https://example.com/img-${i}.png`,
        alt: `image ${i}`,
      }));

      const imageData = Buffer.from("fake data");
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        }),
      );

      const result = await downloadImages(images, tmpDir);

      expect(result).toHaveLength(10);
      expect(mockFetch).toHaveBeenCalledTimes(10);
    });

    it("handles fetch errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const result = await downloadImages(
        [{ url: "https://example.com/img.png", alt: "" }],
        tmpDir,
      );

      expect(result).toHaveLength(0);
    });

    it("adds auth header for GitHub URLs", async () => {
      const imageData = Buffer.from("fake data");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "image/png"],
          ["content-length", String(imageData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      await downloadImages(
        [{ url: "https://user-images.githubusercontent.com/123/img.png", alt: "" }],
        tmpDir,
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://user-images.githubusercontent.com/123/img.png",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "token ghp_testtoken123" }),
        }),
      );
    });
  });

  describe("buildImagePromptSection", () => {
    it("formats correctly with images", () => {
      const result = buildImagePromptSection([
        { localPath: ".claws-images/img-1.png", alt: "screenshot of error" },
        { localPath: ".claws-images/img-2.jpg", alt: "expected layout" },
      ]);

      expect(result).toContain("## Attached Images");
      expect(result).toContain('.claws-images/img-1.png — "screenshot of error"');
      expect(result).toContain('.claws-images/img-2.jpg — "expected layout"');
    });

    it("returns empty string when no images", () => {
      expect(buildImagePromptSection([])).toBe("");
    });

    it("handles images without alt text", () => {
      const result = buildImagePromptSection([
        { localPath: ".claws-images/img-1.png", alt: "" },
      ]);

      expect(result).toContain("- .claws-images/img-1.png");
      expect(result).not.toContain('""');
    });
  });

  describe("processTextForImages", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-img-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns empty string when no images in text", async () => {
      const result = await processTextForImages(["Just plain text"], tmpDir);
      expect(result).toBe("");
    });

    it("end-to-end: extracts, downloads, and builds prompt", async () => {
      const imageData = Buffer.from("fake png");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "image/png"],
          ["content-length", String(imageData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      const result = await processTextForImages(
        ["Check this: ![error](https://example.com/error.png)"],
        tmpDir,
      );

      expect(result).toContain("## Attached Images");
      expect(result).toContain(".claws-images/img-1.png");
      expect(fs.existsSync(path.join(tmpDir, ".claws-images", "img-1.png"))).toBe(true);
    });

    it("combines images from multiple texts", async () => {
      const imageData = Buffer.from("fake png");
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        }),
      );

      const result = await processTextForImages(
        [
          "![first](https://example.com/a.png)",
          "![second](https://example.com/b.png)",
        ],
        tmpDir,
      );

      expect(result).toContain("img-1.png");
      expect(result).toContain("img-2.png");
    });

    it("filters null/empty texts", async () => {
      const result = await processTextForImages(["", "no images here"], tmpDir);
      expect(result).toBe("");
    });

    it("processes attachments alongside images", async () => {
      const imageData = Buffer.from("fake png");
      const textData = Buffer.from("log line 1\nlog line 2");
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Image fetch
          return Promise.resolve({
            ok: true,
            headers: new Map([
              ["content-type", "image/png"],
              ["content-length", String(imageData.length)],
            ]),
            arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
          });
        }
        // Attachment fetch
        return Promise.resolve({
          ok: true,
          headers: new Map([
            ["content-type", "application/octet-stream"],
            ["content-length", String(textData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength)),
        });
      });

      const result = await processTextForImages(
        [
          "![screenshot](https://example.com/error.png)",
          "[error.log](https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456)",
        ],
        tmpDir,
      );

      expect(result).toContain("## Attached Images");
      expect(result).toContain("## Attached Files");
      expect(result).toContain("log line 1");
    });

    it("processes attachments only (no images)", async () => {
      const textData = Buffer.from("some log content");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "text/plain"],
          ["content-length", String(textData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength)),
      });

      const result = await processTextForImages(
        ["[output.txt](https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456)"],
        tmpDir,
      );

      expect(result).not.toContain("## Attached Images");
      expect(result).toContain("## Attached Files");
      expect(result).toContain("some log content");
    });
  });

  describe("extractAttachmentUrls", () => {
    it("parses GitHub attachment links", () => {
      const text = "Here is the log: [error.log](https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456)";
      const result = extractAttachmentUrls(text);
      expect(result).toEqual([
        { url: "https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456", filename: "error.log" },
      ]);
    });

    it("excludes image links (! prefix)", () => {
      const text = "![screenshot](https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456)";
      const result = extractAttachmentUrls(text);
      expect(result).toEqual([]);
    });

    it("excludes non-GitHub URLs", () => {
      const text = "[file.log](https://example.com/some-file)";
      const result = extractAttachmentUrls(text);
      expect(result).toEqual([]);
    });

    it("deduplicates by URL", () => {
      const url = "https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456";
      const text = `[error.log](${url})\n[error.log](${url})`;
      const result = extractAttachmentUrls(text);
      expect(result).toHaveLength(1);
    });

    it("handles special characters in filenames", () => {
      const text = "[my file (2).log](https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456)";
      const result = extractAttachmentUrls(text);
      expect(result).toEqual([
        { url: "https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456", filename: "my file (2).log" },
      ]);
    });

    it("returns empty array when no attachments found", () => {
      const result = extractAttachmentUrls("Just plain text");
      expect(result).toEqual([]);
    });

    it("extracts multiple attachments", () => {
      const text = [
        "[error.log](https://github.com/user-attachments/assets/aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa)",
        "[debug.txt](https://github.com/user-attachments/assets/bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb)",
      ].join("\n");
      const result = extractAttachmentUrls(text);
      expect(result).toHaveLength(2);
      expect(result[0].filename).toBe("error.log");
      expect(result[1].filename).toBe("debug.txt");
    });
  });

  describe("isBinaryContentType", () => {
    it("rejects image types", () => {
      expect(isBinaryContentType("image/png")).toBe(true);
      expect(isBinaryContentType("image/jpeg")).toBe(true);
    });

    it("rejects video types", () => {
      expect(isBinaryContentType("video/mp4")).toBe(true);
    });

    it("rejects audio types", () => {
      expect(isBinaryContentType("audio/mpeg")).toBe(true);
    });

    it("allows text types", () => {
      expect(isBinaryContentType("text/plain")).toBe(false);
      expect(isBinaryContentType("text/html")).toBe(false);
    });

    it("allows application types", () => {
      expect(isBinaryContentType("application/json")).toBe(false);
      expect(isBinaryContentType("application/octet-stream")).toBe(false);
      expect(isBinaryContentType("application/xml")).toBe(false);
    });

    it("handles content-type with charset", () => {
      expect(isBinaryContentType("text/plain; charset=utf-8")).toBe(false);
      expect(isBinaryContentType("image/png; charset=binary")).toBe(true);
    });
  });

  describe("truncateContent", () => {
    it("returns content unchanged when under limit", () => {
      const { text, truncated } = truncateContent("short text");
      expect(text).toBe("short text");
      expect(truncated).toBe(false);
    });

    it("truncates content over limit with head+tail", () => {
      const content = "a".repeat(200_000);
      const { text, truncated } = truncateContent(content);
      expect(truncated).toBe(true);
      expect(text.length).toBeLessThan(content.length);
      expect(text).toContain("... [TRUNCATED — file too large] ...");
      // Head and tail should each be 50K chars
      expect(text.startsWith("a".repeat(100))).toBe(true);
      expect(text.endsWith("a".repeat(100))).toBe(true);
    });
  });

  describe("downloadAttachments", () => {
    it("downloads text attachment", async () => {
      const textData = Buffer.from("log content here");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "text/plain"],
          ["content-length", String(textData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength)),
      });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "error.log" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe("error.log");
      expect(result[0].content).toBe("log content here");
      expect(result[0].truncated).toBe(false);
    });

    it("skips binary content types", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "image/png"]]),
      });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "image.png" },
      ]);

      expect(result).toHaveLength(0);
    });

    it("allows application/octet-stream", async () => {
      const textData = Buffer.from("octet stream text");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "application/octet-stream"],
          ["content-length", String(textData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength)),
      });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "data.log" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].content).toBe("octet stream text");
    });

    it("skips non-UTF-8 content", async () => {
      // Invalid UTF-8 sequence
      const badData = Buffer.from([0xff, 0xfe, 0x80, 0x81]);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "application/octet-stream"],
          ["content-length", String(badData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(badData.buffer.slice(badData.byteOffset, badData.byteOffset + badData.byteLength)),
      });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "binary.dat" },
      ]);

      expect(result).toHaveLength(0);
    });

    it("respects max attachment count", async () => {
      const attachments = Array.from({ length: 8 }, (_, i) => ({
        url: `https://github.com/user-attachments/assets/id-${i}`,
        filename: `file-${i}.log`,
      }));

      const textData = Buffer.from("content");
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          headers: new Map([
            ["content-type", "text/plain"],
            ["content-length", String(textData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength)),
        }),
      );

      const result = await downloadAttachments(attachments);

      expect(result).toHaveLength(5);
      expect(mockFetch).toHaveBeenCalledTimes(5);
    });

    it("adds auth header", async () => {
      const textData = Buffer.from("content");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "text/plain"],
          ["content-length", String(textData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength)),
      });

      await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "test.log" },
      ]);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://github.com/user-attachments/assets/abc-123",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "token ghp_testtoken123" }),
        }),
      );
    });

    it("handles fetch errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "test.log" },
      ]);

      expect(result).toHaveLength(0);
    });

    it("handles HTTP error responses gracefully", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "test.log" },
      ]);

      expect(result).toHaveLength(0);
    });

    it("truncates large text content", async () => {
      const largeText = "x".repeat(200_000);
      const textData = Buffer.from(largeText);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "text/plain"],
          ["content-length", String(textData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(textData.buffer.slice(textData.byteOffset, textData.byteOffset + textData.byteLength)),
      });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "huge.log" },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].truncated).toBe(true);
      expect(result[0].content).toContain("... [TRUNCATED — file too large] ...");
    });
  });

  describe("buildAttachmentPromptSection", () => {
    it("formats correctly with attachments", () => {
      const result = buildAttachmentPromptSection([
        { filename: "error.log", content: "error line 1\nerror line 2", truncated: false },
      ]);

      expect(result).toContain("## Attached Files");
      expect(result).toContain("### error.log");
      expect(result).toContain("```log");
      expect(result).toContain("error line 1\nerror line 2");
    });

    it("returns empty string when no attachments", () => {
      expect(buildAttachmentPromptSection([])).toBe("");
    });

    it("shows truncation notice", () => {
      const result = buildAttachmentPromptSection([
        { filename: "big.log", content: "truncated content", truncated: true },
      ]);

      expect(result).toContain("### big.log (truncated)");
    });

    it("uses file extension as language hint", () => {
      const result = buildAttachmentPromptSection([
        { filename: "config.json", content: '{"key": "value"}', truncated: false },
      ]);

      expect(result).toContain("```json");
    });

    it("handles files without extension", () => {
      const result = buildAttachmentPromptSection([
        { filename: "Dockerfile", content: "FROM node", truncated: false },
      ]);

      expect(result).toContain("```\n");
    });

    it("uses dynamic fence length for content with backticks", () => {
      const result = buildAttachmentPromptSection([
        { filename: "test.md", content: "some ```code``` here", truncated: false },
      ]);

      // Should use longer fence since content contains ```
      expect(result).toContain("````");
    });
  });
});

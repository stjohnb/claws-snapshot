import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock github-app for installation token
const mockGetInstallationTokenForOwner = vi.fn();
const mockGetAnyInstallationToken = vi.fn();
vi.mock("./github-app.js", () => ({
  getInstallationTokenForOwner: (...args: unknown[]) => mockGetInstallationTokenForOwner(...args),
  getAnyInstallationToken: () => mockGetAnyInstallationToken(),
}));

// Mock github for commentOnIssue
const mockCommentOnIssue = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./github.js", () => ({
  commentOnIssue: (...args: unknown[]) => mockCommentOnIssue(...args),
}));

// Mock error-reporter to avoid pulling in heavy transitive imports
const mockReportFailedAttachments = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./error-reporter.js", () => ({
  reportFailedAttachments: (...args: unknown[]) => mockReportFailedAttachments(...args),
}));

// Mock node:dns so SSRF guard tests can control resolved IPs
const mockDnsLookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns", () => ({
  promises: { lookup: mockDnsLookup },
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Mock sharp for image resizing
const { mockSharp, mockSharpInstance } = vi.hoisted(() => {
  const mockSharpInstance = {
    metadata: vi.fn(),
    resize: vi.fn().mockReturnThis(),
    png: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn(),
  };
  const mockSharp = vi.fn(() => mockSharpInstance);
  return { mockSharp, mockSharpInstance };
});
vi.mock("sharp", () => ({ default: mockSharp }));

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
  assertPublicHost,
} from "./images.js";

describe("images", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks doesn't drain mockResolvedValueOnce queues; reset DNS and fetch
    // mocks explicitly so a leftover queued value from one test cannot leak into the next.
    mockDnsLookup.mockReset();
    mockFetch.mockReset();
    // Default: installation token returns a test token
    mockGetAnyInstallationToken.mockResolvedValue("ghs_testtoken123");
    mockGetInstallationTokenForOwner.mockResolvedValue("ghs_testtoken123");
    // Default: DNS resolves any hostname to a public IP so SSRF guard allows it.
    // example.com's real address; tests can override per-case.
    mockDnsLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    // Default: sharp returns small image (no resize needed)
    mockSharp.mockReturnValue(mockSharpInstance);
    mockSharpInstance.resize.mockReturnThis();
    mockSharpInstance.png.mockReturnThis();
    mockSharpInstance.jpeg.mockReturnThis();
    mockSharpInstance.metadata.mockResolvedValue({ width: 100, height: 100 });
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

    it("ignores markdown image syntax inside inline code spans", () => {
      const text = "see `![CI](...)` here";
      const result = extractImageUrls(text);
      expect(result).toEqual([]);
    });

    it("ignores markdown image syntax inside fenced code blocks", () => {
      const text = "before\n```\n![alt](http://example.com/a.png)\n```\nafter";
      const result = extractImageUrls(text);
      expect(result).toEqual([]);
    });

    it("ignores <img> tags inside <code> blocks (HTML body case)", () => {
      const text1 = '<code>&lt;img src="x"&gt;</code>';
      const text2 = '<code><img src="https://example.com/a.png"></code>';
      expect(extractImageUrls(text1)).toEqual([]);
      expect(extractImageUrls(text2)).toEqual([]);
    });

    it("rejects non-URL candidates like '...' even outside code spans", () => {
      const text = "![dots](...)";
      const result = extractImageUrls(text);
      expect(result).toEqual([]);
    });

    it("still parses a real image alongside a code-span false positive", () => {
      const text = "real ![ok](https://example.com/a.png) and quoted `![CI](...)`";
      const result = extractImageUrls(text);
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe("https://example.com/a.png");
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

      expect(result.downloaded).toHaveLength(1);
      expect(result.downloaded[0].localPath).toBe(".claws-images/img-1.png");
      expect(result.downloaded[0].alt).toBe("test");
      expect(result.failed).toEqual([]);
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

      expect(result.downloaded[0].localPath).toBe(".claws-images/img-1.jpg");
    });

    it("skips failed downloads gracefully", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      const result = await downloadImages(
        [{ url: "https://example.com/missing.png", alt: "" }],
        tmpDir,
      );

      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("https://example.com/missing.png");
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

      expect(result.downloaded).toHaveLength(0);
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

      expect(result.downloaded).toHaveLength(10);
      expect(mockFetch).toHaveBeenCalledTimes(10);
    });

    it("handles fetch errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const result = await downloadImages(
        [{ url: "https://example.com/img.png", alt: "" }],
        tmpDir,
      );

      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("https://example.com/img.png");
    });

    it("marks user-attachment URL as failed on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      const result = await downloadImages(
        [{ url: "https://github.com/user-attachments/assets/some-uuid", alt: "" }],
        tmpDir,
        "myorg",
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("https://github.com/user-attachments/assets/some-uuid");
    });

    it("does not add auth header for private-user-images.githubusercontent.com URLs", async () => {
      const imageData = Buffer.from("fake png data");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "image/png"],
          ["content-length", String(imageData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      await downloadImages(
        [{ url: "https://private-user-images.githubusercontent.com/123/img.png?jwt=tok", alt: "" }],
        tmpDir,
        "myorg",
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://private-user-images.githubusercontent.com/123/img.png?jwt=tok",
        expect.objectContaining({ headers: {} }),
      );
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
          headers: expect.objectContaining({ Authorization: "token ghs_testtoken123" }),
        }),
      );
    });

    it("adds auth header for user-attachments URLs", async () => {
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
        [{ url: "https://github.com/user-attachments/assets/some-uuid", alt: "" }],
        tmpDir,
        "myorg",
      );

      expect(mockFetch).toHaveBeenCalledWith(
        "https://github.com/user-attachments/assets/some-uuid",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "token ghs_testtoken123" }),
        }),
      );
    });

    describe("token-attachment security", () => {
      function makeImageResponse() {
        const imageData = Buffer.from("fake data");
        return {
          ok: true,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        };
      }

      it("does not attach token when host contains 'github.com' only as a suffix of another domain", async () => {
        mockFetch.mockResolvedValueOnce(makeImageResponse());

        await downloadImages(
          [{ url: "https://attacker.github.com.evil.example/x.png", alt: "" }],
          tmpDir,
          "myorg",
        );

        expect(mockFetch).toHaveBeenCalledWith(
          "https://attacker.github.com.evil.example/x.png",
          expect.objectContaining({ headers: {} }),
        );
      });

      it("does not attach token when 'github.com' appears only in query string", async () => {
        mockFetch.mockResolvedValueOnce(makeImageResponse());

        await downloadImages(
          [{ url: "https://attacker.example/?github.com", alt: "" }],
          tmpDir,
          "myorg",
        );

        expect(mockFetch).toHaveBeenCalledWith(
          "https://attacker.example/?github.com",
          expect.objectContaining({ headers: {} }),
        );
      });

      it("does not attach token when 'githubusercontent.com' appears only in path", async () => {
        mockFetch.mockResolvedValueOnce(makeImageResponse());

        await downloadImages(
          [{ url: "https://evil.example/githubusercontent.com.png", alt: "" }],
          tmpDir,
          "myorg",
        );

        expect(mockFetch).toHaveBeenCalledWith(
          "https://evil.example/githubusercontent.com.png",
          expect.objectContaining({ headers: {} }),
        );
      });

      it("does not attach token when URL fails to parse", async () => {
        mockFetch.mockRejectedValueOnce(new Error("invalid URL"));

        const result = await downloadImages(
          [{ url: "not a url", alt: "" }],
          tmpDir,
          "myorg",
        );

        // fetch is called (we pass the raw string through), but it rejects — URL is marked failed
        expect(result.failed).toContain("not a url");
        if (mockFetch.mock.calls.length > 0) {
          expect(mockFetch).toHaveBeenCalledWith(
            "not a url",
            expect.objectContaining({ headers: {} }),
          );
        }
      });

      it("does not attach token for non-https github.com URLs", async () => {
        mockFetch.mockResolvedValueOnce(makeImageResponse());

        await downloadImages(
          [{ url: "http://github.com/user-attachments/assets/abc", alt: "" }],
          tmpDir,
          "myorg",
        );

        expect(mockFetch).toHaveBeenCalledWith(
          "http://github.com/user-attachments/assets/abc",
          expect.objectContaining({ headers: {} }),
        );
      });

      it("does not attach token when 'private-user-images.githubusercontent.com' appears only in path of another host", async () => {
        mockFetch.mockResolvedValueOnce(makeImageResponse());

        await downloadImages(
          [{ url: "https://evil.example/private-user-images.githubusercontent.com/x.png", alt: "" }],
          tmpDir,
          "myorg",
        );

        expect(mockFetch).toHaveBeenCalledWith(
          "https://evil.example/private-user-images.githubusercontent.com/x.png",
          expect.objectContaining({ headers: {} }),
        );
      });
    });

    describe("image resizing", () => {
      it("resizes large images before saving", async () => {
        const originalData = Buffer.from("large fake png data");
        const resizedData = Buffer.from("resized png data");
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(originalData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(originalData.buffer.slice(originalData.byteOffset, originalData.byteOffset + originalData.byteLength)),
        });
        mockSharpInstance.metadata.mockResolvedValue({ width: 4000, height: 3000 });
        mockSharpInstance.toBuffer.mockResolvedValue(resizedData);

        const result = await downloadImages(
          [{ url: "https://example.com/large.png", alt: "big image" }],
          tmpDir,
        );

        expect(result.downloaded).toHaveLength(1);
        expect(mockSharpInstance.resize).toHaveBeenCalledWith(2048, 2048, { fit: "inside" });
        expect(mockSharpInstance.png).toHaveBeenCalled();
        const written = fs.readFileSync(path.join(tmpDir, "img-1.png"));
        expect(written).toEqual(resizedData);
      });

      it("does not resize small images", async () => {
        const imageData = Buffer.from("small png data");
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        });
        mockSharpInstance.metadata.mockResolvedValue({ width: 800, height: 600 });

        const result = await downloadImages(
          [{ url: "https://example.com/small.png", alt: "" }],
          tmpDir,
        );

        expect(result.downloaded).toHaveLength(1);
        expect(mockSharpInstance.resize).not.toHaveBeenCalled();
        const written = fs.readFileSync(path.join(tmpDir, "img-1.png"));
        expect(written).toEqual(imageData);
      });

      it("skips sharp entirely for SVG images", async () => {
        const svgData = Buffer.from("<svg></svg>");
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([
            ["content-type", "image/svg+xml"],
            ["content-length", String(svgData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(svgData.buffer.slice(svgData.byteOffset, svgData.byteOffset + svgData.byteLength)),
        });

        const result = await downloadImages(
          [{ url: "https://example.com/icon.svg", alt: "" }],
          tmpDir,
        );

        expect(result.downloaded).toHaveLength(1);
        expect(mockSharp).not.toHaveBeenCalled();
      });

      it("preserves PNG format for large PNG images", async () => {
        const imageData = Buffer.from("large png");
        const resizedData = Buffer.from("resized png");
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        });
        mockSharpInstance.metadata.mockResolvedValue({ width: 5000, height: 4000 });
        mockSharpInstance.toBuffer.mockResolvedValue(resizedData);

        await downloadImages(
          [{ url: "https://example.com/big.png", alt: "" }],
          tmpDir,
        );

        expect(mockSharpInstance.png).toHaveBeenCalled();
        expect(mockSharpInstance.jpeg).not.toHaveBeenCalled();
      });

      it("uses JPEG for large non-PNG images", async () => {
        const imageData = Buffer.from("large webp");
        const resizedData = Buffer.from("resized jpeg");
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([
            ["content-type", "image/webp"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        });
        mockSharpInstance.metadata.mockResolvedValue({ width: 3000, height: 2000 });
        mockSharpInstance.toBuffer.mockResolvedValue(resizedData);

        await downloadImages(
          [{ url: "https://example.com/big.webp", alt: "" }],
          tmpDir,
        );

        expect(mockSharpInstance.jpeg).toHaveBeenCalledWith({ quality: 85 });
        expect(mockSharpInstance.png).not.toHaveBeenCalled();
      });

      it("saves original image when resize fails", async () => {
        const imageData = Buffer.from("original png data");
        mockFetch.mockResolvedValueOnce({
          ok: true,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        });
        mockSharpInstance.metadata.mockRejectedValue(new Error("corrupt image"));

        const result = await downloadImages(
          [{ url: "https://example.com/corrupt.png", alt: "" }],
          tmpDir,
        );

        expect(result.downloaded).toHaveLength(1);
        const written = fs.readFileSync(path.join(tmpDir, "img-1.png"));
        expect(written).toEqual(imageData);
      });
    });
  });

  describe("assertPublicHost / SSRF guard", () => {
    it("rejects invalid URLs", async () => {
      await expect(assertPublicHost("not a url")).rejects.toThrow(/blocked: invalid URL/);
    });

    it("rejects non-http(s) protocols", async () => {
      await expect(assertPublicHost("file:///etc/passwd")).rejects.toThrow(/unsupported protocol/);
      await expect(assertPublicHost("ftp://example.com/x")).rejects.toThrow(/unsupported protocol/);
    });

    it("rejects literal IPv4 loopback", async () => {
      await expect(assertPublicHost("http://127.0.0.1/")).rejects.toThrow(/private address 127\.0\.0\.1/);
      await expect(assertPublicHost("http://127.255.255.254/")).rejects.toThrow(/private address/);
    });

    it("rejects literal IPv6 loopback", async () => {
      await expect(assertPublicHost("http://[::1]/")).rejects.toThrow(/private address/);
    });

    it("rejects IPv4 link-local (AWS/GCE metadata)", async () => {
      await expect(assertPublicHost("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(/private address/);
    });

    it("rejects IPv6 link-local", async () => {
      await expect(assertPublicHost("http://[fe80::1]/")).rejects.toThrow(/private address/);
    });

    it("rejects IPv4 RFC1918 ranges", async () => {
      await expect(assertPublicHost("http://10.0.0.1/")).rejects.toThrow(/private address/);
      await expect(assertPublicHost("http://172.16.0.1/")).rejects.toThrow(/private address/);
      await expect(assertPublicHost("http://172.31.255.255/")).rejects.toThrow(/private address/);
      await expect(assertPublicHost("http://192.168.1.1/")).rejects.toThrow(/private address/);
    });

    it("allows 172.x outside the /12 private range", async () => {
      // 172.15.x.x and 172.32.x.x are public
      await expect(assertPublicHost("http://172.15.0.1/")).resolves.toBeUndefined();
      await expect(assertPublicHost("http://172.32.0.1/")).resolves.toBeUndefined();
    });

    it("rejects IPv4 carrier-grade NAT", async () => {
      await expect(assertPublicHost("http://100.64.0.1/")).rejects.toThrow(/private address/);
      await expect(assertPublicHost("http://100.127.255.255/")).rejects.toThrow(/private address/);
    });

    it("allows 100.x outside CGNAT range", async () => {
      await expect(assertPublicHost("http://100.63.0.1/")).resolves.toBeUndefined();
      await expect(assertPublicHost("http://100.128.0.1/")).resolves.toBeUndefined();
    });

    it("rejects IPv6 unique-local addresses", async () => {
      await expect(assertPublicHost("http://[fd00::1]/")).rejects.toThrow(/private address/);
      await expect(assertPublicHost("http://[fc00::1]/")).rejects.toThrow(/private address/);
    });

    it("rejects IPv4 multicast and reserved", async () => {
      await expect(assertPublicHost("http://224.0.0.1/")).rejects.toThrow(/private address/);
      await expect(assertPublicHost("http://240.0.0.1/")).rejects.toThrow(/private address/);
    });

    it("rejects 0.0.0.0/8", async () => {
      await expect(assertPublicHost("http://0.0.0.0/")).rejects.toThrow(/private address/);
    });

    it("rejects IPv4-mapped IPv6 loopback", async () => {
      await expect(assertPublicHost("http://[::ffff:127.0.0.1]/")).rejects.toThrow(/private address/);
    });

    it("rejects IPv4-mapped IPv6 in hex form for loopback", async () => {
      // ::ffff:7f00:0001 = ::ffff:127.0.0.1
      await expect(assertPublicHost("http://[::ffff:7f00:1]/")).rejects.toThrow(/private address/);
    });

    it("allows IPv4-mapped public IPs", async () => {
      await expect(assertPublicHost("http://[::ffff:8.8.8.8]/")).resolves.toBeUndefined();
    });

    it("rejects 'localhost' by name without DNS lookup", async () => {
      await expect(assertPublicHost("http://localhost:6443/admin")).rejects.toThrow(/localhost/);
      expect(mockDnsLookup).not.toHaveBeenCalled();
    });

    it("rejects hostname whose DNS resolves to a private IP", async () => {
      mockDnsLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
      await expect(assertPublicHost("http://attacker.example/")).rejects.toThrow(/attacker\.example → 10\.0\.0\.5/);
    });

    it("rejects when any DNS record is private (multi-record case)", async () => {
      mockDnsLookup.mockResolvedValueOnce([
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]);
      await expect(assertPublicHost("http://multi.example/")).rejects.toThrow(/private address/);
    });

    it("allows hostname whose DNS resolves to a public IP", async () => {
      mockDnsLookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }]);
      await expect(assertPublicHost("http://public.example/")).resolves.toBeUndefined();
    });

    it("propagates DNS lookup failures (caller treats as fetch failure)", async () => {
      mockDnsLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
      await expect(assertPublicHost("http://nx.example/")).rejects.toThrow(/ENOTFOUND/);
    });
  });

  describe("downloadImages SSRF guard", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-ssrf-test-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("does not call fetch and marks URL failed when host is private", async () => {
      const result = await downloadImages(
        [{ url: "http://169.254.169.254/latest/meta-data/iam", alt: "" }],
        tmpDir,
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("http://169.254.169.254/latest/meta-data/iam");
    });

    it("does not follow a redirect to a private host", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: new Map([["location", "http://127.0.0.1/admin"]]),
      });
      const result = await downloadImages(
        [{ url: "https://example.com/redirect", alt: "" }],
        tmpDir,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("https://example.com/redirect");
    });

    it("follows a redirect to another public host and drops GitHub auth header", async () => {
      const imageData = Buffer.from("fake png");
      mockFetch
        .mockResolvedValueOnce({
          status: 302,
          headers: new Map([["location", "https://cdn.example.com/img.png"]]),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Map([
            ["content-type", "image/png"],
            ["content-length", String(imageData.length)],
          ]),
          arrayBuffer: () =>
            Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
        });

      const result = await downloadImages(
        [{ url: "https://user-images.githubusercontent.com/123/img.png", alt: "" }],
        tmpDir,
        "myorg",
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First hop: GitHub host → token attached
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://user-images.githubusercontent.com/123/img.png",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "token ghs_testtoken123" }),
          redirect: "manual",
        }),
      );
      // Second hop: not GitHub → empty headers (token NOT carried over)
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://cdn.example.com/img.png",
        expect.objectContaining({
          headers: {},
          redirect: "manual",
        }),
      );
      expect(result.downloaded).toHaveLength(1);
    });

    it("caps the redirect chain", async () => {
      mockFetch.mockResolvedValue({
        status: 302,
        headers: new Map([["location", "https://hop.example.com/next"]]),
      });

      const result = await downloadImages(
        [{ url: "https://example.com/start", alt: "" }],
        tmpDir,
      );

      // Initial fetch + 3 redirect hops = 4 fetch calls total; 4th redirect detection bails
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(result.failed).toContain("https://example.com/start");
    });

    it("fails when redirect lacks a Location header", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: new Map(),
      });

      const result = await downloadImages(
        [{ url: "https://example.com/bad-redirect", alt: "" }],
        tmpDir,
      );

      expect(result.failed).toContain("https://example.com/bad-redirect");
    });
  });

  describe("downloadAttachments SSRF guard", () => {
    it("does not call fetch and marks URL failed when host is private", async () => {
      const result = await downloadAttachments([
        { url: "http://10.0.0.1/admin", filename: "test.log" },
      ]);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("http://10.0.0.1/admin");
    });

    it("does not follow a redirect to a private host", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: new Map([["location", "http://169.254.169.254/"]]),
      });
      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "test.log" },
      ]);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(result.failed).toContain("https://github.com/user-attachments/assets/abc-123");
    });

    it("follows a redirect to another public host and drops GitHub auth header", async () => {
      const attachmentData = Buffer.from("fake attachment data");
      mockFetch
        .mockResolvedValueOnce({
          status: 302,
          headers: new Map([["location", "https://cdn.example.com/file.log"]]),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Map([
            ["content-type", "text/plain"],
            ["content-length", String(attachmentData.length)],
          ]),
          arrayBuffer: () =>
            Promise.resolve(attachmentData.buffer.slice(attachmentData.byteOffset, attachmentData.byteOffset + attachmentData.byteLength)),
        });

      const result = await downloadAttachments(
        [{ url: "https://github.com/user-attachments/assets/abc-123", filename: "test.log" }],
        "myorg",
      );

      expect(mockFetch).toHaveBeenCalledTimes(2);
      // First hop: GitHub host → token attached
      expect(mockFetch).toHaveBeenNthCalledWith(
        1,
        "https://github.com/user-attachments/assets/abc-123",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "token ghs_testtoken123" }),
          redirect: "manual",
        }),
      );
      // Second hop: not GitHub → empty headers (token NOT carried over)
      expect(mockFetch).toHaveBeenNthCalledWith(
        2,
        "https://cdn.example.com/file.log",
        expect.objectContaining({
          headers: {},
          redirect: "manual",
        }),
      );
      expect(result.downloaded).toHaveLength(1);
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

    it("posts comment when download fails and posting is provided", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      await processTextForImages(
        ["![screenshot](https://example.com/missing.png)"],
        tmpDir,
        undefined,
        { repo: "owner/repo", issueNumber: 42, agentName: "Planner" },
      );

      expect(mockCommentOnIssue).toHaveBeenCalledWith(
        "owner/repo",
        42,
        expect.stringContaining("https://example.com/missing.png"),
        { agentName: "Planner" },
      );
    });

    it("calls reportFailedAttachments when download fails and posting is provided", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      await processTextForImages(
        ["![screenshot](https://example.com/missing.png)"],
        tmpDir,
        undefined,
        { repo: "owner/repo", issueNumber: 42, agentName: "Planner" },
      );

      expect(mockReportFailedAttachments).toHaveBeenCalledOnce();
      expect(mockReportFailedAttachments).toHaveBeenCalledWith({
        sourceRepo: "owner/repo",
        sourceIssueNumber: 42,
        failedUrls: ["https://example.com/missing.png"],
        agentName: "Planner",
      });
    });

    it("posts comment and calls reportFailedAttachments for user-attachment failed URLs", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      await processTextForImages(
        ["[file.log](https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456)"],
        tmpDir,
        undefined,
        { repo: "owner/repo", issueNumber: 42, agentName: "Planner" },
      );

      expect(mockCommentOnIssue).toHaveBeenCalledWith(
        "owner/repo",
        42,
        expect.stringContaining("https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456"),
        { agentName: "Planner" },
      );
      expect(mockReportFailedAttachments).toHaveBeenCalledWith({
        sourceRepo: "owner/repo",
        sourceIssueNumber: 42,
        failedUrls: ["https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456"],
        agentName: "Planner",
      });
    });

    it("does not post comment when all downloads succeed", async () => {
      const imageData = Buffer.from("fake png");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "image/png"],
          ["content-length", String(imageData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      await processTextForImages(
        ["![screenshot](https://example.com/ok.png)"],
        tmpDir,
        undefined,
        { repo: "owner/repo", issueNumber: 42 },
      );

      expect(mockCommentOnIssue).not.toHaveBeenCalled();
      expect(mockReportFailedAttachments).not.toHaveBeenCalled();
    });

    it("does not post comment when no posting context provided", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      await processTextForImages(
        ["![screenshot](https://example.com/missing.png)"],
        tmpDir,
      );

      expect(mockCommentOnIssue).not.toHaveBeenCalled();
    });

    it("uses htmlBodies for image extraction when provided", async () => {
      const imageData = Buffer.from("fake png");
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([
          ["content-type", "image/png"],
          ["content-length", String(imageData.length)],
        ]),
        arrayBuffer: () => Promise.resolve(imageData.buffer.slice(imageData.byteOffset, imageData.byteOffset + imageData.byteLength)),
      });

      // texts has no image; htmlBodies has a pre-signed img tag with HTML-encoded ampersands
      const result = await processTextForImages(
        ["plain text with no images"],
        tmpDir,
        undefined,
        undefined,
        ['<img src="https://private-user-images.githubusercontent.com/123/img.png?jwt=tok&amp;v=4" alt="screenshot">'],
      );

      expect(result).toContain("## Attached Images");
      // URL must be decoded — &amp; → & — so the fetch uses the real pre-signed URL
      expect(mockFetch).toHaveBeenCalledWith(
        "https://private-user-images.githubusercontent.com/123/img.png?jwt=tok&v=4",
        expect.anything(),
      );
    });

    it("falls back to texts for image extraction when htmlBodies is empty", async () => {
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
        ["![error](https://example.com/error.png)"],
        tmpDir,
        undefined,
        undefined,
        [],
      );

      expect(result).toContain("## Attached Images");
    });

    it("falls back to texts when htmlBodies contains only empty strings", async () => {
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
        ["![error](https://example.com/error.png)"],
        tmpDir,
        undefined,
        undefined,
        [""],
      );

      expect(result).toContain("## Attached Images");
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

    it("ignores attachment links inside inline code spans", () => {
      const url = "https://github.com/user-attachments/assets/abc12345-1234-1234-1234-abcdef123456";
      const text = `see \`[file.log](${url})\` in code`;
      const result = extractAttachmentUrls(text);
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

      expect(result.downloaded).toHaveLength(1);
      expect(result.downloaded[0].filename).toBe("error.log");
      expect(result.downloaded[0].content).toBe("log content here");
      expect(result.downloaded[0].truncated).toBe(false);
      expect(result.failed).toEqual([]);
    });

    it("skips binary content types", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Map([["content-type", "image/png"]]),
      });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "image.png" },
      ]);

      expect(result.downloaded).toHaveLength(0);
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

      expect(result.downloaded).toHaveLength(1);
      expect(result.downloaded[0].content).toBe("octet stream text");
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

      expect(result.downloaded).toHaveLength(0);
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

      expect(result.downloaded).toHaveLength(5);
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
          headers: expect.objectContaining({ Authorization: "token ghs_testtoken123" }),
        }),
      );
    });

    it("handles fetch errors gracefully", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network error"));

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "test.log" },
      ]);

      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("https://github.com/user-attachments/assets/abc-123");
    });

    it("handles HTTP error responses gracefully (marks as failed)", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: new Map() });

      const result = await downloadAttachments([
        { url: "https://github.com/user-attachments/assets/abc-123", filename: "test.log" },
      ]);

      expect(result.downloaded).toHaveLength(0);
      expect(result.failed).toContain("https://github.com/user-attachments/assets/abc-123");
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

      expect(result.downloaded).toHaveLength(1);
      expect(result.downloaded[0].truncated).toBe(true);
      expect(result.downloaded[0].content).toContain("... [TRUNCATED — file too large] ...");
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

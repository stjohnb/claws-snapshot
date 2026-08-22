import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

vi.mock("./config.js", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  return { WORK_DIR: path.join(os.tmpdir(), "claws-session-upload-test") };
});
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import {
  sanitizeUploadFilename,
  sessionUploadDir,
  saveSessionUpload,
  saveSessionUploadStream,
  ensureSessionUploadDir,
  removeSessionUploadDir,
  MAX_UPLOAD_BYTES,
  MAX_FILES_PER_SESSION,
} from "./session-uploads.js";

const WORK_DIR = path.join(os.tmpdir(), "claws-session-upload-test");

describe("session-uploads", () => {
  beforeEach(() => {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  });

  describe("sanitizeUploadFilename", () => {
    it("strips path traversal to basename", () => {
      expect(sanitizeUploadFilename("../../etc/passwd")).toBe("passwd");
    });

    it("replaces disallowed characters", () => {
      expect(sanitizeUploadFilename("my screen shot.png")).toBe("my_screen_shot.png");
    });

    it("strips leading dots", () => {
      expect(sanitizeUploadFilename(".bashrc")).toBe("bashrc");
    });

    it("returns a fallback for an empty result", () => {
      expect(sanitizeUploadFilename("")).toBe("upload");
    });

    it("truncates long names to 80 chars", () => {
      const long = "a".repeat(200) + ".png";
      const result = sanitizeUploadFilename(long);
      expect(result.length).toBe(80);
    });
  });

  describe("saveSessionUpload", () => {
    it("writes the bytes under the session upload dir with a hex prefix", () => {
      const result = saveSessionUpload("abc123", "screenshot.png", Buffer.from("hello"));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(path.dirname(result.path)).toBe(sessionUploadDir("abc123"));
      const base = path.basename(result.path);
      expect(base).toMatch(/^[0-9a-f]{6}-screenshot\.png$/);
      expect(fs.readFileSync(result.path, "utf8")).toBe("hello");
    });

    it("rejects an oversize buffer", () => {
      const big = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
      const result = saveSessionUpload("abc123", "big.bin", big);
      expect(result).toEqual({ ok: false, reason: "too-large" });
    });

    it("rejects an empty buffer", () => {
      const result = saveSessionUpload("abc123", "empty.bin", Buffer.alloc(0));
      expect(result.ok).toBe(false);
    });

    it("rejects once the session has too many existing files", () => {
      const dir = ensureSessionUploadDir("abc123");
      for (let i = 0; i < MAX_FILES_PER_SESSION; i++) {
        fs.writeFileSync(path.join(dir, `existing-${i}`), "x");
      }
      const result = saveSessionUpload("abc123", "one-more.png", Buffer.from("x"));
      expect(result).toEqual({ ok: false, reason: "too-many" });
    });

    it("produces distinct files for two uploads of the same name", () => {
      const first = saveSessionUpload("abc123", "screenshot.png", Buffer.from("one"));
      const second = saveSessionUpload("abc123", "screenshot.png", Buffer.from("two"));
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error("expected ok");
      expect(first.path).not.toBe(second.path);
      expect(fs.readFileSync(first.path, "utf8")).toBe("one");
      expect(fs.readFileSync(second.path, "utf8")).toBe("two");
    });
  });

  describe("saveSessionUploadStream", () => {
    it("streams bytes to disk with a hex prefix", async () => {
      const result = await saveSessionUploadStream(
        "abc123",
        "big.bin",
        Readable.from([Buffer.from("hello "), Buffer.from("world")]),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(path.dirname(result.path)).toBe(sessionUploadDir("abc123"));
      const base = path.basename(result.path);
      expect(base).toMatch(/^[0-9a-f]{6}-big\.bin$/);
      expect(fs.readFileSync(result.path, "utf8")).toBe("hello world");
    });

    it("rejects an empty stream", async () => {
      const result = await saveSessionUploadStream("abc123", "empty.bin", Readable.from([]));
      expect(result.ok).toBe(false);
    });

    it("unlinks the partial file when the source stream errors mid-write", async () => {
      const source = new Readable({
        read() {
          this.push(Buffer.from("partial"));
          process.nextTick(() => this.destroy(new Error("boom")));
        },
      });
      const result = await saveSessionUploadStream("abc123", "fail.bin", source);
      expect(result).toEqual({ ok: false, reason: "write-failed", detail: expect.stringContaining("boom") });
      const dir = sessionUploadDir("abc123");
      expect(fs.readdirSync(dir).length).toBe(0);
    });
  });

  describe("removeSessionUploadDir", () => {
    it("removes the directory without throwing when absent", () => {
      expect(() => removeSessionUploadDir("nonexistent")).not.toThrow();
    });

    it("removes an existing directory", () => {
      const dir = ensureSessionUploadDir("abc123");
      expect(fs.existsSync(dir)).toBe(true);
      removeSessionUploadDir("abc123");
      expect(fs.existsSync(dir)).toBe(false);
    });
  });
});

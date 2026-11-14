import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  internalMcpTokenPath,
  writeInternalMcpTokenFile,
  readInternalMcpToken,
} from "./internal-mcp-token.js";

let dir: string;

afterEach(() => {
  if (dir) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("internal-mcp-token", () => {
  it("write-then-read round-trips the exact token", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-mcp-token-"));
    writeInternalMcpTokenFile(dir, "sekret-token-value");
    expect(readInternalMcpToken(dir, "fallback")).toBe("sekret-token-value");
  });

  it("writes the file with mode 0600", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-mcp-token-"));
    writeInternalMcpTokenFile(dir, "sekret-token-value");
    const stat = fs.statSync(internalMcpTokenPath(dir));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("overwrites on a second write (restart path) and stays 0600", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-mcp-token-"));
    writeInternalMcpTokenFile(dir, "first-token");
    writeInternalMcpTokenFile(dir, "second-token");
    expect(readInternalMcpToken(dir, "fallback")).toBe("second-token");
    const stat = fs.statSync(internalMcpTokenPath(dir));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns the fallback when the file does not exist", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-mcp-token-"));
    expect(readInternalMcpToken(dir, "fb")).toBe("fb");
  });

  it("returns the fallback when the file is empty", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-mcp-token-"));
    fs.writeFileSync(internalMcpTokenPath(dir), "");
    expect(readInternalMcpToken(dir, "fb")).toBe("fb");
  });

  it("returns the fallback when the file contains only whitespace", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-mcp-token-"));
    fs.writeFileSync(internalMcpTokenPath(dir), "   \n\t  ");
    expect(readInternalMcpToken(dir, "fb")).toBe("fb");
  });

  it("trims a trailing newline", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-mcp-token-"));
    fs.writeFileSync(internalMcpTokenPath(dir), "abc\n");
    expect(readInternalMcpToken(dir, "fb")).toBe("abc");
  });

  it("returns the fallback when workDir is empty (unset CLAWS_MCP_WORK_DIR)", () => {
    expect(readInternalMcpToken("", "fb")).toBe("fb");
  });
});

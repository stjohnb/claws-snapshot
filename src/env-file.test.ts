import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "./env-file.js";

describe("loadEnvFile", () => {
  let tmpDir: string;
  let envPath: string;
  const origEnv = { ...process.env };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-env-file-test-"));
    envPath = path.join(tmpDir, "env");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(origEnv)) {
      process.env[key] = value;
    }
  });

  it("sets a new var", () => {
    fs.writeFileSync(envPath, "NEW_VAR=hello\n");
    loadEnvFile(envPath);
    expect(process.env["NEW_VAR"]).toBe("hello");
  });

  it("overrides an existing var", () => {
    process.env["EXISTING_VAR"] = "old";
    fs.writeFileSync(envPath, "EXISTING_VAR=new\n");
    loadEnvFile(envPath);
    expect(process.env["EXISTING_VAR"]).toBe("new");
  });

  it("skips comments and blanks", () => {
    fs.writeFileSync(envPath, "# a comment\n\nVAR_A=1\n   \n# another\nVAR_B=2\n");
    loadEnvFile(envPath);
    expect(process.env["VAR_A"]).toBe("1");
    expect(process.env["VAR_B"]).toBe("2");
  });

  it("strips double-quoted and single-quoted values", () => {
    fs.writeFileSync(envPath, 'DQ="double"\nSQ=\'single\'\n');
    loadEnvFile(envPath);
    expect(process.env["DQ"]).toBe("double");
    expect(process.env["SQ"]).toBe("single");
  });

  it("preserves = inside a value", () => {
    fs.writeFileSync(envPath, "TOKEN=abc=def=ghi\n");
    loadEnvFile(envPath);
    expect(process.env["TOKEN"]).toBe("abc=def=ghi");
  });

  it("no-ops on a missing file", () => {
    expect(() => loadEnvFile(path.join(tmpDir, "does-not-exist"))).not.toThrow();
  });
});

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "./db.js";

const PINNED = { version: 17, sha256: "640538dc9294cd03f9e39feab6db556c8a14a337a9d6036e703ce45fd77aa604" };

function migrateSchemaBody(): string {
  const lines = readFileSync(new URL("./db.ts", import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("async function migrateSchema("));
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l === "}");
  return lines.slice(start, end < 0 ? undefined : end + 1).join("\n");
}

function fingerprint(body: string): string {
  const text = body
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(text).digest("hex");
}

describe("schema version pin", () => {
  it("extracts a real migrateSchema body", () => {
    const body = migrateSchemaBody();
    expect(body.length).toBeGreaterThan(0);
    expect(body).toContain("decided_by");
  });

  it("bumps SCHEMA_VERSION whenever migrateSchema changes", () => {
    expect(
      fingerprint(migrateSchemaBody()),
      "migrateSchema changed: bump SCHEMA_VERSION in src/db.ts, then set PINNED.version and PINNED.sha256 here",
    ).toBe(PINNED.sha256);
    expect(SCHEMA_VERSION).toBe(PINNED.version);
  });
});

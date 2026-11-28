import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatGapChangeBullets, gapAcceptanceChanges } from "./contract-gap-changes.js";

function policy(items: string[]): string {
  return ["# Observability", "", "### Known gaps", "", ...items, ""].join("\n");
}

describe("gapAcceptanceChanges", () => {
  let dir: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gap-changes-"));
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.test");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    write("docs/observability.md", policy([
      "- Accepted: no traces, single process.",
      "- Accepted: logs are plain text for now.",
      "- Not accepted yet.",
    ]));
    write("README.md", "# readme\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns added and reworded accepted or deferred items, skipping unchanged ones", async () => {
    write("docs/observability.md", policy([
      "- Accepted: no traces, single process.",
      "- Accepted: logs are plain text until the rewrite.",
      "- Not accepted yet.",
      "- Deferred until 2027-01-31: dashboard after the migration.",
      "- Accepted: no dashboard for a batch job. (waives: Dashboard)",
      "- Still not accepted.",
    ]));
    git("commit", "-q", "-am", "head");

    const changes = await gapAcceptanceChanges(dir, "main");

    expect(changes).toEqual([
      { path: "docs/observability.md", text: "Accepted: logs are plain text until the rewrite.", state: "accepted", waives: [] },
      { path: "docs/observability.md", text: "Deferred until 2027-01-31: dashboard after the migration.", state: "deferred", waives: [] },
      { path: "docs/observability.md", text: "Accepted: no dashboard for a batch job. (waives: Dashboard)", state: "accepted", waives: ["Dashboard"] },
    ]);
    expect(formatGapChangeBullets(changes).at(-1)).toBe(
      "- `docs/observability.md`: Accepted: no dashboard for a batch job. (waives: Dashboard) — Waives: Dashboard");
  });

  it("counts every accepted item of a new file and nothing for an untouched one", async () => {
    write("docs/security.md", ["# Security", "", "### Known gaps", "", "- Accepted: no CSP, internal only.", ""].join("\n"));
    write("README.md", "# readme\n\nmore\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");

    expect(await gapAcceptanceChanges(dir, "main")).toEqual([
      { path: "docs/security.md", text: "Accepted: no CSP, internal only.", state: "accepted", waives: [] },
    ]);
  });

  it("returns nothing when no accepted or deferred item changed", async () => {
    write("docs/observability.md", policy([
      "- Accepted: no traces, single process.",
      "- Accepted: logs are plain text for now.",
      "- Not accepted yet, reworded.",
    ]));
    git("commit", "-q", "-am", "head");

    expect(await gapAcceptanceChanges(dir, "main")).toEqual([]);
  });
});

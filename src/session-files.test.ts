import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

vi.mock("./config.js", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    DB_PATH: ":memory:",
    DATABASE_URL: "",
    DATABASE_PASSWORD: "",
    WORK_DIR: path.join(os.tmpdir(), "claws-session-files-test"),
  };
});
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import { initDb, closeDb, insertSession, listSessionFiles, deletePersistedSession } from "./db.js";
import { MAX_UPLOAD_BYTES } from "./session-uploads-core.js";
import {
  storeSessionFile,
  readSessionFile,
  deleteSessionFiles,
  describeSessionFile,
  describeSessionFiles,
  sessionFileFamily,
  uniqueSessionFileName,
  guessSessionFileContentType,
  sessionFileDir,
} from "./session-files.js";

const WORK_DIR = path.join(os.tmpdir(), "claws-session-files-test");
const SID = "abc123";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

async function addSession(id: string): Promise<void> {
  await insertSession({
    id, tmux_name: `claws-${id}`, mode: "repo-claude", repo: "org/repo", cwd: "/home/claws/work/org/repo",
    worktree_path: null, extra_worktrees: null, capabilities: null, created_at: Date.now(),
    summary: null, summary_updated_at: null, provider: "claude", model: null,
  });
}

beforeEach(async () => {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  await initDb();
  await addSession(SID);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

describe("storeSessionFile", () => {
  it("stores the exact bytes under the session's directory and records them", async () => {
    const result = await storeSessionFile(SID, "chart.png", Readable.from([PNG.subarray(0, 4), PNG.subarray(4)]));
    if (!result.ok) throw new Error(`store failed: ${result.reason}`);
    expect(result.row).toMatchObject({ session_id: SID, filename: "chart.png", content_type: "image/png", size: PNG.length });
    expect(result.row.id).toMatch(/^csf_[0-9A-Z]{26}$/);

    const found = await readSessionFile(result.row.id);
    expect(found).toBeDefined();
    expect(path.dirname(found!.absolutePath)).toBe(sessionFileDir(SID));
    expect(fs.readFileSync(found!.absolutePath).equals(PNG)).toBe(true);
    expect(await listSessionFiles(SID)).toHaveLength(1);
  });

  it("keeps two publishes of the same name as separate files with distinct names", async () => {
    const a = await storeSessionFile(SID, "out.txt", Readable.from([Buffer.from("one")]));
    const b = await storeSessionFile(SID, "out.txt", Readable.from([Buffer.from("two")]));
    expect(a.ok && b.ok).toBe(true);
    const rows = await listSessionFiles(SID);
    expect(rows.map((r) => r.filename)).toEqual(["out.txt", "out-2.txt"]);
    expect(new Set(rows.map((r) => r.stored_path)).size).toBe(2);
  });

  it("refuses a file over the 10 MB limit and leaves nothing behind", async () => {
    const big = Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES), Buffer.alloc(1)]);
    const result = await storeSessionFile(SID, "big.bin", big);
    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(await listSessionFiles(SID)).toEqual([]);
    expect(fs.readdirSync(sessionFileDir(SID))).toEqual([]);
  });

  it("refuses a session id that could escape the store", async () => {
    const result = await storeSessionFile("../evil", "a.txt", Readable.from([Buffer.from("x")]));
    expect(result).toMatchObject({ ok: false, reason: "write-failed" });
  });
});

describe("readSessionFile", () => {
  it("refuses a row whose stored path escapes the store", async () => {
    const result = await storeSessionFile(SID, "a.txt", Readable.from([Buffer.from("x")]));
    if (!result.ok) throw new Error("store failed");
    const { _rawDb } = await import("./db.js");
    await _rawDb().run(`UPDATE session_files SET stored_path = ? WHERE id = ?`, ["issue-attachments/x/a.txt", result.row.id]);
    expect(await readSessionFile(result.row.id)).toBeUndefined();
  });
});

describe("deleteSessionFiles", () => {
  it("removes the session's rows and directory, leaving other sessions' files", async () => {
    await addSession("def456");
    await storeSessionFile(SID, "a.txt", Readable.from([Buffer.from("a")]));
    const other = await storeSessionFile("def456", "b.txt", Readable.from([Buffer.from("b")]));
    await deleteSessionFiles(SID);
    expect(await listSessionFiles(SID)).toEqual([]);
    expect(fs.existsSync(sessionFileDir(SID))).toBe(false);
    expect(await listSessionFiles("def456")).toHaveLength(1);
    expect(other.ok && fs.existsSync((await readSessionFile(other.row.id))!.absolutePath)).toBe(true);
  });

  it("finishes the job after the session row is gone", async () => {
    await storeSessionFile(SID, "a.txt", Readable.from([Buffer.from("a")]));
    await deletePersistedSession(SID);
    await deleteSessionFiles(SID);
    expect(await listSessionFiles(SID)).toEqual([]);
    expect(fs.existsSync(sessionFileDir(SID))).toBe(false);
  });
});

describe("describeSessionFile", () => {
  it("links the file under its own session, with a forced-download variant", async () => {
    const result = await storeSessionFile(SID, "my chart.png", Readable.from([PNG]));
    if (!result.ok) throw new Error("store failed");
    const view = describeSessionFile(result.row);
    expect(view).toMatchObject({ name: "my_chart.png", size: PNG.length, isImage: true, contentType: "image/png" });
    expect(view.url).toBe(`/sessions/${SID}/files/${result.row.id}/my_chart.png`);
    expect(view.downloadUrl).toBe(`${view.url}?download=1`);
  });

  it("never treats SVG or an unknown extension as an inline image", () => {
    expect(guessSessionFileContentType("x.svg")).toBe("image/svg+xml");
    expect(describeSessionFile({ id: "csf_X", session_id: SID, filename: "x.svg", stored_path: "", content_type: "image/svg+xml", size: 1, created_at: "" }).isImage).toBe(false);
    expect(guessSessionFileContentType("deploy.sh")).toBe("application/octet-stream");
    expect(guessSessionFileContentType("PHOTO.JPG")).toBe("image/jpeg");
  });
});

describe("uniqueSessionFileName", () => {
  it("keeps a free name and numbers a clash before the last extension", () => {
    expect(uniqueSessionFileName("a.sh", [])).toBe("a.sh");
    expect(uniqueSessionFileName("a.sh", ["a.sh"])).toBe("a-2.sh");
    expect(uniqueSessionFileName("a.sh", ["a.sh", "a-2.sh"])).toBe("a-3.sh");
    expect(uniqueSessionFileName("Foo.sh", ["foo.sh"])).toBe("Foo-2.sh");
    expect(uniqueSessionFileName("README", ["README"])).toBe("README-2");
    expect(uniqueSessionFileName("a.tar.gz", ["a.tar.gz"])).toBe("a.tar-2.gz");
  });

  it("stays within 80 characters by truncating the stem", () => {
    const long = "x".repeat(76) + ".sh";
    const out = uniqueSessionFileName(long, [long]);
    expect(out.length).toBe(80);
    expect(out.endsWith("-2.sh")).toBe(true);
  });
});

describe("duplicate publishes", () => {
  it("gives two publishes of one name distinct filenames and keeps both files", async () => {
    const a = await storeSessionFile(SID, "x.sh", Readable.from([Buffer.from("one")]));
    const b = await storeSessionFile(SID, "x.sh", Readable.from([Buffer.from("two")]));
    if (!a.ok || !b.ok) throw new Error("store failed");
    expect(a.row.filename).toBe("x.sh");
    expect(b.row.filename).toBe("x-2.sh");
    expect(b.requestedName).toBe("x.sh");
    expect(fs.readFileSync(path.join(WORK_DIR, a.row.stored_path), "utf8")).toBe("one");
    expect(fs.readFileSync(path.join(WORK_DIR, b.row.stored_path), "utf8")).toBe("two");
  });

  it("serialises concurrent publishes so names stay distinct", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => storeSessionFile(SID, "y.sh", Readable.from([Buffer.from(String(n))]))));
    const names = results.map((r) => (r.ok ? r.row.filename : "failed"));
    expect(new Set(names).size).toBe(3);
  });
});

describe("describeSessionFiles", () => {
  const mk = (id: string, filename: string, created_at: string) =>
    ({ id, session_id: SID, filename, stored_path: "", content_type: "text/plain", size: 1, created_at });

  it("derives families and publish times", () => {
    expect(sessionFileFamily("Deploy-3.sh")).toBe("deploy.sh");
    expect(sessionFileFamily("v-1.sh")).toBe("v-1.sh");
  });

  it("marks only the newest of a family and nothing for distinct names", () => {
    const views = describeSessionFiles([
      mk("csf_1", "x.sh", "2020-01-02 03:04:05"), mk("csf_2", "other.txt", "2020-01-02 03:05:00"), mk("csf_3", "x-2.sh", "2020-01-02 03:06:00"),
    ]);
    expect(views.map((v) => v.latest)).toEqual([false, false, true]);
    expect(views[0]).toMatchObject({ publishedAt: "2020-01-02T03:04:05.000Z", publishedLabel: "2020-01-02 03:04 UTC" });
    expect(describeSessionFiles([mk("csf_1", "a.txt", "2020-01-02 03:04:05"), mk("csf_2", "b.txt", "2020-01-02 03:04:06")]).some((v) => v.latest)).toBe(false);
  });

  it("labels a file published today by time only", () => {
    const now = new Date().toISOString();
    const v = describeSessionFile(mk("csf_1", "a.txt", now.slice(0, 19).replace("T", " ")));
    expect(v.publishedLabel).toBe(`${now.slice(11, 19)} UTC`);
  });
});

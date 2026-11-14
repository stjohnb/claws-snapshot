import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

// The attachments bucket: `config` toggles ATTACHMENTS_S3, `objects` is the stubbed S3Client's whole store.
const s3 = vi.hoisted(() => ({
  config: null as null | { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string },
  objects: new Map<string, { data: Buffer; contentType: string }>(),
}));
vi.mock("./config.js", async () => {
  const os = await import("node:os");
  const path = await import("node:path");
  return {
    DB_PATH: ":memory:",
    DATABASE_URL: "",
    DATABASE_PASSWORD: "",
    WORK_DIR: path.join(os.tmpdir(), "claws-session-attachments-test"),
    get ATTACHMENTS_S3() {
      return s3.config;
    },
  };
});
vi.mock("./pages-s3.js", async () => {
  const fs = await import("node:fs");
  return {
    S3Client: class {
      async putObjectFromFile(key: string, filePath: string, _size: number, contentType: string): Promise<void> {
        s3.objects.set(key, { data: fs.readFileSync(filePath), contentType });
      }
      async getObjectStream(key: string) {
        const obj = s3.objects.get(key);
        if (!obj) return { status: 404, body: null, contentLength: null };
        return { status: 200, body: new Response(new Uint8Array(obj.data)).body, contentLength: obj.data.length };
      }
      async deleteObject(key: string): Promise<void> {
        s3.objects.delete(key);
      }
    },
  };
});
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./session-pod-launch.js", () => ({ POD_UPLOAD_DIR: "/home/claws/.claws-session/uploads" }));

import { initDb, closeDb, insertSession, deletePersistedSession, getSessionAttachment, listSessionAttachments } from "./db.js";
import {
  stageSessionAttachment,
  stageSessionAttachmentStream,
  findPendingSessionAttachments,
  claimSessionAttachments,
  releaseSessionAttachments,
  composeInitialPrompt,
  openSessionAttachment,
  deleteSessionAttachment,
  deleteSessionAttachments,
  sweepPendingSessionAttachments,
  newPodAttachmentName,
  isSessionAttachmentId,
  PENDING_SESSION_ATTACHMENT_TTL_MS,
} from "./session-attachments.js";
import type { SessionAttachmentRow } from "./db.js";

const WORK_DIR = path.join(os.tmpdir(), "claws-session-attachments-test");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function addSession(id: string): Promise<void> {
  await insertSession({
    id, tmux_name: `claws-${id}`, mode: "repo-claude", repo: "org/repo", cwd: "/home/claws/work/org/repo",
    worktree_path: null, extra_worktrees: null, capabilities: null, created_at: Date.now(),
    summary: null, summary_updated_at: null, provider: "claude", model: null,
  });
}

function mustStage(result: Awaited<ReturnType<typeof stageSessionAttachment>>): SessionAttachmentRow {
  if (!result.ok) throw new Error(`stage failed: ${result.reason}`);
  return result.row;
}

async function readAll(row: SessionAttachmentRow): Promise<Buffer | null> {
  const opened = await openSessionAttachment(row);
  return opened ? Buffer.from(await new Response(opened.body).arrayBuffer()) : null;
}

beforeEach(async () => {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  s3.config = null;
  s3.objects.clear();
  await initDb();
  await addSession("abc123");
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

describe("session-attachments", () => {
  it("stages a file as a pending row under the pending dir and reads it back", async () => {
    const row = mustStage(await stageSessionAttachment("board shot.png", PNG, "image/png; charset=x"));
    expect(row).toMatchObject({ session_id: null, pod_name: null, filename: "board_shot.png", storage: "fs", content_type: "image/png", size: PNG.length });
    expect(isSessionAttachmentId(row.id)).toBe(true);
    expect(row.stored_path.startsWith(path.join("session-attachments", "pending") + path.sep)).toBe(true);
    expect(await readAll(row)).toEqual(PNG);
    expect(await getSessionAttachment(row.id)).toEqual(row);
  });

  it("refuses empty and oversized files, as the terminal does", async () => {
    expect(await stageSessionAttachment("empty.txt", Buffer.alloc(0), "text/plain")).toMatchObject({ ok: false, reason: "write-failed", detail: "empty file" });
    expect(await stageSessionAttachment("big.bin", Buffer.alloc(10 * 1024 * 1024 + 1), undefined)).toMatchObject({ ok: false, reason: "too-large" });
    expect(await stageSessionAttachmentStream("empty.txt", Readable.from([]), undefined)).toMatchObject({ ok: false, detail: "empty file" });
    expect(fs.readdirSync(path.join(WORK_DIR, "session-attachments", "pending"))).toEqual([]);
  });

  it("stages a streamed body", async () => {
    const row = mustStage(await stageSessionAttachmentStream("log.txt", Readable.from([Buffer.from("line 1\n"), Buffer.from("line 2\n")]), "text/plain"));
    expect(row.size).toBe(14);
    expect((await readAll(row))!.toString()).toBe("line 1\nline 2\n");
  });

  it("stages into the bucket under the row's own id when one is configured", async () => {
    s3.config = { endpoint: "http://s3", region: "r", bucket: "b", accessKeyId: "a", secretAccessKey: "s" };
    const row = mustStage(await stageSessionAttachment("shot.png", PNG, "image/png"));
    expect(row).toMatchObject({ storage: "s3", stored_path: `${row.id}/shot.png` });
    expect(s3.objects.get(`${row.id}/shot.png`)!.data).toEqual(PNG);
    expect(await readAll(row)).toEqual(PNG);
    await deleteSessionAttachment(row.id);
    expect(s3.objects.size).toBe(0);
    expect(await getSessionAttachment(row.id)).toBeUndefined();
  });

  it("claims pending rows with their pod names, once, and releases them", async () => {
    const a = mustStage(await stageSessionAttachment("a.png", PNG, "image/png"));
    const b = mustStage(await stageSessionAttachment("b.log", PNG, "text/plain"));
    expect(await findPendingSessionAttachments([a.id, b.id])).toEqual([a, b]);
    const claims = [{ id: a.id, podName: newPodAttachmentName(a.filename) }, { id: b.id, podName: newPodAttachmentName(b.filename) }];
    expect(claims[0]!.podName).toMatch(/^[0-9a-f]{6}-a\.png$/);
    const claimed = await claimSessionAttachments(claims, "abc123");
    expect(claimed!.map((r) => [r.id, r.session_id, r.pod_name])).toEqual([[a.id, "abc123", claims[0]!.podName], [b.id, "abc123", claims[1]!.podName]]);
    expect(await findPendingSessionAttachments([a.id])).toBeNull();

    // A second create naming an already-claimed file gets nothing and claims nothing.
    await addSession("def456");
    const c = mustStage(await stageSessionAttachment("c.png", PNG, "image/png"));
    expect(await claimSessionAttachments([{ id: c.id, podName: "x-c.png" }, { id: a.id, podName: "x-a.png" }], "def456")).toBeNull();
    expect((await getSessionAttachment(c.id))!.session_id).toBeNull();
    expect((await getSessionAttachment(a.id))!.session_id).toBe("abc123");

    await releaseSessionAttachments("abc123");
    expect(await findPendingSessionAttachments([a.id, b.id])).toHaveLength(2);
  });

  it("finds nothing for an unknown or malformed id", async () => {
    expect(await findPendingSessionAttachments(["sat_01M617FXR2G2Q62972WCFY57HA"])).toBeNull();
    expect(await findPendingSessionAttachments(["../../etc/passwd"])).toBeNull();
    expect(await findPendingSessionAttachments([])).toEqual([]);
  });

  it("composes the first message: prompt, blank line, one path per line; paths alone without a prompt", () => {
    expect(composeInitialPrompt("Look at this", ["abcdef-a.png", "012345-b.log"]))
      .toBe("Look at this\n\n/home/claws/.claws-session/uploads/abcdef-a.png\n/home/claws/.claws-session/uploads/012345-b.log");
    expect(composeInitialPrompt(null, ["abcdef-a.png"])).toBe("/home/claws/.claws-session/uploads/abcdef-a.png");
    expect(composeInitialPrompt("Just text", [])).toBe("Just text");
    expect(composeInitialPrompt(null, [])).toBeNull();
  });

  it("deletes a session's files and rows, and a session delete afterwards leaves nothing behind", async () => {
    const a = mustStage(await stageSessionAttachment("a.png", PNG, "image/png"));
    const file = path.join(WORK_DIR, a.stored_path);
    await claimSessionAttachments([{ id: a.id, podName: "abcdef-a.png" }], "abc123");
    expect(fs.existsSync(file)).toBe(true);
    await deleteSessionAttachments("abc123");
    expect(fs.existsSync(file)).toBe(false);
    expect(await listSessionAttachments("abc123")).toEqual([]);

    // The FK cascades rows with the session.
    const b = mustStage(await stageSessionAttachment("b.png", PNG, "image/png"));
    await claimSessionAttachments([{ id: b.id, podName: "abcdef-b.png" }], "abc123");
    await deletePersistedSession("abc123");
    expect(await getSessionAttachment(b.id)).toBeUndefined();
  });

  it("sweeps only pending rows older than the TTL", async () => {
    const old = mustStage(await stageSessionAttachment("old.png", PNG, "image/png"));
    const claimedOld = mustStage(await stageSessionAttachment("kept.png", PNG, "image/png"));
    await claimSessionAttachments([{ id: claimedOld.id, podName: "abcdef-kept.png" }], "abc123");
    const fresh = Date.now();
    expect(await sweepPendingSessionAttachments(fresh)).toBe(0);
    expect(await sweepPendingSessionAttachments(fresh + PENDING_SESSION_ATTACHMENT_TTL_MS + 2_000)).toBe(1);
    expect(await getSessionAttachment(old.id)).toBeUndefined();
    expect(fs.existsSync(path.join(WORK_DIR, old.stored_path))).toBe(false);
    expect(await getSessionAttachment(claimedOld.id)).toBeDefined();
  });

  it("refuses to read a row whose stored path escapes the store", async () => {
    const row = mustStage(await stageSessionAttachment("a.png", PNG, "image/png"));
    expect(await openSessionAttachment({ ...row, stored_path: "../../etc/passwd" })).toBeNull();
    expect(await openSessionAttachment({ ...row, storage: "s3", stored_path: "other/a.png" })).toBeNull();
  });
});

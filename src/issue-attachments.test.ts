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
    WORK_DIR: path.join(os.tmpdir(), "claws-issue-attachments-test"),
  };
});
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
const mockRemoteAttachmentReader = vi.hoisted(() => vi.fn((): ((id: string, signal?: AbortSignal) => Promise<Response>) | null => null));
vi.mock("./db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./db.js")>()),
  remoteAttachmentReader: () => mockRemoteAttachmentReader(),
}));

import { getIssueAttachmentRows } from "./diagnostic-queries.js";
import { resolveIssueAttachmentPath } from "./session-uploads-core.js";
import { initDb, closeDb, _rawDb, createShadowIssue, createClawsIssue, getClawsIssueAttachment, listClawsIssueAttachments, setClawsIssueAttachmentStoredPath } from "./db.js";
import {
  storeIssueAttachment,
  storeIssueAttachmentStream,
  readIssueAttachment,
  attachmentFileResponse,
  deleteIssueAttachment,
  deleteIssueAttachmentFiles,
  claimPendingAttachments,
  sweepPendingAttachments,
  issueAttachmentDir,
  attachmentUrl,
  parseAttachmentUrl,
  serveContentType,
  contentDisposition,
  PENDING_TTL_MS,
} from "./issue-attachments.js";

const WORK_DIR = path.join(os.tmpdir(), "claws-issue-attachments-test");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let issueId: string;

beforeEach(async () => {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  await initDb();
  issueId = await createClawsIssue({ title: "T", authorLogin: "stjohnb" });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

function mustStore(result: Awaited<ReturnType<typeof storeIssueAttachment>>) {
  if (!result.ok) throw new Error(`store failed: ${result.reason}`);
  return result.row;
}

describe("issue-attachments store", () => {
  it("round-trips a file through store, read and delete", async () => {
    const row = mustStore(await storeIssueAttachment(issueId, "shot.png", PNG, "image/png", "stjohnb"));
    expect(row).toMatchObject({ issue_id: issueId, filename: "shot.png", content_type: "image/png", size: PNG.length, uploader_login: "stjohnb", comment_id: null });
    expect(row.id).toMatch(/^cla_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(path.isAbsolute(row.stored_path)).toBe(false);
    expect(row.stored_path.startsWith(path.join("issue-attachments", issueId) + path.sep)).toBe(true);

    const found = await readIssueAttachment(row.id);
    expect(found?.row.id).toBe(row.id);
    expect(fs.readFileSync(found!.absolutePath)).toEqual(PNG);
    expect(fs.statSync(found!.absolutePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(issueAttachmentDir(issueId)).mode & 0o777).toBe(0o700);

    expect(await deleteIssueAttachment(row.id)).toBe(true);
    expect(await getClawsIssueAttachment(row.id)).toBeUndefined();
    expect(fs.existsSync(found!.absolutePath)).toBe(false);
    expect(await deleteIssueAttachment(row.id)).toBe(false);
  });

  it("tolerates a file that is already gone on delete", async () => {
    const row = mustStore(await storeIssueAttachment(issueId, "a.txt", Buffer.from("hi"), "text/plain", "stjohnb"));
    fs.rmSync(path.join(WORK_DIR, row.stored_path));
    expect(await deleteIssueAttachment(row.id)).toBe(true);
  });

  it("stores a streamed upload and records its size", async () => {
    const data = Buffer.alloc(4096, 7);
    const result = await storeIssueAttachmentStream(issueId, "blob.bin", Readable.from([data]), undefined, "stjohnb");
    const row = mustStore(result);
    expect(row.size).toBe(4096);
    expect(row.content_type).toBe("application/octet-stream");
  });

  it("sanitises the filename with sanitizeUploadFilename", async () => {
    const row = mustStore(await storeIssueAttachment(issueId, "../../my shot.png", PNG, "IMAGE/PNG; charset=binary", "stjohnb"));
    expect(row.filename).toBe("my_shot.png");
    expect(row.content_type).toBe("image/png");
    expect(path.basename(row.stored_path)).toMatch(/^[0-9a-f]{6}-my_shot\.png$/);
  });

  it("refuses a row whose stored path escapes the store", async () => {
    const row = mustStore(await storeIssueAttachment(issueId, "a.txt", Buffer.from("hi"), "text/plain", "stjohnb"));
    await setClawsIssueAttachmentStoredPath(row.id, "../../etc/passwd");
    expect(await readIssueAttachment(row.id)).toBeUndefined();
  });

  it("claims pending uploads: moves the file and rewrites stored_path", async () => {
    const pending = mustStore(await storeIssueAttachment(null, "doc.zip", Buffer.from("PK\x03\x04"), "application/zip", "stjohnb"));
    expect(pending.issue_id).toBeNull();
    expect(pending.stored_path.startsWith(path.join("issue-attachments", "pending") + path.sep)).toBe(true);
    const oldPath = path.join(WORK_DIR, pending.stored_path);

    const [claimed] = await claimPendingAttachments([pending.id], issueId);
    expect(claimed).toMatchObject({ id: pending.id, issue_id: issueId });
    expect(claimed!.stored_path.startsWith(path.join("issue-attachments", issueId) + path.sep)).toBe(true);
    expect(fs.existsSync(oldPath)).toBe(false);
    expect(fs.existsSync(path.join(WORK_DIR, claimed!.stored_path))).toBe(true);
    expect((await getClawsIssueAttachment(pending.id))?.stored_path).toBe(claimed!.stored_path);

    // Already owned — a second claim, for any issue, takes nothing.
    const other = await createClawsIssue({ title: "Other", authorLogin: "stjohnb" });
    expect(await claimPendingAttachments([pending.id], other)).toEqual([]);
    expect((await listClawsIssueAttachments(issueId)).map((r) => r.id)).toEqual([pending.id]);
  });

  it("sweeps pending uploads older than a day and leaves fresh and claimed ones", async () => {
    const stale = mustStore(await storeIssueAttachment(null, "old.png", PNG, "image/png", "stjohnb"));
    const owned = mustStore(await storeIssueAttachment(issueId, "keep.png", PNG, "image/png", "stjohnb"));
    const later = Date.now() + PENDING_TTL_MS + 60_000;
    expect(await sweepPendingAttachments(later)).toBe(1);
    expect(await getClawsIssueAttachment(stale.id)).toBeUndefined();
    expect(fs.existsSync(path.join(WORK_DIR, stale.stored_path))).toBe(false);
    expect(await getClawsIssueAttachment(owned.id)).toBeDefined();

    const fresh = mustStore(await storeIssueAttachment(null, "new.png", PNG, "image/png", "stjohnb"));
    expect(await sweepPendingAttachments()).toBe(0);
    expect(await getClawsIssueAttachment(fresh.id)).toBeDefined();
  });

  it("removes an issue's whole directory with deleteIssueAttachmentFiles", async () => {
    mustStore(await storeIssueAttachment(issueId, "a.png", PNG, "image/png", "stjohnb"));
    deleteIssueAttachmentFiles(issueId);
    expect(fs.existsSync(issueAttachmentDir(issueId))).toBe(false);
  });
});


describe("attachmentFileResponse", () => {
  beforeEach(() => {
    mockRemoteAttachmentReader.mockReset().mockReturnValue(null);
  });

  it("serves the bytes off the local store when there is no remote reader", async () => {
    const row = mustStore(await storeIssueAttachment(issueId, "shot.png", PNG, "image/png", "stjohnb"));
    const res = await attachmentFileResponse((await readIssueAttachment(row.id))!);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-length")).toBe(String(PNG.length));
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it("answers 404 attachment file missing when the file is gone", async () => {
    const row = mustStore(await storeIssueAttachment(issueId, "shot.png", PNG, "image/png", "stjohnb"));
    const found = (await readIssueAttachment(row.id))!;
    fs.rmSync(found.absolutePath);
    const res = await attachmentFileResponse(found);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("attachment file missing");
  });

  it("delegates to the remote reader in an agent pod, passing the row id and signal", async () => {
    const reader = vi.fn(async () => new Response("remote bytes", { status: 200 }));
    mockRemoteAttachmentReader.mockReturnValue(reader);
    const row = mustStore(await storeIssueAttachment(issueId, "shot.png", PNG, "image/png", "stjohnb"));
    const found = (await readIssueAttachment(row.id))!;
    fs.rmSync(found.absolutePath);
    const signal = AbortSignal.timeout(1_000);
    const res = await attachmentFileResponse(found, signal);
    expect(reader).toHaveBeenCalledWith(row.id, signal);
    expect(await res.text()).toBe("remote bytes");
  });
});
describe("attachment URLs", () => {
  const ISSUE = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
  const ATT = "cla_01JBQ7X4M2K8NV3TYRW9GZ5PDD";

  it("builds a site-relative URL, with `new` for a pending row", () => {
    expect(attachmentUrl({ id: ATT, issue_id: ISSUE, filename: "a.png" })).toBe(`/issues/${ISSUE}/attachments/${ATT}/a.png`);
    expect(attachmentUrl({ id: ATT, issue_id: null, filename: "a.png" })).toBe(`/issues/new/attachments/${ATT}/a.png`);
  });

  it("parses relative and absolute forms, canonicalising the ids", () => {
    expect(parseAttachmentUrl(`/issues/${ISSUE}/attachments/${ATT}/a.png`)).toEqual({ issueId: ISSUE, attachmentId: ATT });
    expect(parseAttachmentUrl(`https://claws.example.invalid/issues/${ISSUE.toLowerCase()}/attachments/${ATT.toLowerCase()}/a.png?x=1`))
      .toEqual({ issueId: ISSUE, attachmentId: ATT });
    expect(parseAttachmentUrl(`/issues/new/attachments/${ATT}`)).toEqual({ issueId: "new", attachmentId: ATT });
  });

  it("rejects paths that are not attachment URLs", () => {
    expect(parseAttachmentUrl(`/issues/${ISSUE}`)).toBeNull();
    expect(parseAttachmentUrl(`/issues/42/attachments/${ATT}/a.png`)).toBeNull();
    expect(parseAttachmentUrl(`/issues/${ISSUE}/attachments/${ATT}/a/b.png`)).toBeNull();
    expect(parseAttachmentUrl("https://github.com/user-attachments/files/1/a.zip")).toBeNull();
    expect(parseAttachmentUrl("not a url")).toBeNull();
  });
});

describe("serve headers", () => {
  it("serves allowlisted types as stored", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "application/zip", "application/gzip", "text/plain", "audio/ogg", "video/mp4"]) {
      expect(serveContentType({ content_type: type })).toBe(type);
    }
  });

  it("downgrades image/svg+xml, text/html and unknown types to octet-stream", () => {
    expect(serveContentType({ content_type: "image/svg+xml" })).toBe("application/octet-stream");
    expect(serveContentType({ content_type: "text/html" })).toBe("application/octet-stream");
    expect(serveContentType({ content_type: "application/x-msdownload" })).toBe("application/octet-stream");
  });

  it("is inline only for images and PDF", () => {
    expect(contentDisposition({ content_type: "image/png", filename: "a.png" })).toBe(`inline; filename="a.png"`);
    expect(contentDisposition({ content_type: "application/pdf", filename: "a.pdf" })).toBe(`inline; filename="a.pdf"`);
    expect(contentDisposition({ content_type: "image/svg+xml", filename: "a.svg" })).toBe(`attachment; filename="a.svg"`);
    expect(contentDisposition({ content_type: "application/zip", filename: "a\".zip" })).toBe(`attachment; filename="a_.zip"`);
  });
});

describe("diagnostic-queries.getIssueAttachmentRows (stdio claws-state server)", () => {
  it("lists an issue's rows with a numeric size and its stored path, and nothing for a shadow", async () => {
    const row = mustStore(await storeIssueAttachment(issueId, "notes.txt", Buffer.from("hi"), "text/plain", "stjohnb"));
    mustStore(await storeIssueAttachment(null, "pending.txt", Buffer.from("p"), "text/plain", "stjohnb"));

    const rows = await getIssueAttachmentRows(_rawDb(), issueId);
    expect(rows).toEqual([expect.objectContaining({ id: row.id, filename: "notes.txt", size: 2, stored_path: row.stored_path })]);

    const shadow = await createShadowIssue("o/r", 7, { title: "S", body: "", authorLogin: "stjohnb", labels: [] });
    mustStore(await storeIssueAttachment(shadow!.id, "s.txt", Buffer.from("s"), "text/plain", "stjohnb"));
    expect(await getIssueAttachmentRows(_rawDb(), shadow!.id)).toEqual([]);
  });
});

// The check the stdio claws-state server (`mcp-server.ts`) shares with this module.
describe("resolveIssueAttachmentPath", () => {
  const workDir = path.join(os.tmpdir(), "claws-work");

  it("resolves a path inside the store", () => {
    expect(resolveIssueAttachmentPath(workDir, "issue-attachments/clw_x/a.png"))
      .toBe(path.join(workDir, "issue-attachments", "clw_x", "a.png"));
  });

  it.each([
    "../../etc/passwd",
    "/etc/passwd",
    "issue-attachments/../config.json",
    "issue-attachments",
    "issue-attachments-evil/a.png",
  ])("refuses %s, which escapes the store", (storedPath) => {
    expect(resolveIssueAttachmentPath(workDir, storedPath)).toBeNull();
  });

  it("refuses everything without a work dir", () => {
    expect(resolveIssueAttachmentPath("", "issue-attachments/clw_x/a.png")).toBeNull();
  });
});

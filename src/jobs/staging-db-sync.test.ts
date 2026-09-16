import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const mockSpawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: mockSpawn }));

const cfg = vi.hoisted(() => ({
  active: true,
  target: "default/claws-staging-0",
  kubeconfig: "~/.kube/config",
}));

vi.mock("../config.js", () => ({
  DB_PATH: "/unused/claws.db",
  SELF_REPO: "St-John-Software/claws",
  STAGING_DB_SYNC_LOG_DAYS: 7,
  get STAGING_DB_SYNC_TARGET() { return cfg.target; },
  get FLEET_KUBECONFIG_PATH() { return cfg.kubeconfig; },
  isActive: () => cfg.active,
}));

const mockEnsureAlertIssue = vi.hoisted(() => vi.fn());
const mockCloseAlertIssue = vi.hoisted(() => vi.fn());
vi.mock("../occurrence-tracking.js", () => ({
  ensureAlertIssue: mockEnsureAlertIssue,
  closeAlertIssueIfResolved: mockCloseAlertIssue,
}));

vi.mock("../log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}));

import { run, parseTarget, pruneSnapshot, compactSnapshot } from "./staging-db-sync.js";
import { AlertIssueFiledError } from "../error-reporter.js";

let originalDatabaseUrl: string | undefined;

beforeEach(() => {
  originalDatabaseUrl = process.env["CLAWS_DATABASE_URL"];
  delete process.env["CLAWS_DATABASE_URL"];
  cfg.active = true;
  cfg.target = "default/claws-staging-0";
  cfg.kubeconfig = "~/.kube/config";
  mockSpawn.mockReset();
  mockEnsureAlertIssue.mockReset();
  mockCloseAlertIssue.mockReset();
});

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env["CLAWS_DATABASE_URL"];
  else process.env["CLAWS_DATABASE_URL"] = originalDatabaseUrl;
});

describe("staging-db-sync gates", () => {
  it("is a no-op on the Postgres backend", async () => {
    process.env["CLAWS_DATABASE_URL"] = "postgres://claws@example/claws";
    await run();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("is a no-op on a verify-only instance", async () => {
    cfg.active = false;
    await run();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("is a no-op with no sync target configured", async () => {
    cfg.target = "";
    await run();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("is a no-op with no fleet kubeconfig configured", async () => {
    cfg.kubeconfig = "";
    await run();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("files no alert when a gate short-circuits", async () => {
    cfg.target = "";
    await run();
    expect(mockEnsureAlertIssue).not.toHaveBeenCalled();
    expect(mockCloseAlertIssue).not.toHaveBeenCalled();
  });
});

describe("staging-db-sync failure path", () => {
  it("files its own alert and throws AlertIssueFiledError instead of the raw error", async () => {
    // DB_PATH ("/unused/claws.db") does not exist, so the very first step —
    // opening the live database read-only — throws and drives run() into its
    // catch block without needing to mock kubectl.
    mockEnsureAlertIssue.mockResolvedValue({ outcome: "created", issueNumber: 1 });

    await expect(run()).rejects.toThrow(AlertIssueFiledError);

    expect(mockEnsureAlertIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: "St-John-Software/claws",
        title: "[staging-db-sync] Nightly claws-staging database sync is failing",
      }),
    );
  });
});

describe("parseTarget", () => {
  it("splits <namespace>/<pod>", () => {
    expect(parseTarget("default/claws-staging-0")).toEqual({ namespace: "default", pod: "claws-staging-0" });
  });

  it("rejects a bare pod name", () => {
    expect(() => parseTarget("claws-staging-0")).toThrow(/expected <namespace>\/<pod>/);
  });

  it("rejects a value with too many segments", () => {
    expect(() => parseTarget("a/b/c")).toThrow(/expected <namespace>\/<pod>/);
  });

  it("rejects an empty namespace or pod", () => {
    expect(() => parseTarget("/claws-staging-0")).toThrow(/expected <namespace>\/<pod>/);
    expect(() => parseTarget("default/")).toThrow(/expected <namespace>\/<pod>/);
  });
});

describe("pruneSnapshot", () => {
  function seed(): Database.Database {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE job_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, job_name TEXT, started_at TEXT);
      CREATE TABLE job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, message TEXT);
    `);
    const insertRun = db.prepare(`INSERT INTO job_runs (run_id, job_name, started_at) VALUES (?, ?, ?)`);
    const insertLog = db.prepare(`INSERT INTO job_logs (run_id, message) VALUES (?, ?)`);
    // 30 old runs of one job, plus one recent run of another.
    for (let i = 0; i < 30; i++) {
      const runId = `old-${i}`;
      insertRun.run(runId, "k3s-monitor", `2020-01-${String((i % 28) + 1).padStart(2, "0")} 00:00:00`);
      insertLog.run(runId, "old log line");
    }
    insertRun.run("fresh", "pr-dispatcher", new Date().toISOString().replace("T", " ").slice(0, 19));
    insertLog.run("fresh", "fresh log line");
    insertLog.run("already-orphaned", "orphan");
    return db;
  }

  it("deletes runs older than the retention window", () => {
    const db = seed();
    const deleted = pruneSnapshot(db, 7);
    expect(deleted).toBe(10); // 30 old runs, newest 20 per job kept
    expect((db.prepare(`SELECT count(*) AS n FROM job_runs`).get() as { n: number }).n).toBe(21);
    db.close();
  });

  it("keeps the newest keepPerJob runs of each job regardless of age", () => {
    const db = seed();
    pruneSnapshot(db, 7, 5);
    const kept = db.prepare(`SELECT count(*) AS n FROM job_runs WHERE job_name = 'k3s-monitor'`).get() as { n: number };
    expect(kept.n).toBe(5);
    const fresh = db.prepare(`SELECT count(*) AS n FROM job_runs WHERE job_name = 'pr-dispatcher'`).get() as { n: number };
    expect(fresh.n).toBe(1);
    db.close();
  });

  it("removes job_logs orphaned by the run deletion", () => {
    const db = seed();
    pruneSnapshot(db, 7, 5);
    const runIds = (db.prepare(`SELECT DISTINCT run_id FROM job_logs`).all() as Array<{ run_id: string }>)
      .map(r => r.run_id);
    expect(runIds).not.toContain("already-orphaned");
    for (const runId of runIds) {
      const exists = db.prepare(`SELECT count(*) AS n FROM job_runs WHERE run_id = ?`).get(runId) as { n: number };
      expect(exists.n).toBe(1);
    }
    db.close();
  });

  it("removes oversized job_logs rows regardless of run age (#3113)", () => {
    const db = seed();
    db.prepare(`INSERT INTO job_logs (run_id, message) VALUES (?, ?)`).run("fresh", "x".repeat(200_000));
    pruneSnapshot(db, 7, 5);

    const messages = (db.prepare(`SELECT message FROM job_logs WHERE run_id = 'fresh'`).all() as Array<{ message: string }>)
      .map(r => r.message);
    expect(messages).toEqual(["fresh log line"]);
    db.close();
  });
});

describe("compactSnapshot", () => {
  let tmpDir: string;
  let snapshotPath: string;
  let compactedPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "claws-dbsync-test-"));
    snapshotPath = path.join(tmpDir, "claws-snapshot.db");
    compactedPath = path.join(tmpDir, "claws-snapshot-compact.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedOnDisk(): void {
    const db = new Database(snapshotPath);
    db.exec(`CREATE TABLE blobs (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB)`);
    const insert = db.prepare(`INSERT INTO blobs (data) VALUES (?)`);
    const chunk = Buffer.alloc(64 * 1024, 1);
    for (let i = 0; i < 200; i++) insert.run(chunk);
    // Delete most rows, leaving the file full of free pages for VACUUM INTO to drop.
    db.prepare(`DELETE FROM blobs WHERE id > 5`).run();
    db.close();
  }

  // VACUUM INTO does real synchronous disk I/O on a 12.8 MB fixture; the
  // shared automation host's disk can push that past vitest's 5s default.
  it("shrinks the file and keeps the retained rows readable", () => {
    seedOnDisk();
    const rawSize = fs.statSync(snapshotPath).size;

    const db = new Database(snapshotPath);
    try {
      compactSnapshot(db, snapshotPath, compactedPath);
    } finally {
      db.close();
    }

    const compactedSize = fs.statSync(snapshotPath).size;
    expect(compactedSize).toBeLessThanOrEqual(rawSize);

    const reopened = new Database(snapshotPath, { readonly: true });
    try {
      const count = reopened.prepare(`SELECT count(*) AS n FROM blobs`).get() as { n: number };
      expect(count.n).toBe(5);
    } finally {
      reopened.close();
    }

    expect(fs.existsSync(compactedPath)).toBe(false);
  }, 30_000);

  it("removes the partial compacted file and preserves the snapshot on failure", () => {
    seedOnDisk();
    const rawContents = fs.readFileSync(snapshotPath);

    const db = new Database(snapshotPath);
    try {
      // A destination inside a nonexistent directory makes VACUUM INTO fail.
      const badCompactedPath = path.join(tmpDir, "missing-dir", "compact.db");
      expect(() => compactSnapshot(db, snapshotPath, badCompactedPath)).toThrow(
        /Failed to compact pruned SQLite snapshot/,
      );
      expect(fs.existsSync(badCompactedPath)).toBe(false);
    } finally {
      db.close();
    }

    expect(fs.readFileSync(snapshotPath).equals(rawContents)).toBe(true);
  }, 30_000);
});

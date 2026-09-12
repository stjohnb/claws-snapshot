import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import { run, parseTarget, pruneSnapshot } from "./staging-db-sync.js";

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
});

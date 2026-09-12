import { describe, it, expect } from "vitest";
import { Client } from "pg";
import { translate, buildPgConnectionConfig } from "./db-driver-pg.js";

/**
 * Each case is a statement lifted verbatim out of `src/db.ts`. `translate()` is a
 * closed set of rules over exactly the SQLite-only constructs that survive there,
 * so a new construct in `src/db.ts` needs a rule here and a case in this file.
 */
describe("translate", () => {
  it("turns INSERT OR IGNORE into ON CONFLICT DO NOTHING", () => {
    expect(translate(
      `INSERT OR IGNORE INTO processed_repos_daily (job_name, repo, local_date) VALUES (?, ?, ?)`,
    )).toBe(
      `INSERT INTO processed_repos_daily (job_name, repo, local_date) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    );
  });

  it("leaves an existing ON CONFLICT clause alone", () => {
    const out = translate(
      `INSERT INTO work_queue (kind) VALUES (?) ON CONFLICT(kind) WHERE status IN ('queued') DO NOTHING`,
    );
    expect(out).toBe(
      `INSERT INTO work_queue (kind) VALUES ($1) ON CONFLICT(kind) WHERE status IN ('queued') DO NOTHING`,
    );
    expect(out.match(/ON CONFLICT/gi)).toHaveLength(1);
  });

  it("rewrites the CAST(json_extract(...)) form before the bare form", () => {
    expect(translate(`AND CAST(json_extract(outcome, '$.commits') AS INTEGER) = 0`))
      .toBe(`AND ((outcome::jsonb ->> 'commits')::int) = 0`);
    expect(translate(`COALESCE(CAST(json_extract(outcome, '$.commits') AS INTEGER), 0) = 0`))
      .toBe(`COALESCE(((outcome::jsonb ->> 'commits')::int), 0) = 0`);
  });

  it("rewrites bare json_extract", () => {
    expect(translate(`AND json_extract(outcome, '$.prNumber') IS NULL`))
      .toBe(`AND (outcome::jsonb ->> 'prNumber') IS NULL`);
    expect(translate(`json_extract(outcome, '$.failureCategory') = 'transient-api'`))
      .toBe(`(outcome::jsonb ->> 'failureCategory') = 'transient-api'`);
  });

  it("rewrites strftime", () => {
    expect(translate(
      `(CAST(strftime('%s', completed_at) AS INTEGER) - CAST(strftime('%s', started_at) AS INTEGER)) * 1000 as duration_ms`,
    )).toBe(
      `(CAST(EXTRACT(EPOCH FROM completed_at::timestamp) AS INTEGER) - CAST(EXTRACT(EPOCH FROM started_at::timestamp) AS INTEGER)) * 1000 as duration_ms`,
    );
    expect(translate(`strftime('%Y-%m-%d', started_at) AS date`))
      .toBe(`to_char(started_at::timestamp, 'YYYY-MM-DD') AS date`);
  });

  it("rewrites julianday to a fractional day count", () => {
    expect(translate(`(julianday(run_started_at) - julianday(created_at)) * 86400`))
      .toBe(
        `((EXTRACT(EPOCH FROM run_started_at::timestamp) / 86400.0) - ` +
        `(EXTRACT(EPOCH FROM created_at::timestamp) / 86400.0)) * 86400`,
      );
  });

  it("rewrites INSTR to strpos and leaves SUBSTR alone", () => {
    expect(translate(
      `CASE WHEN INSTR(job_name, ':') > 0 THEN SUBSTR(job_name, 1, INSTR(job_name, ':') - 1) ELSE job_name END`,
    )).toBe(
      `CASE WHEN strpos(job_name, ':') > 0 THEN SUBSTR(job_name, 1, strpos(job_name, ':') - 1) ELSE job_name END`,
    );
  });

  it("rewrites LIMIT -1 OFFSET to LIMIT ALL OFFSET", () => {
    expect(translate(`ORDER BY ended_at DESC, id DESC\n    LIMIT -1 OFFSET ?`))
      .toBe(`ORDER BY ended_at DESC, id DESC\n    LIMIT ALL OFFSET $1`);
  });

  it("rewrites datetime() to a timestamp cast", () => {
    expect(translate(`AND datetime(started_at) >= datetime(?)`))
      .toBe(`AND (started_at)::timestamp >= ($1)::timestamp`);
  });

  it("numbers placeholders in order", () => {
    expect(translate(`UPDATE work_queue SET status = 'running', pid = ?, started_at = ? WHERE id = ?`))
      .toBe(`UPDATE work_queue SET status = 'running', pid = $1, started_at = $2 WHERE id = $3`);
  });

  it("leaves a ? inside a string literal or a comment alone", () => {
    expect(translate(`SELECT '?' AS q WHERE repo = ?`)).toBe(`SELECT '?' AS q WHERE repo = $1`);
    expect(translate(`SELECT 1 -- really? yes\n WHERE repo = ?`))
      .toBe(`SELECT 1 -- really? yes\n WHERE repo = $1`);
  });

  it("is idempotent across repeated calls (translations are cached)", () => {
    const sql = `INSERT OR IGNORE INTO blog_draft_ports (repo, path, issue_number) VALUES (?, ?, ?)`;
    expect(translate(sql)).toBe(translate(sql));
  });
});

/**
 * Constructing a `pg` Client does not open a connection; `connectionParameters`
 * is exactly what `pg` would authenticate with, which is what lets these tests
 * catch the bug the PGlite lane cannot (#2974).
 */
interface ConnectionParameters {
  user?: string;
  password: string | null;
  host: string;
  port: number;
  database?: string;
}

describe("buildPgConnectionConfig", () => {
  const params = (cfg: { connectionString: string; password?: string }) =>
    (new Client(cfg) as unknown as { connectionParameters: ConnectionParameters }).connectionParameters;

  it("merges a separately supplied password into a passwordless URL", () => {
    const cfg = buildPgConnectionConfig(
      "postgres://claws@postgres.default.svc.cluster.local:5432/claws",
      "s3cret",
    );
    const p = params(cfg);
    expect(p.password).toBe("s3cret");
    expect(p.user).toBe("claws");
    expect(p.host).toBe("postgres.default.svc.cluster.local");
    expect(p.port).toBe(5432);
    expect(p.database).toBe("claws");
  });

  it("documents the old broken shape: connectionString + sibling password loses the password", () => {
    expect(
      params({ connectionString: "postgres://claws@h:5432/claws", password: "s3cret" }).password,
    ).toBe(null);
  });

  it("prefers a separately supplied password over one embedded in the URL", () => {
    const cfg = buildPgConnectionConfig("postgres://claws:urlpw@h:5432/claws", "envpw");
    expect(params(cfg).password).toBe("envpw");
  });

  it("keeps the embedded password when none is supplied separately", () => {
    const cfg = buildPgConnectionConfig("postgres://claws:urlpw@h:5432/claws", "");
    expect(cfg).toEqual({ connectionString: "postgres://claws:urlpw@h:5432/claws" });
    expect(params(cfg).password).toBe("urlpw");
  });

  it("returns the URL untouched when neither side has a password", () => {
    const cfg = buildPgConnectionConfig("postgres://claws@h:5432/claws", "");
    expect(cfg).toEqual({ connectionString: "postgres://claws@h:5432/claws" });
  });

  it("round-trips special characters in the password without re-splitting the userinfo", () => {
    const password = "p@ss:w/rd#?%&+ ä'\"\\";
    const cfg = buildPgConnectionConfig("postgres://claws@h:5432/claws", password);
    const p = params(cfg);
    expect(p.password).toBe(password);
    expect(p.host).toBe("h");
  });

  it("passes a non-URL connection string through with the password alongside it", () => {
    expect(buildPgConnectionConfig("/var/run/postgresql claws", "s3cret")).toEqual({
      connectionString: "/var/run/postgresql claws",
      password: "s3cret",
    });
  });
});

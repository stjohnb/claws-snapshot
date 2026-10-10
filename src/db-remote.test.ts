import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./log-core.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./outcome.js", () => ({ buildFailureOutcome: (err: unknown) => ({ category: "error", detail: String(err) }) }));
vi.mock("./db.js", () => ({
  capJobLogMessage: (m: string) => m,
  getOrphanedTasks: () => { throw new Error("Database not initialized — call initDb() first"); },
}));

import * as remote from "./db-remote.js";
import { encodeWire } from "./agent-pod-wire.js";

type Call = { url: string; init: RequestInit; op: string; args: unknown[] };

function reply(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : encodeWire(body), { status, headers: { "content-type": "application/json" } });
}

function connRefused(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

describe("db-remote", () => {
  let calls: Call[];
  let respond: (call: Call) => Response | Promise<Response>;

  beforeEach(() => {
    remote._resetRemoteDbForTests();
    calls = [];
    respond = () => reply(200, { result: null });
    remote.configureRemoteDb({
      baseUrl: "http://claws.default.svc:3000/",
      token: "pod-token",
      rowId: 7,
      runId: "run-7",
      fetch: (async (url: string, init: RequestInit) => {
        const op = url.split("/").pop()!;
        const call = { url, init, op, args: (JSON.parse(String(init.body)) as { args: unknown[] }).args };
        calls.push(call);
        return await respond(call);
      }) as typeof fetch,
    });
  });

  afterEach(() => {
    remote._resetRemoteDbForTests();
    vi.useRealTimers();
  });

  it("posts the op's args with the pod's bearer token and returns the result", async () => {
    respond = () => reply(200, { result: { id: 7, status: "running" } });
    expect(await remote.getWorkRow(7)).toEqual({ id: 7, status: "running" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://claws.default.svc:3000/agent-pods/7/ops/getWorkRow");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ Authorization: "Bearer pod-token", "Content-Type": "application/json" });
    expect(calls[0]!.args).toEqual([7]);
  });

  it("reads an attachment's bytes from the service's attachment route with the pod's bearer", async () => {
    remote._resetRemoteDbForTests();
    expect(remote.remoteAttachmentReader()).toBeNull();
    const seen: Array<{ url: string; init: RequestInit }> = [];
    remote.configureRemoteDb({ baseUrl: "http://svc/", token: "pod-token", rowId: 7, runId: "run-7", fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("bytes", { status: 200, headers: { "content-type": "image/png" } });
    }) as typeof fetch });
    const signal = AbortSignal.timeout(1_000);
    const res = await remote.remoteAttachmentReader()!("cla_01JBQ7X4M2K8NV3TYRW9GZ5PDD", signal);
    expect(await res.text()).toBe("bytes");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("http://svc/agent-pods/7/attachments/cla_01JBQ7X4M2K8NV3TYRW9GZ5PDD");
    expect(seen[0]!.init.method).toBeUndefined();
    expect(seen[0]!.init.headers).toEqual({ Authorization: "Bearer pod-token" });
    expect(seen[0]!.init.signal).toBe(signal);
  });

  it("round-trips Maps in results and Dates in args", async () => {
    respond = () => reply(200, { result: new Map([["org/repo", 5]]) });
    expect(await remote.getLastProcessedTimestampsForJob("job")).toEqual(new Map([["org/repo", 5]]));
    respond = () => reply(200, { result: [] });
    await remote.listClosedClawsIssuesSince(new Date("2026-09-24T00:00:00Z"));
    expect(String(calls[1]!.init.body)).toContain("2026-09-24T00:00:00.000Z");
  });

  it("throws AgentPodOpUnauthorizedError on 401", async () => {
    respond = () => reply(401, { error: "unauthorized" });
    await expect(remote.getWorkRow(7)).rejects.toBeInstanceOf(remote.AgentPodOpUnauthorizedError);
    expect(calls).toHaveLength(1);
  });

  it("rethrows the server's message on 500 without retrying", async () => {
    respond = () => reply(500, JSON.stringify({ error: "constraint failed" }));
    await expect(remote.markWorkFailed(7, "boom")).rejects.toThrow("constraint failed");
    expect(calls).toHaveLength(1);
  });

  it("retries a refused connection and a 503, then succeeds", async () => {
    vi.useFakeTimers();
    let n = 0;
    respond = () => {
      n++;
      if (n === 1) throw connRefused();
      if (n === 2) return reply(503, JSON.stringify({ error: "database unavailable" }));
      return reply(200, { result: 3 });
    };
    const pending = remote.countRecentTimeouts("org/repo", 1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a reset connection, which may have reached the op", async () => {
    respond = () => { throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) }); };
    await expect(remote.recordTaskStart("ci-fixer", "org/repo", 1, null)).rejects.toThrow(/recordTaskStart failed/);
    expect(calls).toHaveLength(1);
  });

  it("throws AgentPodOpTooLargeError on 413", async () => {
    respond = () => reply(413, JSON.stringify({ error: "request body too large" }));
    await expect(remote.getWorkRow(7)).rejects.toBeInstanceOf(remote.AgentPodOpTooLargeError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a timeout, which may have reached the op", async () => {
    respond = () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); };
    await expect(remote.completeJobRun("run-7", "completed")).rejects.toThrow(/completeJobRun failed/);
    expect(calls).toHaveLength(1);
  });

  it("leaves unlisted db.ts functions on the unopened database", () => {
    expect(() => remote.getOrphanedTasks()).toThrow(/Database not initialized/);
  });

  it("refuses initDb", async () => {
    await expect(remote.initDb()).rejects.toThrow(/agent pod has no database/);
  });

  describe("withTaskRecording", () => {
    it("records the start, then the failure with its outcome, and rethrows", async () => {
      respond = (call) => reply(200, { result: call.op === "recordTaskStart" ? 42 : null });
      await expect(remote.withTaskRecording("ci-fixer", "org/repo", 1, null, async (taskId) => {
        expect(taskId).toBe(42);
        throw new Error("agent crashed");
      })).rejects.toThrow("agent crashed");
      expect(calls.map((c) => [c.op, c.args])).toEqual([
        ["recordTaskStart", ["ci-fixer", "org/repo", 1, null]],
        ["recordTaskFailed", [42, "Error: agent crashed", { category: "error", detail: "Error: agent crashed" }]],
      ]);
    });

    it("returns the callback's value without recording a failure", async () => {
      respond = () => reply(200, { result: 42 });
      expect(await remote.withTaskRecording("ci-fixer", "org/repo", 1, null, async () => "done")).toBe("done");
      expect(calls.map((c) => c.op)).toEqual(["recordTaskStart"]);
    });
  });

  it("trackTaskTokens writes cumulative usage and each new provider, in order", async () => {
    const track = remote.trackTaskTokens(42);
    track(10, 0.1, "claude");
    track(5, 0.05, "claude");
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.map((c) => [c.op, c.args])).toEqual([
      ["updateTaskTokenUsage", [42, 10, 0.1]],
      ["updateTaskProvider", [42, "claude"]],
      ["updateTaskTokenUsage", [42, 15, 0.1 + 0.05]],
    ]);
  });

  describe("job logs", () => {
    it("buffers lines and ships them for the row's run on flush", async () => {
      remote.insertJobLog("run-7", "info", "one");
      remote.insertJobLog("other-run", "warn", "two");
      expect(calls).toHaveLength(0);
      await remote.flushJobLogs();
      expect(calls).toHaveLength(1);
      expect(calls[0]!.op).toBe("insertJobLogRows");
      const [runId, rows] = calls[0]!.args as [string, Array<{ level: string; message: string; loggedAt: string }>];
      expect(runId).toBe("run-7");
      expect(rows.map((r) => [r.level, r.message])).toEqual([["info", "one"], ["warn", "two"]]);
      expect(rows[0]!.loggedAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });

    it("drains on its timer", async () => {
      vi.useFakeTimers();
      remote._resetRemoteDbForTests();
      remote.configureRemoteDb({ baseUrl: "http://svc", token: "t", rowId: 7, runId: "run-7", fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init, op: url.split("/").pop()!, args: [] });
        return reply(200, { result: null });
      }) as typeof fetch });
      remote.insertJobLog("run-7", "info", "tick");
      await vi.advanceTimersByTimeAsync(1_500);
      expect(calls.map((c) => c.op)).toEqual(["insertJobLogRows"]);
    });

    it("keeps a failed batch for the next drain", async () => {
      respond = () => reply(500, JSON.stringify({ error: "db down" }));
      remote.insertJobLog("run-7", "info", "kept");
      await remote.flushJobLogs();
      respond = () => reply(200, { result: null });
      await remote.closeDb();
      expect(calls).toHaveLength(2);
      expect((calls[1]!.args[1] as Array<{ message: string }>)[0]!.message).toBe("kept");
    });

    it("keeps each batch under the route's 4 MiB cap, splitting any the service still refuses", async () => {
      const cap = 4 * 1024 * 1024;
      respond = (call) => Buffer.byteLength(String(call.init.body)) > cap
        ? reply(413, JSON.stringify({ error: "request body too large" }))
        : reply(200, { result: null });
      const big = "x".repeat(32_000);
      for (let i = 0; i < 300; i++) remote.insertJobLog("run-7", "info", `${i}:${big}`);
      await remote.flushJobLogs();
      const shipped = calls.filter((c) => Buffer.byteLength(String(c.init.body)) <= cap);
      expect(calls.length).toBeGreaterThan(1);
      expect(shipped).toHaveLength(calls.length);
      const messages = shipped.flatMap((c) => (c.args[1] as Array<{ message: string }>).map((r) => r.message.split(":")[0]));
      expect(messages).toEqual(Array.from({ length: 300 }, (_, i) => String(i)));
    });

    it("halves a batch refused with 413 and drops a single line that still does not fit", async () => {
      respond = (call) => (call.args[1] as Array<{ message: string }>).some((r) => r.message === "huge")
        ? reply(413, JSON.stringify({ error: "request body too large" }))
        : reply(200, { result: null });
      for (const m of ["a", "b", "huge", "c"]) remote.insertJobLog("run-7", "info", m);
      await remote.flushJobLogs();
      await remote.closeDb();
      const shipped = calls
        .filter((c) => !(c.args[1] as Array<{ message: string }>).some((r) => r.message === "huge"))
        .flatMap((c) => (c.args[1] as Array<{ message: string }>).map((r) => r.message));
      expect(shipped).toEqual(["a", "b", "c"]);
      expect(calls.map((c) => (c.args[1] as unknown[]).length)).toEqual([4, 2, 2, 1, 1]);
    });

    it("drops the buffer once the token is refused", async () => {
      respond = () => reply(401, { error: "unauthorized" });
      remote.insertJobLog("run-7", "info", "lost");
      await remote.flushJobLogs();
      respond = () => reply(200, { result: null });
      await remote.closeDb();
      expect(calls).toHaveLength(1);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("./slack.js", () => ({ notify: mocks.notify }));
vi.mock("./db.js", () => ({ insertJobLog: vi.fn() }));

import { insertJobLog } from "./db.js";

import * as log from "./log.js";
import { withRequestId } from "./log-core.js";

describe("errorAndFlush", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.notify.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stores a producer reason separately from private log text", async () => {
    const consoleInfo = vi.spyOn(console, "log").mockImplementation(() => {});
    await log.withRunContext("run", async () => {
      log.info("Bearer private", "docs_unchanged", { repo: "org/repo", taskId: 12 });
    });
    expect(insertJobLog).toHaveBeenCalledWith("run", "info", "Bearer private", "docs_unchanged", { repo: "org/repo", taskId: 12 });
    consoleInfo.mockRestore();
  });

  it("awaits the notify promise before resolving", async () => {
    let resolve!: () => void;
    mocks.notify.mockReturnValue(new Promise<void>((r) => (resolve = r)));

    const sentinel = Promise.resolve("sentinel");
    const flushPromise = log.errorAndFlush("boom");

    const winner = await Promise.race([flushPromise.then(() => "flush"), sentinel]);
    expect(winner).toBe("sentinel");

    resolve();
    await flushPromise;
  });

  it("resolves after the 5s bound when notify never settles", async () => {
    vi.useFakeTimers();
    mocks.notify.mockReturnValue(new Promise<void>(() => {}));

    let settled = false;
    const flushPromise = log.errorAndFlush("boom").then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5000);
    await flushPromise;

    expect(settled).toBe(true);
  });

  it("calls notify exactly once with the [ERROR] prefix", async () => {
    mocks.notify.mockResolvedValue(undefined);

    await log.errorAndFlush("boom");

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith("[ERROR] boom");
  });

  it("error() never notifies Slack", () => {
    log.error("boom");
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

describe("line format", () => {
  const originalFormat = process.env["CLAWS_LOG_FORMAT"];
  const originalTty = process.stdout.isTTY;
  const setTty = (value: boolean | undefined) => {
    Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true });
  };
  let out: ReturnType<typeof vi.spyOn>;
  let errOut: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env["CLAWS_LOG_FORMAT"];
    mocks.notify.mockReset();
    out = vi.spyOn(console, "log").mockImplementation(() => {});
    errOut = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setTty(false);
  });

  afterEach(() => {
    if (originalFormat === undefined) delete process.env["CLAWS_LOG_FORMAT"];
    else process.env["CLAWS_LOG_FORMAT"] = originalFormat;
    setTty(originalTty);
    vi.restoreAllMocks();
  });

  const lastLine = (spy: ReturnType<typeof vi.spyOn>) => String(spy.mock.calls.at(-1)?.[0]);
  const lastJson = (spy: ReturnType<typeof vi.spyOn>) => JSON.parse(lastLine(spy)) as Record<string, unknown>;

  it("writes one JSON object per line off a TTY, with the [component] prefix as a field", () => {
    log.debug("[reminder-monitor] no fresh backup");
    const record = lastJson(out);
    expect(Object.keys(record)[0]).toBe("time");
    expect(record).toMatchObject({ level: "debug", msg: "no fresh backup", service: "claws", component: "reminder-monitor" });
    expect(new Date(String(record["time"])).toISOString()).toBe(record["time"]);
    expect(record).not.toHaveProperty("run_id");
  });

  it("leaves a bracket that is not a component tag in the message", () => {
    log.info("[not a tag] hello");
    expect(lastJson(out)).toMatchObject({ msg: "[not a tag] hello" });
    expect(lastJson(out)).not.toHaveProperty("component");
  });

  it("stamps run context fields, reason and a snake_cased context", async () => {
    await log.withRunContext("run-1", async () => {
      log.info("[worker:0] started", "docs_unchanged", { repo: "org/repo", targetStalenessMs: 5 });
    }, { job: "work:issue-worker", repo: "org/repo", issue: 12 });
    expect(lastJson(out)).toMatchObject({
      run_id: "run-1", job: "work:issue-worker", repo: "org/repo", issue: 12,
      component: "worker:0", reason: "docs_unchanged", context: { repo: "org/repo", target_staleness_ms: 5 },
    });
  });

  it("serialises err as {type, message, stack}", () => {
    log.error("[config] exploded", new TypeError("bad"));
    const record = lastJson(errOut);
    expect(record["err"]).toMatchObject({ type: "TypeError", message: "bad" });
    expect(String((record["err"] as { stack: string }).stack)).toContain("TypeError: bad");
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("keeps the human form, component restored, when CLAWS_LOG_FORMAT=text", () => {
    process.env["CLAWS_LOG_FORMAT"] = "text";
    log.info("[scheduler] tick");
    expect(lastLine(out)).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z \[INFO\] \[scheduler\] tick$/);
  });

  it("keeps the human form on a TTY", () => {
    setTty(true);
    log.warn("plain");
    expect(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0])).toMatch(/Z \[WARN\] plain$/);
  });
});

describe("structured fields", () => {
  let out: ReturnType<typeof vi.spyOn>;
  let warnOut: ReturnType<typeof vi.spyOn>;
  const originalFormat = process.env["CLAWS_LOG_FORMAT"];

  beforeEach(() => {
    process.env["CLAWS_LOG_FORMAT"] = "json";
    vi.mocked(insertJobLog).mockClear();
    out = vi.spyOn(console, "log").mockImplementation(() => {});
    warnOut = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalFormat === undefined) delete process.env["CLAWS_LOG_FORMAT"];
    else process.env["CLAWS_LOG_FORMAT"] = originalFormat;
    vi.restoreAllMocks();
  });

  const lastJson = (spy: ReturnType<typeof vi.spyOn>) => JSON.parse(String(spy.mock.calls.at(-1)?.[0])) as Record<string, unknown>;

  it("emits fields as top-level snake_case keys after the fixed ones", () => {
    log.info("[db] operation finished", { op: "prune", durationMs: 12, rows: 3, skipped: undefined });
    const record = lastJson(out);
    expect(record).toMatchObject({ msg: "operation finished", component: "db", op: "prune", duration_ms: 12, rows: 3 });
    expect(record).not.toHaveProperty("skipped");
    expect(Object.keys(record).slice(-3)).toEqual(["op", "duration_ms", "rows"]);
  });

  it("drops a field that collides with a reserved key", () => {
    log.info("hello", { msg: "evil", level: "error", runId: "x", requestId: "y", kept: 1 });
    const record = lastJson(out);
    expect(record).toMatchObject({ msg: "hello", level: "info", kept: 1 });
    expect(record).not.toHaveProperty("run_id");
    expect(record).not.toHaveProperty("request_id");
  });

  it("takes fields and err on warn", () => {
    log.warn("failed", { op: "x" }, new Error("boom"));
    expect(lastJson(warnOut)).toMatchObject({ op: "x", err: { type: "Error", message: "boom" } });
  });

  it("keeps the reason/context form of warn", () => {
    log.warn("old", "docs_unchanged", { taskId: 1 }, new Error("e"));
    expect(lastJson(warnOut)).toMatchObject({ reason: "docs_unchanged", context: { task_id: 1 }, err: { message: "e" } });
  });

  it("stamps request_id inside withRequestId", async () => {
    await withRequestId("req-1", async () => {
      log.info("inside");
    });
    expect(lastJson(out)).toMatchObject({ request_id: "req-1" });
    log.info("outside");
    expect(lastJson(out)).not.toHaveProperty("request_id");
  });

  it("appends key=value pairs to the job_logs message", async () => {
    await log.withRunContext("run", async () => {
      log.info("finished", { op: "prune", durationMs: 5, tags: ["a"], msg: "dropped" });
      log.error("failed", new Error("x"), { attempt: 2 });
    });
    expect(insertJobLog).toHaveBeenCalledWith("run", "info", 'finished op=prune duration_ms=5 tags=["a"]', undefined, undefined);
    expect(insertJobLog).toHaveBeenCalledWith("run", "error", "failed attempt=2", undefined, undefined);
  });
});

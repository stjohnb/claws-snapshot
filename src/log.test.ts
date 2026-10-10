import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("./slack.js", () => ({ notify: mocks.notify }));
vi.mock("./db.js", () => ({ insertJobLog: vi.fn() }));

import { insertJobLog } from "./db.js";

import * as log from "./log.js";

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
    log.debug("[ha-backup-monitor] no fresh backup");
    const record = lastJson(out);
    expect(Object.keys(record)[0]).toBe("time");
    expect(record).toMatchObject({ level: "debug", msg: "no fresh backup", service: "claws", component: "ha-backup-monitor" });
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
    expect(mocks.notify).toHaveBeenCalledWith("[ERROR] [config] exploded");
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

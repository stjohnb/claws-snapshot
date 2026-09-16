import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock("./slack.js", () => ({ notify: mocks.notify }));
vi.mock("./db.js", () => ({ insertJobLog: vi.fn() }));

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

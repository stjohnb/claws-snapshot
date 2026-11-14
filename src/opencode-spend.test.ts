import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  warnUsd: 150,
  spend: 0,
  warnedAt: null as number | null,
  notify: vi.fn(async () => {}),
}));

vi.mock("./config.js", () => ({
  get OPENCODE_SPEND_WARN_USD() { return mocks.warnUsd; },
}));
vi.mock("./slack.js", () => ({ notify: mocks.notify }));
vi.mock("./log.js", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("./db.js", () => ({
  getOpencodeAnthropicSpendUsd: vi.fn(async () => mocks.spend),
  getSpendWarningThreshold: vi.fn(async () => mocks.warnedAt),
  recordSpendWarning: vi.fn(async (_key: string, threshold: number) => { mocks.warnedAt = threshold; }),
}));

import { checkOpencodeSpend } from "./opencode-spend.js";
import { recordSpendWarning } from "./db.js";

describe("checkOpencodeSpend", () => {
  beforeEach(() => {
    mocks.warnUsd = 150;
    mocks.spend = 0;
    mocks.warnedAt = null;
    mocks.notify.mockClear();
    vi.mocked(recordSpendWarning).mockClear();
  });

  it("stays quiet below the threshold", async () => {
    mocks.spend = 149.99;
    expect(await checkOpencodeSpend()).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("warns once when spend reaches the threshold, not on later checks", async () => {
    mocks.spend = 151.234;
    expect(await checkOpencodeSpend()).toBe(true);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(expect.stringContaining("OpenCode Anthropic API spend $151.23 has passed the $150.00 warning threshold; see /usage"));
    expect(recordSpendWarning).toHaveBeenCalledWith("opencode-anthropic", 150);

    mocks.spend = 180;
    expect(await checkOpencodeSpend()).toBe(false);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("warns again only after the operator raises the threshold and spend passes it", async () => {
    mocks.warnedAt = 150;
    mocks.warnUsd = 300;
    mocks.spend = 200;
    expect(await checkOpencodeSpend()).toBe(false);
    mocks.spend = 300;
    expect(await checkOpencodeSpend()).toBe(true);
    expect(recordSpendWarning).toHaveBeenCalledWith("opencode-anthropic", 300);
  });

  it("does nothing when the threshold is 0 (disabled)", async () => {
    mocks.warnUsd = 0;
    mocks.spend = 1000;
    expect(await checkOpencodeSpend()).toBe(false);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});

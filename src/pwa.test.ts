import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const toBuffer = vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const png = vi.fn(() => ({ toBuffer }));
  const resize = vi.fn(() => ({ png }));
  const sharpFn = vi.fn(() => ({ resize }));
  return { sharpFn, resize, png, toBuffer };
});
vi.mock("sharp", () => ({ default: mocks.sharpFn }));

describe("pwa", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("WEB_MANIFEST parses as valid installable manifest JSON", async () => {
    const { WEB_MANIFEST } = await import("./pwa.js");
    const parsed = JSON.parse(WEB_MANIFEST);
    expect(parsed.start_url).toBe("/");
    expect(parsed.display).toBe("standalone");
    expect(parsed.icons).toHaveLength(2);
  });

  it("getAppIconPng resolves to a PNG buffer", async () => {
    const { getAppIconPng } = await import("./pwa.js");
    const buf = await getAppIconPng(192);
    expect(buf[0]).toBe(0x89);
  });

  it("memoizes rasterization per size", async () => {
    const { getAppIconPng } = await import("./pwa.js");
    await getAppIconPng(192);
    await getAppIconPng(192);
    expect(mocks.sharpFn).toHaveBeenCalledTimes(1);
  });
});

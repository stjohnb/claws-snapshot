import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./log.js", () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockEnrichedPath = vi.hoisted(() => vi.fn((p?: string) => `/home/test/.local/bin:${p ?? ""}`));
vi.mock("./cli-path.js", () => ({ enrichedPath: mockEnrichedPath }));

import { execFile } from "node:child_process";
import { getCodexModelCatalogue, __resetCodexModelCatalogueForTests } from "./codex-models.js";
import * as log from "./log.js";

const mockExecFile = vi.mocked(execFile);

describe("getCodexModelCatalogue", () => {
  beforeEach(() => {
    __resetCodexModelCatalogueForTests();
    mockExecFile.mockReset();
    mockEnrichedPath.mockClear();
    vi.mocked(log.warn).mockClear();
  });

  it("loads visible models and upgrade mappings from codex debug models", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, JSON.stringify({
        models: [
          { slug: "gpt-5.5", visibility: "list" },
          { slug: "gpt-5.4", visibility: "hide", upgrade: { model: "gpt-5.5" } },
          { slug: "hidden-no-upgrade", visibility: "hide" },
        ],
      }), "");
      return undefined as any;
    });

    const catalogue = await getCodexModelCatalogue();

    expect(catalogue?.visible.has("gpt-5.5")).toBe(true);
    expect(catalogue?.visible.has("gpt-5.4")).toBe(false);
    expect(catalogue?.upgrades.get("gpt-5.4")).toBe("gpt-5.5");
    expect(mockExecFile).toHaveBeenCalledWith(
      "codex",
      ["debug", "models"],
      expect.objectContaining({
        timeout: 5000,
        maxBuffer: 20 * 1024 * 1024,
        env: expect.objectContaining({ PATH: expect.stringContaining("/home/test/.local/bin:") }),
      }),
      expect.any(Function),
    );
    expect(mockEnrichedPath).toHaveBeenCalledWith(process.env["PATH"]);
  });

  it("searches the enriched PATH when codex is only in a profile-installed bin dir", async () => {
    mockExecFile.mockImplementation((_cmd, _args, opts: any, cb: any) => {
      expect(opts.env.PATH.split(":")[0]).toBe("/home/test/.local/bin");
      cb(null, JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list" }] }), "");
      return undefined as any;
    });

    const catalogue = await getCodexModelCatalogue();

    expect(catalogue?.visible.has("gpt-5.5")).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns null and warns once when the command fails", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(new Error("spawn ENOENT"), "", "not found");
      return undefined as any;
    });

    await expect(getCodexModelCatalogue()).resolves.toBeNull();
    await expect(getCodexModelCatalogue()).resolves.toBeNull();

    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("returns null for invalid JSON", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      cb(null, "not json", "");
      return undefined as any;
    });

    await expect(getCodexModelCatalogue()).resolves.toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Codex model catalogue unavailable"));
  });

  it("dedupes concurrent catalogue loads through the cache", async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb: any) => {
      setTimeout(() => cb(null, JSON.stringify({ models: [{ slug: "gpt-5.5", visibility: "list" }] }), ""), 0);
      return undefined as any;
    });

    const [a, b] = await Promise.all([getCodexModelCatalogue(), getCodexModelCatalogue()]);

    expect(a?.visible.has("gpt-5.5")).toBe(true);
    expect(b?.visible.has("gpt-5.5")).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig, mockDb } = vi.hoisted(() => ({
  mockConfig: {
    GRAFANA_JWT_SIGNING_KEY: "",
    PROD_GRAFANA_URL: "",
    FLEET_GRAFANA_URL: "",
    writeConfig: async () => {},
    PAGES_HOST: null as null | { baseUrl: string },
    getPagesHostConfig: () => mockConfig.PAGES_HOST,
  },
  mockDb: { getPersistedSession: vi.fn() },
}));
vi.mock("./config.js", () => mockConfig);
vi.mock("./db.js", () => mockDb);

import {
  clearPagesReadTokenCache,
  mintPagesReadToken,
  pagesHostname,
  pagesReadEnv,
  parsePagesReadToken,
  verifyPagesReadToken,
} from "./pages-read-token.js";

function row(over: Record<string, unknown> = {}) {
  return { id: "s1", ended_at: null, capabilities: JSON.stringify(["pages"]), ...over };
}

describe("pages read token (#clw_01M619KBVSEV0SNRRXD33YYVQC)", () => {
  beforeEach(() => {
    clearPagesReadTokenCache();
    mockDb.getPersistedSession.mockReset();
    mockConfig.PAGES_HOST = null;
  });

  it("round-trips the session id and is deterministic per session", () => {
    const token = mintPagesReadToken("s1");
    expect(token).toMatch(/^s1\.[A-Za-z0-9_-]+$/);
    expect(mintPagesReadToken("s1")).toBe(token);
    expect(mintPagesReadToken("s2")).not.toBe(token);
    expect(parsePagesReadToken(token)).toBe("s1");
  });

  it("rejects a tampered MAC, a swapped session id and malformed tokens", () => {
    const token = mintPagesReadToken("s1");
    const mac = token.slice(3);
    expect(parsePagesReadToken(`s1.${mac.slice(0, -1)}${mac.endsWith("A") ? "B" : "A"}`)).toBeNull();
    expect(parsePagesReadToken(`s2.${mac}`)).toBeNull();
    for (const bad of ["", "s1", ".abc", "s1."]) expect(parsePagesReadToken(bad)).toBeNull();
  });

  it("verifies only an open session that still holds pages", async () => {
    const token = mintPagesReadToken("s1");
    mockDb.getPersistedSession.mockResolvedValueOnce(row());
    expect(await verifyPagesReadToken(token, 0)).toBe("ok");
    clearPagesReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ ended_at: 123 }));
    expect(await verifyPagesReadToken(token, 0)).toBe("invalid");
    clearPagesReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ capabilities: JSON.stringify(["browser"]) }));
    expect(await verifyPagesReadToken(token, 0)).toBe("invalid");
    clearPagesReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(undefined);
    expect(await verifyPagesReadToken(token, 0)).toBe("invalid");
    expect(await verifyPagesReadToken("s1.forged", 0)).toBe("invalid");
  });

  it("caches a verdict for 30 seconds", async () => {
    const token = mintPagesReadToken("s1");
    mockDb.getPersistedSession.mockResolvedValue(row());
    expect(await verifyPagesReadToken(token, 1_000)).toBe("ok");
    expect(await verifyPagesReadToken(token, 20_000)).toBe("ok");
    expect(mockDb.getPersistedSession).toHaveBeenCalledTimes(1);
    mockDb.getPersistedSession.mockResolvedValue(row({ ended_at: 5 }));
    expect(await verifyPagesReadToken(token, 31_001)).toBe("invalid");
    expect(mockDb.getPersistedSession).toHaveBeenCalledTimes(2);
  });

  it("builds the session env and hostname from the configured pages host", () => {
    expect(pagesReadEnv("s1")).toEqual({});
    expect(pagesHostname()).toBeNull();
    mockConfig.PAGES_HOST = { baseUrl: "https://Pages.example.test" };
    const token = mintPagesReadToken("s1");
    expect(pagesReadEnv("s1")).toEqual({
      CLAWS_PAGES_READ_TOKEN: token,
      CLAWS_PAGES_LOGIN_URL: `https://Pages.example.test/__claws/login/${token}`,
    });
    expect(pagesHostname()).toBe("pages.example.test");
  });
});

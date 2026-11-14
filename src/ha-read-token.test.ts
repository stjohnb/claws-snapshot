import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig, mockDb } = vi.hoisted(() => ({
  mockConfig: {
    GRAFANA_JWT_SIGNING_KEY: "",
    PROD_GRAFANA_URL: "",
    FLEET_GRAFANA_URL: "",
    writeConfig: async () => {},
    SESSION_POD_SETTINGS: { mcpUrl: "" },
  },
  mockDb: { getPersistedSession: vi.fn() },
}));
vi.mock("./config.js", () => mockConfig);
vi.mock("./db.js", () => mockDb);

import { clearHaReadTokenCache, haReadEnv, mintHaReadToken, parseHaReadToken, verifyHaReadToken } from "./ha-read-token.js";
import { mintPagesReadToken } from "./pages-read-token.js";

function row(over: Record<string, unknown> = {}) {
  return { id: "s1", ended_at: null, capabilities: JSON.stringify(["home-assistant-read"]), ...over };
}

describe("Home Assistant read token (#clw_01M77K5B15JHY1N6JMGRZDFQ0D)", () => {
  beforeEach(() => {
    clearHaReadTokenCache();
    mockDb.getPersistedSession.mockReset();
    mockConfig.SESSION_POD_SETTINGS = { mcpUrl: "" };
  });

  it("round-trips the session id, is deterministic per session and differs from the pages token", () => {
    const token = mintHaReadToken("s1");
    expect(token).toMatch(/^s1\.[A-Za-z0-9_-]+$/);
    expect(mintHaReadToken("s1")).toBe(token);
    expect(mintHaReadToken("s2")).not.toBe(token);
    expect(parseHaReadToken(token)).toBe("s1");
    expect(parseHaReadToken(mintPagesReadToken("s1"))).toBeNull();
  });

  it("rejects a swapped session id and malformed tokens", () => {
    const mac = mintHaReadToken("s1").slice(3);
    expect(parseHaReadToken(`s2.${mac}`)).toBeNull();
    for (const bad of ["", "s1", ".abc", "s1."]) expect(parseHaReadToken(bad)).toBeNull();
  });

  it("verifies only an open session that still holds home-assistant-read", async () => {
    const token = mintHaReadToken("s1");
    mockDb.getPersistedSession.mockResolvedValueOnce(row());
    expect(await verifyHaReadToken(token, 0)).toBe("ok");
    clearHaReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ ended_at: 123 }));
    expect(await verifyHaReadToken(token, 0)).toBe("invalid");
    clearHaReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ capabilities: JSON.stringify(["home-assistant", "pages-read"]) }));
    expect(await verifyHaReadToken(token, 0)).toBe("invalid");
    clearHaReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(undefined);
    expect(await verifyHaReadToken(token, 0)).toBe("invalid");
    expect(await verifyHaReadToken("s1.forged", 0)).toBe("invalid");
  });

  it("caches a verdict for 30 seconds", async () => {
    const token = mintHaReadToken("s1");
    mockDb.getPersistedSession.mockResolvedValue(row());
    expect(await verifyHaReadToken(token, 1_000)).toBe("ok");
    expect(await verifyHaReadToken(token, 20_000)).toBe("ok");
    expect(mockDb.getPersistedSession).toHaveBeenCalledTimes(1);
    mockDb.getPersistedSession.mockResolvedValue(row({ ended_at: 5 }));
    expect(await verifyHaReadToken(token, 31_001)).toBe("invalid");
  });

  it("haReadEnv gives the proxy URL and token, never the HA token, and nothing without an MCP URL", () => {
    expect(haReadEnv("s1")).toEqual({});
    mockConfig.SESSION_POD_SETTINGS = { mcpUrl: "https://claws.example.test/" };
    const env = haReadEnv("s1");
    expect(env).toEqual({ CLAWS_HA_READ_URL: "https://claws.example.test/api/ha-read", CLAWS_HA_READ_TOKEN: mintHaReadToken("s1") });
    expect(Object.keys(env)).not.toContain("HOME_ASSISTANT_TOKEN");
  });
});

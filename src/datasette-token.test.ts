import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig, mockDb } = vi.hoisted(() => ({
  mockConfig: {
    GRAFANA_JWT_SIGNING_KEY: "",
    FLEET_GRAFANA_URL: "",
    writeConfig: async () => {},
    SESSION_POD_SETTINGS: { mcpUrl: "" },
  },
  mockDb: { getPersistedSession: vi.fn() },
}));
vi.mock("./config.js", async (importOriginal) => (await import("./test-helpers.js")).completeConfigMock(await importOriginal<typeof import("./config.js")>(), mockConfig));
vi.mock("./db.js", () => mockDb);

import { clearDatasetteTokenCache, datasetteEnv, mintDatasetteToken, parseDatasetteToken, verifyDatasetteToken } from "./datasette-token.js";
import { mintHaReadToken } from "./ha-read-token.js";

function row(over: Record<string, unknown> = {}) {
  return { id: "s1", ended_at: null, capabilities: JSON.stringify(["datasette:prod_namey", "cross-repo"]), ...over };
}

describe("Datasette proxy token (#clw_01M89P9YVSQY0S29YP6KBPJAQQ)", () => {
  beforeEach(() => {
    clearDatasetteTokenCache();
    mockDb.getPersistedSession.mockReset();
    mockConfig.SESSION_POD_SETTINGS = { mcpUrl: "" };
  });

  it("round-trips the session id, is deterministic per session and differs from the HA read token", () => {
    const token = mintDatasetteToken("s1");
    expect(token).toMatch(/^s1\.[A-Za-z0-9_-]+$/);
    expect(mintDatasetteToken("s1")).toBe(token);
    expect(mintDatasetteToken("s2")).not.toBe(token);
    expect(parseDatasetteToken(token)).toBe("s1");
    expect(parseDatasetteToken(mintHaReadToken("s1"))).toBeNull();
  });

  it("rejects a tampered token and malformed tokens", () => {
    const token = mintDatasetteToken("s1");
    expect(parseDatasetteToken(`s2.${token.slice(3)}`)).toBeNull();
    expect(parseDatasetteToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    for (const bad of ["", "s1", ".abc", "s1."]) expect(parseDatasetteToken(bad)).toBeNull();
  });

  it("returns the databases an open session holds, and null for an ended session, none held or a forged token", async () => {
    const token = mintDatasetteToken("s1");
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ capabilities: JSON.stringify(["datasette:prod_namey", "datasette:garden", "pages-read"]) }));
    const ok = await verifyDatasetteToken(token, 0);
    expect(ok?.sessionId).toBe("s1");
    expect([...(ok?.databases ?? [])].sort()).toEqual(["garden", "prod_namey"]);
    clearDatasetteTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ ended_at: 123 }));
    expect(await verifyDatasetteToken(token, 0)).toBeNull();
    clearDatasetteTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ capabilities: JSON.stringify(["home-assistant-read", "datasette:"]) }));
    expect(await verifyDatasetteToken(token, 0)).toBeNull();
    clearDatasetteTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ capabilities: "not json" }));
    expect(await verifyDatasetteToken(token, 0)).toBeNull();
    clearDatasetteTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(undefined);
    expect(await verifyDatasetteToken(token, 0)).toBeNull();
    expect(await verifyDatasetteToken("s1.forged", 0)).toBeNull();
  });

  it("caches a verdict for 30 seconds, then follows a capability change", async () => {
    const token = mintDatasetteToken("s1");
    mockDb.getPersistedSession.mockResolvedValue(row());
    expect([...(await verifyDatasetteToken(token, 1_000))!.databases]).toEqual(["prod_namey"]);
    mockDb.getPersistedSession.mockResolvedValue(row({ capabilities: JSON.stringify(["datasette:garden"]) }));
    expect([...(await verifyDatasetteToken(token, 20_000))!.databases]).toEqual(["prod_namey"]);
    expect(mockDb.getPersistedSession).toHaveBeenCalledTimes(1);
    expect([...(await verifyDatasetteToken(token, 31_001))!.databases]).toEqual(["garden"]);
    clearDatasetteTokenCache();
    mockDb.getPersistedSession.mockResolvedValue(row({ capabilities: JSON.stringify(["cross-repo"]) }));
    expect(await verifyDatasetteToken(token, 31_002)).toBeNull();
  });

  it("datasetteEnv gives the proxy URL and token, and nothing without an MCP URL", () => {
    expect(datasetteEnv("s1")).toEqual({});
    mockConfig.SESSION_POD_SETTINGS = { mcpUrl: "https://claws.example.test/" };
    expect(datasetteEnv("s1")).toEqual({ CLAWS_DATASETTE_URL: "https://claws.example.test/api/datasette", CLAWS_DATASETTE_TOKEN: mintDatasetteToken("s1") });
  });
});

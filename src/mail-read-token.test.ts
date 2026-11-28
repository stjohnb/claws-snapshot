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

import { clearMailReadTokenCache, mailReadEnv, mintMailReadToken, parseMailReadToken, verifyMailReadToken } from "./mail-read-token.js";
import { mintHaReadToken } from "./ha-read-token.js";
import { mintDatasetteToken } from "./datasette-token.js";

function row(over: Record<string, unknown> = {}) {
  return { id: "s1", ended_at: null, capabilities: JSON.stringify(["prod-mail-read", "cross-repo"]), ...over };
}

describe("prod mailbox read token (#clw_01M8BM2RWC1T085EEEVZ6X21EH)", () => {
  beforeEach(() => {
    clearMailReadTokenCache();
    mockDb.getPersistedSession.mockReset();
    mockConfig.SESSION_POD_SETTINGS = { mcpUrl: "" };
  });

  it("round-trips the session id, is deterministic per session and differs from the other proxy tokens", () => {
    const token = mintMailReadToken("s1");
    expect(token).toMatch(/^s1\.[A-Za-z0-9_-]+$/);
    expect(mintMailReadToken("s1")).toBe(token);
    expect(mintMailReadToken("s2")).not.toBe(token);
    expect(parseMailReadToken(token)).toBe("s1");
    expect(parseMailReadToken(mintHaReadToken("s1"))).toBeNull();
    expect(parseMailReadToken(mintDatasetteToken("s1"))).toBeNull();
  });

  it("rejects a tampered token and malformed tokens", () => {
    const token = mintMailReadToken("s1");
    expect(parseMailReadToken(`s2.${token.slice(3)}`)).toBeNull();
    expect(parseMailReadToken(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`)).toBeNull();
    for (const bad of ["", "s1", ".abc", "s1."]) expect(parseMailReadToken(bad)).toBeNull();
  });

  it("returns the session id only while the session is open and holds prod-mail-read", async () => {
    const token = mintMailReadToken("s1");
    mockDb.getPersistedSession.mockResolvedValueOnce(row());
    expect(await verifyMailReadToken(token, 0)).toBe("s1");
    clearMailReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ ended_at: 123 }));
    expect(await verifyMailReadToken(token, 0)).toBeNull();
    clearMailReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ capabilities: JSON.stringify(["home-assistant-read", "datasette:prod_namey"]) }));
    expect(await verifyMailReadToken(token, 0)).toBeNull();
    clearMailReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(row({ capabilities: "not json" }));
    expect(await verifyMailReadToken(token, 0)).toBeNull();
    clearMailReadTokenCache();
    mockDb.getPersistedSession.mockResolvedValueOnce(undefined);
    expect(await verifyMailReadToken(token, 0)).toBeNull();
    expect(await verifyMailReadToken("s1.forged", 0)).toBeNull();
  });

  it("caches a verdict for 30 seconds, then follows a revoke", async () => {
    const token = mintMailReadToken("s1");
    mockDb.getPersistedSession.mockResolvedValue(row());
    expect(await verifyMailReadToken(token, 1_000)).toBe("s1");
    mockDb.getPersistedSession.mockResolvedValue(row({ capabilities: JSON.stringify(["cross-repo"]) }));
    expect(await verifyMailReadToken(token, 20_000)).toBe("s1");
    expect(mockDb.getPersistedSession).toHaveBeenCalledTimes(1);
    expect(await verifyMailReadToken(token, 31_001)).toBeNull();
  });

  it("mailReadEnv gives the proxy URL and token, and nothing without an MCP URL", () => {
    expect(mailReadEnv("s1")).toEqual({});
    mockConfig.SESSION_POD_SETTINGS = { mcpUrl: "https://claws.example.test/" };
    expect(mailReadEnv("s1")).toEqual({ CLAWS_MAIL_READ_URL: "https://claws.example.test/api/mail-read", CLAWS_MAIL_READ_TOKEN: mintMailReadToken("s1") });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Row = {
  id: string;
  label: string;
  token: string | null;
  position: number;
  email?: string | null;
  org_uuid?: string | null;
  org_name?: string | null;
  plan?: string | null;
  identity_source?: string | null;
  identity_checked_at?: string | null;
};

const mockDb = vi.hoisted(() => ({
  rows: [] as Row[],
  listClaudeAccounts: vi.fn(async () => mockDb.rows.map((r) => ({ ...r }))),
  setClaudeAccountIdentity: vi.fn(async (id: string, token: string, identity: { email: string | null; orgUuid: string | null; orgName: string | null; plan: string | null; source: string | null; checkedAt: string } | null) => {
    const row = mockDb.rows.find((r) => r.id === id && r.token === token);
    if (!row) return false;
    Object.assign(row, {
      email: identity?.email ?? null,
      org_uuid: identity?.orgUuid ?? null,
      org_name: identity?.orgName ?? null,
      plan: identity?.plan ?? null,
      identity_source: identity?.source ?? null,
      identity_checked_at: identity?.checkedAt ?? null,
    });
    return true;
  }),
  labelClaudeAccountIfDefault: vi.fn(async (id: string, label: string) => {
    const row = mockDb.rows.find((r) => r.id === id && (r.label === "" || r.label === id));
    if (row) row.label = label;
    return !!row;
  }),
}));
vi.mock("./db.js", () => mockDb);
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./log.js", () => mockLog);

import { backfillClaudeAccountIdentities, lookupClaudeIdentity, parseProfile, refreshClaudeAccountIdentity } from "./claude-account-identity.js";
import { __resetClaudeAccountsForTests, findClaudeAccount, refreshClaudeAccounts } from "./claude-accounts.js";

const TOKEN = "sk-ant-oat01-IDENTITY-SECRET";
const fetchMock = vi.fn();

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

const PROFILE = {
  account: { uuid: "acct-1", email_address: "max@example.com", has_claude_max: true },
  organization: { uuid: "org-uuid-1234567890", name: "Max Org", organization_type: "claude_max" },
};

async function seed(rows: Row[]): Promise<void> {
  mockDb.rows = rows;
  await refreshClaudeAccounts();
}

function logged(): string {
  return JSON.stringify([...mockLog.info.mock.calls, ...mockLog.warn.mock.calls, ...mockLog.debug.mock.calls, ...mockLog.error.mock.calls]);
}

beforeEach(() => {
  __resetClaudeAccountsForTests();
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseProfile", () => {
  it("reads email, org and plan, falling back across field names", () => {
    expect(parseProfile(PROFILE)).toEqual({ email: "max@example.com", orgUuid: "org-uuid-1234567890", orgName: "Max Org", plan: "claude_max" });
    expect(parseProfile({ account: { email: "p@example.com", has_claude_pro: true } })).toEqual({ email: "p@example.com", orgUuid: null, orgName: null, plan: "pro" });
  });

  it("is null for a body naming no identity", () => {
    expect(parseProfile({})).toBeNull();
    expect(parseProfile(null)).toBeNull();
    expect(parseProfile({ account: { email: 42 } })).toBeNull();
  });
});

describe("lookupClaudeIdentity", () => {
  it("uses the profile endpoint with the OAuth bearer and beta headers", async () => {
    fetchMock.mockResolvedValueOnce(res(200, PROFILE));
    expect(await lookupClaudeIdentity(TOKEN)).toMatchObject({ email: "max@example.com", source: "profile" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/api/oauth/profile");
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}`, "anthropic-beta": "oauth-2025-04-20" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the org-id header of /v1/models whatever its status", async () => {
    fetchMock.mockResolvedValueOnce(res(403, { error: "scope" }));
    fetchMock.mockResolvedValueOnce(res(401, {}, { "anthropic-organization-id": "org-from-header" }));
    expect(await lookupClaudeIdentity(TOKEN)).toEqual({ email: null, orgUuid: "org-from-header", orgName: null, plan: null, source: "org-header" });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.anthropic.com/v1/models");
  });

  it("falls back when a 200 profile names no identity, and is null when neither path answers", async () => {
    fetchMock.mockResolvedValueOnce(res(200, {}));
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    expect(await lookupClaudeIdentity(TOKEN)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("logs each call with its target, status and duration, never the token", async () => {
    fetchMock.mockResolvedValueOnce(res(403));
    fetchMock.mockResolvedValueOnce(res(200, {}, { "anthropic-organization-id": "org-x" }));
    await lookupClaudeIdentity(TOKEN);
    expect(mockLog.info).toHaveBeenCalledWith("claude identity lookup", expect.objectContaining({ component: "claude-identity", target: "/api/oauth/profile", status: 403, duration_ms: expect.any(Number) }));
    expect(mockLog.info).toHaveBeenCalledWith("claude identity lookup", expect.objectContaining({ target: "/v1/models", status: 200 }));
    expect(logged()).not.toContain("sk-ant-");
  });
});

describe("refreshClaudeAccountIdentity", () => {
  it("stores the profile identity and replaces a default label with the email", async () => {
    await seed([{ id: "primary", label: "primary", token: TOKEN, position: 0 }]);
    fetchMock.mockResolvedValueOnce(res(200, PROFILE));
    await refreshClaudeAccountIdentity("primary");
    const account = findClaudeAccount("primary")!;
    expect(account.label).toBe("max@example.com");
    expect(account.identity).toMatchObject({ email: "max@example.com", orgUuid: "org-uuid-1234567890", orgName: "Max Org", plan: "claude_max", source: "profile" });
    expect(account.identity!.checkedAt).toEqual(expect.any(String));
    expect(JSON.stringify(account)).not.toContain(TOKEN);
    expect(logged()).not.toContain("sk-ant-");
  });

  it("keeps a label the operator typed, and cuts a long email to the label limit", async () => {
    await seed([
      { id: "primary", label: "Main Max", token: TOKEN, position: 0 },
      { id: "second", label: "", token: TOKEN, position: 1 },
    ]);
    fetchMock.mockResolvedValueOnce(res(200, PROFILE));
    await refreshClaudeAccountIdentity("primary");
    expect(findClaudeAccount("primary")!.label).toBe("Main Max");
    const long = `${"x".repeat(70)}@example.com`;
    fetchMock.mockResolvedValueOnce(res(200, { account: { email_address: long } }));
    await refreshClaudeAccountIdentity("second");
    expect(findClaudeAccount("second")!.label).toBe(long.slice(0, 64));
  });

  it("drops a lookup a newer login superseded, and looks the new token up on its own", async () => {
    await seed([{ id: "primary", label: "primary", token: TOKEN, position: 0 }]);
    let answerOld!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => (answerOld = r)));
    const old = refreshClaudeAccountIdentity("primary");
    // A re-login stores a new token (and clears the identity) while the old lookup is pending.
    const NEW = "sk-ant-oat01-NEW-SECRET";
    mockDb.rows[0] = { id: "primary", label: "primary", token: NEW, position: 0 };
    await refreshClaudeAccounts();
    fetchMock.mockResolvedValueOnce(res(200, { account: { email_address: "new@example.com" } }));
    const fresh = refreshClaudeAccountIdentity("primary");
    expect(fresh).not.toBe(old);
    await fresh;
    answerOld(res(200, PROFILE));
    await old;
    const account = findClaudeAccount("primary")!;
    expect(account.label).toBe("new@example.com");
    expect(account.identity).toMatchObject({ email: "new@example.com" });
    expect(mockLog.info).toHaveBeenCalledWith("claude identity superseded", expect.objectContaining({ account: "primary" }));
  });

  it("keeps a label the operator typed while the lookup ran", async () => {
    await seed([{ id: "primary", label: "primary", token: TOKEN, position: 0 }]);
    fetchMock.mockImplementationOnce(async () => {
      mockDb.rows[0]!.label = "Typed";
      return res(200, PROFILE);
    });
    await refreshClaudeAccountIdentity("primary");
    expect(findClaudeAccount("primary")!.label).toBe("Typed");
  });

  it("stores the header org when the profile is refused", async () => {
    await seed([{ id: "primary", label: "primary", token: TOKEN, position: 0 }]);
    fetchMock.mockResolvedValueOnce(res(403));
    fetchMock.mockResolvedValueOnce(res(200, {}, { "anthropic-organization-id": "org-hdr" }));
    await refreshClaudeAccountIdentity("primary");
    const account = findClaudeAccount("primary")!;
    expect(account.label).toBe("primary");
    expect(account.identity).toMatchObject({ email: null, orgUuid: "org-hdr", source: "org-header" });
  });

  it("records the check even when nothing comes back, so a page load does not ask again", async () => {
    await seed([{ id: "primary", label: "primary", token: TOKEN, position: 0 }]);
    fetchMock.mockResolvedValue(res(401));
    await refreshClaudeAccountIdentity("primary");
    const identity = findClaudeAccount("primary")!.identity!;
    expect(identity).toMatchObject({ email: null, orgUuid: null, source: null });
    expect(identity.checkedAt).toEqual(expect.any(String));
    fetchMock.mockClear();
    backfillClaudeAccountIdentities();
    await Promise.resolve();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing for an account with no token, shares a concurrent lookup, and never throws", async () => {
    await seed([
      { id: "primary", label: "primary", token: TOKEN, position: 0 },
      { id: "empty", label: "empty", token: null, position: 1 },
    ]);
    await refreshClaudeAccountIdentity("empty");
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(res(200, PROFILE));
    const a = refreshClaudeAccountIdentity("primary");
    expect(refreshClaudeAccountIdentity("primary")).toBe(a);
    await a;
    expect(fetchMock).toHaveBeenCalledTimes(1);

    mockDb.setClaudeAccountIdentity.mockRejectedValueOnce(new Error("db down"));
    fetchMock.mockResolvedValueOnce(res(200, PROFILE));
    await expect(refreshClaudeAccountIdentity("primary")).resolves.toBeUndefined();
    expect(mockLog.warn).toHaveBeenCalledWith("claude identity refresh failed", expect.objectContaining({ account: "primary" }), expect.any(Error));
  });

  it("backfills only accounts with a token that were never checked", async () => {
    await seed([
      { id: "primary", label: "primary", token: TOKEN, position: 0 },
      { id: "checked", label: "checked", token: TOKEN, position: 1, identity_checked_at: "2026-10-01T00:00:00.000Z" },
      { id: "empty", label: "empty", token: null, position: 2 },
    ]);
    fetchMock.mockResolvedValue(res(200, PROFILE));
    backfillClaudeAccountIdentities();
    await vi.waitFor(() => expect(mockDb.setClaudeAccountIdentity).toHaveBeenCalledTimes(1));
    expect(mockDb.setClaudeAccountIdentity).toHaveBeenCalledWith("primary", TOKEN, expect.any(Object));
  });
});

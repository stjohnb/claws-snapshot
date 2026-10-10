import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    recordImportedIssue: vi.fn(),
    listImportedIssues: vi.fn(),
  },
}));
vi.mock("./db.js", () => mockDb);

import { loadImportedRefs, recordImport, resolveImportedRef, issueRefAliases, resetImportedRefsForTest } from "./imported-refs.js";
import { resolveImportedRef as resolveFromIndex } from "./imported-refs-index.js";

const NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const OTHER_NATIVE_ID = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDE";

describe("imported-refs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.listImportedIssues.mockResolvedValue([]);
    mockDb.recordImportedIssue.mockResolvedValue(true);
    resetImportedRefsForTest();
  });

  it("leaves the index alone when the durable row names another native issue", async () => {
    // The `(repo, forge_number)` row is the durable answer and it was taken by
    // a concurrent import. Indexing this call's id anyway would resolve the
    // forge ref to an issue the database does not agree with until the next
    // restart, and to nothing at all after it.
    mockDb.recordImportedIssue.mockResolvedValue(false);

    expect(await recordImport("o/r", 7, NATIVE_ID)).toBe(false);
    expect(resolveImportedRef("o/r", 7)).toBe(7);
    expect(issueRefAliases("o/r", NATIVE_ID)).toEqual([NATIVE_ID]);
  });

  it("resolves an imported forge number to the native id it became", async () => {
    expect(await recordImport("o/r", 7, NATIVE_ID)).toBe(true);
    expect(resolveImportedRef("o/r", 7)).toBe(NATIVE_ID);
    expect(mockDb.recordImportedIssue).toHaveBeenCalledWith("o/r", 7, NATIVE_ID);
  });

  it("is repo-scoped, because forge numbers collide across repositories", async () => {
    await recordImport("o/r", 7, NATIVE_ID);
    await recordImport("o/other", 7, OTHER_NATIVE_ID);

    expect(resolveImportedRef("o/r", 7)).toBe(NATIVE_ID);
    expect(resolveImportedRef("o/other", 7)).toBe(OTHER_NATIVE_ID);
    expect(resolveImportedRef("o/third", 7)).toBe(7);
  });

  it("round-trips an unknown ref unchanged, canonicalised", () => {
    expect(resolveImportedRef("o/r", 7)).toBe(7);
    expect(resolveImportedRef("o/r", "7")).toBe(7);
    expect(resolveImportedRef("o/r", NATIVE_ID)).toBe(NATIVE_ID);
  });

  it("does not resolve the native id back to the forge number", async () => {
    // Resolution is one-directional: the native id is the live issue, and a
    // caller that needs both spellings asks for the aliases.
    await recordImport("o/r", 7, NATIVE_ID);
    expect(resolveImportedRef("o/r", NATIVE_ID)).toBe(NATIVE_ID);
  });

  it("returns one alias for an unknown ref", () => {
    expect(issueRefAliases("o/r", 7)).toEqual([7]);
    expect(issueRefAliases("o/r", NATIVE_ID)).toEqual([NATIVE_ID]);
  });

  it("returns both sides of a known pair, canonical ref first", async () => {
    await recordImport("o/r", 7, NATIVE_ID);
    expect(issueRefAliases("o/r", 7)).toEqual([7, NATIVE_ID]);
    expect(issueRefAliases("o/r", NATIVE_ID)).toEqual([NATIVE_ID, 7]);
  });

  it("resolves and aliases a lower-cased native id", async () => {
    await recordImport("o/r", 7, NATIVE_ID.toLowerCase());
    expect(resolveImportedRef("o/r", 7)).toBe(NATIVE_ID);
    expect(issueRefAliases("o/r", NATIVE_ID.toLowerCase())).toEqual([NATIVE_ID, 7]);
  });

  it("loads the index from the table and replaces whatever was there", async () => {
    await recordImport("o/r", 7, NATIVE_ID);
    mockDb.listImportedIssues.mockResolvedValue([{ repo: "o/other", forgeNumber: 42, nativeId: OTHER_NATIVE_ID }]);

    await loadImportedRefs();

    expect(resolveImportedRef("o/r", 7)).toBe(7);
    expect(resolveImportedRef("o/other", 42)).toBe(OTHER_NATIVE_ID);
  });

  it("skips a row whose native id does not canonicalise, keeping the rest of the index", async () => {
    // One corrupt row must not poison the whole index — every later row still
    // loads, so resolution degrades by exactly that one pair.
    mockDb.listImportedIssues.mockResolvedValue([
      { repo: "o/r", forgeNumber: 7, nativeId: "not-an-id" },
      { repo: "o/r", forgeNumber: 8, nativeId: NATIVE_ID },
    ]);

    await loadImportedRefs();

    expect(resolveImportedRef("o/r", 8)).toBe(NATIVE_ID);
    expect(resolveImportedRef("o/r", 7)).toBe(7);
    expect(issueRefAliases("o/r", 7)).toEqual([7]);
  });

  it("loadImportedRefs populates the leaf imported-refs-index module directly", async () => {
    // config.ts's issueUrl reads ./imported-refs-index.js directly, bypassing
    // this module entirely, so loadImportedRefs must reach that same index.
    mockDb.listImportedIssues.mockResolvedValue([{ repo: "o/r", forgeNumber: 7, nativeId: NATIVE_ID }]);

    await loadImportedRefs();

    expect(resolveFromIndex("o/r", 7)).toBe(NATIVE_ID);
  });

  it("resolves nothing before the index is loaded", () => {
    // A boot-order slip must degrade to the pre-import behaviour rather than
    // mis-resolve a ref to the wrong issue.
    expect(resolveImportedRef("o/r", 7)).toBe(7);
    expect(issueRefAliases("o/r", 7)).toEqual([7]);
  });
});

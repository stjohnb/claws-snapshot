// The issue page's reference resolver: which refs link, and where. The store
// is a small fake keyed like the real tables.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { state } = vi.hoisted(() => ({
  state: {
    issues: new Set<string>(),
    prs: new Set<string>(),
    imported: new Map<string, string>(),
  },
}));

vi.mock("./db.js", () => ({
  getClawsIssue: vi.fn(async (id: string) => (state.issues.has(id) ? { id } : undefined)),
  clawsIssueExists: vi.fn(async (id: string) => state.issues.has(id)),
  getClawsPr: vi.fn(async (repo: string, n: number) => (state.prs.has(`${repo}#${n}`) ? { repo, prNumber: n } : null)),
  getLinkedNativeId: vi.fn(async (repo: string, n: number) => state.imported.get(`${repo}#${n}`)),
}));
vi.mock("./config.js", () => ({
  prUrl: (repo: string, n: number) => `https://forge.example/${repo}/pulls/${n}`,
}));

import { resolveIssueRefLinks } from "./issue-ref-links.js";
import * as db from "./db.js";

const NATIVE = "clw_01JBQ0000000000000000000AA";
const SHADOW = "clw_01JBQ0000000000000000000SH";

beforeEach(() => {
  state.issues = new Set([NATIVE]);
  state.prs = new Set(["o/b#5"]);
  state.imported = new Map([["o/a#9", SHADOW], ["o/b#9", "clw_01JBQ0000000000000000000XX"]]);
  vi.clearAllMocks();
});

describe("resolveIssueRefLinks", () => {
  it("links a known native id, in any case, and not an unknown one", async () => {
    const refs = await resolveIssueRefLinks([`#${NATIVE.toLowerCase()} clw_01JBQ0000000000000000000ZZ`], []);
    expect(refs.hrefFor(NATIVE)).toBe(`/issues/${NATIVE}`);
    expect(refs.hrefFor("clw_01JBQ0000000000000000000ZZ")).toBeUndefined();
  });

  it("links a claws_prs row to its PR and an imported issue to its native page", async () => {
    const refs = await resolveIssueRefLinks(["o/b#5 and o/a#9"], []);
    expect(refs.hrefFor("o/b#5")).toBe("https://forge.example/o/b/pulls/5");
    expect(refs.hrefFor("o/a#9")).toBe(`/issues/${SHADOW}`);
  });

  it("tries the issue's repos in sorted order for a bare #N", async () => {
    const refs = await resolveIssueRefLinks(["#9", "#5"], ["o/b", "o/a"]);
    expect(refs.hrefFor("#9")).toBe(`/issues/${SHADOW}`);
    expect(refs.hrefFor("#5")).toBe("https://forge.example/o/b/pulls/5");
  });

  it("resolves an unknown number to nothing", async () => {
    const refs = await resolveIssueRefLinks(["#404"], ["o/a", "o/b"]);
    expect(refs.hrefFor("#404")).toBeUndefined();
  });

  it("resolves no bare #N for an issue with no repos", async () => {
    const refs = await resolveIssueRefLinks(["#5 #9"], []);
    expect(refs.hrefFor("#5")).toBeUndefined();
    expect(refs.hrefFor("#9")).toBeUndefined();
    expect(db.getClawsPr).not.toHaveBeenCalled();
  });

  it("looks each distinct ref up once across texts", async () => {
    await resolveIssueRefLinks(["o/b#5", "o/b#5 again"], []);
    expect(db.getClawsPr).toHaveBeenCalledTimes(1);
  });
});

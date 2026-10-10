import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  DASHBOARD_URL: "https://claws.example.invalid",
  LABELS: { duplicate: "Duplicate", blocked: "Blocked", ready: "Ready" },
  isAgentDisabled: () => false,
}));

vi.mock("./log.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

const mockEnqueue = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock("./worker.js", () => ({
  enqueue: mockEnqueue,
  AGENT_KINDS: { ISSUE_REFINER_REPLAN: "issue-refiner:replan" },
}));

// The façade, reduced to the native path the link layer uses: comments land in
// the real native store, carrying the Claws marker `github.ts` would add.
vi.mock("./github.js", async () => {
  const claws = await import("./claws-issues.js");
  const markers = await import("./marker-text.js");
  return {
    isClawsComment: markers.isClawsComment,
    hasPriorityLabel: () => false,
    getIssueComments: vi.fn(async (_repo: string, ref: string) => await claws.getIssueComments(ref)),
    commentOnIssue: vi.fn(async (repo: string, ref: string, body: string, opts?: { agentName?: string }) => {
      await claws.commentOnIssue(repo, ref, `*— Automated by Claws · ${opts?.agentName ?? "Claws"} —*\n\n${body}`, claws.CLAWS_NATIVE_LOGIN);
    }),
  };
});

import { initDb, closeDb, createShadowIssue, enqueueWork, listClawsIssueLinks, upsertClawsPr } from "./db.js";
import * as claws from "./claws-issues.js";
import * as gh from "./github.js";
import { LinkError, addLink, listLinks, listOpenDependencies, parseLinkKind, releaseDependencyParkedIssues, removeLink, resolveLinkTarget } from "./issue-links.js";
import { BLOCKED_PLAN_SENTENCE } from "./plan-parser.js";

const REPO = "org/a";
const PLAN = "*— Automated by Claws · Planner —*\n\n## Implementation Plan\n\nDo the thing.";

async function issue(title: string, opts: { labels?: string[]; repos?: string[] } = {}): Promise<string> {
  return await claws.createIssue({ title, authorLogin: "stjohnb", repos: opts.repos ?? [REPO], labels: opts.labels });
}

async function lifecycleOf(id: string): Promise<string | undefined> {
  return (await claws.getIssue(id))?.lifecycle;
}

beforeEach(async () => {
  await initDb();
  vi.clearAllMocks();
});

afterEach(async () => {
  await closeDb();
});

describe("parseLinkKind", () => {
  it("accepts the three kinds in any reasonable spelling", () => {
    expect(parseLinkKind("depends_on")).toBe("depends_on");
    expect(parseLinkKind("Depends on")).toBe("depends_on");
    expect(parseLinkKind("relates-to")).toBe("relates_to");
    expect(parseLinkKind("blocks")).toBe("blocks");
    expect(parseLinkKind("duplicate_of")).toBeNull();
    expect(parseLinkKind(undefined)).toBeNull();
  });
});

describe("resolveLinkTarget", () => {
  it("resolves native ids in any case, and forge refs through their shadow", async () => {
    const a = await issue("A");
    expect(await resolveLinkTarget(a.toLowerCase(), REPO)).toBe(a);
    expect(await resolveLinkTarget(`https://claws.example.invalid/issues/${a}`, REPO)).toBe(a);
    const shadow = (await createShadowIssue("org/b", 12, { title: "Forge", authorLogin: "x" }))!.id;
    expect(await resolveLinkTarget("org/b#12", REPO)).toBe(shadow);
    expect(await resolveLinkTarget("https://github.com/org/b/issues/12", REPO)).toBe(shadow);
    const inRepo = (await createShadowIssue(REPO, 7, { title: "Local", authorLogin: "x" }))!.id;
    expect(await resolveLinkTarget("#7", REPO)).toBe(inRepo);
  });

  it("rejects unknown and untracked refs", async () => {
    await expect(resolveLinkTarget("clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC", REPO)).rejects.toBeInstanceOf(LinkError);
    await expect(resolveLinkTarget("org/b#99", REPO)).rejects.toThrow(/not tracked by Claws/);
    await expect(resolveLinkTarget("#3", "")).rejects.toThrow(/names no repository/);
    await expect(resolveLinkTarget("nonsense", REPO)).rejects.toThrow(/Not an issue reference/);
  });
});

describe("addLink", () => {
  it("stores blocks as the inverse depends_on, visible from both ends", async () => {
    const a = await issue("A");
    const b = await issue("B", { labels: ["Ready"] });
    const { link } = await addLink(REPO, a, "blocks", b, "stjohnb");
    expect(link).toMatchObject({ kind: "blocks", otherId: b });
    const [row] = await listClawsIssueLinks(a);
    expect(row).toMatchObject({ source_id: b, target_id: a, kind: "depends_on" });
    expect((await listLinks(REPO, b)).map((l) => [l.kind, l.otherId])).toEqual([["depends_on", a]]);
  });

  it("dedups relates_to in both directions", async () => {
    const a = await issue("A");
    const b = await issue("B");
    expect((await addLink(REPO, a, "relates_to", b, "x")).created).toBe(true);
    expect((await addLink(REPO, b, "relates_to", a, "x")).created).toBe(false);
    expect(await listClawsIssueLinks(a)).toHaveLength(1);
    expect((await listLinks(REPO, b))[0]).toMatchObject({ kind: "relates_to", otherId: a });
  });

  it("rejects self-links and a shadow acting issue", async () => {
    const a = await issue("A");
    await expect(addLink(REPO, a, "depends_on", a, "x")).rejects.toThrow(/itself/);
    const shadow = (await createShadowIssue(REPO, 5, { title: "S", authorLogin: "x" }))!.id;
    await expect(addLink(REPO, shadow, "depends_on", a, "x")).rejects.toMatchObject({ status: 404 });
  });

  it("parks the dependent on an open target with a comment", async () => {
    const a = await issue("A", { labels: ["Ready"] });
    const b = await issue("B");
    const { parked } = await addLink(REPO, a, "depends_on", b, "x");
    expect(parked).toBe(true);
    expect(await lifecycleOf(a)).toBe("blocked");
    expect(vi.mocked(gh.commentOnIssue)).toHaveBeenCalledWith(REPO, a, expect.stringContaining(`depends on #${b} — B, which is still open`), { agentName: "Issue links" });
  });

  it("does not park on a closed target, a Backlog issue or one with an open PR", async () => {
    const closed = await issue("Closed");
    await claws.closeIssue(REPO, closed, "completed");
    const a = await issue("A");
    expect((await addLink(REPO, a, "depends_on", closed, "x")).parked).toBe(false);
    expect(await lifecycleOf(a)).toBe("ideas");
    expect((await listClawsIssueLinks(a))[0]!.released_at).not.toBeNull();

    const open = await issue("Open");
    const backlog = await issue("Backlog", { labels: ["Backlog"] });
    expect((await addLink(REPO, backlog, "depends_on", open, "x")).parked).toBe(false);
    expect(await lifecycleOf(backlog)).toBe("backlog");
    const withPr = await issue("With PR");
    await upsertClawsPr(REPO, 7, { stage: "awaiting-review", issueId: withPr });
    expect((await addLink(REPO, withPr, "depends_on", open, "x")).parked).toBe(false);
    expect(await lifecycleOf(withPr)).toBe("ideas");

    // A merged PR is no longer in flight: the issue parks as any other would.
    const merged = await issue("Merged PR");
    await upsertClawsPr(REPO, 8, { stage: "merged", issueId: merged });
    expect((await addLink(REPO, merged, "depends_on", open, "x")).parked).toBe(true);
    expect(await lifecycleOf(merged)).toBe("blocked");
  });
});

describe("removeLink", () => {
  it("removes a link from either end, and 404s for another issue's link", async () => {
    const a = await issue("A");
    const b = await issue("B");
    const c = await issue("C");
    const { link } = await addLink(REPO, a, "relates_to", b, "x");
    await expect(removeLink(REPO, c, link.id)).rejects.toMatchObject({ status: 404 });
    await removeLink(REPO, b, link.id);
    expect(await listLinks(REPO, a)).toEqual([]);
  });
});

describe("listOpenDependencies", () => {
  it("gates on an open dependency, native or through a forge issue's shadow", async () => {
    const a = await issue("A");
    const b = await issue("B");
    expect(await listOpenDependencies(REPO, a)).toEqual([]);
    await addLink(REPO, a, "depends_on", b, "x");
    expect(await listOpenDependencies(REPO, a)).toEqual([{ id: b, title: "B" }]);
    await claws.closeIssue(REPO, b, "completed");
    expect(await listOpenDependencies(REPO, a)).toEqual([]);

    const shadow = (await createShadowIssue(REPO, 44, { title: "Forge", authorLogin: "x" }))!.id;
    const d = await issue("D");
    await addLink(REPO, d, "blocks", shadow, "x");
    expect(await listOpenDependencies(REPO, 44)).toEqual([{ id: d, title: "D" }]);
  });
});

describe("releaseDependencyParkedIssues", () => {
  it("releases only once every unreleased dependency has closed", async () => {
    const a = await issue("A");
    const b = await issue("B");
    const c = await issue("C");
    await addLink(REPO, a, "depends_on", b, "x");
    await addLink(REPO, a, "depends_on", c, "x");
    await claws.closeIssue(REPO, b, "completed");
    expect(await releaseDependencyParkedIssues(REPO)).toEqual([]);
    expect(await lifecycleOf(a)).toBe("blocked");

    await claws.closeIssue(REPO, c, "not_planned");
    vi.mocked(gh.commentOnIssue).mockClear();
    expect(await releaseDependencyParkedIssues(REPO)).toEqual([a]);
    // No plan yet: back to Ideas, its requirements unapproved.
    expect(await lifecycleOf(a)).toBe("ideas");
    const comment = vi.mocked(gh.commentOnIssue).mock.calls[0]![2];
    expect(comment).toContain(`- #${b} — B (closed as completed)`);
    expect(comment).toContain(`- #${c} — C (closed as not planned)`);
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect((await listClawsIssueLinks(a)).every((l) => l.released_at !== null)).toBe(true);

    // A human re-park is not undone: the links have fired.
    await claws.setLifecycle(REPO, a, "blocked");
    expect(await releaseDependencyParkedIssues(REPO)).toEqual([]);
    expect(await lifecycleOf(a)).toBe("blocked");
  });

  it("marks an issue with a real plan Ready", async () => {
    const a = await issue("A", { labels: ["Ready"] });
    await claws.commentOnIssue(REPO, a, PLAN, "claws");
    const b = await issue("B");
    await addLink(REPO, a, "depends_on", b, "x");
    await claws.closeIssue(REPO, b, "completed");
    expect(await releaseDependencyParkedIssues(REPO)).toEqual([a]);
    expect(await lifecycleOf(a)).toBe("awaiting-plan-review");
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("re-plans an issue whose last plan is the blocked verdict", async () => {
    const a = await issue("A");
    await claws.commentOnIssue(REPO, a, PLAN, "claws");
    await claws.commentOnIssue(REPO, a, `*— Automated by Claws · Planner —*\n\n## Implementation Plan\n\n${BLOCKED_PLAN_SENTENCE} and cannot be implemented yet.`, "claws");
    const b = await issue("B");
    await addLink(REPO, a, "depends_on", b, "x");
    await claws.closeIssue(REPO, b, "completed");
    expect(await releaseDependencyParkedIssues(REPO)).toEqual([a]);
    expect(await lifecycleOf(a)).toBe("planning");
    expect(mockEnqueue).toHaveBeenCalledWith("issue-refiner:replan", REPO, a, { priority: false });
  });

  it("defers an issue whose planner work is still queued or running", async () => {
    const a = await issue("A");
    const b = await issue("B");
    await addLink(REPO, a, "depends_on", b, "x");
    await claws.closeIssue(REPO, b, "completed");
    await enqueueWork("issue-refiner:replan", REPO, a);

    expect(await releaseDependencyParkedIssues(REPO)).toEqual([]);
    expect(await lifecycleOf(a)).toBe("blocked");
    expect((await listClawsIssueLinks(a)).every((l) => l.released_at === null)).toBe(true);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("only sweeps issues whose primary repo is the one asked about", async () => {
    const a = await issue("A", { repos: ["org/z"] });
    const b = await issue("B");
    await addLink("org/z", a, "depends_on", b, "x");
    await claws.closeIssue(REPO, b, "completed");
    expect(await releaseDependencyParkedIssues(REPO)).toEqual([]);
    expect(await releaseDependencyParkedIssues("org/z")).toEqual([a]);
  });
});

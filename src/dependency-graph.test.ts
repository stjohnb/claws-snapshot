import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./db.js", () => ({
  listUnreleasedDependencyTargets: vi.fn(async () => new Map()),
  getIssuePlannedPRs: vi.fn(async () => []),
}));
vi.mock("./overlap-gate.js", () => ({ storedIssueHolds: vi.fn(async () => ({ plannedCount: 0, holds: [] })) }));
vi.mock("./log.js", () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));

import * as db from "./db.js";
import * as log from "./log.js";
import { storedIssueHolds, type OverlapHold } from "./overlap-gate.js";
import { buildChains, classifyNode, loadDependencyGraph, type GraphEdge, type GraphNode } from "./dependency-graph.js";
import type { BoardCard, BoardCardPr } from "./pages/board.js";
import { LABELS } from "./config.js";
import { READY_TO_APPROVE_REASON } from "./pr-attention.js";
import { shortIssueRef } from "./issue-id.js";

const A = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDA";
const B = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDB";
const C = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const D = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";

const REFINED = { lifecycle: "awaiting-plan-review", approvedThrough: "plan" } as const;

function pr(overrides: Partial<BoardCardPr> = {}): BoardCardPr {
  return { repo: "org/repo", prNumber: 7, stage: "awaiting-review", needsHumanReview: false, mergeApprovedAt: null, ...overrides };
}

function card(ref: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return { repo: "org/repo", ref, title: `Issue ${ref.slice(-1)}`, labels: [], url: `/issues/${ref}`, ...REFINED, ...overrides };
}

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return { id, title: id, repo: "org/repo", column: "queued", state: "held", since: "2026-11-26T10:00:00Z", why: "", ...overrides };
}

function edge(from: string, to: string): GraphEdge {
  return { from, to, kind: "overlap", label: `${from}->${to}` };
}

function held(repo: string, position: number, links: Array<{ issueId: string; position?: number; prNumber?: number | null; running?: boolean; shared: string[] }>): OverlapHold {
  return {
    repo,
    position,
    holders: links.map((l) => ({ issueId: l.issueId, position: l.position ?? 1, prNumber: l.prNumber ?? null, running: l.running ?? false, shared: l.shared })),
  };
}

/** A `storedIssueHolds` answer with these holds. */
function holds(...steps: OverlapHold[]): { plannedCount: number; holds: OverlapHold[] } {
  return { plannedCount: 0, holds: steps };
}

describe("buildChains", () => {
  it("drops nodes with no edge and orders a chain so the issue delivered next is on the right", () => {
    const chains = buildChains([node(A), node(B), node(C), node(D)], [edge(A, B), edge(B, C), edge(A, C)]);
    expect(chains).toHaveLength(1);
    expect(chains[0].nodes.map((n) => n.id)).toEqual([A, B, C]);
    expect(chains[0].edges).toHaveLength(3);
  });

  it("separates unconnected chains and sorts them oldest first", () => {
    const chains = buildChains(
      [node(A, { since: "2026-11-26T12:00:00Z" }), node(B), node(C, { since: "2026-11-20T00:00:00Z" }), node(D)],
      [edge(A, B), edge(C, D)],
    );
    expect(chains.map((c) => c.nodes.map((n) => n.id))).toEqual([[C, D], [A, B]]);
  });

  it("terminates on a cycle and keeps both edges", () => {
    const chains = buildChains([node(A), node(B)], [edge(A, B), edge(B, A)]);
    expect(chains).toHaveLength(1);
    expect(chains[0].nodes.map((n) => n.id).sort()).toEqual([A, B]);
    expect(chains[0].edges).toHaveLength(2);
  });

  it("drops an edge with an end that is not a node", () => {
    expect(buildChains([node(A)], [edge(A, B)])).toEqual([]);
  });
});

describe("classifyNode", () => {
  it("is held in Queued", () => {
    expect(classifyNode(card(A), "queued")).toBe("held");
  });

  it("needs the operator in Blocked, the review columns, on an operator step, a PR hold or a non-approval attention reason", () => {
    expect(classifyNode(card(A), "blocked")).toBe("operator");
    expect(classifyNode(card(A), "requirements-review")).toBe("operator");
    expect(classifyNode(card(A), "awaiting-plan-review")).toBe("operator");
    expect(classifyNode(card(A, { awaitingOperator: true }), "awaiting-merge")).toBe("operator");
    expect(classifyNode(card(A, { flight: { implementing: false, openPrs: [pr({ manualActionReason: "Set the secret" })] } }), "awaiting-merge")).toBe("operator");
    expect(classifyNode(card(A, { flight: { implementing: false, openPrs: [pr({ attention: ["Infra approval needed", READY_TO_APPROVE_REASON] })] } }), "awaiting-merge")).toBe("operator");
  });

  it("awaits approval only when the merge approval is the only reason", () => {
    expect(classifyNode(card(A, { flight: { implementing: false, openPrs: [pr({ attention: [READY_TO_APPROVE_REASON] })] } }), "awaiting-merge")).toBe("approval");
  });

  it("is moving otherwise", () => {
    expect(classifyNode(card(A, { flight: { implementing: false, openPrs: [pr()] } }), "in-progress")).toBe("moving");
    expect(classifyNode(card(A), "approved")).toBe("moving");
  });
});

describe("loadDependencyGraph", () => {
  beforeEach(() => {
    vi.mocked(storedIssueHolds).mockReset().mockResolvedValue(holds());
    vi.mocked(db.listUnreleasedDependencyTargets).mockReset().mockResolvedValue(new Map());
    vi.mocked(db.getIssuePlannedPRs).mockReset().mockResolvedValue([]);
    vi.mocked(log.warn).mockReset();
  });

  const inProgress = (ref: string, prNumber: number, extra: Partial<BoardCardPr> = {}) =>
    card(ref, { flight: { implementing: false, openPrs: [pr({ prNumber, ...extra })] } });
  const queuedCard = (ref: string) => card(ref, { labels: [LABELS.blocked], queued: true, boardColumn: "queued", boardColumnAt: "2026-11-26T09:00:00Z" });

  it("collapses a held issue's steps to one edge per blocker and labels it", async () => {
    vi.mocked(storedIssueHolds).mockImplementation(async (id) => id === B
      ? holds(held("org/repo", 2, [{ issueId: A, prNumber: 575, shared: ["a.ts", "b.ts"] }]), held("org/repo", 3, [{ issueId: A, prNumber: 575, shared: ["b.ts", "c.ts"] }]))
      : holds());
    const chains = await loadDependencyGraph([inProgress(A, 575), queuedCard(B), card(C)]);
    expect(chains).toHaveLength(1);
    expect(chains[0].nodes.map((n) => n.id)).toEqual([B, A]);
    expect(chains[0].edges).toEqual([{ from: B, to: A, kind: "overlap", label: "Steps 2, 3 share 3 files with repo#575" }]);
    const [b, a] = chains[0].nodes;
    expect(b).toMatchObject({ state: "held", column: "queued", since: "2026-11-26T09:00:00Z", why: "Steps 2, 3 share 3 files with repo#575" });
    expect(a).toMatchObject({ state: "moving", column: "in-progress", why: "repo#575 open, runs to merge" });
  });

  it("names a blocker step with no PR by issue and step", async () => {
    vi.mocked(storedIssueHolds).mockImplementation(async (id) => id === B ? holds(held("org/repo", 1, [{ issueId: A, position: 2, running: true, shared: ["a.ts"] }])) : holds());
    const chains = await loadDependencyGraph([card(A, { flight: { implementing: true, openPrs: [] } }), queuedCard(B)]);
    expect(chains[0].edges[0].label).toBe(`Step 1 shares 1 file with #${shortIssueRef(A)} step 2, implementing`);
    expect(chains[0].nodes[1].why).toBe("Implementing");
  });

  it("draws unreleased depends_on links to an open target, step-scoped or not", async () => {
    vi.mocked(db.listUnreleasedDependencyTargets).mockResolvedValue(new Map([
      [B, [{ id: A, title: "A", open: true, target_step: 2 }, { id: C, title: "C", open: false, target_step: null }]],
    ]));
    const chains = await loadDependencyGraph([inProgress(A, 9), queuedCard(B), card(C)]);
    expect(chains).toHaveLength(1);
    expect(chains[0].edges).toEqual([{ from: B, to: A, kind: "depends_on", label: `Depends on #${shortIssueRef(A)} step 2` }]);
  });

  it("drops edges to Backlog, closed and forge issues", async () => {
    vi.mocked(storedIssueHolds).mockResolvedValue(holds(held("org/repo", 1, [{ issueId: A, prNumber: 1, shared: ["x"] }, { issueId: C, prNumber: 2, shared: ["x"] }])));
    vi.mocked(db.listUnreleasedDependencyTargets).mockResolvedValue(new Map([[B, [{ id: D, title: "D", open: true, target_step: null }]]]));
    const chains = await loadDependencyGraph([
      card(A, { labels: [LABELS.backlog] }),
      queuedCard(B),
      card(C, { closed: true }),
      card(D, { ref: 12 } as Partial<BoardCard>),
    ]);
    expect(chains).toEqual([]);
  });

  it("reads overlaps only for approved columns", async () => {
    await loadDependencyGraph([card(A, { lifecycle: "awaiting-plan-review", approvedThrough: "requirements" }), queuedCard(B)]);
    expect(vi.mocked(storedIssueHolds).mock.calls.map((call) => call[0])).toEqual([B]);
  });

  it("leaves out a rejected overlap read's edges and warns", async () => {
    vi.mocked(storedIssueHolds).mockImplementation(async (id) => {
      if (id === B) throw new Error("boom");
      return id === C ? holds(held("org/repo", 1, [{ issueId: A, prNumber: 3, shared: ["x"] }])) : holds();
    });
    const chains = await loadDependencyGraph([inProgress(A, 3), queuedCard(B), queuedCard(C)]);
    expect(chains.flatMap((c) => c.edges.map((e) => e.from))).toEqual([C]);
    expect(log.warn).toHaveBeenCalledWith("dependency_graph_overlap_read_failed", { component: "board", issue: B }, expect.any(Error));
  });

  it("appends step N of M for an open PR with a known phase", async () => {
    vi.mocked(db.listUnreleasedDependencyTargets).mockResolvedValue(new Map([[B, [{ id: A, title: "A", open: true, target_step: null }]]]));
    vi.mocked(storedIssueHolds).mockImplementation(async (id) => ({ plannedCount: id === A ? 3 : 0, holds: [] }));
    const chains = await loadDependencyGraph([inProgress(A, 5, { phase: 2, attention: [READY_TO_APPROVE_REASON], stage: "awaiting-merge" }), queuedCard(B)]);
    const a = chains[0].nodes.find((n) => n.id === A)!;
    expect(a.state).toBe("approval");
    expect(a.why).toBe(`repo#5: ${READY_TO_APPROVE_REASON} · step 2 of 3`);
  });

  it("takes the plan size from the overlap read, and reads it only for a node that read gave none for", async () => {
    vi.mocked(db.listUnreleasedDependencyTargets).mockResolvedValue(new Map([[B, [{ id: A, title: "A", open: true, target_step: null }]]]));
    vi.mocked(storedIssueHolds).mockImplementation(async (id) => {
      if (id === B) throw new Error("boom");
      return { plannedCount: 4, holds: [] };
    });
    vi.mocked(db.getIssuePlannedPRs).mockResolvedValue([{}, {}] as Awaited<ReturnType<typeof db.getIssuePlannedPRs>>);
    const chains = await loadDependencyGraph([inProgress(A, 5, { phase: 3 }), inProgress(B, 6, { phase: 1 })]);
    expect(chains[0].nodes.find((n) => n.id === A)!.why).toBe("repo#5 open, runs to merge · step 3 of 4");
    expect(chains[0].nodes.find((n) => n.id === B)!.why).toContain("step 1 of 2");
    expect(vi.mocked(db.getIssuePlannedPRs).mock.calls.map((call) => call[0])).toEqual([B]);
  });
});

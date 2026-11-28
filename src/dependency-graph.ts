/**
 * The Board's Dependency graph (`GET /api/board/dependency-graph`,
 * docs/issue-tracker.md#board): every chain of open native issues that hold
 * one another, one node per issue. Edges point from a held issue to the issue
 * blocking it and come from current file-overlap holds (`storedIssueHolds`,
 * the gate's own held ready steps, collapsed from plan steps to issues) and
 * unreleased `depends_on` links.
 *
 * Pure graph code (`buildChains`, `classifyNode`) is separate from the loader
 * (`loadDependencyGraph`) so both are unit-tested without a database.
 */
import * as db from "./db.js";
import * as log from "./log.js";
import { storedIssueHolds, type OverlapHold } from "./overlap-gate.js";
import { BACKLOG_DESTINATION, type BoardColumn } from "./issue-board.js";
import { READY_TO_APPROVE_REASON } from "./pr-attention.js";
import { isClawsIssueId, shortIssueRef } from "./issue-id.js";
import { mapSettledWithConcurrency } from "./util.js";
import { boardCardColumn, cardColumnSince, type BoardCard, type BoardCardPr } from "./pages/board.js";
import { repoShortName } from "./pages/layout.js";

/**
 * Who a node waits on: `moving` runs to merge with nothing from the operator;
 * `approval` needs only the operator's merge approval; `operator` needs a real
 * operator action; `held` is held by another issue.
 */
export type GraphNodeState = "moving" | "approval" | "operator" | "held";

export interface GraphNode {
  id: string;
  title: string;
  /** The issue's primary repo, `""` when unassigned. */
  repo: string;
  column: BoardColumn;
  state: GraphNodeState;
  /** ISO 8601: when the issue entered `column`, as the board card's age chip reads it. */
  since: string | undefined;
  /** One line on what the issue waits for. */
  why: string;
}

export interface GraphEdge {
  /** The held issue. */
  from: string;
  /** The issue blocking it. */
  to: string;
  kind: "overlap" | "depends_on";
  label: string;
}

/** One connected group of issues holding one another, its nodes ordered left to right. */
export interface DependencyChain {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * The connected components of the graph that contain at least one edge, each
 * with its nodes ordered so the issue to be delivered next is on the right:
 * a node's rank is its longest path to a node with no outgoing edge, and
 * higher ranks sit further left, ties by id. A cycle is cut where the walk
 * meets a node already on its path, so ranking always terminates. Chains sort
 * oldest `since` first; edges whose ends are not both nodes are dropped.
 */
export function buildChains(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): DependencyChain[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kept = edges.filter((e) => e.from !== e.to && byId.has(e.from) && byId.has(e.to));
  const out = new Map<string, string[]>();
  const adj = new Map<string, Set<string>>();
  for (const e of kept) {
    out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    for (const [a, b] of [[e.from, e.to], [e.to, e.from]]) {
      const set = adj.get(a) ?? new Set<string>();
      set.add(b);
      adj.set(a, set);
    }
  }

  const rank = new Map<string, number>();
  const onPath = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    onPath.add(id);
    let best = 0;
    for (const next of out.get(id) ?? []) {
      if (onPath.has(next)) continue;
      best = Math.max(best, rankOf(next) + 1);
    }
    onPath.delete(id);
    rank.set(id, best);
    return best;
  };

  const seen = new Set<string>();
  const chains: DependencyChain[] = [];
  for (const id of [...adj.keys()].sort()) {
    if (seen.has(id)) continue;
    const members: string[] = [];
    const stack = [id];
    seen.add(id);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      members.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    const memberSet = new Set(members);
    const ordered = members
      .map((m) => ({ id: m, rank: rankOf(m) }))
      .sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id))
      .map((m) => byId.get(m.id)!);
    chains.push({ nodes: ordered, edges: kept.filter((e) => memberSet.has(e.from)) });
  }
  const oldest = (c: DependencyChain): number => {
    const times = c.nodes.map((n) => (n.since ? Date.parse(n.since) : NaN)).filter((t) => !Number.isNaN(t));
    return times.length > 0 ? Math.min(...times) : Infinity;
  };
  return chains.sort((a, b) => oldest(a) - oldest(b) || a.nodes[0].id.localeCompare(b.nodes[0].id));
}

/** The columns where the operator owes a decision before the issue can move. */
const OPERATOR_COLUMNS: readonly BoardColumn[] = ["blocked", "requirements-review", "awaiting-plan-review"];

/** Whether an open PR needs a real operator action: a recorded hold, or any attention reason but the merge approval. */
function prNeedsAction(pr: BoardCardPr): boolean {
  return !!pr.manualActionReason?.trim() || (pr.attention ?? []).some((r) => r !== READY_TO_APPROVE_REASON);
}

/** Who the card waits on, by its column and its open PRs (see {@link GraphNodeState}). */
export function classifyNode(card: BoardCard, column: BoardColumn): GraphNodeState {
  if (column === "queued") return "held";
  const prs = card.flight?.openPrs ?? [];
  if (OPERATOR_COLUMNS.includes(column) || card.awaitingOperator || prs.some(prNeedsAction)) return "operator";
  if (prs.some((pr) => (pr.attention ?? []).includes(READY_TO_APPROVE_REASON))) return "approval";
  return "moving";
}

/** The columns whose issue's overlap holds are drawn: approved work only, never an unapproved plan's would-be overlaps. */
const OVERLAP_COLUMNS: readonly BoardColumn[] = ["approved", "queued", "in-progress", "awaiting-merge", "blocked"];

/** How many concurrent overlap reads the loader makes. */
const OVERLAP_READ_CONCURRENCY = 8;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function prName(repo: string, prNumber: number): string {
  return `${repoShortName(repo)}#${prNumber}`;
}

/** One held issue's overlap with one blocker, collapsed from its steps. */
interface OverlapPair {
  steps: Set<number>;
  shared: Set<string>;
  repo: string;
  prNumber: number | null;
  position: number | null;
  running: boolean;
}

function collapseOverlaps(heldId: string, holds: readonly OverlapHold[]): Map<string, OverlapPair> {
  const pairs = new Map<string, OverlapPair>();
  for (const step of holds) {
    for (const link of step.holders) {
      if (link.issueId === heldId) continue;
      const pair = pairs.get(link.issueId) ?? {
        steps: new Set<number>(), shared: new Set<string>(), repo: step.repo, prNumber: link.prNumber, position: link.position, running: link.running,
      };
      pair.steps.add(step.position);
      for (const path of link.shared) pair.shared.add(path);
      // A blocker's open PR names it better than a step not started.
      if (pair.prNumber === null && link.prNumber !== null) {
        pair.prNumber = link.prNumber;
        pair.repo = step.repo;
        pair.position = link.position;
      }
      pair.running ||= link.running;
      pairs.set(link.issueId, pair);
    }
  }
  return pairs;
}

function overlapLabel(blockerId: string, pair: OverlapPair): string {
  const steps = [...pair.steps].sort((a, b) => a - b);
  const which = steps.length === 1 ? `Step ${steps[0]}` : `Steps ${steps.join(", ")}`;
  const shares = `${steps.length === 1 ? "shares" : "share"} ${plural(pair.shared.size, "file")}`;
  if (pair.prNumber !== null) return `${which} ${shares} with ${prName(pair.repo, pair.prNumber)}`;
  const step = pair.position !== null ? ` step ${pair.position}` : "";
  return `${which} ${shares} with #${shortIssueRef(blockerId)}${step}, ${pair.running ? "implementing" : "not started"}`;
}

function dependsLabel(targetId: string, targetStep: number | null): string {
  return `Depends on #${shortIssueRef(targetId)}${targetStep !== null ? ` step ${targetStep}` : ""}`;
}

function sortedPrs(card: BoardCard): BoardCardPr[] {
  return [...(card.flight?.openPrs ?? [])].sort((a, b) => a.repo.localeCompare(b.repo) || a.prNumber - b.prNumber);
}

/** What an issue with nothing ahead of it waits for. */
function headWhy(card: BoardCard): string {
  const prs = sortedPrs(card);
  if (card.awaitingOperator && card.operatorStep) return card.operatorStep.title ?? card.operatorStep.summary;
  const held = prs.find((pr) => pr.manualActionReason?.trim());
  if (held) return `${prName(held.repo, held.prNumber)} waits on an operator step`;
  const flagged = prs.find((pr) => (pr.attention?.length ?? 0) > 0);
  if (flagged) return `${prName(flagged.repo, flagged.prNumber)}: ${flagged.attention!.join(" · ")}`;
  if (prs.length > 0) return `${prName(prs[0].repo, prs[0].prNumber)} open, runs to merge`;
  if (card.flight?.implementing) return "Implementing";
  const reason = card.blockedReason?.split("\n").map((l) => l.trim()).find((l) => l);
  return reason ?? "";
}

/** A held issue's line: up to two holders, then "and N more"; prefixed by its open PR when it has one and is not Queued. */
function heldWhy(card: BoardCard, column: BoardColumn, labels: readonly string[]): string {
  const shown = labels.slice(0, 2).join("; ");
  const more = labels.length > 2 ? ` and ${labels.length - 2} more` : "";
  const prs = sortedPrs(card);
  const prefix = column !== "queued" && prs.length > 0 ? `${prName(prs[0].repo, prs[0].prNumber)} open; ` : "";
  return `${prefix}${shown}${more}`;
}

/** The step of the issue's open PR with a known phase, lowest first. */
function openPhase(card: BoardCard): number | null {
  const phases = (card.flight?.openPrs ?? [])
    .map((pr) => pr.phase)
    .filter((p): p is number => typeof p === "number");
  return phases.length > 0 ? Math.min(...phases) : null;
}

/**
 * The dependency graph of the board's cards: native, open, non-Backlog cards
 * are the candidate nodes, edges come from overlap holds (read only for cards
 * in {@link OVERLAP_COLUMNS}) and unreleased `depends_on` links to an open
 * target, and only nodes with an edge are kept. A failed overlap read leaves
 * that issue's overlap edges out and logs a warning.
 */
export async function loadDependencyGraph(cards: readonly BoardCard[], nowMs = Date.now()): Promise<DependencyChain[]> {
  const eligible = cards
    .filter((card) => !card.closed && isClawsIssueId(card.ref))
    .map((card) => ({ card, column: boardCardColumn(card) }))
    .filter((e): e is { card: BoardCard; column: BoardColumn } => e.column !== BACKLOG_DESTINATION);
  const byId = new Map(eligible.map((e) => [String(e.card.ref), e]));

  const edges = new Map<string, GraphEdge>();
  const addEdge = (from: string, to: string, kind: GraphEdge["kind"], label: string): void => {
    if (from === to || !byId.has(from) || !byId.has(to)) return;
    const key = `${from}\u0000${to}`;
    const existing = edges.get(key);
    if (existing) existing.label = `${existing.label}; ${label}`;
    else edges.set(key, { from, to, kind, label });
  };

  const overlapCards = eligible.filter((e) => OVERLAP_COLUMNS.includes(e.column));
  const plannedCounts = new Map<string, number>();
  const reads = await mapSettledWithConcurrency(overlapCards, OVERLAP_READ_CONCURRENCY, (e) => storedIssueHolds(String(e.card.ref), nowMs));
  reads.forEach((result, i) => {
    const heldId = String(overlapCards[i].card.ref);
    if (result.status === "rejected") {
      log.warn("dependency_graph_overlap_read_failed", { component: "board", issue: heldId }, result.reason);
      return;
    }
    plannedCounts.set(heldId, result.value.plannedCount);
    for (const [blocker, pair] of collapseOverlaps(heldId, result.value.holds)) addEdge(heldId, blocker, "overlap", overlapLabel(blocker, pair));
  });

  const links = await db.listUnreleasedDependencyTargets([...byId.keys()]);
  for (const [source, targets] of links) {
    for (const target of targets) {
      if (target.open) addEdge(source, target.id, "depends_on", dependsLabel(target.id, target.target_step));
    }
  }

  const edgeList = [...edges.values()];
  const inGraph = new Set(edgeList.flatMap((e) => [e.from, e.to]));
  const outgoing = new Map<string, string[]>();
  for (const e of edgeList) outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e.label]);

  // Plan sizes the overlap reads did not already return (a node outside
  // OVERLAP_COLUMNS, or a failed read), read once each, bounded.
  const missing = [...inGraph].filter((id) => !plannedCounts.has(id) && openPhase(byId.get(id)!.card) !== null);
  const planReads = await mapSettledWithConcurrency(missing, OVERLAP_READ_CONCURRENCY, async (id) => (await db.getIssuePlannedPRs(id)).length);
  planReads.forEach((result, i) => {
    if (result.status === "fulfilled") plannedCounts.set(missing[i], result.value);
    else log.warn("dependency_graph_plan_read_failed", { component: "board", issue: missing[i] }, result.reason);
  });

  const nodes = [...inGraph].map((id): GraphNode => {
    const { card, column } = byId.get(id)!;
    const held = outgoing.get(id);
    let why = held ? heldWhy(card, column, held) : headWhy(card);
    const phase = openPhase(card);
    const total = plannedCounts.get(id) ?? 0;
    if (phase !== null && total > 0) why = why ? `${why} · step ${phase} of ${total}` : `Step ${phase} of ${total}`;
    return {
      id,
      title: card.title,
      repo: card.repo,
      column,
      state: classifyNode(card, column),
      since: cardColumnSince(card, column).since,
      why,
    };
  });
  return buildChains(nodes, edgeList);
}

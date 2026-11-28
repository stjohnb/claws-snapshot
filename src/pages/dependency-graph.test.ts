import { describe, it, expect } from "vitest";
import { renderDependencyGraph, DEPENDENCY_GRAPH_MODAL_HTML } from "./dependency-graph.js";
import type { DependencyChain, GraphNode } from "../dependency-graph.js";

const NOW = Date.parse("2026-11-26T21:00:00Z");
const A = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDA";
const B = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDB";
const C = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDC";
const D = "clw_01JBQ7X4M2K8NV3TYRW9GZ5PDD";

function node(id: string, overrides: Partial<GraphNode> = {}): GraphNode {
  return { id, title: `Issue ${id.slice(-1)}`, repo: "org/bonkus", column: "queued", state: "held", since: "2026-11-26T18:00:00Z", why: "", ...overrides };
}

function cardOf(html: string, id: string): string {
  return html.match(new RegExp(`<a class="dep-card"[^>]*data-node="${id}"[\\s\\S]*?</a>`))?.[0] ?? "";
}

describe("renderDependencyGraph", () => {
  it("says so when there are no chains", () => {
    expect(renderDependencyGraph([], NOW)).toBe("<p>No open issues are blocking one another.</p>");
  });

  it("renders each of the four states, the column title, the time in state and the why line", () => {
    const chain: DependencyChain = {
      nodes: [
        node(D, { state: "held", why: "Step 2 shares 1 file with bonkus#575" }),
        node(C, { state: "operator", column: "blocked", since: "2026-11-24T21:00:00Z" }),
        node(B, { state: "approval", column: "awaiting-merge", since: "2026-11-26T20:30:00Z" }),
        node(A, { state: "moving", column: "in-progress", repo: "org/namey" }),
      ],
      edges: [{ from: D, to: C, kind: "overlap", label: "x" }, { from: C, to: B, kind: "overlap", label: "y" }, { from: D, to: A, kind: "depends_on", label: "z" }],
    };
    const html = renderDependencyGraph([chain], NOW);
    expect(cardOf(html, D)).toContain('data-state="held"');
    expect(cardOf(html, D)).toContain(`href="/issues/${D}"`);
    expect(cardOf(html, D)).toContain('<span class="dep-stage">Queued</span>');
    expect(cardOf(html, D)).toMatch(/<span class="dep-time"[^>]*>3h<\/span>/);
    expect(cardOf(html, D)).toContain('<div class="dep-why">Step 2 shares 1 file with bonkus#575</div>');
    expect(cardOf(html, C)).toContain('data-state="operator"');
    expect(cardOf(html, C)).toMatch(/<span class="dep-time"[^>]*>2d<\/span>/);
    expect(cardOf(html, C)).toContain('<span class="dep-stage">Blocked</span>');
    expect(cardOf(html, B)).toContain('data-state="approval"');
    expect(cardOf(html, B)).toContain('<span class="dep-stage">Awaiting merge</span>');
    expect(cardOf(html, B)).toMatch(/<span class="dep-time"[^>]*>30m<\/span>/);
    expect(cardOf(html, A)).toContain('data-state="moving"');
    // Boxes keep the chain's left-to-right order.
    expect([...html.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1])).toEqual([D, C, B, A]);
    expect(html).toContain("<h3>bonkus · namey</h3>");
    expect(html).toContain(`data-edges="${JSON.stringify([{ from: D, to: C, label: "x" }, { from: C, to: B, label: "y" }, { from: D, to: A, label: "z" }]).replace(/"/g, "&quot;")}"`);
    expect(html).toContain("is blocked by →");
    for (const state of ["moving", "approval", "operator", "held"]) expect(html).toContain(`class="dep-swatch" data-state="${state}"`);
  });

  it("escapes titles, why lines and edge labels", () => {
    const html = renderDependencyGraph([{
      nodes: [node(A, { title: "<b>x</b>", why: "a & <i>b</i>" }), node(B)],
      edges: [{ from: A, to: B, kind: "overlap", label: `"><script>` }],
    }], NOW);
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("a &amp; &lt;i&gt;b&lt;/i&gt;");
  });

  it("leaves the time blank with no since", () => {
    const html = renderDependencyGraph([{ nodes: [node(A, { since: undefined }), node(B)], edges: [{ from: A, to: B, kind: "overlap", label: "" }] }], NOW);
    expect(cardOf(html, A)).toContain('<span class="dep-time"></span>');
  });
});

describe("DEPENDENCY_GRAPH_MODAL_HTML", () => {
  it("is a preview-modal dialog with an empty body", () => {
    expect(DEPENDENCY_GRAPH_MODAL_HTML).toContain('id="dep-graph-modal"');
    expect(DEPENDENCY_GRAPH_MODAL_HTML).toMatch(/<div class="preview-modal-body dep-graph-body" data-dep-graph-body><\/div>/);
  });
});

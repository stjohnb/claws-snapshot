// The Board's Dependency graph modal (`DEPENDENCY_GRAPH_MODAL_HTML` in
// src/pages/dependency-graph.ts). A click on `[data-dep-graph-open]` opens
// `#dep-graph-modal`, shows "Loading…" and fetches
// `GET /api/board/dependency-graph` afresh on every open; the body is not
// refreshed while the dialog stays open (the board poller pauses meanwhile).
//
// Each chain's `.dep-row` carries its edges as JSON in `data-edges`
// (`{from, to, label}`, from the held issue to the issue blocking it). An edge
// between neighbouring boxes is a straight line at mid-height; any other edge
// (skipping a box, or pointing right to left) drops from the held box's bottom
// centre, runs below the row in its own lane and rises into the blocker's
// bottom centre. Redrawn on resize; `scrollLeft` is never changed, so a wide
// chain opens scrolled to the left.
(function clawsDependencyGraph() {
  const NS = "http://www.w3.org/2000/svg";
  const LANE_GAP = 12;
  const BASE_PAD = 34;
  let opener: HTMLElement | null = null;
  let seq = 0;

  interface Edge { from: string; to: string; label?: string }

  function parseEdges(row: HTMLElement): Edge[] {
    try {
      const parsed = JSON.parse(row.dataset.edges ?? "[]") as unknown;
      return Array.isArray(parsed) ? (parsed as Edge[]).filter((e) => e && typeof e.from === "string" && typeof e.to === "string") : [];
    } catch {
      return [];
    }
  }

  function drawRow(row: HTMLElement, rowIndex: number): void {
    row.querySelector(":scope > svg")?.remove();
    const cards = Array.from(row.querySelectorAll<HTMLElement>("[data-node]"));
    const index = new Map(cards.map((c, i) => [c.dataset.node ?? "", i]));
    const edges = parseEdges(row).filter((e) => index.has(e.from) && index.has(e.to));
    const below = edges.filter((e) => index.get(e.to)! !== index.get(e.from)! + 1);
    row.style.paddingBottom = `${BASE_PAD + Math.max(0, below.length - 1) * LANE_GAP}px`;

    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("width", String(row.scrollWidth));
    svg.setAttribute("height", String(row.scrollHeight));
    svg.setAttribute("aria-hidden", "true");
    const markerId = `dep-ah-${rowIndex}`;
    const defs = document.createElementNS(NS, "defs");
    const marker = document.createElementNS(NS, "marker");
    for (const [k, v] of [["id", markerId], ["viewBox", "0 0 10 10"], ["refX", "8"], ["refY", "5"], ["markerWidth", "7"], ["markerHeight", "7"], ["orient", "auto"]]) marker.setAttribute(k, v);
    const head = document.createElementNS(NS, "path");
    head.setAttribute("d", "M0,0 L10,5 L0,10 z");
    head.setAttribute("class", "dep-edge-mark");
    marker.appendChild(head);
    defs.appendChild(marker);
    svg.appendChild(defs);

    const box = row.getBoundingClientRect();
    const sx = row.scrollLeft;
    const rect = (id: string) => {
      const r = cards[index.get(id)!].getBoundingClientRect();
      return { l: r.left - box.left + sx, r: r.right - box.left + sx, t: r.top - box.top, b: r.bottom - box.top, w: r.width, h: r.height };
    };
    const bottom = Math.max(0, ...cards.map((c) => c.getBoundingClientRect().bottom - box.top));

    let lane = 0;
    for (const edge of edges) {
      const h = rect(edge.from);
      const k = rect(edge.to);
      let d: string;
      let start: [number, number];
      if (index.get(edge.to)! === index.get(edge.from)! + 1) {
        const y = h.t + Math.min(h.h, k.h) / 2;
        d = `M${h.r},${y} L${k.l - 3},${y}`;
        start = [h.r, y];
      } else {
        const y = bottom + 20 + lane++ * LANE_GAP;
        const x1 = h.l + h.w * 0.5;
        const x2 = k.l + k.w * 0.5;
        const dir = x2 >= x1 ? 1 : -1;
        const r = 10;
        d = `M${x1},${h.b} L${x1},${y - r} Q${x1},${y} ${x1 + dir * r},${y} L${x2 - dir * r},${y} Q${x2},${y} ${x2},${y - r} L${x2},${k.b + 3}`;
        start = [x1, h.b];
      }
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      path.setAttribute("class", "dep-edge");
      path.setAttribute("marker-end", `url(#${markerId})`);
      if (edge.label) {
        const title = document.createElementNS(NS, "title");
        title.textContent = edge.label;
        path.appendChild(title);
      }
      svg.appendChild(path);
      const dot = document.createElementNS(NS, "circle");
      dot.setAttribute("cx", String(start[0]));
      dot.setAttribute("cy", String(start[1]));
      dot.setAttribute("r", "3.5");
      dot.setAttribute("class", "dep-edge-mark");
      svg.appendChild(dot);
    }
    row.appendChild(svg);
  }

  function drawAll(body: HTMLElement): void {
    Array.from(body.querySelectorAll<HTMLElement>(".dep-row")).forEach((row, i) => drawRow(row, i));
  }

  function init() {
    const dialog = document.getElementById("dep-graph-modal") as HTMLDialogElement | null;
    const body = dialog?.querySelector<HTMLElement>("[data-dep-graph-body]");
    if (!dialog || !body) return;
    if (dialog.dataset.wired) return;
    dialog.dataset.wired = "1";

    async function load(): Promise<void> {
      const mine = ++seq;
      body!.textContent = "Loading…";
      try {
        const res = await fetch("/api/board/dependency-graph", { headers: { Accept: "application/json" }, credentials: "same-origin" });
        const data = res.ok ? await res.json().catch(() => null) as { html?: unknown } | null : null;
        if (mine !== seq) return;
        if (!data || typeof data.html !== "string") {
          body!.textContent = "Could not load the dependency graph.";
          return;
        }
        body!.innerHTML = data.html;
        drawAll(body!);
      } catch {
        if (mine === seq) body!.textContent = "Could not load the dependency graph.";
      }
    }

    document.addEventListener("click", (ev: Event) => {
      const target = ev.target as Element | null;
      const trigger = target && target.closest ? target.closest<HTMLElement>("[data-dep-graph-open]") : null;
      if (!trigger) return;
      if (typeof dialog.showModal !== "function" || dialog.open) return;
      ev.preventDefault();
      opener = trigger;
      dialog.showModal();
      void load();
    });

    dialog.querySelector(".preview-modal-close")?.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (ev: Event) => {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", () => {
      seq++;
      if (opener) opener.focus();
      opener = null;
    });
    window.addEventListener("resize", () => {
      if (dialog.open) drawAll(body);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Exposed for the jsdom unit test.
  (window as unknown as { clawsDependencyGraphInit: () => void }).clawsDependencyGraphInit = init;
})();

export {};

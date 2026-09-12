// Builds the /damp readings chart from the JSON payload emitted by
// renderCharts() in src/pages/damp.ts. Chart.js itself arrives as the global
// `Chart` from the deferred /static/chart.js, so init must wait for
// DOMContentLoaded — a deferred external script runs after this inline bundle.
interface DampSeries { label: string; colour: string; data: { x: number; y: number }[]; }
interface DampEvent { x: number; short: string; }
interface DampPayload { series: DampSeries[]; events: DampEvent[]; min: number; max: number; }

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(x: number, withYear: boolean): string {
  const d = new Date(Math.round(x) * 86400000);
  const base = d.getUTCDate() + " " + MONTHS[d.getUTCMonth()];
  return withYear ? base + " " + String(d.getUTCFullYear()).slice(2) : base;
}

function init(): void {
  const canvas = document.getElementById("damp-chart") as HTMLCanvasElement | null;
  const dataEl = document.getElementById("damp-chart-data");
  const status = document.getElementById("damp-chart-status");
  const showAllBtn = document.getElementById("damp-show-all");
  const hideLowBox = document.getElementById("damp-hide-low") as HTMLInputElement | null;
  const ChartCtor = window.Chart;
  if (!canvas || !dataEl || !ChartCtor) return;
  let payload: DampPayload;
  try { payload = JSON.parse(dataEl.textContent || "{}"); } catch { return; }
  if (!payload.series || payload.series.length === 0) return;

  const LOW_THRESHOLD = 1;
  const isLow = payload.series.map((s) => !s.data.some((p) => p.y > LOW_THRESHOLD));
  const lowCount = isLow.filter(Boolean).length;
  let hideLow = false;

  const grid = cssVar("--border", "#ddd6ca");
  const tick = cssVar("--text-subtle", "#948d82");
  const ALL_MSG = "Tap a line or a legend entry to isolate one point.";
  let chart: any;
  let isolated: number | null = null;

  function statusMsg(): string {
    if (isolated !== null) return "Showing " + payload.series[isolated].label + " only — tap again to show all.";
    if (!hideLow || lowCount === 0) return ALL_MSG;
    if (lowCount === payload.series.length) return "All " + lowCount + " points stay at or below 1.0 — nothing left to plot.";
    return "Hiding " + lowCount + " point" + (lowCount === 1 ? "" : "s") + " that never go above 1.0. " + ALL_MSG;
  }
  function apply(): void {
    chart.data.datasets.forEach((_d: unknown, i: number) => {
      const shown = (!hideLow || !isLow[i]) && (isolated === null || isolated === i);
      chart.setDatasetVisibility(i, shown);
    });
    chart.update();
    if (status) status.textContent = statusMsg();
  }
  function showAll(): void { isolated = null; apply(); }
  function isolate(idx: number): void {
    if (typeof idx !== "number" || idx < 0) return;
    if (hideLow && isLow[idx]) return;
    if (isolated === idx) { showAll(); return; }
    isolated = idx;
    apply();
  }

  const spansYears = new Date(payload.min * 86400000).getUTCFullYear() !== new Date(payload.max * 86400000).getUTCFullYear();
  const accent = cssVar("--accent", "#c1521a");
  const eventPlugin = {
    id: "dampEvents",
    afterDatasetsDraw(c: any) {
      const evs = payload.events || [];
      if (!evs.length) return;
      const { ctx, chartArea, scales } = c;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = accent;
      ctx.fillStyle = accent;
      ctx.font = '11px "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      for (const ev of evs) {
        const px = scales.x.getPixelForValue(ev.x);
        if (px < chartArea.left || px > chartArea.right) continue;
        ctx.beginPath();
        ctx.moveTo(px, chartArea.top);
        ctx.lineTo(px, chartArea.bottom);
        ctx.stroke();
        const w = ctx.measureText(ev.short).width;
        let tx = px + 4;
        if (tx + w > chartArea.right) tx = Math.max(chartArea.left, px - 4 - w);
        ctx.setLineDash([]);
        ctx.fillText(ev.short, tx, chartArea.top + 2);
        ctx.setLineDash([4, 4]);
      }
      ctx.restore();
    },
  };

  chart = new ChartCtor(canvas, {
    type: "line",
    data: {
      datasets: payload.series.map((s) => ({
        label: s.label, data: s.data,
        borderColor: s.colour, backgroundColor: s.colour,
        borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, pointHitRadius: 14,
        tension: 0,
      })),
    },
    plugins: [eventPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,                 // docs/DESIGN.md: no motion outside the topology pulse
      interaction: { mode: "nearest", intersect: false, axis: "xy" },
      scales: {
        x: {
          type: "linear",
          min: payload.min,
          max: payload.max,
          grid: { color: grid },
          afterBuildTicks: (axis: any) => {
            const lo = Math.ceil(axis.min), hi = Math.floor(axis.max);
            const step = Math.max(1, Math.ceil(Math.max(1, hi - lo) / 4));
            const ticks = [];
            for (let v = lo; v <= hi; v += step) ticks.push({ value: v });
            const last = ticks[ticks.length - 1];
            if (!last || hi - last.value >= step / 2) ticks.push({ value: hi });
            axis.ticks = ticks;
          },
          ticks: {
            color: tick, maxRotation: 0, autoSkip: false, font: { size: 11 },
            callback: (v: number) => fmtDay(v, spansYears),
          },
        },
        y: { beginAtZero: true, suggestedMax: 2.5, grid: { color: grid }, ticks: { color: tick, font: { size: 11 } } },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: tick, usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 8, font: { size: 11 },
            filter: (item: { datasetIndex: number }) => !(hideLow && isLow[item.datasetIndex]),
          },
          onClick: (_e: unknown, item: { datasetIndex: number }) => isolate(item.datasetIndex),
        },
        tooltip: {
          displayColors: true,
          callbacks: { title: (items: any[]) => items.length ? fmtDay(items[0].parsed.x, true) : "" },
        },
      },
      onClick: (evt: unknown) => {
        const hits = chart.getElementsAtEventForMode(evt, "nearest", { intersect: false }, true);
        if (hits.length) isolate(hits[0].datasetIndex);
      },
    },
  });

  if (showAllBtn) showAllBtn.addEventListener("click", showAll);
  if (hideLowBox) {
    hideLowBox.checked = false;
    hideLowBox.addEventListener("change", () => {
      hideLow = hideLowBox.checked;
      if (isolated !== null && hideLow && isLow[isolated]) isolated = null;
      apply();
    });
  }
  if (status) status.textContent = ALL_MSG;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

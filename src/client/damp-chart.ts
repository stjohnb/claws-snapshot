// Builds the /damp readings chart from the JSON payload emitted by
// renderCharts() in src/pages/damp.ts. Chart.js itself arrives as the global
// `Chart` from the deferred /static/chart.js, so init must wait for
// DOMContentLoaded — a deferred external script runs after this inline bundle.
interface DampSeries { label: string; colour: string; data: (number | null)[]; }
interface DampPayload { labels: string[]; series: DampSeries[]; }

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function init(): void {
  const canvas = document.getElementById("damp-chart") as HTMLCanvasElement | null;
  const dataEl = document.getElementById("damp-chart-data");
  const status = document.getElementById("damp-chart-status");
  const showAllBtn = document.getElementById("damp-show-all");
  const ChartCtor = window.Chart;
  if (!canvas || !dataEl || !ChartCtor) return;
  let payload: DampPayload;
  try { payload = JSON.parse(dataEl.textContent || "{}"); } catch { return; }
  if (!payload.series || payload.series.length === 0) return;

  const grid = cssVar("--border", "#ddd6ca");
  const tick = cssVar("--text-subtle", "#948d82");
  const ALL_MSG = "Tap a line or a legend entry to isolate one point.";
  let chart: any;
  let isolated: number | null = null;

  function showAll(): void {
    isolated = null;
    chart.data.datasets.forEach((_d: unknown, i: number) => chart.setDatasetVisibility(i, true));
    chart.update();
    if (status) status.textContent = ALL_MSG;
  }
  function isolate(idx: number): void {
    if (typeof idx !== "number" || idx < 0) return;
    if (isolated === idx) { showAll(); return; }
    isolated = idx;
    chart.data.datasets.forEach((_d: unknown, i: number) => chart.setDatasetVisibility(i, i === idx));
    chart.update();
    if (status) status.textContent = "Showing " + payload.series[idx].label + " only — tap again to show all.";
  }

  chart = new ChartCtor(canvas, {
    type: "line",
    data: {
      labels: payload.labels,
      datasets: payload.series.map((s) => ({
        label: s.label, data: s.data,
        borderColor: s.colour, backgroundColor: s.colour,
        borderWidth: 2, pointRadius: 3, pointHoverRadius: 6, pointHitRadius: 14,
        tension: 0, spanGaps: true,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,                 // docs/DESIGN.md: no motion outside the topology pulse
      interaction: { mode: "nearest", intersect: false, axis: "xy" },
      scales: {
        x: { grid: { color: grid }, ticks: { color: tick, maxRotation: 0, autoSkip: true, maxTicksLimit: 4, font: { size: 11 } } },
        y: { beginAtZero: true, suggestedMax: 2.5, grid: { color: grid }, ticks: { color: tick, font: { size: 11 } } },
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: tick, usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 8, font: { size: 11 } },
          onClick: (_e: unknown, item: { datasetIndex: number }) => isolate(item.datasetIndex),
        },
        tooltip: { displayColors: true },
      },
      onClick: (evt: unknown) => {
        const hits = chart.getElementsAtEventForMode(evt, "nearest", { intersect: false }, true);
        if (hits.length) isolate(hits[0].datasetIndex);
      },
    },
  });

  if (showAllBtn) showAllBtn.addEventListener("click", showAll);
  if (status) status.textContent = ALL_MSG;
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
else init();

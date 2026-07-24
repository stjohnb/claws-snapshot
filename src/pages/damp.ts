import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, formatRelativeTime } from "./layout.js";
import type { DampReadingRow } from "../db.js";

const KEY_SEP = "␞";

export const DAMP_POINTS: ReadonlyArray<{
  location: string; point: string;
  wall: "masonry" | "stud"; exposure: "interior" | "exterior";
}> = [
  { location: "Downstairs toilet",       point: "N",          wall: "stud",    exposure: "interior" },
  { location: "Downstairs toilet",       point: "S",          wall: "stud",    exposure: "interior" },
  { location: "Downstairs toilet",       point: "E",          wall: "stud",    exposure: "interior" },
  { location: "Downstairs toilet",       point: "W",          wall: "masonry", exposure: "interior" },
  { location: "Sitting room wall",       point: "near",       wall: "masonry", exposure: "interior" },
  { location: "Sitting room wall",       point: "centre",     wall: "masonry", exposure: "interior" },
  { location: "Sitting room wall",       point: "far",        wall: "masonry", exposure: "interior" },
  { location: "Sitting room Bay Window", point: "corner",     wall: "masonry", exposure: "exterior" },
  { location: "Sitting room Bay Window", point: "bay corner", wall: "masonry", exposure: "exterior" },
  { location: "Sitting room Bay Window", point: "centre bay", wall: "masonry", exposure: "exterior" },
  { location: "Hall Closet",             point: "Manifold",   wall: "masonry", exposure: "interior" },
  { location: "Hall Closet",             point: "utility",    wall: "stud",    exposure: "interior" },
  { location: "Utility wall",            point: "left",       wall: "masonry", exposure: "interior" },
  { location: "Utility wall",            point: "centre",     wall: "masonry", exposure: "interior" },
  { location: "Utility wall",            point: "right",      wall: "masonry", exposure: "interior" },
];

function pointKey(location: string, point: string): string {
  return `${location}${KEY_SEP}${point}`;
}

function groupByPoint(rows: DampReadingRow[]): Map<string, DampReadingRow[]> {
  const byPoint = new Map<string, DampReadingRow[]>();
  for (const row of rows) {
    const key = pointKey(row.location, row.point);
    const existing = byPoint.get(key);
    if (existing) existing.push(row);
    else byPoint.set(key, [row]);
  }
  return byPoint;
}

function wallLabel(p: { wall: string; exposure: string }): string {
  return `${p.wall} · ${p.exposure}`;
}

const WALL_BY_KEY = new Map(DAMP_POINTS.map((p) => [pointKey(p.location, p.point), wallLabel(p)]));

function renderContext(): string {
  return `<div class="damp-context">
  <p>Readings are taken with a handheld damp meter on interior wall surfaces around the house. The number is a relative moisture scale, not an absolute percentage.</p>
  <p><strong>Scale:</strong> the meter runs 0–2.5. A reading of <strong>2.5</strong> means the meter is pegged at its maximum — the true moisture level may be higher, so treat any 2.5 as "at least 2.5". Lower is drier.</p>
  <p><strong>Wall type matters:</strong> points sit on different wall constructions — some masonry (brick/block), some stud partition (timber + plasterboard), and a mix of internal and external walls. Masonry and external walls naturally hold and read more moisture than internal stud walls. Compare each point against its own history over time, not against other points.</p>
  <p><strong>What to expect:</strong></p>
  <ul class="damp-guide">
    <li><strong>Interior stud walls</strong> (timber + plasterboard) should read <strong>low and stable</strong> — typically well under 1. A sustained rise here suggests a leak or condensation, not normal fabric moisture.</li>
    <li><strong>Interior masonry walls</strong> (brick/block) hold more moisture and read <strong>moderately higher</strong> than stud — a steady reading up to roughly 1.5 can be normal. Watch for upward trends rather than the absolute value.</li>
    <li><strong>Exterior masonry walls</strong> are exposed to weather and read <strong>highest</strong>, and will rise after rain — readings toward or at the 2.5 cap are not unusual, especially seasonally. Judge these against their own dry-weather baseline.</li>
  </ul>
  <p>These are rules of thumb for interpreting a handheld meter's relative scale, not calibrated moisture percentages. Always compare a point against its own history.</p>
</div>`;
}

function renderForm(): string {
  const today = new Date().toISOString().slice(0, 10);
  const rows = DAMP_POINTS.map((p, i) => `<tr>
      <td>${escapeHtml(p.location)}</td>
      <td>${escapeHtml(p.point)}</td>
      <td>${escapeHtml(wallLabel(p))}</td>
      <td><input type="number" step="any" inputmode="decimal" name="p${i}" data-index="${i}"></td>
      <td class="save-status" id="s${i}"></td>
    </tr>`).join("\n");
  return `<form method="post" action="/damp/log">
    <label>Date <input type="date" name="reading_date" value="${today}"></label>
    <table class="damp-table">
      <thead><tr><th>Location</th><th>Point</th><th>Wall</th><th>Value</th><th></th></tr></thead>
      <tbody>
      ${rows}
      </tbody>
    </table>
    <button type="submit">Save readings</button>
  </form>`;
}

const DAMP_AUTOSAVE_SCRIPT = `<script>
(function () {
  var form = document.querySelector('form[action="/damp/log"]');
  if (!form) return;
  var dateEl = form.querySelector('input[name="reading_date"]');
  form.querySelectorAll('input[type=number][data-index]').forEach(function (inp) {
    inp.addEventListener('change', function () {
      var idx = inp.dataset.index;
      var status = document.getElementById('s' + idx);
      var blank = inp.value.trim() === '';
      if (status) status.textContent = '…';
      fetch('/damp/reading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index: Number(idx), value: inp.value, reading_date: dateEl ? dateEl.value : '' })
      }).then(function (r) {
        if (status) status.textContent = r.ok ? (blank ? '' : '✓') : '⚠';
      }).catch(function () { if (status) status.textContent = '⚠'; });
    });
  });
})();
</script>`;

const CHART_PALETTE = [
  "#58a6ff", "#3fb950", "#f778ba", "#d29922", "#a371f7", "#ff7b72",
  "#39c5cf", "#e3b341", "#db61a2", "#56d364", "#79c0ff", "#ffa657",
  "#bc8cff", "#7ee787", "#ff9bce",
];

function renderCharts(rows: DampReadingRow[]): string {
  if (rows.length === 0) return '<p class="idle">No readings yet.</p>';

  const byPoint = groupByPoint(rows);
  for (const readings of byPoint.values()) {
    readings.sort((a, b) =>
      a.reading_date.localeCompare(b.reading_date) || a.recorded_at.localeCompare(b.recorded_at));
  }

  const width = 720;
  const height = 340;
  const padLeft = 48;
  const padBottom = 28;
  const padTop = 12;
  const padRight = 12;

  // Global date axis + value range across ALL series.
  const dateSet = new Set<string>();
  const allValues: number[] = [];
  for (const r of rows) { dateSet.add(r.reading_date); allValues.push(r.value); }
  const dates = Array.from(dateSet).sort();

  if (dates.length < 2) {
    return '<div class="damp-chart"><p class="idle">Not enough data to plot yet.</p></div>';
  }

  const dateIndex = new Map(dates.map((d, i) => [d, i]));
  const max = allValues.reduce((a, b) => (b > a ? b : a), allValues[0]);
  const min = allValues.reduce((a, b) => (b < a ? b : a), allValues[0]);
  const range = max === min ? 1 : max - min;
  const mid = (height - padTop - padBottom) / 2 + padTop;

  const xFor = (dateIdx: number) =>
    padLeft + (dates.length === 1 ? 0 : (dateIdx / (dates.length - 1)) * (width - padLeft - padRight));
  const yFor = (value: number) =>
    max === min ? mid : height - padBottom - ((value - min) / range) * (height - padTop - padBottom);

  const linesAndDots = DAMP_POINTS.map((p, i) => {
    const readings = byPoint.get(pointKey(p.location, p.point)) ?? [];
    if (readings.length === 0) return "";
    const colour = CHART_PALETTE[i % CHART_PALETTE.length];
    const coords = readings.map((r) => ({ x: xFor(dateIndex.get(r.reading_date)!), y: yFor(r.value) }));
    const polyline = coords.length > 1
      ? `<polyline points="${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ")}" fill="none" stroke="${colour}" stroke-width="1.5"/>`
      : "";
    const dots = coords.map((c) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="2.5" fill="${colour}"/>`).join("");
    return polyline + dots;
  }).join("");

  const yAxisLabels =
    `<text x="${padLeft - 4}" y="${padTop + 4}" font-size="10" fill="var(--muted,#8b949e)" text-anchor="end">${escapeHtml(String(max))}</text>` +
    `<text x="${padLeft - 4}" y="${height - padBottom}" font-size="10" fill="var(--muted,#8b949e)" text-anchor="end">${escapeHtml(String(min))}</text>`;

  const xAxisLabels =
    `<text x="${padLeft}" y="${height - 6}" font-size="10" fill="var(--muted,#8b949e)" text-anchor="start">${escapeHtml(dates[0])}</text>` +
    `<text x="${width - padRight}" y="${height - 6}" font-size="10" fill="var(--muted,#8b949e)" text-anchor="end">${escapeHtml(dates[dates.length - 1])}</text>`;

  const legend = DAMP_POINTS.map((p, i) => {
    const readings = byPoint.get(pointKey(p.location, p.point)) ?? [];
    if (readings.length === 0) return "";
    const colour = CHART_PALETTE[i % CHART_PALETTE.length];
    return `<span><span class="damp-swatch" style="background:${colour}"></span>${escapeHtml(`${p.location} · ${p.point}`)}</span>`;
  }).join("");

  return `<div class="damp-chart">
    <svg viewBox="0 0 ${width} ${height}" style="max-width:100%;height:auto">
      ${yAxisLabels}
      ${xAxisLabels}
      ${linesAndDots}
    </svg>
    <div class="damp-legend">${legend}</div>
  </div>`;
}

function renderTrends(trendRows: DampReadingRow[]): string {
  const byPoint = groupByPoint(trendRows);

  const rows = DAMP_POINTS.map((p) => {
    const readings = byPoint.get(pointKey(p.location, p.point)) ?? [];
    const latest = readings[0];
    const previous = readings[1];
    if (!latest) {
      return `<tr>
        <td>${escapeHtml(p.location)}</td>
        <td>${escapeHtml(p.point)}</td>
        <td>${escapeHtml(wallLabel(p))}</td>
        <td>—</td><td>—</td><td>—</td><td>—</td>
      </tr>`;
    }
    let delta = "—";
    if (previous) {
      const diff = latest.value - previous.value;
      const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "–";
      delta = `${arrow} ${Math.round(Math.abs(diff) * 100) / 100}`;
    }
    return `<tr>
      <td>${escapeHtml(p.location)}</td>
      <td>${escapeHtml(p.point)}</td>
      <td>${escapeHtml(wallLabel(p))}</td>
      <td>${escapeHtml(String(latest.value))}</td>
      <td>${formatRelativeTime(latest.recorded_at)}</td>
      <td>${previous ? escapeHtml(String(previous.value)) : "—"}</td>
      <td>${delta}</td>
    </tr>`;
  }).join("\n");

  return `<table class="damp-table">
    <thead><tr><th>Location</th><th>Point</th><th>Wall</th><th>Latest</th><th>Reading date</th><th>Previous</th><th>Δ</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderHistory(recentRows: DampReadingRow[]): string {
  if (recentRows.length === 0) return '<p class="idle">No readings yet.</p>';
  const rows = recentRows.map((row) => `<tr>
      <td>${escapeHtml(row.reading_date)}</td>
      <td>${escapeHtml(row.location)}</td>
      <td>${escapeHtml(row.point)}</td>
      <td>${escapeHtml(WALL_BY_KEY.get(pointKey(row.location, row.point)) ?? "—")}</td>
      <td>${escapeHtml(String(row.value))}</td>
    </tr>`).join("\n");
  return `<table class="damp-table">
    <thead><tr><th>Date</th><th>Location</th><th>Point</th><th>Wall</th><th>Value</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

export function buildDampPage(
  trendRows: DampReadingRow[],
  recentRows: DampReadingRow[],
  theme: Theme,
  saved: boolean,
): string {
  const savedBanner = saved
    ? '<div style="background:#2da44e;color:#fff;padding:0.5em 1em;margin:0 0 0.5em 0;font-weight:600;border-radius:4px">Saved ✓</div>'
    : "";

  return `<!DOCTYPE html>
${htmlOpenTag(theme)}
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>claws — Damp Readings</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .damp-table { border-collapse: collapse; font-size: 0.85rem; width: 100%; margin-bottom: 1rem; }
  .damp-table th, .damp-table td { padding: 0.4rem 0.6rem; border: 1px solid var(--border); text-align: left; }
  .damp-table th { background: var(--bg); }
  .idle { color: var(--text-subtle); font-style: italic; }
  .damp-chart { margin-bottom: 1.5rem; }
  .damp-chart h3 { font-size: 0.95rem; margin: 0.5rem 0 0.25rem; }
  .damp-legend { display: flex; flex-wrap: wrap; gap: 0.75rem; font-size: 0.8rem; margin-top: 0.25rem; }
  .damp-legend span { display: inline-flex; align-items: center; gap: 0.3rem; }
  .damp-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .damp-context { border: 1px solid var(--border); background: var(--bg); border-radius: 4px; padding: 0.5rem 0.9rem; margin: 0 0 1rem 0; font-size: 0.85rem; }
  .damp-context p { margin: 0.4rem 0; }
  .damp-context p:first-child { margin-top: 0; }
  .damp-context p:last-child { margin-bottom: 0; }
  .damp-guide { margin: 0.4rem 0; padding-left: 1.2rem; font-size: 0.85rem; }
  .damp-guide li { margin: 0.25rem 0; }
  .save-status { color: var(--text-subtle); width: 1.5rem; text-align: center; }
  </style>
</head>
<body>
  ${buildPageHeader("Damp Readings", theme)}
  ${THEME_SCRIPT}
  ${savedBanner}
  ${renderContext()}
  <h2>Log readings</h2>
  ${renderForm()}
  <h2>Trends</h2>
  ${renderTrends(trendRows)}
  <h2>Charts</h2>
  ${renderCharts(trendRows)}
  <h2>Recent history</h2>
  ${renderHistory(recentRows)}
  ${DAMP_AUTOSAVE_SCRIPT}
</body>
</html>`;
}

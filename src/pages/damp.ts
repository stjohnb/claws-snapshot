import type { Theme } from "./layout.js";
import { PAGE_CSS, TAILWIND_STYLESHEET, escapeHtml, htmlOpenTag, buildPageHeader, THEME_SCRIPT, CHART_SCRIPT, formatRelativeTime } from "./layout.js";
import type { DampReadingRow } from "../db.js";
import { DAMP_CHART_SCRIPT } from "../resources/damp-chart.generated.js";

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

export const DAMP_EVENTS: ReadonlyArray<{ date: string; label: string; short: string }> = [
  {
    date: "2026-08-24",
    label: "Started running UFH 8h a day with water at 50 degrees",
    short: "UFH 8h/day @ 50°",
  },
];

function dayIndex(isoDate: string): number {
  return Math.round(Date.parse(`${isoDate}T00:00:00Z`) / 86_400_000);
}

const EVENT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatEventDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${d.getUTCDate()} ${EVENT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

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
  return `<details class="damp-context"><summary>How to read these numbers</summary>
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
</details>`;
}

function renderForm(): string {
  const today = new Date().toISOString().slice(0, 10);
  const indexed = DAMP_POINTS.map((p, i) => ({ ...p, i }));

  const items: string[] = [];
  let prevLocation: string | null = null;
  for (const p of indexed) {
    if (p.location !== prevLocation) {
      items.push(`<li class="damp-group">${escapeHtml(p.location)}</li>`);
      prevLocation = p.location;
    }
    items.push(`<li class="damp-row">
      <span class="damp-label"><span class="damp-point">${escapeHtml(p.point)}</span><span class="damp-wall">${escapeHtml(wallLabel(p))}</span></span>
      <input type="number" step="any" inputmode="decimal" name="p${p.i}" data-index="${p.i}" aria-label="${escapeHtml(`${p.location} ${p.point}`)}">
      <span class="save-status" id="s${p.i}"></span>
    </li>`);
  }

  return `<form method="post" action="/damp/log">
    <div class="damp-date"><label>Date <input type="date" name="reading_date" value="${today}"></label></div>
    <ul class="damp-entry">
      ${items.join("\n")}
    </ul>
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

  // Global date axis across ALL series.
  const dateSet = new Set<string>();
  for (const r of rows) dateSet.add(r.reading_date);
  const dates = Array.from(dateSet).sort();

  if (dates.length < 2) {
    return '<div class="damp-chart"><p class="idle">Not enough data to plot yet.</p></div>';
  }

  const series = DAMP_POINTS.flatMap((p, i) => {
    const readings = byPoint.get(pointKey(p.location, p.point)) ?? [];
    if (readings.length === 0) return [];
    const data = readings.map((r) => ({ x: dayIndex(r.reading_date), y: r.value }));
    return [{ label: `${p.location} · ${p.point}`, colour: CHART_PALETTE[i % CHART_PALETTE.length], data }];
  });

  const firstDay = dayIndex(dates[0]);
  const lastDay = dayIndex(dates[dates.length - 1]);
  const events = DAMP_EVENTS
    .map((e) => ({ x: dayIndex(e.date), short: e.short }))
    .filter((e) => e.x >= firstDay - 14 && e.x <= lastDay + 14);
  const eventXs = events.map((e) => e.x);
  const min = Math.min(firstDay, ...eventXs) - 1;
  const max = Math.max(lastDay, ...eventXs) + 1;

  const payloadJson = JSON.stringify({ series, events, min, max }).replace(/</g, "\\u003c");

  const eventsHtml = DAMP_EVENTS.length === 0 ? "" : `<ul class="damp-events">
    ${DAMP_EVENTS.map((e) => `<li><strong>${escapeHtml(formatEventDate(e.date))}</strong> — ${escapeHtml(e.label)}</li>`).join("\n")}
  </ul>`;

  return `<div class="damp-chart">
    <div class="damp-chart-wrap"><canvas id="damp-chart" role="img" aria-label="Damp readings over time"></canvas></div>
    <p class="damp-chart-status" id="damp-chart-status" aria-live="polite">Tap a line or a legend entry to isolate one point.</p>
    ${eventsHtml}
    <div class="damp-chart-controls">
      <button type="button" id="damp-show-all">Show all</button>
      <label class="damp-filter"><input type="checkbox" id="damp-hide-low"> Hide points never above 1.0</label>
    </div>
    <noscript><p class="idle">The chart needs JavaScript — the Trends and Recent history tables above carry the same numbers.</p></noscript>
    <script type="application/json" id="damp-chart-data">${payloadJson}</script>
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
        <td class="cell-title" data-label="Location">${escapeHtml(p.location)}</td>
        <td data-label="Point">${escapeHtml(p.point)}</td>
        <td class="hide-sm" data-label="Wall">${escapeHtml(wallLabel(p))}</td>
        <td data-label="Latest">—</td><td data-label="Reading date">—</td><td data-label="Previous">—</td><td data-label="Δ">—</td>
      </tr>`;
    }
    let delta = "—";
    if (previous) {
      const diff = latest.value - previous.value;
      const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "–";
      delta = `${arrow} ${Math.round(Math.abs(diff) * 100) / 100}`;
    }
    return `<tr>
      <td class="cell-title" data-label="Location">${escapeHtml(p.location)}</td>
      <td data-label="Point">${escapeHtml(p.point)}</td>
      <td class="hide-sm" data-label="Wall">${escapeHtml(wallLabel(p))}</td>
      <td data-label="Latest">${escapeHtml(String(latest.value))}</td>
      <td data-label="Reading date">${formatRelativeTime(latest.recorded_at)}</td>
      <td data-label="Previous">${previous ? escapeHtml(String(previous.value)) : "—"}</td>
      <td data-label="Δ">${delta}</td>
    </tr>`;
  }).join("\n");

  return `<div class="table-scroll"><table class="damp-table data-cards">
    <thead><tr><th>Location</th><th>Point</th><th>Wall</th><th>Latest</th><th>Reading date</th><th>Previous</th><th>Δ</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderHistory(recentRows: DampReadingRow[]): string {
  if (recentRows.length === 0) return '<p class="idle">No readings yet.</p>';
  const rows = recentRows.map((row) => `<tr>
      <td class="cell-title" data-label="Date">${escapeHtml(row.reading_date)}</td>
      <td data-label="Location">${escapeHtml(row.location)}</td>
      <td data-label="Point">${escapeHtml(row.point)}</td>
      <td class="hide-sm" data-label="Wall">${escapeHtml(WALL_BY_KEY.get(pointKey(row.location, row.point)) ?? "—")}</td>
      <td data-label="Value">${escapeHtml(String(row.value))}</td>
    </tr>`).join("\n");
  return `<div class="table-scroll"><table class="damp-table data-cards">
    <thead><tr><th>Date</th><th>Location</th><th>Point</th><th>Wall</th><th>Value</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@200;400;600&family=IBM+Plex+Sans:wght@300;400;600&display=swap">
  <link rel="manifest" href="/manifest.webmanifest">
  ${CHART_SCRIPT}
  <title>claws — Damp Readings</title>
  ${TAILWIND_STYLESHEET}
  <style>${PAGE_CSS}
  .damp-table { border-collapse: collapse; font-size: 0.85rem; width: 100%; margin-bottom: 1rem; }
  .idle { color: var(--text-subtle); font-style: italic; }
  .damp-chart { margin-bottom: 1.5rem; }
  .damp-chart h3 { font-size: 0.95rem; margin: 0.5rem 0 0.25rem; }
  .damp-chart-wrap { position: relative; height: 62vh; min-height: 340px; max-height: 520px; width: 100%; }
  .damp-chart-wrap canvas { touch-action: manipulation; }
  .damp-chart-status { font-size: 0.8rem; color: var(--text-secondary); margin: 0.4rem 0; min-height: 1.2em; }
  .damp-events { list-style: none; margin: 0.3rem 0 0.6rem; padding: 0; font-size: 0.78rem; color: var(--text-secondary); }
  .damp-events li::before { content: "│ "; color: var(--accent); }
  #damp-show-all { min-height: 36px; padding: 0.3rem 0.8rem; font: inherit; font-size: 0.8rem;
    background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border);
    border-radius: 999px; cursor: pointer; }
  #damp-show-all:hover { border-color: var(--accent); color: var(--accent); }
  .damp-chart-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 0.75rem; }
  .damp-filter { display: inline-flex; align-items: center; gap: 0.4rem; min-height: 36px;
    font-size: 0.8rem; color: var(--text-secondary); cursor: pointer; }
  .damp-filter input[type=checkbox] { width: 1rem; height: 1rem; accent-color: var(--accent); }
  @media (min-width: 768px) { .damp-chart-wrap { height: 420px; } }
  .damp-context { border: 1px solid var(--border); background: var(--bg); border-radius: 4px; padding: 0.5rem 0.9rem; margin: 0 0 1rem 0; font-size: 0.85rem; }
  .damp-context summary { cursor: pointer; font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.75rem; color: var(--text-secondary); }
  .damp-context p { margin: 0.4rem 0; }
  .damp-context p:last-child { margin-bottom: 0; }
  .damp-guide { margin: 0.4rem 0; padding-left: 1.2rem; font-size: 0.85rem; }
  .damp-guide li { margin: 0.25rem 0; }
  .save-status { color: var(--text-subtle); width: 1.5rem; text-align: center; }
  .damp-date { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 0.5rem 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; }
  .damp-entry { list-style: none; margin: 0 0 1rem; padding: 0; }
  .damp-group { font-family: var(--font-display); text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.72rem; color: var(--accent); margin: 1rem 0 0.35rem; }
  .damp-row { display: grid; grid-template-columns: 1fr 5.5rem 1.5rem; align-items: center; gap: 0.6rem; padding: 0.35rem 0; border-bottom: 1px solid var(--border); }
  .damp-label { display: flex; flex-direction: column; min-width: 0; }
  .damp-point { font-size: 0.95rem; overflow-wrap: anywhere; }
  .damp-wall { font-size: 0.72rem; color: var(--text-subtle); }
  .damp-entry input[type=number] { width: 100%; min-height: 2.75rem; font-size: 16px; text-align: center; background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.4rem; }
  .damp-entry input[type=number]:focus { outline: 2px solid var(--accent); border-color: var(--accent); }
  .damp-date input[type=date] { font-size: 16px; min-height: 2.5rem; background: var(--bg-secondary); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.3rem 0.5rem; }
  </style>
</head>
<body>
  ${buildPageHeader("Damp Readings", theme)}
  ${THEME_SCRIPT}
  ${savedBanner}
  <h2>Log readings</h2>
  ${renderForm()}
  <h2>Trends</h2>
  ${renderTrends(trendRows)}
  <h2>Charts</h2>
  ${renderCharts(trendRows)}
  <h2>Recent history</h2>
  ${renderHistory(recentRows)}
  ${renderContext()}
  ${DAMP_AUTOSAVE_SCRIPT}
  ${DAMP_CHART_SCRIPT}
</body>
</html>`;
}

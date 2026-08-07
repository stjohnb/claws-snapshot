import { describe, it, expect } from "vitest";
import { buildDampPage, DAMP_POINTS } from "./damp.js";
import type { DampReadingRow } from "../db.js";

describe("damp page", () => {
  it("DAMP_POINTS has 15 entries", () => {
    expect(DAMP_POINTS.length).toBe(15);
  });

  it("buildDampPage renders the form and location/point names", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain("Downstairs toilet");
    expect(html).toContain("Manifold");
    expect(html).toContain('action="/damp/log"');
    expect(html).toContain("/damp/reading");
    for (let i = 0; i < DAMP_POINTS.length; i++) {
      expect(html).toContain(`name="p${i}"`);
      expect(html).toContain(`data-index="${i}"`);
      expect(html).toContain(`id="s${i}"`);
    }
  });

  it("buildDampPage shows empty state and Charts heading when there are no readings", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain("No readings yet.");
    expect(html).toContain("<h2>Charts</h2>");
  });

  it("buildDampPage renders an svg polyline when a point has two or more dated readings", () => {
    const rows: DampReadingRow[] = [
      { id: 1, location: "Downstairs toilet", point: "N", value: 10, reading_date: "2026-01-01", recorded_at: "2026-01-01T09:00:00.000Z" },
      { id: 2, location: "Downstairs toilet", point: "N", value: 12, reading_date: "2026-01-02", recorded_at: "2026-01-02T09:00:00.000Z" },
    ];
    const html = buildDampPage(rows, rows, "light", false);
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");
  });

  it("buildDampPage shows 'Not enough data' for a location with a single reading", () => {
    const rows: DampReadingRow[] = [
      { id: 1, location: "Downstairs toilet", point: "N", value: 10, reading_date: "2026-01-01", recorded_at: "2026-01-01T09:00:00.000Z" },
    ];
    const html = buildDampPage(rows, rows, "light", false);
    expect(html).toContain("Not enough data to plot");
  });

  it("buildDampPage renders all points on a single chart (one svg)", () => {
    const rows: DampReadingRow[] = [
      { id: 1, location: "Downstairs toilet", point: "N", value: 10, reading_date: "2026-01-01", recorded_at: "2026-01-01T09:00:00.000Z" },
      { id: 2, location: "Downstairs toilet", point: "N", value: 12, reading_date: "2026-01-02", recorded_at: "2026-01-02T09:00:00.000Z" },
      { id: 3, location: "Utility wall", point: "centre", value: 5, reading_date: "2026-01-01", recorded_at: "2026-01-01T09:00:00.000Z" },
      { id: 4, location: "Utility wall", point: "centre", value: 6, reading_date: "2026-01-02", recorded_at: "2026-01-02T09:00:00.000Z" },
    ];
    const html = buildDampPage(rows, rows, "light", false);
    expect(html.match(/<svg/g)?.length).toBe(1);
    expect(html).toContain("Downstairs toilet · N");
    expect(html).toContain("Utility wall · centre");
  });

  it("buildDampPage renders the interpretation context", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain("damp-context");
    expect(html).toContain("2.5");
    expect(html).toContain("Wall type matters");
  });

  it("buildDampPage renders wall-type metadata and expected-reading guidance", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain("<th>Wall</th>");
    expect(html).toContain("masonry · interior");
    expect(html).toContain("stud · interior");
    expect(html).toContain("masonry · exterior");
    expect(html).toContain("What to expect");
    expect(html).toContain("damp-guide");
  });

  it("entry form is a stacked list, not a table, grouped by location", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain('class="damp-entry"');
    const distinctLocations = new Set(DAMP_POINTS.map((p) => p.location));
    expect(html.match(/class="damp-group"/g)?.length).toBe(distinctLocations.size);
  });

  it("preserves original index order when grouping points by location", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain('name="p14"');
    expect(html).toContain('data-index="14"');
  });

  it("read-only tables opt into the shared responsive card pattern", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain('class="table-scroll"');
    expect(html).toContain('class="damp-table data-cards"');
    expect(html).toContain('data-label="Latest"');
  });

  it("the interpretation guide is collapsed and rendered after the log-readings form", () => {
    const html = buildDampPage([], [], "light", false);
    expect(html).toContain('<details class="damp-context">');
    expect(html.indexOf('<details class="damp-context">')).toBeGreaterThan(html.indexOf('class="damp-entry"'));
  });
});

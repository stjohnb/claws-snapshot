import { describe, it, expect } from "vitest";
import { buildHaUpgraderPage } from "./ha-upgrader.js";
import type { HaUpgraderStateRow } from "../db.js";

describe("buildHaUpgraderPage tables", () => {
  it("renders each table as data-cards with a data-label on the first cell", () => {
    const row: HaUpgraderStateRow = {
      entity_id: "update.some_device",
      version: "1.2.3",
      first_seen_at: Date.now() - 1000,
      attempted_at: Date.now() - 500,
      failure_count: 0,
    };
    const html = buildHaUpgraderPage([row], "light");
    expect(html).toContain('class="ha-table data-cards"');
    expect(html).toContain('data-label="Entity"');
  });
});

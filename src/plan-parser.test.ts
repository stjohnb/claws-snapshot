import { describe, it, expect } from "vitest";
import { parsePlan, findPlanComment } from "./plan-parser.js";

describe("parsePlan", () => {
  it("parses a multi-PR plan with 3 phases", () => {
    const plan = [
      "Some preamble text about the issue.",
      "",
      "### PR 1: Add database schema",
      "Create the new tables and migrations.",
      "- File: schema.sql",
      "",
      "### PR 2: Implement API endpoints",
      "Build the REST endpoints.",
      "- File: api/routes.ts",
      "",
      "### PR 3: Add frontend UI",
      "Wire up the React components.",
      "- File: components/Form.tsx",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.totalPhases).toBe(3);
    expect(result.preamble).toBe("Some preamble text about the issue.");
    expect(result.phases).toHaveLength(3);

    expect(result.phases[0].phaseNumber).toBe(1);
    expect(result.phases[0].title).toBe("Add database schema");
    expect(result.phases[0].description).toContain("Create the new tables");

    expect(result.phases[1].phaseNumber).toBe(2);
    expect(result.phases[1].title).toBe("Implement API endpoints");
    expect(result.phases[1].description).toContain("REST endpoints");

    expect(result.phases[2].phaseNumber).toBe(3);
    expect(result.phases[2].title).toBe("Add frontend UI");
    expect(result.phases[2].description).toContain("React components");
  });

  it("returns single phase when no PR headers found", () => {
    const plan = "Just a simple plan with no multi-PR structure.\n\nChange file X.";

    const result = parsePlan(plan);

    expect(result.totalPhases).toBe(1);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phaseNumber).toBe(1);
    expect(result.phases[0].title).toBe("Implementation");
    expect(result.phases[0].description).toBe(plan);
  });

  it("handles plan with no preamble", () => {
    const plan = [
      "### PR 1: First change",
      "Do the first thing.",
      "",
      "### PR 2: Second change",
      "Do the second thing.",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.totalPhases).toBe(2);
    expect(result.preamble).toBe("");
    expect(result.phases[0].title).toBe("First change");
    expect(result.phases[1].title).toBe("Second change");
  });

  it("parses a multi-Phase plan", () => {
    const plan = [
      "Some preamble text about the issue.",
      "",
      "### Phase 1: Create Zod schemas",
      "Define validation schemas for all API responses.",
      "- File: schemas.ts",
      "",
      "### Phase 2: Migrate SWR calls",
      "Update all useSWR hooks to use validatedFetcher.",
      "- File: hooks/useData.ts",
      "",
      "### Phase 3: Remove legacy fetcher",
      "Delete the old unvalidated fetcher utility.",
      "- File: utils/fetcher.ts",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.totalPhases).toBe(3);
    expect(result.preamble).toBe("Some preamble text about the issue.");
    expect(result.phases).toHaveLength(3);

    expect(result.phases[0].phaseNumber).toBe(1);
    expect(result.phases[0].title).toBe("Create Zod schemas");
    expect(result.phases[0].description).toContain("validation schemas");

    expect(result.phases[1].phaseNumber).toBe(2);
    expect(result.phases[1].title).toBe("Migrate SWR calls");
    expect(result.phases[1].description).toContain("validatedFetcher");

    expect(result.phases[2].phaseNumber).toBe(3);
    expect(result.phases[2].title).toBe("Remove legacy fetcher");
    expect(result.phases[2].description).toContain("unvalidated fetcher");
  });

  it("parses mixed PR and Phase headers", () => {
    const plan = [
      "Preamble.",
      "",
      "### PR 1: Backend changes",
      "Update the API layer.",
      "",
      "### Phase 2: Frontend changes",
      "Update the UI components.",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.totalPhases).toBe(2);
    expect(result.preamble).toBe("Preamble.");
    expect(result.phases[0].phaseNumber).toBe(1);
    expect(result.phases[0].title).toBe("Backend changes");
    expect(result.phases[1].phaseNumber).toBe(2);
    expect(result.phases[1].title).toBe("Frontend changes");
  });

  it("handles empty plan", () => {
    const result = parsePlan("");

    expect(result.totalPhases).toBe(1);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].title).toBe("Implementation");
  });
});

describe("findPlanComment", () => {
  it("finds the most recent plan comment", () => {
    const comments = [
      { body: "Some discussion" },
      { body: "## Implementation Plan\n\nOld plan" },
      { body: "More discussion" },
      { body: "## Implementation Plan\n\nNew plan" },
    ];

    const result = findPlanComment(comments);
    expect(result).toBe("## Implementation Plan\n\nNew plan");
  });

  it("returns null when no plan comment exists", () => {
    const comments = [{ body: "Just a regular comment" }];

    const result = findPlanComment(comments);
    expect(result).toBeNull();
  });

  it("returns null for empty comments", () => {
    const result = findPlanComment([]);
    expect(result).toBeNull();
  });
});

import { describe, it, expect } from "vitest";
import { parsePlan, findPlanComment, findPlanCommentEntry, makePlanUpdateFooter, getPlanUpdatePhase, getRecommendedModel, getRecommendedReviewModel, extractModelsAttribution } from "./plan-parser.js";

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

  it("strips ## Implementation Plan header from preamble", () => {
    const plan = [
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: First change",
      "Do the first thing.",
      "",
      "### PR 2: Second change",
      "Do the second thing.",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.preamble).toBe("Preamble text.");
    expect(result.totalPhases).toBe(2);
  });

  it("strips Claws visible header from preamble", () => {
    const plan = [
      "*— Automated by Claws · Planner —*",
      "",
      "## Implementation Plan",
      "",
      "Preamble text.",
      "",
      "### PR 1: First change",
      "Do the first thing.",
      "",
      "### PR 2: Second change",
      "Do the second thing.",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.preamble).toBe("Preamble text.");
    expect(result.preamble).not.toContain("Automated by Claws");
  });

  it("handles empty plan", () => {
    const result = parsePlan("");

    expect(result.totalPhases).toBe(1);
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].title).toBe("Implementation");
  });

  it("strips plan-updated-after-phase marker from last phase description", () => {
    const plan = [
      "Preamble.",
      "",
      "### PR 1: First change",
      "Do the first thing.",
      "",
      "### PR 2: Second change",
      "Do the second thing.",
      "",
      "plan-updated-after-phase:1",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.phases[1].description).toBe("Do the second thing.");
    expect(result.phases[1].description).not.toContain("plan-updated-after-phase");
  });

  it("strips recommended-model line from phase descriptions", () => {
    const plan = [
      "Preamble.",
      "",
      "### PR 1: First change",
      "Do the first thing.",
      "",
      "### PR 2: Second change",
      "Do the second thing.",
      "",
      "**Recommended implementation model:** `sonnet`",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.phases[1].description).toBe("Do the second thing.");
    expect(result.phases[1].description).not.toContain("Recommended implementation model");
  });
});

describe("findPlanComment", () => {
  it("finds the most recent Claws-authored plan comment", () => {
    const comments = [
      { body: "Some discussion" },
      { body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOld plan" },
      { body: "More discussion" },
      { body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nNew plan" },
    ];

    const result = findPlanComment(comments);
    expect(result).toBe("*— Automated by Claws —*\n\n## Implementation Plan\n\nNew plan");
  });

  it("ignores plan comments not authored by Claws", () => {
    const comments = [
      { body: "## Implementation Plan\n\nHuman-written plan" },
      { body: "Some discussion" },
    ];

    const result = findPlanComment(comments);
    expect(result).toBeNull();
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

describe("findPlanCommentEntry", () => {
  it("returns id and body of the most recent Claws-authored plan comment", () => {
    const comments = [
      { id: 1, body: "Some discussion" },
      { id: 2, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nOld plan" },
      { id: 3, body: "More discussion" },
      { id: 4, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nNew plan" },
    ];

    const result = findPlanCommentEntry(comments);
    expect(result).toEqual({ id: 4, body: "*— Automated by Claws —*\n\n## Implementation Plan\n\nNew plan" });
  });

  it("ignores plan comments not authored by Claws", () => {
    const comments = [
      { id: 1, body: "## Implementation Plan\n\nHuman-injected plan" },
      { id: 2, body: "Some discussion" },
    ];

    const result = findPlanCommentEntry(comments);
    expect(result).toBeNull();
  });

  it("returns null when no plan comment exists", () => {
    const result = findPlanCommentEntry([{ id: 1, body: "Just a regular comment" }]);
    expect(result).toBeNull();
  });
});

describe("makePlanUpdateFooter", () => {
  it("returns correct marker format", () => {
    expect(makePlanUpdateFooter(1)).toBe("plan-updated-after-phase:1");
    expect(makePlanUpdateFooter(3)).toBe("plan-updated-after-phase:3");
  });
});

describe("getPlanUpdatePhase", () => {
  it("extracts phase number from marker", () => {
    const text = "Some plan text\n\nplan-updated-after-phase:2";
    expect(getPlanUpdatePhase(text)).toBe(2);
  });

  it("returns null when no marker present", () => {
    const text = "Some plan text without any marker";
    expect(getPlanUpdatePhase(text)).toBeNull();
  });

  it("extracts the correct number from multi-digit phases", () => {
    const text = "Plan\nplan-updated-after-phase:12";
    expect(getPlanUpdatePhase(text)).toBe(12);
  });

  it("returns the last marker when multiple markers are present", () => {
    const text = "Plan\nplan-updated-after-phase:1\nplan-updated-after-phase:3";
    expect(getPlanUpdatePhase(text)).toBe(3);
  });
});

describe("getRecommendedModel", () => {
  it("returns sonnet when plan recommends sonnet", () => {
    const text = "Plan content.\n\n**Recommended implementation model:** `sonnet`";
    expect(getRecommendedModel(text)).toBe("sonnet");
  });

  it("returns opus when plan recommends opus", () => {
    const text = "Plan content.\n\n**Recommended implementation model:** `opus`";
    expect(getRecommendedModel(text)).toBe("opus");
  });

  it("returns null when no marker present", () => {
    const text = "Just a plan with no model recommendation.";
    expect(getRecommendedModel(text)).toBeNull();
  });

  it("returns null for invalid model values", () => {
    const text = "Plan content.\n\n**Recommended implementation model:** `haiku`";
    expect(getRecommendedModel(text)).toBeNull();
  });
});

describe("getRecommendedReviewModel", () => {
  it("returns sonnet when plan recommends sonnet for review", () => {
    const text = "Plan content.\n\n**Recommended review model:** `sonnet`";
    expect(getRecommendedReviewModel(text)).toBe("sonnet");
  });

  it("returns opus when plan recommends opus for review", () => {
    const text = "Plan content.\n\n**Recommended review model:** `opus`";
    expect(getRecommendedReviewModel(text)).toBe("opus");
  });

  it("returns null when no review model marker present", () => {
    const text = "Just a plan with no review model recommendation.";
    expect(getRecommendedReviewModel(text)).toBeNull();
  });

  it("returns null for invalid model values", () => {
    const text = "Plan content.\n\n**Recommended review model:** `haiku`";
    expect(getRecommendedReviewModel(text)).toBeNull();
  });
});

describe("parsePlan strips review model line", () => {
  it("strips recommended-review-model line from phase descriptions", () => {
    const plan = [
      "Preamble.",
      "",
      "### PR 1: First change",
      "Do the first thing.",
      "",
      "### PR 2: Second change",
      "Do the second thing.",
      "",
      "**Recommended review model:** `sonnet`",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.phases[1].description).toBe("Do the second thing.");
    expect(result.phases[1].description).not.toContain("Recommended review model");
  });
});

describe("parsePlan strips provider line", () => {
  it("strips recommended-provider line from phase descriptions", () => {
    const plan = [
      "Preamble.",
      "",
      "### PR 1: First change",
      "Do the first thing.",
      "",
      "### PR 2: Second change",
      "Do the second thing.",
      "",
      "**Recommended provider:** `codex`",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.phases[1].description).toBe("Do the second thing.");
    expect(result.phases[1].description).not.toContain("Recommended provider");
  });
});

describe("extractModelsAttribution", () => {
  it("extracts models-used attribution line", () => {
    const body = "Plan content.\n\n*Models used: claude-sonnet-4-5 (planner)*";
    expect(extractModelsAttribution(body)).toBe("*Models used: claude-sonnet-4-5 (planner)*");
  });

  it("returns null when no attribution line present", () => {
    const body = "Plan content with no attribution.";
    expect(extractModelsAttribution(body)).toBeNull();
  });

  it("handles attribution with multiple models", () => {
    const body = "Plan.\n\n*Models used: claude-opus-4-6 (planner), claude-sonnet-4-6 (reviewer)*";
    expect(extractModelsAttribution(body)).toBe("*Models used: claude-opus-4-6 (planner), claude-sonnet-4-6 (reviewer)*");
  });
});

describe("parsePlan strips verbose preamble", () => {
  it("strips verbose preamble with 'I'll analyze' before plan header", () => {
    const plan = [
      "I'll analyze the GitHub issue about noisy plans and produce a detailed implementation plan.",
      "",
      "Let me examine the codebase structure to understand the issue.",
      "",
      "## Implementation Plan",
      "",
      "This issue is about reducing verbosity in OpenCode-generated plans.",
      "",
      "### PR 1: Add conciseness instructions",
      "Update issue-refiner.ts to include concise output instructions.",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.preamble).toBe("This issue is about reducing verbosity in OpenCode-generated plans.");
    expect(result.preamble).not.toContain("I'll analyze");
    expect(result.preamble).not.toContain("Let me examine");
  });

  it("strips verbose preamble with 'Based on my review' before plan header", () => {
    const plan = [
      "Based on my review of the issue, I'll create an implementation plan.",
      "",
      "After analyzing the codebase, here's what needs to be done:",
      "",
      "## Implementation Plan",
      "",
      "The plan details go here.",
      "",
      "### PR 1: First change",
      "Do the first thing.",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.preamble).toBe("The plan details go here.");
    expect(result.preamble).not.toContain("Based on my review");
    expect(result.preamble).not.toContain("After analyzing");
  });

  it("preserves text before plan header when it doesn't contain verbose phrases", () => {
    const plan = [
      "Context about the issue:",
      "This is a bug fix for issue #123.",
      "",
      "## Implementation Plan",
      "",
      "Fix the bug by updating the parser.",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.preamble).toContain("Context about the issue");
    expect(result.preamble).toContain("This is a bug fix");
  });

  it("handles plan without ## Implementation Plan header", () => {
    const plan = [
      "I'll help you with this issue.",
      "",
      "Just a simple fix needed here.",
    ].join("\n");

    const result = parsePlan(plan);

    // Without the header, the verbose preamble stripping doesn't apply
    expect(result.totalPhases).toBe(1);
    expect(result.phases[0].description).toContain("I'll help you");
  });

  it("strips verbose preamble with multiple verbose phrases", () => {
    const plan = [
      "I'll analyze this GitHub issue for the repository St-John-Software/claws.",
      "Let me examine the current implementation to understand the problem.",
      "Upon review of the codebase, I can see that plans are too verbose.",
      "",
      "## Implementation Plan",
      "",
      "Core changes needed:",
      "",
      "### PR 1: Update prompts",
      "Add conciseness instructions to issue-refiner.ts",
    ].join("\n");

    const result = parsePlan(plan);

    expect(result.preamble).toBe("Core changes needed:");
    expect(result.preamble).not.toContain("I'll analyze");
    expect(result.preamble).not.toContain("Let me examine");
    expect(result.preamble).not.toContain("Upon review");
  });
});

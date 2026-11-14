import { describe, it, expect } from "vitest";
import * as config from "./config.js";
import { shippedModelDefault } from "./model-selector.js";

describe("shippedModelDefault", () => {
  it("matches the effective config defaults", () => {
    expect(shippedModelDefault("improvementIdentifierModel")).toBe(config.IMPROVEMENT_IDENTIFIER_MODEL);
    expect(shippedModelDefault("opencodeBestModel")).toBe(config.OPENCODE_BEST_MODEL);
    expect(shippedModelDefault("opencodeAdequateModel")).toBe(config.OPENCODE_ADEQUATE_MODEL);
    expect(shippedModelDefault("opencodeCheapModel")).toBe(config.OPENCODE_CHEAP_MODEL);
    expect(shippedModelDefault("opencodeFableModel")).toBe(config.OPENCODE_FABLE_MODEL);
  });
});

import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerPlannerTools, parsePlannerOffers, type PlannerToolDeps } from "./planner-tools.js";

function makeDeps(overrides: Partial<PlannerToolDeps> = {}): PlannerToolDeps {
  return {
    runId: "run-1",
    stage: "plan",
    offers: { duplicates: false, transfer: false },
    fetchApi: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

async function connect(deps: PlannerToolDeps): Promise<Client> {
  const server = new McpServer({ name: "claws-state", version: "1.0.0" });
  registerPlannerTools(server, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function toolNames(deps: PlannerToolDeps): Promise<string[]> {
  const client = await connect(deps);
  // An McpServer with no tools registers no tools/list handler at all.
  const tools = await client.listTools().then((r) => r.tools).catch(() => []);
  return tools.map((t) => t.name).sort();
}

const PLAN_ARGS = {
  plan: "### Requirement\nx",
  prs: [{ repo: "o/r", title: "x" }],
  implementation_model: "sonnet",
  review_model: "opus",
};

describe("registerPlannerTools", () => {
  it("registers nothing without a run id", async () => {
    expect(await toolNames(makeDeps({ runId: "" }))).toEqual([]);
  });

  it("registers the plan and outcome tools in the plan and refine stages", async () => {
    expect(await toolNames(makeDeps({ stage: "plan" }))).toEqual(["claws_report_outcome", "claws_save_plan"]);
    expect(await toolNames(makeDeps({ stage: "refine" }))).toEqual(["claws_report_outcome", "claws_save_plan"]);
  });

  it("omits claws_report_outcome for a plan-only run (allowOutcomes: false)", async () => {
    expect(await toolNames(makeDeps({ stage: "plan", outcomes: false }))).toEqual(["claws_save_plan"]);
    expect(await toolNames(makeDeps({ stage: "refine", outcomes: false }))).toEqual(["claws_save_plan"]);
  });

  it("registers only the step-back verdict in the step_back stage", async () => {
    expect(await toolNames(makeDeps({ stage: "step_back" }))).toEqual(["claws_step_back_verdict"]);
  });

  it("offers response only when refining", async () => {
    const schemaOf = async (stage: PlannerToolDeps["stage"]) => {
      const { tools } = await (await connect(makeDeps({ stage }))).listTools();
      return tools.find((t) => t.name === "claws_save_plan")!.inputSchema.properties ?? {};
    };
    expect(Object.keys(await schemaOf("refine"))).toContain("response");
    expect(Object.keys(await schemaOf("plan"))).not.toContain("response");
  });

  it("limits the outcome tool to the outcomes the prompt offered", async () => {
    const outcomeSchema = async (offers: PlannerToolDeps["offers"]) => {
      const { tools } = await (await connect(makeDeps({ offers }))).listTools();
      const tool = tools.find((t) => t.name === "claws_report_outcome")!;
      const props = tool.inputSchema.properties as Record<string, { enum?: string[] }>;
      return { outcomes: props["outcome"]!.enum!.slice().sort(), fields: Object.keys(props).sort() };
    };
    expect(await outcomeSchema({ duplicates: false, transfer: false })).toEqual({
      outcomes: ["blocked", "no_code_changes"],
      fields: ["explanation", "outcome"],
    });
    expect(await outcomeSchema({ duplicates: true, transfer: true })).toEqual({
      outcomes: ["blocked", "duplicate", "no_code_changes", "transfer"],
      fields: ["duplicate_of", "explanation", "outcome", "transfer_to"],
    });
  });

  it("posts to the run's own route", async () => {
    const deps = makeDeps({ runId: "abc-123" });
    const client = await connect(deps);
    const result = await client.callTool({ name: "claws_save_plan", arguments: PLAN_ARGS }) as { isError?: boolean };
    expect(result.isError).toBeFalsy();
    expect(deps.fetchApi).toHaveBeenCalledWith("/api/planner-runs/abc-123/plan", expect.any(Number), { method: "POST", body: PLAN_ARGS });

    await client.callTool({ name: "claws_report_outcome", arguments: { outcome: "blocked", explanation: "x" } });
    expect(deps.fetchApi).toHaveBeenLastCalledWith("/api/planner-runs/abc-123/outcome", expect.any(Number), { method: "POST", body: { outcome: "blocked", explanation: "x" } });
  });

  it("returns the API error text to the agent", async () => {
    const deps = makeDeps({
      fetchApi: vi.fn(async () => { throw new Error('HTTP 400: prs[1].repo "x/y" is not one of this issue\'s repositories: o/r'); }),
    });
    const client = await connect(deps);
    const result = await client.callTool({ name: "claws_save_plan", arguments: PLAN_ARGS }) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("is not one of this issue's repositories: o/r");
    expect(result.content[0]!.text).toContain("fix the input and call again");
  });

  it("sends the step-back verdict to the step-back route", async () => {
    const deps = makeDeps({ stage: "step_back" });
    const client = await connect(deps);
    await client.callTool({ name: "claws_step_back_verdict", arguments: { verdict: "sound" } });
    expect(deps.fetchApi).toHaveBeenCalledWith("/api/planner-runs/run-1/step-back", expect.any(Number), { method: "POST", body: { verdict: "sound" } });
  });
});

describe("parsePlannerOffers", () => {
  it("reads a comma list", () => {
    expect(parsePlannerOffers("duplicate, transfer")).toEqual({ duplicates: true, transfer: true });
    expect(parsePlannerOffers("transfer")).toEqual({ duplicates: false, transfer: true });
    expect(parsePlannerOffers("")).toEqual({ duplicates: false, transfer: false });
  });
});

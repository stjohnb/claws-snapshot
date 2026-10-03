import { describe, it, expect, vi } from "vitest";

vi.mock("./log.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { startPlannerRunListener, plannerRunApp } from "./planner-run-listener.js";
import { withPlannerRun, getSubmission, NO_SUCH_PLANNER_RUN } from "./planner-runs.js";

const TOKEN = "pod-token-" + "x".repeat(40);
const RUN = { repo: "org/repo", issueRef: 1, stage: "plan" as const, allowedRepos: ["org/repo"] };
const PLAN = JSON.stringify({
  plan: "### Requirement\nx",
  prs: [{ repo: "org/repo", title: "x" }],
  implementation_model: "sonnet",
  review_model: "opus",
});

function post(baseUrl: string, path: string, body: string, token?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}

describe("planner-run listener (#clw_01M3A42ZTGECAB11S0BZA6NG1A)", () => {
  it("binds loopback only, on an ephemeral port, and records a plan posted with the pod's token", async () => {
    const listener = await startPlannerRunListener({ token: TOKEN });
    try {
      expect(listener.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(listener.baseUrl).not.toMatch(/:0$/);
      await withPlannerRun(RUN, async (id) => {
        const res = await post(listener.baseUrl, `/api/planner-runs/${id}/plan`, PLAN, TOKEN);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(getSubmission(id)?.kind).toBe("plan");
      });
    } finally {
      await listener.close();
    }
  });

  it("refuses a missing or wrong bearer with 401 and records nothing", async () => {
    const listener = await startPlannerRunListener({ token: TOKEN });
    try {
      await withPlannerRun(RUN, async (id) => {
        const missing = await post(listener.baseUrl, `/api/planner-runs/${id}/plan`, PLAN);
        expect(missing.status).toBe(401);
        const wrong = await post(listener.baseUrl, `/api/planner-runs/${id}/plan`, PLAN, "not-the-token");
        expect(wrong.status).toBe(401);
        expect(getSubmission(id)).toBeNull();
      });
    } finally {
      await listener.close();
    }
  });

  it("answers 404 for an unknown run and serves all three routes", async () => {
    const app = plannerRunApp(TOKEN);
    const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
    for (const route of ["plan", "outcome", "step-back"]) {
      const res = await app.request(`/api/planner-runs/no-such-run/${route}`, { method: "POST", body: "{}", headers });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: NO_SUCH_PLANNER_RUN });
    }
  });

  it("refuses to start without a token", async () => {
    await expect(startPlannerRunListener({ token: "" })).rejects.toThrow(/token/);
  });
});

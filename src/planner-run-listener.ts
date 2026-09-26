/**
 * The agent pod's loopback listener for the planner-run routes
 * (#clw_01M3A42ZTGECAB11S0BZA6NG1A).
 *
 * Under `CLAWS_WORK_BACKEND=k8s-pod` the issue-refiner runs inside the agent
 * pod, so `withPlannerRun` (`src/planner-runs.ts`) registers each planner run
 * in the pod's memory. The MCP child's planner tools used to post their
 * submissions to the service (`CLAWS_MCP_BASE_URL`), whose own registry never
 * opened the run, so every `claws_save_plan` got `404 no such planner run`.
 * This listener serves the same three routes as `server.ts` from the process
 * that holds the registry, bound to 127.0.0.1 on an ephemeral port, and
 * `agent-pod/run.ts` publishes its URL to the MCP config writer through
 * `CLAWS_PLANNER_RUN_BASE_URL`, which becomes the child's
 * `CLAWS_MCP_PLANNER_BASE_URL`.
 *
 * Callers authenticate with the pod's own bearer token — the same one the MCP
 * child already sends to the service — so a misdirected call from anything
 * else in the pod is refused. Loopback only: a wider bind would expose the
 * planner routes across the pod network.
 */

import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import * as log from "./log.js";
import { plannerRunHandler, submitPlan, submitOutcome, submitStepBack } from "./planner-runs.js";

export interface PlannerRunListener {
  /** `http://127.0.0.1:<port>`, the base the MCP child's planner tools post to. */
  baseUrl: string;
  close(): Promise<void>;
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

/** The routes and their bearer guard, separate from the listener so a test can drive `app.request()`. */
export function plannerRunApp(token: string): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token || !provided || !safeCompare(provided, token)) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.post("/api/planner-runs/:id/plan", plannerRunHandler(submitPlan));
  app.post("/api/planner-runs/:id/outcome", plannerRunHandler(submitOutcome));
  app.post("/api/planner-runs/:id/step-back", plannerRunHandler(submitStepBack));
  return app;
}

/** Start serving the planner-run routes on loopback; resolves once the port is bound. */
export async function startPlannerRunListener(opts: { token: string }): Promise<PlannerRunListener> {
  if (!opts.token) throw new Error("planner-run listener needs the pod's MCP token");
  const app = plannerRunApp(opts.token);
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, () => resolve(s));
    s.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("planner-run listener bound no TCP port");
  }
  const port = (address as AddressInfo).port;
  log.info(`[planner-run-listener] Serving planner-run routes on 127.0.0.1:${port}`);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); }),
  };
}

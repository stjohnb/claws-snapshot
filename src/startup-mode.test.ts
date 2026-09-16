import { describe, expect, it } from "vitest";
import type { Job } from "./scheduler.js";
import { canRunJobForActivation, selectStartupJobs, shouldStartWorkersForActivation } from "./startup-mode.js";

function job(name: string, triggers?: string[]): Job {
  return {
    name,
    intervalMs: 60_000,
    triggers,
    run: async () => {},
  };
}

describe("selectStartupJobs", () => {
  const jobs = [
    job("issue-dispatcher", ["pr-dispatcher"]),
    job("pr-dispatcher"),
    job("repo-standards"),
    job("staging-db-sync"),
  ];

  it("registers all jobs when active", () => {
    expect(selectStartupJobs(jobs, "active").map((j) => j.name)).toEqual([
      "issue-dispatcher",
      "pr-dispatcher",
      "repo-standards",
      "staging-db-sync",
    ]);
  });

  it("registers no jobs when verify-only", () => {
    expect(selectStartupJobs(jobs, "verify-only")).toEqual([]);
  });

  it("registers exactly the issue and PR dispatcher lane when staging", () => {
    expect(selectStartupJobs(jobs, "staging").map((j) => j.name)).toEqual([
      "issue-dispatcher",
      "pr-dispatcher",
    ]);
  });

  it("keeps staging trigger targets registered", () => {
    const selected = selectStartupJobs(jobs, "staging");
    const selectedNames = new Set(selected.map((j) => j.name));
    const issueDispatcher = selected.find((j) => j.name === "issue-dispatcher");

    expect(issueDispatcher?.triggers).toContain("pr-dispatcher");
    for (const target of issueDispatcher?.triggers ?? []) {
      expect(selectedNames.has(target)).toBe(true);
    }
  });
});

describe("shouldStartWorkersForActivation", () => {
  it("starts workers only for work-capable activation states", () => {
    expect(shouldStartWorkersForActivation("active")).toBe(true);
    expect(shouldStartWorkersForActivation("staging")).toBe(true);
    expect(shouldStartWorkersForActivation("verify-only")).toBe(false);
  });
});

describe("canRunJobForActivation", () => {
  it("allows all jobs in active mode", () => {
    expect(canRunJobForActivation("repo-standards", "active")).toBe(true);
    expect(canRunJobForActivation("issue-dispatcher", "active")).toBe(true);
  });

  it("allows only the issue and PR dispatcher lane in staging mode", () => {
    expect(canRunJobForActivation("issue-dispatcher", "staging")).toBe(true);
    expect(canRunJobForActivation("pr-dispatcher", "staging")).toBe(true);
    expect(canRunJobForActivation("repo-standards", "staging")).toBe(false);
  });

  it("blocks every job in verify-only mode", () => {
    expect(canRunJobForActivation("issue-dispatcher", "verify-only")).toBe(false);
    expect(canRunJobForActivation("repo-standards", "verify-only")).toBe(false);
  });
});

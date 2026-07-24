import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, MAX_WORK_WORKERS: 2 };
});

import { ordinal, formatDuration, getItemStatus, buildQueuePage, type PipelineInfo } from "./queue.js";
import type { QueueItem } from "../github.js";

describe("ordinal", () => {
  it("handles 1st, 2nd, 3rd", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
  });

  it("handles 4th–9th", () => {
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(9)).toBe("9th");
  });

  it("handles teens (11th, 12th, 13th)", () => {
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
  });

  it("handles 21st, 22nd, 23rd", () => {
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(23)).toBe("23rd");
  });

  it("handles 111th, 112th, 113th (teens pattern)", () => {
    expect(ordinal(111)).toBe("111th");
    expect(ordinal(112)).toBe("112th");
    expect(ordinal(113)).toBe("113th");
  });

  it("handles 0 and negative input", () => {
    expect(ordinal(0)).toBe("0th");
    expect(ordinal(-1)).toBe("-1th");
  });

  it("handles larger numbers", () => {
    expect(ordinal(101)).toBe("101st");
    expect(ordinal(102)).toBe("102nd");
    expect(ordinal(103)).toBe("103rd");
    expect(ordinal(1000)).toBe("1000th");
  });
});

describe("formatDuration", () => {
  it("returns &lt;1m for sub-minute durations", () => {
    expect(formatDuration(0)).toBe("&lt;1m");
    expect(formatDuration(29_999)).toBe("&lt;1m");
  });

  it("rounds to nearest minute", () => {
    expect(formatDuration(30_000)).toBe("1m"); // rounds 0.5 up
    expect(formatDuration(89_999)).toBe("1m"); // 89999ms ≈ 1.4999min, rounds to 1m
  });

  it("returns minutes for <60m", () => {
    expect(formatDuration(60_000)).toBe("1m");
    expect(formatDuration(5 * 60_000)).toBe("5m");
    expect(formatDuration(59 * 60_000)).toBe("59m");
  });

  it("returns hours and minutes for >=60m", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h 0m");
    expect(formatDuration(90 * 60_000)).toBe("1h 30m");
    expect(formatDuration(125 * 60_000)).toBe("2h 5m");
  });

  it("returns em dash for NaN or non-finite input", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(Infinity)).toBe("—");
    expect(formatDuration(-Infinity)).toBe("—");
  });
});

describe("getItemStatus", () => {
  const baseItem: QueueItem = {
    repo: "org/repo",
    number: 42,
    title: "Test issue",
    category: "refined",
    updatedAt: new Date().toISOString(),
    type: "issue",
  };

  it("returns empty string when no pipeline info", () => {
    expect(getItemStatus(baseItem)).toBe("");
  });

  it("returns empty string when item is not running", () => {
    const pipeline: PipelineInfo = {
      runningTasks: [],
      claudeEntries: [],
      jobNextRun: {},
      avgDurations: {},
    };
    expect(getItemStatus(baseItem, pipeline)).toBe("");
  });

  it("shows processing status when running but not in Claude queue", () => {
    const pipeline: PipelineInfo = {
      runningTasks: [{
        id: 1,
        run_id: "run-1",
        job_name: "issue-worker",
        repo: "org/repo",
        item_number: 42,
        trigger_label: null,
        worktree_path: null,
        branch_name: null,
        started_at: new Date(Date.now() - 120_000).toISOString().replace("Z", ""),
        completed_at: null,
        status: "running",
        error: null,
        outcome: null,
        model_used: null,
        provider_used: null,
        tokens_used: null,
        cost_usd: null,
      }],
      claudeEntries: [],
      jobNextRun: {},
      avgDurations: {},
    };
    const result = getItemStatus(baseItem, pipeline);
    expect(result).toContain("Processing");
    expect(result).toContain("status-processing");
  });

  it("shows queued status with position and ETA when in Claude queue", () => {
    const pipeline: PipelineInfo = {
      runningTasks: [{
        id: 1,
        run_id: "run-1",
        job_name: "issue-worker",
        repo: "org/repo",
        item_number: 42,
        trigger_label: null,
        worktree_path: null,
        branch_name: null,
        started_at: new Date().toISOString().replace("Z", ""),
        completed_at: null,
        status: "running",
        error: null,
        outcome: null,
        model_used: null,
        provider_used: null,
        tokens_used: null,
        cost_usd: null,
      }],
      claudeEntries: [{
        position: 2,
        priority: false,
        meta: { repo: "org/repo", itemNumber: 42, jobName: "issue-worker" },
      }],
      jobNextRun: {},
      avgDurations: { "issue-worker": 600_000 }, // 10 min avg
    };
    const result = getItemStatus(baseItem, pipeline);
    expect(result).toContain("Queued");
    expect(result).toContain("2nd");
    expect(result).toContain("ETA");
    expect(result).toContain("status-queued");
  });

  it("shows queued with weighted ETA across different job types", () => {
    const pipeline: PipelineInfo = {
      runningTasks: [{
        id: 1,
        run_id: "run-1",
        job_name: "issue-worker",
        repo: "org/repo",
        item_number: 42,
        trigger_label: null,
        worktree_path: null,
        branch_name: null,
        started_at: new Date().toISOString().replace("Z", ""),
        completed_at: null,
        status: "running",
        error: null,
        outcome: null,
        model_used: null,
        provider_used: null,
        tokens_used: null,
        cost_usd: null,
      }],
      claudeEntries: [
        { position: 1, priority: false, meta: { repo: "org/other", itemNumber: 10, jobName: "ci-fixer" } },
        { position: 2, priority: false, meta: { repo: "org/other", itemNumber: 11, jobName: "ci-fixer" } },
        { position: 3, priority: false, meta: { repo: "org/repo", itemNumber: 42, jobName: "issue-worker" } },
      ],
      jobNextRun: {},
      avgDurations: { "ci-fixer": 300_000, "issue-worker": 1_200_000 }, // 5min, 20min
    };
    const result = getItemStatus(baseItem, pipeline);
    // Greedy simulation: worker0=ci-fixer(5m), worker1=ci-fixer(5m), then
    // issue-worker assigned to earliest-free (t=5m), finishes at t=25m
    expect(result).toContain("ETA ~25m");
  });

  it("accounts for active workers' remaining time in ETA", () => {
    // Active worker has been running for 4 minutes on a ci-fixer (avg 5min), ~1min remaining.
    // Greedy sim: worker0 has 1min remaining, worker1 is free. issue-worker → worker1, finishes at 20min.
    const pipeline: PipelineInfo = {
      runningTasks: [
        {
          id: 1, run_id: "run-1", job_name: "issue-worker",
          repo: "org/repo", item_number: 42,
          started_at: new Date().toISOString().replace("Z", ""),
          completed_at: null, status: "running", error: null,
          trigger_label: "", worktree_path: null, branch_name: null, outcome: null,
          model_used: null, provider_used: null, tokens_used: null, cost_usd: null,
        },
        {
          id: 2, run_id: "run-2", job_name: "ci-fixer",
          repo: "org/other", item_number: 99,
          started_at: new Date(Date.now() - 4 * 60_000).toISOString().replace("Z", ""),
          completed_at: null, status: "running", error: null,
          trigger_label: "", worktree_path: null, branch_name: null, outcome: null,
          model_used: null, provider_used: null, tokens_used: null, cost_usd: null,
        },
      ],
      claudeEntries: [
        { position: 1, priority: false, meta: { repo: "org/repo", itemNumber: 42, jobName: "issue-worker" } },
      ],
      jobNextRun: {},
      avgDurations: { "ci-fixer": 300_000, "issue-worker": 1_200_000 }, // 5min, 20min
    };
    const result = getItemStatus(baseItem, pipeline);
    // Worker1 is free, issue-worker (20min) assigned there → ETA 20min
    expect(result).toContain("ETA ~20m");
  });

  it("accounts for active workers running sub-jobs (e.g. ci-fixer:merge-conflict)", () => {
    // Active worker job_name includes a colon suffix — the prefix must be extracted
    // to match avgDurations keys (keyed by prefix, e.g. "ci-fixer").
    const pipeline: PipelineInfo = {
      runningTasks: [
        {
          id: 1, run_id: "run-1", job_name: "issue-worker",
          repo: "org/repo", item_number: 42,
          started_at: new Date().toISOString().replace("Z", ""),
          completed_at: null, status: "running", error: null,
          trigger_label: "", worktree_path: null, branch_name: null, outcome: null,
          model_used: null, provider_used: null, tokens_used: null, cost_usd: null,
        },
        {
          id: 2, run_id: "run-2", job_name: "ci-fixer:merge-conflict",
          repo: "org/other", item_number: 99,
          started_at: new Date(Date.now() - 4 * 60_000).toISOString().replace("Z", ""),
          completed_at: null, status: "running", error: null,
          trigger_label: "", worktree_path: null, branch_name: null, outcome: null,
          model_used: null, provider_used: null, tokens_used: null, cost_usd: null,
        },
      ],
      claudeEntries: [
        { position: 1, priority: false, meta: { repo: "org/repo", itemNumber: 42, jobName: "issue-worker" } },
      ],
      jobNextRun: {},
      avgDurations: { "ci-fixer": 300_000, "issue-worker": 1_200_000 }, // 5min, 20min
    };
    const result = getItemStatus(baseItem, pipeline);
    // Same as above — prefix "ci-fixer" extracted from "ci-fixer:merge-conflict", 1min remaining.
    // issue-worker → free worker1, finishes at 20min
    expect(result).toContain("ETA ~20m");
  });

  it("shows queued without ETA when no avg duration", () => {
    const pipeline: PipelineInfo = {
      runningTasks: [{
        id: 1,
        run_id: "run-1",
        job_name: "issue-worker",
        repo: "org/repo",
        item_number: 42,
        trigger_label: null,
        worktree_path: null,
        branch_name: null,
        started_at: new Date().toISOString().replace("Z", ""),
        completed_at: null,
        status: "running",
        error: null,
        outcome: null,
        model_used: null,
        provider_used: null,
        tokens_used: null,
        cost_usd: null,
      }],
      claudeEntries: [{
        position: 1,
        priority: false,
        meta: { repo: "org/repo", itemNumber: 42, jobName: "issue-worker" },
      }],
      jobNextRun: {},
      avgDurations: {},
    };
    const result = getItemStatus(baseItem, pipeline);
    expect(result).toContain("Queued");
    expect(result).toContain("1st");
    expect(result).not.toContain("ETA");
  });

  it("shows 'Next scan' when item is not running and has a scheduled job", () => {
    const pipeline: PipelineInfo = {
      runningTasks: [],
      claudeEntries: [],
      jobNextRun: { "issue-dispatcher": 180_000 }, // 3 minutes from now
      avgDurations: {},
    };
    const result = getItemStatus(baseItem, pipeline);
    expect(result).toContain("Next scan");
    expect(result).toContain("in 3m");
    expect(result).toContain("status-waiting");
  });

  it("returns empty for 'Next scan' when job has no scheduled run", () => {
    const pipeline: PipelineInfo = {
      runningTasks: [],
      claudeEntries: [],
      jobNextRun: {},
      avgDurations: {},
    };
    // "refined" maps to "issue-dispatcher" but no nextRun entry
    const result = getItemStatus(baseItem, pipeline);
    expect(result).toBe("");
  });
});

describe("buildQueuePage refined button", () => {
  const makeItem = (category: QueueItem["category"], type: QueueItem["type"] = "issue"): QueueItem => ({
    repo: "org/repo",
    number: 99,
    title: "Test issue",
    category,
    updatedAt: new Date().toISOString(),
    type,
  });

  const now = Date.now();

  it("renders refined-btn for needs-refinement issues in clawsAttention section", () => {
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [makeItem("needs-refinement")], oldestFetchAt: now },
      "light",
    );
    expect(html).toContain('class="refined-btn"');
    expect(html).toContain("markRefined");
    expect(html).toContain("markAutomerge('org/repo',99, $event, true)");
  });

  it("does not render refined-btn for needs-refinement PRs", () => {
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [makeItem("needs-refinement", "pr")], oldestFetchAt: now },
      "light",
    );
    expect(html).not.toContain('class="refined-btn"');
  });

  it("does not render refined-btn for issues in other categories", () => {
    for (const category of ["refined", "needs-review-addressing", "auto-mergeable"] as const) {
      const html = buildQueuePage(
        { items: [], oldestFetchAt: null },
        { items: [makeItem(category)], oldestFetchAt: now },
        "light",
      );
      expect(html).not.toContain('class="refined-btn"');
    }
  });

  it("renders refined-btn for ready issues in myAttention section", () => {
    const html = buildQueuePage(
      { items: [makeItem("ready")], oldestFetchAt: now },
      { items: [], oldestFetchAt: null },
      "light",
    );
    expect(html).toContain('class="refined-btn"');
    expect(html).toContain("markRefined");
  });

  it("renders refined-btn for ready issues in clawsAttention section", () => {
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [makeItem("ready")], oldestFetchAt: now },
      "light",
    );
    expect(html).toContain('class="refined-btn"');
    expect(html).toContain("markRefined");
  });

  it("does not render refined-btn for ready PRs in myAttention section", () => {
    const html = buildQueuePage(
      { items: [makeItem("ready", "pr")], oldestFetchAt: now },
      { items: [], oldestFetchAt: null },
      "light",
    );
    expect(html).not.toContain('class="refined-btn"');
  });

  it("renders only the Automerge button for issues already carrying the Refined label", () => {
    const item: QueueItem = { ...makeItem("ready"), labels: ["Refined"] };
    const html = buildQueuePage(
      { items: [item], oldestFetchAt: now },
      { items: [], oldestFetchAt: null },
      "light",
    );
    expect(html).not.toContain("markRefined('org/repo'");
    expect(html).toContain("markAutomerge('org/repo',99, $event, false)");
  });

  it("renders only the Automerge button for needs-refinement issues already carrying the Refined label", () => {
    const item: QueueItem = { ...makeItem("needs-refinement"), labels: ["Refined"] };
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [item], oldestFetchAt: now },
      "light",
    );
    expect(html).not.toContain("markRefined('org/repo'");
    expect(html).toContain("markAutomerge('org/repo',99, $event, false)");
  });

  it("renders nothing extra for issues already carrying both Refined and Automerge labels", () => {
    const item: QueueItem = { ...makeItem("ready"), labels: ["Refined", "Automerge"] };
    const html = buildQueuePage(
      { items: [item], oldestFetchAt: now },
      { items: [], oldestFetchAt: null },
      "light",
    );
    expect(html).not.toContain("markRefined('org/repo'");
    expect(html).not.toContain("markAutomerge('org/repo'");
  });

  it("renders issue labels with class pr-label", () => {
    const item: QueueItem = { ...makeItem("needs-refinement"), labels: ["Priority", "Claws Ignore"] };
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [item], oldestFetchAt: now },
      "light",
    );
    expect(html).toContain('class="pr-label"');
    expect(html).toContain("Priority");
    expect(html).toContain("Claws Ignore");
  });
});

describe("buildQueuePage ordering", () => {
  const makeOrderItem = (
    category: QueueItem["category"],
    type: QueueItem["type"],
    number: number,
    updatedAt: string,
  ): QueueItem => ({
    repo: "org/repo",
    number,
    title: `Item ${number}`,
    category,
    updatedAt,
    type,
  });

  const fetchAt = Date.now();

  it("PRs render before issues regardless of updatedAt", () => {
    const issue = makeOrderItem("refined", "issue", 1, "2024-01-03T00:00:00Z");
    const pr = makeOrderItem("refined", "pr", 2, "2024-01-01T00:00:00Z"); // older than issue
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [issue, pr], oldestFetchAt: fetchAt },
      "light",
    );
    // Use queue-item IDs which are unique and unambiguous in the rendered HTML
    expect(html.indexOf('id="item-org/repo-2"')).toBeLessThan(html.indexOf('id="item-org/repo-1"'));
  });

  it("within PRs, newer updatedAt renders first", () => {
    const olderPR = makeOrderItem("auto-mergeable", "pr", 10, "2024-01-01T00:00:00Z");
    const newerPR = makeOrderItem("needs-review-addressing", "pr", 11, "2024-01-02T00:00:00Z");
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [olderPR, newerPR], oldestFetchAt: fetchAt },
      "light",
    );
    expect(html.indexOf('id="item-org/repo-11"')).toBeLessThan(html.indexOf('id="item-org/repo-10"'));
  });

  it("within issues, newer updatedAt renders first", () => {
    const olderIssue = makeOrderItem("needs-refinement", "issue", 20, "2024-01-01T00:00:00Z");
    const newerIssue = makeOrderItem("refined", "issue", 21, "2024-01-02T00:00:00Z");
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [olderIssue, newerIssue], oldestFetchAt: fetchAt },
      "light",
    );
    expect(html.indexOf('id="item-org/repo-21"')).toBeLessThan(html.indexOf('id="item-org/repo-20"'));
  });

  it("renders queue-label category badge for each item", () => {
    const item = makeOrderItem("refined", "issue", 30, "2024-01-01T00:00:00Z");
    const html = buildQueuePage(
      { items: [], oldestFetchAt: null },
      { items: [item], oldestFetchAt: fetchAt },
      "light",
    );
    expect(html).toContain('class="queue-label"');
    // "Refined" is the CATEGORY_DISPLAY label for "refined"
    expect(html).toContain("Refined");
  });
});

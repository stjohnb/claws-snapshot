import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./config.js", () => ({
  DB_PATH: ":memory:",
  DATABASE_URL: "",
  DATABASE_PASSWORD: "",
  WORK_DIR: "/tmp/claws-agent-metrics-test",
  PROVIDER_RATE_LIMIT_COOLDOWN_MS: 5 * 60_000,
}));
vi.mock("./log.js", () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("./slack.js", () => ({ notify: vi.fn() }));
const queue = vi.hoisted(() => ({ items: [] as Array<{ category: string }> }));
vi.mock("./github.js", () => ({
  ALL_QUEUE_CATEGORIES: ["ready", "needs-review"],
  getQueueSnapshot: vi.fn(() => ({ items: queue.items, oldestFetchAt: null })),
}));
const boardCounts = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("./operator-attention.js", () => ({ boardColumnCounts: boardCounts.fn }));

import * as db from "./db.js";
import * as log from "./log.js";
import { registry } from "./metrics.js";
import { OPEN_PR_STAGES, resetAgentMetricsForTests, sampleAgentMetrics, sampleBoardMetrics } from "./agent-metrics.js";

const METRIC_NAMES = [
  "claws_agent_tokens_total",
  "claws_agent_cost_usd_total",
  "claws_agent_tasks_total",
  "claws_provider_hold_expiry_timestamp_seconds",
  "claws_agents_running",
  "claws_queue_items",
  "claws_work_queue_items",
  "claws_board_issues",
  "claws_board_issues_waiting_on_operator",
  "claws_open_prs",
  "claws_job_last_run_timestamp_seconds",
  "claws_job_last_run_success",
  "claws_agent_metrics_last_sample_timestamp_seconds",
];

async function values(name: string): Promise<Array<{ labels: Record<string, string | number>; value: number }>> {
  const metric = registry.getSingleMetric(name);
  if (!metric) throw new Error(`${name} is not registered`);
  return (await metric.get()).values.map((v) => ({ labels: v.labels as Record<string, string | number>, value: v.value }));
}

async function tokensTotal(): Promise<number> {
  await sampleAgentMetrics();
  return (await values("claws_agent_tokens_total")).reduce((sum, v) => sum + v.value, 0);
}

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
}

async function addSession(id: string, repo: string | null, tokens: number): Promise<void> {
  await db.insertSession({
    id, tmux_name: `claws-${id}`, mode: "home-claude", repo, cwd: `/home/claws/work/${id}`, worktree_path: null, extra_worktrees: null,
    capabilities: null, created_at: 1, summary: null, summary_updated_at: null, provider: "claude", model: "claude-opus",
  });
  await db.updateSessionUsage(id, { tokensUsed: tokens, costUsd: tokens / 100, lastContextTokens: 0, usageUpdatedAt: Date.now() });
}

beforeEach(async () => {
  await db.initDb();
  resetAgentMetricsForTests();
  queue.items = [];
  boardCounts.fn.mockReset();
  vi.mocked(log.warn).mockClear();
});

afterEach(async () => {
  await db.closeDb();
});

describe("agent metrics", () => {
  it("exposes every metric, with the usage totals as counters", async () => {
    await db._rawDb().run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, tokens_used, cost_usd, provider_used, model_used, account_used) VALUES ('issue-worker:x','org/repo','1','completed','${ago(0)}','${ago(0)}', 100, 1.5, 'claude', 'opus', 'work')`);
    await db.setProviderHold("claude@work:opus", Date.now() + 60_000, "model-usage-limit");
    await db.insertJobRun("run-1", "work:issue");
    await db.completeJobRun("run-1", "failed");
    queue.items = [{ category: "ready" }, { category: "ready" }];
    boardCounts.fn.mockResolvedValue({ columns: { drafting: 2, blocked: 1 }, waiting: 1 });

    await sampleAgentMetrics();
    await sampleBoardMetrics();
    const text = await registry.metrics();

    for (const name of METRIC_NAMES) expect(text).toContain(`# TYPE ${name} `);
    expect(text).toContain("# TYPE claws_agent_tokens_total counter");
    expect(text).toContain("# TYPE claws_agent_cost_usd_total counter");
    expect(text).toContain("# TYPE claws_agent_tasks_total counter");
    expect(text).toContain('claws_agent_tokens_total{provider="claude",model="opus",account="work",repo="org/repo",job="issue-worker"} 100');
    expect(text).toContain('claws_agent_tasks_total{job="issue-worker",outcome="completed"} 1');
    expect(text).toContain('claws_provider_hold_expiry_timestamp_seconds{provider="claude",account="work",tier="opus",reason="model-tier"}');
    expect(text).toContain('claws_queue_items{category="ready"} 2');
    expect(text).toContain('claws_queue_items{category="needs-review"} 0');
    expect(text).toContain('claws_board_issues{column="drafting"} 2');
    expect(text).toContain("claws_board_issues_waiting_on_operator 1");
    expect(text).toContain('claws_job_last_run_success{job="work"} 0');
    for (const stage of OPEN_PR_STAGES) expect(text).toContain(`claws_open_prs{stage="${stage}"} 0`);
  });

  it("never lowers the token counter across prunes, session deletes and usage resets", async () => {
    await db._rawDb().run(`INSERT INTO tasks (job_name, repo, item_number, status, started_at, completed_at, tokens_used, cost_usd, provider_used, model_used) VALUES ('issue-worker','org/repo','1','completed','${ago(10368000000)}','${ago(10368000000)}', 100, 1, 'claude', 'opus')`);
    await addSession("a", "org/repo", 10);
    await addSession("b", null, 20);
    await addSession("c", null, 40);
    let last = await tokensTotal();
    expect(last).toBe(170);

    const steps: Array<() => Promise<unknown>> = [
      () => db.pruneTasks(90),
      () => db.updateSessionUsage("a", { tokensUsed: 1, costUsd: 0, lastContextTokens: 0, usageUpdatedAt: Date.now() }),
      () => db.deletePersistedSession("a"),
      () => db.markSessionEnded("b", 2, JSON.stringify([])).then(() => db.deleteEndedPersistedSession("b")),
      () => db.markSessionEnded("c", 3, JSON.stringify([])).then(() => db.pruneEndedSessions(0, "local-tmux")),
    ];
    for (const step of steps) {
      await step();
      const now = await tokensTotal();
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
    expect(last).toBe(171);
  });

  it("never exports a session cwd as the repo label", async () => {
    await addSession("x", null, 10);
    await addSession("y", "org/repo", 10);
    await sampleAgentMetrics();
    const repos = (await values("claws_agent_tokens_total")).map((v) => v.labels["repo"]);
    expect(repos.sort()).toEqual(["", "org/repo"]);
    expect(await registry.metrics()).not.toContain("/home/claws/work");
  });

  it("keeps the last good board counts when a board sample fails", async () => {
    boardCounts.fn.mockResolvedValueOnce({ columns: { drafting: 3 }, waiting: 0 });
    await sampleBoardMetrics();
    boardCounts.fn.mockRejectedValueOnce(new Error("forge down"));
    await sampleBoardMetrics();
    expect(await values("claws_board_issues")).toEqual([{ labels: { column: "drafting" }, value: 3 }]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("[agent-metrics]"), { part: "board" }, expect.any(Error));
  });
});

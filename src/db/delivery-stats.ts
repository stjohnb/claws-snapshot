// Read-only rows behind `claws_delivery_stats` (src/delivery-stats.ts): the
// implemented issues, their PRs, the tasks and review rounds that worked them,
// and the issues that may follow up on them. Reached only through the src/db.ts
// façade.
import { getDb, timedDb } from "./core.js";
import { primaryRepoSql } from "./issues.js";

/** A non-shadow native issue closed `completed` with at least one merged PR. */
export interface DeliveryIssueRow {
  id: string;
  title: string;
  repo: string | null;
  closed_at: string;
}

/** A `claws_prs` row, any stage. */
export interface DeliveryPrRow {
  repo: string;
  pr_number: number;
  issue_id: string | null;
  stage: string;
  merged_at: string | null;
  problematic_at: string | null;
}

/** A `tasks` row's token figures; never its `error` or `outcome` text. */
export interface DeliveryTaskRow {
  job_name: string;
  repo: string;
  item_number: string;
  tokens_used: number | null;
  cost_usd: number | null;
  started_at: string;
}

/** A candidate follow-up issue. */
export interface DeliveryCandidateRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
}

export interface DeliveryStatsRows {
  issues: DeliveryIssueRow[];
  prs: DeliveryPrRow[];
  tasks: DeliveryTaskRow[];
  reviewRounds: Array<{ repo: string; pr_number: number; rounds: number }>;
  candidates: DeliveryCandidateRow[];
  links: Array<{ source_id: string; target_id: string }>;
}

const CHUNK = 400;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

const marks = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every row {@link buildDeliveryStats} needs for issues closed, and PRs merged,
 * at or after `since` (`YYYY-MM-DD HH:MM:SS` UTC), optionally for one repo:
 * an issue by its primary repo, a PR by its own. Follow-up candidates are the
 * non-shadow issues created at or after `since`.
 */
export async function loadDeliveryStatsRows(since: string, repo?: string): Promise<DeliveryStatsRows> {
  return timedDb("delivery-stats-read", async () => {
    const db = getDb();
    const primary = primaryRepoSql();
    const issueRows = await db.all(
      `SELECT id, title, closed_at, ${primary} AS repo FROM claws_issues
        WHERE state = 'closed' AND state_reason = 'completed' AND kind <> 'shadow'
          AND closed_at IS NOT NULL AND closed_at >= ?
          AND EXISTS (SELECT 1 FROM claws_prs p WHERE p.issue_id = claws_issues.id AND p.stage = 'merged')
          ${repo ? `AND ${primary} = ?` : ""}
        ORDER BY closed_at ASC, id ASC`,
      repo ? [since, repo] : [since],
    ) as Array<{ id: string; title: string; closed_at: string; repo: string | null }>;
    const issues: DeliveryIssueRow[] = issueRows.map((r) => ({ id: r.id, title: r.title, repo: r.repo ?? null, closed_at: r.closed_at }));
    const issueIds = issues.map((i) => i.id);

    const prSelect = `SELECT repo, pr_number, issue_id, stage, merged_at, problematic_at, updated_at FROM claws_prs`;
    type RawPr = { repo: string; pr_number: unknown; issue_id: string | null; stage: string; merged_at: string | null; problematic_at: string | null; updated_at: string };
    const rawPrs: RawPr[] = [];
    rawPrs.push(...await db.all(
      `${prSelect} WHERE stage = 'merged' AND COALESCE(merged_at, updated_at) >= ?${repo ? " AND repo = ?" : ""}`,
      repo ? [since, repo] : [since],
    ) as RawPr[]);
    for (const ids of chunks(issueIds)) {
      rawPrs.push(...await db.all(`${prSelect} WHERE issue_id IN (${marks(ids.length)})`, ids) as RawPr[]);
    }
    const prByKey = new Map<string, DeliveryPrRow>();
    for (const r of rawPrs) {
      const prNumber = Number(r.pr_number);
      prByKey.set(`${r.repo}#${prNumber}`, {
        repo: r.repo,
        pr_number: prNumber,
        issue_id: r.issue_id ?? null,
        stage: r.stage,
        merged_at: r.merged_at ?? (r.stage === "merged" ? r.updated_at : null),
        problematic_at: r.problematic_at ?? null,
      });
    }
    const prs = [...prByKey.values()];

    const prNumbersByRepo = new Map<string, number[]>();
    for (const p of prs) prNumbersByRepo.set(p.repo, [...(prNumbersByRepo.get(p.repo) ?? []), p.pr_number]);

    const taskSelect = `SELECT id, job_name, repo, item_number, tokens_used, cost_usd, started_at FROM tasks`;
    type RawTask = { id: unknown; job_name: string; repo: string; item_number: unknown; tokens_used: unknown; cost_usd: unknown; started_at: string };
    const taskById = new Map<string, RawTask>();
    for (const ids of chunks(issueIds)) {
      for (const t of await db.all(`${taskSelect} WHERE item_number IN (${marks(ids.length)})`, ids) as RawTask[]) taskById.set(String(t.id), t);
    }
    const reviewRounds: DeliveryStatsRows["reviewRounds"] = [];
    for (const [prRepo, numbers] of prNumbersByRepo) {
      for (const nums of chunks(numbers)) {
        const refs = nums.map((n) => String(n));
        for (const t of await db.all(
          `${taskSelect} WHERE repo = ? AND item_number IN (${marks(refs.length)})`, [prRepo, ...refs],
        ) as RawTask[]) taskById.set(String(t.id), t);
        const counts = await db.all(
          `SELECT pr_number, COUNT(*) AS rounds FROM pr_reviews WHERE repo = ? AND pr_number IN (${marks(nums.length)}) GROUP BY pr_number`,
          [prRepo, ...nums],
        ) as Array<{ pr_number: unknown; rounds: unknown }>;
        for (const c of counts) reviewRounds.push({ repo: prRepo, pr_number: Number(c.pr_number), rounds: Number(c.rounds) });
      }
    }
    const tasks: DeliveryTaskRow[] = [...taskById.values()].map((t) => ({
      job_name: t.job_name,
      repo: t.repo,
      item_number: String(t.item_number),
      tokens_used: numOrNull(t.tokens_used),
      cost_usd: numOrNull(t.cost_usd),
      started_at: t.started_at,
    }));

    const candidates = issues.length === 0 ? [] : await db.all(
      `SELECT id, title, body, created_at FROM claws_issues WHERE kind <> 'shadow' AND created_at >= ?`,
      [since],
    ) as DeliveryCandidateRow[];

    const links: DeliveryStatsRows["links"] = [];
    const seenLinks = new Set<string>();
    for (const ids of chunks(issueIds)) {
      const rows = await db.all(
        `SELECT source_id, target_id FROM claws_issue_links WHERE source_id IN (${marks(ids.length)}) OR target_id IN (${marks(ids.length)})`,
        [...ids, ...ids],
      ) as Array<{ source_id: string; target_id: string }>;
      for (const l of rows) {
        const key = `${l.source_id}>${l.target_id}`;
        if (seenLinks.has(key)) continue;
        seenLinks.add(key);
        links.push({ source_id: l.source_id, target_id: l.target_id });
      }
    }

    return { issues, prs, tasks, reviewRounds, candidates, links };
  });
}

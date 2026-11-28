/**
 * What implemented issues cost and how much rework they took, per repo and
 * period, for the read-only `claws_delivery_stats` tool
 * (`GET /api/delivery-stats`). Reads only stored rows (`loadDeliveryStatsRows`)
 * and returns ids, titles, counts and timestamps — never a task's `error` or
 * `outcome` text. {@link buildDeliveryStats} is pure, so SQLite and Postgres
 * bucket alike: every timestamp is parsed as UTC in JS.
 */
import { loadDeliveryStatsRows, type DeliveryStatsRows } from "./db.js";
import { listRepos } from "./github.js";

export const DELIVERY_PERIODS = ["day", "week", "month"] as const;
export type DeliveryPeriod = (typeof DELIVERY_PERIODS)[number];

export const DELIVERY_PHASES = ["requirements", "plan", "implement", "ci_fix", "review", "review_address", "other"] as const;
export type DeliveryPhase = (typeof DELIVERY_PHASES)[number];

/** How long `pruneTasks` keeps task rows, so tokens and CI-fix counts reach back. */
export const TASK_RETENTION_DAYS = 90;
/** The default and the furthest-back `since`. */
export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 365;
/** A follow-up issue is created within this many days after the issue closed. */
export const FOLLOW_UP_DAYS = 14;
/** The most issues `detail` lists per period. */
export const DETAIL_ISSUE_LIMIT = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A task's phase, from its `job_name`. */
export function phaseOfJob(jobName: string): DeliveryPhase {
  if (jobName === "requirements-writer") return "requirements";
  if (jobName === "issue-refiner") return "plan";
  if (jobName === "issue-worker") return "implement";
  if (jobName === "ci-fixer:problematic") return "other";
  if (jobName === "ci-fixer" || jobName.startsWith("ci-fixer:")) return "ci_fix";
  if (jobName === "pr-reviewer" || jobName === "escalation-reviewer") return "review";
  if (jobName === "review-addresser") return "review_address";
  return "other";
}

/** A stored timestamp (`YYYY-MM-DD HH:MM:SS` or ISO-8601) as epoch ms, read as UTC; NaN when unreadable. */
export function parseUtc(value: string | null | undefined): number {
  if (!value) return NaN;
  const s = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return Date.parse(`${s}T00:00:00Z`);
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`);
}

/** The UTC start of the `period` containing `ms`: midnight, Monday 00:00, or the 1st. */
export function periodStart(ms: number, period: DeliveryPeriod): number {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (period === "day") return day;
  if (period === "month") return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return day - sinceMonday * DAY_MS;
}

function nextPeriod(start: number, period: DeliveryPeriod): number {
  if (period === "day") return start + DAY_MS;
  if (period === "week") return start + 7 * DAY_MS;
  const d = new Date(start);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const isoOf = (ms: number): string => new Date(ms).toISOString();

type PhaseTokens = Record<DeliveryPhase, number | null>;

function emptyPhases(): PhaseTokens {
  return Object.fromEntries(DELIVERY_PHASES.map((p) => [p, null])) as PhaseTokens;
}

function addTo(target: PhaseTokens, phase: DeliveryPhase, tokens: number): void {
  target[phase] = (target[phase] ?? 0) + tokens;
}

export interface DeliveryIssueDetail {
  issue_id: string;
  title: string;
  closed_at: string;
  prs: string[];
  tokens_by_phase: PhaseTokens;
  ci_fix_runs: number;
  review_rounds: number;
  problematic: boolean;
  follow_up_issue_ids: string[];
}

export interface DeliveryPeriodStats {
  start: string;
  tokens_partial: boolean;
  issues_implemented: number;
  prs_merged: number;
  tokens: {
    total: number | null;
    cost_usd: number | null;
    per_issue_mean: number | null;
    per_issue_median: number | null;
    by_phase: PhaseTokens;
  };
  tasks: number;
  tasks_without_tokens: number;
  ci_fix_runs: number;
  ci_fix_runs_per_pr: number | null;
  review_rounds: number;
  review_rounds_per_pr: number | null;
  prs_problematic: number;
  follow_up_issues: number;
  issues?: DeliveryIssueDetail[];
}

export interface DeliveryStats {
  window: { since: string; until: string; period: DeliveryPeriod; task_retention_days: number };
  repos: Array<{ repo: string; periods: DeliveryPeriodStats[] }>;
}

export interface DeliveryStatsOptions {
  since: number;
  until: number;
  period: DeliveryPeriod;
  detail?: boolean;
  /** The one repo asked for, listed even with no data. */
  repo?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `text` names PR `n` of `repo` as `owner/name#n`, `name#n` or a `/owner/name/pulls/n` URL. */
function namesPr(text: string, repo: string, n: number): boolean {
  const name = repo.split("/").pop() ?? repo;
  const re = new RegExp(
    `(?:^|[^\\w./-])(?:${escapeRegExp(repo)}|${escapeRegExp(name)})#${n}(?!\\d)|/${escapeRegExp(repo)}/pulls?/${n}(?!\\d)`,
    "i",
  );
  return re.test(text);
}

/** Aggregates `rows` into per-repo periods. Pure. */
export function buildDeliveryStats(rows: DeliveryStatsRows, opts: DeliveryStatsOptions): DeliveryStats {
  const { since, until, period } = opts;
  const retentionCutoff = until - TASK_RETENTION_DAYS * DAY_MS;

  const prKey = (repo: string, n: number | string): string => `${repo.toLowerCase()}#${n}`;
  const prsByIssue = new Map<string, DeliveryStatsRows["prs"]>();
  for (const p of rows.prs) {
    if (!p.issue_id) continue;
    prsByIssue.set(p.issue_id, [...(prsByIssue.get(p.issue_id) ?? []), p]);
  }
  const tasksByItem = new Map<string, DeliveryStatsRows["tasks"]>();
  const tasksByPr = new Map<string, DeliveryStatsRows["tasks"]>();
  for (const t of rows.tasks) {
    tasksByItem.set(t.item_number, [...(tasksByItem.get(t.item_number) ?? []), t]);
    const key = prKey(t.repo, t.item_number);
    tasksByPr.set(key, [...(tasksByPr.get(key) ?? []), t]);
  }
  const roundsByPr = new Map<string, number>();
  for (const r of rows.reviewRounds) roundsByPr.set(prKey(r.repo, r.pr_number), r.rounds);
  const linked = new Map<string, Set<string>>();
  for (const l of rows.links) {
    for (const [a, b] of [[l.source_id, l.target_id], [l.target_id, l.source_id]] as const) {
      if (!linked.has(a)) linked.set(a, new Set());
      linked.get(a)!.add(b);
    }
  }
  const candidates = rows.candidates
    .map((c) => ({ ...c, created: parseUtc(c.created_at), text: `${c.title}\n${c.body}` }))
    .filter((c) => Number.isFinite(c.created));

  const ciFixRuns = (repo: string, n: number): number =>
    (tasksByPr.get(prKey(repo, n)) ?? []).filter((t) => phaseOfJob(t.job_name) === "ci_fix").length;

  interface Bucket {
    issues: DeliveryIssueDetail[];
    issueTotals: number[];
    byPhase: PhaseTokens;
    cost: number | null;
    tasks: number;
    tasksWithoutTokens: number;
    followUps: Set<string>;
    prsMerged: number;
    ciFixRuns: number;
    reviewRounds: number;
    prsProblematic: number;
  }
  const repos = new Map<string, Map<number, Bucket>>();
  const bucket = (repo: string, ms: number): Bucket => {
    if (!repos.has(repo)) repos.set(repo, new Map());
    const byStart = repos.get(repo)!;
    const start = periodStart(ms, period);
    let b = byStart.get(start);
    if (!b) {
      b = { issues: [], issueTotals: [], byPhase: emptyPhases(), cost: null, tasks: 0, tasksWithoutTokens: 0, followUps: new Set(), prsMerged: 0, ciFixRuns: 0, reviewRounds: 0, prsProblematic: 0 };
      byStart.set(start, b);
    }
    return b;
  };

  for (const issue of rows.issues) {
    const closed = parseUtc(issue.closed_at);
    if (!Number.isFinite(closed) || closed < since || closed > until || !issue.repo) continue;
    const prs = prsByIssue.get(issue.id) ?? [];
    const issueTasks = [...(tasksByItem.get(issue.id) ?? [])];
    for (const p of prs) issueTasks.push(...(tasksByPr.get(prKey(p.repo, p.pr_number)) ?? []));
    const phases = emptyPhases();
    let total: number | null = null;
    let cost: number | null = null;
    let withoutTokens = 0;
    for (const t of issueTasks) {
      if (t.tokens_used === null) {
        withoutTokens++;
        continue;
      }
      addTo(phases, phaseOfJob(t.job_name), t.tokens_used);
      total = (total ?? 0) + t.tokens_used;
      if (t.cost_usd !== null) cost = (cost ?? 0) + t.cost_usd;
    }
    const refs = prs.map((p) => ({ repo: p.repo, n: p.pr_number }));
    const followUps = candidates
      .filter((c) => c.id !== issue.id && c.created > closed && c.created <= closed + FOLLOW_UP_DAYS * DAY_MS)
      .filter((c) => linked.get(issue.id)?.has(c.id)
        || c.text.toLowerCase().includes(issue.id.toLowerCase())
        || refs.some((r) => namesPr(c.text, r.repo, r.n)))
      .map((c) => c.id)
      .sort();

    const b = bucket(issue.repo, closed);
    for (const phase of DELIVERY_PHASES) if (phases[phase] !== null) addTo(b.byPhase, phase, phases[phase]!);
    if (total !== null) b.issueTotals.push(total);
    if (cost !== null) b.cost = (b.cost ?? 0) + cost;
    b.tasks += issueTasks.length;
    b.tasksWithoutTokens += withoutTokens;
    for (const f of followUps) b.followUps.add(f);
    b.issues.push({
      issue_id: issue.id,
      title: issue.title,
      closed_at: isoOf(closed),
      prs: prs.map((p) => `${p.repo}#${p.pr_number}`).sort(),
      tokens_by_phase: phases,
      ci_fix_runs: prs.reduce((sum, p) => sum + ciFixRuns(p.repo, p.pr_number), 0),
      review_rounds: prs.reduce((sum, p) => sum + (roundsByPr.get(prKey(p.repo, p.pr_number)) ?? 0), 0),
      problematic: prs.some((p) => p.problematic_at !== null),
      follow_up_issue_ids: followUps,
    });
  }

  for (const p of rows.prs) {
    if (p.stage !== "merged") continue;
    const merged = parseUtc(p.merged_at);
    if (!Number.isFinite(merged) || merged < since || merged > until) continue;
    if (opts.repo && p.repo.toLowerCase() !== opts.repo.toLowerCase()) continue;
    const b = bucket(p.repo, merged);
    b.prsMerged++;
    b.ciFixRuns += ciFixRuns(p.repo, p.pr_number);
    b.reviewRounds += roundsByPr.get(prKey(p.repo, p.pr_number)) ?? 0;
    if (p.problematic_at !== null) b.prsProblematic++;
  }

  if (opts.repo && !repos.has(opts.repo)) repos.set(opts.repo, new Map());

  const out: DeliveryStats["repos"] = [];
  for (const repo of [...repos.keys()].sort()) {
    const byStart = repos.get(repo)!;
    const periods: DeliveryPeriodStats[] = [];
    for (let start = periodStart(since, period); start <= until; start = nextPeriod(start, period)) {
      const b = byStart.get(start);
      const total = b && b.issueTotals.length ? b.issueTotals.reduce((a, c) => a + c, 0) : null;
      const prsMerged = b?.prsMerged ?? 0;
      const stats: DeliveryPeriodStats = {
        start: dateOf(start),
        tokens_partial: start < retentionCutoff,
        issues_implemented: b?.issues.length ?? 0,
        prs_merged: prsMerged,
        tokens: {
          total,
          cost_usd: b?.cost === null || b?.cost === undefined ? null : round2(b.cost),
          per_issue_mean: total === null ? null : Math.round(total / b!.issueTotals.length),
          per_issue_median: b ? median(b.issueTotals) : null,
          by_phase: b?.byPhase ?? emptyPhases(),
        },
        tasks: b?.tasks ?? 0,
        tasks_without_tokens: b?.tasksWithoutTokens ?? 0,
        ci_fix_runs: b?.ciFixRuns ?? 0,
        ci_fix_runs_per_pr: prsMerged ? round2(b!.ciFixRuns / prsMerged) : null,
        review_rounds: b?.reviewRounds ?? 0,
        review_rounds_per_pr: prsMerged ? round2(b!.reviewRounds / prsMerged) : null,
        prs_problematic: b?.prsProblematic ?? 0,
        follow_up_issues: b?.followUps.size ?? 0,
      };
      if (opts.detail) stats.issues = (b?.issues ?? []).slice(0, DETAIL_ISSUE_LIMIT);
      periods.push(stats);
    }
    out.push({ repo, periods });
  }
  return {
    window: { since: isoOf(since), until: isoOf(until), period, task_retention_days: TASK_RETENTION_DAYS },
    repos: out,
  };
}

/** `since` clamped to {@link MAX_WINDOW_DAYS} before `now`; {@link DEFAULT_WINDOW_DAYS} back when unset. */
export function resolveSince(since: number | undefined, now: number): number {
  const floor = now - MAX_WINDOW_DAYS * DAY_MS;
  if (since === undefined) return now - DEFAULT_WINDOW_DAYS * DAY_MS;
  return Math.max(since, floor);
}

const toSql = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/**
 * The stats for `repo` (case-insensitive, answered under its configured name)
 * or every repo; `null` when `repo` is not one Claws manages.
 */
export async function loadDeliveryStats(opts: { repo?: string; since?: number; period?: DeliveryPeriod; detail?: boolean; now?: number } = {}): Promise<DeliveryStats | null> {
  let repo: string | undefined;
  if (opts.repo) {
    const wanted = opts.repo.toLowerCase();
    repo = (await listRepos()).find((r) => r.fullName.toLowerCase() === wanted)?.fullName;
    if (!repo) return null;
  }
  const now = opts.now ?? Date.now();
  const since = resolveSince(opts.since, now);
  // Periods start on a boundary, so read from the first period's start.
  const period = opts.period ?? "week";
  const from = periodStart(since, period);
  const rows = await loadDeliveryStatsRows(toSql(from), repo);
  return buildDeliveryStats(rows, { since: from, until: now, period, detail: opts.detail, repo });
}

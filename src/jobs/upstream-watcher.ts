import { parse } from "yaml";
import { z } from "zod";
import { SELF_REPO, LABELS } from "../config.js";
import { hasUpstreamWatchFired, recordUpstreamWatchFired } from "../db.js";
import * as gh from "../github.js";
import { RateLimitError } from "../rate-limit.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { guardContent, makeGuardCtx } from "../prompt-guard.js";
import { upsertAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";

const NAME = "upstream-watcher";
export const WATCHES_DIR = "docs/upstream-watches";
const MALFORMED_ISSUE_TITLE = "[upstream-watcher] Malformed files in docs/upstream-watches/";

const RepoSlug = z.string().regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);

const ConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pr_merged"), repo: RepoSlug, number: z.number().int().positive() }),
  z.object({ kind: z.literal("issue_closed"), repo: RepoSlug, number: z.number().int().positive() }),
  z.object({
    kind: z.literal("release"),
    repo: RepoSlug,
    published_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tag_matches: z.string().optional(),
    include_prereleases: z.boolean().optional(),
  }),
]);

const WatchSchema = z.object({
  id: z.string().min(1).optional(),
  target: z.object({ repo: RepoSlug, issue: z.number().int().positive() }),
  require: z.enum(["all", "any"]).optional(),
  conditions: z.array(ConditionSchema).min(1),
  note: z.string().optional(),
});

export type Condition = z.infer<typeof ConditionSchema>;

export interface Watch {
  id: string;
  target: { repo: string; issue: number };
  require: "all" | "any";
  conditions: Condition[];
  note?: string;
}

export type ParseWatchResult =
  | { ok: true; watch: Watch }
  | { ok: false; error: string };

export interface ConditionResult {
  met: boolean;
  summary: string;
  /** The condition can never become true (e.g. the watched PR was closed unmerged). */
  dead?: boolean;
}

/** Callers pass a string already matching \d{4}-\d{2}-\d{2}; round-trips it through
 *  Date.UTC to catch a rollover like 2026-02-30, which `new Date(...)` accepts silently. */
function isValidCalendarDate(dateStr: string): boolean {
  const year = Number(dateStr.slice(0, 4));
  const month = Number(dateStr.slice(5, 7));
  const day = Number(dateStr.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Plain YAML — no frontmatter. `id` defaults to the filename stem, `require` to "all". */
export function parseWatchFile(fileName: string, content: string): ParseWatchResult {
  let parsed: unknown;
  try {
    parsed = parse(content);
  } catch (err) {
    return { ok: false, error: `invalid YAML: ${(err as Error).message}` };
  }

  const result = WatchSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = issue.path.join(".");
    return { ok: false, error: path ? `${path}: ${issue.message}` : issue.message };
  }
  const raw = result.data;

  for (const c of raw.conditions) {
    if (c.kind !== "release") continue;
    if (c.tag_matches !== undefined) {
      try {
        new RegExp(c.tag_matches);
      } catch (err) {
        return { ok: false, error: `tag_matches is not a valid regular expression: ${(err as Error).message}` };
      }
    }
    if (c.published_after !== undefined && !isValidCalendarDate(c.published_after)) {
      return { ok: false, error: `published_after is not a valid date: ${c.published_after}` };
    }
  }

  return {
    ok: true,
    watch: {
      id: raw.id ?? fileName.replace(/\.ya?ml$/, ""),
      target: raw.target,
      require: raw.require ?? "all",
      conditions: raw.conditions,
      note: raw.note,
    },
  };
}

/** Upstream titles/tags are third-party GitHub text; a comment Claws posts itself
 *  is never re-guarded when read back, so guard before it lands in a body. */
function guardUpstream(c: Condition, source: string, text: string): string {
  const itemNumber = "number" in c ? c.number : 0;
  return guardContent(text, makeGuardCtx(c.repo, itemNumber)(source));
}

export async function evaluateCondition(c: Condition): Promise<ConditionResult> {
  if (c.kind === "pr_merged") {
    const status = await gh.getUpstreamPRStatus(c.repo, c.number);
    if (!status) {
      return { met: false, summary: `\`${c.repo}#${c.number}\` — not found` };
    }
    const title = guardUpstream(c, "upstream-pr_merged", status.title);
    if (status.merged) {
      const mergedOn = status.mergedAt ? status.mergedAt.slice(0, 10) : "an unknown date";
      return { met: true, summary: `\`${c.repo}#${c.number}\` — _${title}_ merged ${mergedOn} (${status.url})` };
    }
    if (status.state === "closed") {
      return {
        met: false,
        dead: true,
        summary: `\`${c.repo}#${c.number}\` — _${title}_ was closed without merging (${status.url})`,
      };
    }
    return {
      met: false,
      summary: `\`${c.repo}#${c.number}\` — _${title}_ still open, last updated ${status.updatedAt.slice(0, 10)} (${status.url})`,
    };
  }

  if (c.kind === "issue_closed") {
    let state: { state: string; stateReason: string | null };
    try {
      state = await gh.getIssueState(c.repo, c.number);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      const msg = String((err as Error)?.message ?? err);
      if (/\b404\b/.test(msg) || /not found/i.test(msg) || /could not resolve/i.test(msg)) {
        return { met: false, summary: `\`${c.repo}#${c.number}\` — not found` };
      }
      throw err;
    }
    const closed = state.state.toUpperCase() === "CLOSED";
    return {
      met: closed,
      summary: `\`${c.repo}#${c.number}\` — issue is ${closed ? "closed" : "still open"}`,
    };
  }

  // release
  const tagRe = c.tag_matches ? new RegExp(c.tag_matches) : null;
  const afterMs = c.published_after ? Date.parse(`${c.published_after}T00:00:00Z`) : null;
  const releases = await gh.listReleases(c.repo);
  // The API returns newest-first, so the first survivor is the newest match.
  const match = releases.find((r) => {
    if (r.draft) return false;
    if (r.prerelease && !c.include_prereleases) return false;
    if (r.publishedAt === null) return false;
    if (tagRe && !tagRe.test(r.tag)) return false;
    if (afterMs !== null && !(Date.parse(r.publishedAt) > afterMs)) return false;
    return true;
  });

  const criteria = [
    c.include_prereleases ? "including prereleases" : "stable only",
    c.tag_matches ? `tag matching \`${c.tag_matches}\`` : null,
    c.published_after ? `published after ${c.published_after}` : null,
  ].filter(Boolean).join(", ");

  if (!match) {
    return { met: false, summary: `\`${c.repo}\` — no release yet (${criteria})` };
  }
  const tag = guardUpstream(c, "upstream-release", match.tag);
  return {
    met: true,
    summary: `\`${c.repo}\` published **${tag}** on ${match.publishedAt!.slice(0, 10)} (${match.url})`,
  };
}

export function buildUnblockComment(watch: Watch, results: ConditionResult[], fileName: string): string {
  const lines = [
    "The upstream conditions this issue was parked on are now met, so Claws has removed `Blocked` and added `Ready`.",
    "",
    `**Watch:** \`${watch.id}\` (require: \`${watch.require}\`)`,
    "",
    ...results.map((r) => `- ${r.met ? "✅" : "⬜"} ${r.summary}`),
  ];
  if (watch.note) {
    lines.push("", "**Note from the watch file:**", "", watch.note);
  }
  lines.push(
    "",
    `Once this issue is done, delete \`${WATCHES_DIR}/${fileName}\` so the watch stops being evaluated.`,
  );
  return lines.join("\n");
}

async function processWatch(watch: Watch, fileName: string): Promise<void> {
  const { repo, issue } = watch.target;

  if (hasUpstreamWatchFired(watch.id, repo, issue)) return;

  const state = await gh.getIssueState(repo, issue);
  if (state.state.toUpperCase() !== "OPEN") {
    // Not recorded: a reopened issue should be re-evaluated on the next run.
    log.info(`[${NAME}] ${watch.id}: ${repo}#${issue} is ${state.state.toLowerCase()} — skipping`);
    return;
  }

  const results: ConditionResult[] = [];
  for (const c of watch.conditions) {
    results.push(await evaluateCondition(c));
  }

  const dead = results.filter((r) => r.dead);
  const satisfied = watch.require === "any" ? results.some((r) => r.met) : results.every((r) => r.met);
  // For "any", a dead condition doesn't make the watch impossible as long as
  // another condition can still (or already does) succeed — only "all" dead
  // (or already-satisfied "any") conditions make firing genuinely impossible.
  const impossible = !satisfied && (watch.require === "any" ? results.every((r) => r.dead) : dead.length > 0);
  if (impossible) {
    await upsertAlertIssue({
      repo: SELF_REPO,
      title: `[${NAME}] Watch "${watch.id}" can never fire`,
      body: [
        `The watch \`${WATCHES_DIR}/${fileName}\` is blocked on a condition that can never become true, ` +
          `so ${repo}#${issue} would stay parked forever.`,
        "",
        ...dead.map((r) => `- ${r.summary}`),
        "",
        `Edit or delete \`${WATCHES_DIR}/${fileName}\` — either point the watch at the replacement upstream work, ` +
          `or drop the watch and handle ${repo}#${issue} by hand.`,
      ].join("\n"),
      labels: [LABELS.clawsIgnore],
      logPrefix: NAME,
    });
    return;
  }

  if (!satisfied) {
    const met = results.filter((r) => r.met).length;
    log.info(`[${NAME}] ${watch.id}: ${met}/${results.length} conditions met (require: ${watch.require}) — waiting`);
    return;
  }

  // Label ops are idempotent, so recording last means a mid-way failure just
  // retries on the next run rather than leaving the issue half-unblocked. An
  // unconfirmed removal must also bail before addLabel/commentOnIssue/record —
  // otherwise the issue is left carrying both labels with the fire recorded,
  // and hasUpstreamWatchFired permanently skips it on every future run.
  // `Blocked` is the park label; `Claws Ignore` is the legacy one (#913 was parked
  // with it), so strip both — leaving either behind keeps the issue skipped.
  for (const label of [LABELS.blocked, LABELS.clawsIgnore]) {
    if (!(await gh.removeLabel(repo, issue, label))) {
      log.warn(`[${NAME}] ${watch.id}: could not confirm removal of "${label}" from ${repo}#${issue} — will retry next run`);
      return;
    }
  }
  await gh.addLabel(repo, issue, LABELS.ready);
  await gh.commentOnIssue(repo, issue, buildUnblockComment(watch, results, fileName), { agentName: NAME });
  recordUpstreamWatchFired(watch.id, repo, issue);
  log.info(`[${NAME}] ${watch.id}: unblocked ${repo}#${issue} — all upstream conditions met`);
}

export async function run(): Promise<void> {
  const entries = await gh.listRepoDirectory(SELF_REPO, WATCHES_DIR);
  const files = entries.filter((e) => e.type === "file" && /\.ya?ml$/.test(e.name));
  if (files.length === 0) {
    log.info(`[${NAME}] no watch files in ${WATCHES_DIR}`);
  }

  const malformed: { file: string; error: string }[] = [];

  for (const entry of files) {
    try {
      const content = await gh.fetchRepoFileContent(SELF_REPO, entry.path);
      if (content === null) continue;

      const result = parseWatchFile(entry.name, content);
      if (!result.ok) {
        malformed.push({ file: entry.name, error: result.error });
        continue;
      }

      await processWatch(result.watch, entry.name);
    } catch (err) {
      await reportError(`${NAME}:process-watch`, SELF_REPO, err);
    }
  }

  if (malformed.length > 0) {
    const body = [
      `Claws found files in \`${WATCHES_DIR}\` that could not be parsed:`,
      "",
      ...malformed.map((m) => `- \`${m.file}\` — ${m.error}`),
      "",
      "Expected schema:",
      "",
      "```yaml",
      "id: optional-slug             # optional; defaults to the filename",
      "target:",
      "  repo: owner/repo            # the parked issue's repo",
      "  issue: 123                  # the parked issue number",
      "require: all                  # optional; all (default) or any",
      "conditions:",
      "  - kind: pr_merged",
      "    repo: upstream-org/upstream-repo",
      "    number: 2715",
      "  - kind: issue_closed",
      "    repo: upstream-org/upstream-repo",
      "    number: 42",
      "  - kind: release",
      "    repo: upstream-org/upstream-repo",
      '    published_after: "2026-08-25"   # optional YYYY-MM-DD',
      '    tag_matches: "^v\\\\d+"           # optional regular expression',
      "    include_prereleases: false      # optional; default false",
      "note: >-                      # optional; shown in the unblock comment",
      "  Anything the planner should read before starting.",
      "```",
    ].join("\n");
    await upsertAlertIssue({
      repo: SELF_REPO,
      title: MALFORMED_ISSUE_TITLE,
      body,
      labels: [],
      logPrefix: NAME,
    });
  } else {
    await closeAlertIssueIfResolved({
      repo: SELF_REPO,
      title: MALFORMED_ISSUE_TITLE,
      logPrefix: NAME,
      reason: "no malformed watch files",
    });
  }
}

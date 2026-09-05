import { parse } from "yaml";
import { z } from "zod";
import { LABELS, type Repo } from "../config.js";
import { hasReminderFired, recordReminderFired } from "../db.js";
import * as gh from "../github.js";
import * as log from "../log.js";
import { reportError } from "../error-reporter.js";
import { mapSettledWithConcurrency } from "../util.js";
import { ensureAlertIssue, closeAlertIssueIfResolved } from "../occurrence-tracking.js";

const NAME = "reminder-monitor";
const REMINDERS_DIR = "docs/scheduled-reminders";
const MAX_DESCRIPTION_CHARS = 8000;
const REPO_CONCURRENCY = 4;
const MALFORMED_ISSUE_TITLE = "[reminder-monitor] Malformed files in docs/scheduled-reminders/";

// Reserved Claws control markers (see src/agents/issue-refiner.ts) that must
// never be honoured when they originate from a reminder body — a reminder file
// lives in the target repo, not in planner output, so a body that opens with
// one of these is either a mistake or an attempt to steer a downstream agent.
const RESERVED_MARKER_RE =
  /^\s*(CLAWS_TRANSFER_TO:|CLAWS_NO_CODE_CHANGES|CLAWS_DUPLICATE_OF:|CLAWS_PLAN_OCCURRENCES:|CLAWS_TRANSFERRED_FROM:)/;

const FrontmatterSchema = z.object({
  id: z.string().min(1).optional(),
  title: z.string().min(1),
  notify_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  owner: z.string().optional(),
  priority: z.boolean().optional(),
});

export interface Reminder {
  id: string;
  title: string;
  notify_on: string;
  expires_on?: string;
  owner?: string;
  priority?: boolean;
  body: string;
}

export type ParseReminderResult =
  | { ok: true; reminder: Reminder }
  | { ok: false; error: string };

function isValidCalendarDate(dateStr: string): boolean {
  return !Number.isNaN(new Date(`${dateStr}T00:00:00`).getTime());
}

export function parseReminderFile(fileName: string, content: string): ParseReminderResult {
  if (!content.startsWith("---\n")) return { ok: false, error: "missing YAML frontmatter" };

  const lines = content.split("\n");
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---" || lines[i] === "---\r") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) return { ok: false, error: "missing YAML frontmatter" };

  const frontmatterBlock = lines.slice(1, closingIndex).join("\n");

  let parsed: unknown;
  try {
    parsed = parse(frontmatterBlock);
  } catch (err) {
    return { ok: false, error: `invalid YAML: ${(err as Error).message}` };
  }

  const result = FrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    return { ok: false, error: `${issue.path.join(".")}: ${issue.message}` };
  }
  const fm = result.data;

  if (!isValidCalendarDate(fm.notify_on)) return { ok: false, error: "invalid date" };
  if (fm.expires_on && !isValidCalendarDate(fm.expires_on)) return { ok: false, error: "invalid date" };

  let body = lines.slice(closingIndex + 1).join("\n").trim();
  if (RESERVED_MARKER_RE.test(body)) {
    return { ok: false, error: "body begins with a reserved Claws control marker" };
  }
  if (body.length > MAX_DESCRIPTION_CHARS) {
    body = body.slice(0, MAX_DESCRIPTION_CHARS) + "\n\n_(truncated)_";
  }

  const id = fm.id ?? fileName.replace(/\.md$/, "");

  return {
    ok: true,
    reminder: {
      id,
      title: fm.title,
      notify_on: fm.notify_on,
      expires_on: fm.expires_on,
      owner: fm.owner,
      priority: fm.priority,
      body,
    },
  };
}

export function todayLocalDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function isDue(reminder: Reminder, today: string): boolean {
  return today >= reminder.notify_on;
}

export function buildIssueTitle(r: Reminder): string {
  return `[reminder] ${r.title} (${r.notify_on})`;
}

export function buildIssueBody(r: Reminder, repo: string, filePath: string): string {
  const lines = [
    `A scheduled reminder from \`${filePath}\` in ${repo} is due.`,
    "",
    `**Notify on:** ${r.notify_on}`,
    `**Expires on:** ${r.expires_on ?? "_not set_"}`,
  ];
  if (r.owner) lines.push(`**Owner:** ${r.owner}`);
  lines.push("", "## Steps", "", r.body, "", "## After completing this reminder", "",
    `In the same PR, either update \`notify_on\`/\`expires_on\` in \`${filePath}\` to the next cycle's dates, ` +
    `or delete the file if the reminder is no longer needed — otherwise Claws will not re-fire it.`);
  return lines.join("\n");
}

async function processRepo(repo: Repo, today: string): Promise<void> {
  const entries = await gh.listRepoDirectory(repo.fullName, REMINDERS_DIR);
  const files = entries.filter((e) => e.type === "file" && e.name.endsWith(".md") && e.name !== "README.md");

  const malformed: { file: string; error: string }[] = [];

  for (const entry of files) {
    const content = await gh.fetchRepoFileContent(repo.fullName, entry.path);
    if (content === null) continue;

    const result = parseReminderFile(entry.name, content);
    if (!result.ok) {
      malformed.push({ file: entry.name, error: result.error });
      continue;
    }

    const reminder = result.reminder;
    if (!isDue(reminder, today)) continue;

    try {
      if (hasReminderFired(repo.fullName, reminder.id, reminder.notify_on)) continue;

      const title = buildIssueTitle(reminder);
      const existing = await gh.findIssueByExactTitle(repo.fullName, title);
      if (existing) {
        recordReminderFired(repo.fullName, reminder.id, reminder.notify_on, existing.number);
        continue;
      }

      const body = buildIssueBody(reminder, repo.fullName, entry.path);
      const labels = reminder.priority === false ? [] : [LABELS.priority];
      const issueNumber = await gh.createIssue(repo.fullName, title, body, labels);
      recordReminderFired(repo.fullName, reminder.id, reminder.notify_on, issueNumber);
      log.info(`[${NAME}] ${repo.fullName}: filed reminder "${reminder.title}" as #${issueNumber}`);
    } catch (err) {
      log.warn(`[${NAME}] ${repo.fullName}: failed to process reminder "${reminder.id}": ${err}`);
    }
  }

  if (malformed.length > 0) {
    const body = [
      `Claws found files in \`${REMINDERS_DIR}\` that could not be parsed:`,
      "",
      ...malformed.map((m) => `- \`${m.file}\` — ${m.error}`),
      "",
      "Expected frontmatter schema:",
      "",
      "```yaml",
      "---",
      "id: optional-slug           # optional; defaults to the filename",
      "title: Short description",
      "notify_on: YYYY-MM-DD",
      "expires_on: YYYY-MM-DD      # optional",
      "owner: someone              # optional",
      "priority: true              # optional",
      "---",
      "```",
    ].join("\n");
    await ensureAlertIssue({
      repo: repo.fullName,
      title: MALFORMED_ISSUE_TITLE,
      body,
      labels: [],
      logPrefix: NAME,
      refreshBody: true,
    });
  } else {
    await closeAlertIssueIfResolved({
      repo: repo.fullName,
      title: MALFORMED_ISSUE_TITLE,
      logPrefix: NAME,
      reason: "no malformed reminder files",
    });
  }
}

export async function run(repos: Repo[], now: Date = new Date()): Promise<void> {
  const today = todayLocalDate(now);
  await mapSettledWithConcurrency(repos, REPO_CONCURRENCY, async (repo) => {
    try {
      await processRepo(repo, today);
    } catch (err) {
      await reportError(`${NAME}:process-repo`, repo.fullName, err);
    }
  });
}

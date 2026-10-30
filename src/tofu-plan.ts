/**
 * Parsing for the Tofu plan comments posted by the managed repos' own
 * `tofu-plan-on-pr.yml` workflows, plus the diff tests behind the auto-merger's
 * no-op plan exception: pin-only for a trusted dependency PR on GitHub, the
 * provider-bump rule for any PR on Forgejo. Its one import, ci-exempt.ts, has
 * none of its own: github.ts and the dashboard pages share this module.
 */

import { isCiExemptPath } from "./ci-exempt.js";

export interface TofuPlanSummary { add: number; change: number; replace: number; destroy: number }

/** The `name:` of both repos' plan workflow; its runs are the plan evidence. */
export const TOFU_PLAN_WORKFLOW_NAME = "Tofu Plan";

/** production-infra's comment marker (redacted summary with a counts line). */
const TOFU_PLAN_MARKER = "<!-- tofu-plan -->";
/** bstjohn-blog's comment heading (raw `tofu plan` text in a fence). */
const TOFU_PLAN_HEADING = "### Tofu plan (tofu/)";

const COUNTS_LINE = /\*\*(\d+) to add, (\d+) to change, (\d+) to replace, (\d+) to destroy\.\*\*/;
const NO_CHANGES = /No changes\. Your infrastructure matches the configuration\./;
const RAW_PLAN_LINE = /^\s*Plan: (.+)\.\s*$/m;
const RAW_PLAN_TERM = /(\d+) to (\w+)/g;
const MUST_BE_REPLACED = /^\s*# .+ must be replaced\s*$/gm;

/** True when `body` is a plan comment in either repo's format. */
export function isTofuPlanComment(body: string): boolean {
  const head = body.trimStart();
  return head.startsWith(TOFU_PLAN_MARKER) || head.startsWith(TOFU_PLAN_HEADING);
}

/**
 * Counts from a plan comment body, or null when they cannot be established.
 * Accepts production-infra's `**N to add, N to change, N to replace, N to destroy.**`
 * line, and raw tofu output: "No changes. Your infrastructure matches the
 * configuration." is all zeros; otherwise the `Plan: N to add, N to change,
 * N to destroy.` line, with `replace` counted from `# … must be replaced`
 * lines. Any other `Plan:` term (`to import`, `to forget`) counts as a change,
 * so it never reads as a no-op. Neither form present (an outputs-only plan, a
 * truncated body) is null.
 */
export function parseTofuPlanBody(body: string): TofuPlanSummary | null {
  const counts = COUNTS_LINE.exec(body);
  if (counts) {
    return { add: Number(counts[1]), change: Number(counts[2]), replace: Number(counts[3]), destroy: Number(counts[4]) };
  }
  const plan = RAW_PLAN_LINE.exec(body);
  if (plan) {
    const summary: TofuPlanSummary = { add: 0, change: 0, replace: 0, destroy: 0 };
    let terms = 0;
    for (const [, n, verb] of plan[1]!.matchAll(RAW_PLAN_TERM)) {
      terms++;
      if (verb === "add") summary.add += Number(n);
      else if (verb === "destroy") summary.destroy += Number(n);
      else summary.change += Number(n);
    }
    if (terms === 0) return null;
    summary.replace = body.match(MUST_BE_REPLACED)?.length ?? 0;
    return summary;
  }
  if (NO_CHANGES.test(body)) return { add: 0, change: 0, replace: 0, destroy: 0 };
  return null;
}

/** Total resources the plan touches. */
export function tofuPlanChangeCount(p: TofuPlanSummary): number {
  return p.add + p.change + p.replace + p.destroy;
}

export function isNoOpPlan(p: TofuPlanSummary): boolean {
  return tofuPlanChangeCount(p) === 0;
}

/** The board card's wording of a plan: one text segment per count, plus whether it destroys anything. */
export interface InfraSummary {
  additions: string;
  changes: string;
  deletions: string;
  /** Null when the plan replaces nothing. */
  replacements: string | null;
  /** True when the plan destroys or replaces at least one resource. */
  destructive: boolean;
}

function countPhrase(n: number, noun: string, plural: string): string {
  if (n === 0) return `no ${plural}`;
  return `${n} ${n === 1 ? noun : plural}`;
}

/**
 * Word a plan for the board card: "1 addition", "no changes", "no deletions",
 * "2 replacements". Zero additions, changes and deletions are stated as "no …"
 * rather than omitted; replacements are left out (null) when there are none.
 */
export function formatInfraSummary(plan: TofuPlanSummary): InfraSummary {
  return {
    additions: countPhrase(plan.add, "addition", "additions"),
    changes: countPhrase(plan.change, "change", "changes"),
    deletions: countPhrase(plan.destroy, "deletion", "deletions"),
    replacements: plan.replace > 0 ? countPhrase(plan.replace, "replacement", "replacements") : null,
    destructive: plan.destroy > 0 || plan.replace > 0,
  };
}

/** A provider/version pin file: `versions.tf` or `.terraform.lock.hcl` in any directory. */
export function isInfraPinPath(p: string): boolean {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base === "versions.tf" || base === ".terraform.lock.hcl";
}

/** True when every changed file is a pin file; one other file of any kind disqualifies the diff. */
export function isInfraPinOnly(files: string[]): boolean {
  return files.length > 0 && files.every(isInfraPinPath);
}

/**
 * Label the auto-merger puts on a PR it merges under the no-op plan exception;
 * production-infra's `tofu-apply.yml` then refuses any non-zero plan for it.
 */
export const CLAWS_NOOP_MERGE_LABEL = "claws-noop-merge";

export type ProviderBumpVerdict = { ok: true } | { ok: false; reason: string };

const WORKFLOW_DIR = /(?:^|\/)\.(?:github|forgejo)\/workflows\//;
const TF_SOURCE = /\.(?:tf|tfvars)$/;
const TOFU_DIR = /(?:^|\/)(?:tofu|terraform)\//;
const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
const COMMENT_OR_BLANK = /^\s*(?:#|\/\/|$)/;
const HEREDOC_OPEN = /<<-?\s*["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*$/;

/** Whether a changed comment-looking line sits inside a heredoc, where it is content. */
function changesHeredocContent(hunks: string[]): boolean {
  let terminator: string | null = null;
  const hasChange = hunks.some((l) => l.startsWith("+") || l.startsWith("-"));
  for (const line of hunks) {
    if (line.startsWith("@@")) {
      terminator = null;
      continue;
    }
    const text = line.slice(1);
    // A bare all-caps identifier line with no opener earlier in the hunk is a
    // likely heredoc terminator whose opener fell outside the context: fail closed.
    if (terminator === null && hasChange && /^[A-Z_][A-Z0-9_]*$/.test(text.trim())) return true;
    if (terminator !== null) {
      if (text.trim() === terminator) terminator = null;
      else if (line.startsWith("+") || line.startsWith("-")) return true;
      continue;
    }
    const open = HEREDOC_OPEN.exec(text);
    if (open) terminator = open[1]!;
  }
  return false;
}

/** A unified diff split into per-file sections keyed by the `b/` path. */
function diffSections(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of diff.split("\n")) {
    const header = DIFF_HEADER.exec(line);
    if (header) {
      current = [];
      out.set(header[2]!, current);
    } else if (current) {
      current.push(line);
    }
  }
  return out;
}

/**
 * Whether a Forgejo PR's diff is a provider-version bump the no-op plan
 * exception may admit: every changed file is a pin file (`isInfraPinPath`), an
 * existing `.tf`/`.tfvars` file whose added and removed lines are all blank or
 * `#`/`//` comments, or a docs file (`isCiExemptPath`, outside any `tofu/` or
 * `terraform/` directory). A workflow file, any other file, an added, deleted
 * or renamed `.tf` file, a `.tf.json` file or an unreadable diff fails, with a
 * reason naming the file.
 */
export function providerBumpDiffVerdict(files: string[], diff: string): ProviderBumpVerdict {
  if (files.length === 0 || !diff.trim()) return { ok: false, reason: "diff unreadable" };
  const sections = diffSections(diff);
  for (const file of files) {
    if (WORKFLOW_DIR.test(file)) return { ok: false, reason: `changes workflow file ${file}` };
    if (isInfraPinPath(file)) continue;
    if (TF_SOURCE.test(file)) {
      const section = sections.get(file);
      if (!section) return { ok: false, reason: `diff unreadable for ${file}` };
      // `---`/`+++` are file headers only before the first hunk; inside one they
      // are content (a removed `--` line), so split there rather than by prefix.
      const firstHunk = section.findIndex((l) => l.startsWith("@@"));
      const header = firstHunk < 0 ? section : section.slice(0, firstHunk);
      if (header.some((l) => l.startsWith("rename from") || l === "--- /dev/null" || l === "+++ /dev/null")) {
        return { ok: false, reason: `${file} is added, deleted or renamed` };
      }
      const changed = firstHunk < 0 ? [] : section.slice(firstHunk).filter((l) => l.startsWith("+") || l.startsWith("-"));
      if (firstHunk < 0 || !changed.every((l) => COMMENT_OR_BLANK.test(l.slice(1))) || changesHeredocContent(section.slice(firstHunk))) {
        return { ok: false, reason: `non-comment change in ${file}` };
      }
      continue;
    }
    if (isCiExemptPath(file) && !TOFU_DIR.test(file)) continue;
    return { ok: false, reason: `${file} is not a provider pin, comment-only .tf edit or docs file` };
  }
  return { ok: true };
}

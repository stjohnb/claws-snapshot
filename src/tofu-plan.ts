/**
 * Parsing for the Tofu plan comments posted by the managed repos' own
 * `tofu-plan-on-pr.yml` workflows, plus the pin-only diff test behind the
 * auto-merger's one infra exception (a trusted dependency PR whose verified
 * plan is a no-op). No imports: github.ts and the dashboard pages share it.
 */

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

/** A provider/version pin file: `versions.tf` or `.terraform.lock.hcl` in any directory. */
export function isInfraPinPath(p: string): boolean {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return base === "versions.tf" || base === ".terraform.lock.hcl";
}

/** True when every changed file is a pin file; one other file of any kind disqualifies the diff. */
export function isInfraPinOnly(files: string[]): boolean {
  return files.length > 0 && files.every(isInfraPinPath);
}

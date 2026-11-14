/**
 * Parsing for the Tofu plan comments posted by the managed repos' own
 * `tofu-plan-on-pr.yml` workflows, plus the diff tests behind the auto-merger's
 * zero-change plan exception (`noopMergeDiffVerdict`) and its carry-over of an
 * infra merge approval across plan-neutral commits (`tofuPlanFingerprint`,
 * `infraWorkflowDiffDigest`). It imports nothing of Claws' own: github.ts and
 * the dashboard pages share this module.
 */

import { createHash } from "node:crypto";

export interface TofuPlanSummary { add: number; change: number; replace: number; destroy: number }

/** The `name:` of both repos' plan workflow; its runs are the plan evidence. */
export const TOFU_PLAN_WORKFLOW_NAME = "Tofu Plan";

/** production-infra's comment marker (redacted summary with a counts line). */
const TOFU_PLAN_MARKER = "<!-- tofu-plan -->";
/** bstjohn-blog's comment heading (raw `tofu plan` text in a fence). */
const TOFU_PLAN_HEADING = "### Tofu plan (tofu/)";

const COUNTS_LINE = /\*\*(\d+) to add, (\d+) to change, (\d+) to replace, (\d+) to destroy\.\*\*/;
/** fleet-infra's import span, in its own bold run before the counts line. */
const IMPORT_SPAN = /\*\*(\d+) to import\*\*/;
/** fleet-infra's per-root heading: one comment per tofu root. */
const ROOT_HEADING = /^### Tofu Plan: (\S+)\s*$/m;
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
 * so it never reads as a no-op. fleet-infra's `**N to import**` span beside
 * the counts line is added to `change` for the same reason. Neither form
 * present (an outputs-only plan, a truncated body) is null.
 */
export function parseTofuPlanBody(body: string): TofuPlanSummary | null {
  const counts = COUNTS_LINE.exec(body);
  if (counts) {
    const imports = Number(IMPORT_SPAN.exec(body)?.[1] ?? 0);
    return { add: Number(counts[1]), change: Number(counts[2]) + imports, replace: Number(counts[3]), destroy: Number(counts[4]) };
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

/** fleet-infra's `**N to import**` span, which `parseTofuPlanBody` adds to `change`; 0 without one. */
export function tofuPlanImportCount(body: string): number {
  return COUNTS_LINE.test(body) ? Number(IMPORT_SPAN.exec(body)?.[1] ?? 0) : 0;
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

/**
 * The tofu root a plan comment describes: fleet-infra's `### Tofu Plan: <dir>`
 * heading, or null for a repo that posts one comment for its single root.
 */
export function parseTofuPlanRoot(body: string): string | null {
  return ROOT_HEADING.exec(body)?.[1] ?? null;
}

/** One resource-level change in a plan: its address and action. */
export interface TofuPlanResource { address: string; action: string }

/** production-infra's redacted bullet: `` - `address` — **action** ``. */
const RESOURCE_BULLET = /^- `([^`]+)` — \*\*([a-z+-]+)\*\*/gm;
/** A raw `tofu plan` resource header: `# address will be created` / `must be replaced`. */
const RAW_RESOURCE_LINE = /^\s*# (.+?) (?:will be (created|updated in-place|destroyed|imported|read during apply|replaced)|must be (replaced))\b/gm;

/**
 * The resource-level changes a plan comment lists, sorted by address then
 * action: production-infra's `` - `address` — **action** `` bullets, or raw
 * plan `# address will be …` / `# address must be replaced` lines. A
 * zero-change body is an empty list; a body whose counts are non-zero but
 * names no resource (a truncated comment, an unknown format) is null, so it
 * can never be matched against another plan.
 */
export function parseTofuPlanResources(body: string): TofuPlanResource[] | null {
  const plan = parseTofuPlanBody(body);
  if (!plan) return null;
  // A comment cut short (production-infra caps it at 60 000 characters) hides resources.
  if (/Output truncated/i.test(body)) return null;
  const out: TofuPlanResource[] = [];
  for (const [, address, action] of body.matchAll(RESOURCE_BULLET)) out.push({ address: address!, action: action! });
  const bulleted = out.length > 0;
  if (!bulleted) {
    for (const [, address, will, must] of body.matchAll(RAW_RESOURCE_LINE)) {
      out.push({ address: address!, action: (will ?? must)! === "read during apply" ? "read" : (will ?? must)! });
    }
  }
  if (out.length === 0 && !isNoOpPlan(plan)) return null;
  // The bulleted changes must account for the plan's totals, or some are missing (a raw plan counts a replacement as add + destroy, so it is exempt).
  if (bulleted && out.filter((r) => r.action !== "read").length !== tofuPlanChangeCount(plan)) return null;
  return out.sort((a, b) => a.address.localeCompare(b.address) || a.action.localeCompare(b.action));
}

/**
 * A canonical text form of a plan's resource-level changes: one
 * `root address action` line per resource (root `-` for a single-root repo),
 * sorted, joined by newline. Two plans with the same fingerprint change the
 * same resources the same way.
 */
export function tofuPlanFingerprint(resources: readonly (TofuPlanResource & { root?: string | null })[]): string {
  return resources
    .map((r) => `${r.root || "-"} ${r.address} ${r.action}`)
    .sort()
    .join("\n");
}

/** A tofu/terraform-named workflow or action under `.github/` or `.forgejo/`: it can apply infra with no .tf file changing (#841). */
export function isInfraWorkflowPath(p: string): boolean {
  return /(?:^|\/)\.(?:github|forgejo)\/(?:workflows|actions)\/.*(?:tofu|terraform)/i.test(p);
}

/** Any workflow or action file under `.github/` or `.forgejo/`. */
export function isWorkflowOrActionPath(p: string): boolean {
  return /(?:^|\/)\.(?:github|forgejo)\/(?:workflows|actions)\//.test(p);
}

/**
 * Whether the diff admits the zero-change plan exception. `plan-only`: no
 * workflow or action file changed, so the plan covers everything the merge
 * can do. `tool-version-bump`: every infra path is a tofu-named workflow or
 * action file whose only edit is one version string (see
 * `isVersionStringEdit`), and no other workflow or action file changed — the
 * auto-merger admits it only for a trusted Renovate update.
 */
export type NoopMergeDiffVerdict =
  | { ok: true; kind: "plan-only" | "tool-version-bump" }
  | { ok: false; reason: string };

const DIFF_HEADER = /^diff --git a\/(.+) b\/(.+)$/;
/** One version token: `1.13.8`, `v1.13`, `1.2.3-rc1`, `1.2.3+k3s1`. */
const VERSION_TOKEN = /v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.]+)?/g;

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

/** A section's header lines (before the first hunk) and its changed lines; `---`/`+++` are headers only before the first hunk. */
function splitSection(section: string[]): { header: string[]; changed: string[]; hunked: boolean } {
  const firstHunk = section.findIndex((l) => l.startsWith("@@"));
  const header = firstHunk < 0 ? section : section.slice(0, firstHunk);
  const changed = firstHunk < 0 ? [] : section.slice(firstHunk).filter((l) => l.startsWith("+") || l.startsWith("-"));
  return { header, changed, hunked: firstHunk >= 0 };
}

function isAddedDeletedOrRenamed(header: string[]): boolean {
  return header.some((l) => l.startsWith("rename from") || l === "--- /dev/null" || l === "+++ /dev/null");
}

/** Exactly one removed and one added line, identical once one version token in each is replaced. */
function isVersionStringEdit(changed: string[]): boolean {
  const removed = changed.filter((l) => l.startsWith("-"));
  const added = changed.filter((l) => l.startsWith("+"));
  if (removed.length !== 1 || added.length !== 1) return false;
  const a = removed[0]!.slice(1);
  const b = added[0]!.slice(1);
  if (a === b) return false;
  const tokensA = [...a.matchAll(VERSION_TOKEN)];
  const tokensB = [...b.matchAll(VERSION_TOKEN)];
  for (const ta of tokensA) {
    for (const tb of tokensB) {
      const restA = a.slice(0, ta.index) + "\0" + a.slice(ta.index! + ta[0].length);
      const restB = b.slice(0, tb.index) + "\0" + b.slice(tb.index! + tb[0].length);
      if (restA === restB) return true;
    }
  }
  return false;
}

/**
 * Whether a PR's diff admits the zero-change plan exception, with the kind of
 * diff it is (see {@link NoopMergeDiffVerdict}). A workflow or action file that
 * names neither tofu nor terraform, a tofu-named one with any edit other than
 * one version string, one that is added, deleted or renamed, a tool bump
 * beside other infra paths, or an unreadable diff fails with a reason naming
 * the file. Non-infra files are unrestricted.
 */
export function noopMergeDiffVerdict(files: string[], diff: string): NoopMergeDiffVerdict {
  if (files.length === 0 || !diff.trim()) return { ok: false, reason: "diff unreadable" };
  const workflows = files.filter(isWorkflowOrActionPath);
  if (workflows.length === 0) return { ok: true, kind: "plan-only" };
  const plain = workflows.find((f) => !isInfraWorkflowPath(f));
  if (plain) return { ok: false, reason: `changes workflow file ${plain}` };
  const sections = diffSections(diff);
  for (const file of workflows) {
    const section = sections.get(file);
    if (!section) return { ok: false, reason: `diff unreadable for ${file}` };
    const { header, changed, hunked } = splitSection(section);
    if (isAddedDeletedOrRenamed(header)) return { ok: false, reason: `${file} is added, deleted or renamed` };
    if (!hunked || !isVersionStringEdit(changed)) return { ok: false, reason: `non-version change in ${file}` };
  }
  const otherInfra = files.find((f) => !isInfraWorkflowPath(f) && isInfraCodePath(f));
  if (otherInfra) return { ok: false, reason: `tofu tool version bump also changes ${otherInfra}` };
  return { ok: true, kind: "tool-version-bump" };
}

/** An infra path other than a workflow or action: a tofu/terraform directory, `.tf`/`.tfvars` file or lock file. */
export function isInfraCodePath(p: string): boolean {
  return /(?:^|\/)(?:tofu|terraform)\//.test(p)
    || /\.(?:tf|tfvars)(?:\.json)?$/.test(p)
    || /(?:^|\/)\.terraform\.lock\.hcl$/.test(p);
}

/**
 * A digest of the PR's tofu/terraform workflow and action edits: sha256 over
 * the sorted tofu-named workflow/action files and their `+`/`-` lines, hunk
 * headers and context excluded, so a rebase or a merge from the base branch
 * that leaves those edits alone keeps it. `""` when the PR changes none; null
 * when a tofu workflow file has no readable section in the diff, so two failed
 * reads never compare equal.
 */
export function infraWorkflowDiffDigest(files: string[], diff: string): string | null {
  const workflows = files.filter(isInfraWorkflowPath).sort();
  if (workflows.length === 0) return "";
  const sections = diffSections(diff);
  const hash = createHash("sha256");
  for (const file of workflows) {
    hash.update(`${file}\n`);
    const section = sections.get(file);
    if (!section) return null;
    const { header, changed } = splitSection(section);
    for (const l of header) if (l.startsWith("rename from") || l.startsWith("new file") || l.startsWith("deleted file")) hash.update(`${l}\n`);
    for (const l of changed) hash.update(`${l}\n`);
  }
  return hash.digest("hex");
}
